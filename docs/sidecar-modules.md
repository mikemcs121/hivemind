# Sidecar feature modules

Main-process modules that back the persistent, per-project features wrapped around the
terminal panes: `plan.js`, `handoff.js`, `consult.js`, `promptHistory.js`, `transcript.js`,
`usage.js`.

All six live at the repo root, run in the **Electron main process**, and are wired into
IPC in one block of `main.js` (`main.js:787-850`). The renderer reaches them through the
`window.api.*` bridge defined in `preload.js:113-185`.

## Purpose

A Hivemind "hive" (board) is a project directory with several agent CLI panes running in
it. These modules add persistence and insight around those panes: a reviewable plan
document per thread (`plan.js`), the brief that carries a conversation from one thread to
another (`handoff.js`), the question-and-answer pair that gets one thread a second opinion
from another (`consult.js`), a log of every prompt sent (`promptHistory.js`), a rendered chat view of each pane's conversation
(`transcript.js`), and a per-agent subscription-usage readout (`usage.js`). Except for `usage.js`
(machine-global), each is scoped to the project directory: state lives in a `.hivemind/`
folder inside the project (kept out of Git by `plan.ensureIgnored`), or — for
transcripts — is read from Claude Code's own session files under `~/.claude/`. They share
a house style worth preserving: containment-guarded paths, atomic temp-then-rename
writes, per-file promise locks, and "a failed read is never treated as an empty file".

## plan.js

Backs the **plan review** feature: a thread's plan rendered as a markdown document with
highlight-and-comment review, opened from the 📋 chip in a pane header or shown as a chat
card (renderer "Plan review" section, `src/renderer.js:6840-7900`).

Two kinds of plan files feed the same UI:

- **Hivemind-requested plans** — the thread is asked to write
  `.hivemind/plans/<planId>.md` in the project (`planId` is a stable per-pane id from the
  renderer). Read/written via `readPlan` / `writePlan`.
- **Native Claude Code plan-mode files** — live *outside* the project under
  `~/.claude/plans/…`; read by absolute path via `readPlanFile`, which only allows the
  two roots `~/.claude/plans` and `<project>/.hivemind/plans` (case-insensitive compare
  on Windows, `plan.js:70-88`).

Comments are a sidecar JSON next to the Hivemind plan file:
`.hivemind/plans/<planId>.comments.json`, an array of comment objects the renderer keys
by quoted text (`{ id, quote, occurrence, body, resolved, sent }`,
`src/renderer.js:6884`).

| Export | Does | IPC channel (`main.js:790-799`) |
|---|---|---|
| `readPlan(root, planId)` | read `.md`, returns `{ok, content, mtime}` or `reason: 'not-found'/'no-dir'` | `plan:read` |
| `readPlanFile(root, file)` | read absolute path, root-allowlisted | `plan:readFile` |
| `writePlan(root, planId, content)` | write `.md` (in-panel edits, checkbox toggles) | `plan:write` |
| `readComments` / `writeComments` | sidecar JSON; a failed read is **not** treated as empty — corrupt/unreadable returns `{ok:false, reason:'corrupt'\|'unreadable'\|'error', message}` (ENOENT still returns `{ok:true, comments:[]}`), matching the promptHistory.js discipline; the renderer blocks saving comments after a failed read so real comments aren't overwritten | `plan:comments:read` / `plan:comments:write` |
| `clearPlan(root, planId)` | delete both files, ENOENT ok | `plan:clear` |
| `ensureIgnored(root)` | idempotently append `.hivemind/` to the project `.gitignore` | `plan:ensureIgnored` |

`planId` must match `/^[A-Za-z0-9._-]+$/` and every resolved path must stay inside
`<project>/.hivemind/plans` (`plan.js:41-49`). `ensureIgnored` is the shared
keep-out-of-Git helper: `promptHistory:ensureIgnored` and the
attachment stager (`main.js:688`) all delegate to it.

## handoff.js

