'use strict';

// ---------------------------------------------------------------------------
// Publish-to-website (FTP) backend.
//
// The Publish panel is to a web host what Source Control is to git: it takes an
// explicit allowlist of files/folders in the board's project directory and
// uploads the ones that changed since the last publish.
//
// ## Where the settings live, and why
//
// Everything — host, username, remote folder, file list, and the encrypted
// password — lives in ONE file in Hivemind's own userData directory
// (`%APPDATA%\hivemind\publish.json`), keyed by project directory. Nothing is
// ever written into the project folder. That is deliberate:
//
//   * the project folder gets committed, pushed to GitHub, zipped and shared —
//     userData does not;
//   * the agent threads Hivemind spawns work *inside* the project folder, so
//     anything stored there is readable by whatever is running in a pane.
//
// ## How the password is protected
//
// The password is encrypted with Electron `safeStorage`, which on Windows is
// DPAPI scoped to the logged-in Windows user account. Another Windows user on
// this machine cannot decrypt it, and a copy of publish.json moved to another
// machine is inert ciphertext. If the OS keyring is unavailable we refuse to
// write the password to disk at all and keep it in memory for the session only.
//
// The plaintext password never crosses back to the renderer (the config the UI
// receives carries `hasPassword: true/false`, never the secret), and it never
// appears in a command line — argv is world-readable in the Windows process
// list, so credentials are fed to curl over stdin via `--config -` instead of
// deploy.ps1's `-u user:pass`.
//
// ## Uploading
//
// One `curl` per file, sequential, 3 tries with a short backoff (Hostinger and
// friends throw transient 450/530s). `--ftp-ssl-control` is the default: it
// encrypts the control channel that carries the login while leaving the data
// channel plain, because curl's Windows schannel backend mishandles the TLS
// shutdown on the data connection and larger files die with "450 Transfer
// aborted". Website payloads are public anyway; the login is what matters.
// Full FTPS and plain FTP are both selectable per site.
// ---------------------------------------------------------------------------

const { app, safeStorage } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const MAX_FILES = 5000;          // refuse to walk a runaway tree
const RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const storeFile = () => path.join(app.getPath('userData'), 'publish.json');

// ---------------------------------------------------------------------------
// Path safety — same contract as files.js: a lexical containment check plus a
// realpath check so an in-tree symlink can't be used to publish a file from
// outside the project.
// ---------------------------------------------------------------------------
function safeJoin(root, rel) {
  if (typeof root !== 'string' || !root.length) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(rel ? path.join(base, rel) : base);
  let a = resolved, b = base;
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  if (a !== b && !a.startsWith(b + path.sep)) return null;
  return resolved;
}

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
      if (parent === abs) throw e;
      missing.push(path.basename(abs));
      abs = parent;
    }
  }
}

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

// ---------------------------------------------------------------------------
// Denylist — never uploaded, even if the user ticks a folder that contains it.
// The allowlist already means nothing ships by accident; this is the backstop
// for "I ticked the project root" and for agent threads dropping a .env next to
// index.html. Matched per path segment against the project-relative path.
// ---------------------------------------------------------------------------
const DENY_DIRS = new Set([
  '.git', '.svn', '.hg', '.hivemind', '.claude', '.vscode', '.vs', '.idea',
  'node_modules', '__pycache__',
]);
const DENY_FILE_RE = [
  /^\.env(\..*)?$/i,          // .env, .env.local, .env.production
  /^\.ftp-cred$/i,            // deploy.ps1's own credential file
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.git.*$/i,               // .gitignore, .gitattributes, .git-credentials
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|ppk|keystore|jks)$/i,
  /^(thumbs\.db|desktop\.ini|\.ds_store)$/i,
];

// Why this path is blocked, or null if it's publishable.
function denyReason(rel) {
  const parts = String(rel).split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (DENY_DIRS.has(parts[i].toLowerCase())) return `inside ${parts[i]}/`;
  }
  const name = parts[parts.length - 1] || '';
  if (DENY_DIRS.has(name.toLowerCase())) return `${name}/ is never published`;
  for (const re of DENY_FILE_RE) if (re.test(name)) return 'looks like a secret or local-only file';
  return null;
}

