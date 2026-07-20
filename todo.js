'use strict';

// ---------------------------------------------------------------------------
// Todo panel backend: a per-hive checklist stored as JSON in the board's
// project directory:
//
//   .hivemind/todos.json  -- [{ id, text, done }]
//
// Scoped to the project directory (cwd) only, like the Source Control and File
// Explorer panels — one shared list per hive, not per-thread. The path is
// resolved and checked to stay inside the project's `.hivemind/` folder (same
// guard as files.js / plan.js), so nothing can read or write outside it.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const TODOS_REL = '.hivemind/todos.json';

// Resolve `.hivemind/todos.json` against the project root and reject anything
// that escapes `.hivemind/`. Returns the absolute path, or null.
function todoPath(root) {
  if (typeof root !== 'string' || !root.length) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, TODOS_REL);
  const dir = path.resolve(base, '.hivemind');
  if (!resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

// Serialize writes per file, and write atomically (temp + rename), so a reader
// never sees a half-written file and two windows saving at once don't tear the
// file — Node maps rename to MoveFileEx(REPLACE_EXISTING) on Windows.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.then(() => {}, () => {}));
  return next;
}

let tmpSeq = 0;
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

// Read the todo list. A missing file is a normal "no todos yet" state. A file
// that exists but can't be read or parsed (locked mid-write, truncated by a
// crash) is reported as unreadable — NOT as an empty list — so the panel shows
// an error rather than an empty list the user's next edit would save over the
// real todos.
async function readTodos(root) {
  if (!root) return { ok: false, reason: 'no-dir' };
  const p = todoPath(root);
  if (!p) return { ok: false, reason: 'error', message: 'Invalid todo path.' };
  let raw;
  try {
    raw = await fs.promises.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, todos: [] };
    return { ok: false, reason: 'unreadable', message: err.message };
  }
  try {
    const parsed = JSON.parse(raw);
    return { ok: true, todos: Array.isArray(parsed) ? parsed : [] };
  } catch (err) {
    return { ok: false, reason: 'corrupt', message: err.message };
  }
}

// Write the todo list, creating `.hivemind/` if needed. Serialized and atomic.
async function writeTodos(root, todos) {
  const p = todoPath(root);
  if (!p) return { ok: false, message: 'Invalid todo path.' };
  return withLock(p, async () => {
    try {
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      const list = Array.isArray(todos) ? todos : [];
      await writeAtomic(p, JSON.stringify(list, null, 2));
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
}

module.exports = { readTodos, writeTodos };
