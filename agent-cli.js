'use strict';

// Where the agent CLIs actually live.
//
// Hivemind never execs an agent CLI by absolute path: a thread types `codex`
// (or `claude`, `gemini`, `grok`) into a shell, and model discovery resolves
// the bare name against PATH. That only works when the CLI's directory is on
// PATH — and one common install is not. The OpenAI Codex desktop app ships its
// own CLI at `%LOCALAPPDATA%\OpenAI\Codex\bin\<build hash>\codex.exe`, a
// directory that changes with every update and that nothing adds to PATH, so a
// machine with a perfectly good, signed-in Codex died on PowerShell's
// "'codex' is not recognized as the name of a cmdlet" the moment a ChatGPT
// thread started.
//
// This module collects those known-but-unlisted install directories and
// **appends** them to the PTY's PATH (append, never prepend: a CLI the user
// installed deliberately — npm global, winget, a hand-rolled shim — still
// wins). `resolveCommand` searches the same augmented list, so model discovery
// and the spawned thread always agree on which binary "codex" means.
//
// Only directories that exist and actually contain the executable are ever
// returned, so nothing here can inject a bogus PATH entry.

const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';

// Executable suffixes to try for a bare command name. `.js` is deliberately
// absent even though Windows lists it in PATHEXT: this repo has a `codex.js`,
// and PATHEXT would happily "resolve" `codex` to it.
const EXE_EXTS = WIN ? ['.exe', '.cmd', '.bat', ''] : [''];

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; }
}

// The Codex desktop app keeps one bin directory per installed build, named by
// a build hash, and leaves older builds behind. Take the ones that really hold
// a `codex.exe`, newest first, so an update is picked up with no PATH edit.
function codexAppDirs() {
  if (!WIN || !process.env.LOCALAPPDATA) return [];
  const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  if (!isDir(root)) return [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .filter((dir) => isFile(path.join(dir, 'codex.exe')))
    .map((dir) => ({ dir, at: mtime(dir) }))
    .sort((a, b) => b.at - a.at)
    .map((e) => e.dir);
}

// Claude Code's native installer drops `claude` here. It normally adds it to
// PATH too, but only for shells started after the install — an app launched
// from the pre-install session inherits the old PATH.
function localBinDirs() {
  const dir = path.join(os.homedir(), '.local', 'bin');
  return isDir(dir) ? [dir] : [];
}

// Install directories worth searching that PATH may not mention. Deduped,
// existing-only, in search order.
function extraBinDirs() {
  const out = [];
  const seen = new Set();
  for (const dir of [...codexAppDirs(), ...localBinDirs()]) {
    const key = WIN ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

function splitPath(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((p) => p.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

// PATH with the extra install directories appended, skipping any the given
// PATH already lists (case-insensitively on Windows).
function augmentedPath(basePath) {
  const dirs = splitPath(basePath);
  const seen = new Set(dirs.map((d) => (WIN ? d.toLowerCase() : d).replace(/[\\/]+$/, '')));
  for (const dir of extraBinDirs()) {
    const key = (WIN ? dir.toLowerCase() : dir).replace(/[\\/]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs.join(path.delimiter);
}

// Rewrite an environment object's PATH in place. Windows env blocks spell it
// "Path"; writing a second "PATH" key would leave the child process with two
// competing entries, so reuse whichever key is already there.
function augmentEnv(env) {
  const key = Object.keys(env).find((k) => /^path$/i.test(k)) || 'PATH';
  env[key] = augmentedPath(env[key]);
  return env;
}

// Absolute path of `name` as PATH (plus the extra directories) would resolve
// it, or null when it isn't installed anywhere we know to look.
function resolveCommand(name, env) {
  const source = env || process.env;
  const fromEnv = source[Object.keys(source).find((k) => /^path$/i.test(k)) || 'PATH'];
  for (const dir of splitPath(augmentedPath(fromEnv))) {
    for (const ext of EXE_EXTS) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

module.exports = { extraBinDirs, augmentedPath, augmentEnv, resolveCommand };
