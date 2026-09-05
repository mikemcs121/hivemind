'use strict';

// ---------------------------------------------------------------------------
// ChatGPT (Codex CLI) accounts.
//
// The Codex CLI keeps exactly one signed-in account per *home directory*: its
// whole state — `auth.json`, `config.toml`, sessions, history — lives under
// `~/.codex`, and the `CODEX_HOME` environment variable relocates that
// directory wholesale. There is no per-invocation account flag (`--profile`
// layers config only, not credentials), so a second account means a second
// home.
//
// This module owns those extra homes. Each named account gets its own
// directory under `<userData>/codex-homes/<id>`, and `main.js` puts that path
// in `CODEX_HOME` when it spawns a ChatGPT thread's PTY. Threads on different
// accounts therefore run against different logins at the same time.
//
// ## Why userData and not the project or the home directory
//
// The agent threads Hivemind spawns work
// *inside* the project folder and the project folder gets committed and
// shared, so credentials must not live there. `~/.codex-<name>` was the other
// candidate; userData keeps every Hivemind-created home in one place that an
// `HM_USER_DATA` test instance automatically isolates.
//
// ## Seeding
//
// A brand-new home has no `config.toml`, which would silently drop the user's
// Codex settings (approval policy, MCP servers, …) on threads using that
// account. So a new account starts as a copy of the default home's
// `config.toml` — settings carried over, credentials not. Managed homes force
// `cli_auth_credentials_store = "file"`: CODEX_HOME isolates auth.json, while
// an OS keyring can otherwise make two homes silently share one login.
//
// ## What crosses back to the renderer
//
// Labels, ids, sign-in state, and the account's email/plan read out of the
// stored ID token. Never the tokens themselves.
// ---------------------------------------------------------------------------

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agentModels = require('./agent-models');

const STORE_VERSION = 1;
const MAX_ACCOUNTS = 12;        // a dropdown, not a directory
const MAX_LABEL = 40;
const DEFAULT_ID = 'default';

const storeFile = () => path.join(app.getPath('userData'), 'codex-accounts.json');
const homesRoot = () => path.join(app.getPath('userData'), 'codex-homes');

// The home the Codex CLI would use on its own. Honouring an inherited
// CODEX_HOME matters: if the user launched Hivemind with one set, that — not
// `~/.codex` — is what the "Default" account really points at.
function defaultHome() {
  const env = process.env.CODEX_HOME && String(process.env.CODEX_HOME).trim();
  return env ? path.resolve(env) : path.join(os.homedir(), '.codex');
}

function ensureFileCredentialStore(home) {
  const file = path.join(home, 'config.toml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { /* a new home */ }
  const lines = text.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const existing = lines.slice(0, limit).findIndex((line) => /^\s*cli_auth_credentials_store\s*=/.test(line));
  if (existing >= 0) lines[existing] = 'cli_auth_credentials_store = "file"';
  else lines.unshift('cli_auth_credentials_store = "file"', '');
  fs.writeFileSync(file, lines.join('\n').replace(/^\n+/, ''), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Ids
//
// An account id is a directory name under homesRoot(), so it is validated
// rather than trusted: lowercase alphanumerics and dashes only, no dots, so it
// can never climb out of the root or collide with the store file. `default` is
// reserved for the CLI's own home, which this module never creates or deletes.
// ---------------------------------------------------------------------------

const isSafeId = (id) =>
  typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id) && id !== DEFAULT_ID;

function slugify(label) {
  const base = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return /^[a-z0-9]/.test(base) ? base : 'account';
}

function uniqueId(label, taken) {
  const base = slugify(label);
  if (!taken.has(base) && isSafeId(base)) return base;
  for (let n = 2; n < 100; n++) {
    const cand = base.slice(0, 28) + '-' + n;
    if (!taken.has(cand) && isSafeId(cand)) return cand;
  }
  return null;
}

const errText = (err) => (err && err.message ? err.message : String(err));

const cleanLabel = (label) =>
  String(label == null ? '' : label)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    if (data && typeof data === 'object' && Array.isArray(data.accounts)) {
      return {
        version: STORE_VERSION,
        accounts: data.accounts
          .filter((a) => a && isSafeId(a.id))
          .map((a) => ({ id: a.id, label: cleanLabel(a.label) || a.id })),
      };
    }
  } catch (_) { /* no file yet, or unreadable — treat as empty */ }
  return { version: STORE_VERSION, accounts: [] };
}

