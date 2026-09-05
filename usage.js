'use strict';

// Agent usage — how much of each agent's subscription is spent, and what
// today's work has cost, for every agent Hivemind can run threads on.
//
// Hivemind mixes agents in one hive, so "usage" is never a single number: a
// Claude thread and a ChatGPT thread bill to different subscriptions, and the
// ChatGPT side can be several *different* logins at once (codex.js gives each
// named account its own CODEX_HOME). The readout is therefore per agent, and
// within an agent per account.
//
// Each agent's numbers come from wherever that CLI actually keeps them:
//
//  * Claude (one login per machine) — plan limits from the same OAuth endpoint
//    Claude Code's /usage screen calls, authenticated with the token in
//    ~/.claude/.credentials.json. Live — but the endpoint budgets refreshes
//    tightly, so a refused one falls back to the last reading, aged and
//    labelled the same way the ChatGPT side always is.
//  * ChatGPT / Codex (one login per CODEX_HOME) — there is no equivalent
//    endpoint, but the CLI records the server's rate-limit snapshot into every
//    session rollout: `event_msg` lines of type `token_count` carry a
//    `rate_limits` block. So the limits are read back out of the newest rollout
//    in each account's home. That makes them *observed*, not live — they are as
//    of the last time that account ran, which is why every ChatGPT window
//    carries an `observedAt` the UI has to show.
//
// Token totals for the day are local in both cases: Claude's JSONL transcripts
// under ~/.claude/projects/, Codex's rollouts under <home>/sessions/. Neither
// costs a network call.
//
// Nothing here writes anything, and no agent's failure sinks another's: every
// source is caught into its own `error` field.

const fs = require('fs');
const path = require('path');
const os = require('os');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 8 * 1000; // abort a hung usage request instead of hanging

// How far back to look for a ChatGPT rate-limit snapshot before giving up. An
// account nobody has used in two weeks has no meaningful number to show.
const CODEX_LIMIT_DAYS = 14;
const CODEX_LIMIT_FILES = 40;   // stop after this many rollouts per account
const CODEX_TAIL_BYTES = 256 * 1024; // rate_limits ride the last events of a rollout
const CODEX_TOKEN_DAYS = 3;     // date dirs to consider for "today" (mtime prunes further)

const claudeDir = () => path.join(os.homedir(), '.claude');

const errText = (err) => (err && err.message ? err.message : String(err));

const localMidnight = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Plan names arrive as API slugs ("max", "self_serve_business_prolite") but sit
// next to an account name in the UI, so tidy them into words.
function prettyPlan(slug) {
  const s = String(slug || '').trim();
  if (!s) return '';
  return s.replace(/^self[_-]serve[_-]/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .slice(0, 40);
}

// The per-model token bucket both agents fill. `input` always excludes cached
// tokens so the two tables mean the same thing side by side.
const bucket = (byModel, model) => byModel[model] || (byModel[model] = {
  messages: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
});

// ---------------------------------------------------------------------------
// Claude — plan limits (OAuth endpoint)
// ---------------------------------------------------------------------------

function readOauth() {
  const file = path.join(claudeDir(), '.credentials.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    throw new Error('No Claude Code credentials found — run `claude` and sign in first.');
  }
  const oauth = data && data.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    throw new Error('Claude Code is not signed in with a subscription account.');
  }
  return oauth;
}

// Human label for a limit entry. The endpoint reports each window as a "kind"
// plus an optional model scope (e.g. the weekly cap for one model family).
function limitLabel(l) {
  const scopeName = l.scope && l.scope.model && l.scope.model.display_name;
  switch (l.kind) {
    case 'session': return 'Session (5-hour window)';
    case 'weekly_all': return 'Week — all models';
    case 'weekly_scoped': return scopeName ? `Week — ${scopeName}` : 'Week — model-specific';
    default: return scopeName ? `${l.kind} — ${scopeName}` : String(l.kind || 'limit');
  }
}

