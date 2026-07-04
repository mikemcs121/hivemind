'use strict';

// Transcript tailing for the chat wrapper. Claude Code writes a JSONL
// transcript per session under ~/.claude/projects/<encoded-project-dir>/.
// Each chat-view pane binds to "its" session file and receives every appended
// line as a parsed entry, which the renderer classifies into chat rows. The
// interactive TUI in the pane's PTY is untouched — this module only reads.
//
// The hard part is deciding which file belongs to which pane when several
// panes run in the same project directory. Rules (in order):
//   1. A file binds to at most one pane (synchronous claims, no races).
//   2. Fresh panes take an unclaimed file created after the pane spawned
//      (with slack for the shell-startup delay before `claude` is typed).
//   3. Resume panes (--continue) prefer a fresh file too — current Claude
//      Code re-emits the resumed history into a new session file — but fall
//      back to the most recently modified unclaimed pre-existing file if no
//      new one appears within RESUME_FALLBACK_MS.
//   4. A candidate whose first user message matches text exactly one waiting
//      pane sent (noteSent — the composer and spawn-time initial prompts both
//      report) binds to that pane; the rest pair oldest-file-to-oldest-pane.
//   5. After binding, a new unclaimed file can re-bind a pane (session
//      rollover via /clear) when the pane is alone in the directory or the
//      new file's first user text matches something the pane sent.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FRESH_SLACK_MS = 2000;      // spawn-time slack when judging "new" files
const RESUME_FALLBACK_MS = 10000; // resume panes wait this long for a new file
const BIND_TIMEOUT_MS = 15000;    // then tell the renderer we're stuck
const POLL_MS = 2000;             // fs.watch misses appends on Windows; poll too
const EMIT_DEBOUNCE_MS = 50;
const MAX_STRING = 50 * 1024;     // cap any single string field sent to renderer
const LAST_SENT_MAX = 5;

const encodeProjectDir = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
const transcriptDirFor = (cwd) =>
  path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(cwd));

let send = () => {};

const watchers = new Map(); // dir -> { fsWatcher, pollTimer, scanTimer, refCount }
const panes = new Map();    // paneId -> pane record
const claims = new Map();   // filePath -> paneId
const retired = new Set();  // once-claimed files — never rollover targets again
const tails = new Map();    // filePath -> { offset, partial (Buffer) }
const firstUser = new Map(); // filePath -> { sizeChecked, text } (bind heuristics)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function bind({ paneId, cwd, resume }, sendFn) {
  if (sendFn) send = sendFn;
  unbind(paneId); // re-bind safely (respawn under the same id, defensive)
  const dir = transcriptDirFor(cwd);
  const pane = {
    paneId,
    dir,
    resume: !!resume,
    registeredAt: Date.now(),
    allowPreExisting: false,
    preExisting: snapshotDir(dir),
    boundFile: null,
    boundAt: 0,
    lastSent: [],
    pending: [],
    emitTimer: null,
    timeoutTimer: null,
    fallbackTimer: null,
  };
  panes.set(paneId, pane);
  ensureWatcher(dir);

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
  }
  readAppended(pane, pane.boundFile, true);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Directory watching
// ---------------------------------------------------------------------------

function ensureWatcher(dir) {
  let w = watchers.get(dir);
  if (w) {
    w.refCount += 1;
    return;
  }
  w = { fsWatcher: null, pollTimer: null, scanTimer: null, refCount: 1 };
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
    w.fsWatcher = fs.watch(dir, () => {
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

// ---------------------------------------------------------------------------
// Scanning: tail bound files, bind waiting panes, handle session rollover
// ---------------------------------------------------------------------------

function scanDir(dir) {
  const dirPanes = [...panes.values()].filter((p) => p.dir === dir);
  if (!dirPanes.length) return;

  const stats = new Map(); // filePath -> fs.Stats
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try { stats.set(file, fs.statSync(file)); } catch (_) { /* vanished */ }
    }
  } catch (_) {
    return; // dir doesn't exist yet
  }

  // 1. Tail every bound file.
  for (const pane of dirPanes) {
    if (pane.boundFile && stats.has(pane.boundFile)) {
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
      const text = firstUserText(file, st.size);
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
      if (candidates.length) {
        claimFile(pane, candidates[0]);
        taken.add(candidates[0]);
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
      const fresh = bound.filter((p) => birthMs(st) > p.boundAt);
      if (!fresh.length) continue;
      const text = firstUserText(file, st.size);
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
  if (birthMs(st) >= pane.registeredAt - FRESH_SLACK_MS) return true;
  return pane.allowPreExisting && pane.preExisting.has(file);
}

function claimFile(pane, file) {
  claims.set(file, pane.paneId);
  pane.boundFile = file;
  pane.boundAt = Date.now();
  clearTimeout(pane.timeoutTimer);
  clearTimeout(pane.fallbackTimer);
  pane.timeoutTimer = pane.fallbackTimer = null;
  tails.set(file, { offset: 0, partial: Buffer.alloc(0) });
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
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(slimEntry(JSON.parse(t)));
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
  }
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
function firstUserText(file, size) {
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
        if (o.type !== 'user' || o.isMeta || o.isSidechain || !o.message) continue;
        const c = o.message.content;
        if (typeof c === 'string') text = c.trim();
        else if (Array.isArray(c)) {
          const t = c.find((p) => p && p.type === 'text' && typeof p.text === 'string');
          if (!t) continue; // tool_result-only "user" line — not a real turn
          text = t.text.trim();
        }
        if (text) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) { /* unreadable — treat as no user text */ }
  firstUser.set(file, { sizeChecked: size, text });
  return text;
}

module.exports = { bind, unbind, noteSent, disposeAll, listSessions, readSession, refresh };