// ---------------------------------------------------------------------------
// Store I/O. One JSON file, all sites, atomic replace.
// ---------------------------------------------------------------------------
const keyFor = (dir) => {
  const abs = path.resolve(String(dir || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
};

function readStore() {
  try {
    const raw = fs.readFileSync(storeFile(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.sites && typeof data.sites === 'object') return data;
  } catch (_) { /* no file yet, or unreadable — treat as empty */ }
  return { version: STORE_VERSION, sites: {} };
}

function writeStore(store) {
  const file = storeFile();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 0600: on Windows the mode is largely advisory (DPAPI is the real
    // protection for the secret), but it costs nothing and matters if userData
    // ever lands on a POSIX box.
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    console.error('Failed to save publish settings:', err);
    return false;
  }
}

// Passwords held only in memory, for the case where the OS keyring can't
// encrypt (safeStorage unavailable). Cleared when the app exits.
const sessionSecrets = new Map();

function encryptSecret(plain) {
  if (!plain) return { secret: null };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { secret: safeStorage.encryptString(plain).toString('base64') };
    }
  } catch (_) { /* fall through to session-only */ }
  return { secret: null, sessionOnly: true };
}

function decryptSecret(rec, key) {
  if (sessionSecrets.has(key)) return sessionSecrets.get(key);
  if (!rec || !rec.secret) return null;
  try {
    return safeStorage.decryptString(Buffer.from(rec.secret, 'base64'));
  } catch (_) {
    // Wrong Windows user, or the file was copied from another machine.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation. Everything here is renderer-supplied.
// ---------------------------------------------------------------------------
const CTRL_RE = /[\u0000-\u001f\u007f]/;

function cleanHost(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { error: 'Enter the FTP server (host name or IP).' };
  if (s.length > 255 || !/^[A-Za-z0-9._:\-[\]]+$/.test(s) || s.startsWith('-')) {
    return { error: 'That does not look like a host name or IP address.' };
  }
  return { value: s };
}

function cleanPort(v) {
  if (v === '' || v == null) return { value: 21 };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: 'Port must be a number between 1 and 65535.' };
  return { value: n };
}

function cleanUser(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { error: 'Enter the FTP username.' };
  // curl's config file is line-based; a control character would break out of
  // the quoted credential line.
  if (CTRL_RE.test(s) || s.length > 255) return { error: 'The username contains characters FTP cannot use.' };
  return { value: s };
}

// "domains/example.com/public_html" — POSIX-ish, no traversal, no leading slash.
function cleanRemoteDir(v) {
  let s = String(v == null ? '' : v).trim().replace(/\\/g, '/');
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!s) return { value: '' }; // the FTP login root itself
  if (CTRL_RE.test(s) || s.length > 512) return { error: 'The remote folder contains characters FTP cannot use.' };
  const parts = s.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) return { error: 'The remote folder cannot contain "." or ".." segments.' };
  return { value: parts.join('/') };
}

function cleanSiteUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { value: '' };
  if (!/^https?:\/\//i.test(s) || CTRL_RE.test(s) || s.length > 2000) {
    return { error: 'The website address must start with http:// or https://' };
  }
  return { value: s };
}

const SECURITY = new Set(['ftps-control', 'ftps', 'plain']);

// A file-list entry: project-relative, "/"-separated. A trailing "/" marks a
// folder, which publishes recursively.
function cleanEntry(dir, raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/\\/g, '/');
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  const isDir = s.endsWith('/');
  s = s.replace(/\/+$/, '');
  if (!s || CTRL_RE.test(s)) return null;
  const parts = s.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) return null;
  const rel = parts.join('/');
  if (!safeJoin(dir, rel)) return null;
  return isDir ? rel + '/' : rel;
}

// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------

// Shape handed to the renderer. Never carries the password.
function publicSite(rec, key) {
  return {
    host: rec.host || '',
    port: rec.port || 21,
    user: rec.user || '',
    remoteDir: rec.remoteDir || '',
    security: rec.security || 'ftps-control',
    insecureCert: rec.insecureCert !== false,
    siteUrl: rec.siteUrl || '',
    files: Array.isArray(rec.files) ? rec.files.slice() : [],
    hasPassword: !!(rec.secret || sessionSecrets.has(key)),
    passwordSessionOnly: !rec.secret && sessionSecrets.has(key),
    lastPublish: rec.lastPublish || 0,
  };
}

function getConfig(dir) {
  if (!dir) return { ok: false, reason: 'no-dir' };
  const key = keyFor(dir);
  const rec = readStore().sites[key];
  let canEncrypt = false;
  try { canEncrypt = safeStorage.isEncryptionAvailable(); } catch (_) { canEncrypt = false; }
  if (!rec) return { ok: true, configured: false, canEncrypt, site: null };
  return { ok: true, configured: true, canEncrypt, site: publicSite(rec, key) };
}

// Merge a partial update into the site record. `password` is handled here too
// so the setup form can save everything in one call, but it is stripped before
// anything is written as plaintext.
function setConfig(dir, patch) {
  if (!dir) return { ok: false, message: 'This hive has no project directory set.' };
  const p = patch && typeof patch === 'object' ? patch : {};
  const key = keyFor(dir);
  const store = readStore();
  const rec = store.sites[key] || { dir: path.resolve(dir), files: [], state: {} };
  // Upload state records local fingerprints, not "what is on that server", so
  // it only means anything for one destination. Remember which one it was.
  const destOf = (r) => [r.host || '', r.port || 21, r.remoteDir || ''].join(' ');
  const destBefore = destOf(rec);

  const checks = [
    ['host', cleanHost, p.host],
    ['port', cleanPort, p.port],
    ['user', cleanUser, p.user],
    ['remoteDir', cleanRemoteDir, p.remoteDir],
    ['siteUrl', cleanSiteUrl, p.siteUrl],
  ];
  for (const [field, fn, raw] of checks) {
    if (raw === undefined) continue;
    const res = fn(raw);
    if (res.error) return { ok: false, message: res.error };
    rec[field] = res.value;
  }
  if (p.security !== undefined) {
    if (!SECURITY.has(p.security)) return { ok: false, message: 'Unknown connection security setting.' };
    rec.security = p.security;
  }
  if (p.insecureCert !== undefined) rec.insecureCert = !!p.insecureCert;

  if (p.files !== undefined) {
    if (!Array.isArray(p.files)) return { ok: false, message: 'The file list is malformed.' };
    const seen = new Set();
    const out = [];
    for (const raw of p.files.slice(0, MAX_FILES)) {
      const e = cleanEntry(dir, raw);
      if (!e || seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }
    rec.files = out;
    // Forget upload state for anything no longer listed, so re-adding a file
    // later republishes it rather than trusting a stale fingerprint.
    const keep = {};
    for (const [rel, st] of Object.entries(rec.state || {})) {
      if (out.some((e) => (e.endsWith('/') ? rel.startsWith(e) : rel === e))) keep[rel] = st;
    }
    rec.state = keep;
  }

  // Required fields must be present before the record counts as configured.
  for (const [field, fn] of [['host', cleanHost], ['user', cleanUser]]) {
    const res = fn(rec[field]);
    if (res.error) return { ok: false, message: res.error };
    rec[field] = res.value;
  }
  if (rec.port == null) rec.port = 21;
  if (rec.remoteDir == null) rec.remoteDir = '';
  if (!SECURITY.has(rec.security)) rec.security = 'ftps-control';
  if (rec.insecureCert === undefined) rec.insecureCert = true;

  // Pointing the hive at a different server or folder invalidates every
  // fingerprint: the new destination has none of these files. Without this the
  // next publish reports "Everything is already up to date." and uploads
  // nothing — the same silent no-op that hid the empty-remoteDir bug.
  if (destOf(rec) !== destBefore && Object.keys(rec.state || {}).length) rec.state = {};

  store.sites[key] = rec;
  if (!writeStore(store)) return { ok: false, message: 'Could not save the publish settings.' };

  if (p.password !== undefined) {
    const res = setPassword(dir, p.password);
    if (!res.ok) return res;
  }
  return getConfig(dir);
}

function setPassword(dir, password) {
  if (!dir) return { ok: false, message: 'This hive has no project directory set.' };
  const key = keyFor(dir);
  const store = readStore();
  const rec = store.sites[key];
  if (!rec) return { ok: false, message: 'Set up the connection first.' };

  const plain = password == null ? '' : String(password);
  if (CTRL_RE.test(plain)) return { ok: false, message: 'The password contains a line break or control character FTP cannot use.' };

  if (!plain) {
    sessionSecrets.delete(key);
    delete rec.secret;
    store.sites[key] = rec;
    writeStore(store);
    return getConfig(dir);
  }

  const enc = encryptSecret(plain);
  if (enc.sessionOnly) {
    // No OS keyring: keep it in memory rather than writing plaintext to disk.
    sessionSecrets.set(key, plain);
    delete rec.secret;
    store.sites[key] = rec;
    writeStore(store);
    const out = getConfig(dir);
    out.warning = 'Windows would not provide encryption, so the password is kept for this session only and never written to disk.';
    return out;
  }
  sessionSecrets.delete(key);
  rec.secret = enc.secret;
  store.sites[key] = rec;
  if (!writeStore(store)) return { ok: false, message: 'Could not save the password.' };
  return getConfig(dir);
}

// Drop everything Hivemind knows about publishing this project.
function forget(dir) {
  if (!dir) return { ok: false, message: 'This hive has no project directory set.' };
  const key = keyFor(dir);
  sessionSecrets.delete(key);
  const store = readStore();
  delete store.sites[key];
  writeStore(store);
  return { ok: true, configured: false, site: null };
}

// ---------------------------------------------------------------------------
// Expanding the allowlist into concrete files, with change detection.
// ---------------------------------------------------------------------------
function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function walkDir(root, relDir, out) {
  let dirents;
  try { dirents = fs.readdirSync(path.join(root, relDir), { withFileTypes: true }); }
  catch (_) { return; }
  for (const d of dirents) {
    if (out.length >= MAX_FILES) return;
    const rel = relDir ? relDir + '/' + d.name : d.name;
    if (denyReason(rel)) continue;
    const abs = path.join(root, rel);
    if (!realInside(root, abs)) continue; // symlink pointing out of the project
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try { isDir = fs.statSync(abs).isDirectory(); } catch (_) { continue; }
    }
    if (isDir) walkDir(root, rel, out);
    else out.push(rel);
  }
}

