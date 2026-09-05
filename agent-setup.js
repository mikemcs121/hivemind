'use strict';

// ---------------------------------------------------------------------------
// First-run agent detection — "is there an agent on this machine at all?"
//
// Hivemind does nothing useful until at least one agent CLI is installed and
// signed in, and nothing used to say so: a brand-new user landed on "Create
// your first hive", made one, and watched the first thread die on PowerShell's
// "'claude' is not recognized as the name of a cmdlet". The setup wizard in
// `src/renderer.js` walks that user through picking an agent and getting it
// connected; this module is the fact base it renders.
//
// Two questions per agent, both answered without running anything:
//
//   installed — resolved by `agent-cli.js` against PATH *plus* the install
//     directories PATH can miss (the Codex desktop app's per-build bin,
//     `~/.local/bin`). That is the exact resolution a spawned thread gets, so
//     the wizard can never call something installed that a thread won't find.
//
//   signedIn — read off the CLI's own credential file. `true` / `false` /
//     `null`, where null means "this machine's layout can't answer" (an OS
//     keyring, or a CLI whose credential store we don't know). Never guess
//     `false`: the wizard words an unknown as "the thread will ask you if it
//     needs to", which is always true, whereas a wrong "not signed in" sends
//     the user off to re-authenticate an account that was already fine.
//
// Deliberately cheap and deliberately quiet. Nothing here spawns a process —
// `agent-models.js` does that, and a cold `codex debug models` costs seconds,
// far too long for a wizard step that re-checks on a timer. Nothing here
// returns a token, a path inside a credential file, or raw CLI output: only
// booleans plus the fixed install/doc strings below, which are constants in
// this file and never anything the filesystem said.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const agentCli = require('./agent-cli');

// Credential files are small. The cap keeps a pathological (or hostile) file
// from being parsed at all — `~/.claude.json` is a config file that grows with
// project history, and it is read here only as a fallback signal.
const MAX_CRED_BYTES = 4 * 1024 * 1024;

const inHome = (...parts) => path.join(os.homedir(), ...parts);

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function envSet(...names) {
  return names.some((n) => !!(process.env[n] && String(process.env[n]).trim()));
}

// True only when the file parses *and* carries the field that means "signed
// in". A half-written or truncated auth.json would otherwise read as a good
// login and the wizard would wave the user past a step they still need.
function jsonSays(file, test) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_CRED_BYTES) return false;
    return !!test(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) { return false; }
}

// -- Per-agent sign-in probes ------------------------------------------------
// Each returns true / false / null (unknown). They only ever read; signing in
// is the CLI's own job, done by the user in a thread.

// Claude Code stores its OAuth grant in `~/.claude/.credentials.json` (the same
// file `usage.js` reads for rate-limit windows). A native-installer login that
// used an OS keyring leaves that file absent but stamps the account into
// `~/.claude.json`, so check both before believing "not signed in".
function claudeSignedIn() {
  if (jsonSays(inHome('.claude', '.credentials.json'),
    (d) => d && d.claudeAiOauth && d.claudeAiOauth.accessToken)) return true;
  if (envSet('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN')) return true;
  if (jsonSays(inHome('.claude.json'), (d) => d && d.oauthAccount)) return true;
  return isFile(inHome('.claude', '.credentials.json')) ? null : false;
}

// Codex keeps one login per *home directory*, and Hivemind can own several of
// them (`codex.js`). Any signed-in account counts: the wizard's question is
// "can a ChatGPT thread work at all", not "which account". `codex.js` needs
// Electron's userData path, so a non-Electron caller (tests) falls back to the
// default home alone — the same shape `usage.js` uses.
function codexSignedIn() {
  try {
    const accounts = require('./codex').list();
    if (accounts.some((a) => a.signedIn === true)) return true;
    if (accounts.some((a) => a.signedIn === null)) return null;
    return false;
  } catch (_) {
    const env = process.env.CODEX_HOME && String(process.env.CODEX_HOME).trim();
    const home = env ? path.resolve(env) : inHome('.codex');
    return isFile(path.join(home, 'auth.json'));
  }
}

