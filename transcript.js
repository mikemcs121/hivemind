'use strict';

// Transcript tailing for the chat wrapper. Claude Code writes a JSONL
// transcript per session under ~/.claude/projects/<encoded-project-dir>/;
// OpenAI's Codex CLI ("ChatGPT") writes a rollout JSONL per session under
// ~/.codex/sessions/YYYY/MM/DD/. Each chat-view pane binds to "its" session
// file and receives every appended line as a parsed entry, which the renderer
// classifies into chat rows. Codex lines are normalized here into the same
// entry shape Claude produces, so one chat renderer serves both agents. The
// interactive TUI in the pane's PTY is untouched — this module only reads.
//
// The hard part is deciding which file belongs to which pane when several
// panes run in the same project directory. Rules (in order):
//   0. A pane bound with an explicit `sessionId` claims `<sessionId>.jsonl`
//      outright — Hivemind starts claude with `--session-id <uuid>` (fresh
//      threads) or `--resume <uuid>` (which reuses the same session id), so
//      the file is known up front and none of the guessing below applies.
//   1. A file binds to at most one pane (synchronous claims, no races).
//   2. Fresh panes take an unclaimed file created after the pane spawned
//      (with slack for the shell-startup delay before `claude` is typed).
//   3. Resume panes (--continue) prefer a fresh file (older Claude Code
//      re-emitted resumed history into a new session file; current versions
//      reuse the original id and keep appending to the old file) and fall
//      back to the most recently modified unclaimed pre-existing file if no
//      new one appears within RESUME_FALLBACK_MS.
//   4. A candidate whose first user message matches text exactly one waiting
//      pane sent (noteSent — the composer and spawn-time initial prompts both
//      report) binds to that pane; the rest pair oldest-file-to-oldest-pane,
//      except that (a) a newborn file whose first user line hasn't hit disk
//      yet waits TEXT_GRACE_MS so the text-match gets first look, and (b) a
//      pane that has waited far longer than a Claude boot yields a just-born
//      file to a just-spawned pane.
//   5. After binding, a new unclaimed file can re-bind a pane (session
//      rollover via /clear) when the pane is alone in the directory or the
//      new file's first user text matches something the pane sent.
//   6. Self-heal: a waiting pane whose sent text is the first user message of
//      a file another pane holds — text that owner never sent — takes the
//      claim; the previous owner rejoins the waiting pool.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FRESH_SLACK_MS = 2000;      // spawn-time slack when judging "new" files
const TEXT_GRACE_MS = 5000;       // newborn file, no user line yet — let text-match see it first
const SPAWN_WINDOW_MS = 30000;    // a file born this soon after a pane spawned belongs to that spawn
const RESUME_FALLBACK_MS = 10000; // resume panes wait this long for a new file
const BIND_TIMEOUT_MS = 15000;    // then tell the renderer we're stuck
const POLL_MS = 2000;             // fs.watch misses appends on Windows; poll too
const EMIT_DEBOUNCE_MS = 50;
const MAX_STRING = 50 * 1024;     // cap any single string field sent to renderer
const LAST_SENT_MAX = 5;

const encodeProjectDir = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
const transcriptDirFor = (cwd) =>
  path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(cwd));
const codexSessionsRoot = () => path.join(os.homedir(), '.codex', 'sessions');