Backs **thread handoff**: passing a conversation from one thread to another — a different
agent, a fresh context window, or a thread that's free. Renderer side is the "Thread
handoff" section of `src/renderer.js` (`startHandoff`, `handoffPoll`, `endHandoff`,
`cancelHandoff`, driven from the *Hand off to another thread* page of the chat top
bar's `⋯` conversation menu — `buildThreadMenu` / `buildThreadPicker`).

The transfer medium is a markdown **brief the source thread writes itself** to
`.hivemind/handoffs/<id>.md`. That choice is the design: only the source agent knows which
parts of its own context mattered, a file survives both threads restarting, and every
agent CLI can read markdown — a transcript format is neither portable nor summarised.
**Hivemind never writes a brief**, which is why this module has no write export and the
bridge exposes no write channel.

| Export | Does | IPC channel |
|---|---|---|
| `readHandoff(root, id)` | read the brief; `{ok, content, mtime}` or `reason: 'not-found'/'no-dir'/'error'` | `handoff:read` |
| `clearHandoff(root, id)` | delete one brief; ENOENT is `ok` | `handoff:clear` |
| `sweepHandoffs(root)` | delete briefs older than a week (`MAX_AGE_MS`) | `handoff:sweep` |
| `handoffRelPath(id)` | `.hivemind/handoffs/<id>.md` — the path both prompts name | — |

`id` must match `/^[A-Za-z0-9._-]+$/` and every resolved path must stay inside
`<project>/.hivemind/handoffs` — same guard as plan.js. The renderer generates the id
(`newHandoffId`, `h-<base36 ts>-<rand>`) and builds the same relative path in
`handoffRel`; keep the two in step.

The renderer's sequence, for reference:

1. resolve the target — an existing pane, or `addTerminal(board, { agent })` for a fresh
   thread, opened immediately so the user can see where the conversation is going;
2. `plan.ensureIgnored` + `handoff:sweep` (both best-effort — neither is worth failing a
   handoff over);
3. `deliverPrompt(source, …, { caption: false })` asking for the brief at that path — an
   ordinary prompt, because the PTY is always the delivery path, but kept out of the
   caption tracker (it is a multi-line outline; the thread is captioned
   "Handing off to <target>" instead);
4. poll `handoff:read` every `HANDOFF_POLL_MS` = 2 s until the content is non-trivial
   **and its `mtime` is unchanged since the previous poll** — agents write a draft and
   then revise it, and a half-written brief loses the rest — giving up after
   `HANDOFF_TIMEOUT_MS` = 5 min (a brief over a long conversation is a full turn);
5. `deliverPrompt(target, …)` pointing it at the same path, then focus it.

A handoff is a **copy**: the source thread is untouched afterwards, so the same
conversation can be handed to several threads. In-flight state lives on `pane.handoff`
and is deliberately **not** persisted into the layout — a brief still being written when
the app closes has no waiting thread on the other side. `disposePaneResources` clears the
poll interval, and a closed target ends the handoff with a notice.

## consult.js

Backs **thread consult**: one thread asking another for a **second opinion**, and getting
the answer back. Where a handoff *moves* a conversation, a consult keeps it — only a
question and an answer travel — so the asking thread carries on with the reply in hand.
Renderer side is the "Thread consult" section of `src/renderer.js` (`startConsult`,
`consultPoll`, `endConsult`, `cancelConsult`, `adoptConsult`, `consultInboxTick`), plus
the *Ask for a second opinion* page of the chat top bar's `⋯` conversation menu
(`buildThreadMenu` / `buildThreadPicker`), which also holds the handoff and the
past-conversation list.

Two files, same medium and same reasoning as the handoff brief — only the asking agent
knows what context its question needs, only the answering agent has the opinion, and
markdown is readable by every agent CLI:

```
.hivemind/consults/<id>.md         the question + context   (written by the ASKING thread)
.hivemind/consults/<id>.reply.md   the answer               (written by the ANSWERING thread)
.hivemind/consults/README.md       the protocol             (the one file Hivemind writes)
```

