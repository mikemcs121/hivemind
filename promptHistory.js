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

// Read the history. A missing file is a normal "no prompts yet" state; a
// corrupt file yields an empty list so the panel still renders.
async function readHistory(root) {
  if (!root) return { ok: false, reason: 'no-dir' };
  const p = historyPath(root);
  if (!p) return { ok: false, reason: 'error', message: 'Invalid history path.' };
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, entries: Array.isArray(parsed) ? parsed : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, entries: [] };
    return { ok: true, entries: [] };
  }
}

// Write the history, creating `.hivemind/` if needed. Trims oldest entries
// past the cap.
async function writeHistory(root, entries) {
  const p = historyPath(root);
  if (!p) return { ok: false, message: 'Invalid history path.' };
  try {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    let list = Array.isArray(entries) ? entries : [];
    if (list.length > MAX_ENTRIES) list = list.slice(list.length - MAX_ENTRIES);
    await fs.promises.writeFile(p, JSON.stringify(list, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// Append one prompt, deduping by exact text (the repeat moves to the top with
// a fresh timestamp). Read-modify-write happens here in the main process so
// concurrent sends from several threads (or a repost while the panel holds a
// stale copy) can't clobber each other.
async function appendPrompt(root, entry) {
  if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) {
    return { ok: false, message: 'Empty prompt.' };
  }
  const read = await readHistory(root);
  if (!read.ok) return read;
  const list = read.entries.filter((e) => e && e.text !== entry.text);
  list.push(entry);
  return writeHistory(root, list);
}

module.exports = { readHistory, writeHistory, appendPrompt };
