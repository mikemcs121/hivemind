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

// Read the todo list. A missing file is a normal "no todos yet" state; a corrupt
// file yields an empty list so the panel still renders (we never silently
// overwrite it — only an explicit save from the panel replaces it).
async function readTodos(root) {
  if (!root) return { ok: false, reason: 'no-dir' };
  const p = todoPath(root);
  if (!p) return { ok: false, reason: 'error', message: 'Invalid todo path.' };
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, todos: Array.isArray(parsed) ? parsed : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, todos: [] };
    return { ok: true, todos: [] };
  }
}

// Write the todo list, creating `.hivemind/` if needed.
async function writeTodos(root, todos) {
  const p = todoPath(root);
  if (!p) return { ok: false, message: 'Invalid todo path.' };
  try {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    const list = Array.isArray(todos) ? todos : [];
    await fs.promises.writeFile(p, JSON.stringify(list, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { readTodos, writeTodos };