So a consult is a handoff with a return leg: `phase: 'question'` polls for the first
file, `phase: 'answer'` polls for the second, each with the same settle-on-mtime rule.
In-flight state lives on the **asking** pane (`pane.consult`); the answering thread is
just a thread that was sent a prompt and needs no state.

| Export | Does | IPC channel |
|---|---|---|
| `readConsult(root, id)` | read the question; `{ok, content, mtime}` or `reason: 'not-found'/'no-dir'/'error'` | `consult:read` |
| `readReply(root, id)` | read the answer, same shape | `consult:readReply` |
| `listRequests(root)` | `ask-*.md` questions with no answer beside them yet — `{ok, requests: [{id, mtime}]}` | `consult:requests` |
| `clearConsult(root, id)` | delete both sides; ENOENT is `ok` | `consult:clear` |
| `sweepConsults(root)` | delete consults older than a week (`MAX_AGE_MS`), keeping `README.md` | `consult:sweep` |
| `ensureConsultDocs(root)` | write `README.md` (the request protocol) if missing or stale | `consult:ensureDocs` |
| `consultRelPath(id)` / `replyRelPath(id)` | the paths both threads are told to use | — |

Ids must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, must **not contain `.reply`** (the id
`x.reply` would otherwise resolve its question onto `x`'s answer file), and every resolved
path must stay inside `<project>/.hivemind/consults` — same guard as plan.js. The renderer
generates solicited ids (`newConsultId`, `c-<base36 ts>-<rand>`) and rebuilds the same
relative paths in `consultRel` / `consultReplyRel`; keep the two in step.

**Two ways a consult starts.** The id prefix is what tells them apart, and it is load-bearing:

- `c-…` — **the user asked Hivemind**: the ⋯ menu's *Ask for a second opinion*, or "Hivemind, ask Gemini
  what it thinks about the caching plan". Hivemind generates the id and drives both legs
  from the start, so the poller already knows about it.
- `ask-…` — **a thread asked on its own**: the user told the agent itself ("go ask Codex"),
  and it wrote `.hivemind/consults/ask-<slug>.md` with `to:` / `from:` front matter. Nobody
  is driving it, so `listRequests` surfaces it and `consultInboxTick` (every
  `CONSULT_INBOX_MS` = 3 s, over every hive with a live thread) adopts it at the second leg.
  `README.md` is what teaches agents that format, and `HIVEMIND_THREAD` in each thread's
  environment (set in `spawnPty`) is how a thread knows its own name for `from:`.

`ensureConsultDocs` is the module's **only** write, and it writes neither side of a
consult — same rule as handoff.js. It is versioned by a marker line (`README_MARKER`), so
bumping the protocol rewrites stale copies in every project on the next consult.

## promptHistory.js

Backs the **Prompt History panel** (renderer `src/renderer.js:6627-6839`): a per-hive log
of prompts actually delivered to threads. Recorded by `recordPromptHistory`
(`src/renderer.js:6832`) after Hivemind-command interception, so app
commands never appear in it. Each row offers: click → jump to that bubble in an open
chat; the always-visible ➤ button → repost to the focused thread; 🎤 → re-speak the
prompt in voice training.

| Export | Does | IPC channel (`main.js:811-814`) |
|---|---|---|
| `readHistory(root)` | `{ok, entries}`; unreadable/corrupt is never reported as empty | `promptHistory:read` |
| `appendPrompt(root, entry)` | read-modify-write under the per-file lock; dedupes by exact `text` (repeat moves to the end with a fresh `ts`); aborts if the read failed | `promptHistory:append` |
| `writeHistory(root, entries)` | wholesale replace (used by the Clear button) | `promptHistory:write` |
| — (plan.ensureIgnored) | | `promptHistory:ensureIgnored` |

Data file: `.hivemind/prompt-history.json`, `[{ id, text, ts, agent }]` stored
oldest→newest (panel renders reversed), capped at 200 distinct entries (`MAX_ENTRIES`,
`promptHistory.js:22`). `agent` is `'claude'` / `'codex'` / `''`. Appending happens in
the main process precisely so simultaneous sends from several threads serialize instead
of clobbering.

## transcript.js

The largest module (~980 lines) and the only one that streams. It backs the **chat
view** — each pane's alternate rendered-conversation view — plus the per-pane **history
menu** (browse past sessions) and the **cost chip**. It runs in the **main process**:
editing it requires a full app relaunch. Ctrl+R only reloads the renderer; the module's
in-memory state (claims, tails, watchers) lives in main and old code keeps running.

### Where session files live

- **Claude Code**: one JSONL per session at
  `~/.claude/projects/<encoded-project-dir>/<session-uuid>.jsonl`, where the encoding
  replaces every non-alphanumeric character of the cwd with `-`
  (`encodeProjectDir`, `transcript.js:54`).
- **Codex CLI ("ChatGPT")**: `<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl` — one
  date-partitioned tree shared by *all* projects. A rollout's owning cwd is read from its
  first line (`session_meta.payload.cwd`, `codexCwd`, `transcript.js:589`), and binding
  filters on it. Only today's and yesterday's date dirs are scanned for new candidates
  (`codexRecentDateDirs`, `transcript.js:399`); already-bound files are tailed wherever
  they live. The home is `~/.codex` **unless the thread runs on a named ChatGPT
  account**, which relocates the whole home via `CODEX_HOME` (see `codex.js`) — `bind`
  takes a `codexHome`, resolved in main from the pane's account id, so panes on
  different accounts watch different roots. Forgetting to pass it doesn't break the
  thread; it silently leaves the chat view searching forever.

### The pane→file binding heuristic (rules in priority order)

Implemented across `bind` (`transcript.js:84`) and `scanDir` (`transcript.js:417`);
the rule list is also the module's header comment (`transcript.js:12-38`).

0. **Deterministic bind.** Hivemind starts fresh claude panes with
   `--session-id <uuid>` and restores with `--resume <uuid>` (`main.js:205-223`), and
   passes that uuid to `bind`. The pane claims `<uuid>.jsonl` immediately — even before
   the file exists; tailing starts when it appears, and a `timeout` status is emitted if
   it still hasn't appeared `BIND_TIMEOUT_MS` = 15 s **after the pane sends its first
   prompt**
   (`armTimeout`, armed from `noteSent` — claude writes the file lazily, so an idle
   thread having no transcript is normal and must not raise the notice). This is the
   normal path; everything below is fallback for `--continue`, codex, and legacy panes.
1. **One claim per file** — the `claims` map is authoritative, updated synchronously.
2. **Fresh panes take fresh files**: an unclaimed file born after the pane registered
   (minus `FRESH_SLACK_MS` = 2 s of shell-startup slack) is acceptable
   (`paneAccepts`, `transcript.js:572`).
3. **Resume (`--continue`) panes** prefer a fresh file, and only after
   `RESUME_FALLBACK_MS` = 10 s fall back to the most-recently-modified unclaimed
   *pre-existing* file (snapshot taken at bind time).
4. **First-user-text match beats age pairing**: the composer reports every sent message
   (`noteSent`, kept in a 5-entry `lastSent` ring). A candidate whose first real user
   message (`firstUserText`, cached peek of the head 256 KB) equals text exactly one
   waiting pane sent binds to that pane. Remaining panes pair oldest-file-to-oldest-pane,
   with two guards: a newborn file with no user line yet waits `TEXT_GRACE_MS` = 5 s so
   the text match gets first look, and a pane that has waited longer than
   `SPAWN_WINDOW_MS` = 30 s yields a just-born file to a just-spawned pane.
5. **Rollover** (`/clear` writes a new session file): a leftover unclaimed file re-binds
   an already-bound pane when its first user text matches that pane's sent text, or —
   only if the first user text is unreadable — when exactly one bound pane could own it.
   Readable-but-unmatched text is positive evidence of an unrelated run (e.g.
   `claude -p "…"` in the same directory) and never hijacks a pane
   (`transcript.js:531-565`).
6. **Self-heal**: a still-waiting pane whose sent text is the first user message of a
   file another pane holds — text that owner never sent — steals the claim; the loser
   rejoins the waiting pool. Deterministic claims are never stolen
   (`transcript.js:507-528`).

Released files enter a `retired` set so a closed pane's file can never look like a
rollover target for another pane (`releaseFile`, `transcript.js:630`); the set is now
capped (~500) rather than growing for the process lifetime. Likewise the `firstUser` /
`codexMeta` head-peek caches are pruned (on claim/release and on a per-dir scan of
vanished files) so they're no longer unbounded.

### Watching, tailing, parsing

Each transcript directory gets one ref-counted watcher: `fs.watch` (recursive for the
codex tree) plus a 2 s poll (`POLL_MS`) because Windows drops append events and the
directory may not exist yet (`ensureWatcher`, `transcript.js:313`). Tailing is
byte-offset based with a `partial` buffer so a line (or multi-byte char) split across
reads survives (`readAppended`, `transcript.js:658`); the `partial` buffer is capped
(~8 MB) so a newline-less file can't grow it without bound. Each complete line is
`JSON.parse`d and reduced: Claude lines via `slimEntry` (`transcript.js:711` — keeps
type/uuid/parentUuid/timestamp/meta flags/message role+model+content, plus
`message.id`/`usage`/`requestId` for the cost chip, and `toolUseResult`); codex rollout
lines via `normalizeCodexEntry` (`transcript.js:802`) which rewrites them into the same
Claude entry shape (synthetic uuids `cx:<lineNo>`). Every string is capped at 50 KB
(`MAX_STRING`) before crossing IPC. Non-backfill entries are debounced 50 ms per pane.

### IPC channels

| Channel | Direction / kind | Purpose |
|---|---|---|
| `transcript:bind` | invoke (`main.js:838`) | bind pane → session file; called at pane spawn (`src/renderer.js:4504`) |
| `transcript:unbind` | send | release claim (pane close/respawn) |
| `transcript:noteSent` | send | report sent text for the text-match rules; called by `deliverPrompt` (`src/renderer.js:1160`) and for spawn-time initial prompts (`src/renderer.js:4550` — mirrors main.js's whitespace normalization so it equals the transcript's first user line) |
| `transcript:sessions` | invoke | list past sessions for the history menu (`listSessions` — titles from a head peek: rolling `summary` line, else first user message) |
| `transcript:session` | invoke | read one whole past session (`readSession` — basename-only, containment-guarded) |
| `transcript:refresh` | send | re-emit the live file from offset 0 (leaving history view) |
| `transcript:entries` | push → renderer | `{paneId, entries, backfill}`; feeds `planScanEntries` → `chatIngest` → `costIngest` (`src/renderer.js:5105`) |
| `transcript:status` | push → renderer | `{paneId, status: 'searching'|'bound'|'timeout', file}` |

On `bound`, the renderer extracts the session uuid from the filename and persists it in
the layout so a restart `--resume`s this exact conversation (`src/renderer.js:5129`).
Note `bound` does **not** mean the file exists yet (deterministic binds claim first);
only arriving entries prove it (`pane.sessionBound`, `src/renderer.js:5108-5112`).

### Failure modes

- **Mis-bind** (heuristic paths only): the chat view renders the *wrong conversation*.
  Prompt delivery is unaffected — prompts are typed into the pane's PTY, a completely
  separate path. Secondary damage: the pane persists the wrong session id, so a restart
  would `--resume` the wrong session. Rule 6 self-heals the common case once the
  rightful pane's sent text lands on disk.
- **Timeout**: `searching` → `timeout` status 15 s after the pane's first sent prompt
  with no candidate; the chat view shows a notice but binding keeps trying (a late file
  still binds, and a deterministic pane re-announces `bound` when its file finally
  appears). The clock only ever starts on a send (`armTimeout`), and never for codex —
  a thread nobody has prompted yet has no transcript to find, and warning about that was
  a false alarm on every fresh thread.
- **Codex lazy rollouts**: codex often creates its file only on the first message, so a
  codex pane sitting unbound for minutes is normal — it stays quietly `searching`
  (`transcript.js:112-118`).

## usage.js

Backs the toolbar **usage pill** and the **Usage modal**. Hivemind bills against two
subscriptions at once — Claude Code and the Codex CLI ("ChatGPT") — so the readout is
**per agent, and within an agent per account**: the pill carries one segment per agent
(`Claude 62%  ChatGPT 5%`, each tinted ok/warn/crit at 60/85 by that agent's fullest
window), and the modal expands each agent into its accounts' windows plus today's tokens.
Renderer: the "Agent usage" section near the end of `src/renderer.js` (`renderUsagePill`,
`renderUsageAgent`, `renderUsageAccount`, `renderUsageTokens`); polled every 60 s and on
modal open.

Single export `getUsage({ force })` behind one IPC channel `usage:get`, with a 30 s
in-module cache (`force`, wired to the modal's ⟳, bypasses it; the minute poll does not).
It returns

```js
{ ok, fetchedAt, agents: [ {
    id, label, live, unitLabel, note,
    accounts: [ { id, label, email, plan, limits: [ {kind,label,percent,resetsAt,severity} ],
                  error, observedAt, observedNote } ],
    tokens: { byModel: { <model>: {messages,input,output,cacheRead,cacheCreate} } }, tokensError,
} ] }
```

Every source is caught into its own `error` / `tokensError`, and the two agents are
gathered with `Promise.all` + per-agent `.catch`, so no failure sinks another agent's
numbers.

### Claude (one machine login, live)

1. **Plan limits** — the same OAuth endpoint Claude Code's `/usage` screen calls
   (`https://api.anthropic.com/api/oauth/usage`), authenticated with the token in
   `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`, header
   `anthropic-beta: oauth-2025-04-20`). The request (`fetchClaudeLimits`) has an 8s
   `AbortController` timeout so a hung endpoint can't stall the readout. Windows: session
   5-hour, weekly all-models, weekly per-model. A 401 means the token rotated — Claude
   Code refreshes it whenever it runs, so using any thread and retrying clears it. The
   endpoint also budgets refreshes tightly (HTTP 429 — two Hivemind windows plus a few ⟳
   clicks will trip it), which is why only ⟳ forces a fetch and why a *refused* refresh
   falls back to `lastClaude`, the last reading the endpoint actually returned: the bars
   stay, now carrying `observedAt` + `observedNote` and the failure reason, exactly like
   the ChatGPT side. Blanking them would read as "your limits reset".
2. **Today's tokens** — no network: scans `~/.claude/projects/*/*.jsonl` **across all
   projects** (async via `fs.promises` so it doesn't block the main-process event loop),
   skipping files whose mtime predates local midnight, summing the `usage` block of every
   assistant message timestamped today. Dedupes on `message.id + requestId` (a message can
   be re-emitted on resume) and skips model `<synthetic>` (`claudeTokensToday`).

### ChatGPT / Codex (one login per `CODEX_HOME`, observed)

There is no `/usage` endpoint for Codex, but the CLI writes the server's rate-limit
snapshot into every session rollout: `event_msg` lines whose `payload.type` is
`token_count` carry a sibling `payload.rate_limits` block (`primary` / `secondary`, each
`{used_percent, window_minutes, resets_at | resets_in_seconds}`, plus `plan_type`).

- **Accounts** come from `codex.list()` — the CLI's own home plus every named account's
  managed home. `codex.js` needs Electron's `userData`, so a non-Electron caller falls
  back to the default home alone (this is also what makes the module testable with plain
  `node`).
- **Limits** (`codexLimits`) walk that home's `sessions/YYYY/MM/DD` tree newest-first (at
  most `CODEX_LIMIT_DAYS` = 14 date dirs / `CODEX_LIMIT_FILES` = 40 rollouts), read the
  **tail** of each rollout (`CODEX_TAIL_BYTES` = 256 KB — snapshots ride the last events,
  and rollouts run to megabytes), and take the newest parseable `rate_limits`.
  `codexWindowLabel` turns `window_minutes` into the same vocabulary the Claude side uses
  ("Session (5-hour window)", "Week — all models").
- These readings are **observed, not live**: they are as of the last time that account
  ran, so every account carries `observedAt` (+ `observedNote`, the clause the UI appends
  after the age) and the UI *must* show its age
  (`.usage-stamp`, and "as of …" in the pill tooltip). An account with no snapshot in 14
  days reports an `error` string instead of limits, and contributes no pill segment.
- **Today's tokens** (`codexTokensForHome`) scan the newest `CODEX_TOKEN_DAYS` = 3 date
  dirs, mtime-pruned to midnight. `token_count` events repeat the same `last_token_usage`
  when a turn ends without new spend, so summing deltas double-counts; instead
  `total_token_usage` (cumulative and monotonic within a rollout) is read as **final total
  minus the total as of the last pre-midnight event** — correct across midnight and immune
  to repeats. The model comes from the envelope-level `turn_context` lines
  (`o.type === 'turn_context'`, `payload.model`); Codex counts cached tokens *inside*
  `input_tokens`, so `cached_input_tokens` is subtracted out to make the "Input" column
  mean the same thing as Claude's.

This module is machine-global (not per-project) and writes nothing.

## On-disk data (`<project>/.hivemind/`)

| Path | Owner | Shape | Written when |
|---|---|---|---|
| `prompt-history.json` | promptHistory.js | `[{ id, text, ts, agent }]` oldest→newest, ≤200 | every delivered prompt (append), Clear (write `[]`) |
| `plans/<planId>.md` | plan.js | markdown | by the *thread* (Hivemind-requested plans) or by Hivemind on in-panel edits |
| `plans/<planId>.comments.json` | plan.js | `[{ id, quote, occurrence, body, resolved, sent }]` | every comment add/resolve/send |
| `handoffs/<id>.md` | the *thread* (handoff.js only reads/sweeps) | markdown brief: goal, done so far, decisions, open questions, next step | when a handoff is started; entries older than a week are swept on the next handoff |
| `consults/<id>.md` | the *asking thread* (consult.js only reads/sweeps) | markdown: question, context, what would change its mind | when a consult is started (`c-…`) or a thread asks unprompted (`ask-…`); swept after a week |
| `consults/<id>.reply.md` | the *answering thread* (consult.js only reads/sweeps) | markdown: answer, why, what it would do differently, caveats | when the answering thread replies; swept after a week |
| `consults/README.md` | consult.js (`ensureConsultDocs`) | the request protocol agents read to start a consult themselves | first consult on the hive, and whenever `README_MARKER` changes |
| `attachments/` | main.js (`attach:stage`, `main.js:683`) | staged file copies for codex threads | on attach; entries older than a week are swept |
| `kanban.json` | **nobody — legacy** | `[]` | was the Board (Kanban) panel, removed in commit `7172134`; safe to ignore/delete |

Claude Code session transcripts and native plan files are *read* but never owned:
`~/.claude/projects/…` (transcript.js, usage.js), `~/.claude/plans/…` (plan.js),
`<codex home>/sessions/…` (transcript.js). `.hivemind/` itself is kept out of Git by
`plan.ensureIgnored` — called opportunistically before nearly every write.

## Invariants & gotchas

1. **Never write over a failed read.** promptHistory.js distinguishes
   `'unreadable'`/`'corrupt'` from empty, and both module and renderer refuse to save in
   that state. Any new persistence must copy this — the user's own agent threads edit
   these files concurrently, and "couldn't read" mistaken for "empty" destroys data.
2. **Atomic writes + per-file locks.** All writes are temp-file-then-rename
   (`writeAtomic`, several private copies — plan.js now among them) and read-modify-writes
   are serialized per path (`withLock`). plan.js gained its own `withLock` too, so
   `writePlan`, `writeComments`, and `ensureIgnored`'s gitignore read-modify-write are now
   serialized per path like promptHistory.js. Don't add a plain `fs.writeFile`.
3. **Path containment everywhere.** Project-relative paths are resolved and checked to
   stay inside `.hivemind/` (or the plan-root allowlist); `readSession` accepts only a
   bare `.jsonl` basename. Renderer-supplied ids never reach the filesystem raw.
4. **transcript.js state lives in the main process.** Changes need a full app relaunch;
   a renderer reload re-invokes `bind` but runs against the old module. When testing
   live, use an isolated instance (`HM_USER_DATA`) — never kill the user's running app.
5. **`bound` ≠ file exists.** A deterministic bind claims the file before claude creates
   it; only `transcript:entries` proves the session is real (`--resume` of a
   never-written session dies with "No conversation found").
6. **Deterministic claims are ground truth** — the self-heal rule must never steal them,
   and released files are `retired` so they can't be re-bound as rollovers.
7. **usage.js is per agent, and machine-global.** Claude's limits need a subscription
   login (`~/.claude/.credentials.json`) — the 401 path is expected operation, not a bug —
   and both agents' token scans cover *all* projects on the machine, not just the open
   hive. ChatGPT's limits are a **recorded snapshot**, never live: any UI that shows them
   must show `observedAt` too, or it is claiming a stale number is current.
8. **AGENTS.md rule**: any user-facing change to these features (buttons, shortcuts,
   panels) must update the Help modal in `src/index.html` in the same change.

## How to extend: adding a new per-project sidecar feature

Follow the promptHistory.js template — it is the smallest complete example.

1. **Module** (`<feature>.js` at the repo root, main process): define
   `FEATURE_REL = '.hivemind/<feature>.json'`; copy the path guard
   (resolve against root, reject anything escaping `.hivemind/`), `writeAtomic`, and
   `withLock` patterns; export `read<X>(root)` / `write<X>(root, data)` returning
   `{ok, ...}` objects with `no-dir` / `unreadable` / `corrupt` reasons (never throw
   across IPC).
2. **IPC** (`main.js`, in the `-- IPC:` block near `main.js:800`):
   `const feature = require('./feature');` then
   `ipcMain.handle('feature:read', (_e, { cwd }) => feature.read(cwd));` etc. Add
   `ipcMain.handle('feature:ensureIgnored', (_e, { cwd }) => plan.ensureIgnored(cwd));`
   — reuse, don't reimplement.
3. **Preload** (`preload.js`, near line 125): expose a `feature: { read, write, … }`
   group on the bridge, mirroring the promptHistory entries.
4. **Renderer** (`src/renderer.js`): add a sidebar panel following the Prompt History
   panel pattern — a toggle that closes the other panels (`setHistoryOpen`-style mutual
   exclusion), `refresh` on open and on board change, a `loadFailed` flag that blocks
   saves after a bad read, and a call to `ensureIgnored` before the first write. Panel
   markup goes in `src/index.html`, styles in `src/styles.css`.
5. **Data file**: pick a JSON array/object shape, document it in the module header, and
   assume agent threads may edit it concurrently — re-read before append-style
   mutations (see `promptHistory.appendPrompt`) rather than trusting in-memory state.
6. **Help modal**: document the new panel/shortcut in `#help-modal`
   (`src/index.html`) — per AGENTS.md the change isn't done without it.

If the feature must react to files changing on disk (like the chat view), do the
watching in the main process (transcript.js's ref-counted watcher + poll pattern) and
push over a `feature:events` channel; remember that main-process changes require a full
relaunch to test.
