'use strict';

// ---------------------------------------------------------------------------
// Board panel (kanban) backend: per-hive cards stored as JSON in the board's
// project directory:
//
//   .hivemind/kanban.json  -- [{ id, text, status: 'todo'|'doing'|'done' }]
//
// Scoped to the project directory (cwd) like the Todo panel — one shared board
// per hive, not per-thread. The path is resolved and checked to stay inside
// the project's `.hivemind/` folder (same guard as todo.js / plan.js), so
// nothing can read or write outside it.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const KANBAN_REL = '.hivemind/kanban.json';

// Resolve `.hivemind/kanban.json` against the project root and reject anything
// that escapes `.hivemind/`. Returns the absolute path, or null.
function kanbanPath(root) {
  if (typeof root !== 'string' || !root.length) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, KANBAN_REL);
  const dir = path.resolve(base, '.hivemind');
  if (!resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

// Read the cards. A missing file is a normal "no cards yet" state; a corrupt
// file yields an empty list so the panel still renders (we never silently
// overwrite it — only an explicit save from the panel replaces it).
async function readCards(root) {
  if (!root) return { ok: false, reason: 'no-dir' };
  const p = kanbanPath(root);
  if (!p) return { ok: false, reason: 'error', message: 'Invalid kanban path.' };
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, cards: Array.isArray(parsed) ? parsed : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, cards: [] };
    return { ok: true, cards: [] };
  }
}

// Write the cards, creating `.hivemind/` if needed.
async function writeCards(root, cards) {
  const p = kanbanPath(root);
  if (!p) return { ok: false, message: 'Invalid kanban path.' };
  try {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    const list = Array.isArray(cards) ? cards : [];
    await fs.promises.writeFile(p, JSON.stringify(list, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { readCards, writeCards };