// Codex rollouts for every project share one date-partitioned tree, so panes
// can't be scoped by directory — each rollout's session_meta line carries the
// session's cwd instead, and binding filters candidates on it.
const normPath = (p) => {
  let r;
  try { r = path.resolve(String(p)); } catch (_) { r = String(p); }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

let send = () => {};

const watchers = new Map(); // dir -> { fsWatcher, pollTimer, scanTimer, refCount }
const panes = new Map();    // paneId -> pane record
const claims = new Map();   // filePath -> paneId
const retired = new Set();  // once-claimed files — never rollover targets again
const tails = new Map();    // filePath -> { offset, partial (Buffer), lineNo }
const firstUser = new Map(); // filePath -> { sizeChecked, text } (bind heuristics)
const codexMeta = new Map(); // filePath -> { sizeChecked, cwd } (session_meta peek)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bind({ paneId, cwd, resume, sessionId, agent }, sendFn) {
  if (sendFn) send = sendFn;
  unbind(paneId); // re-bind safely (respawn under the same id, defensive)
  const kind = agent === 'codex' ? 'codex' : 'claude';
  const dir = kind === 'codex' ? codexSessionsRoot() : transcriptDirFor(cwd);
  const pane = {
    paneId,
    agent: kind,
    cwd: String(cwd || ''),
    dir,
    resume: kind === 'claude' && !!resume,
    deterministic: false,
    timedOut: false,
    registeredAt: Date.now(),
    allowPreExisting: false,
    preExisting: kind === 'claude' ? snapshotDir(dir) : new Set(),
    boundFile: null,
    boundAt: 0,
    lastSent: [],
    pending: [],
    emitTimer: null,
    timeoutTimer: null,
    fallbackTimer: null,
  };
  panes.set(paneId, pane);
  ensureWatcher(dir, kind === 'codex'); // the codex tree is date-partitioned

  // Codex creates its rollout lazily (often only once the first message is
  // sent), so a fresh pane can sit unbound for minutes — that's normal, not
  // worth the "can't find the transcript" notice. Stay quietly 'searching'.
  if (kind === 'codex') {
    emitStatus(pane, 'searching');
    scanDir(dir);
    return { ok: true };
  }

  // Rule 0: the renderer knows this pane's session id (it started claude with
  // --session-id or --resume <id>), so the transcript file is known up front.
  // Claim it immediately — even before claude has created it; tailing starts
  // the moment it appears. If it never appears, tell the renderer we're stuck.
  if (typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)) {
    const file = path.join(dir, sessionId + '.jsonl');
    const ownerId = claims.get(file);
    if (!ownerId || !panes.has(ownerId)) {
      pane.deterministic = true;
      retired.delete(file); // resuming a file a closed/respawned pane released
      claimFile(pane, file);
      pane.timeoutTimer = setTimeout(() => {
        pane.timeoutTimer = null;
        if (pane.boundFile && !fs.existsSync(pane.boundFile)) {
          pane.timedOut = true;
          emitStatus(pane, 'timeout');
        }
      }, BIND_TIMEOUT_MS);
      return { ok: true };
    }
    // Same session claimed by another live pane (shouldn't happen — ids are
    // per-pane UUIDs). Fall through to the heuristics rather than fight.
  }

  if (pane.resume) {
    pane.fallbackTimer = setTimeout(() => {
      pane.fallbackTimer = null;
      pane.allowPreExisting = true;
      scanDir(dir);
    }, RESUME_FALLBACK_MS);
  }
  pane.timeoutTimer = setTimeout(() => {
    pane.timeoutTimer = null;
    if (!pane.boundFile) emitStatus(pane, 'timeout');
    // keep watching — a late file still binds
  }, BIND_TIMEOUT_MS);

  emitStatus(pane, 'searching');
  scanDir(dir);
  return { ok: true };
}

function unbind(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  panes.delete(paneId);
  clearTimeout(pane.timeoutTimer);
  clearTimeout(pane.fallbackTimer);
  clearTimeout(pane.emitTimer);
  releaseFile(pane);
  releaseWatcher(pane.dir);
}

// The composer reports every message it sends so binding can match a
// candidate file's first user message to the pane that typed it.
function noteSent(paneId, text) {
  const pane = panes.get(paneId);
  if (!pane || typeof text !== 'string') return;
  const t = text.trim();
  if (!t) return;
  pane.lastSent.push(t);
  if (pane.lastSent.length > LAST_SENT_MAX) pane.lastSent.shift();
}

function disposeAll() {
  for (const paneId of [...panes.keys()]) unbind(paneId);
}

// ---------------------------------------------------------------------------
// Conversation history (chat-overlay session picker)
// ---------------------------------------------------------------------------
// The chat overlay tails one live session file per pane. These three helpers
// let the renderer browse a project's *past* sessions read-only:
//   listSessions  — enumerate the transcript dir, one entry per session file
//   readSession   — parse one whole session file into slim entries
//   refresh       — re-emit the pane's live file (restore the live view after
//                   the user was browsing history)

// First-user / summary peek used to title a session in the picker. Reads only
// the file head — a session's rolling summary is re-emitted near the top, and
// the first real user message is the natural fallback title.
const HISTORY_PEEK_BYTES = 256 * 1024;
const PLUMBING_HEAD_RE =
  /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder)/;

