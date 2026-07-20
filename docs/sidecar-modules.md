# Sidecar feature modules

Main-process modules that back the persistent, per-project features wrapped around the
terminal panes: `plan.js`, `todo.js`, `promptHistory.js`, `transcript.js`, `usage.js`.

All five live at the repo root, run in the **Electron main process**, and are wired into
IPC in one block of `main.js` (`main.js:787-850`). The renderer reaches them through the
`window.api.*` bridge defined in `preload.js:113-185`.

## Purpose

A Hivemind "hive" (board) is a project directory with several agent CLI panes running in
it. These modules add persistence and insight around those panes: a reviewable plan
document per thread (`plan.js`), a shared checklist (`todo.js`), a log of every prompt
sent (`promptHistory.js`), a rendered chat view of each pane's conversation
(`transcript.js`), and a subscription-usage readout (`usage.js`). Except for `usage.js`
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
| `readComments` / `writeComments` | sidecar JSON; corrupt read yields `[]` (comments are expendable) | `plan:comments:read` / `plan:comments:write` |
| `clearPlan(root, planId)` | delete both files, ENOENT ok | `plan:clear` |
| `ensureIgnored(root)` | idempotently append `.hivemind/` to the project `.gitignore` | `plan:ensureIgnored` |

`planId` must match `/^[A-Za-z0-9._-]+$/` and every resolved path must stay inside
`<project>/.hivemind/plans` (`plan.js:41-49`). `ensureIgnored` is the shared
keep-out-of-Git helper: `todo:ensureIgnored`, `promptHistory:ensureIgnored`, and the
attachment stager (`main.js:688`) all delegate to it.

## todo.js

Backs the **Todo panel** in the sidebar (renderer `src/renderer.js:6227-6626`): one
shared checklist per hive (scoped to cwd, not per-thread), with nesting, rename,
clear-completed, and a composer capture — a message starting with the word "todo" becomes
a checklist item instead of a prompt (`TODO_PREFIX_RE`, `src/renderer.js:6321`).

| Export | Does | IPC channel (`main.js:803-807`) |
|---|---|---|
| `readTodos(root)` | returns `{ok, todos}`; missing file → `[]`; unreadable/corrupt → `{ok:false, reason:'unreadable'|'corrupt'}` | `todo:read` |
| `writeTodos(root, todos)` | atomic + per-file lock, creates `.hivemind/` | `todo:write` |
| — (plan.ensureIgnored) | | `todo:ensureIgnored` |

Data file: `.hivemind/todos.json`. The module header says `[{ id, text, done }]` but the
real shape is a **tree** — the renderer adds `children` (and a transient `collapsed`)
and normalizes on read (`normalizeTodos`, item ids like `todo-<base36>-<n>`). Treat
`{ id, text, done, children: [...] }` as the canonical shape.

The renderer refuses to save while the last read failed (`todoLoadFailed`,
`src/renderer.js:6245,6294`), and the "todo …" capture path re-reads from disk before
appending (`addTodoItem`, `src/renderer.js:6331`) because Claude threads edit the file
directly and the panel's in-memory copy may be stale.

## promptHistory.js

Backs the **Prompt History panel** (renderer `src/renderer.js:6627-6839`): a per-hive log
of prompts actually delivered to threads. Recorded by `recordPromptHistory`
(`src/renderer.js:6832`) after Hivemind-command / todo-prefix interception, so app
commands never appear in it. Each row offers: click → jump to that bubble in an open
chat; ↩ → repost to the focused thread; 🎤 → re-speak the prompt in voice training.

| Export | Does | IPC channel (`main.js:811-814`) |
|---|---|---|
| `readHistory(root)` | `{ok, entries}`; same unreadable/corrupt discipline as todo.js | `promptHistory:read` |
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
- **Codex CLI ("ChatGPT")**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — one
  date-partitioned tree shared by *all* projects. A rollout's owning cwd is read from its
  first line (`session_meta.payload.cwd`, `codexCwd`, `transcript.js:589`), and binding
  filters on it. Only today's and yesterday's date dirs are scanned for new candidates
  (`codexRecentDateDirs`, `transcript.js:399`); already-bound files are tailed wherever
  they live.

### The pane→file binding heuristic (rules in priority order)

Implemented across `bind` (`transcript.js:84`) and `scanDir` (`transcript.js:417`);
the rule list is also the module's header comment (`transcript.js:12-38`).

0. **Deterministic bind.** Hivemind starts fresh claude panes with
   `--session-id <uuid>` and restores with `--resume <uuid>` (`main.js:205-223`), and
   passes that uuid to `bind`. The pane claims `<uuid>.jsonl` immediately — even before
   the file exists; tailing starts when it appears, and a `timeout` status is emitted if
   it never does (`BIND_TIMEOUT_MS` = 15 s). This is the normal path; everything below is
   fallback for `--continue`, codex, and legacy panes.
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
rollover target for another pane (`releaseFile`, `transcript.js:630`).

### Watching, tailing, parsing

Each transcript directory gets one ref-counted watcher: `fs.watch` (recursive for the
codex tree) plus a 2 s poll (`POLL_MS`) because Windows drops append events and the
directory may not exist yet (`ensureWatcher`, `transcript.js:313`). Tailing is
byte-offset based with a `partial` buffer so a line (or multi-byte char) split across
reads survives (`readAppended`, `transcript.js:658`). Each complete line is
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
| `transcript:noteSent` | send | report sent text for the text-match rules; called by `deliverPrompt` (`src/renderer.js:1125`) and for spawn-time initial prompts (`src/renderer.js:4515` — mirrors main.js's whitespace normalization so it equals the transcript's first user line) |
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
- **Timeout**: `searching` → `timeout` status after 15 s with no candidate; the chat
  view shows a notice but binding keeps trying (a late file still binds, and a
  deterministic pane re-announces `bound` when its file finally appears).