// Resolve `files` into the concrete file list, tagging each with why it will or
// won't be uploaded. Returns entries sorted by path.
function scan(dir) {
  if (!dir) return { ok: false, reason: 'no-dir' };
  const key = keyFor(dir);
  const store = readStore();
  const rec = store.sites[key];
  if (!rec) return { ok: true, configured: false, files: [] };

  const state = rec.state || {};
  const seen = new Set();
  const rels = [];
  const problems = [];

  for (const entry of rec.files || []) {
    const isDir = entry.endsWith('/');
    const rel = isDir ? entry.slice(0, -1) : entry;
    const abs = safeJoin(dir, rel);
    if (!abs || !realInside(dir, abs)) { problems.push({ entry, message: 'outside the project folder' }); continue; }
    const deny = denyReason(rel);
    if (deny) { problems.push({ entry, message: deny }); continue; }
    let st;
    try { st = fs.statSync(abs); }
    catch (_) { problems.push({ entry, message: 'missing' }); continue; }
    if (isDir || st.isDirectory()) {
      const found = [];
      walkDir(dir, rel, found);
      for (const f of found) if (!seen.has(f)) { seen.add(f); rels.push(f); }
    } else if (!seen.has(rel)) {
      seen.add(rel);
      rels.push(rel);
    }
  }

  rels.sort((a, b) => a.localeCompare(b));

  let stateDirty = false;
  const out = [];
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    let st;
    try { st = fs.statSync(abs); } catch (_) { continue; }
    const size = st.size;
    const mtime = Math.floor(st.mtimeMs);
    const rec2 = state[rel];
    let changed = true;
    if (rec2 && rec2.size === size) {
      if (rec2.mtime === mtime) {
        changed = false;
      } else {
        // Same size, different timestamp: hash before deciding, so a touched-
        // but-unmodified file doesn't cost an upload.
        try {
          if (sha256(abs) === rec2.hash) {
            changed = false;
            state[rel] = { size, mtime, hash: rec2.hash };
            stateDirty = true;
          }
        } catch (_) { /* unreadable — let the upload report it */ }
      }
    }
    out.push({ rel, size, mtime, changed, uploadedAt: rec2 ? rec2.at || 0 : 0 });
  }

  if (stateDirty) { rec.state = state; store.sites[key] = rec; writeStore(store); }
  return { ok: true, configured: true, files: out, problems, changed: out.filter((f) => f.changed).length };
}