function peekSession(file, size) {
  let firstUser = null;
  let summary = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, HISTORY_PEEK_BYTES);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let o;
        try { o = JSON.parse(t); } catch (_) { continue; }
        if (o.type === 'summary' && typeof o.summary === 'string' && o.summary.trim()) {
          summary = o.summary.trim();
        } else if (!firstUser && o.type === 'user' && !o.isMeta && !o.isSidechain && o.message) {
          const c = o.message.content;
          let val = null;
          if (typeof c === 'string') val = c.trim();
          else if (Array.isArray(c)) {
            const p = c.find((x) => x && x.type === 'text' && typeof x.text === 'string');
            if (p) val = p.text.trim();
          }
          if (val && !PLUMBING_HEAD_RE.test(val)) firstUser = val;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) { /* unreadable — no title */ }
  return { firstUser, summary };
}

// List the sessions in this pane's project transcript dir, newest first. The
// pane's currently-bound live file is flagged `current` so the picker can mark
// it and route a click back to the live view instead of re-reading it.
function listSessions({ paneId, cwd } = {}) {
  const dir = transcriptDirFor(cwd);
  const pane = panes.get(paneId);
  const currentFile = pane ? pane.boundFile : null;
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return { ok: true, sessions: [] }; }
  const sessions = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    if (!st.isFile() || st.size === 0) continue;
    const { firstUser, summary } = peekSession(file, st.size);
    const current = file === currentFile;
    // Skip empty/plumbing-only sessions (no title and not the live one) — they
    // only clutter the picker.
    if (!summary && !firstUser && !current) continue;
    sessions.push({
      name,
      current,
      mtimeMs: st.mtimeMs,
      birthMs: birthMs(st),
      title: summary || firstUser || '',
      preview: firstUser || '',
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { ok: true, sessions };
}

// Read one whole session file into slim entries. `name` must be a bare
// `.jsonl` basename that resolves inside the project's transcript dir — no
// path traversal, same containment guard as the file/plan/todo backends.
function readSession({ cwd, name } = {}) {
  if (typeof name !== 'string' || !name.endsWith('.jsonl') || path.basename(name) !== name) {
    return { ok: false, reason: 'bad-name' };
  }
  const dir = transcriptDirFor(cwd);
  const resolved = path.resolve(dir, name);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) return { ok: false, reason: 'bad-path' };
  let raw;
  try { raw = fs.readFileSync(resolved, 'utf8'); } catch (_) { return { ok: false, reason: 'read-failed' }; }
  const entries = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(slimEntry(JSON.parse(t))); } catch (_) { /* torn line — skip */ }
  }
  return { ok: true, entries };
}

// Re-emit the pane's live bound file from the top (as a backfill) — used to
// restore the live conversation after the user finishes browsing history.
function refresh(paneId) {
  const pane = panes.get(paneId);
  if (!pane || !pane.boundFile) return { ok: false };
  const tail = tails.get(pane.boundFile);
  if (tail) {
    tail.offset = 0;
    tail.partial = Buffer.alloc(0);
    tail.lineNo = 0;
  }
  readAppended(pane, pane.boundFile, true);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Directory watching
// ---------------------------------------------------------------------------

function ensureWatcher(dir, recursive) {
  let w = watchers.get(dir);
  if (w) {
    w.refCount += 1;
    return;
  }
  w = { fsWatcher: null, pollTimer: null, scanTimer: null, refCount: 1, recursive: !!recursive };
  watchers.set(dir, w);
  tryWatch(dir, w);
  // Poll fallback: catches missed append events, the directory not existing
  // yet (first Claude run in a project), and a dropped fs.watch handle.
  w.pollTimer = setInterval(() => {
    if (!w.fsWatcher) tryWatch(dir, w);
    scanDir(dir);
  }, POLL_MS);
}

function tryWatch(dir, w) {
  try {
    w.fsWatcher = fs.watch(dir, { recursive: w.recursive }, () => {
      // Coalesce event storms (one write can fire several events).
      if (w.scanTimer) return;
      w.scanTimer = setTimeout(() => {
        w.scanTimer = null;
        scanDir(dir);
      }, EMIT_DEBOUNCE_MS);
    });
    w.fsWatcher.on('error', () => {
      try { w.fsWatcher.close(); } catch (_) { /* already dead */ }
      w.fsWatcher = null; // poll re-establishes it
    });
  } catch (_) {
    w.fsWatcher = null; // dir missing — poll retries
  }
}

function releaseWatcher(dir) {
  const w = watchers.get(dir);
  if (!w) return;
  w.refCount -= 1;
  if (w.refCount > 0) return;
  watchers.delete(dir);
  clearInterval(w.pollTimer);
  clearTimeout(w.scanTimer);
  try { if (w.fsWatcher) w.fsWatcher.close(); } catch (_) { /* ignore */ }
}

function snapshotDir(dir) {
  const known = new Set();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.jsonl')) known.add(path.join(dir, name));
    }
  } catch (_) { /* dir doesn't exist yet */ }
  return known;
}

