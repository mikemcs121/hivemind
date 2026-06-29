'use strict';

// ---------------------------------------------------------------------------
// File Explorer backend: list a board's project directory one level at a time
// (the renderer expands folders lazily), plus open/reveal a file via the OS.
//
// Every path the renderer asks for is resolved and checked to stay inside the
// board's project directory, so a stray "../" can't read outside the project.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

// Resolve a board-relative path (POSIX-style, "/"-separated) against the project
// root and reject anything that escapes it. Returns the absolute path, or null.
function safeJoin(root, rel) {
  if (typeof root !== 'string' || !root.length) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(rel ? path.join(base, rel) : base);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// List one directory level. `rel` is empty for the project root. Entries are
// sorted folders-first, then alphabetically (case-insensitive).
async function list(root, rel) {
  const dir = safeJoin(root, rel);
  if (!root) return { ok: false, reason: 'no-dir' };
  if (!dir) return { ok: false, reason: 'error', message: 'Path is outside the project directory.' };

  let dirents;
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'not-found' };
    return { ok: false, reason: 'error', message: err.message };
  }

  const entries = dirents.map((d) => {
    let isDir = d.isDirectory();
    // A symlink that points at a directory should expand like one.
    if (d.isSymbolicLink()) {
      try { isDir = fs.statSync(path.join(dir, d.name)).isDirectory(); }
      catch (_) { isDir = false; }
    }
    const childRel = rel ? rel.replace(/\/+$/, '') + '/' + d.name : d.name;
    return { name: d.name, path: childRel, isDir };
  });

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return { ok: true, entries };
}

// Open a file in the OS default application.
async function open(root, rel) {
  const p = safeJoin(root, rel);
  if (!p) return { ok: false, message: 'Path is outside the project directory.' };
  const err = await shell.openPath(p); // '' on success
  return err ? { ok: false, message: err } : { ok: true };
}

// Highlight the file in the OS file manager (Explorer / Finder).
function reveal(root, rel) {
  const p = safeJoin(root, rel);
  if (!p) return { ok: false, message: 'Path is outside the project directory.' };
  shell.showItemInFolder(p);
  return { ok: true };
}

module.exports = { list, open, reveal };
