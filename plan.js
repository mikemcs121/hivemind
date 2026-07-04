'use strict';

// ---------------------------------------------------------------------------
// Plan pane backend: read a per-thread plan markdown file the thread writes,
// and read/write the sidecar comments Hivemind attaches to it. Both live under
// `.hivemind/plans/` inside the board's project directory:
//
//   .hivemind/plans/<planId>.md            -- written by the thread (the plan)
//   .hivemind/plans/<planId>.comments.json -- written by Hivemind (the comments)
//
// `planId` is a stable per-pane id supplied by the renderer. Every path is
// resolved and checked to stay inside the project directory (same guard as
// files.js), so a stray planId can't read or write outside the project.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const PLANS_REL = '.hivemind/plans';

// Resolve `.hivemind/plans/<file>` against the project root and reject anything
// that escapes it (or a planId carrying path separators / traversal). Returns
// the absolute path, or null.
function planPath(root, planId, suffix) {
  if (typeof root !== 'string' || !root.length) return null;
  if (typeof planId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(planId)) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, PLANS_REL, planId + suffix);
  const dir = path.resolve(base, PLANS_REL);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

// Read the plan markdown. Missing file is a normal "no plan yet" state.
async function readPlan(root, planId) {
  const p = planPath(root, planId, '.md');
  if (!root) return { ok: false, reason: 'no-dir' };
  if (!p) return { ok: false, reason: 'error', message: 'Invalid plan path.' };
  try {
    const content = await fs.promises.readFile(p, 'utf8');
    const { mtimeMs } = await fs.promises.stat(p);
    return { ok: true, content, mtime: mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'not-found' };
    return { ok: false, reason: 'error', message: err.message };
  }
}

// Read the sidecar comments. A missing/corrupt file yields an empty list so the
// pane still renders the plan.
async function readComments(root, planId) {
  const p = planPath(root, planId, '.comments.json');
  if (!p) return { ok: true, comments: [] };
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, comments: Array.isArray(parsed) ? parsed : [] };
  } catch (_) {
    return { ok: true, comments: [] };
  }
}

// Write the sidecar comments, creating `.hivemind/plans/` if needed.
async function writeComments(root, planId, comments) {
  const p = planPath(root, planId, '.comments.json');
  if (!p) return { ok: false, message: 'Invalid plan path.' };
  try {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    const list = Array.isArray(comments) ? comments : [];
    await fs.promises.writeFile(p, JSON.stringify(list, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// Write the plan markdown itself (used when the user edits it in-panel, e.g.
// toggling a task checkbox). Path-guarded and folder-creating like the rest.
async function writePlan(root, planId, content) {
  const p = planPath(root, planId, '.md');
  if (!p) return { ok: false, message: 'Invalid plan path.' };
  try {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, String(content == null ? '' : content), 'utf8');
    const { mtimeMs } = await fs.promises.stat(p);
    return { ok: true, mtime: mtimeMs };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// Clear a thread's plan: delete both the markdown and its comment sidecar.
// Missing files are fine (already cleared) — only a real error is reported.
async function clearPlan(root, planId) {
  const md = planPath(root, planId, '.md');
  const cmt = planPath(root, planId, '.comments.json');
  if (!md || !cmt) return { ok: false, message: 'Invalid plan path.' };
  try {
    for (const p of [md, cmt]) {
      try {
        await fs.promises.unlink(p);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// Ensure the project's `.gitignore` ignores `.hivemind/` so plan files and
// their comment sidecars don't clutter the very Source Control panel the app
// ships. Idempotent: only appends when no equivalent entry is already present,
// and preserves the file's existing trailing newline convention.
async function ensureIgnored(root) {
  if (typeof root !== 'string' || !root.length) return { ok: false };
  const gi = path.join(path.resolve(root), '.gitignore');
  try {
    let existing = '';
    try { existing = await fs.promises.readFile(gi, 'utf8'); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const already = existing.split(/\r?\n/).some((l) => {
      const t = l.trim().replace(/\/+$/, '');
      return t === '.hivemind';
    });
    if (already) return { ok: true, added: false };
    const sep = existing.length && !/\n$/.test(existing) ? '\n' : '';
    await fs.promises.writeFile(gi, existing + sep + '.hivemind/\n', 'utf8');
    return { ok: true, added: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { readPlan, readComments, writeComments, writePlan, clearPlan, ensureIgnored };