// Enumerate candidate session files. Claude: the project dir's *.jsonl.
// Codex: rollout-*.jsonl in the date dirs a fresh spawn could land in —
// today and yesterday (clock slack around midnight); older files can't be
// new-bind candidates anyway, and bound files are re-added by the caller.
function listSessionFiles(dir, agent) {
  const stats = new Map();
  if (agent === 'codex') {
    for (const day of codexRecentDateDirs(dir)) {
      let names;
      try { names = fs.readdirSync(day); } catch (_) { continue; }
      for (const name of names) {
        if (!/^rollout-.*\.jsonl$/i.test(name)) continue;
        const file = path.join(day, name);
        try { stats.set(file, fs.statSync(file)); } catch (_) { /* vanished */ }
      }
    }
    return stats;
  }
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try { stats.set(file, fs.statSync(file)); } catch (_) { /* vanished */ }
  }
  return stats;
}

// Codex partitions rollouts by local date: <root>/YYYY/MM/DD.
function codexRecentDateDirs(root) {
  const out = [];
  for (const back of [0, 1]) {
    const t = new Date(Date.now() - back * 24 * 60 * 60 * 1000);
    out.push(path.join(
      root,
      String(t.getFullYear()),
      String(t.getMonth() + 1).padStart(2, '0'),
      String(t.getDate()).padStart(2, '0')
    ));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scanning: tail bound files, bind waiting panes, handle session rollover
// ---------------------------------------------------------------------------

function scanDir(dir) {
  const dirPanes = [...panes.values()].filter((p) => p.dir === dir);
  if (!dirPanes.length) return;
  // A watched dir is either one Claude project dir or the shared codex root,
  // so every pane in it runs the same agent.
  const agent = dirPanes[0].agent;

  const stats = listSessionFiles(dir, agent); // filePath -> fs.Stats
  if (!stats) return; // dir doesn't exist yet

  // A long-running session can outlive the recent-date windows the codex
  // enumeration scans — keep tailing bound files wherever they live.
  for (const pane of dirPanes) {
    if (pane.boundFile && !stats.has(pane.boundFile)) {
      try { stats.set(pane.boundFile, fs.statSync(pane.boundFile)); } catch (_) { /* gone */ }
    }
  }

  // 1. Tail every bound file.
  for (const pane of dirPanes) {
    if (pane.boundFile && stats.has(pane.boundFile)) {
      // A deterministic bind whose file was slow to appear may have reported
      // 'timeout' — the file is here now, so re-announce the bind (nothing was
      // ingested while it didn't exist, so the renderer's reset is harmless).
      if (pane.timedOut) {
        pane.timedOut = false;
        emitStatus(pane, 'bound', pane.boundFile);
      }
      checkTail(pane, stats.get(pane.boundFile));
    }
  }

  const unclaimed = [...stats.keys()].filter((f) => !claims.has(f));

  // 2. Bind waiting panes (oldest pane first, oldest candidate first).
  const waiting = dirPanes
    .filter((p) => !p.boundFile)
    .sort((a, b) => a.registeredAt - b.registeredAt);
  if (waiting.length) {
    const taken = new Set();

    // Bind by first user message first: a candidate whose opening user text
    // matches something exactly one waiting pane sent belongs to that pane,
    // no matter how file/pane ages would pair up below.
    for (const file of unclaimed) {
      const st = stats.get(file);
      const text = firstUserText(file, st.size, agent);
      if (!text) continue;
      const matches = waiting.filter(
        (p) => !p.boundFile && p.lastSent.includes(text) && paneAccepts(p, file, st)
      );
      if (matches.length === 1) {
        claimFile(matches[0], file);
        taken.add(file);
      }
    }

    for (const pane of waiting) {
      if (pane.boundFile) continue;
      const candidates = unclaimed
        .filter((f) => !taken.has(f) && paneAccepts(pane, f, stats.get(f)))
        .sort((a, b) => birthMs(stats.get(a)) - birthMs(stats.get(b)));
      // Resume fallback prefers the most recently *used* old session.
      if (pane.allowPreExisting && candidates.length > 1) {
        candidates.sort((a, b) => stats.get(b).mtimeMs - stats.get(a).mtimeMs);
      }
      const file = candidates.find((f) => {
        const st = stats.get(f);
        // A newborn file whose first user line hasn't hit disk yet may
        // text-match another pane once it lands — don't age-pair it away.
        if (Date.now() - birthMs(st) < TEXT_GRACE_MS && !firstUserText(f, st.size, agent)) return false;
        // A pane that has waited far longer than a Claude boot yields a
        // just-born file to a just-spawned pane: new session files follow new
        // spawns, not threads whose session never materialized ages ago.
        if (birthMs(st) - pane.registeredAt > SPAWN_WINDOW_MS &&
            waiting.some((q) => q !== pane && !q.boundFile &&
              birthMs(st) >= q.registeredAt - FRESH_SLACK_MS &&
              birthMs(st) - q.registeredAt <= SPAWN_WINDOW_MS)) return false;
        return true;
      });
      if (file) {
        claimFile(pane, file);
        taken.add(file);
      }
    }

    // Self-heal a mis-bind: a waiting pane whose sent text is the first user
    // message of a file some other pane holds — text that owner never sent —
    // is the rightful owner. Take the claim; the loser rejoins the waiting
    // pool and re-binds (or times out) on later scans.
    for (const pane of waiting) {
      if (pane.boundFile || !pane.lastSent.length) continue;
      for (const [file, st] of stats) {
        const ownerId = claims.get(file);
        if (!ownerId || ownerId === pane.paneId) continue;
        const owner = panes.get(ownerId);
        // A deterministic claim is ground truth (claude was told that session
        // id) — never steal it, even on a text match.
        if (!owner || owner.deterministic || !paneAccepts(pane, file, st)) continue;
        const text = firstUserText(file, st.size, agent);
        if (!text || !pane.lastSent.includes(text) || owner.lastSent.includes(text)) continue;
        releaseFile(owner);
        emitStatus(owner, 'searching');
        clearTimeout(owner.timeoutTimer);
        owner.timeoutTimer = setTimeout(() => {
          owner.timeoutTimer = null;
          if (!owner.boundFile) emitStatus(owner, 'timeout');
        }, BIND_TIMEOUT_MS);
        claimFile(pane, file);
        break;
      }
    }
  }

  // 3. Session rollover (/clear writes a new file): re-bind a pane to a fresh
  // unclaimed file when it's unambiguous. Waiting panes were served first
  // above, so anything left here is genuinely extra.
  const leftovers = unclaimed.filter((f) => !claims.has(f) && !retired.has(f));
  if (leftovers.length && !dirPanes.some((p) => !p.boundFile)) {
    const bound = dirPanes.filter((p) => p.boundFile);
    for (const file of leftovers) {
      if (claims.has(file)) continue;
      const st = stats.get(file);
      // Only panes whose bound file actually exists can roll over — a
      // deterministic pane still waiting for claude to create its file must
      // not be hijacked by an unrelated transcript (e.g. a `claude -p` run).
      // cwdOk keeps a lone codex pane from rolling over onto some other
      // project's rollout (codex started outside Hivemind, another board…).
      const fresh = bound.filter((p) =>
        stats.has(p.boundFile) && birthMs(st) > p.boundAt && cwdOk(p, file, st.size));
      if (!fresh.length) continue;
      const text = firstUserText(file, st.size, agent);
      const byText = fresh.filter((p) => text && p.lastSent.includes(text));
      const target =
        byText.length === 1 ? byText[0] : fresh.length === 1 ? fresh[0] : null;
      if (target) {
        releaseFile(target);
        claimFile(target, file);
      }
    }
  }
}

function birthMs(st) {
  return st.birthtimeMs || st.mtimeMs;
}

function paneAccepts(pane, file, st) {
  if (!cwdOk(pane, file, st.size)) return false;
  if (birthMs(st) >= pane.registeredAt - FRESH_SLACK_MS) return true;
  return pane.allowPreExisting && pane.preExisting.has(file);
}

// Codex rollouts from every project share one tree — a candidate only fits a
// pane when its session_meta cwd matches the pane's project directory. (A file
// whose meta line hasn't hit disk yet matches nothing; later scans retry.)
function cwdOk(pane, file, size) {
  if (pane.agent !== 'codex') return true;
  const cwd = codexCwd(file, size);
  return !!cwd && normPath(cwd) === normPath(pane.cwd);
}

// Peek a rollout's first line (session_meta) for its cwd. Cached per file;
// re-read only while no meta has been parsed yet and the file has grown.
function codexCwd(file, size) {
  const cached = codexMeta.get(file);
  if (cached && (cached.cwd !== null || cached.sizeChecked === size)) return cached.cwd;
  let cwd = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      // session_meta is one (large — it embeds the base instructions) line.
      const buf = Buffer.alloc(Math.min(size, 256 * 1024));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t);
          if (o && o.type === 'session_meta' && o.payload && typeof o.payload.cwd === 'string') {
            cwd = o.payload.cwd;
          }
        } catch (_) { /* torn first line — retry when the file grows */ }
        break; // only the first line matters
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) { /* unreadable — treat as unknown */ }
  codexMeta.set(file, { sizeChecked: size, cwd });
  return cwd;
}