// ---------------------------------------------------------------------------
// curl
// ---------------------------------------------------------------------------

// Prefer the absolute System32 curl: this process spawns with no shell, but
// Windows CreateProcess still searches the application directory before PATH,
// and the project folder is written to by agent threads. Never let a stray
// curl.exe next to the user's website win.
const curlBin = (() => {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
    try { if (fs.existsSync(sys)) return sys; } catch (_) { /* fall through */ }
    return 'curl.exe';
  }
  return 'curl';
})();

// curl config-file quoting: backslash and double quote are the only escapes we
// need, and escaping backslash first also neutralises \n / \t sequences.
const curlQuote = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

const encodePath = (p) => String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');

function baseUrl(rec) {
  const host = rec.host.includes(':') && !rec.host.startsWith('[') ? '[' + rec.host + ']' : rec.host;
  const port = rec.port && rec.port !== 21 ? ':' + rec.port : '';
  const remote = rec.remoteDir ? '/' + encodePath(rec.remoteDir) : '';
  return `ftp://${host}${port}${remote}`;
}

function securityArgs(rec) {
  const a = [];
  if (rec.security === 'ftps') a.push('--ssl-reqd');
  else if (rec.security !== 'plain') a.push('--ftp-ssl-control');
  // Shared hosts routinely serve a certificate for the provider, not for the
  // per-account hostname, so cert verification is opt-out per site.
  if (rec.insecureCert !== false && rec.security !== 'plain') a.push('-k');
  return a;
}

// One curl invocation. Credentials go in over stdin, never argv. Resolves
// { code, stdout, stderr } and never rejects.
function runCurl(args, credLine, { timeout = 900000, onChild } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(curlBin, ['--config', '-', ...args], {
        // No cwd: every local path we pass is already absolute, and leaving the
        // project folder out of the picture keeps binary resolution predictable.
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: 'curl could not be started: ' + err.message });
      return;
    }
    if (onChild) onChild(child);

    let stdout = '', stderr = '', done = false;
    const finish = (res) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* already gone */ }
      finish({ code: 28, stdout, stderr: stderr || 'The upload timed out.' });
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      finish(err && err.code === 'ENOENT'
        ? { code: 127, stdout: '', stderr: 'curl was not found. It ships with Windows 10 and 11 — check that C:\\Windows\\System32\\curl.exe exists.' }
        : { code: 1, stdout, stderr: (err && err.message) || 'curl failed to start.' });
    });
    child.on('close', (code) => finish({ code: code == null ? 1 : code, stdout, stderr }));

    child.stdin.on('error', () => { /* curl exited before reading the config */ });
    child.stdin.end(credLine);
  });
}