function writeStore(store) {
  const file = storeFile();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    console.error('Failed to save Codex accounts:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading a home's sign-in state
// ---------------------------------------------------------------------------

// Who is signed in to this home, from `auth.json`. The ChatGPT login stores an
// OIDC ID token whose payload carries the account's email and plan; that is
// decoded (not verified — this is a label, not an authorization decision) so
// the UI can say *which* account a row is, rather than just "signed in".
// Returns no secrets.
function describeHome(home) {
  const info = { signedIn: false, email: '', plan: '', method: '' };
  let raw;
  try {
    raw = fs.readFileSync(path.join(home, 'auth.json'), 'utf8');
  } catch (_) {
    // With keyring/auto storage, absence of auth.json says nothing. Report an
    // unknown state instead of incorrectly labelling an active account signed
    // out; the CLI itself remains the authority and logout uses it below.
    try {
      const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
      const top = config.split(/^\s*\[/m, 1)[0];
      const match = /^\s*cli_auth_credentials_store\s*=\s*["'](keyring|auto)["']/mi.exec(top);
      if (match) {
        info.signedIn = null;
        info.method = match[1];
      }
    } catch (_) { /* default file-storage assumption */ }
    return info;
  }
  info.signedIn = true;
  try {
    const auth = JSON.parse(raw);
    if (typeof auth.auth_mode === 'string') info.method = auth.auth_mode;
    else if (auth.OPENAI_API_KEY) info.method = 'apikey';
    const jwt = auth && auth.tokens && auth.tokens.id_token;
    const seg = typeof jwt === 'string' ? jwt.split('.')[1] : null;
    if (seg) {
      const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
      if (typeof payload.email === 'string') info.email = payload.email.slice(0, 120);
      const claims = payload['https://api.openai.com/auth'];
      const plan = claims && claims.chatgpt_plan_type;
      if (typeof plan === 'string') info.plan = plan.slice(0, 40);
    }
  } catch (_) { /* an auth.json we can't parse still means "signed in" */ }
  return info;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// The directory a given account id maps to, or `null` for "no override".
// Null covers the Default account, an unknown id, and a stored account whose
// entry has gone — all three correctly fall back to the CLI's own home.
function homeFor(id) {
  if (!isSafeId(id)) return null;
  if (!readStore().accounts.some((a) => a.id === id)) return null;
  const home = path.join(homesRoot(), id);
  // Codex creates its home on demand, but a thread that starts on a
  // half-deleted account should still land somewhere sane.
  try {
    fs.mkdirSync(home, { recursive: true });
    ensureFileCredentialStore(home);
  } catch (_) { /* codex will report it if it matters */ }
  return home;
}

// Every account, Default first. Each entry carries its sign-in state so the UI
// can show which ones still need a `codex login`.
function list() {
  const out = [];
  const home = defaultHome();
  out.push(Object.assign(
    { id: DEFAULT_ID, label: 'Default', home: home, builtin: true },
    describeHome(home),
  ));
  for (const acc of readStore().accounts) {
    const dir = path.join(homesRoot(), acc.id);
    out.push(Object.assign(
      { id: acc.id, label: acc.label, home: dir, builtin: false },
      describeHome(dir),
    ));
  }
  return out;
}

function add(label) {
  const name = cleanLabel(label);
  if (!name) return { ok: false, error: 'Give the account a name.' };
  const store = readStore();
  if (store.accounts.length >= MAX_ACCOUNTS) {
    return { ok: false, error: 'Hivemind holds at most ' + MAX_ACCOUNTS + ' extra ChatGPT accounts.' };
  }
  if (store.accounts.some((a) => a.label.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'There is already an account called "' + name + '".' };
  }
  const id = uniqueId(name, new Set(store.accounts.map((a) => a.id)));
  if (!id) return { ok: false, error: 'Could not derive a folder name for that account.' };

  const home = path.join(homesRoot(), id);
  try {
    fs.mkdirSync(home, { recursive: true });
    // Carry the user's Codex settings over to the new home — but never the
    // credentials, which are the whole point of a separate account.
    const src = path.join(defaultHome(), 'config.toml');
    const dst = path.join(home, 'config.toml');
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    ensureFileCredentialStore(home);
  } catch (err) {
    return { ok: false, error: 'Could not create the account folder: ' + errText(err) };
  }

  store.accounts.push({ id: id, label: name });
  if (!writeStore(store)) return { ok: false, error: 'Could not save the account list.' };
  return { ok: true, id: id, accounts: list() };
}

function rename(id, label) {
  const name = cleanLabel(label);
  if (!name) return { ok: false, error: 'Give the account a name.' };
  const store = readStore();
  const acc = store.accounts.find((a) => a.id === id);
  if (!acc) return { ok: false, error: 'No such account.' };
  if (store.accounts.some((a) => a.id !== id && a.label.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'There is already an account called "' + name + '".' };
  }
  acc.label = name;
  if (!writeStore(store)) return { ok: false, error: 'Could not save the account list.' };
  return { ok: true, accounts: list() };
}

// Forget an account and delete its home. Destructive: the stored login goes
// with it. The path is rebuilt from a validated id and re-checked against
// homesRoot() before anything is removed, so a bad id can't delete elsewhere.
function remove(id) {
  if (!isSafeId(id)) return { ok: false, error: 'The default account cannot be removed.' };
  const store = readStore();
  const i = store.accounts.findIndex((a) => a.id === id);
  if (i === -1) return { ok: false, error: 'No such account.' };
  const root = homesRoot();
  const home = path.join(root, id);
  if (!home.startsWith(root + path.sep) || path.basename(home) !== id) {
    return { ok: false, error: 'Refusing to delete outside the accounts folder.' };
  }
  store.accounts.splice(i, 1);
  if (!writeStore(store)) return { ok: false, error: 'Could not save the account list.' };
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* the entry is gone either way */ }
  return { ok: true, accounts: list() };
}

// Drop just the stored credentials, keeping the account and its settings —
// what `codex logout` does to a home. Doing it here means the user doesn't
// have to start a thread on an account merely to sign out of it.
async function signOut(id) {
  const home = id === DEFAULT_ID ? defaultHome() : homeFor(id);
  if (!home) return { ok: false, error: 'No such account.' };
  // The built-in home may use the OS keyring (`auto`/`keyring` in current
  // Codex). Only `codex logout` can clear that store; deleting auth.json would
  // falsely report success while leaving the active login intact. Managed
  // homes are forced to file storage and can be cleared directly.
  if (id === DEFAULT_ID) {
    try {
      await agentModels.runCli('codex', ['logout'], { CODEX_HOME: home });
      return { ok: true, accounts: list() };
    } catch (_) {
      return { ok: false, error: 'Could not sign out through the Codex CLI. Make sure Codex is installed, then try again.' };
    }
  }
  try {
    fs.rmSync(path.join(home, 'auth.json'), { force: true });
  } catch (err) {
    return { ok: false, error: 'Could not sign out: ' + errText(err) };
  }
  return { ok: true, accounts: list() };
}

module.exports = { list, add, rename, remove, signOut, homeFor, defaultHome, MAX_ACCOUNTS };