function claimFile(pane, file) {
  claims.set(file, pane.paneId);
  pane.boundFile = file;
  pane.boundAt = Date.now();
  clearTimeout(pane.timeoutTimer);
  clearTimeout(pane.fallbackTimer);
  pane.timeoutTimer = pane.fallbackTimer = null;
  tails.set(file, { offset: 0, partial: Buffer.alloc(0), lineNo: 0 });
  emitStatus(pane, 'bound', file);
  readAppended(pane, file, true);
}

function releaseFile(pane) {
  if (!pane.boundFile) return;
  claims.delete(pane.boundFile);
  tails.delete(pane.boundFile);
  // A released session file must never look like a fresh rollover target for
  // some other pane (e.g. closing thread B re-binding thread A to B's file).
  retired.add(pane.boundFile);
  pane.boundFile = null;
}

// ---------------------------------------------------------------------------
// Tailing a bound file
// ---------------------------------------------------------------------------

function checkTail(pane, st) {
  const tail = tails.get(pane.boundFile);
  if (!tail) return;
  if (st.size < tail.offset) {
    // Truncated/rewritten — start over and let the renderer re-render.
    tail.offset = 0;
    tail.partial = Buffer.alloc(0);
    tail.lineNo = 0;
    readAppended(pane, pane.boundFile, true);
  } else if (st.size > tail.offset) {
    readAppended(pane, pane.boundFile, false);
  }
}

