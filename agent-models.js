'use strict';

// Model catalogs exposed by the installed agent CLIs.  The provider owns the
// authoritative, account-aware list; Hivemind only reduces that output to safe
// { value, label } records for the renderer.  Discovery is best-effort so an
// older/missing CLI never prevents the app from opening.

const childProcess = require('child_process');
const agentCli = require('./agent-cli');

const TIMEOUT_MS = 15000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const CACHE_MS = 5 * 60 * 1000;

const FALLBACKS = Object.freeze({
  claude: [
    { value: 'default', label: 'Default' },
    { value: 'fable', label: 'Fable' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ],
  codex: [
    { value: 'default', label: 'Default' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.3-codex-spark', label: 'Codex Spark' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  ],
  grok: [{ value: 'default', label: 'Default' }],
});

const cache = new Map();

function cleanId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 160 && /^[a-z0-9][a-z0-9._:/-]*$/i.test(id) ? id : '';
}

function titleFor(id) {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => /^[a-z]+$/i.test(part)
      ? (part.toLowerCase() === 'gpt' ? 'GPT' : part[0].toUpperCase() + part.slice(1))
      : part)
    .join(' ');
}

function normalize(items) {
  const out = [{ value: 'default', label: 'Default' }];
  const seen = new Set(['default']);
  for (const item of items || []) {
    const value = cleanId(typeof item === 'string' ? item : item && item.value);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    const rawLabel = item && typeof item === 'object' ? item.label : '';
    const label = String(rawLabel || titleFor(value)).trim().slice(0, 120) || value;
    out.push({ value, label });
  }
  return out;
}

function merge(primary, fallback) {
  return normalize([...(primary || []), ...(fallback || []).filter((m) => m.value !== 'default')]);
}

function parseCodex(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Codex returned no JSON model catalog.');
  const parsed = JSON.parse(text.slice(start, end + 1));
  const models = Array.isArray(parsed) ? parsed : parsed.models;
  if (!Array.isArray(models)) throw new Error('Codex returned an invalid model catalog.');
  return normalize(models
    .filter((m) => m && m.visibility !== 'hide')
    .map((m) => ({ value: m.slug || m.id, label: m.display_name || m.name })));
}

function parseGrok(stdout) {
  const lines = String(stdout || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*Available models\s*:/i.test(line));
  const candidates = (start >= 0 ? lines.slice(start + 1) : lines)
    .map((line) => {
      const hit = /^\s*[*-]\s+([^\s(]+)(?:\s+\(default\))?\s*$/i.exec(line);
      return hit && hit[1];
    })
    .filter(Boolean);
  return normalize(candidates);
}

function parseClaude(stdout) {
  // Claude has no supported catalog command. Its help text does document any
  // rolling aliases accepted by --model, so merge newly advertised aliases
  // into the stable fallback set. Full version ids remain a CLI concern.
  const text = String(stdout || '').replace(/\s+/g, ' ');
  const section = (/--model <model>(.{0,500})/i.exec(text) || [])[1] || '';
  const aliases = [];
  for (const match of section.matchAll(/['"]([a-z][a-z0-9.-]{1,40})['"]/gi)) {
    const id = match[1].toLowerCase();
    if (!['default', 'latest'].includes(id) && !id.startsWith('claude-')) aliases.push(id);
  }
  return normalize(aliases);
}

// PATH lookup lives in agent-cli.js, which also searches the install
// directories a CLI can occupy without ever landing on PATH (the Codex desktop
// app's per-build bin). Threads spawn with those same directories appended to
// PATH, so discovery and the running thread agree on which binary a name means.
function resolveCommand(name) {
  return agentCli.resolveCommand(name);
}

function runCli(name, args, env) {
  const bin = resolveCommand(name);
  if (!bin) return Promise.reject(Object.assign(new Error(name + ' is not installed or is not on PATH.'), { code: 'ENOENT' }));
  // Windows cannot CreateProcess a .cmd/.bat shim directly. The resolved path
  // and every argument are fixed by this module (never renderer input), so the
  // platform shell is safe here and handles npm's shim quoting correctly.
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  return new Promise((resolve, reject) => {
    const options = {
      env: agentCli.augmentEnv(Object.assign({}, process.env, env || {})),
      windowsHide: true,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    };
    const done = (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message || '').trim().split(/\r?\n/).slice(-2).join(' ');
        reject(Object.assign(new Error(detail || (name + ' model discovery failed.')), { code: err.code }));
        return;
      }
      resolve(stdout);
    };
    if (shell) {
      // The executable path is resolved from PATH and args are internal fixed
      // literals. Quote each for cmd so spaces in an npm prefix remain safe.
      const quote = (s) => '"' + String(s).replace(/"/g, '""') + '"';
      childProcess.exec([quote(bin), ...args.map(quote)].join(' '), options, done);
    } else {
      childProcess.execFile(bin, args, options, done);
    }
  });
}

async function discover(provider, options = {}) {
  // `FALLBACKS[provider]` on its own inherits from Object.prototype, so a
  // provider of "constructor" or "toString" returns something truthy, sails past
  // the guard, and throws deeper in `merge`. Own properties only.
  const known = Object.prototype.hasOwnProperty.call(FALLBACKS, provider);
  const fallback = known ? FALLBACKS[provider] : null;
  if (!fallback) return { provider, models: [], source: 'fallback', installed: false, error: 'Unknown agent.' };
  const codexHome = provider === 'codex' && options.codexHome ? String(options.codexHome) : '';
  const key = provider + '\0' + codexHome;
  const prior = cache.get(key);
  if (!options.force && prior && Date.now() - prior.at < CACHE_MS) return prior.value;

  const spec = provider === 'codex'
    ? { command: 'codex', args: ['debug', 'models'], parse: parseCodex, env: codexHome ? { CODEX_HOME: codexHome } : {} }
    : provider === 'grok'
      ? { command: 'grok', args: ['models'], parse: parseGrok, env: {} }
      : { command: 'claude', args: ['--help'], parse: parseClaude, env: {} };
  let value;
  try {
    const stdout = await runCli(spec.command, spec.args, spec.env);
    const found = spec.parse(stdout);
    const hasCatalog = provider === 'claude' || found.length > 1;
    const models = provider === 'claude'
      ? merge(found, fallback)
      : (hasCatalog ? found : fallback.map((m) => Object.assign({}, m)));
    value = {
      provider,
      models,
      source: hasCatalog ? 'cli' : 'fallback',
      installed: true,
      error: hasCatalog ? '' : 'The CLI returned no selectable models; sign in and refresh.',
    };
  } catch (err) {
    const missing = !!(err && err.code === 'ENOENT');
    const label = provider === 'codex' ? 'ChatGPT/Codex' : provider === 'grok' ? 'Grok' : 'Claude';
    value = {
      provider,
      models: fallback.map((m) => Object.assign({}, m)),
      source: 'fallback',
      installed: !missing,
      // Do not return raw CLI stderr: authentication output can contain a
      // device code or URL. The terminal remains the place for those details.
      error: missing
        ? label + ' is not installed or is not on PATH.'
        : label + ' could not refresh models. Launch it once, finish signing in, and retry.',
    };
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = {
  discover,
  runCli,
  FALLBACKS,
  _parseCodex: parseCodex,
  _parseGrok: parseGrok,
  _parseClaude: parseClaude,
  _resolveCommand: resolveCommand,
};
