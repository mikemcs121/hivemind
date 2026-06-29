'use strict';

// ---------------------------------------------------------------------------
// Portable-build backend.
//
// Hivemind can build a *portable* copy of itself (a single self-contained
// Windows .exe) straight from the toolbar — but only when the active hive is
// pointed at the Hivemind source checkout. This module answers "is this dir
// the Hivemind project?" and runs the electron-builder portable target.
//
// electron-builder lives in devDependencies, so it is only present in a real
// source checkout — exactly the case where the toolbar button is shown.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Read a directory's package.json (or null if missing/invalid).
async function readPkg(cwd) {
  if (typeof cwd !== 'string' || !cwd.length) return null;
  try {
    const raw = await fs.promises.readFile(path.join(cwd, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// True when `cwd` is the Hivemind source project. We match on the package name
// (and accept the appId as a fallback) so a forked/renamed checkout still works
// as long as it is recognisably Hivemind.
async function isHivemindProject(cwd) {
  const pkg = await readPkg(cwd);
  if (!pkg) return false;
  if (pkg.name === 'hivemind') return true;
  return !!(pkg.build && pkg.build.appId === 'com.mikem.hivemind');
}

// Build the portable .exe via electron-builder. `onProgress(line)` receives
// trimmed output lines as they arrive. Resolves with { ok, code, message }.
function buildPortable(cwd, onProgress) {
  return new Promise((resolve) => {
    if (typeof cwd !== 'string' || !cwd.length) {
      return resolve({ ok: false, message: 'No project directory.' });
    }

    // Use the locally-installed electron-builder via npx, run through a shell
    // so the platform-specific launcher (.cmd on Windows) resolves correctly.
    const child = spawn('npx', ['electron-builder', '--win', 'portable'], {
      cwd,
      shell: true,
      windowsHide: true,
      env: Object.assign({}, process.env),
    });

    let tail = '';
    const onChunk = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000); // keep a bounded tail for error reports
      if (typeof onProgress === 'function') {
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t) onProgress(t);
        }
      }
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('error', (err) => {
      resolve({ ok: false, code: -1, message: err.message });
    });

    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, code });
      else resolve({ ok: false, code, message: tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || `electron-builder exited with code ${code}` });
    });
  });
}

module.exports = { isHivemindProject, buildPortable };