function readAppended(pane, file, backfill) {
  const tail = tails.get(file);
  if (!tail) return;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= tail.offset) return;
    const chunks = [];
    let pos = tail.offset;
    const buf = Buffer.alloc(1024 * 1024);
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
    // `offset` counts bytes consumed from disk; a trailing partial line stays
    // buffered in `partial` (as bytes, so a multi-byte char straddling reads
    // survives intact) and is prepended on the next append.
    tail.offset = pos;
    const data = Buffer.concat([tail.partial, ...chunks]);
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl === -1) {
      tail.partial = data;
      return;
    }
    tail.partial = Buffer.from(data.subarray(lastNl + 1));
    const entries = [];
    for (const line of data.subarray(0, lastNl).toString('utf8').split('\n')) {
      // Count every raw line so codex row keys ('cx:<line>') are stable across
      // re-reads regardless of blank or malformed lines in between.
      const lineNo = tail.lineNo++;
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        const entry = pane.agent === 'codex' ? normalizeCodexEntry(o, lineNo) : slimEntry(o);
        if (entry) entries.push(entry);
      } catch (_) { /* torn or malformed line — skip */ }
    }
    if (entries.length) queueEmit(pane, entries, backfill);
  } catch (_) {
    /* file vanished mid-read — next scan re-handles it */
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

// Renderers only need a subset of each transcript line, and giant tool
// results shouldn't cross IPC at full size.
function slimEntry(o) {
  const e = {
    type: o.type,
    uuid: o.uuid,
    parentUuid: o.parentUuid,
    timestamp: o.timestamp,
    isMeta: o.isMeta,
    isSidechain: o.isSidechain,
    subtype: o.subtype,
    summary: o.summary,
    content: o.content,
  };
  if (o.message && typeof o.message === 'object') {
    e.message = {
      role: o.message.role,
      model: o.message.model,
      content: o.message.content,
    };
    // Token usage for the per-pane cost estimate. Forwarded verbatim so the
    // cache_creation 5m/1h breakdown (newer transcripts) survives; id and
    // requestId let the renderer dedup multi-line messages like usage.js does.
    if (o.message.id) e.message.id = o.message.id;
    if (o.message.usage) e.message.usage = o.message.usage;
  }
  if (o.requestId) e.requestId = o.requestId;
  if (o.toolUseResult !== undefined) e.toolUseResult = o.toolUseResult;
  return capStrings(e);
}

function capStrings(value) {
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? value.slice(0, MAX_STRING) + '\n… [truncated]'
      : value;
  }
  if (Array.isArray(value)) return value.map(capStrings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = capStrings(value[k]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Codex rollout normalization
// ---------------------------------------------------------------------------
// Rollout lines are { timestamp, type, payload }. Normalize each into the
// Claude-transcript entry shape the renderer already renders (user/assistant
// bubbles, tool_use/tool_result, thinking, meta) and return null for lines the
// chat view shouldn't show: event_msg streams that duplicate response_item
// lines, token counts, and per-turn context blobs.

// Context blocks codex injects into the conversation as "user" messages.
const CODEX_PLUMBING_RE =
  /^<(environment_context|user_instructions|permissions|turn_state|turn_aborted|ide_[a-z_]*|AGENTS)/i;

const codexText = (parts, types) =>
  (Array.isArray(parts) ? parts : [])
    .filter((c) => c && types.includes(c.type) && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();

const codexToolUse = (name, id, input) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

// Codex tool names are raw snake_case ids ("apply_patch", "web_search"); give
// the chat's tool rows the same title-case look Claude tool names have.
const CODEX_TOOL_LABELS = {
  shell: 'Shell',
  local_shell: 'Shell',
  unified_exec: 'Shell',
  exec_command: 'Shell',
  apply_patch: 'Apply patch',
  update_plan: 'Update plan',
  view_image: 'View image',
  web_search: 'Web search',
};
function codexToolLabel(name) {
  if (!name) return 'tool';
  if (CODEX_TOOL_LABELS[name]) return CODEX_TOOL_LABELS[name];
  if (/^[a-z0-9_]+$/.test(name)) {
    const s = name.replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return name; // MCP-style names stay as-is
}

function normalizeCodexEntry(o, lineNo) {
  const e = codexPayloadEntry(o && o.type, (o && o.payload) || {});
  if (!e) return null;
  e.uuid = 'cx:' + lineNo;
  e.timestamp = o.timestamp;
  return capStrings(e);
}

function codexPayloadEntry(type, p) {
  if (type === 'compacted') return { type: 'system', content: 'conversation compacted' };
  if (type === 'event_msg') {
    // agent_message/user_message/reasoning events all have response_item
    // twins; only surface what exists nowhere else.
    if (p.type === 'error') return { type: 'system', subtype: 'error', content: p.message || 'error' };
    if (p.type === 'turn_aborted') return { type: 'system', content: 'turn interrupted' };
    return null;
  }
  if (type !== 'response_item') return null; // session_meta, turn_context, …
  switch (p.type) {
    case 'message': {
      if (p.role === 'assistant') {
        const text = codexText(p.content, ['output_text', 'text']);
        if (!text) return null;
        return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
      }
      if (p.role !== 'user') return null; // developer/system instruction blobs
      const text = codexText(p.content, ['input_text', 'text']);
      if (!text) return null;
      const tag = CODEX_PLUMBING_RE.exec(text);
      if (tag) return { type: 'system', content: tag[1].replace(/_/g, ' ').toLowerCase() };
      return { type: 'user', message: { role: 'user', content: text } };
    }
    case 'reasoning': {
      // Only the summary is readable — the chain itself ships encrypted.
      const text = codexText(p.summary, ['summary_text']);
      if (!text) return null;
      return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } };
    }
    case 'function_call': {
      let input = null;
      try {
        const parsed = JSON.parse(p.arguments);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
      } catch (_) { /* not JSON — keep raw below */ }
      if (!input) input = typeof p.arguments === 'string' && p.arguments ? { arguments: p.arguments } : {};
      return codexToolUse(codexToolLabel(p.name), p.call_id, input);
    }
    case 'local_shell_call': {
      const cmd = p.action && Array.isArray(p.action.command) ? p.action.command.join(' ') : '';
      return codexToolUse('Shell', p.call_id || p.id, { command: cmd });
    }
    case 'custom_tool_call': {
      const input = {};
      if (typeof p.input === 'string') {
        // apply_patch input is a patch blob — surface the first touched file
        // as the tool row's one-line summary.
        const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(p.input);
        if (m) input.file_path = m[1].trim();
        input.input = p.input;
      }
      return codexToolUse(codexToolLabel(p.name), p.call_id, input);
    }
    case 'web_search_call':
      return codexToolUse('Web search', p.call_id || p.id, {
        query: (p.action && p.action.query) || '',
      });
    case 'function_call_output':
    case 'custom_tool_call_output': {
      let out = p.output;
      if (out && typeof out === 'object') {
        out = typeof out.output === 'string' ? out.output : safeJsonStr(out);
      }
      out = typeof out === 'string' ? out : String(out == null ? '' : out);
      return {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: p.call_id,
            content: out,
            // Shell outputs lead with "Exit code: N" — flag failures.
            is_error: /^Exit code: (?!0\b)\d+/.test(out),
          }],
        },
      };
    }
    default:
      return null;
  }
}