// curl exit codes worth translating; anything else falls back to stderr.
const CURL_MSG = {
  6: 'Could not resolve the FTP server name.',
  7: 'Could not connect to the FTP server.',
  9: 'The server refused access to that folder — check the remote folder path.',
  28: 'The connection timed out.',
  35: 'The secure (TLS) handshake failed. Try a different connection security setting.',
  60: "The server's certificate could not be verified. Tick \u201cAllow the host's shared certificate\u201d.",
  67: 'The FTP server rejected the username or password.',
  78: 'The remote file or folder does not exist.',
};

function curlMessage(res) {
  const err = (res.stderr || '').trim().replace(/^curl:\s*\(\d+\)\s*/i, '');
  return err || CURL_MSG[res.code] || `curl exited with code ${res.code}.`;
}

// ---------------------------------------------------------------------------
// Connection test + publish
// ---------------------------------------------------------------------------
function credFor(dir) {
  const key = keyFor(dir);
  const rec = readStore().sites[key];
  if (!rec) return { error: 'This hive has no publish settings yet.' };
  const pass = decryptSecret(rec, key);
  if (pass == null) {
    return { error: rec.secret
      ? 'The saved password could not be decrypted (it was encrypted for a different Windows user or machine). Enter it again.'
      : 'No password saved. Open the connection settings and enter it.' };
  }
  return { rec, line: 'user = ' + curlQuote(rec.user + ':' + pass) + '\n' };
}

// List the remote folder — cheap proof that host, credentials and path all work.
async function test(dir) {
  const c = credFor(dir);
  if (c.error) return { ok: false, message: c.error };
  const url = baseUrl(c.rec) + '/';
  const res = await runCurl(
    [...securityArgs(c.rec), '-sS', '--list-only', '--connect-timeout', '20', url],
    c.line,
    { timeout: 60000 }
  );
  if (res.code !== 0) return { ok: false, message: curlMessage(res) };
  const names = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { ok: true, message: `Connected. ${names.length} item${names.length === 1 ? '' : 's'} in ${c.rec.remoteDir || 'the login root'}.`, entries: names.slice(0, 200) };
}