async function fetchClaudeLimits() {
  const oauth = readOauth();
  // A hung connection would otherwise never resolve and stall the usage poll;
  // abort after a few seconds so it surfaces as a caught account error instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: 'Bearer ' + oauth.accessToken,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
    if (res.status === 401) {
      // Token rotated/expired — Claude Code refreshes it whenever it runs, so a
      // retry after using any thread usually clears this.
      throw new Error('Claude sign-in token expired — use any thread once (Claude Code refreshes it), then retry.');
    }
    if (res.status === 429) {
      // The endpoint budgets refreshes tightly, and two Hivemind windows plus a
      // few ⟳ clicks are enough to trip it. Not an error worth blanking the
      // bars over — the caller falls back to the last good reading.
      throw new Error('Claude\'s usage endpoint is rate-limiting refreshes right now.');
    }
    if (!res.ok) throw new Error('Usage endpoint returned HTTP ' + res.status);
    const body = await res.json();
    const limits = (Array.isArray(body.limits) ? body.limits : []).map((l) => ({
      kind: l.kind || '',
      label: limitLabel(l),
      percent: typeof l.percent === 'number' ? l.percent : null,
      resetsAt: l.resets_at || null,
      severity: l.severity || 'normal',
    })).filter((l) => l.percent !== null);
    return { plan: oauth.subscriptionType || '', limits };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Claude — today's tokens (local transcripts)
// ---------------------------------------------------------------------------

// Sum the usage blocks of every assistant message written today (local time).
// Only transcript files touched today can contain today's records, so mtime
// prunes the scan cheaply. Records are deduped on message+request id because
// a message can be re-emitted into the same transcript (e.g. on resume).
async function claudeTokensToday() {
  const projectsDir = path.join(claudeDir(), 'projects');
  const startMs = localMidnight();

  const byModel = {}; // model -> { messages, input, output, cacheRead, cacheCreate }
  const seen = new Set();

  let dirs = [];
  try { dirs = await fs.promises.readdir(projectsDir); } catch (_) { return { byModel }; }

  for (const d of dirs) {
    const dir = path.join(projectsDir, d);
    let entries = [];
    try { entries = await fs.promises.readdir(dir); } catch (_) { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        // `await` per file yields the event loop between files so a large
        // scan can't block the main process; mtime still prunes the reads.
        if ((await fs.promises.stat(file)).mtimeMs < startMs) continue;
        const lines = (await fs.promises.readFile(file, 'utf8')).split('\n');
        for (const line of lines) {
          // Cheap pre-filter before paying for JSON.parse on every line.
          if (line.indexOf('"assistant"') === -1 || line.indexOf('"usage"') === -1) continue;
          let o;
          try { o = JSON.parse(line); } catch (_) { continue; }
          if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
          if (!o.timestamp || Date.parse(o.timestamp) < startMs) continue;
          const model = o.message.model || 'unknown';
          if (model === '<synthetic>') continue;
          const key = (o.message.id || '') + ':' + (o.requestId || '');
          if (key !== ':' && seen.has(key)) continue;
          seen.add(key);
          const u = o.message.usage;
          const m = bucket(byModel, model);
          m.messages += 1;
          m.input += u.input_tokens || 0;
          m.output += u.output_tokens || 0;
          m.cacheRead += u.cache_read_input_tokens || 0;
          m.cacheCreate += u.cache_creation_input_tokens || 0;
        }
      } catch (_) {
        /* unreadable transcript — skip */
      }
    }
  }
  return { byModel };
}

// ---------------------------------------------------------------------------
// ChatGPT / Codex — accounts and their session rollouts
// ---------------------------------------------------------------------------