- **Codex lazy rollouts**: codex often creates its file only on the first message, so a
  codex pane sitting unbound for minutes is normal — it stays quietly `searching`
  (`transcript.js:112-118`).

## usage.js

Backs the toolbar **usage pill** (shows the fullest rate-limit window as a percent,
colored ok/warn/crit at 60/85) and the **Usage modal** (per-window bars + today's token
table). Renderer: `src/renderer.js:9908-10038`; polled every 60 s and on modal open.

Single export `getUsage()` behind one IPC channel `usage:get` (`main.js:833`), with a
30 s in-module cache. It combines two local-first sources, each failing independently
into `limitsError` / `tokensError` without sinking the other:

1. **Plan limits** — the same OAuth endpoint Claude Code's `/usage` screen calls
   (`https://api.anthropic.com/api/oauth/usage`), authenticated with the token in
   `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`, header
   `anthropic-beta: oauth-2025-04-20`). Returns `{kind, label, percent, resetsAt,
   severity}` per window (session 5-hour, weekly all-models, weekly per-model). A 401
   means the token rotated — Claude Code refreshes it whenever it runs, so using any
   thread and retrying clears it (`usage.js:62-66`).
2. **Today's tokens** — no network: scans `~/.claude/projects/*/*.jsonl` **across all
   projects**, skipping files whose mtime predates local midnight, summing the `usage`
   block of every assistant message timestamped today. Dedupes on
   `message.id + requestId` (a message can be re-emitted on resume) and skips model
   `<synthetic>`. Result: `tokens.byModel[model] = { messages, input, output, cacheRead,
   cacheCreate }` (`tokensToday`, `usage.js:87-137`).

This module is machine-global (not per-project) and writes nothing.

## On-disk data (`<project>/.hivemind/`)

| Path | Owner | Shape | Written when |
|---|---|---|---|
| `todos.json` | todo.js | `[{ id, text, done, children: [...] }]` (nested tree) | every panel edit; also directly by agent threads |
| `prompt-history.json` | promptHistory.js | `[{ id, text, ts, agent }]` oldest→newest, ≤200 | every delivered prompt (append), Clear (write `[]`) |
| `plans/<planId>.md` | plan.js | markdown | by the *thread* (Hivemind-requested plans) or by Hivemind on in-panel edits |
| `plans/<planId>.comments.json` | plan.js | `[{ id, quote, occurrence, body, resolved, sent }]` | every comment add/resolve/send |
| `attachments/` | main.js (`attach:stage`, `main.js:683`) | staged file copies for codex threads | on attach; entries older than a week are swept |
| `kanban.json` | **nobody — legacy** | `[]` | was the Board (Kanban) panel, removed in commit `7172134`; safe to ignore/delete |

Claude Code session transcripts and native plan files are *read* but never owned:
`~/.claude/projects/…` (transcript.js, usage.js), `~/.claude/plans/…` (plan.js),
`~/.codex/sessions/…` (transcript.js). `.hivemind/` itself is kept out of Git by
`plan.ensureIgnored` — called opportunistically before nearly every write.

## Invariants & gotchas

1. **Never write over a failed read.** todo.js and promptHistory.js distinguish
   `'unreadable'`/`'corrupt'` from empty, and both module and renderer refuse to save in
   that state. Any new persistence must copy this — the user's own agent threads edit
   these files concurrently, and "couldn't read" mistaken for "empty" destroys data.
2. **Atomic writes + per-file locks.** All writes are temp-file-then-rename
   (`writeAtomic`, three private copies) and read-modify-writes are serialized per path
   (`withLock`). Don't add a plain `fs.writeFile`.
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
7. **todos.json is a tree** despite the module comment's flat sketch; keep `children`
   round-tripping through any code that touches it.
8. **usage.js needs a subscription login** (`~/.claude/.credentials.json`); its 401 path
   is expected operation, not a bug, and its token scan covers *all* projects on the
   machine, not just the open hive.
9. **CLAUDE.md rule**: any user-facing change to these features (buttons, shortcuts,
   panels) must update the Help modal in `src/index.html` in the same change.

## How to extend: adding a new per-project sidecar feature

Follow the todo.js template — it is the smallest complete example.

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
   group on the bridge, mirroring the todo/promptHistory entries.
4. **Renderer** (`src/renderer.js`): add a sidebar panel following the Todo panel
   pattern — a toggle that closes the other panels (`setTodoOpen`-style mutual
   exclusion), `refresh` on open and on board change, a `loadFailed` flag that blocks
   saves after a bad read, and a call to `ensureIgnored` before the first write. Panel
   markup goes in `src/index.html`, styles in `src/styles.css`.
5. **Data file**: pick a JSON array/object shape, document it in the module header, and
   assume agent threads may edit it concurrently — re-read before append-style
   mutations (see `addTodoItem`) rather than trusting in-memory state.
6. **Help modal**: document the new panel/shortcut in `#help-modal`
   (`src/index.html`) — per CLAUDE.md the change isn't done without it.

If the feature must react to files changing on disk (like the chat view), do the
watching in the main process (transcript.js's ref-counted watcher + poll pattern) and
push over a `feature:events` channel; remember that main-process changes require a full
relaunch to test.
