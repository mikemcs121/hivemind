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
  // Lexical check only. On win32 paths are case-insensitive, so fold case before
  // the prefix compare to avoid rejecting legitimate in-tree paths that differ
  // only in case.
  let a = resolved, b = base;
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  if (a !== b && !a.startsWith(b + path.sep)) return null;
  return resolved;
}

// realpathSync that tolerates a not-yet-existing target: resolve the nearest
// existing ancestor, then re-append the missing trailing segments.
function realpathAllowMissing(p) {
  let abs = path.resolve(p);
  const missing = [];
  for (;;) {
    try {
      const real = fs.realpathSync(abs);
      if (!missing.length) return real;
      missing.reverse();
      return path.join(real, ...missing);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
      const parent = path.dirname(abs);
      if (parent === abs) throw e; // reached the filesystem root, still missing
      missing.push(path.basename(abs));
      abs = parent;
    }
  }
}

// True only if the *real* (symlink-resolved) location of `p` is inside `root`.
// safeJoin is lexical and is defeated by an in-tree symlink pointing outside the
// project, so resolve real paths before listing/opening/revealing. On win32
// realpath returns canonical case, so compare case-insensitively there.
function realInside(root, p) {
  let base, real;
  try {
    base = fs.realpathSync(path.resolve(root));
    real = realpathAllowMissing(p);
  } catch (_) { return false; }
  let a = real, b = base;
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b || a.startsWith(b + path.sep);
}

// List one directory level. `rel` is empty for the project root. Entries are
// sorted folders-first, then alphabetically (case-insensitive).
async function list(root, rel) {
  const dir = safeJoin(root, rel);
  if (!root) return { ok: false, reason: 'no-dir' };
  if (!dir) return { ok: false, reason: 'error', message: 'Path is outside the project directory.' };
  // Lexically inside, but a symlink component could still point outside — verify
  // the real directory is within the project before reading it.
  if (!realInside(root, dir)) return { ok: false, reason: 'error', message: 'Path is outside the project directory.' };

  let dirents;
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'not-found' };
    return { ok: false, reason: 'error', message: err.message };
  }

  const entries = [];
  for (const d of dirents) {
    let isDir = d.isDirectory();
    // A symlink that points at a directory should expand like one — but a
    // symlink whose real target escapes the project tree must not be followed,
    // so omit it from the listing entirely.
    if (d.isSymbolicLink()) {
      const target = path.join(dir, d.name);
      if (!realInside(root, target)) continue;
      try { isDir = fs.statSync(target).isDirectory(); }
      catch (_) { isDir = false; }
    }
    const childRel = rel ? rel.replace(/\/+$/, '') + '/' + d.name : d.name;
    entries.push({ name: d.name, path: childRel, isDir });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return { ok: true, entries };
}

// Extensions Windows will *execute* rather than open in a viewer. `openPath`
// on one of these is `ShellExecute`, i.e. arbitrary code as the user — so the
// File Explorer refuses them outright and offers Reveal instead. The path
// guards above only prove the file is inside the project; they say nothing
// about whether opening it is safe, and a project tree is exactly where an
// agent thread's output lands.
const EXECUTABLE_EXTS = new Set([
  '.exe', '.com', '.scr', '.pif', '.cpl', '.msi', '.msp', '.msc',
  '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.hta', '.reg', '.lnk', '.url', '.inf', '.jar', '.appref-ms',
]);

// Open a file in the OS default application.
async function open(root, rel) {
  const p = safeJoin(root, rel);
  if (!p) return { ok: false, message: 'Path is outside the project directory.' };
  if (!realInside(root, p)) return { ok: false, message: 'Path is outside the project directory.' };
  if (EXECUTABLE_EXTS.has(path.extname(p).toLowerCase())) {
    return { ok: false, message: 'That file type runs as a program — use Reveal in Explorer instead.' };
  }
  const err = await shell.openPath(p); // '' on success
  return err ? { ok: false, message: err } : { ok: true };
}

// Highlight the file in the OS file manager (Explorer / Finder).
function reveal(root, rel) {
  const p = safeJoin(root, rel);
  if (!p) return { ok: false, message: 'Path is outside the project directory.' };
  if (!realInside(root, p)) return { ok: false, message: 'Path is outside the project directory.' };
  shell.showItemInFolder(p);
  return { ok: true };
}

module.exports = { list, open, reveal };