// Every ChatGPT login Hivemind can run a thread on: the CLI's own home plus
// each named account's managed home. codex.js needs Electron's userData, so a
// non-Electron caller (tests) falls back to the default home alone.
function codexAccounts() {
  try {
    const codex = require('./codex');
    return codex.list().map((a) => ({
      id: a.id,
      label: a.label,
      home: a.home,
      email: a.email || '',
      plan: a.plan || '',
      signedIn: a.signedIn,
    }));
  } catch (_) {
    const env = process.env.CODEX_HOME && String(process.env.CODEX_HOME).trim();
    const home = env ? path.resolve(env) : path.join(os.homedir(), '.codex');
    return [{ id: 'default', label: 'Default', home, email: '', plan: '', signedIn: null }];
  }
}

// Rollouts live in a `sessions/YYYY/MM/DD` tree. Yields the newest date dirs
// first, stopping at `limit` — the callers only ever care about recent days.
async function codexDateDirs(home, limit) {
  const root = path.join(home, 'sessions');
  const numeric = async (dir) => {
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return []; }
    return entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name).sort().reverse();
  };
  const out = [];
  for (const y of await numeric(root)) {
    for (const m of await numeric(path.join(root, y))) {
      for (const d of await numeric(path.join(root, y, m))) {
        out.push(path.join(root, y, m, d));
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

// The rollout files in one date dir, newest-modified first.
async function codexRollouts(dir) {
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch (_) { return []; }
  const files = [];
  for (const name of names) {
    if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try { files.push({ file, mtimeMs: (await fs.promises.stat(file)).mtimeMs }); } catch (_) { /* gone */ }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// A rate-limit snapshot rides the *last* events of a rollout, so reading the
// tail beats reading rollouts that can run to megabytes. A split first line is
// simply an unparseable line and gets skipped.
async function readTail(file, bytes) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    if (buf.length) await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

// "Session (5-hour window)" / "Week — all models" — the same vocabulary the
// Claude side uses, derived from the window length Codex reports in minutes.
function codexWindowLabel(minutes, slot) {
  const mins = Number(minutes);
  if (!mins || !isFinite(mins) || mins <= 0) {
    return slot === 'primary' ? 'Primary window' : 'Secondary window';
  }
  if (mins % 10080 === 0) {
    const weeks = mins / 10080;
    return weeks === 1 ? 'Week — all models' : `${weeks}-week window`;
  }
  if (mins % 1440 === 0) {
    const days = mins / 1440;
    return days === 1 ? 'Day (24-hour window)' : `${days}-day window`;
  }
  if (mins % 60 === 0) return `Session (${mins / 60}-hour window)`;
  return `${mins}-minute window`;
}

// Codex reports either an absolute reset (epoch seconds) or a countdown from
// the moment the snapshot was taken. Both become the ISO string the UI formats.
function codexResetIso(window, observedMs) {
  if (typeof window.resets_at === 'number' && window.resets_at > 0) {
    return new Date(window.resets_at * 1000).toISOString();
  }
  if (typeof window.resets_in_seconds === 'number' && window.resets_in_seconds >= 0) {
    return new Date(observedMs + window.resets_in_seconds * 1000).toISOString();
  }
  return null;
}

function codexLimitEntries(rateLimits, observedMs) {
  const out = [];
  for (const slot of ['primary', 'secondary']) {
    const w = rateLimits[slot];
    if (!w || typeof w.used_percent !== 'number') continue;
    out.push({
      kind: 'codex_' + slot,
      label: codexWindowLabel(w.window_minutes, slot),
      percent: Math.max(0, Math.min(100, w.used_percent)),
      resetsAt: codexResetIso(w, observedMs),
      severity: 'normal',
    });
  }
  return out;
}

// The newest rate-limit snapshot this account has on disk, or null if it has
// not run recently enough to have one.
async function codexLimits(home) {
  let examined = 0;
  for (const dir of await codexDateDirs(home, CODEX_LIMIT_DAYS)) {
    for (const { file, mtimeMs } of await codexRollouts(dir)) {
      if (examined++ >= CODEX_LIMIT_FILES) return null;
      let text = '';
      try { text = await readTail(file, CODEX_TAIL_BYTES); } catch (_) { continue; }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.indexOf('"rate_limits"') === -1) continue;
        let o;
        try { o = JSON.parse(line); } catch (_) { continue; }
        const rl = o && o.payload && o.payload.rate_limits;
        if (!rl) continue;
        const observedMs = Date.parse(o.timestamp) || mtimeMs;
        const limits = codexLimitEntries(rl, observedMs);
        if (!limits.length) continue;
        return { limits, plan: typeof rl.plan_type === 'string' ? rl.plan_type : '', observedAt: observedMs };
      }
    }
  }
  return null;
}

// Today's tokens for one account.
//
// `token_count` events repeat the same `last_token_usage` when a turn ends
// without new spend, so summing the deltas double-counts. `total_token_usage`
// is cumulative and monotonic within a rollout, which makes the honest measure
// "final total minus whatever the total already was at midnight" — correct for
// sessions that span midnight and immune to repeated events.
async function codexTokensForHome(home, startMs, byModel) {
  const dirs = await codexDateDirs(home, CODEX_TOKEN_DAYS);
  for (const dir of dirs) {
    for (const { file } of await codexRollouts(dir)) {
      let text;
      try {
        if ((await fs.promises.stat(file)).mtimeMs < startMs) continue;
        text = await fs.promises.readFile(file, 'utf8');
      } catch (_) { continue; }

      let model = '';
      let baseline = null;   // total as of the last event before midnight
      let latest = null;     // total as of the last event today
      let turns = 0;
      let prevTotal = null;

      for (const line of text.split('\n')) {
        if (line.indexOf('"turn_context"') === -1 && line.indexOf('"token_count"') === -1) continue;
        let o;
        try { o = JSON.parse(line); } catch (_) { continue; }
        const payload = o && o.payload;
        if (!payload) continue;
        // The rollout's line kind is on the envelope (`turn_context`,
        // `event_msg`); the event's own kind is on the payload.
        if (o.type === 'turn_context') {
          if (typeof payload.model === 'string' && payload.model) model = payload.model;
          continue;
        }
        if (payload.type !== 'token_count') continue;
        const total = payload.info && payload.info.total_token_usage;
        if (!total) continue;
        const ts = Date.parse(o.timestamp);
        if (isFinite(ts) && ts < startMs) { baseline = total; prevTotal = total.total_tokens || 0; continue; }
        if (prevTotal === null) prevTotal = baseline ? (baseline.total_tokens || 0) : 0;
        if ((total.total_tokens || 0) > prevTotal) {
          turns += 1;
          prevTotal = total.total_tokens || 0;
        }
        latest = total;
      }

      if (!latest) continue;
      const base = baseline || {};
      const delta = (field) => Math.max(0, (latest[field] || 0) - (base[field] || 0));
      const cacheRead = delta('cached_input_tokens');
      const m = bucket(byModel, model || 'unknown');
      m.messages += turns;
      // Codex counts cached tokens *inside* `input_tokens`; Claude reports them
      // separately. Subtract so both tables' "Input" column means fresh input.
      m.input += Math.max(0, delta('input_tokens') - cacheRead);
      m.output += delta('output_tokens');
      m.cacheRead += cacheRead;
      m.cacheCreate += delta('cache_write_input_tokens');
    }
  }
}

async function codexTokensToday(accounts) {
  const startMs = localMidnight();
  const byModel = {};
  const seenHomes = new Set();
  for (const acc of accounts) {
    const key = path.resolve(acc.home).toLowerCase();
    if (seenHomes.has(key)) continue; // two entries pointing at one home
    seenHomes.add(key);
    await codexTokensForHome(acc.home, startMs, byModel);
  }
  return { byModel };
}

// ---------------------------------------------------------------------------
// Per-agent snapshots
// ---------------------------------------------------------------------------

// The last limits the Claude endpoint actually returned, so a refused refresh
// degrades to a stale-but-labelled reading instead of an empty one.
let lastClaude = null; // { plan, limits, at }

async function claudeAgent() {
  const agent = {
    id: 'claude',
    label: 'Claude',
    live: true,
    unitLabel: 'Msgs',
    accounts: [],
    tokens: { byModel: {} },
    tokensError: null,
    note: 'Same windows as Claude Code\'s /usage — the session window covers rolling 5-hour blocks; weekly windows cap the whole week.',
  };

  const account = {
    id: 'claude',
    label: 'Claude Code',
    email: '',
    plan: '',
    limits: [],
    error: null,
    observedAt: null,
    observedNote: 'the last successful refresh',
  };
  try {
    const l = await fetchClaudeLimits();
    account.plan = prettyPlan(l.plan);
    account.limits = l.limits;
    if (!l.limits.length) account.error = 'No limit information reported for this account.';
    else lastClaude = { plan: account.plan, limits: l.limits, at: Date.now() };
  } catch (err) {
    account.error = errText(err);
    // A refused refresh (429, a dropped connection) is not the same as having no
    // numbers: keep showing the last reading, aged, exactly as the ChatGPT side
    // does. Blanking the bars would look like the limits had reset.
    if (lastClaude) {
      account.plan = lastClaude.plan;
      account.limits = lastClaude.limits;
      account.observedAt = lastClaude.at;
    }
  }
  agent.accounts.push(account);

  try {
    agent.tokens = await claudeTokensToday();
  } catch (err) {
    agent.tokensError = errText(err);
  }
  return agent;
}

async function codexAgent() {
  const agent = {
    id: 'codex',
    label: 'ChatGPT',
    live: false,
    unitLabel: 'Turns',
    accounts: [],
    tokens: { byModel: {} },
    tokensError: null,
    note: 'ChatGPT limits are the snapshot the Codex CLI last recorded, so they age until that account runs again.',
  };

  let accounts = [];
  try {
    accounts = codexAccounts();
  } catch (err) {
    agent.tokensError = errText(err);
    return agent;
  }

  for (const acc of accounts) {
    const entry = {
      id: acc.id,
      label: acc.label,
      email: acc.email,
      plan: prettyPlan(acc.plan),
      limits: [],
      error: null,
      observedAt: null,
      observedNote: 'the last time this account ran',
    };
    try {
      const found = await codexLimits(acc.home);
      if (found) {
        entry.limits = found.limits;
        entry.observedAt = found.observedAt;
        if (found.plan && !entry.plan) entry.plan = prettyPlan(found.plan);
      } else if (acc.signedIn === false) {
        entry.error = 'Not signed in — run `codex login` on a thread using this account.';
      } else {
        entry.error = 'No limits recorded yet — they appear once a ChatGPT thread on this account runs.';
      }
    } catch (err) {
      entry.error = errText(err);
    }
    agent.accounts.push(entry);
  }

  try {
    agent.tokens = await codexTokensToday(accounts);
  } catch (err) {
    agent.tokensError = errText(err);
  }
  return agent;
}

// ---------------------------------------------------------------------------
// Combined snapshot, cached briefly so the toolbar poll doesn't hammer the
// endpoint or re-scan transcripts on every tick. The modal's Refresh button
// passes `force` to bypass it.
// ---------------------------------------------------------------------------

const CACHE_MS = 30 * 1000;
let cache = null; // { at, data }

async function getUsage(options) {
  const force = !!(options && options.force);
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;

  // One agent's failure must never sink the other's numbers.
  const [claude, codex] = await Promise.all([
    claudeAgent().catch((err) => ({
      id: 'claude', label: 'Claude', live: true, unitLabel: 'Msgs',
      accounts: [{ id: 'claude', label: 'Claude Code', email: '', plan: '', limits: [], error: errText(err), observedAt: null }],
      tokens: { byModel: {} }, tokensError: null, note: '',
    })),
    codexAgent().catch((err) => ({
      id: 'codex', label: 'ChatGPT', live: false, unitLabel: 'Turns',
      accounts: [], tokens: { byModel: {} }, tokensError: errText(err), note: '',
    })),
  ]);

  const data = { ok: true, fetchedAt: Date.now(), agents: [claude, codex] };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { getUsage };
