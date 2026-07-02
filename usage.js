'use strict';

// Claude usage — how much of the subscription's rate limits are used and how
// many tokens today's work has consumed. Two sources, both local-first:
//
//  1. Plan limits: the same OAuth endpoint Claude Code's /usage screen calls,
//     authenticated with the token Claude Code keeps in ~/.claude/.credentials.json.
//     Returns percent-used + reset time for the 5-hour session window and the
//     weekly windows.
//  2. Token counts: Claude Code writes a JSONL transcript per conversation
//     under ~/.claude/projects/. Every assistant message carries a usage block
//     (input/output/cache tokens), so summing today's records gives per-model
//     token totals without any network call.

const fs = require('fs');
const path = require('path');
const os = require('os');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const claudeDir = () => path.join(os.homedir(), '.claude');

// ---------------------------------------------------------------------------
// Plan limits (OAuth endpoint)
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

async function fetchLimits() {
  const oauth = readOauth();
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: 'Bearer ' + oauth.accessToken,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (res.status === 401) {
    // Token rotated/expired — Claude Code refreshes it whenever it runs, so a
    // retry after using any thread usually clears this.
    throw new Error('Claude sign-in token expired — use any thread once (Claude Code refreshes it), then retry.');
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
  return { subscriptionType: oauth.subscriptionType || null, limits };
}

// ---------------------------------------------------------------------------
// Today's tokens (local transcripts)
// ---------------------------------------------------------------------------

// Sum the usage blocks of every assistant message written today (local time).
// Only transcript files touched today can contain today's records, so mtime
// prunes the scan cheaply. Records are deduped on message+request id because
// a message can be re-emitted into the same transcript (e.g. on resume).
function tokensToday() {
  const projectsDir = path.join(claudeDir(), 'projects');
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const startMs = dayStart.getTime();

  const byModel = {}; // model -> { messages, input, output, cacheRead, cacheCreate }
  const seen = new Set();

  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch (_) { return { byModel }; }

  for (const d of dirs) {
    const dir = path.join(projectsDir, d);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < startMs) continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
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
          const m = byModel[model] || (byModel[model] = {
            messages: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
          });
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
// Combined snapshot, cached briefly so the toolbar poll doesn't hammer the
// endpoint or re-scan transcripts on every tick.
// ---------------------------------------------------------------------------

const CACHE_MS = 30 * 1000;
let cache = null; // { at, data }

async function getUsage() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;

  const data = {
    ok: true,
    fetchedAt: Date.now(),
    subscriptionType: null,
    limits: [],
    limitsError: null,
    tokens: { byModel: {} },
    tokensError: null,
  };

  try {
    const l = await fetchLimits();
    data.subscriptionType = l.subscriptionType;
    data.limits = l.limits;
  } catch (err) {
    data.limitsError = (err && err.message) || String(err);
  }

  try {
    data.tokens = tokensToday();
  } catch (err) {
    data.tokensError = (err && err.message) || String(err);
  }

  cache = { at: Date.now(), data };
  return data;
}

module.exports = { getUsage };