// One publish run per project directory at a time.
const running = new Map(); // key -> { cancelled, child }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Upload every changed file (or all of them when `all` is set). `onProgress`
// is called with { phase, rel, index, total, ok, message } as it goes.
async function publish(dir, { all = false } = {}, onProgress = () => {}) {
  if (!dir) return { ok: false, message: 'This hive has no project directory set.' };
  const key = keyFor(dir);
  if (running.has(key)) return { ok: false, message: 'A publish is already running for this hive.' };

  const c = credFor(dir);
  if (c.error) return { ok: false, message: c.error };
  const rec = c.rec;
  if (!(rec.files || []).length) return { ok: false, message: 'Nothing is ticked to publish yet — use “Choose files”.' };

  const scanned = scan(dir);
  const targets = (scanned.files || []).filter((f) => all || f.changed);
  const skippedProblems = scanned.problems || [];

  if (!targets.length) {
    return {
      ok: true, uploaded: 0, files: [], failed: [], skipped: skippedProblems,
      message: 'Everything is already up to date.',
    };
  }

  const job = { cancelled: false, child: null };
  running.set(key, job);

  const base = baseUrl(rec);
  const secArgs = securityArgs(rec);
  const uploaded = [];
  const failed = [];

  try {
    for (let i = 0; i < targets.length; i++) {
      if (job.cancelled) break;
      const { rel } = targets[i];
      const abs = safeJoin(dir, rel);
      // Re-check at upload time: the tree may have changed since the scan.
      if (!abs || !realInside(dir, abs) || denyReason(rel)) {
        failed.push({ rel, message: 'blocked for safety' });
        onProgress({ phase: 'file', rel, index: i + 1, total: targets.length, ok: false, message: 'blocked for safety' });
        continue;
      }
      onProgress({ phase: 'start', rel, index: i + 1, total: targets.length });

      const url = base + '/' + encodePath(rel);
      let res = null;
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        if (job.cancelled) break;
        res = await runCurl(
          [...secArgs, '-sS', '--ftp-create-dirs', '--connect-timeout', '20', '-T', abs, url],
          c.line,
          { onChild: (ch) => { job.child = ch; } }
        );
        job.child = null;
        if (res.code === 0 || job.cancelled) break;
        // Auth failures never fix themselves; don't burn two more tries on them.
        if (res.code === 67 || res.code === 127) break;
        if (attempt < RETRIES) {
          onProgress({ phase: 'retry', rel, index: i + 1, total: targets.length, attempt });
          await sleep(RETRY_DELAY_MS);
        }
      }
      if (job.cancelled) break;

      if (res && res.code === 0) {
        uploaded.push(rel);
        onProgress({ phase: 'file', rel, index: i + 1, total: targets.length, ok: true });
        // Record the fingerprint immediately so a later failure (or a cancel)
        // doesn't force a re-upload of what already landed.
        try {
          const store = readStore();
          const r = store.sites[key];
          if (r) {
            const st = fs.statSync(abs);
            r.state = r.state || {};
            r.state[rel] = { size: st.size, mtime: Math.floor(st.mtimeMs), hash: sha256(abs), at: Date.now() };
            store.sites[key] = r;
            writeStore(store);
          }
        } catch (_) { /* the file will simply be re-sent next time */ }
      } else {
        const message = res ? curlMessage(res) : 'Upload failed.';
        failed.push({ rel, message });
        onProgress({ phase: 'file', rel, index: i + 1, total: targets.length, ok: false, message });
      }
    }
  } finally {
    running.delete(key);
  }

  if (uploaded.length) {
    const store = readStore();
    const r = store.sites[key];
    if (r) { r.lastPublish = Date.now(); store.sites[key] = r; writeStore(store); }
  }

  const cancelled = job.cancelled;
  let message;
  if (cancelled) message = `Stopped. ${uploaded.length} file${uploaded.length === 1 ? '' : 's'} uploaded before cancelling.`;
  else if (failed.length) message = `${uploaded.length} uploaded, ${failed.length} failed: ${failed.map((f) => f.rel).join(', ')}`;
  else message = `Published ${uploaded.length} file${uploaded.length === 1 ? '' : 's'}.`;

  // An empty remote folder is legal — it means the FTP login root — but on
  // shared hosting the login lands *above* the web root, so every file
  // transfers successfully and the website never changes. That failure is
  // completely silent otherwise, so say it out loud.
  const warning = !rec.remoteDir && uploaded.length
    ? 'Uploaded to the FTP login root, because no remote folder is set. On most hosts the website lives in a subfolder (public_html, or domains/<your-domain>/public_html) and nothing on the site will have changed. Check the remote folder in ⚙.'
    : undefined;

  return { ok: !failed.length && !cancelled, cancelled, uploaded: uploaded.length, files: uploaded, failed, skipped: skippedProblems, message, warning };
}

function cancel(dir) {
  const job = running.get(keyFor(dir));
  if (!job) return { ok: false };
  job.cancelled = true;
  if (job.child) { try { job.child.kill(); } catch (_) { /* already gone */ } }
  return { ok: true };
}

// Which of these project-relative paths would be refused, and why. The picker
// asks per directory listing so the denylist stays defined in exactly one place.
function denyPaths(rels) {
  const out = {};
  if (!Array.isArray(rels)) return out;
  for (const rel of rels.slice(0, MAX_FILES)) {
    const r = String(rel || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!r) continue;
    const why = denyReason(r);
    if (why) out[rel] = why;
  }
  return out;
}

module.exports = {
  getConfig, setConfig, setPassword, forget,
  scan, test, publish, cancel, denyPaths,
  // exported for tests / reuse
  denyReason,
};
