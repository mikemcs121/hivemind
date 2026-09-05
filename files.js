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
const { execFile } = require('child_process');
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

// ---------------------------------------------------------------------------
// Whole-project file index, for the composer's "@" mention picker.
//
// The explorer lists one level at a time because it draws a tree the user
// expands. The @-picker is the opposite: it has to answer "which file in this
// project is called something like this" against every path at once, so it
// needs a flat index it can rank. It is built once and handed to the renderer,
// which filters it locally — a project-wide fuzzy match per keystroke can't
// cross IPC.
//
// Inside a git work tree the index is `git ls-files`, so it honours .gitignore
// exactly like the editor's own quick-open does (no node_modules, no dist, no
// build output). Outside one, fall back to a bounded walk with a hard-coded
// skip list, which is the best a plain directory can do.
// ---------------------------------------------------------------------------

const INDEX_MAX_FILES = 20000; // ranking 20k paths per keystroke stays instant
const INDEX_MAX_DEPTH = 12;

// Only the fallback walk uses this: in a repo, .gitignore already covers these
// (and covers the project-specific ones this list can't know about).
const INDEX_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'target', 'coverage', '.cache', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.gradle', '.idea', '.vs', '.terraform',
]);

// One build per root at a time: several threads share a project directory and
// every composer asks on its first "@".
const indexInFlight = new Map(); // root -> Promise

function gitListFiles(root) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { timeout: 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
        env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) },
      (err, stdout) => {
        // No git, not a repo, or it timed out — the caller walks instead.
        if (err) { resolve(null); return; }
        resolve(String(stdout || '').split('\0').filter(Boolean));
      }
    );
  });
}

// Depth-bounded readdir walk. Symlinks are skipped outright rather than
// resolved: `list` can afford a realpath per entry because it does one level on
// demand, but a whole-tree walk that follows links is both a loop hazard and a
// way for an in-tree link to pull outside paths into the picker.
async function walkFiles(root) {
  const files = [];
  let truncated = false;
  async function walk(abs, rel, depth) {
    if (truncated || depth > INDEX_MAX_DEPTH) return;
    let dirents;
    try { dirents = await fs.promises.readdir(abs, { withFileTypes: true }); }
    catch (_) { return; }
    for (const d of dirents) {
      if (truncated) return;
      if (d.isSymbolicLink()) continue;
      const childRel = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) {
        if (INDEX_SKIP_DIRS.has(d.name)) continue;
        await walk(path.join(abs, d.name), childRel, depth + 1);
      } else if (d.isFile()) {
        if (files.length >= INDEX_MAX_FILES) { truncated = true; return; }
        files.push(childRel);
      }
    }
  }
  await walk(path.resolve(root), '', 0);
  return { files, truncated };
}

// Every directory that holds at least one indexed file, so the picker can offer
// folders (and step into them) without a second listing pass.
function dirsOf(files) {
  const dirs = new Set();
  for (const f of files) {
    let cut = f.lastIndexOf('/');
    while (cut > 0) {
      const d = f.slice(0, cut);
      if (dirs.has(d)) break; // this ancestor chain is already recorded
      dirs.add(d);
      cut = d.lastIndexOf('/');
    }
  }
  return Array.from(dirs);
}

async function buildIndex(root) {
  const base = path.resolve(root);
  try { if (!fs.statSync(base).isDirectory()) return { ok: false, reason: 'not-found' }; }
  catch (_) { return { ok: false, reason: 'not-found' }; }

  let files = await gitListFiles(base);
  let truncated = false;
  let source = 'git';
  if (files) {
    // `--cached` lists one row per merge stage, so a conflicted file repeats.
    files = Array.from(new Set(files));
    if (files.length > INDEX_MAX_FILES) { files = files.slice(0, INDEX_MAX_FILES); truncated = true; }
  } else {
    source = 'walk';
    const walked = await walkFiles(base);
    files = walked.files;
    truncated = walked.truncated;
  }

  files.sort((a, b) => a.localeCompare(b));
  const dirs = dirsOf(files).sort((a, b) => a.localeCompare(b));
  return { ok: true, files, dirs, truncated, source };
}

// Flat list of every project-relative file path (and the directories holding
// them), "/"-separated. Concurrent callers share one build.
function index(root) {
  if (typeof root !== 'string' || !root.length) return Promise.resolve({ ok: false, reason: 'no-dir' });
  const pending = indexInFlight.get(root);
  if (pending) return pending;
  const p = buildIndex(root)
    .catch((err) => ({ ok: false, reason: 'error', message: err.message }))
    .then((res) => { indexInFlight.delete(root); return res; });
  indexInFlight.set(root, p);
  return p;
}

module.exports = { list, index, open, reveal };
