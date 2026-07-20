'use strict';

// ---------------------------------------------------------------------------
// Prompt History panel backend: a per-hive log of prompts sent to threads,
// stored as JSON in the board's project directory:
//
//   .hivemind/prompt-history.json  -- [{ id, text, ts, agent }]
//
// Scoped to the project directory (cwd) like the Todo panel — one shared list
// per hive, not per-thread. Appended newest-last (the panel renders it
// newest-first). The path is resolved and checked to stay inside the project's
// `.hivemind/` folder (same guard as todo.js / files.js / plan.js).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const HISTORY_REL = '.hivemind/prompt-history.json';

// Repeats of the same prompt move to the top instead of piling up, so the cap
// is a breadth limit (200 distinct recent prompts), not a time window.
const MAX_ENTRIES = 200;

// Resolve `.hivemind/prompt-history.json` against the project root and reject
// anything that escapes `.hivemind/`. Returns the absolute path, or null.
function historyPath(root) {
  if (typeof root !== 'string' || !root.length) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, HISTORY_REL);
  const dir = path.resolve(base, '.hivemind');
  if (!resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

// Serialize read-modify-write per file so concurrent sends from several threads
// (a "tell all threads…" broadcast, or a repost while the panel holds a stale
// copy) can't interleave at the awaits and drop each other's entries.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive but swallow rejections so one failure doesn't poison
  // every later write queued behind it.
  locks.set(key, next.then(() => {}, () => {}));
  return next;
}

let tmpSeq = 0;
// Atomic write: fully write a sibling temp file, then rename over the target.
// Node maps rename to MoveFileEx(REPLACE_EXISTING) on Windows and rename(2)
// elsewhere, so a reader never sees a half-written file and a crash mid-write
// leaves the previous good file intact.
async function writeAtomic(p, data) {
  const tmp = `${p}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, 'utf8');
    await fs.promises.rename(tmp, p);
  } catch (err) {
    try { await fs.promises.unlink(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

// Read the history. A missing file is a normal "no prompts yet" state. A file
// that exists but can't be read or parsed (locked mid-write, truncated by a
// crash) is reported as unreadable — NOT as an empty list — so callers never
// mistake "couldn't read" for "no history" and overwrite the real file.
async function readHistory(root) {
  if (!root) return { ok: false, reason: 'no-dir' };
  const p = historyPath(root);
  if (!p) return { ok: false, reason: 'error', message: 'Invalid history path.' };
  let raw;
  try {
    raw = await fs.promises.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, entries: [] };
    return { ok: false, reason: 'unreadable', message: err.message };
  }
  try {
    const parsed = JSON.parse(raw);
    return { ok: true, entries: Array.isArray(parsed) ? parsed : [] };
  } catch (err) {
    return { ok: false, reason: 'corrupt', message: err.message };
  }
}

// Write the history, creating `.hivemind/` if needed. Trims oldest entries
// past the cap. Serialized and atomic.
async function writeHistory(root, entries) {
  const p = historyPath(root);
  if (!p) return { ok: false, message: 'Invalid history path.' };
  return withLock(p, async () => {
    try {
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      let list = Array.isArray(entries) ? entries : [];
      if (list.length > MAX_ENTRIES) list = list.slice(list.length - MAX_ENTRIES);
      await writeAtomic(p, JSON.stringify(list, null, 2));
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
}

// Append one prompt, deduping by exact text (the repeat moves to the top with
// a fresh timestamp). The whole read-modify-write runs under the per-file lock
// so parallel appends serialize instead of clobbering, and a failed/corrupt
// read aborts without ever writing an empty list over real history.
async function appendPrompt(root, entry) {
  if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) {
    return { ok: false, message: 'Empty prompt.' };
  }
  const p = historyPath(root);
  if (!p) return { ok: false, message: 'Invalid history path.' };
  return withLock(p, async () => {
    const read = await readHistory(root);
    if (!read.ok) return { ok: false, message: read.message || 'Could not read history.' };
    const list = read.entries.filter((e) => e && e.text !== entry.text);
    list.push(entry);
    try {
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      let out = list;
      if (out.length > MAX_ENTRIES) out = out.slice(out.length - MAX_ENTRIES);
      await writeAtomic(p, JSON.stringify(out, null, 2));
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
}

module.exports = { readHistory, writeHistory, appendPrompt };
