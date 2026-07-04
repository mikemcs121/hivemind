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

// Resolve the absolute path to the project's locally-installed electron-builder
// CLI entry (the `electron-builder` bin script). Returns null if the dependency
// isn't installed in `cwd`. We read the package's own bin field so this keeps
// working if the entry path changes across versions.
function resolveBuilderCli(cwd) {
  try {
    const pkgJson = require.resolve('electron-builder/package.json', { paths: [cwd] });
    const dir = path.dirname(pkgJson);
    const bin = require(pkgJson).bin;
    const rel = typeof bin === 'string' ? bin : (bin && bin['electron-builder']);
    if (rel) {
      const cli = path.resolve(dir, rel);
      if (fs.existsSync(cli)) return cli;
    }
    // Fallback to the conventional entry if the bin field is unexpected.
    const fallback = path.join(dir, 'out', 'cli', 'cli.js');
    return fs.existsSync(fallback) ? fallback : null;
  } catch (_) {
    return null;
  }
}

// Find a real Node.js executable to run electron-builder with. We must NOT use
// our own Electron binary (even in ELECTRON_RUN_AS_NODE mode): Electron's
// bundled module loader can't `require()` the ESM dependencies electron-builder
// pulls in (e.g. @noble/hashes), so it dies with ERR_REQUIRE_ESM before doing
// any work. `npm_node_execpath` is set when Hivemind itself was launched via an
// npm script (`npm start`) and points at the exact Node that ran npm. Falling
// back to `node` on PATH covers other launch paths.
function resolveNode() {
  const fromNpm = process.env.npm_node_execpath;
  if (fromNpm && fs.existsSync(fromNpm)) return fromNpm;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

// Build the portable .exe via electron-builder. `onProgress(line)` receives
// trimmed output lines as they arrive. Resolves with { ok, code, message }.
function buildPortable(cwd, onProgress) {
  return new Promise((resolve) => {
    if (typeof cwd !== 'string' || !cwd.length) {
      return resolve({ ok: false, message: 'No project directory.' });
    }

    // Run the locally-installed electron-builder CLI directly with a real Node,
    // resolved by absolute path. This avoids the previous `npx` invocation,
    // which failed immediately when Hivemind was launched from a context where
    // `npx` wasn't on PATH (desktop shortcut, editor, etc.).
    const cli = resolveBuilderCli(cwd);
    if (!cli) {
      return resolve({
        ok: false,
        message: 'electron-builder is not installed in this project. Run `npm install` in the Hivemind source first.',
      });
    }

    const node = resolveNode();
    // Run as real Node, not Electron-as-Node: strip ELECTRON_RUN_AS_NODE in case
    // we inherited it, or electron-builder dies with ERR_REQUIRE_ESM.
    const childEnv = Object.assign({}, process.env);
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(node, [cli, '--win', 'portable'], {
      cwd,
      windowsHide: true,
      env: childEnv,
    });

    let full = '';      // complete output, written to a log file for diagnosis
    let tail = '';       // bounded recent output, used for the failure message
    const onChunk = (buf) => {
      const text = buf.toString();
      full += text;
      tail = (tail + text).slice(-4000);
      if (typeof onProgress === 'function') {
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t) onProgress(t);
        }
      }
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    // On failure, persist the full build log so the real error is recoverable —
    // the toast only shows the last few lines.
    const writeLog = () => {
      try {
        fs.writeFileSync(path.join(cwd, 'dist', 'portable-build.log'), full);
        return path.join('dist', 'portable-build.log');
      } catch (_) {
        return null;
      }
    };

    child.on('error', (err) => {
      resolve({ ok: false, code: -1, message: `Could not start the build (${node}): ${err.message}` });
    });

    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true, code });
      const logRel = writeLog();
      const recent = tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || `electron-builder exited with code ${code}`;
      resolve({ ok: false, code, message: logRel ? `${recent} (full log: ${logRel})` : recent });
    });
  });
}

// Run a command, streaming trimmed output lines to onProgress. Resolves with
// { code, output } and never rejects; a spawn failure resolves with code -1.
function run(cmd, args, cwd, onProgress) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (err) {
      return resolve({ code: -1, output: err.message });
    }
    const onChunk = (buf) => {
      const text = buf.toString();
      output += text;
      if (typeof onProgress === 'function') {
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t) onProgress(t);
        }
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (err) => resolve({ code: -1, output: `${output}${err.message}` }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

function lastLine(s) {
  return String(s || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
}

// Bump the patch version in package.json (0.1.0 → 0.1.1) with a minimal string
// edit so the file's formatting is untouched. Returns { version, prevRaw } so
// a failed build can restore the file exactly as it was.
async function bumpPatchVersion(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  const prevRaw = await fs.promises.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(prevRaw);
  const parts = String(pkg.version || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  const version = parts.slice(0, 3).join('.');
  const updated = prevRaw.replace(`"version": "${pkg.version}"`, `"version": "${version}"`);
  if (updated === prevRaw) throw new Error('could not find the version field in package.json');
  await fs.promises.writeFile(pkgPath, updated);
  return { version, prevRaw };
}

async function restoreVersion(cwd, prevRaw) {
  try {
    await fs.promises.writeFile(path.join(cwd, 'package.json'), prevRaw);
  } catch (_) { /* best effort — worst case the bump sticks */ }
}

// Publish the built portable exe as a GitHub release (tag vX.Y.Z) via the gh
// CLI, committing and pushing the version bump first so the repo matches the
// release. The commit/push is best-effort; the release upload is the point.
async function publishRelease(cwd, version, onProgress) {
  const log = (m) => { if (typeof onProgress === 'function') onProgress(m); };
  const exePath = path.join(cwd, 'dist', `Hivemind ${version} portable.exe`);
  if (!fs.existsSync(exePath)) {
    return { ok: false, message: `Built exe not found: ${exePath}` };
  }

  log(`Committing version bump to ${version}…`);
  await run('git', ['add', 'package.json'], cwd, null);
  const commit = await run('git', ['commit', '-m', `Bump version to ${version}`], cwd, null);
  if (commit.code !== 0) {
    log(`Could not commit the version bump (continuing): ${lastLine(commit.output)}`);
  } else {
    const push = await run('git', ['push'], cwd, null);
    if (push.code !== 0) log(`Could not push the version bump (continuing): ${lastLine(push.output)}`);
  }

  log(`Publishing release v${version} to GitHub…`);
  const gh = await run('gh', ['release', 'create', `v${version}`, exePath,
    '--title', `Hivemind v${version}`,
    '--notes', `Portable build v${version}. Download the .exe below — existing portable copies offer to update themselves on next launch.`,
  ], cwd, onProgress);
  if (gh.code !== 0) {
    const detail = lastLine(gh.output) || `gh exited with code ${gh.code}`;
    return {
      ok: false,
      message: gh.code === -1
        ? `GitHub CLI (gh) is required to publish releases: ${detail}`
        : detail,
    };
  }
  const url = (gh.output.match(/https:\/\/\S+/) || [])[0] || null;
  log(`Release v${version} published.`);
  return { ok: true, url };
}

module.exports = { isHivemindProject, buildPortable, bumpPatchVersion, restoreVersion, publishRelease };