const safeJsonStr = (v) => {
  try { return JSON.stringify(v); } catch (_) { return String(v); }
};

function queueEmit(pane, entries, backfill) {
  if (backfill) {
    // Flush anything pending first so ordering stays sane on re-reads.
    flushPending(pane);
    send('transcript:entries', { paneId: pane.paneId, entries, backfill: true });
    return;
  }
  pane.pending.push(...entries);
  if (!pane.emitTimer) {
    pane.emitTimer = setTimeout(() => flushPending(pane), EMIT_DEBOUNCE_MS);
  }
}

function flushPending(pane) {
  clearTimeout(pane.emitTimer);
  pane.emitTimer = null;
  if (!pane.pending.length) return;
  const entries = pane.pending;
  pane.pending = [];
  send('transcript:entries', { paneId: pane.paneId, entries });
}

function emitStatus(pane, status, file) {
  send('transcript:status', { paneId: pane.paneId, status, file: file || null });
}

// ---------------------------------------------------------------------------
// First-user-message peek (binding disambiguation)
// ---------------------------------------------------------------------------

// Returns the trimmed text of the file's first real user message, or null.
// Cached per file; re-read only while no user line has appeared yet and the
// file has grown since the last look.
function firstUserText(file, size, agent) {
  const cached = firstUser.get(file);
  if (cached && (cached.text !== null || cached.sizeChecked === size)) {
    return cached.text;
  }
  let text = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, 256 * 1024));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        let o;
        try { o = JSON.parse(line); } catch (_) { continue; }
        text = agent === 'codex' ? codexUserLineText(o) : claudeUserLineText(o);
        if (text) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) { /* unreadable — treat as no user text */ }
  firstUser.set(file, { sizeChecked: size, text });
  return text;
}

function claudeUserLineText(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain || !o.message) return null;
  const c = o.message.content;
  if (typeof c === 'string') return c.trim() || null;
  if (Array.isArray(c)) {
    const t = c.find((p) => p && p.type === 'text' && typeof p.text === 'string');
    if (!t) return null; // tool_result-only "user" line — not a real turn
    return t.text.trim() || null;
  }
  return null;
}

// The user's text appears both as an event_msg and a response_item user
// message; the latter also carries injected context blocks (all of which start
// with an XML-ish tag) — skip those, take whichever real text comes first.
function codexUserLineText(o) {
  const p = o.payload || {};
  if (o.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
    return p.message.trim() || null;
  }
  if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
    const text = codexText(p.content, ['input_text', 'text']);
    if (text && !CODEX_PLUMBING_RE.test(text) && !text.startsWith('<')) return text;
  }
  return null;
}

module.exports = { bind, unbind, noteSent, disposeAll, listSessions, readSession, refresh };