// The Gemini CLI writes its Google OAuth grant to `~/.gemini/oauth_creds.json`;
// an API-key setup instead uses the environment.
function geminiSignedIn() {
  if (envSet('GEMINI_API_KEY', 'GOOGLE_API_KEY')) return true;
  if (isFile(inHome('.gemini', 'oauth_creds.json'))) return true;
  if (isFile(inHome('.gemini', 'google_accounts.json'))) return true;
  return isDir(inHome('.gemini')) ? null : false;
}

// Grok's CLI is the one whose credential layout we don't pin down, so an
// existing `~/.grok` with none of the known files reports unknown rather than
// "not signed in".
function grokSignedIn() {
  if (envSet('XAI_API_KEY', 'GROK_API_KEY')) return true;
  const dir = inHome('.grok');
  if (['auth.json', 'user-settings.json', 'settings.json', 'credentials.json']
    .some((f) => isFile(path.join(dir, f)))) return true;
  return isDir(dir) ? null : false;
}

// -- The catalog -------------------------------------------------------------
// `agent` matches the renderer's AGENTS registry values, and `command` matches
// what a thread types into its shell. `install` is a shell command or an https
// URL; the renderer picks its wording off which one it is.

const AGENTS = Object.freeze([
  {
    agent: 'claude',
    label: 'Claude',
    command: 'claude',
    blurb: "Anthropic's Claude Code. The agent Hivemind is built around — plan review, "
      + 'chat view, past conversations and cost estimates all work on Claude threads.',
    install: 'npm install -g @anthropic-ai/claude-code',
    docs: 'https://docs.claude.com/en/docs/claude-code/setup',
    signIn: claudeSignedIn,
  },
  {
    agent: 'codex',
    label: 'ChatGPT',
    command: 'codex',
    blurb: "OpenAI's Codex CLI, signed in with a ChatGPT account. Threads get the chat "
      + 'view and approval cards, and several ChatGPT logins can run side by side.',
    install: 'npm install -g @openai/codex',
    docs: 'https://developers.openai.com/codex/cli',
    signIn: codexSignedIn,
  },
  {
    agent: 'gemini',
    label: 'Gemini',
    command: 'gemini',
    blurb: "Google's Gemini CLI. Terminal-only threads — no chat view, plan review or "
      + 'cost estimate.',
    install: 'npm install -g @google/gemini-cli',
    docs: 'https://github.com/google-gemini/gemini-cli',
    signIn: geminiSignedIn,
  },
  {
    agent: 'grok',
    label: 'Grok',
    command: 'grok',
    blurb: "xAI's Grok CLI. Terminal-only threads, with a model dropdown.",
    install: 'https://x.ai/cli',
    docs: 'https://x.ai/cli',
    signIn: grokSignedIn,
  },
]);

// One record per agent, plus the two summary flags the wizard's trigger and its
// step wording key off. `installed` is authoritative; `signedIn` is advisory.
function detect() {
  const agents = AGENTS.map((spec) => {
    const bin = agentCli.resolveCommand(spec.command);
    const installed = !!bin;
    return {
      agent: spec.agent,
      label: spec.label,
      command: spec.command,
      blurb: spec.blurb,
      install: spec.install,
      docs: spec.docs,
      installed,
      // Probing credentials for a CLI that isn't there tells the user nothing
      // and can only mislead ("signed in" for an agent they can't run).
      signedIn: installed ? spec.signIn() : false,
    };
  });
  return {
    agents,
    anyInstalled: agents.some((a) => a.installed),
    // `signedIn !== false` — an unknown counts as ready, because the thread
    // itself will ask if it turns out not to be. See the header note.
    anyReady: agents.some((a) => a.installed && a.signedIn !== false),
  };
}

module.exports = { detect, AGENTS };
