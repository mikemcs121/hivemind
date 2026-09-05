#!/usr/bin/env node
// Launch Hivemind the way a brand-new user sees it: no boards, no settings, no
// voice models, no Codex accounts — the `#empty-state` screen and nothing else.
//
// Every scrap of per-user state Hivemind keeps lives in Electron's userData dir
// (boards.json, publish.json, codex-accounts.json, codex-homes/, downloaded STT
// models, and the Local Storage backing every `hm.*` preference). So a first run
// is simply a run against an empty userData dir: `HM_USER_DATA` (main.js:12)
// points Electron at a throwaway profile under the OS temp dir instead of
// `%APPDATA%\hivemind`, and the live instance is never touched.
//
//   node scripts/fresh-run.js            wipe the profile, launch a first run
//   node scripts/fresh-run.js --keep     relaunch the same profile (2nd run)
//   node scripts/fresh-run.js --sample-project   also make a virgin project dir
//   node scripts/fresh-run.js --debug    open a CDP port for the `verify` skill
//
// See docs/development.md ("Simulating a first run").
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const profilesRoot = path.join(os.tmpdir(), 'hivemind-fresh');
// Written into every profile this script owns. Nothing is ever deleted unless
// the marker is there — so a mistyped `--dir %APPDATA%\hivemind` refuses rather
// than wiping the user's real hives.
const MARKER = '.hivemind-fresh-profile';

function usage() {
  console.log(`Run Hivemind as a first-time user (isolated, throwaway profile).

  node scripts/fresh-run.js [options]

Options:
  --keep                 Reuse the profile from the last run instead of wiping
                         it — for testing the *second* launch (settings stick,
                         boards reload) after setting things up in a first run.
  --profile <name>       Name of the throwaway profile (default: "default").
                         Different names = independent new-user sessions.
  --dir <path>           Use this exact profile dir instead of one under
                         ${profilesRoot}.
                         Only wiped if it is empty or was created by this script.
  --sample-project       Also create an empty project folder (not a Git repo) and
                         print its path, so the new hive you add points at
                         virgin ground rather than a repo that already has
                         .hivemind/ state in it.
  --debug[=<port>]       Start with --remote-debugging-port (default 9223) so the
                         \`verify\` skill can drive the window over CDP.
  --detach               Launch and exit instead of staying attached to the app's
                         stdout/stderr.
  --help                 Show this.

The instance runs as electron.exe with an --hm-fresh marker, so it is never
confused with the live Hivemind.exe. To stop just this one:
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -match 'hm-fresh' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
}

function parseArgs(argv) {
  const opts = { keep: false, profile: 'default', dir: null, sample: false, debug: null, detach: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a === '--keep') opts.keep = true;
    else if (a === '--detach') opts.detach = true;
    else if (a === '--sample-project') opts.sample = true;
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--debug') opts.debug = 9223;
    else if (a.startsWith('--debug=')) opts.debug = parseInt(a.slice(8), 10);
    else { console.error(`Unknown option: ${a}\n`); usage(); process.exit(1); }
  }
  if (!opts.profile) { console.error('--profile needs a name'); process.exit(1); }
  if (opts.dir === undefined || opts.dir === '') { console.error('--dir needs a path'); process.exit(1); }
  if (opts.debug !== null && !(opts.debug > 0)) { console.error('--debug needs a port number'); process.exit(1); }
  return opts;
}

// Delete a profile dir, but only one this script owns: missing, empty, or
// carrying the marker file. Anything else is somebody's real data.
function resetProfile(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (entries.length && !entries.includes(MARKER)) {
    console.error(`Refusing to wipe ${dir}: it is not empty and has no ${MARKER} marker.`);
    console.error('Pass --keep to reuse it as-is, or --dir/--profile to pick another location.');
    process.exit(1);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function electronBinary() {
  const dist = path.join(appDir, 'node_modules', 'electron', 'dist');
  const exe = process.platform === 'win32' ? 'electron.exe'
    : process.platform === 'darwin' ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';
  const p = path.join(dist, exe);
  if (!fs.existsSync(p)) {
    console.error(`Bundled Electron not found at ${p}`);
    console.error('Run: node node_modules\\electron\\install.js');
    process.exit(1);
  }
  return p;
}

// Electron inherits this process's env. Two things must not carry over:
// ELECTRON_RUN_AS_NODE (set when this script itself runs under the bundled
// Electron via "Fresh Hivemind.cmd" — it would start the child as plain Node,
// no GUI), and Claude Code's session vars, which otherwise leak into the thread
// PTYs and make a nested `claude` run as a child session that writes no
// transcript (docs/development.md).
function childEnv(userData) {
  const env = { ...process.env, HM_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

const opts = parseArgs(process.argv.slice(2));
const profileDir = opts.dir ? path.resolve(opts.dir) : path.join(profilesRoot, opts.profile);

if (!opts.keep) resetProfile(profileDir);
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, MARKER), 'Throwaway Hivemind userData — safe to delete.\n');

let sampleDir = null;
if (opts.sample) {
  sampleDir = path.join(profileDir, 'sample-project');
  fs.mkdirSync(sampleDir, { recursive: true });
  const readme = path.join(sampleDir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, '# Sample project\n\nA new user\'s empty project folder. Not a Git repo yet.\n');
  }
}

const args = [appDir, '--hm-fresh', '--disable-gpu'];
if (opts.debug) args.push(`--remote-debugging-port=${opts.debug}`);

console.log(`Hivemind first-run instance
  profile   ${profileDir}${opts.keep ? ' (kept)' : ' (wiped — this is a first run)'}`);
if (sampleDir) console.log(`  project   ${sampleDir}  <- point the first hive here`);
if (opts.debug) console.log(`  CDP       http://127.0.0.1:${opts.debug}/json/list`);
console.log(`  live app  untouched (%APPDATA%\\hivemind)\n`);

const child = spawn(electronBinary(), args, {
  cwd: appDir,
  env: childEnv(profileDir),
  detached: opts.detach,
  stdio: opts.detach ? 'ignore' : 'inherit',
});

if (opts.detach) {
  child.unref();
} else {
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => { console.error('Failed to launch Electron:', err); process.exit(1); });
}
