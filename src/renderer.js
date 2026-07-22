'use strict';

/* global Terminal, FitAddon */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let boards = [];                 // [{ id, name, dir, startupCommand }]
let activeBoardId = null;
const grids = new Map();         // boardId -> { el, columns: [ { el, flex, panes: [pane] } ] }
let idCounter = 1;
const nextId = (p) => `${p}-${Date.now().toString(36)}-${idCounter++}`;

// Claude Code session ids are UUIDs. Hivemind generates one per fresh thread
// (passed to claude as --session-id) so each pane's transcript file is known
// up front instead of guessed from timing — see spawnPanePty / transcript.js.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSessionId = (v) => typeof v === 'string' && SESSION_ID_RE.test(v);
function newSessionId() {
  try { return crypto.randomUUID(); } catch (_) { /* very old Chromium */ }
  const hex = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b, i) => {
      if (i === 6) b = (b & 0x0f) | 0x40; // version 4
      if (i === 8) b = (b & 0x3f) | 0x80; // variant
      return b.toString(16).padStart(2, '0');
    }).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Themes
//
// A theme colours both the app chrome (CSS custom properties on :root) and the
// xterm terminal palette. The registry below is the single source of truth;
// styles.css mirrors the default (Midnight) so the app is correctly coloured
// before this script runs. Switching themes updates the CSS variables live and
// re-applies the terminal colours to every open thread.
//
// `vars`  — CSS custom properties set on :root (matches the names in styles.css).
// `term`  — the xterm palette (background/foreground + 16 ANSI colours).
// ---------------------------------------------------------------------------
const THEMES = {
  midnight: {
    label: 'Midnight (deep blue-black, cyan)',
    vars: {
      '--bg': '#0b0e14', '--bg-alt': '#070a10', '--panel': '#04060a',
      '--surface': '#1b2333', '--text': '#c6d0e0', '--muted': '#64748b',
      '--accent': '#38bdf8', '--accent-2': '#34d399', '--border': '#1b2333',
      '--danger': '#f87171', '--peach': '#fb923c', '--yellow': '#fbbf24',
      '--on-accent': '#04060a',
    },
    term: {
      background: '#04060a', foreground: '#c6d0e0',
      cursor: '#38bdf8', selectionBackground: '#1e293b',
      black: '#1b2333', red: '#f87171', green: '#34d399', yellow: '#fbbf24',
      blue: '#38bdf8', magenta: '#c084fc', cyan: '#22d3ee', white: '#cbd5e1',
      brightBlack: '#475569', brightRed: '#fca5a5', brightGreen: '#6ee7b7',
      brightYellow: '#fcd34d', brightBlue: '#7dd3fc', brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9', brightWhite: '#f1f5f9',
    },
  },
  forest: {
    label: 'Forest (deep green, lime)',
    vars: {
      '--bg': '#0f1a14', '--bg-alt': '#0a130e', '--panel': '#050d08',
      '--surface': '#1d2f24', '--text': '#d3e0d5', '--muted': '#7d9585',
      '--accent': '#4ade80', '--accent-2': '#a3e635', '--border': '#1d2f24',
      '--danger': '#f87171', '--peach': '#fb923c', '--yellow': '#facc15',
      '--on-accent': '#050d08',
    },
    term: {
      background: '#050d08', foreground: '#d3e0d5',
      cursor: '#4ade80', selectionBackground: '#1f3327',
      black: '#1d2f24', red: '#ef6f6f', green: '#4ade80', yellow: '#facc15',
      blue: '#4d9de0', magenta: '#c58fd8', cyan: '#56c8b0', white: '#c9d6cc',
      brightBlack: '#4a6154', brightRed: '#fca5a5', brightGreen: '#86efac',
      brightYellow: '#fde047', brightBlue: '#7cc0f5', brightMagenta: '#d8b4fe',
      brightCyan: '#7ee0cc', brightWhite: '#e7efe9',
    },
  },
  ember: {
    label: 'Ember (warm charcoal, amber)',
    vars: {
      '--bg': '#1a1512', '--bg-alt': '#140f0c', '--panel': '#0d0907',
      '--surface': '#2c2420', '--text': '#ecdcc8', '--muted': '#a08a76',
      '--accent': '#f59e0b', '--accent-2': '#fb923c', '--border': '#2c2420',
      '--danger': '#ef4444', '--peach': '#fdba74', '--yellow': '#fcd34d',
      '--on-accent': '#0d0907',
    },
    term: {
      background: '#0d0907', foreground: '#ecdcc8',
      cursor: '#f59e0b', selectionBackground: '#3a2f27',
      black: '#2c2420', red: '#ef4444', green: '#a3b18a', yellow: '#fcd34d',
      blue: '#7ba7c9', magenta: '#c98fb0', cyan: '#6fbfae', white: '#d9c7b0',
      brightBlack: '#6e5c4c', brightRed: '#f87171', brightGreen: '#c3d1a8',
      brightYellow: '#fde68a', brightBlue: '#9cc0dc', brightMagenta: '#e0abc8',
      brightCyan: '#94d6c6', brightWhite: '#f5ead6',
    },
  },
  grape: {
    label: 'Grape (purple, magenta)',
    vars: {
      '--bg': '#231a33', '--bg-alt': '#1c1429', '--panel': '#140d1e',
      '--surface': '#382a4d', '--text': '#e9def5', '--muted': '#9d8bb8',
      '--accent': '#c084fc', '--accent-2': '#f472b6', '--border': '#382a4d',
      '--danger': '#fb7185', '--peach': '#fbbf24', '--yellow': '#fde047',
      '--on-accent': '#140d1e',
    },
    term: {
      background: '#140d1e', foreground: '#e9def5',
      cursor: '#c084fc', selectionBackground: '#3f2f57',
      black: '#382a4d', red: '#fb7185', green: '#7ee787', yellow: '#fde047',
      blue: '#818cf8', magenta: '#e879f9', cyan: '#67e8f9', white: '#d8c9ec',
      brightBlack: '#6d5a8a', brightRed: '#fda4af', brightGreen: '#a6f0ad',
      brightYellow: '#fef08a', brightBlue: '#a5b4fc', brightMagenta: '#f0abfc',
      brightCyan: '#a5f3fc', brightWhite: '#f3edfb',
    },
  },
  paper: {
    label: 'Paper (light, indigo)',
    vars: {
      '--bg': '#faf9f6', '--bg-alt': '#f1efe9', '--panel': '#eae7df',
      '--surface': '#ded9cd', '--text': '#3a3733', '--muted': '#6f6a60',
      '--accent': '#4f46e5', '--accent-2': '#059669', '--border': '#d6d1c4',
      '--danger': '#dc2626', '--peach': '#ea580c', '--yellow': '#ca8a04',
      '--on-accent': '#faf9f6',
    },
    term: {
      background: '#eae7df', foreground: '#3a3733',
      cursor: '#4f46e5', selectionBackground: '#d6d1c4',
      black: '#57534e', red: '#dc2626', green: '#059669', yellow: '#ca8a04',
      blue: '#4f46e5', magenta: '#c026d3', cyan: '#0891b2', white: '#a8a29e',
      brightBlack: '#78716c', brightRed: '#ef4444', brightGreen: '#10b981',
      brightYellow: '#eab308', brightBlue: '#6366f1', brightMagenta: '#d946ef',
      brightCyan: '#06b6d4', brightWhite: '#292524',
    },
  },
  rose: {
    label: 'Rose (warm cream, rose)',
    vars: {
      '--bg': '#faf4ed', '--bg-alt': '#f3ece2', '--panel': '#efe6da',
      '--surface': '#e4d8cc', '--text': '#575279', '--muted': '#8c839c',
      '--accent': '#d7827e', '--accent-2': '#56949f', '--border': '#dfd6ca',
      '--danger': '#b4637a', '--peach': '#ea9d34', '--yellow': '#ea9d34',
      '--on-accent': '#faf4ed',
    },
    term: {
      background: '#efe6da', foreground: '#575279',
      cursor: '#d7827e', selectionBackground: '#dfd6ca',
      black: '#797593', red: '#b4637a', green: '#56949f', yellow: '#ea9d34',
      blue: '#286983', magenta: '#907aa9', cyan: '#d7827e', white: '#575279',
      brightBlack: '#9893a5', brightRed: '#c96a83', brightGreen: '#63a3ae',
      brightYellow: '#f0ac48', brightBlue: '#356e8a', brightMagenta: '#a086bb',
      brightCyan: '#e0918d', brightWhite: '#4a4568',
    },
  },
};
const DEFAULT_THEME = 'midnight';
const isValidTheme = (t) => Object.prototype.hasOwnProperty.call(THEMES, t);

let currentTheme = localStorage.getItem('hm.theme');
if (!isValidTheme(currentTheme)) currentTheme = DEFAULT_THEME;

// xterm theme — mutated in place by applyTheme so freshly-created terminals
// read the current palette from it (new Terminal({ theme: THEME })).
const THEME = { ...THEMES[DEFAULT_THEME].term };

// Apply a theme: repaint the app chrome (CSS vars) and every open terminal.
function applyTheme(id, { persist = true } = {}) {
  if (!isValidTheme(id)) id = DEFAULT_THEME;
  currentTheme = id;
  const t = THEMES[id];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  Object.assign(THEME, t.term);
  for (const g of grids.values())
    for (const col of g.columns)
      for (const pane of col.panes)
        if (!pane.disposed) pane.term.options.theme = { ...THEME };
  if (persist) localStorage.setItem('hm.theme', id);
}

// Paint the persisted theme immediately, before any terminals are created.
applyTheme(currentTheme, { persist: false });

// ---------------------------------------------------------------------------
// Per-thread font sizing
//
// Each thread keeps its own font size, but the last size chosen is remembered
// as the default for any new thread you open (persisted across sessions).
// ---------------------------------------------------------------------------
const FONT_MIN = 8;
const FONT_MAX = 32;
const FONT_DEFAULT = 13;
const clampFont = (n) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));

let defaultFontSize = clampFont(parseInt(localStorage.getItem('hm.fontSize'), 10) || FONT_DEFAULT);

function setPaneFontSize(pane, size) {
  if (pane.disposed) return;
  const n = clampFont(size);
  if (pane.fontSize === n) return;
  pane.fontSize = n;
  pane.term.options.fontSize = n;
  // The chat view scales off this variable (see .chat-* rules in styles.css).
  pane.el.style.setProperty('--pane-font', n + 'px');
  defaultFontSize = n;
  localStorage.setItem('hm.fontSize', String(n));
  try {
    pane.fitAddon.fit();
    window.api.resizePty(pane.id, pane.term.cols, pane.term.rows);
  } catch (_) { /* terminal not ready */ }
}

// ---------------------------------------------------------------------------
// Per-thread Claude model
//
// Each thread can run a different Claude model. The choice is passed to Claude
// Code two ways: as `--model <alias>` when the thread first starts, and — when
// you switch a running thread — by typing the `/model <alias>` slash command
// into it so it changes mid-session. The last model chosen is remembered as the
// default for new threads (persisted across sessions).
// ---------------------------------------------------------------------------
const MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
const isValidModel = (m) => MODELS.some((x) => x.value === m);

let defaultModel = localStorage.getItem('hm.model') || 'default';
if (!isValidModel(defaultModel)) defaultModel = 'default';

// ---------------------------------------------------------------------------
// Claude API list prices, $ per million tokens, matched against the full model
// id from the transcript (e.g. "claude-opus-4-8") — first match wins. Cache
// rates derive from the input rate: reads 0.1×, 5-minute cache writes 1.25×,
// 1-hour writes 2×. Used only for the header cost-estimate chip.
// ---------------------------------------------------------------------------
const MODEL_PRICES = [
  { re: /fable|mythos/i, input: 10, output: 50 },
  { re: /opus-4-1|opus-4-2025/i, input: 15, output: 75 }, // legacy Opus 4.0/4.1
  { re: /opus/i, input: 5, output: 25 },
  { re: /haiku/i, input: 1, output: 5 },
  { re: /sonnet/i, input: 3, output: 15 },
];
const FALLBACK_PRICE = { input: 3, output: 15 };
const priceForModel = (model) =>
  (MODEL_PRICES.find((p) => p.re.test(model || '')) || FALLBACK_PRICE);

// ---------------------------------------------------------------------------
// Per-thread ChatGPT (Codex) model
//
// ChatGPT threads get their own model dropdown, mirroring the Claude one. The
// choice reaches the Codex CLI as `--model <id>` at startup. Codex has no
// inline slash command to switch models mid-session (its /model opens an
// interactive picker), so changing a running thread restarts it. The last
// choice is remembered as the default for new ChatGPT threads.
// ---------------------------------------------------------------------------
const CODEX_MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.3-codex-spark', label: 'Codex Spark' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
];
const isValidCodexModel = (m) => CODEX_MODELS.some((x) => x.value === m);

let defaultCodexModel = localStorage.getItem('hm.codexModel') || 'default';
if (!isValidCodexModel(defaultCodexModel)) defaultCodexModel = 'default';

// ---------------------------------------------------------------------------
// Per-thread permission mode
//
// Each thread can start Claude Code in a different permission mode, handed to
// the CLI as a startup flag (see main.js). Claude Code has no slash command to
// change mode mid-session, so switching a running thread restarts it (resuming
// the conversation when one exists). The last choice is remembered as the
// default for new threads.
// ---------------------------------------------------------------------------
const PERMS = [
  { value: 'default',     label: 'Default' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'plan',        label: 'Plan' },
  { value: 'bypass',      label: 'Bypass ⚠' },
];
const isValidPerm = (p) => PERMS.some((x) => x.value === p);

let defaultPerm = localStorage.getItem('hm.perm') || 'default';
if (!isValidPerm(defaultPerm)) defaultPerm = 'default';

// ---------------------------------------------------------------------------
// Per-thread agent
//
// Each thread can run a different coding agent CLI: Claude Code (the default),
// OpenAI's Codex CLI ("ChatGPT"), or Google's Gemini CLI — so one hive can mix
// e.g. three Claude threads and one ChatGPT thread. A Claude thread keeps the
// hive's custom startup command (extra flags etc.); other agents run their own
// command. Switching a live thread kills its process and starts the new agent
// in the same pane. Claude and ChatGPT threads each show their own model
// dropdown; Gemini threads show none.
// ---------------------------------------------------------------------------
const AGENTS = [
  { value: 'claude', label: 'Claude',  command: 'claude', install: null },
  { value: 'codex',  label: 'ChatGPT', command: 'codex',  install: 'npm install -g @openai/codex' },
  { value: 'gemini', label: 'Gemini',  command: 'gemini', install: 'npm install -g @google/gemini-cli' },
];
const isValidAgent = (a) => AGENTS.some((x) => x.value === a);
const agentFor = (v) => AGENTS.find((x) => x.value === v) || AGENTS[0];

// The command a pane's PTY should auto-run. Claude threads honour the hive's
// custom startup command; other agents always run their own CLI.
function paneCommand(pane) {
  return pane.agent === 'claude'
    ? (pane.board.startupCommand || 'claude')
    : agentFor(pane.agent).command;
}

function setPaneAgent(pane, agent) {
  if (pane.disposed) return;
  if (!isValidAgent(agent)) agent = 'claude';
  if (pane.agent === agent) return;
  pane.agent = agent;
  if (pane.agentSelect && pane.agentSelect.value !== agent) pane.agentSelect.value = agent;
  // The Claude model / permission dropdowns mean nothing to other agents — hide
  // them there. ChatGPT threads get their own model dropdown instead.
  if (pane.modelSelect) pane.modelSelect.style.display = agent === 'claude' ? '' : 'none';
  if (pane.codexModelSelect) pane.codexModelSelect.style.display = agent === 'codex' ? '' : 'none';
  if (pane.permSelect) pane.permSelect.style.display = agent === 'claude' ? '' : 'none';
  // Claude and ChatGPT are transcript-backed; Gemini stays terminal-only.
  updateChatAvailability(pane);
  // The cost estimate only applies to Claude conversations, and switching
  // agents starts a new one anyway — drop the accumulator and hide the chip.
  pane.costFile = null;
  resetPaneCost(pane);
  // Auto names track the running command ("codex 2"); manual names stay put.
  if (pane.autoName) {
    const num = (/(\d+)\s*$/.exec(pane.name || '') || [])[1];
    pane.name = agentFor(agent).command + (num ? ' ' + num : '');
    pane.title.textContent = pane.name;
  }
  respawnPane(pane);
}

// Kill a pane's process and start its (possibly new) agent in the same pane.
// The pane gets a fresh PTY id so late data/exit events from the old process
// can't reach it. Pass { resume: true } to continue the thread's conversation
// (e.g. when only a startup flag changed, not the whole agent), or a session-id
// string to resume that specific past conversation. An initialPrompt rides
// along as claude's CLI argument (see spawnPty).
function respawnPane(pane, { resume, initialPrompt } = {}) {
  window.api.killPty(pane.id);
  window.api.transcript.unbind(pane.id); // release before the id changes
  pane.id = nextId('term');
  clearTimeout(pane.idleTimer);
  stopAttentionProbe(pane);
  pane.state = null;
  pane.buf = '';
  pane.errored = false;
  pane.errorText = '';
  pane.hintShown = false;
  try { pane.term.reset(); } catch (_) { /* ignore */ }
  // The new process starts a fresh live session — drop any history view so
  // the rebuilt chat tails it (chatIngest is suppressed while viewingHistory).
  if (pane.chat && pane.chat.viewingHistory) {
    pane.chat.viewingHistory = false;
    pane.chat.historySession = null;
    updateHistoryChrome(pane, null);
  }
  resetChat(pane); // the new session's transcript backfills the chat view
  updateChatBanner(pane); // drop a composer lock left by a pre-respawn attention state
  spawnPanePty(pane, { resume: resume || false, initialPrompt });
}

function setPaneModel(pane, model) {
  if (pane.disposed) return;
  if (!isValidModel(model)) model = 'default';
  pane.model = model;
  defaultModel = model;
  localStorage.setItem('hm.model', model);
  if (pane.modelSelect && pane.modelSelect.value !== model) pane.modelSelect.value = model;
  // Switch a running thread live by driving Claude Code's /model command.
  if (pane.agent === 'claude' && pane.state !== 'dead') {
    window.api.writePty(pane.id, `/model ${model}\r`);
    markActivity(pane, '');
  }
}

function setPaneCodexModel(pane, model) {
  if (pane.disposed) return;
  if (!isValidCodexModel(model)) model = 'default';
  const changed = pane.codexModel !== model;
  pane.codexModel = model;
  defaultCodexModel = model;
  localStorage.setItem('hm.codexModel', model);
  if (pane.codexModelSelect && pane.codexModelSelect.value !== model) pane.codexModelSelect.value = model;
  // Codex only reads its model at startup (its /model slash command opens an
  // interactive picker we can't drive), so apply a change to a running ChatGPT
  // thread by restarting it. Codex rollouts aren't resumable here (see
  // rebuildFromLayout), so the restart begins a fresh conversation.
  if (changed && pane.agent === 'codex' && pane.state !== 'dead') respawnPane(pane);
}

// Highlight the permission dropdown when it's in a risky mode (bypass), so the
// thread's mode is obvious at a glance instead of buried in Claude's TUI.
function paintPermSelect(pane) {
  if (pane.permSelect) pane.permSelect.classList.toggle('perm-bypass', pane.permMode === 'bypass');
}

function setPanePerm(pane, mode) {
  if (pane.disposed) return;
  if (!isValidPerm(mode)) mode = 'default';
  const changed = pane.permMode !== mode;
  pane.permMode = mode;
  defaultPerm = mode;
  localStorage.setItem('hm.perm', mode);
  if (pane.permSelect && pane.permSelect.value !== mode) pane.permSelect.value = mode;
  paintPermSelect(pane);
  // Permission mode is a startup flag with no live slash-command equivalent, so
  // apply a change to a running Claude thread by restarting it. Resume this
  // pane's own session (`--resume <id>`) so a mid-session mode switch doesn't
  // throw the work away — and doesn't `--continue` into another thread's more
  // recent conversation. Resume only once the session file provably exists
  // (sessionBound): fresh threads pre-generate their id for --session-id, but
  // claude doesn't create the conversation until the first message, so
  // `--resume` on an unused thread dies with "No conversation found" and
  // strands the pane in the bare shell. A used thread that never bound (has a
  // caption) falls back to --continue; a fresh, unused thread restarts clean.
  if (changed && pane.agent === 'claude' && pane.state !== 'dead') {
    respawnPane(pane, { resume: (pane.sessionBound && pane.sessionId) || !!pane.captionText });
  }
}

// ---------------------------------------------------------------------------
// Terminal status detection
//
// The agent CLIs render an animated spinner while they work, so the PTY emits
// a steady stream of output during a turn: output flowing => busy; output
// gone quiet => the turn is done or the CLI is waiting for you. Quiet panes
// are told apart by scanning the *visible screen* for prompt patterns —
// "needs your input" (attention) vs "finished" (idle). Blocking menus can't
// wait for quiet, though: codex keeps animating its status line under an
// approval modal, so busy panes are also probed on a timer for on-screen
// menu prompts (probeAttention).
// ---------------------------------------------------------------------------
const IDLE_MS = 1000; // quiet period before a terminal is no longer "busy"

const STATE_LABEL = {
  busy: 'working…',
  attention: 'needs you',
  error: 'error',
  idle: 'ready',
  dead: 'exited',
};

// Interactive menu prompts a CLI is blocked on — Claude Code's permission
// menus ("❯ 1. Yes") and the Codex CLI's approval modals. These are TUI
// chrome, not prose, so they're safe to match even while output is still
// flowing. That matters: codex keeps animating its status line while an
// approval modal waits, so "output gone quiet" never happens there — these
// are probed on a timer against the visible screen instead (probeAttention).
// Claude Code select-menu footer (AskUserQuestion, permission menus). The
// options carry arbitrary labels, so this chrome line is the only
// label-independent signature the screen offers. Also drives the screen-parsed
// question card (parseScreenQuestion).
const SELECT_FOOTER_RE =
  /\bEnter to (select|submit|confirm)\b[^\n]{0,120}\bEsc to (cancel|close|go back|exit|skip)/i;

// The Submit tab of a multi-select AskUserQuestion ("Review your answers" over
// "1. Submit answers / 2. Cancel") draws NO footer chrome at all (verified
// v2.1.201) — this prompt line is its only stable signature.
const REVIEW_PROMPT_RE = /Ready to submit your answers\?/i;

const MENU_PATTERNS = [
  /[❯›]\s*1\.\s*Yes/i,                        // selection caret on a Yes option
  /\b1\.\s*Yes\b[\s\S]{0,160}\b2\.\s*No\b/i,  // numbered Yes/No menu
  /Yes, and don'?t ask again/i,               // codex approval options
  /No, and (tell Codex what to do differently|continue without running)/i,
  /Allow Codex to [^\n]{0,200}\?/,            // codex approval headers
  /Codex wants to (edit|run|use)/i,
  /Would you like to (run the following command|grant these permissions|make this edit)/i,
  SELECT_FOOTER_RE,
  REVIEW_PROMPT_RE,
];

// Prose questions that mean a *finished* turn is waiting on an answer. Only
// checked once output has gone quiet — mid-turn they'd be ordinary sentences
// streaming past in the agent's reply.
const QUESTION_PATTERNS = [
  /Do you want to (proceed|create|make|run|allow|continue|trust)/i,
  /Would you like to/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /press\s+enter\s+to\s+continue/i,
  /Continue\?\s*$/im,
];

// Patterns that mean a thread hit a wall and won't make progress on its own —
// API/usage errors that otherwise read as "ready" and never pull you back.
const ERROR_PATTERNS = [
  // "rate limit" alone is too loose — codex shows an "Approaching rate limits"
  // reminder menu on healthy threads.
  /usage limit reached|(hit|reached) your (usage|daily|rate) limit/i,
  /rate limit (reached|exceeded|hit)|rate_limit_error/i,
  /not supported when using Codex/i,
  /\b(overloaded_error|api_error|authentication_error|invalid_request_error)\b/i,
  /\b5\d\d\s+(Internal Server Error|Service Unavailable|Bad Gateway)\b/i,
  /Request timed out|ECONNRESET|ETIMEDOUT|fetch failed/i,
  /\b(401|403)\b[^\n]{0,40}(unauthorized|forbidden|invalid api key)/i,
];

// The shell couldn't launch the startup command — usually `claude` isn't on PATH.
const CMD_MISSING_PATTERNS = [
  /is not recognized as (an internal or external command|the name of a cmdlet)/i,
  /command not found/i,
  /CommandNotFoundException/i,
];

// Strip ANSI escape / OSC sequences so the pattern scan sees plain text.
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\x1B\][^\x07]*(?:\x07|\x1B\\)/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

let notifyMuted = localStorage.getItem('hm.muteNotifications') === '1';

// The visible terminal screen (the live bottom page of xterm's buffer).
// Prompt detection reads this rather than the raw output stream: a menu that
// is on screen is genuinely waiting, and an answered one vanishes from the
// screen immediately — no stale matches lingering in an append buffer.
function screenText(pane) {
  try {
    const b = pane.term.buffer.active;
    const lines = [];
    for (let y = b.baseY; y < b.baseY + pane.term.rows; y++) {
      const line = b.getLine(y);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  } catch (_) {
    return pane.buf || ''; // terminal not ready — fall back to the stream tail
  }
}

// The TUI hard-wraps at pane width, so a menu signature (the select-menu
// footer, an approval header) can split across two screen rows and defeat a
// single-line regex. Give pattern scans a second view of the screen with each
// adjacent pair of rows glued back together — one wrap point anywhere can't
// hide a match. (Same idea as the wrap-joined error scan in evaluateIdle,
// applied to the live screen.)
function joinWrapped(lines) {
  const out = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i].trim(), b = lines[i + 1].trim();
    if (a && b) out.push(a + ' ' + b);
  }
  return out.join('\n');
}

// MENU_PATTERNS against the screen, tolerating one hard wrap per signature.
function menuOnScreen(screen) {
  return MENU_PATTERNS.some((re) => re.test(screen)) ||
    MENU_PATTERNS.some((re) => re.test(joinWrapped(screen.split('\n'))));
}

// "Something on screen is waiting for the user" — a blocking menu or a
// finished-turn prose question.
function promptVisibleOnScreen(screen) {
  return menuOnScreen(screen) || QUESTION_PATTERNS.some((re) => re.test(screen));
}

const PROBE_MS = 700; // how often a busy pane's screen is checked for a menu

// The transcript knows about one kind of prompt the screen scan can't be
// trusted on: an AskUserQuestion tool call whose result hasn't landed yet —
// the agent is blocked on the user picking an option. The chat view tracks
// those deterministically (addQuestionRow / attachToolResult); while browsing
// history the live question isn't on screen, so it doesn't count.
function chatHasPendingQuestion(pane) {
  const c = pane.chat;
  return !!(c && !c.viewingHistory && c.pendingQuestions.size);
}

// pendingQuestions normally clears within one transcript batch: the CLI only
// flushes an AskUserQuestion once it's answered, so the tool_use and its
// tool_result arrive together (attachToolResult deletes the entry). If a
// result never lands — interrupted turn, truncated JSONL, future flush-
// behavior drift — the stale entry would pin 'attention' and the composer
// lock forever with nothing on screen to answer. So: whenever the pane is
// judged with no prompt visible, age transcript entries out after a grace
// period (screen-parsed 'screenq:' entries are already lifecycle-managed by
// syncScreenQuestion and excluded here).
const QUESTION_EXPIRE_MS = 5000;
const strandedQuestionIds = (c) =>
  [...c.pendingQuestions.keys()].filter((k) => k.indexOf('screenq:') !== 0);
function syncQuestionExpiry(pane, promptVisible) {
  const c = pane.chat;
  if (promptVisible || !c || !strandedQuestionIds(c).length) {
    clearTimeout(pane.qExpireTimer);
    pane.qExpireTimer = null;
    return;
  }
  if (pane.qExpireTimer) return;
  pane.qExpireTimer = setTimeout(() => {
    pane.qExpireTimer = null;
    const cc = pane.chat;
    if (pane.disposed || !cc || cc.viewingHistory) return;
    if (promptVisibleOnScreen(screenText(pane))) return; // it showed up after all
    for (const k of strandedQuestionIds(cc)) {
      cc.pendingQuestions.delete(k);
      const row = cc.byKey.get(cc.toolByUseId.get(k));
      const card = row && row.querySelector('.chat-question');
      if (card && !card.classList.contains('answered')) {
        card.classList.add('answered');
        const ans = card.querySelector('.chat-question-answer');
        if (ans) { ans.textContent = '(answered in the terminal)'; ans.classList.remove('hidden'); }
      }
    }
    updateChatBanner(pane);
    if (pane.state === 'attention') evaluateIdle(pane); // drop the pinned attention
  }, QUESTION_EXPIRE_MS);
}

// A *pending* AskUserQuestion never reaches the transcript: Claude Code only
// flushes the assistant message (its text and the tool_use) once the tool
// resolves — i.e. after the user has already answered in the TUI (verified
// against v2.1.201). So while the question waits — the only window the card
// matters — the visible screen is the sole signal, exactly like codex
// approvals. These helpers parse the select menu off the screen and render it
// as a synthetic question card (addQuestionRow) so the chat view can show and
// answer the prompt live. Once answered, the menu leaves the screen (the
// probe removes the stand-in) and the real transcript entries land, rendering
// the permanent answered card.
// Multi-select menus draw a checkbox on each option — before or after the
// number depending on the menu, and Windows terminals render the check mark
// as √ (the figures-package fallback for ✓). Its presence is the reliable
// multi-select signal; footer wording varies between Claude Code versions.
// Since v2.1.20x the multi-select flow is two screens: on the question tab
// digits toggle and Enter only toggles the highlighted option — Tab moves to
// the Submit tab, a review screen ("Ready to submit your answers?" over
// "1. Submit answers / 2. Cancel") with no footer chrome, where digits act
// immediately (1 submits, 2 declines). Single-select menus still answer
// straight off a digit press. All verified against v2.1.201.
const SCREEN_OPT_RE = /^\s*(?:[❯›>]\s+)?(\[[ x✓✔√]\]\s*|[◻◼☐☑]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
const SCREEN_CHECK_RE = /^(\[[ x✓✔√]\]|[◻◼☐☑])\s*/;
const SCREEN_CHECKED_RE = /[x✓✔√◼☑]/;
const SCREEN_SEP_RE = /^[\s─—–-]*$/;
const SCREEN_CHIP_RE = /^\[[^\]]{0,3}\]\s*(\S.{0,40})$/;

// Menus can render inside a bordered box (the plan dialog does; permission
// dialogs have in past versions) — shed │/┃ border chrome so the ^-anchored
// row regexes still see the content.
const stripBoxChrome = (l) => l.replace(/^\s*[│┃]/, '').replace(/[│┃]\s*$/, '');
// Wrap-tolerant row test: the row itself, or the row glued to the next one
// (the TUI hard-wraps at pane width).
const testWrapped = (re, lines, i) =>
  re.test(lines[i]) ||
  (i + 1 < lines.length && re.test(lines[i].trim() + ' ' + lines[i + 1].trim()));

function parseScreenQuestion(screen) {
  const lines = screen.split('\n').map(stripBoxChrome);
  let foot = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (testWrapped(SELECT_FOOTER_RE, lines, i)) { foot = i; break; }
  }
  if (foot < 0) return parseScreenReview(lines);
  // The options block: the "1." line closest above the footer, then numbered
  // lines counting up. Unnumbered lines under an option are its description
  // (or a wrapped label — indistinguishable, and cosmetically equivalent).
  let start = -1;
  for (let i = foot - 1; i >= 0; i--) {
    const m = SCREEN_OPT_RE.exec(lines[i]);
    if (m && m[2] === '1') { start = i; break; }
  }
  if (start < 0) return null;
  const options = [];
  let hasCheckbox = false;
  for (let i = start; i < foot; i++) {
    if (SCREEN_SEP_RE.test(lines[i])) continue;
    const m = SCREEN_OPT_RE.exec(lines[i]);
    if (m && Number(m[2]) === options.length + 1) {
      let label = m[3].trim();
      let box = m[1] || '';
      const cm = SCREEN_CHECK_RE.exec(label);
      if (cm) {
        box = cm[1];
        label = label.slice(cm[0].length).trim();
      }
      if (box) hasCheckbox = true;
      options.push({ label, description: '', checked: SCREEN_CHECKED_RE.test(box) });
    } else if (m && Number(m[2]) > options.length + 1) {
      // A numbered row out of sequence means the "1." anchored on wasn't this
      // menu's first option (prose above a partly scrolled menu) — better no
      // card than one whose digits actuate unseen rows.
      return null;
    } else if (options.length) {
      const t = lines[i].trim();
      // The focusable "Submit" row under the last option is menu chrome, not
      // an option description.
      if (/^Submit$/.test(t)) continue;
      const o = options[options.length - 1];
      o.description = (o.description ? o.description + ' ' : '') + t;
    }
  }
  if (options.length < 2) return null;
  // The question: the contiguous text block directly above the options. A
  // leading "[ ] Header" chip line is the header tab, not question prose.
  let end = start - 1;
  while (end >= 0 && SCREEN_SEP_RE.test(lines[end])) end--;
  let qStart = end;
  while (qStart >= 0 && !SCREEN_SEP_RE.test(lines[qStart]) && !SCREEN_OPT_RE.test(lines[qStart])) qStart--;
  qStart++;
  if (qStart > end) return null;
  let header = '';
  const chip = SCREEN_CHIP_RE.exec(lines[qStart].trim());
  if (chip && qStart < end) {
    header = chip[1].trim();
    qStart++;
  }
  const question = lines.slice(qStart, end + 1).map((s) => s.trim()).join(' ').trim();
  if (!question) return null;
  return {
    header,
    question,
    options,
    multiSelect: hasCheckbox || /space to (toggle|select)/i.test(lines[foot]),
  };
}

// The footerless review screen (see REVIEW_PROMPT_RE): options sit *below*
// the anchor prompt, and the chosen answers sit above it under a "Review your
// answers" heading — carried into the card so the user sees what they're
// confirming. Digits act immediately here, so the ordinary click-sends-digit
// card works unchanged.
function parseScreenReview(lines) {
  let a = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (REVIEW_PROMPT_RE.test(lines[i])) { a = i; break; }
  }
  if (a < 0) return null;
  const options = [];
  for (let i = a + 1; i < lines.length; i++) {
    if (SCREEN_SEP_RE.test(lines[i])) {
      if (options.length) break;
      continue;
    }
    const m = SCREEN_OPT_RE.exec(lines[i]);
    if (m && Number(m[2]) === options.length + 1) {
      options.push({ label: m[3].trim(), description: '', checked: false });
    } else break;
  }
  if (options.length < 2) return null;
  let head = -1;
  for (let i = a - 1; i >= 0; i--) {
    if (/^\s*Review your answers\s*$/i.test(lines[i])) { head = i; break; }
  }
  const summary = head < 0 ? '' : lines.slice(head + 1, a)
    .map((s) => s.replace(/^[\s●•·]+/, '').trim())
    .filter(Boolean)
    .join(' ');
  return {
    header: 'Review',
    question: (summary ? summary + ' — ' : '') + lines[a].trim(),
    options,
    multiSelect: false,
  };
}

// The "Ready to code?" plan-approval menu gets the same card treatment as a
// question: it draws none of the footer chrome parseScreenQuestion anchors on,
// so it's recognised by its option labels instead (parsePlanMenu, defined with
// the plan-review code below). Digits act immediately in that menu — the same
// keys the plan review's Approve buttons send — so the ordinary
// click-sends-digit card works unchanged.
function parsePlanScreenQuestion(pane, screen) {
  if (pane.agent !== 'claude') return null;
  const options = parsePlanMenu(screen);
  if (!options) return null;
  return {
    header: 'Plan',
    question: /Ready to code\?/i.test(screen) ? 'Ready to code?'
      : /Would you like to proceed\?/i.test(screen)
        ? 'Claude has written up a plan and is ready to execute. Would you like to proceed?'
        : 'Approve this plan?',
    options: options.map((o) => ({ label: o.label, description: '', checked: false })),
    multiSelect: false,
    // The plan itself, rendered on the card so the terminal view isn't needed
    // to read what's being approved. Served from a cache — the file read is
    // async and re-syncs this card when the content lands (planCardText).
    planMd: planCardText(pane),
    planReview: true,
  };
}

// Codex approval modals (run command / make edits / grant permissions /
// network access) draw a "Press enter to confirm or esc to cancel" footer that
// SELECT_FOOTER_RE happens to match — but the generic parser keeps only the
// text block directly above the options as the question, dropping the header
// line that says what's being approved (and the Reason:/command lines between
// them). Parse the whole modal instead so a ChatGPT approval card reads like a
// Claude permission card: header + context as the question, numbered options
// with their trailing "(y)"-style key hints stripped (cards click, they don't
// type). Codex list menus select-and-confirm on a digit press, so the ordinary
// click-sends-digit card works unchanged. Layout verified against the
// codex-rs 0.144.4 TUI snapshot tests.
const CODEX_APPROVAL_HEAD_RE =
  /^(?:Would you like to (?:run the following command|grant these permissions|make the following edits)\?|Do you want to approve network access to .{0,120}\?|Allow Codex to .{0,160}\?)$/;
const CODEX_KEYHINT_RE = /\s*\((?:[a-z]\+)?[a-z]{1,5}\)$/i;

function parseCodexApproval(pane, screen) {
  if (pane.agent !== 'codex') return null;
  const lines = screen.split('\n').map(stripBoxChrome);
  let foot = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (testWrapped(SELECT_FOOTER_RE, lines, i)) { foot = i; break; }
  }
  if (foot < 0) return null;
  // The header can hard-wrap too (a long command inside "Allow Codex to run
  // …?") — accept a two-row match and treat its second row as consumed.
  let head = -1, headText = '';
  for (let i = foot - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (CODEX_APPROVAL_HEAD_RE.test(t)) { head = i; headText = t; break; }
    const pair = i + 1 < foot ? t + ' ' + lines[i + 1].trim() : '';
    if (pair && CODEX_APPROVAL_HEAD_RE.test(pair)) { head = i + 1; headText = pair; break; }
  }
  if (head < 0) return null;
  // Anchor the options on the "1." row closest above the footer — same
  // defence as parseScreenQuestion. A top-down scan would let a numbered list
  // in the detail block (a diff adding "1. Install deps") become the clickable
  // options while the digits still fire the real approval.
  let start = -1;
  for (let i = foot - 1; i > head; i--) {
    const m = SCREEN_OPT_RE.exec(lines[i]);
    if (m && m[2] === '1') { start = i; break; }
  }
  if (start < 0) return null;
  const detail = []; // Reason: / Permission rule: / $ command … between header and options
  for (let i = head + 1; i < start && detail.length < 8; i++) {
    const t = lines[i].trim();
    if (t && !SCREEN_SEP_RE.test(lines[i])) detail.push(t);
  }
  const options = [];
  for (let i = start; i < foot; i++) {
    const t = lines[i].trim();
    const m = SCREEN_OPT_RE.exec(lines[i]);
    if (m && Number(m[2]) === options.length + 1) {
      options.push({ label: m[3].trim().replace(CODEX_KEYHINT_RE, ''), description: '', checked: false });
    } else if (!t || SCREEN_SEP_RE.test(lines[i])) {
      continue;
    } else if (m && Number(m[2]) > options.length + 1) {
      return null; // out-of-sequence number — mis-anchored, don't guess
    } else if (options.length) {
      // A wrapped option label — cosmetically a description, same treatment
      // as parseScreenQuestion.
      const o = options[options.length - 1];
      o.description = (o.description ? o.description + ' ' : '') + t.replace(CODEX_KEYHINT_RE, '');
    }
  }
  if (options.length < 2) return null;
  return {
    header: 'Approval',
    question: [headText, ...detail].join('\n'),
    options,
    multiSelect: false,
  };
}

const screenQuestionKey = (pane) => 'screenq:' + pane.id;

function syncScreenQuestion(pane, screen) {
  const c = pane.chat;
  if (!c) return;
  const s = screen !== undefined ? screen : screenText(pane);
  const parsed = !c.viewingHistory && pane.state !== 'dead'
    ? parseCodexApproval(pane, s) || parseScreenQuestion(s) || parsePlanScreenQuestion(pane, s)
    : null;
  if (!parsed) {
    removeScreenQuestion(pane);
    return;
  }
  // Re-parsed every probe tick; only touch the DOM when the content changed
  // (a re-render would drop the clicked-option echo mid-interaction).
  const key = screenQuestionKey(pane);
  const sig = safeJson(parsed);
  // A transcript tool_use just superseded this exact menu — the answered menu
  // can stay painted for one more repaint while the transcript flush wins the
  // race, and resurrecting it would re-lock the composer under the answered
  // card (addQuestionRow stamps the supersede).
  if (c.screenQSupSig === sig && Date.now() - (c.screenQSupAt || 0) < 2000) return;
  c.screenQSupSig = null;
  if (c.screenQSig === sig && c.byKey.has(key)) return;
  c.screenQSig = sig;
  const fresh = !c.byKey.has(key);
  addQuestionRow(pane, key, {
    id: key,
    name: 'AskUserQuestion',
    input: { questions: [parsed] },
  });
  if (fresh && c.pinned) c.list.scrollTop = c.list.scrollHeight;
}

// Click-time staleness check for question-card buttons: the card can lag the
// screen by up to a probe tick (700 ms) — the menu may have been answered in
// the terminal, or replaced by a chained prompt (a permission menu right after
// a question). A digit sent then would actuate whatever took its place, so
// re-parse the live screen at click time and require it to still show the
// menu this card rendered (question + option labels; checkbox state may
// legitimately differ mid-toggle). On mismatch, repaint reality and swallow
// the click.
function cardMenuLive(pane, q) {
  const c = pane.chat;
  if (!c) return false;
  const s = screenText(pane);
  const parsed =
    parseCodexApproval(pane, s) || parseScreenQuestion(s) || parsePlanScreenQuestion(pane, s);
  const shape = (p) =>
    safeJson([p.question, (Array.isArray(p.options) ? p.options : []).map((o) =>
      typeof o === 'object' && o ? o.label : String(o))]);
  if (parsed && shape(parsed) === shape(q)) return true;
  syncScreenQuestion(pane, s); // removes or replaces the stale card
  return false;
}

function removeScreenQuestion(pane) {
  const c = pane.chat;
  if (!c) return;
  c.screenQSig = null;
  const key = screenQuestionKey(pane);
  const row = c.byKey.get(key);
  if (row) {
    row.remove();
    c.byKey.delete(key);
  }
  c.toolByUseId.delete(key);
  if (c.pendingQuestions.delete(key)) updateChatBanner(pane);
}

// While output is flowing, periodically check the screen for a blocking menu.
// Codex animates its status line while an approval modal waits, so a codex
// pane never "goes quiet" — without this probe the modal would sit behind
// "working…" forever (Claude pauses output at its prompts, so the quiet path
// catches those too; the probe just gets there sooner).
function probeAttention(pane) {
  if (pane.disposed || pane.state === 'dead') return stopAttentionProbe(pane);
  if (pane.state !== 'busy' && pane.state !== 'attention') return;
  const screen = screenText(pane);
  syncScreenQuestion(pane, screen);
  planScreenCheck(pane, screen);
  if (menuOnScreen(screen) || chatHasPendingQuestion(pane)) {
    pane.menuMiss = 0;
    setPaneState(pane, 'attention');
  } else if (pane.state === 'attention' && ++pane.menuMiss >= 2) {
    // Two consecutive misses before dropping back to busy: a snapshot taken
    // mid-repaint can briefly show the modal region cleared, and flapping
    // would re-fire the "needs your input" notification.
    setPaneState(pane, 'busy');
  }
}

function startAttentionProbe(pane) {
  if (pane.probeTimer) return;
  pane.menuMiss = 0;
  pane.probeTimer = setInterval(() => probeAttention(pane), PROBE_MS);
}

function stopAttentionProbe(pane) {
  clearInterval(pane.probeTimer);
  pane.probeTimer = null;
}

function markActivity(pane, data) {
  if (pane.disposed || pane.state === 'dead') return;
  if (data) pane.buf = ((pane.buf || '') + stripAnsi(data)).slice(-4000);
  // A pane showing a menu keeps emitting output (codex repaints its status
  // line under the modal) — don't let those repaints flip 'attention' back to
  // 'busy'; the probe clears it once the menu leaves the screen.
  if (pane.state !== 'attention') setPaneState(pane, 'busy');
  startAttentionProbe(pane);
  clearTimeout(pane.idleTimer);
  pane.idleTimer = setTimeout(() => evaluateIdle(pane), IDLE_MS);
}

function evaluateIdle(pane) {
  if (pane.disposed || pane.state === 'dead') return;
  stopAttentionProbe(pane); // output is quiet — the screen won't change now
  const buf = pane.buf || '';

  // A failed startup command: hint once, right in the terminal.
  if (!pane.hintShown && CMD_MISSING_PATTERNS.some((re) => re.test(buf))) {
    pane.hintShown = true;
    const cmd = paneCommand(pane);
    const install = agentFor(pane.agent).install;
    const fix = install
      ? `Install it with \`${install}\` (then sign in by running \`${cmd}\` once)`
      : `Install it (or fix the hive's startup command in ✎ Edit hive)`;
    try {
      pane.term.write(
        `\r\n\x1b[33m[Hivemind] "${cmd}" wasn't found on PATH. ` +
        `${fix}, then open a new thread.\x1b[0m\r\n`);
    } catch (_) { /* ignore */ }
  }

  // The TUI hard-wraps long messages at pane width, so an error sentence can
  // split mid-phrase across lines — scan wrap-joined runs of non-blank lines
  // so a pattern matches regardless of where the wrap fell. Repaints repeat
  // the same text, hence the Set.
  const blocks = buf.split(/\n\s*\n/)
    .map((run) => run.split('\n').map((s) => s.trim()).filter(Boolean).join(' '))
    .filter(Boolean);
  const errLines = [...new Set(blocks
    .filter((b) => ERROR_PATTERNS.some((re) => re.test(b)))
    .map((b) => {
      // Codex prefixes its error lines with ■ — cut the screen chrome the
      // wrap-join glued on in front of it.
      const i = b.indexOf('■');
      if (i > 0) b = b.slice(i);
      return b.length > 300 ? b.slice(0, 300) + '…' : b;
    }))];
  if (errLines.length) {
    pane.errored = true;
    // Keep the matched line for the prompt card (the buffer's tail is usually
    // just the CLI's redrawn input box, not the error), and drop the buffer so
    // a recovered thread doesn't re-flag this same stale error on every quiet.
    pane.errorText = errLines.slice(-3).join('\n');
    pane.buf = '';
    // Also pin the message into the chat flow as a red card: the prompt card
    // is suppressed while a screen menu waits (codex pairs API errors with a
    // "switch model?" menu), and it vanishes on the next state change — the
    // chat row keeps the reason visible either way.
    if (pane.chat) addErrorRow(pane, 'err:' + pane.errorText.slice(0, 60), pane.errorText);
    // An error can strand a stale question card (the probe is stopped and
    // won't run again in this state) — re-judge the screen before settling.
    syncScreenQuestion(pane);
    setPaneState(pane, 'error');
    return;
  }
  pane.errored = false;
  pane.errorText = '';
  // Quiet means the turn ended or the CLI is waiting. Judge the visible
  // screen: a blocking menu, or a turn that finished on a question for the
  // user, both read "needs you"; anything else is a finished turn.
  const screen = screenText(pane);
  syncScreenQuestion(pane, screen);
  planScreenCheck(pane, screen);
  const promptVisible = promptVisibleOnScreen(screen);
  const needsYou = promptVisible || chatHasPendingQuestion(pane);
  // A transcript-pending question with nothing on screen is a stranded lock —
  // start (or cancel) its expiry clock.
  syncQuestionExpiry(pane, promptVisible);
  // A turn that ended without reaching the plan-approval menu (⟳-requested
  // plans, or planning interrupted): the file is final for now, not mid-draft
  // — drop "drafting" so the 📋 chip doesn't stick.
  if (!needsYou && panePlan(pane).state === 'drafting') planSetState(pane, 'none');
  setPaneState(pane, needsYou ? 'attention' : 'idle');
}

// A finished turn is easy to miss — the header dot just flips yellow→green. So
// when a turn completes (busy → idle) the whole pane glows green and its status
// reads "✓ done" until the user clicks back into the thread (focusPane clears
// it). Starting new work, dying, or needing input also clears a stale glow.
function setDoneGlow(pane, on) {
  on = !!on && pane.state === 'idle';
  if (!!pane.doneGlow === on) return;
  pane.doneGlow = on;
  pane.el.classList.toggle('done', on);
  if (pane.statusEl && pane.state === 'idle') {
    pane.statusEl.textContent = on ? '✓ done' : STATE_LABEL.idle;
  }
  updateBoardStatus(pane.board.id);
  refreshZoomTabs(pane.board.id);
}

function setPaneState(pane, state) {
  if (pane.state === state) return;
  const prev = pane.state;
  pane.state = state;

  // The process is gone — no menu can be waiting. Drop the live question
  // chrome so the exit card isn't suppressed by an unanswerable question
  // (the probe is stopped on death; nothing else would clean these up).
  if (state === 'dead' && pane.chat) {
    removeScreenQuestion(pane);
    pane.chat.pendingQuestions.clear();
  }

  pane.dot.className = 'dot ' + state;
  if (pane.statusEl) {
    pane.statusEl.textContent = STATE_LABEL[state] || '';
    pane.statusEl.className = 'status ' + state;
  }
  if (state === 'idle' && prev === 'busy') setDoneGlow(pane, true);
  else if (state !== 'idle') setDoneGlow(pane, false);
  updateBoardStatus(pane.board.id);
  refreshZoomTabs(pane.board.id);
  updateChatBanner(pane);

  // Notify on the transitions that pull a human back: a terminal asking for
  // input, hitting an error, or finishing a turn while the window is backgrounded.
  const focusedHere = pane === focusedPane && document.hasFocus();
  if (notifyMuted || (pane.board && pane.board.muted) || focusedHere) return;
  if (state === 'error') {
    notify(pane, 'hit an error');
  } else if (state === 'attention') {
    notify(pane, 'needs your input');
  } else if (state === 'idle' && prev === 'busy' && !document.hasFocus()) {
    notify(pane, 'finished its turn');
  }
}

function notify(pane, what) {
  window.api.notify({
    title: pane.board.name || 'Hivemind',
    body: `${pane.name || 'thread'} ${what}`,
    paneId: pane.id,
    boardId: pane.board.id,
  });
}

function boardStatus(boardId) {
  const s = { attention: 0, error: 0, busy: 0, idle: 0, dead: 0, done: 0, total: 0 };
  const g = grids.get(boardId);
  if (!g) return s;
  for (const col of g.columns) {
    for (const p of col.panes) {
      s.total++;
      if (p.doneGlow) s.done++;
      const st = p.state || 'idle';
      if (s[st] !== undefined) s[st]++;
    }
  }
  return s;
}

function updateBoardStatus(boardId) {
  const item = boardListEl.querySelector(`.board-item[data-id="${boardId}"]`);
  if (!item) return;
  const sdot = item.querySelector('.status-dot');
  const badge = item.querySelector('.badge');
  const s = boardStatus(boardId);

  let summary = 'none';
  if (s.error > 0) summary = 'error';
  else if (s.attention > 0) summary = 'attention';
  else if (s.busy > 0) summary = 'busy';
  else if (s.done > 0) summary = 'done';
  else if (s.idle > 0) summary = 'idle';
  else if (s.dead > 0) summary = 'dead';
  if (sdot) sdot.className = 'status-dot ' + summary;

  const waiting = s.attention + s.error;
  if (badge) {
    if (waiting > 0) {
      badge.textContent = String(waiting);
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }
  }
}

// ---------------------------------------------------------------------------
// Thread captions
//
// To label each thread with what it's working on, we watch the raw keystrokes
// flowing into a pane, rebuild the current input line, and when the user hits
// Enter we use that line as the thread's caption. It's a heuristic — terminal
// input has no clean "prompt submitted" event — but the latest real prompt wins,
// so the header stays a useful summary of the thread's current task.
// ---------------------------------------------------------------------------
function feedCaptionInput(pane, data) {
  if (!pane || !data) return;
  let buf = pane.capBuf || '';
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = data.charCodeAt(i);
    if (ch === '\r' || ch === '\n') {
      commitCaption(pane, buf);
      buf = '';
    } else if (code === 0x1b) {
      // Skip an escape sequence (arrow keys, history nav…) so it can't pollute
      // the line. Consume the CSI/SS3 introducer and its final byte.
      if (data[i + 1] === '[' || data[i + 1] === 'O') {
        i += 1;
        while (i + 1 < data.length) {
          const c = data.charCodeAt(i + 1);
          i += 1;
          if (c >= 0x40 && c <= 0x7e) break;
        }
      }
    } else if (code === 0x7f || code === 0x08) {
      buf = buf.slice(0, -1); // backspace / delete
    } else if (code === 0x03 || code === 0x15) {
      buf = ''; // Ctrl-C / Ctrl-U abandon the current line
    } else if (code >= 0x20) {
      buf += ch;
    }
  }
  pane.capBuf = buf;
}

// Short confirmations, menu picks and yes/no replies aren't tasks — they answer
// a prompt Claude is showing. If the thread already has a caption, don't let one
// of these clobber it; the real task prompt should keep the header.
const REPLY_WORDS = new Set([
  'y', 'n', 'yes', 'no', 'yep', 'yeah', 'yup', 'nope', 'ok', 'okay', 'k',
  'sure', 'continue', 'go', 'proceed', 'stop', 'done', 'skip', 'accept',
  'approve', 'deny', 'cancel', 'quit', 'exit', 'thanks', 'thank you',
]);

function isReplyLike(text) {
  const t = text.toLowerCase();
  if (/^[0-9]{1,3}$/.test(t)) return true;   // menu selection ("1", "2"…)
  return REPLY_WORDS.has(t);
}

function commitCaption(pane, line) {
  const text = (line || '').trim();
  if (!text) return;                 // a bare Enter keeps the existing caption
  if (text.startsWith('/')) return;  // slash commands are controls, not tasks
  // Keep the existing task caption when the line is just a reply to a prompt.
  if (pane.captionText && pane.captionText.trim() && isReplyLike(text)) return;
  setPaneCaption(pane, text);
}

// Set a thread's caption (truncated for display, full text on hover).
function setPaneCaption(pane, text, { persist = true } = {}) {
  if (!pane) return;
  const full = String(text || '').replace(/\s+/g, ' ').trim();
  pane.captionText = full;
  if (pane.caption) {
    pane.caption.textContent = full.length > 80 ? full.slice(0, 79) + '…' : full;
    pane.caption.title = full;
  }
  if (persist) persistLayout(pane.board.id);
}

// Send keystrokes/text to a pane.
function sendToPane(pane, data) {
  window.api.writePty(pane.id, data);
  feedCaptionInput(pane, data);
  markActivity(pane, ''); // typing means this pane is active again
}

// Type a prompt into a pane's TUI: text goes through bracketed paste, and
// Enter follows as its own keystroke once the TUI has ingested the text. Both
// CLIs treat rapid input as a paste burst, and an Enter arriving inside that
// burst becomes a plain newline instead of a submit — under load ConPTY can
// hand the paste and a fixed-delay Enter to the CLI in a single read, so no
// gap is safe on its own. The delay scales with payload size (codex needs a
// longer floor), text is always bracketed so the burst has an explicit
// terminator, and confirmSubmit() watches the screen afterwards and re-sends
// Enter if the prompt is still sitting in the composer. Slash commands are
// typed raw instead of pasted so the TUI's command handling sees them.
// `images` are file paths the TUI should attach as actual image input: the
// Codex composer converts a paste event into an image attachment only when
// that paste is exactly one image path and nothing else, so each path goes
// through as its own bracketed paste (its model can't view images from a path
// in text — codex's view_image tool is unreliable in the Windows sandbox).
function typePrompt(pane, text, images = []) {
  for (const p of images) sendToPane(pane, '\x1b[200~' + p + '\x1b[201~');
  if (text && !text.includes('\n') && text.startsWith('/')) sendToPane(pane, text);
  else if (text) sendToPane(pane, '\x1b[200~' + text + '\x1b[201~');
  const delay = (pane.agent === 'codex' ? 250 : 150) +
    Math.min(300, Math.ceil(text.length / 20));
  const ptyId = pane.id; // a respawn in the gap remaps pane.id to a fresh pty
  setTimeout(() => {
    if (pane.disposed || pane.id !== ptyId) return;
    // A menu can pop up during the paste delay — menu detection lags by up to
    // a probe tick, and an Enter now would accept the highlighted row. Leave
    // the text in the composer; confirmSubmit waits the menu out and presses
    // Enter once it's gone.
    if (pane.state === 'attention' || chatHasPendingQuestion(pane) ||
        menuOnScreen(screenText(pane))) {
      confirmSubmit(pane, ptyId, text, 5);
      return;
    }
    sendToPane(pane, '\r');
    confirmSubmit(pane, ptyId, text, 2);
  }, delay);
}

// After the Enter, verify the prompt actually left the composer. When the
// paste and the Enter coalesce into one read, the CLI keeps the text in its
// input box — visible as the prompt's head still sitting on the composer row.
// The composer is the LAST prompt-prefixed row on screen ("> " in Claude
// Code — its transcript echoes of submitted prompts use the same chrome but
// always sit above the composer — "▌" in codex, "│ >" in bordered builds), so
// only that row and its wrap-continuation rows below it are judged. Menus and
// questions on screen (or a pending chat question) mean Enter would actuate a
// menu row instead, so those bail out.
const SUBMIT_RETRY_MS = 1000;
const COMPOSER_ROW_RE = /^\s*(?:[>❯](\s|$)|[│▌])/;
function promptStuckOnScreen(screen, head) {
  const rows = screen.split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!COMPOSER_ROW_RE.test(rows[i])) continue;
    return rows.slice(i).some((l) => l.includes(head));
  }
  return false;
}
function confirmSubmit(pane, ptyId, text, tries) {
  const head = String(text || '').split('\n', 1)[0].trim().slice(0, 40);
  if (head.length < 3 || tries <= 0) return;
  setTimeout(() => {
    if (pane.disposed || pane.id !== ptyId) return;
    const screen = screenText(pane);
    // A menu in the way: don't actuate it — keep waiting for it to clear (the
    // user answers it in card or terminal; the stuck prompt is still worth
    // submitting afterwards), giving up once the tries run out.
    if (pane.state === 'attention' || chatHasPendingQuestion(pane) ||
        promptVisibleOnScreen(screen)) {
      confirmSubmit(pane, ptyId, text, tries - 1);
      return;
    }
    if (!promptStuckOnScreen(screen, head)) return;
    sendToPane(pane, '\r');
    confirmSubmit(pane, ptyId, text, tries - 1);
  }, SUBMIT_RETRY_MS);
}

// Send a full prompt to a live pane, exactly like the chat composer would.
function deliverPrompt(pane, text, images = []) {
  if (transcriptSupported(pane)) window.api.transcript.noteSent(pane.id, text);
  // Echo bubbles only make sense in the transcript-backed chat: the terminal-
  // backed layer keeps its list hidden (the TUI itself echoes the message), so
  // a row there would never be seen — or confirmed away.
  if (pane.chat && transcriptSupported(pane)) {
    const names = images.map((p) => '🖼 ' + (String(p).split(/[\\/]/).pop() || p));
    addEchoRow(pane, [text, ...names].filter(Boolean).join('\n'));
  }
  typePrompt(pane, text, images);
}

// ---------------------------------------------------------------------------
// Hivemind commands
//
// A message addressed to the app instead of the thread: start a composer
// message (or one dictated utterance) with "Hivemind" and the rest is a
// command Hivemind itself carries out — open a thread and hand it a task,
// route a task to another thread, close/rename/maximize threads, switch
// hives — rather than text sent to Claude. Parsing is deliberately loose
// (rule-based, punctuation-tolerant) so dictated phrasing works.
// ---------------------------------------------------------------------------
const HM_WAKE_RE = /^(?:hey\s+|ok\s+|okay\s+)?hive\s*mind\b[\s,:.!?-]*/i;

// Wake-word mishearings speech models actually produce for "Hivemind",
// normalized to lowercase letters only. Checked against the first one or two
// words of a dictated utterance; an edit distance ≤ 2 from "hivemind" catches
// near-misses that aren't listed.
const HM_WAKE_MISHEARD = new Set([
  'halfmine', 'halfmind', 'halfmined', 'highmind', 'himind', 'hivemine',
  'hivemined', 'hiveman', 'hivemen', 'havemind', 'hymind', 'ivemind',
]);

function hmEditDistance(a, b) {
  const n = a.length, m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[m];
}

// Does a normalized (lowercase, letters-only) word look like a mangled
// "hivemind"? Membership in the known set always counts. The edit-distance
// net is only cast over single words (`joined` false): two-word joins like
// "his mind" → "hismind" sit within distance 2 of "hivemind" and would
// swallow ordinary dictated prose, so joins must be explicitly listed.
function hmLooksLikeWake(s, joined) {
  if (!s) return false;
  if (HM_WAKE_MISHEARD.has(s)) return true;
  if (joined) return false;
  return s[0] === 'h' && s.length >= 6 && s.length <= 10 && hmEditDistance(s, 'hivemind') <= 2;
}

// The command text after the wake word ('' if the wake word stood alone), or
// null when the text isn't addressed to Hivemind at all. With `fuzzy` (the
// dictation paths), the first word or two is also tried as a mishearing of
// "Hivemind" — so "half mine, open a thread" still runs as a command instead
// of being typed into the thread. Typed text keeps the strict match: "half
// mine" at the start of a written sentence shouldn't be swallowed.
function matchHivemindCommand(text, fuzzy) {
  const t = String(text || '').trim();
  const m = HM_WAKE_RE.exec(t);
  if (m) return t.slice(m[0].length).trim();
  if (!fuzzy) return null;
  const lead = /^(?:hey|ok|okay)[\s,]+/i.exec(t);
  const rest = lead ? t.slice(lead[0].length) : t;
  const words = /^(\S+)(?:\s+(\S+))?/.exec(rest);
  if (!words) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const w1 = norm(words[1]);
  if (hmLooksLikeWake(w1)) {
    return rest.slice(words[1].length).replace(/^[\s,:.!?-]+/, '').trim();
  }
  if (words[2] && hmLooksLikeWake(w1 + norm(words[2]), true)) {
    return rest.slice(words[0].length).replace(/^[\s,:.!?-]+/, '').trim();
  }
  return null;
}

// Feedback for commands: a transient toast over the workspace, view-agnostic.
// When the Chat with Hivemind dialog is open, every response is also mirrored
// into its transcript; for commands issued *from* the dialog the bubble is the
// feedback, so the toast is suppressed. (Commands that toast after an internal
// await miss the capture window and both toast and mirror — acceptable.)
let hmToastTimer = null;
function hmToast(msg, kind) {
  if (hmChatIsOpen()) hmChatAppend('bee', msg, kind);
  if (hmChatCaptureActive) { hmChatCapture++; return; }
  const el = document.getElementById('hm-toast');
  if (!el) return;
  el.textContent = '🐝 ' + msg;
  el.classList.toggle('err', kind === 'err');
  el.classList.remove('hidden');
  clearTimeout(hmToastTimer);
  hmToastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'err' ? 6000 : 3500);
}

function boardPanes(board) {
  const g = board && grids.get(board.id);
  if (!g) return [];
  const out = [];
  for (const col of g.columns) for (const p of col.panes) if (!p.disposed) out.push(p);
  return out;
}

// Find a thread by what the user calls it: exact name, then partial name,
// then caption — all case-insensitive, so dictated names match.
function findPaneByName(board, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  const panes = boardPanes(board);
  return panes.find((p) => (p.name || '').toLowerCase() === q)
      || panes.find((p) => (p.name || '').toLowerCase().includes(q))
      || panes.find((p) => (p.captionText || '').toLowerCase().includes(q))
      || null;
}

// A command's run() may return HM_PASS to decline its match (e.g. "in Leo"
// didn't name a real thread) and let the rest of the registry have a go.
const HM_PASS = Symbol('hm-pass');

// Route "<task> in <name>" / "in <name>, <task>" to the named thread. Only an
// exact thread-name match claims the text — anything else returns HM_PASS so
// ordinary phrasing ("find foo in bar.js") keeps reaching other commands.
function hmRouteTaskTo(board, who, task) {
  const q = String(who || '').trim().toLowerCase();
  const target = q && boardPanes(board).find((p) => (p.name || '').trim().toLowerCase() === q);
  if (!target) return HM_PASS;
  if (target.state === 'dead') { hmToast(paneLabel(target) + ' has exited — open a new thread.', 'err'); return; }
  const t = hmExtractTask(task);
  if (!t) { hmToast('What should ' + paneLabel(target) + ' do?', 'err'); return; }
  deliverPrompt(target, t);
  hmToast('Sent to ' + paneLabel(target) + ': ' + t);
}

// Strip the connective tissue between "open a new thread" and the task itself:
// "and have it fix the bug" → "fix the bug".
// "2" / "two" / "three"… → a thread count for "open N threads". Anything
// unrecognized (or missing) means 1.
const HM_NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function hmParseCount(word) {
  if (!word) return 1;
  const n = HM_NUM_WORDS[word.toLowerCase()] || parseInt(word, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function hmExtractTask(rest) {
  let task = String(rest || '').trim();
  task = task.replace(/^(?:,|\.|and|then)\s+/i, '');
  task = task.replace(/^(?:to|have it|tell it to|ask it to|get it to|and)\s+/i, '');
  return task.trim();
}

// "everywhere" / "in all threads" suffix on font commands → every pane on the
// hive instead of just the context pane.
const HM_ALL_RE = /\b(?:everywhere|all\s+(?:threads|panes|terminals))\b/i;
function hmFontPanes(board, pane, rest) {
  if (HM_ALL_RE.test(rest || '')) {
    const all = boardPanes(board);
    if (all.length) return all;
  }
  return pane ? [pane] : [];
}

// Resolve a spoken/typed model name against a MODELS/CODEX_MODELS list: exact
// value, exact label, then substring — all case-insensitive.
function hmResolveModel(list, q) {
  q = String(q || '').trim().toLowerCase().replace(/\s+model$/, '');
  if (!q) return null;
  return list.find((x) => x.value.toLowerCase() === q)
      || list.find((x) => x.label.toLowerCase() === q)
      || list.find((x) => x.label.toLowerCase().includes(q) || x.value.toLowerCase().includes(q))
      || null;
}

// The command registry. Ordered — the first entry with a matching pattern
// wins, so specific commands sit above generic ones (e.g. voice's "stop
// listening" above the catch-all "stop <thread>"). `help` is the entry's line
// in the Help modal's "Hivemind commands" list (null on aliases / commands
// documented by a sibling entry); the list is generated from this registry so
// it can't drift out of date. Every `run` gets (match, { board, pane }) where
// pane is the context thread ("this thread").
const HM_COMMANDS = [
  {
    name: 'help',
    patterns: [/^(?:help|commands?|what can (?:you|i) (?:do|say))$/i],
    help: '<strong>help</strong> — opens this window.',
    run() {
      openHelp();
      hmToast('Commands are listed under "Hivemind commands" in Help.');
    },
  },
  {
    name: 'close-help',
    patterns: [/^close\s+(?:the\s+)?help$/i],
    help: null,
    run() { closeHelp(); },
  },
  {
    name: 'open-chat',
    patterns: [/^(?:open\s+(?:the\s+)?)?chat$/i, /^talk\s+to\s+me$/i],
    help: '<strong>chat</strong> / <strong>talk to me</strong> — opens the Chat with Hivemind panel in the sidebar (commands without the wake word).',
    run() { hmChatOpen(); },
  },
  {
    name: 'close-chat',
    patterns: [/^close\s+(?:the\s+)?chat$/i],
    help: null,
    run() { hmChatClose(); },
  },
  {
    // "add a todo (item) [to] <text>" — append to this hive's Todo panel. The
    // bare "todo <text>" composer prefix is the shortcut for the same thing.
    name: 'add-todo',
    patterns: [/^(?:add|create|make|new)\s+(?:a\s+)?(?:new\s+)?to-?do(?:\s+item)?\b\s*(.*)$/i],
    help: '<strong>add a todo &lt;text&gt;</strong> — adds an item to this hive\'s Todo panel.',
    run(m) { captureTodo(hmExtractTask(m[1])); },
  },
  {
    // "open (up) a new thread [and/to <task>]" — the task rides along as the
    // new Claude's initial prompt, so it starts working the moment it boots.
    // "open 2 threads" / "open three new threads" opens that many (capped at
    // 8); a task goes to every one of them.
    name: 'new-thread',
    patterns: [
      /^(?:open(?:\s+up)?|start|create|add|make|spawn)\s+(?:(?:a|another)\s+)?(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:new\s+)?(?:more\s+)?(?:threads?|terminals?|panes?|tabs?|claudes?)\b\s*(.*)$/i,
      /^new\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:threads?|terminals?|panes?|tabs?)\b\s*(.*)$/i,
    ],
    help: '<strong>open a new thread</strong> / <strong>open &lt;N&gt; threads</strong> <em>[and/to &lt;task&gt;]</em> — opens one or more threads on this hive; with a task, each new Claude starts working on it the moment it boots.',
    run(m, { board }) {
      if (!board) { hmToast('No hive is open — create one first.', 'err'); return; }
      const wanted = hmParseCount(m[1]);
      const count = Math.min(wanted, 8);
      const task = hmExtractTask(m[2]);
      const names = [];
      for (let i = 0; i < count; i++) {
        const p = addTerminal(board, task ? { initialPrompt: task } : {});
        if (!p) break;
        if (task) setPaneCaption(p, task);
        names.push(p.name);
      }
      if (!names.length) { hmToast('Could not open a thread here.', 'err'); return; }
      const label = names.length === 1 ? names[0] : names.length + ' threads (' + names.join(', ') + ')';
      let msg = task ? 'Opened ' + label + ' — starting on: ' + task : 'Opened ' + label + '.';
      if (wanted > 8) msg += ' (8 at a time is the max.)';
      hmToast(msg);
    },
  },
  {
    name: 'new-hive',
    patterns: [/^(?:new|create|add|open|make|start)\s+(?:a\s+)?(?:new\s+)?(?:hive|board)$/i],
    help: '<strong>new hive</strong> — opens the create-hive dialog.',
    run() { openModal(null); },
  },
  {
    // "tell <thread> to <task>" — route a task to another thread by name/caption.
    name: 'tell',
    patterns: [/^(?:tell|ask)\s+(?:thread\s+)?(.+?)\s+to\s+(.+)$/i],
    help: '<strong>tell &lt;thread&gt; to &lt;task&gt;</strong> — sends the task to the named thread (names and captions both match, so “tell Leo to…” or “tell the login thread to…” work).',
    run(m, { board, pane }) {
      const who = m[1].trim();
      const target = /^(?:it|this|this thread|the current thread)$/i.test(who)
        ? pane : findPaneByName(board, who);
      if (!target) { hmToast('No thread called "' + who + '" on this hive.', 'err'); return; }
      if (target.state === 'dead') { hmToast('That thread has exited — open a new one.', 'err'); return; }
      const task = m[2].trim();
      deliverPrompt(target, task);
      hmToast('Sent to ' + paneLabel(target) + ': ' + task);
    },
  },
  {
    // "close this thread" / "close thread <name>"
    name: 'close-thread',
    patterns: [/^(?:close|kill)\s+(?:(?:this|the\s+current)\s+)?(?:thread|terminal|pane)\b\s*(.*)$/i],
    help: '<strong>close this thread</strong> / <strong>close thread &lt;name&gt;</strong>',
    run(m, { board, pane }) {
      const nm = m[1].replace(/^(?:called|named)\s+/i, '').trim();
      const target = nm ? findPaneByName(board, nm) : pane;
      if (!target) { hmToast(nm ? 'No thread called "' + nm + '" on this hive.' : 'No thread to close.', 'err'); return; }
      const label = paneLabel(target);
      closePane(target);
      hmToast('Closed ' + label + '.');
    },
  },
  {
    name: 'rename-thread',
    patterns: [/^rename\s+(?:(?:this|the\s+current)\s+)?(?:thread|terminal|pane)?\s*(?:to|as)\s+(.+)$/i],
    help: '<strong>rename this thread to &lt;name&gt;</strong>',
    run(m, { pane }) {
      if (!pane) { hmToast('No thread to rename.', 'err'); return; }
      pane.name = m[1].trim();
      pane.autoName = false;
      pane.title.textContent = pane.name;
      refreshZoomTabs(pane.board.id);
      persistLayout(pane.board.id);
      hmToast('Renamed this thread to "' + pane.name + '".');
    },
  },
  {
    name: 'maximize',
    patterns: [/^(?:maximi[sz]e|zoom(?:\s+in)?)\b/i],
    help: '<strong>maximize</strong> / <strong>restore</strong> — zoom the current thread or go back to the tiled layout.',
    run(m, { pane }) {
      if (!pane) { hmToast('No thread to maximize.', 'err'); return; }
      const g = grids.get(pane.board.id);
      if (g && g.zoomed !== pane) toggleZoom(pane);
      hmToast('Maximized ' + paneLabel(pane) + '.');
    },
  },
  {
    name: 'restore',
    patterns: [/^(?:restore|un\s*zoom|zoom\s+out|minimi[sz]e|tile)\b/i],
    help: null, // documented on the maximize entry
    run(m, { board }) {
      const g = board && grids.get(board.id);
      if (g && g.zoomed) toggleZoom(g.zoomed);
      hmToast('Restored the tiled layout.');
    },
  },
  {
    // Must sit above the stop/interrupt catch-all so "stop voice typing" and
    // "stop listening" reach the mic instead of a thread.
    name: 'voice-start',
    patterns: [/^(?:start|enable|turn\s+on|begin)\s+(?:voice(?:\s+typing)?|dictation|dictating|listening)$/i],
    help: '<strong>start / stop voice typing</strong> — same as the 🎤 button or the <kbd>~</kbd> key.',
    run() { startVoice(); },
  },
  {
    name: 'voice-stop',
    patterns: [
      /^(?:stop|disable|turn\s+off|end)\s+(?:voice(?:\s+typing)?|dictation|dictating|listening)$/i,
      /^stop\s+listening$/i,
    ],
    help: null,
    run() { stopVoice(); hmToast('Voice typing stopped.'); },
  },
  {
    name: 'voice-toggle',
    patterns: [/^toggle\s+(?:voice(?:\s+typing)?|dictation)$/i],
    help: null,
    run() { toggleVoice(); },
  },
  {
    name: 'voice-train',
    patterns: [
      /^(?:train|practice)\s+(?:the\s+)?(?:voice\s+)?dictionary$/i,
      /^(?:open\s+|start\s+)?voice\s+training$/i,
    ],
    help: '<strong>train dictionary</strong> — read practice sentences built from your own prompts; Hivemind proposes voice-dictionary fixes for whatever it misheard and re-drills the misses.',
    run() { openVoiceTraining(); },
  },
  {
    // "stop / interrupt [thread <name>]" — same Ctrl+C the ⏹ button sends.
    name: 'interrupt',
    patterns: [/^(?:stop|interrupt|cancel)(?:\s+(?:(?:this|the\s+current)\s+)?(?:thread|terminal|pane))?\s*(.*)$/i],
    help: '<strong>stop</strong> / <strong>interrupt</strong> <em>[thread &lt;name&gt;]</em> — sends the same Ctrl+C as the ⏹ button.',
    run(m, { board, pane }) {
      const nm = m[1].trim();
      const target = nm ? findPaneByName(board, nm) : pane;
      if (!target) { hmToast(nm ? 'No thread called "' + nm + '" on this hive.' : 'No thread to interrupt.', 'err'); return; }
      sendToPane(target, '\x03');
      hmToast('Interrupted ' + paneLabel(target) + '.');
    },
  },
  {
    name: 'focus-thread',
    patterns: [/^(?:focus|go\s+to|switch\s+to|show)\s+(?:the\s+)?thread\s+(.+)$/i],
    help: '<strong>focus thread &lt;name&gt;</strong> — jump to a thread by name.',
    run(m, { board }) {
      const target = findPaneByName(board, m[1]);
      if (!target) { hmToast('No thread called "' + m[1].trim() + '" on this hive.', 'err'); return; }
      focusPane(target);
      hmToast('Focused ' + paneLabel(target) + '.');
    },
  },
  {
    name: 'cycle-thread',
    patterns: [/^(?:focus\s+|go\s+to\s+|switch\s+to\s+)?(?:the\s+)?(next|previous|prev)\s+(?:thread|terminal|pane)$/i],
    help: '<strong>next / previous thread</strong> — cycle focus, like <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>]</kbd> / <kbd>[</kbd>.',
    run(m) {
      cycleFocus(/^n/i.test(m[1]) ? 1 : -1);
      if (focusedPane) hmToast('Focused ' + paneLabel(focusedPane) + '.');
    },
  },
  {
    name: 'switch-hive',
    patterns: [
      /^(?:switch|go|jump|move)\s+to\s+(?:the\s+)?(?:hive|board|project)\s+(.+)$/i,
      /^open\s+(?:the\s+)?(?:hive|board|project)\s+(.+)$/i,
    ],
    help: '<strong>switch to hive &lt;name&gt;</strong>',
    run(m) {
      const q = m[1].trim().toLowerCase();
      const b = boards.find((x) => (x.name || '').toLowerCase() === q)
             || boards.find((x) => (x.name || '').toLowerCase().includes(q));
      if (!b) { hmToast('No hive called "' + m[1].trim() + '".', 'err'); return; }
      selectBoard(b.id);
      hmToast('Switched to ' + b.name + '.');
    },
  },
  {
    name: 'font-bigger',
    patterns: [
      /^(?:make\s+)?(?:the\s+)?(?:font|text)(?:\s+size)?\s+(?:bigger|larger|up)\b(.*)$/i,
      /^(?:increase|enlarge|grow|raise|bump(?:\s+up)?)\s+(?:the\s+)?(?:font|text)(?:\s+size)?\b(.*)$/i,
      /^bigger\s+(?:font|text)\b(.*)$/i,
    ],
    help: '<strong>font bigger / smaller</strong>, <strong>font size &lt;n&gt;</strong>, <strong>reset font</strong> — this thread\'s font; add <em>everywhere</em> to change all threads.',
    run(m, { board, pane }) {
      const targets = hmFontPanes(board, pane, m[1]);
      if (!targets.length) { hmToast('No thread to resize.', 'err'); return; }
      for (const p of targets) setPaneFontSize(p, p.fontSize + 1);
      const f = targets[targets.length - 1].fontSize;
      hmToast('Font size ' + f + (f >= FONT_MAX ? ' — that\'s the max.' : '.'));
    },
  },
  {
    name: 'font-smaller',
    patterns: [
      /^(?:make\s+)?(?:the\s+)?(?:font|text)(?:\s+size)?\s+(?:smaller|down)\b(.*)$/i,
      /^(?:decrease|reduce|shrink|lower)\s+(?:the\s+)?(?:font|text)(?:\s+size)?\b(.*)$/i,
      /^smaller\s+(?:font|text)\b(.*)$/i,
    ],
    help: null, // documented on the font-bigger entry
    run(m, { board, pane }) {
      const targets = hmFontPanes(board, pane, m[1]);
      if (!targets.length) { hmToast('No thread to resize.', 'err'); return; }
      for (const p of targets) setPaneFontSize(p, p.fontSize - 1);
      const f = targets[targets.length - 1].fontSize;
      hmToast('Font size ' + f + (f <= FONT_MIN ? ' — that\'s the minimum.' : '.'));
    },
  },
  {
    name: 'font-set',
    patterns: [
      /^(?:set\s+)?(?:the\s+)?(?:font|text)(?:\s+size)?\s+(?:to\s+)?(\d{1,3})\b(.*)$/i,
      /^(reset)\s+(?:the\s+)?(?:font|text)(?:\s+size)?\b(.*)$/i,
    ],
    help: null, // documented on the font-bigger entry
    run(m, { board, pane }) {
      const targets = hmFontPanes(board, pane, m[2]);
      if (!targets.length) { hmToast('No thread to resize.', 'err'); return; }
      const size = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : FONT_DEFAULT;
      for (const p of targets) setPaneFontSize(p, size);
      const f = clampFont(size);
      hmToast('Font size ' + f + (f !== size ? ' (' + size + ' is outside ' + FONT_MIN + '–' + FONT_MAX + ')' : '') + '.');
    },
  },
  {
    name: 'theme',
    patterns: [
      /^(?:switch|change|set)\s+(?:the\s+)?theme\s+(?:to\s+)?(.+)$/i,
      /^theme\s+(.+)$/i,
      /^(?:switch|change)\s+to\s+(?:the\s+)?(.+?)\s+theme$/i,
    ],
    help: '<strong>theme &lt;name&gt;</strong> — midnight, forest, ember, grape, paper, or rose.',
    run(m) {
      const q = m[1].trim().toLowerCase().replace(/\s+theme$/, '');
      const id = Object.keys(THEMES).find((k) => k === q)
        || Object.keys(THEMES).find((k) => THEMES[k].label.toLowerCase().startsWith(q));
      if (!id) { hmToast('No theme called "' + m[1].trim() + '" — themes: ' + Object.keys(THEMES).join(', ') + '.', 'err'); return; }
      applyTheme(id);
      const st = $('set-theme');
      if (st && st.options.length) st.value = id;
      hmToast('Theme: ' + THEMES[id].label.replace(/\s*\(.*$/, '') + '.');
    },
  },
  {
    name: 'model',
    patterns: [
      /^(?:switch|change|set)\s+(?:the\s+)?model\s+(?:to\s+)?(.+)$/i,
      /^use\s+(?:the\s+)?(.+?)\s+model$/i,
    ],
    help: '<strong>switch model to &lt;model&gt;</strong> — live on a Claude thread; restarts a ChatGPT thread with a fresh conversation.',
    run(m, { pane }) {
      if (!pane) { hmToast('No thread to switch models on.', 'err'); return; }
      if (pane.agent === 'gemini') { hmToast('Gemini threads have no model picker.', 'err'); return; }
      const codex = pane.agent === 'codex';
      const list = codex ? CODEX_MODELS : MODELS;
      const hit = hmResolveModel(list, m[1]);
      if (!hit) {
        hmToast('No ' + (codex ? 'ChatGPT' : 'Claude') + ' model matches "' + m[1].trim() + '" — options: ' + list.map((x) => x.label).join(', ') + '.', 'err');
        return;
      }
      if (codex) {
        const restarting = pane.codexModel !== hit.value && pane.state !== 'dead';
        setPaneCodexModel(pane, hit.value);
        hmToast('Model: ' + hit.label + (restarting ? ' — restarting this thread; the conversation starts fresh.' : '.'));
      } else {
        setPaneModel(pane, hit.value);
        hmToast('Model: ' + hit.label + ' — switched live.');
      }
      persistLayout(pane.board.id);
    },
  },
  {
    name: 'agent',
    patterns: [
      /^(?:switch|change)\s+(?:(?:this|the\s+current)\s+thread\s+)?to\s+(claude|chat\s*gpt|codex|gemini)$/i,
      /^use\s+(claude|chat\s*gpt|codex|gemini)$/i,
    ],
    help: '<strong>switch to claude / chatgpt / gemini</strong> — restarts this thread on that agent (the conversation doesn\'t carry over).',
    run(m, { pane }) {
      if (!pane) { hmToast('No thread to switch.', 'err'); return; }
      const raw = m[1].toLowerCase().replace(/\s+/g, '');
      const v = raw === 'claude' ? 'claude' : raw === 'gemini' ? 'gemini' : 'codex';
      if (pane.agent === v) { hmToast('This thread is already running ' + agentFor(v).label + '.'); return; }
      setPaneAgent(pane, v);
      persistLayout(pane.board.id);
      hmToast('Restarting this thread as ' + agentFor(v).label + ' — the conversation doesn\'t carry over.');
    },
  },
  {
    name: 'permission-mode',
    patterns: [
      /^(?:set\s+)?(?:the\s+)?permissions?(?:\s+mode)?\s+(?:to\s+)?(.+)$/i,
      /^(?:enter\s+|go\s+to\s+|switch\s+to\s+)?(plan|bypass|accept\s*edits|default)\s+mode$/i,
    ],
    help: '<strong>plan / bypass / accept edits / default mode</strong> — this Claude thread\'s permission mode (restarts it, resuming the conversation).',
    run(m, { pane }) {
      if (!pane) { hmToast('No thread to change.', 'err'); return; }
      if (pane.agent !== 'claude') { hmToast('Permission modes only apply to Claude threads.', 'err'); return; }
      const q = m[1].trim().toLowerCase().replace(/\s+mode$/, '').replace(/[\s-]+/g, '');
      const v = q === 'default' ? 'default'
        : q === 'plan' ? 'plan'
        : /^bypass/.test(q) ? 'bypass'
        : /^accept/.test(q) ? 'acceptEdits' : null;
      if (!v) { hmToast('Permission modes: Default, Accept Edits, Plan, Bypass.', 'err'); return; }
      const label = (PERMS.find((p) => p.value === v) || {}).label || v;
      if (pane.permMode === v) { hmToast('Already in ' + label + ' mode.'); return; }
      const restarting = pane.state !== 'dead';
      setPanePerm(pane, v);
      persistLayout(pane.board.id);
      hmToast('Permission mode: ' + label + (restarting ? ' — restarting and resuming this conversation.' : '.'));
    },
  },
  {
    name: 'panel',
    patterns: [/^(open|show|close|hide|toggle)\s+(?:the\s+)?(files?|file\s+explorer|explorer|git|source\s+control|to-?dos?)\s*(?:panel|sidebar|list)?$/i],
    help: '<strong>open / close the explorer / git / todo panel</strong>',
    run(m) {
      const verb = m[1].toLowerCase();
      const what = m[2].toLowerCase();
      const kind = /git|source/.test(what) ? 'git' : /to-?do/.test(what) ? 'todo' : 'files';
      const panel = kind === 'git' ? gitPanel : kind === 'todo' ? todoPanel : filesPanel;
      const isOpen = panel && !panel.classList.contains('hidden');
      const open = verb === 'toggle' ? !isOpen : (verb === 'open' || verb === 'show');
      if (kind === 'git') { setGitOpen(open); if (open) refreshGit(); }
      else if (kind === 'todo') { setTodoOpen(open); if (open) refreshTodo(); }
      else { setFilesOpen(open); if (open) refreshFiles(); }
      hmToast((kind === 'git' ? 'Source Control' : kind === 'todo' ? 'Todo' : 'Explorer') + (open ? ' panel opened.' : ' panel closed.'));
    },
  },
  {
    name: 'show-plan',
    patterns: [/^(?:open|show|view)\s+(?:the\s+)?plan(?:\s+review)?$/i],
    help: '<strong>show the plan</strong> / <strong>close the plan</strong> — this thread\'s plan review.',
    run(m, { pane }) {
      if (!pane) { hmToast('No thread to show a plan for.', 'err'); return; }
      openPlanReview(pane);
    },
  },
  {
    name: 'close-plan',
    patterns: [/^close\s+(?:the\s+)?plan(?:\s+review)?$/i],
    help: null,
    run() { closePlanReview(); },
  },
  {
    name: 'show-diff',
    patterns: [/^(?:show|open|view)\s+(?:the\s+)?diff(?:s)?(?:\s+(?:for|of|on)\s+(.+))?$/i],
    help: '<strong>show diff</strong> <em>[for &lt;file&gt;]</em> — opens Source Control, or jumps straight to a changed file\'s diff.',
    async run(m) {
      const dir = activeDir();
      if (!dir) { hmToast('This hive has no project directory set.', 'err'); return; }
      const q = (m[1] || '').trim();
      if (!q) {
        setGitOpen(true);
        refreshGit();
        hmToast('Source Control opened — click a file to see its diff.');
        return;
      }
      const st = await window.api.git.status(dir);
      const files = (st && st.files) || [];
      const hits = files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase()));
      if (hits.length === 1) { showDiff(hits[0], !!(hits[0].staged && !hits[0].unstaged)); return; }
      setGitOpen(true);
      refreshGit();
      if (hits.length) hmToast(hits.length + ' changed files match "' + q + '" — pick one in Source Control.');
      else hmToast('No changed file matches "' + q + '".', 'err');
    },
  },
  {
    name: 'show-terminal',
    patterns: [/^(?:show|open|switch\s+to|go\s+to)\s+(?:the\s+)?terminal(?:\s+view)?$/i],
    help: '<strong>show the terminal</strong> / <strong>show the chat</strong> — flip this thread\'s view, like the <strong>&gt;_</strong> / <strong>💬</strong> button.',
    run(m, { pane }) {
      if (!pane) { hmToast('No thread to switch views on.', 'err'); return; }
      setPaneView(pane, 'term');
      hmToast('Terminal view.');
    },
  },
  {
    name: 'show-chat',
    patterns: [/^(?:show|open|switch\s+to|go\s+to)\s+(?:the\s+)?chat(?:\s+view)?$/i],
    help: null, // documented on the show-terminal entry
    run(m, { pane }) {
      if (!pane) { hmToast('No thread to switch views on.', 'err'); return; }
      if (!chatSupported(pane)) { hmToast('This thread is terminal-only.', 'err'); return; }
      setPaneView(pane, 'chat');
      hmToast('Chat view.');
    },
  },
  {
    name: 'attach',
    patterns: [/^attach(?:\s+(?:a\s+|some\s+)?files?)?$/i],
    help: '<strong>attach a file</strong> — opens the composer\'s 📎 file picker.',
    run(m, { pane }) {
      if (!pane || !pane.chat || !pane.chat.pickAttachments) { hmToast('This thread has no composer to attach files to.', 'err'); return; }
      if (pane.view !== 'chat') setPaneView(pane, 'chat');
      pane.chat.pickAttachments();
    },
  },
  {
    name: 'history',
    patterns: [/^(?:open|show|browse)\s+(?:the\s+)?(?:conversation\s+)?history$/i],
    help: '<strong>show history</strong> — browse this Claude thread\'s past conversations.',
    run(m, { pane }) {
      if (!pane || !pane.chat || !historySupported(pane)) { hmToast('Past conversations are only available on Claude threads.', 'err'); return; }
      if (pane.view !== 'chat') setPaneView(pane, 'chat');
      toggleHistoryMenu(pane);
    },
  },
  {
    name: 'settings',
    patterns: [/^(?:open|show)\s+(?:the\s+)?settings(?:\s+(general|voice))?$/i],
    help: '<strong>open settings</strong> <em>[general/voice]</em> / <strong>close settings</strong>',
    run(m) { openSettings(m[1] ? m[1].toLowerCase() : 'general'); },
  },
  {
    name: 'close-settings',
    patterns: [/^close\s+(?:the\s+)?settings$/i],
    help: null,
    run() { closeSettings(); },
  },
  {
    name: 'usage',
    patterns: [/^(?:open|show|check)\s+(?:the\s+)?(?:claude\s+)?usage$/i],
    help: '<strong>show usage</strong> / <strong>close usage</strong> — your Claude plan limits and today\'s tokens.',
    run() { openUsage(); },
  },
  {
    name: 'close-usage',
    patterns: [/^close\s+(?:the\s+)?usage$/i],
    help: null,
    run() { closeUsage(); },
  },
  {
    name: 'build',
    patterns: [/^(?:build|package|compile)(?:\s+(?:the|a))?(?:\s+portable)?(?:\s+(?:app|application|build|exe|copy|version))?$/i],
    help: '<strong>build the portable app</strong> — bump the version, build, and publish a release (only when this hive is the Hivemind checkout).',
    async run() {
      const dir = activeDir();
      let ok = false;
      try { ok = !!dir && await window.api.build.isHivemind(dir); } catch (_) { /* not buildable */ }
      if (!ok || !startPortableBuild) {
        hmToast('Building is only available when this hive points at the Hivemind source checkout.', 'err');
        return;
      }
      if (buildBtn.dataset.busy) {
        hmToast('A build is already running — progress shows on the Build button in Settings.', 'err');
        return;
      }
      startPortableBuild();
      hmToast('Building the portable app — progress shows in Settings → General → Building Hivemind.');
    },
  },
  {
    // "<task> in <thread>" — "Hivemind, fix the failing test in Leo". Guarded:
    // only an exact thread-name match routes; otherwise hmRouteTaskTo returns
    // HM_PASS and the text falls through to the rest of the registry. Sits
    // below the specific commands so "make the font bigger in Leo" still means
    // the font command, but above the find catch-all.
    name: 'task-in-thread',
    patterns: [/^(.+?)\s+in\s+(?:thread\s+)?([A-Za-z][\w'-]*)$/i],
    help: '<strong>&lt;task&gt; in &lt;thread&gt;</strong> — “fix the failing test in Leo” sends the task to that thread (every new thread gets a short name like <em>Leo</em> or <em>Nina</em>; exact names only).',
    run(m, { board }) { return hmRouteTaskTo(board, m[2], m[1]); },
  },
  {
    // "in <thread>, <task>" — same routing, name-first.
    name: 'in-thread-task',
    patterns: [/^in\s+(?:thread\s+)?([A-Za-z][\w'-]*)[,:]?\s+(.+)$/i],
    help: null, // documented on the task-in-thread entry
    run(m, { board }) { return hmRouteTaskTo(board, m[1], m[2]); },
  },
  {
    // Greediest pattern — keep it last so "find <anything>" can't shadow
    // other commands.
    name: 'find',
    patterns: [/^(?:find|search(?:\s+for)?)\s+(.+)$/i, /^find$/i],
    help: '<strong>find &lt;text&gt;</strong> — search this thread\'s terminal, like <kbd>Ctrl</kbd>+<kbd>F</kbd>.',
    run(m, { pane }) {
      if (!pane) { hmToast('No thread to search.', 'err'); return; }
      if (!pane.searchAddon) { hmToast('Search isn\'t available in this build.', 'err'); return; }
      if (pane.view !== 'term') setPaneView(pane, 'term');
      openFind(pane);
      const q = (m[1] || '').trim();
      if (q) {
        pane.findInput.value = q;
        try { pane.searchAddon.findNext(q); } catch (_) { /* no match */ }
      }
    },
  },
];

// The Help modal's "Hivemind commands" list is generated from the registry,
// so the docs can never drift from what the dispatcher actually accepts.
(function renderHmCommandHelp() {
  const ul = document.getElementById('hm-cmd-list');
  if (!ul) return;
  ul.innerHTML = HM_COMMANDS.filter((c) => c.help).map((c) => '<li>' + c.help + '</li>').join('');
})();

// Walk the registry with a command string. Returns true when an entry claimed
// it (even if the entry then failed, e.g. an unknown thread name — that's an
// answered command), false when nothing matched.
function hmDispatch(c, board, pane) {
  entries: for (const entry of HM_COMMANDS) {
    for (const re of entry.patterns) {
      const m = re.exec(c);
      if (!m) continue;
      // HM_PASS: the entry declined the match — keep scanning the registry.
      if (entry.run(m, { board, pane }) === HM_PASS) continue entries;
      return true;
    }
  }
  return false;
}

// Conversational tolerance, tier 1 (instant, local): peel politeness and
// filler off the edges so "hey, could you please make the font bigger for me?"
// reaches the registry as "make the font bigger". Applied only after the raw
// text fails to match, so no existing phrasing changes meaning.
const HM_NORM_PREFIXES = [
  /^(?:hey|hi|hello|ok|okay|so|um+|uh+|well|now|also|and)[,!\s]+/i,
  /^(?:please|kindly|just|go\s+ahead\s+and)[,\s]+/i,
  /^(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?/i,
  /^(?:i|we)\s+(?:want|need|would\s+like|'?d\s+like)\s+(?:you\s+)?to\s+/i,
  /^(?:let'?s|lets)\s+/i,
];
const HM_NORM_SUFFIXES = [
  /[\s,]+(?:please|thanks|thank\s+you|for\s+me|now|ok(?:ay)?)$/i,
];
function hmNormalize(c) {
  let t = String(c || '').trim().replace(/[\s.!?]+$/, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of [...HM_NORM_PREFIXES, ...HM_NORM_SUFFIXES]) {
      const next = t.replace(re, '').trim().replace(/[\s.!?]+$/, '');
      if (next !== t) { t = next; changed = true; }
    }
  }
  return t.trim();
}

// Conversational tolerance, tier 2 (AI fallback): when the registry can't
// match even the normalized text, hand the request to a one-shot `claude -p`
// on the fast model along with the command catalog and the live context
// (thread/hive/theme/model names). It answers with one canonical command line
// (re-dispatched through the registry — never a second AI pass) or NONE.
let hmInterpretBusy = false;
async function hmInterpretRequest(c, ctxPane) {
  if (!(window.api.hm && window.api.hm.interpret)) {
    hmToast('Didn\'t recognize "' + c + '" — say "help" for the command list.', 'err');
    return;
  }
  if (hmInterpretBusy) {
    hmToast('Still working out the previous request — give me a second.', 'err');
    return;
  }
  hmInterpretBusy = true;
  hmToast('Let me figure out what you mean…');
  try {
    const board = activeBoard();
    const payload = {
      request: c,
      commands: HM_COMMANDS.filter((x) => x.help)
        .map((x) => x.help.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()),
      threads: boardPanes(board).map((p) => p.name).filter(Boolean),
      hives: boards.map((b) => b.name).filter(Boolean),
      themes: Object.keys(THEMES),
      models: MODELS.map((x) => x.label).concat(CODEX_MODELS.map((x) => x.label)),
    };
    const res = await window.api.hm.interpret(payload);
    if (!res || res.code !== 0) {
      hmToast('Didn\'t recognize "' + c + '"' +
        (res && res.message ? ' (' + res.message + ')' : '') +
        ' — say "help" for the command list.', 'err');
      return;
    }
    const line = hmNormalize(res.message.replace(HM_WAKE_RE, ''));
    // The context pane may have closed while Claude was thinking — fall back
    // to whatever is focused now, same as a fresh command would.
    const pane = (ctxPane && !ctxPane.disposed) ? ctxPane : focusedPane;
    if (!line || /^(?:NONE|PASS)\.?$/i.test(line) || !hmDispatch(line, activeBoard(), pane)) {
      hmToast('Didn\'t recognize "' + c + '" — say "help" for the command list.', 'err');
    }
  } finally {
    hmInterpretBusy = false;
  }
}

// Execute a command addressed to Hivemind. Anything that starts with the wake
// word is consumed as a command — recognized ones run (even when they fail,
// e.g. an unknown thread name), unrecognized ones get an error toast — and is
// never sent to the thread. Mentioning Hivemind mid-sentence doesn't match the
// wake regex at all, so ordinary messages still pass through untouched.
// Matching is tiered: exact registry patterns, then locally normalized text
// (politeness stripped), then the AI interpreter — so phrasing doesn't have to
// be exact, and only genuinely unrecognized requests pay the AI round-trip.
function runHivemindCommand(cmd, ctxPane) {
  const board = activeBoard();
  const pane = (ctxPane && !ctxPane.disposed) ? ctxPane : focusedPane;
  const c = String(cmd || '').replace(/[\s.!?]+$/, '').trim();
  if (!c) {
    hmToast('Say a command after "Hivemind" — e.g. "Hivemind, open a new thread and fix the failing test". Say "Hivemind help" for the list.', 'err');
    return true;
  }
  if (hmDispatch(c, board, pane)) return true;
  const n = hmNormalize(c);
  if (n && n !== c && hmDispatch(n, board, pane)) return true;
  // Async on purpose: the command is consumed now; the answer toasts (and
  // mirrors into the chat, if open) when the interpreter comes back.
  hmInterpretRequest(n || c, pane);
  return true;
}

// ---------------------------------------------------------------------------
// Chat with Hivemind — command console docked in the sidebar (#hm-chat), like
// the Source Control / Todo / Prompt History panels. Every message is a
// command (the wake word is tolerated but not required); responses arrive by
// hmToast mirroring into the transcript. The workspace stays visible so
// commands like "focus alpha" can be watched taking effect.
// ---------------------------------------------------------------------------
const hmChatLog = [];            // { role: 'user'|'bee', text, kind } — session-only
const HM_CHAT_MAX = 200;         // same cap as composer history
let hmChatCaptureActive = false; // a dialog-issued command is dispatching
let hmChatCapture = 0;           // responses captured during that dispatch
let hmChatSeeded = false;        // greeter shown once per session
let hmChatSendOnStop = false;    // mic stopped mid-transcription — send when the result lands

function hmChatIsOpen() {
  const root = document.getElementById('hm-chat');
  return !!root && !root.classList.contains('hidden');
}

function hmChatRenderMsg(m) {
  const log = document.getElementById('hm-chat-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'hm-msg ' + m.role + (m.kind === 'err' ? ' err' : '');
  div.textContent = m.text;   // command echoes contain user text — never innerHTML
  if (m.role === 'user') {
    const edit = document.createElement('button');
    edit.className = 'hm-msg-edit';
    edit.title = 'Edit & re-apply — corrections teach the voice dictionary';
    edit.setAttribute('aria-label', 'Edit and re-apply this command');
    edit.textContent = '✏';
    edit.onclick = () => hmChatEditStart(div, m);
    div.appendChild(edit);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// Rebuild the transcript from the log — used after an in-place edit is applied
// or cancelled to restore normal bubbles.
function hmChatRerender() {
  const log = document.getElementById('hm-chat-log');
  if (!log) return;
  log.innerHTML = '';
  for (const m of hmChatLog) hmChatRenderMsg(m);
}

// Swap a sent-command bubble into an inline editor. Re-apply runs the edited
// command as a new message; if words changed, the diff feeds the voice
// dictionary's correction learning (an explicit edit is a strong signal, so
// the "add to dictionary?" offer comes up immediately, not after two sightings).
function hmChatEditStart(bubble, m) {
  if (bubble.classList.contains('editing')) return;
  bubble.classList.add('editing');
  bubble.textContent = '';
  const ta = document.createElement('textarea');
  ta.className = 'hm-edit-ta';
  ta.value = m.text;
  ta.rows = Math.min(5, Math.max(2, Math.ceil(m.text.length / 30)));
  const row = document.createElement('div');
  row.className = 'hm-edit-actions';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  const apply = document.createElement('button');
  apply.className = 'primary';
  apply.textContent = 'Re-apply';
  const finish = () => hmChatRerender();
  cancel.onclick = finish;
  apply.onclick = () => {
    const edited = ta.value.trim();
    finish();
    if (!edited) return;
    if (edited !== m.text) voiceLearnFromTexts(m.text, edited, VOICE_LEARN_MIN_SEEN);
    hmChatDispatch(edited);
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); apply.onclick(); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(); }  // don't close the panel
  });
  row.appendChild(cancel);
  row.appendChild(apply);
  bubble.appendChild(ta);
  bubble.appendChild(row);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function hmChatAppend(role, text, kind) {
  const entry = { role, text, kind };
  hmChatLog.push(entry);
  if (hmChatLog.length > HM_CHAT_MAX) hmChatLog.shift();
  hmChatRenderMsg(entry);
  if (role === 'bee' && hmChatCaptureActive) hmSpeak(text);
}

function hmChatOpen() {
  const root = document.getElementById('hm-chat');
  if (!root) return;
  // Docked in the sidebar — one panel at a time, like its siblings.
  if (typeof setGitOpen === 'function') setGitOpen(false);
  if (typeof setFilesOpen === 'function') setFilesOpen(false);
  if (typeof setTodoOpen === 'function') setTodoOpen(false);
  if (typeof setHistoryOpen === 'function') setHistoryOpen(false);
  if (!hmChatSeeded) {
    hmChatSeeded = true;
    hmChatLog.push({ role: 'bee', text: 'Tell me what you need — plain English is fine, no "Hivemind" prefix needed. Try "help" for the full command list.' });
  }
  // Rebuild the transcript from the log so close/clear/reopen stay consistent.
  hmChatRerender();
  root.classList.remove('hidden');
  const toggle = document.getElementById('hm-chat-toggle');
  if (toggle) toggle.classList.add('active');
  const sb = document.getElementById('sidebar');
  if (sb) sb.classList.add('hm-open'); // board list yields its space
  const input = document.getElementById('hm-chat-input');
  if (input) input.focus();
}

function hmChatClose() {
  const root = document.getElementById('hm-chat');
  if (!root || root.classList.contains('hidden')) return;
  root.classList.add('hidden');
  const toggle = document.getElementById('hm-chat-toggle');
  if (toggle) toggle.classList.remove('active');
  const sb = document.getElementById('sidebar');
  if (sb) sb.classList.remove('hm-open');
  hmChatSendOnStop = false;
  if (window.speechSynthesis) speechSynthesis.cancel();
  // Closing the panel is a dismissal, not a "send it" — drop the auto-send.
  if (voiceTargetHmChat) { stopVoice({ send: false }); voiceTargetHmChat = false; }
  if (focusedPane && !focusedPane.disposed) focusPane(focusedPane);
}

function hmChatToggle() { if (hmChatIsOpen()) hmChatClose(); else hmChatOpen(); }

// Panel-style setter so the sibling panels' "one at a time" logic can close
// the chat the same way it closes the others.
function setHmChatOpen(open) { if (open) hmChatOpen(); else hmChatClose(); }

function hmChatClearLog() {
  hmChatLog.length = 0;
  const log = document.getElementById('hm-chat-log');
  if (log) log.innerHTML = '';
}

function hmChatSubmit() {
  const input = document.getElementById('hm-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  // Learn from fixes made to dictated text before this command was sent.
  voiceLearnHarvest(input, text);
  input.value = '';
  hmChatDispatch(text);
}

// Echo a command into the transcript and run it — shared by the composer
// (hmChatSubmit) and the bubble editor's Re-apply (hmChatEditStart).
function hmChatDispatch(text) {
  hmChatAppend('user', text);
  // The wake word is tolerated ("hivemind help" works) but not required —
  // fuzzily, so a dictated "half mine help" doesn't leave a stray prefix.
  const stripped = matchHivemindCommand(text, true);
  const cmd = stripped !== null ? stripped : text;
  hmChatCaptureActive = true;
  hmChatCapture = 0;
  try {
    runHivemindCommand(cmd, null);  // null ctx → live focusedPane, so "focus alpha" then "bigger font" chains
    if (hmChatCapture === 0) hmChatAppend('bee', 'Done.');  // silent commands still get an answer
  } finally {
    hmChatCaptureActive = false;
  }
}

// Dictation routed here while the dialog is the voice target (see
// commitVoiceText). Same dictionary/auto-enter/auto-space treatment as thread
// dictation; the wake word isn't stripped here — hmChatSubmit tolerates it.
function hmChatVoiceCommit(trimmed) {
  const input = document.getElementById('hm-chat-input');
  if (!input) return;
  if (voiceAutoEnter && VOICE_ENTER_RE.test(trimmed)) { hmChatSubmit(); return; }
  let text = applyVoiceDict(trimmed);
  if (!text) return;
  if (voiceAutoSpace) text += ' ';
  const start = input.selectionStart != null ? input.selectionStart : input.value.length;
  const end = input.selectionEnd != null ? input.selectionEnd : start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + text.length;
  // Remembered for correction learning, harvested in hmChatSubmit.
  voiceLearnRecord(input, text.trim());
}

// Stopping the mic sends the dictated command — no Send click needed. Called
// straight from stopVoice when nothing is transcribing, or deferred (via
// hmChatSendOnStop) until the last in-flight transcription has been committed
// so the tail of what was said isn't cut off.
function hmChatVoiceSend() {
  hmChatSendOnStop = false;
  const input = document.getElementById('hm-chat-input');
  if (!hmChatIsOpen() || !input || !input.value.trim()) return;
  hmChatSubmit();
}

// Spoken replies (Settings → Voice, default off). Only dialog-issued replies
// are spoken — composer commands that merely mirror stay silent. An open mic
// can pick the speech back up; accepted for now.
function hmSpeak(text) {
  if (!voiceReplyEnabled || !window.speechSynthesis) return;
  speechSynthesis.cancel();   // a new reply interrupts the previous one
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

(function wireHmChat() {
  const btn = document.getElementById('hm-chat-toggle');
  if (btn) btn.onclick = hmChatToggle;
  const send = document.getElementById('hm-chat-send');
  if (send) send.onclick = hmChatSubmit;
  const clear = document.getElementById('hm-chat-clear');
  if (clear) clear.onclick = hmChatClearLog;
  const close = document.getElementById('hm-chat-close');
  if (close) close.onclick = hmChatClose;
  const input = document.getElementById('hm-chat-input');
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); hmChatSubmit(); }
  });
  const root = document.getElementById('hm-chat');
  // Non-modal, so Esc is handled on the dialog itself (not the global modal
  // chain): it only closes when focus is inside the dialog.
  if (root) root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); hmChatClose(); }
  });
})();

// Ctrl+Shift+H toggles the dialog from anywhere, terminals included.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyH')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  hmChatToggle();
}, true);

// ---------------------------------------------------------------------------
// Image drop / paste helpers
// ---------------------------------------------------------------------------
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function isImageFile(f) {
  return !!f && ((f.type && f.type.startsWith('image/')) || IMAGE_EXT_RE.test(f.name || ''));
}

// Persist an in-memory image (a pasted screenshot, or a dropped file with no
// on-disk path) to a temp file and return its absolute path.
async function persistImage(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const ext = (file.type && file.type.split('/')[1]) ||
      ((file.name || '').match(IMAGE_EXT_RE) || [])[1] || 'png';
    return await window.api.saveTempImage(buf, ext);
  } catch (err) {
    console.error('Could not persist pasted image:', err);
    return null;
  }
}

// Paths with spaces need quoting before they land on an input line.
const quotePath = (p) => (/\s/.test(p) ? `"${p}"` : p);

// The Codex CLI ("ChatGPT") runs sandboxed and can only read files inside its
// workspace, so an attachment living elsewhere (temp screenshots, files picked
// or dropped from anywhere on disk) is copied into the project's
// `.hivemind/attachments/` before its path is sent. Claude reads any path, so
// its attachments pass through untouched.
function pathInsideDir(p, dir) {
  const norm = (s) => {
    const v = String(s).replace(/\\/g, '/').replace(/\/+$/, '');
    return window.api.platform === 'win32' ? v.toLowerCase() : v;
  };
  return norm(p).startsWith(norm(dir) + '/');
}

async function stagePathForPane(pane, p) {
  if (!p || pane.agent !== 'codex') return p;
  const dir = pane.board && pane.board.dir;
  if (!dir || pathInsideDir(p, dir)) return p;
  return (await window.api.stageAttachment(dir, p)) || p;
}

// Type an image's path into the pane's prompt so the agent can read it.
// A trailing space lets the user keep typing. Codex only attaches an image as
// real image input when a paste event is exactly one path (see typePrompt),
// so there the path goes through as its own bracketed paste instead.
async function typePathIntoPane(pane, p) {
  p = await stagePathForPane(pane, p);
  if (pane.agent === 'codex') sendToPane(pane, '\x1b[200~' + p + '\x1b[201~');
  else sendToPane(pane, quotePath(p) + ' ');
}

// ---------------------------------------------------------------------------
// Chat wrapper
//
// A structured chat view layered over a thread. Claude renders from its JSONL
// transcript; ChatGPT/Codex renders from the Codex CLI's rollout log, which
// transcript.js normalizes into the same entry shape — so both agents get the
// same clean bubbles-and-tool-folds view over their hidden terminal.
// Input goes through the same sendToPane() path as keystrokes; voice dictation
// lands in the composer textarea while chat view is showing.
// ---------------------------------------------------------------------------
const CHAT_KINDS = ['tool', 'thinking', 'meta', 'subagent'];
const CHAT_KIND_LABELS = { tool: 'Tools', thinking: 'Thinking', meta: 'Meta', subagent: 'Subagents' };
const CHAT_DEFAULT_FILTERS = { tool: true, thinking: false, meta: false, subagent: false };

// Filter defaults for new panes; each pane's own choices persist in its layout.
function globalChatFilters() {
  try {
    return Object.assign({}, CHAT_DEFAULT_FILTERS, JSON.parse(localStorage.getItem('hm.chatFilters') || '{}'));
  } catch (_) {
    return Object.assign({}, CHAT_DEFAULT_FILTERS);
  }
}

// Transcript-backed chat: Claude tails its ~/.claude/projects session JSONL;
// ChatGPT/Codex tails the Codex CLI rollout under ~/.codex/sessions (both
// normalized to the same entry shape in transcript.js).
function transcriptSupported(pane) {
  return pane.agent === 'claude' || pane.agent === 'codex';
}

// Browsing/resuming past conversations is Claude-only: the history picker and
// composer-resume both ride on `claude --resume <session-id>`.
function historySupported(pane) {
  return pane.agent === 'claude';
}

function chatSupported(pane) {
  return transcriptSupported(pane);
}

// Composer placeholder for the live view; history mode swaps in its own
// "continue this conversation" hint (updateHistoryChrome).
const CHAT_PLACEHOLDER =
  'Message this thread…  (Enter sends, Shift+Enter for a new line, paste/drop files to attach)';

function initChatUI(pane, body) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-wrap';

  // Header bar: the conversation topic on the left (Claude Code's rolling
  // summary of the session — what the terminal TUI shows in its header, fed
  // by the transcript's summary lines) and the filter chips on the right.
  const filters = document.createElement('div');
  filters.className = 'chat-filters';
  const topic = document.createElement('div');
  topic.className = 'chat-topic';
  filters.appendChild(topic);

  // The thread's caption (last real prompt sent) sits left-aligned after the
  // topic — the element is created in createPane so setPaneCaption can run
  // before this bar exists.
  filters.appendChild(pane.caption);

  // History picker: a dropdown of this thread's past conversations. The button
  // toggles a menu (populated on open via api.transcript.listSessions); picking
  // an entry shows that session read-only over the live view (openHistorySession).
  const historyBtn = document.createElement('button');
  historyBtn.className = 'chat-chip chat-history-btn';
  historyBtn.textContent = '🕘 History';
  historyBtn.title = 'Browse this thread’s past conversations';
  const historyMenu = document.createElement('div');
  historyMenu.className = 'chat-history-menu hidden';
  historyBtn.onclick = (e) => { e.stopPropagation(); toggleHistoryMenu(pane); };
  filters.append(historyBtn, historyMenu);

  const chips = {};
  for (const kind of CHAT_KINDS) {
    const chip = document.createElement('button');
    chip.className = 'chat-chip';
    chip.textContent = CHAT_KIND_LABELS[kind];
    chip.title = `Show/hide ${CHAT_KIND_LABELS[kind].toLowerCase()} in this thread's chat view`;
    chip.onclick = (e) => {
      e.stopPropagation();
      pane.chatFilters[kind] = !pane.chatFilters[kind];
      applyChatFilters(pane);
      localStorage.setItem('hm.chatFilters', JSON.stringify(pane.chatFilters));
      persistLayout(pane.board.id);
    };
    chips[kind] = chip;
    filters.appendChild(chip);
  }

  // Binding trouble notice ("couldn't find this thread's transcript").
  const notice = document.createElement('div');
  notice.className = 'chat-notice hidden';
  const noticeText = document.createElement('span');
  noticeText.textContent = 'Couldn’t find this thread’s transcript — the chat view can’t update. Still watching for it…';
  const noticeBtn = document.createElement('button');
  noticeBtn.className = 'chat-open-term';
  noticeBtn.textContent = 'Open terminal';
  // This is a *temporary* escape hatch while the chat can't find its transcript
  // — not a lasting "I prefer the terminal" choice. Don't persist it, and mark
  // the pane so the view snaps back to chat the moment the transcript binds
  // (chatBindStatus). Persisting it here trapped threads in terminal view: once
  // the transcript later bound, the chat view stayed hidden behind the terminal
  // on every subsequent launch.
  noticeBtn.onclick = (e) => {
    e.stopPropagation();
    pane.termFallback = true;
    setPaneView(pane, 'term', { persist: false });
  };
  notice.append(noticeText, noticeBtn);

  // Working indicator: a spinning swirl below the last message while the
  // thread is busy on a turn (mirrors the header's "working…" status). It
  // lives inside the message list as its permanent last child — rows are
  // inserted before it (upsertChatRow) so it always trails the newest one.
  const working = document.createElement('div');
  working.className = 'chat-working hidden';
  const workingIcon = document.createElement('span');
  workingIcon.className = 'chat-working-icon';
  workingIcon.textContent = '🌀';
  const workingText = document.createElement('span');
  workingText.textContent = 'working…';
  working.append(workingIcon, workingText);

  // Message list.
  const list = document.createElement('div');
  list.className = 'chat-list';
  list.addEventListener('scroll', () => {
    const c = pane.chat;
    if (c) c.pinned = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  });
  list.appendChild(working);

  // Composer. Attachment chips (pasted/dropped/picked files) sit in their own
  // row above the input; their paths are appended to the message on send.
  const composer = document.createElement('div');
  composer.className = 'chat-composer';
  const attachRow = document.createElement('div');
  attachRow.className = 'chat-attachments hidden';
  const input = document.createElement('textarea');
  input.className = 'chat-input';
  input.rows = 1;
  input.placeholder = CHAT_PLACEHOLDER;
  input.spellcheck = true;
  const attachBtn = document.createElement('button');
  attachBtn.className = 'chat-attach';
  attachBtn.textContent = '📎';
  attachBtn.title = 'Attach files — their paths are sent with your message';
  // Interrupt: same as typing Ctrl+C in the terminal — ConPTY (Windows) / the
  // tty line discipline (POSIX) turn \x03 into the interrupt for the running
  // process. Routed through sendToPane so the caption buffer resets like a
  // typed Ctrl+C would.
  const interruptBtn = document.createElement('button');
  interruptBtn.className = 'chat-interrupt';
  interruptBtn.textContent = '⏹';
  interruptBtn.title = 'Interrupt — send Ctrl+C to this thread';
  interruptBtn.onclick = (e) => { e.stopPropagation(); sendToPane(pane, '\x03'); };
  const sendBtn = document.createElement('button');
  sendBtn.className = 'chat-send';
  sendBtn.textContent = '➤';
  sendBtn.title = 'Send (Enter)';
  const composerRow = document.createElement('div');
  composerRow.className = 'chat-composer-row';
  composerRow.append(attachBtn, input, interruptBtn, sendBtn);
  composer.append(attachRow, composerRow);

  // Read-only banner shown while browsing a past conversation. "Back to live"
  // drops history mode and restores the live tail (exitHistory).
  const historyBar = document.createElement('div');
  historyBar.className = 'chat-history-bar hidden';
  const historyBarText = document.createElement('span');
  historyBarText.className = 'chat-history-bar-text';
  const historyBackBtn = document.createElement('button');
  historyBackBtn.className = 'chat-open-term';
  historyBackBtn.textContent = 'Back to live';
  historyBackBtn.onclick = (e) => { e.stopPropagation(); exitHistory(pane); };
  historyBar.append(historyBarText, historyBackBtn);

  wrap.append(filters, notice, historyBar, list, composer);
  body.appendChild(wrap);

  pane.chat = {
    wrap, list, input, sendBtn, notice, chips, attachRow, topic, working,
    historyBtn, historyMenu, historyBar, historyBarText,
    viewingHistory: false,   // true while showing a past session over the live view
    historySession: null,    // the session being viewed (so the composer can resume it)
    attachments: [],         // { path, name, isImage, thumbUrl } chips awaiting send
    byKey: new Map(),        // row key -> row element
    toolByUseId: new Map(),  // tool_use id -> row key
    pendingResults: new Map(), // tool_use id -> result payload that arrived early
    pendingQuestions: new Map(), // AskUserQuestion tool_use id -> question text, until answered
    pendingEcho: [],         // optimistic user bubbles awaiting their transcript line
    echoSeq: 0,
    topicFromMsg: false,     // codex topic fallback already taken from a user message
    pinned: true,
    history: [],             // past sent messages, oldest→newest (↑/↓ to recall)
    histIdx: null,           // index into history while browsing; null = live draft
    histDraft: '',           // the in-progress draft stashed when browsing began
  };

  updateChatChrome(pane);

  // Terminal-backed mode insets the terminal by the composer's height so the
  // TUI's input line stays visible (.pane.term-chat CSS). Track that height as
  // the textarea autosizes and attachment chips wrap — the observer fires once
  // on observe, seeding the variable before first paint.
  new ResizeObserver(() => {
    if (pane.disposed) return;
    pane.el.style.setProperty('--chat-composer-h', composer.offsetHeight + 'px');
    if (pane.el.classList.contains('term-chat')) fitBoard(pane.board.id);
  }).observe(composer);

  // Composer wiring. Keystrokes stay local to the textarea; Enter sends.
  // The autocomplete menu gets first look at keys so ↑/↓/Tab/Enter/Esc can
  // drive it while it's open.
  const ac = initChatAutocomplete(pane, composer, input);
  pane.chat.ac = ac;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (ac.handleKey(e)) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey &&
        chatHistoryNav(pane, e.key === 'ArrowUp' ? -1 : 1)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage(pane);
    }
  });
  // Typing abandons history browsing so the next ↑ starts from the newest entry.
  input.addEventListener('input', () => { pane.chat.histIdx = null; autosizeComposer(input); ac.refresh(); });
  input.addEventListener('click', () => ac.refresh());
  input.addEventListener('blur', () => ac.hide());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  sendBtn.onclick = (e) => { e.stopPropagation(); sendChatMessage(pane); };

  // 📎 opens a native picker; each chosen file becomes an attachment chip.
  // Exposed on the chat object so the "hivemind attach a file" command can
  // drive the same picker the button does.
  pane.chat.pickAttachments = async () => {
    const paths = (await window.api.pickFiles()) || [];
    for (const p of paths) await addChatAttachment(pane, p);
    input.focus();
  };
  attachBtn.onclick = (e) => { e.stopPropagation(); pane.chat.pickAttachments(); };

  // Images pasted into the composer become temp files shown as attachment
  // chips, so they submit together with the message text.
  input.addEventListener('paste', async (e) => {
    const cd = e.clipboardData;
    const items = Array.from((cd && cd.items) || []);
    const types = Array.from((cd && cd.types) || []);
    const imgItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (imgItem) {
      e.preventDefault();
      const file = imgItem.getAsFile();
      const p = file && (await persistImage(file));
      if (p) await addChatAttachment(pane, p, file);
      return;
    }
    if (types.includes('text/plain')) return; // native text paste
    // Raw bitmap on the native clipboard (e.g. Win+Shift+S).
    e.preventDefault();
    const p = await window.api.clipboardImage();
    if (p) await addChatAttachment(pane, p);
  });

  // Drag-and-drop files anywhere on the chat view — each becomes a chip.
  wrap.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some((it) => it.kind === 'file')) {
      e.preventDefault();
      pane.el.classList.add('drag-over');
    }
  });
  wrap.addEventListener('dragleave', () => pane.el.classList.remove('drag-over'));
  wrap.addEventListener('drop', async (e) => {
    pane.el.classList.remove('drag-over');
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    e.preventDefault(); // never let Electron navigate to a dropped file
    focusPane(pane);
    for (const f of files) {
      // Files already on disk keep their path; in-memory images get persisted.
      const p = f.path || (isImageFile(f) ? await persistImage(f) : null);
      if (p) await addChatAttachment(pane, p, f);
    }
    input.focus();
  });

  // Font sizing works in the chat view too: Ctrl +/-/0 and Ctrl+scroll, same
  // as the terminal. Capture phase so the composer's stopPropagation (which
  // keeps ordinary typing local) doesn't swallow the shortcuts.
  wrap.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    let size = null;
    if (e.key === '=' || e.key === '+') size = pane.fontSize + 1;
    else if (e.key === '-' || e.key === '_') size = pane.fontSize - 1;
    else if (e.key === '0') size = FONT_DEFAULT;
    if (size === null) return;
    e.preventDefault();           // don't also zoom the whole Electron page
    e.stopPropagation();
    setPaneFontSize(pane, size);
  }, true);
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    setPaneFontSize(pane, pane.fontSize + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false, capture: true });

  // View toggle button (created in createPane's header).
  pane.viewBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  pane.viewBtn.onclick = (e) => {
    e.stopPropagation();
    setPaneView(pane, pane.view === 'chat' ? 'term' : 'chat');
  };
  pane.viewBtn.style.display = chatSupported(pane) ? '' : 'none';

  applyChatFilters(pane);
  setPaneView(pane, pane.view, { persist: false });
}

function autosizeComposer(input) {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

// ---------------------------------------------------------------------------
// Composer attachments — VS-Code-style chips above the input. Images render a
// thumbnail, other files a pill with the filename; ✕ removes a chip. On send
// the chips' quoted paths are appended to the message text.
// ---------------------------------------------------------------------------

// file:// URL for an <img> thumbnail (the window itself is file://-origin).
// The drive-letter colon stays unencoded (":" can't appear in filenames).
function fileUrlFor(p) {
  let u = String(p).replace(/\\/g, '/');
  if (!u.startsWith('/')) u = '/' + u;
  return 'file://' + u.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':');
}

async function addChatAttachment(pane, p, file) {
  const c = pane.chat;
  if (!c || !p) return;
  // Dedupe on the pre-staging path too — staging a source twice would mint a
  // second copy with a fresh timestamped name and slip past the path check.
  if (c.attachments.some((a) => a.path === p || a.src === p)) return;
  const src = p;
  p = await stagePathForPane(pane, p);
  if (!p || c.attachments.some((a) => a.path === p)) return;
  const name = String(p).split(/[\\/]/).pop() || String(p);
  const isImage = isImageFile(file) || IMAGE_EXT_RE.test(name);
  // Prefer an object URL when we still hold the bytes (pasted images) — it
  // works even before slow disks flush; fall back to the on-disk path.
  const thumbUrl = !isImage ? null
    : (file && file.size ? URL.createObjectURL(file) : fileUrlFor(p));
  c.attachments.push({ path: p, src, name, isImage, thumbUrl });
  renderChatAttachments(pane);
}

function removeChatAttachment(pane, att) {
  const c = pane.chat;
  const i = c.attachments.indexOf(att);
  if (i === -1) return;
  c.attachments.splice(i, 1);
  if (att.thumbUrl && att.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(att.thumbUrl);
  renderChatAttachments(pane);
}

function renderChatAttachments(pane) {
  const c = pane.chat;
  c.attachRow.innerHTML = '';
  for (const att of c.attachments) {
    const chip = document.createElement('div');
    chip.className = 'chat-attachment' + (att.isImage ? ' image' : '');
    chip.title = att.path;
    if (att.isImage) {
      const img = document.createElement('img');
      img.src = att.thumbUrl;
      img.alt = att.name;
      // Broken thumbnail (e.g. unreadable file) degrades to a file pill.
      img.onerror = () => { chip.classList.remove('image'); img.replaceWith(fileChipLabel(att)); };
      chip.appendChild(img);
    } else {
      chip.appendChild(fileChipLabel(att));
    }
    const rm = document.createElement('button');
    rm.className = 'att-remove';
    rm.textContent = '✕';
    rm.title = 'Remove attachment';
    rm.onclick = (e) => { e.stopPropagation(); removeChatAttachment(pane, att); c.input.focus(); };
    chip.appendChild(rm);
    c.attachRow.appendChild(chip);
  }
  c.attachRow.classList.toggle('hidden', !c.attachments.length);
}

function fileChipLabel(att) {
  const label = document.createElement('span');
  label.className = 'att-label';
  const icon = document.createElement('span');
  icon.className = 'att-icon';
  icon.textContent = '📄';
  const name = document.createElement('span');
  name.className = 'att-name';
  name.textContent = att.name;
  label.append(icon, name);
  return label;
}

// ---------------------------------------------------------------------------
// Composer autocomplete. Two triggers:
//   "/" as the first character  -> slash commands (built-ins below, plus the
//        project's .claude/commands/*.md and .claude/skills/* directories)
//   "@word" anywhere            -> file paths under the board's project
//        directory, listed one level at a time via api.files.list
// ↑/↓ select, Tab/Enter accept, Esc dismisses. Enter falls through to "send"
// when the typed token already exactly matches the selected suggestion.
// ---------------------------------------------------------------------------
const AC_MAX_ITEMS = 8;
const SLASH_COMMANDS = [
  ['/agents', 'Manage agent configurations'],
  ['/clear', 'Clear the conversation history'],
  ['/compact', 'Summarize the conversation to free up context'],
  ['/config', 'Open Claude Code settings'],
  ['/context', 'Show what is using up the context window'],
  ['/cost', 'Show token usage for this session'],
  ['/doctor', 'Check the Claude Code installation'],
  ['/exit', 'Quit this Claude session'],
  ['/export', 'Export the conversation'],
  ['/help', 'List available commands'],
  ['/hooks', 'Manage hooks'],
  ['/init', 'Generate a CLAUDE.md for this project'],
  ['/mcp', 'Manage MCP servers'],
  ['/memory', 'Edit memory files'],
  ['/model', 'Switch model'],
  ['/permissions', 'View or change tool permissions'],
  ['/resume', 'Resume an earlier conversation'],
  ['/review', 'Review a pull request'],
  ['/rewind', 'Rewind the conversation or code'],
  ['/status', 'Show session status'],
  ['/todos', 'List current TODO items'],
  ['/usage', 'Show plan usage limits'],
  ['/vim', 'Toggle vim editing mode'],
];

function initChatAutocomplete(pane, composer, input) {
  const menu = document.createElement('div');
  menu.className = 'chat-autocomplete hidden';
  composer.appendChild(menu);

  const st = {
    items: [], sel: 0, token: null,
    seq: 0,            // guards against stale async listings
    customFor: null,   // board dir the cached project commands were read from
    custom: null,
  };

  function hide() {
    st.items = [];
    st.token = null;
    menu.innerHTML = '';
    menu.classList.add('hidden');
  }

  // The completable token ending at the caret, or null.
  function tokenAtCaret() {
    if (input.selectionStart !== input.selectionEnd) return null;
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    if (/^\/\S*$/.test(before)) return { type: 'slash', start: 0, end: pos, query: before.slice(1) };
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (m) return { type: 'file', start: pos - m[2].length - 1, end: pos, query: m[2] };
    return null;
  }

  async function refresh() {
    const tok = tokenAtCaret();
    if (!tok) { hide(); return; }
    const seq = ++st.seq;
    const items = tok.type === 'slash' ? await slashItems(tok.query) : await fileItems(tok.query);
    if (seq !== st.seq || pane.disposed) return; // a newer refresh superseded this one
    if (document.activeElement !== input) return; // blurred while the listing was in flight
    st.token = tok;
    st.items = items.slice(0, AC_MAX_ITEMS);
    st.sel = 0;
    render();
  }

  async function slashItems(query) {
    const q = query.toLowerCase();
    const byName = new Map();
    for (const [name, desc] of SLASH_COMMANDS) byName.set(name, { label: name, desc, insert: name + ' ' });
    for (const it of await projectCommands()) if (!byName.has(it.label)) byName.set(it.label, it);
    return Array.from(byName.values())
      .filter((it) => it.label.slice(1).toLowerCase().startsWith(q))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  // Project slash commands, read once per board directory.
  async function projectCommands() {
    const dir = pane.board.dir;
    if (!dir) return [];
    if (st.customFor === dir && st.custom) return st.custom;
    st.customFor = dir;
    st.custom = [];
    try {
      const [cmds, skills] = await Promise.all([
        window.api.files.list(dir, '.claude/commands'),
        window.api.files.list(dir, '.claude/skills'),
      ]);
      if (cmds && cmds.ok) {
        for (const e of cmds.entries) {
          if (e.isDir || !/\.md$/i.test(e.name)) continue;
          const name = '/' + e.name.replace(/\.md$/i, '');
          st.custom.push({ label: name, desc: 'Project command', insert: name + ' ' });
        }
      }
      if (skills && skills.ok) {
        for (const e of skills.entries) {
          if (e.isDir) st.custom.push({ label: '/' + e.name, desc: 'Project skill', insert: '/' + e.name + ' ' });
        }
      }
    } catch (_) { /* no project commands */ }
    return st.custom;
  }

  async function fileItems(query) {
    const dir = pane.board.dir;
    if (!dir) return [];
    const slash = query.lastIndexOf('/');
    const parent = slash >= 0 ? query.slice(0, slash) : '';
    const prefix = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase();
    let res;
    try { res = await window.api.files.list(dir, parent); } catch (_) { return []; }
    if (!res || !res.ok) return [];
    const showHidden = prefix.startsWith('.');
    return res.entries
      .filter((e) => (showHidden || !e.name.startsWith('.')) && e.name.toLowerCase().startsWith(prefix))
      .map((e) => ({
        label: e.name + (e.isDir ? '/' : ''),
        desc: e.path,
        insert: '@' + e.path + (e.isDir ? '/' : ' '),
        keepOpen: e.isDir, // completing a directory re-opens the menu inside it
      }));
  }

  function render() {
    if (!st.items.length || !st.token) { hide(); return; }
    menu.innerHTML = '';
    st.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'chat-ac-item' + (i === st.sel ? ' sel' : '');
      const name = document.createElement('span');
      name.className = 'chat-ac-name';
      name.textContent = it.label;
      const desc = document.createElement('span');
      desc.className = 'chat-ac-desc';
      desc.textContent = it.desc || '';
      row.append(name, desc);
      // mousedown (not click) with preventDefault keeps focus in the textarea.
      row.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); accept(it); });
      row.addEventListener('mouseenter', () => {
        if (st.sel === i) return;
        menu.children[st.sel] && menu.children[st.sel].classList.remove('sel');
        st.sel = i;
        row.classList.add('sel');
      });
      menu.appendChild(row);
    });
    menu.classList.remove('hidden');
  }

  function accept(it) {
    const tok = st.token;
    if (!tok) return;
    input.setRangeText(it.insert, tok.start, tok.end, 'end');
    autosizeComposer(input);
    input.focus();
    if (it.keepOpen) refresh();
    else hide();
  }

  // Returns true when the key was consumed by the menu.
  function handleKey(e) {
    if (menu.classList.contains('hidden')) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      st.sel = (st.sel + (e.key === 'ArrowDown' ? 1 : -1) + st.items.length) % st.items.length;
      render();
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      const it = st.items[st.sel];
      const typed = st.token ? input.value.slice(st.token.start, st.token.end) : '';
      // Fully-typed token: let Enter through so it sends instead of re-inserting.
      if (e.key === 'Enter' && it && !it.keepOpen && it.insert.trim() === typed.trim()) {
        hide();
        return false;
      }
      e.preventDefault();
      if (it) accept(it);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
      return true;
    }
    // Caret moves don't fire 'input'; re-evaluate the token after they land.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      setTimeout(() => { if (!pane.disposed) refresh(); }, 0);
    }
    return false;
  }

  return { handleKey, refresh, hide };
}

function updateViewBtn(pane) {
  if (!pane.viewBtn) return;
  const chat = pane.view === 'chat';
  pane.viewBtn.textContent = chat ? '>_' : '💬';
  pane.viewBtn.title = chat
    ? 'Show the terminal running underneath this chat view'
    : 'Show the chat view';
}

function setPaneView(pane, view, { persist = true } = {}) {
  if (!chatSupported(pane)) view = 'term';
  // A persisted view change is a deliberate user choice (the >_/💬 toggle, the
  // show-terminal/show-chat commands): it overrides any pending "terminal only
  // because the transcript was missing" fallback, so the chat view won't snap
  // back on the next bind against the user's wishes.
  if (persist) pane.termFallback = false;
  pane.view = view;
  pane.el.classList.toggle('term-view', view === 'term');
  // Terminal-backed chat (agents with a composer but no readable session log):
  // the terminal stays the conversation view, shrunk by the composer's height
  // (.pane.term-chat CSS) so the TUI's own input line isn't covered. Re-fit
  // whenever that inset appears/disappears.
  const termChat = view === 'chat' && !transcriptSupported(pane);
  const insetChanged = pane.el.classList.contains('term-chat') !== termChat;
  pane.el.classList.toggle('term-chat', termChat);
  updateViewBtn(pane);
  if (view === 'term' || insetChanged) fitBoard(pane.board.id); // defensive re-fit on reveal
  if (pane === focusedPane) {
    try {
      if (view === 'chat' && pane.chat) pane.chat.input.focus();
      else pane.term.focus();
    } catch (_) { /* ignore */ }
  }
  if (persist) persistLayout(pane.board.id);
}

function updateChatChrome(pane) {
  const c = pane.chat;
  if (!c) return;
  const transcript = transcriptSupported(pane);
  c.wrap.classList.toggle('terminal-backed', !transcript);
  c.historyBtn.style.display = historySupported(pane) ? '' : 'none';
  c.historyMenu.classList.add('hidden');
  for (const kind of CHAT_KINDS) {
    if (c.chips[kind]) c.chips[kind].style.display = transcript ? '' : 'none';
  }
  if (!transcript) c.notice.classList.add('hidden');
  // Claude's topic comes from the transcript's rolling summary; other agents
  // don't write one. ChatGPT threads take their topic from the first user
  // message once one lands (addUserOrMetaRow) — until then, and for other
  // agents always, show the agent name.
  if (pane.agent !== 'claude' && !c.topicFromMsg) {
    c.topic.textContent = agentFor(pane.agent).label;
    c.topic.title = agentFor(pane.agent).label + ' thread';
  }
}

// Called when a pane's agent changes: chat for supported agents, terminal for the rest.
function updateChatAvailability(pane) {
  if (!pane.viewBtn) return;
  const ok = chatSupported(pane);
  updateChatChrome(pane);
  pane.viewBtn.style.display = ok ? '' : 'none';
  setPaneView(pane, ok ? 'chat' : 'term', { persist: false });
}

function applyChatFilters(pane) {
  const c = pane.chat;
  if (!c) return;
  for (const kind of CHAT_KINDS) {
    const show = !!pane.chatFilters[kind];
    c.wrap.classList.toggle('hide-' + kind, !show);
    if (c.chips[kind]) c.chips[kind].classList.toggle('active', show);
  }
}

// Drop all rendered rows (respawn, session rollover) — the transcript backfill
// that follows repopulates the view.
function resetChat(pane) {
  const c = pane.chat;
  if (!c) return;
  c.list.innerHTML = '';
  c.list.appendChild(c.working); // clearing the list must not drop the swirl
  c.byKey.clear();
  c.toolByUseId.clear();
  c.pendingResults.clear();
  c.pendingQuestions.clear();
  c.screenQSig = null;
  c.screenQSupSig = null;
  c.pendingEcho = [];
  c.pinned = true;
  c.topic.textContent = '';
  c.topic.title = '';
  c.topicFromMsg = false;
  updateChatChrome(pane);
}

function chatBindStatus(pane, status) {
  const c = pane.chat;
  if (!c) return;
  if (!transcriptSupported(pane)) return;
  // Don't let a live (re)bind wipe the past conversation being viewed; the
  // live view is rebuilt from scratch when the user clicks "Back to live".
  if (c.viewingHistory) return;
  if (status === 'timeout') {
    c.notice.classList.remove('hidden');
  } else {
    c.notice.classList.add('hidden');
    // A (re)bind means a fresh source file; render it from scratch. And when
    // the binder takes a mis-bound file away (self-heal), 'searching' drops
    // the other thread's conversation instead of leaving it on screen.
    if (status === 'bound' || status === 'searching') {
      resetChat(pane);
      // The reset dropped a live question card while its menu may still be on
      // screen — and if the pane sits in quiet attention, the probe is stopped
      // and nothing re-runs the sync until new output. Restore the card and
      // re-judge the composer lock now.
      syncScreenQuestion(pane);
      updateChatBanner(pane);
    }
    // If the terminal was only showing because the chat couldn't find its
    // transcript (the notice's "Open terminal" fallback), the reason is gone
    // now that it's bound — snap back to the chat view. Non-persistent, so a
    // deliberate terminal-view choice (which clears the flag) is never touched.
    if (status === 'bound' && pane.termFallback) {
      pane.termFallback = false;
      if (pane.view === 'term') setPaneView(pane, 'chat', { persist: false });
    }
  }
}

// -- Conversation history (chat-overlay session picker) ----------------------

// Compact "2h ago" style stamp for the picker; falls back to a date past a week.
function relTimeShort(ms) {
  const d = Date.now() - ms;
  if (d < 60 * 1000) return 'just now';
  const m = Math.floor(d / 60000);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const days = Math.floor(h / 24);
  if (days < 7) return days + 'd ago';
  return new Date(ms).toLocaleDateString();
}

function hideHistoryMenu(pane) {
  const c = pane.chat;
  if (c) c.historyMenu.classList.add('hidden');
}

async function toggleHistoryMenu(pane) {
  const c = pane.chat;
  if (!c) return;
  if (!c.historyMenu.classList.contains('hidden')) { hideHistoryMenu(pane); return; }
  c.historyMenu.innerHTML = '<div class="chat-history-empty">Loading…</div>';
  c.historyMenu.classList.remove('hidden');
  let res;
  try { res = await window.api.transcript.listSessions({ paneId: pane.id, cwd: pane.board.dir }); }
  catch (_) { res = null; }
  if (pane.disposed || c.historyMenu.classList.contains('hidden')) return; // closed meanwhile
  buildHistoryMenu(pane, (res && res.sessions) || []);
}

function buildHistoryMenu(pane, sessions) {
  const c = pane.chat;
  c.historyMenu.innerHTML = '';
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-history-empty';
    empty.textContent = 'No past conversations yet.';
    c.historyMenu.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const item = document.createElement('button');
    item.className = 'chat-history-item' + (s.current ? ' current' : '');
    const title = document.createElement('span');
    title.className = 'chat-history-item-title';
    title.textContent = s.title || s.preview || '(no messages)';
    const meta = document.createElement('span');
    meta.className = 'chat-history-item-meta';
    meta.textContent = (s.current ? 'live · ' : '') + relTimeShort(s.mtimeMs);
    item.append(title, meta);
    item.title = s.title || s.preview || '';
    item.onclick = (e) => {
      e.stopPropagation();
      hideHistoryMenu(pane);
      if (s.current) exitHistory(pane);       // clicking the live session just returns to it
      else openHistorySession(pane, s);
    };
    c.historyMenu.appendChild(item);
  }
}

// Show a past session read-only over the live view. Live tailing keeps running
// underneath (chatIngest is suppressed) so nothing is lost; exitHistory rebuilds
// the live view from the current file.
async function openHistorySession(pane, sess) {
  const c = pane.chat;
  if (!c) return;
  let res;
  try { res = await window.api.transcript.readSession({ cwd: pane.board.dir, name: sess.name }); }
  catch (_) { res = null; }
  if (pane.disposed || !c) return;
  if (!res || !res.ok) { c.notice.classList.remove('hidden'); return; }
  c.viewingHistory = true;
  c.historySession = sess; // remembered so the composer can continue this conversation
  resetChat(pane);
  renderChatEntries(pane, res.entries, true);
  if (sess.title) setChatTopic(pane, sess.title);
  updateChatBanner(pane);   // hide the live swirl/banner while browsing
  c.list.scrollTop = 0;     // start at the top of the past conversation
  updateHistoryChrome(pane, sess);
}

function exitHistory(pane) {
  const c = pane.chat;
  if (!c) return;
  hideHistoryMenu(pane);
  if (!c.viewingHistory) return;
  c.viewingHistory = false;
  c.historySession = null;
  resetChat(pane);
  updateHistoryChrome(pane, null);
  updateChatBanner(pane);              // restore live swirl/banner state
  window.api.transcript.refresh(pane.id); // re-emit the live file to catch up
  syncScreenQuestion(pane);            // restore a live on-screen question card
}

function updateHistoryChrome(pane, sess) {
  const c = pane.chat;
  if (!c) return;
  const on = !!sess;
  c.historyBar.classList.toggle('hidden', !on);
  c.wrap.classList.toggle('viewing-history', on);
  c.historyBtn.classList.toggle('active', on);
  if (on) {
    c.historyBarText.textContent =
      'Viewing a past conversation' + (sess.title ? ' · ' + sess.title : '');
  }
  // The composer stays usable in history mode — sending continues the viewed
  // conversation (the thread restarts on it), so say so where the user types.
  c.input.placeholder = on
    ? 'Continue this conversation…  (sending restarts the thread on it)'
    : CHAT_PLACEHOLDER;
}

// -- Rendering ---------------------------------------------------------------

function chatIngest(pane, entries, backfill) {
  const c = pane.chat;
  // Live tail updates are paused while the user browses a past conversation;
  // exitHistory() re-reads the live file to catch up.
  if (!c || c.viewingHistory) return;
  renderChatEntries(pane, entries, backfill);
  // A batch of rows landing must not bury the live screen-question card —
  // keep it trailing the newest content (an exitHistory backfill otherwise
  // strands it at the top, scrolled out of view).
  const sq = c.byKey.get(screenQuestionKey(pane));
  if (sq && sq.nextSibling !== c.working) c.list.insertBefore(sq, c.working);
  // A question can land after the pane already went quiet and read 'idle'
  // (the transcript line trails the screen) — pull the state to 'attention'
  // now instead of waiting for the next output burst. Only when the screen
  // corroborates that something is waiting: a tool_use whose result arrives
  // in the next batch must not flash a "needs your input" notification. A
  // transcript entry left pending with no prompt on screen ages out instead
  // (syncQuestionExpiry).
  if (chatHasPendingQuestion(pane)) {
    const promptVisible = promptVisibleOnScreen(screenText(pane));
    if (pane.state === 'idle' && promptVisible) setPaneState(pane, 'attention');
    syncQuestionExpiry(pane, promptVisible);
  }
}

function renderChatEntries(pane, entries, backfill) {
  const c = pane.chat;
  for (const e of entries) {
    try { renderChatEntry(pane, e); } catch (_) { /* one bad entry never kills the view */ }
  }
  if (c.pinned || backfill) c.list.scrollTop = c.list.scrollHeight;
}

function renderChatEntry(pane, e) {
  // Summary lines carry the conversation topic — they feed the chat's topic
  // header rather than the message list.
  if (e.type === 'summary') {
    setChatTopic(pane, e.summary);
    return;
  }
  // Subagent traffic (Task tool sidechains) collapses to one-liners.
  if (e.isSidechain) {
    addSidechainRow(pane, e);
    return;
  }
  if (e.type === 'user' && e.message) {
    const content = e.message.content;
    if (typeof content === 'string') {
      addUserOrMetaRow(pane, e, content);
      return;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && part.type === 'tool_result') attachToolResult(pane, part, e.toolUseResult);
      }
      const text = content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text).join('\n').trim();
      if (text) addUserOrMetaRow(pane, e, text);
      return;
    }
    return;
  }
  if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
    e.message.content.forEach((part, i) => {
      if (!part) return;
      const key = (e.uuid || 'a') + ':' + i;
      if (part.type === 'text' && part.text && part.text.trim()) {
        upsertChatRow(pane, key, 'assistant', (row) => {
          row.innerHTML = '<div class="chat-bubble assistant chat-md">' + markdownToHtml(part.text) + '</div>';
          addCodeCopyBtns(row.firstChild);
          addBubbleCopyBtn(row.firstChild, part.text);
        });
      } else if (part.type === 'thinking' && part.thinking) {
        upsertChatRow(pane, key, 'thinking', (row) => {
          row.innerHTML =
            '<details class="chat-fold"><summary>Thinking…</summary><pre class="chat-pre"></pre></details>';
          row.querySelector('.chat-pre').textContent = part.thinking;
        });
      } else if (part.type === 'tool_use') {
        if (part.name === 'AskUserQuestion' && part.input && Array.isArray(part.input.questions)) {
          addQuestionRow(pane, key, part);
        } else {
          addToolRow(pane, key, part);
        }
      }
    });
    return;
  }
  // API/CLI errors (e.g. Codex rejecting the chosen model, usage limits) get a
  // red card — as a dim meta line they're invisible right when the thread
  // stops responding.
  if (e.type === 'system' && e.subtype === 'error' && typeof e.content === 'string') {
    addErrorRow(pane, chatKeyFor(e), e.content);
    return;
  }
  addMetaRow(pane, chatKeyFor(e), metaLabel(e));
}

let chatAnonSeq = 0;
function chatKeyFor(e) {
  return e.uuid || 'anon:' + (++chatAnonSeq);
}

// Upsert keyed by transcript uuid (+part index) — re-emitted lines update in
// place instead of duplicating. Re-renders keep an open <details> open.
function upsertChatRow(pane, key, kind, render) {
  const c = pane.chat;
  let row = c.byKey.get(key);
  const fold = row && row.querySelector('details');
  const wasOpen = !!(fold && fold.open);
  if (!row) {
    row = document.createElement('div');
    row.className = 'chat-row';
    c.byKey.set(key, row);
    c.list.insertBefore(row, c.working); // the working swirl stays last
  }
  row.dataset.kind = kind;
  render(row);
  if (wasOpen) {
    const f = row.querySelector('details');
    if (f) f.open = true;
  }
  return row;
}

// Wire a copy-to-clipboard button: on click copy `text` and briefly flash a
// check, then restore the copy glyph. Shared by the message- and code-copy
// buttons so both behave identically.
function wireCopyButton(btn, getText, glyph) {
  glyph = glyph || '⧉';
  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(typeof getText === 'function' ? getText() : getText);
      btn.classList.add('copied');
      btn.textContent = '✓';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = glyph; }, 1200);
    } catch (_) { /* clipboard unavailable — ignore */ }
  });
}

// Hover-revealed "copy" button tucked at the end of an assistant message —
// like the one in the Claude VS Code extension. Copies the message's raw
// markdown to the clipboard. Re-run on every re-render (upsertChatRow rewrites
// the bubble's innerHTML), so it's always freshly wired to the latest text.
function addBubbleCopyBtn(bubble, text) {
  const btn = document.createElement('button');
  btn.className = 'chat-copy-btn';
  btn.title = 'Copy message';
  btn.setAttribute('aria-label', 'Copy message');
  btn.textContent = '⧉';
  wireCopyButton(btn, text);
  // Sit the button inline, right after the last word, when the message ends in
  // a normal text block (paragraph, list item, heading, quote) — appending it
  // into that block keeps it on the same row as the text. For messages that end
  // in a code block / table / bare list, fall back to the bubble so it drops to
  // its own line rather than landing inside a code fence.
  const last = bubble.lastElementChild;
  const inlineHost = last && /^(P|LI|H[1-6]|BLOCKQUOTE)$/.test(last.tagName) ? last : bubble;
  inlineHost.classList.toggle('has-inline-copy', inlineHost !== bubble);
  inlineHost.appendChild(btn);
}

// Give every fenced code block in an assistant bubble its own hover-revealed
// copy button, floated at the top-right of the block. Each <pre> is wrapped in
// a positioned .chat-code container so the button stays pinned even when a long
// line scrolls the <pre> horizontally. Re-run on every re-render, so guard with
// the wrapper class to avoid double-wrapping.
function addCodeCopyBtns(bubble) {
  bubble.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains('chat-code')) return;
    const code = pre.querySelector('code') || pre;
    const wrap = document.createElement('div');
    wrap.className = 'chat-code';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'chat-code-copy';
    btn.title = 'Copy code';
    btn.setAttribute('aria-label', 'Copy code');
    btn.textContent = '⧉';
    wireCopyButton(btn, () => code.textContent);
    wrap.appendChild(btn);
  });
}

// User lines that are really app/CLI plumbing (slash-command envelopes, meta
// notes) belong in the meta bucket, not as chat bubbles.
const CHAT_PLUMBING_RE = /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder)>/;

function addUserOrMetaRow(pane, e, text) {
  if (e.isMeta || CHAT_PLUMBING_RE.test(text)) {
    const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
    addMetaRow(pane, chatKeyFor(e), cmd ? 'command: ' + cmd[1].trim() : text);
    return;
  }
  confirmEcho(pane, text);
  // ChatGPT rollouts never carry summary lines (Claude's topic source), so
  // title the conversation by its first real user message — the same fallback
  // the history picker uses for untitled Claude sessions.
  if (pane.agent === 'codex' && !pane.chat.topicFromMsg) {
    pane.chat.topicFromMsg = true;
    setChatTopic(pane, text);
  }
  upsertChatRow(pane, chatKeyFor(e), 'user', (row) => {
    row.innerHTML = '<div class="chat-bubble user"></div>';
    row.firstChild.textContent = text;
  });
}

// The latest summary wins; a bare/blank one never wipes an existing topic.
function setChatTopic(pane, text) {
  const c = pane.chat;
  if (!c) return;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  c.topic.textContent = t;
  c.topic.title = t;
}

function addMetaRow(pane, key, label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!text) return;
  upsertChatRow(pane, key, 'meta', (row) => {
    row.innerHTML = '<div class="chat-meta-line"></div>';
    row.firstChild.textContent = text;
  });
}

function addErrorRow(pane, key, text) {
  const t = stripAnsi(String(text || '')).trim().slice(0, 1000);
  if (!t) return;
  upsertChatRow(pane, key, 'error', (row) => {
    row.innerHTML = '<div class="chat-error-card"></div>';
    row.firstChild.textContent = t;
  });
  if (pane.chat.pinned) pane.chat.list.scrollTop = pane.chat.list.scrollHeight;
}

function addSidechainRow(pane, e) {
  let brief = e.type;
  if (e.message && Array.isArray(e.message.content)) {
    const t = e.message.content.find((p) => p && p.type === 'text' && p.text);
    const u = e.message.content.find((p) => p && p.type === 'tool_use');
    if (t) brief = t.text;
    else if (u) brief = u.name || 'tool';
  } else if (e.message && typeof e.message.content === 'string') {
    brief = e.message.content;
  }
  upsertChatRow(pane, chatKeyFor(e), 'subagent', (row) => {
    row.innerHTML = '<div class="chat-meta-line subagent"></div>';
    row.firstChild.textContent =
      'subagent · ' + String(brief).replace(/\s+/g, ' ').trim().slice(0, 160);
  });
}

function metaLabel(e) {
  if (e.type === 'system' && typeof e.content === 'string') return stripAnsi(e.content);
  return e.type + (e.subtype ? ': ' + e.subtype : '');
}

// One-line description of a tool call: the input field a human would scan for.
const TOOL_SUMMARY_FIELDS = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description', 'prompt', 'skill'];
function toolSummary(part) {
  const input = part.input || {};
  for (const f of TOOL_SUMMARY_FIELDS) {
    if (typeof input[f] === 'string' && input[f].trim()) {
      return input[f].replace(/\s+/g, ' ').trim().slice(0, 100);
    }
  }
  const keys = Object.keys(input);
  return keys.length ? keys.join(', ').slice(0, 100) : '';
}

const CHAT_RESULT_MAX = 4000;
function clipResult(s) {
  s = String(s);
  return s.length > CHAT_RESULT_MAX ? s.slice(0, CHAT_RESULT_MAX) + '\n… (truncated)' : s;
}

function addToolRow(pane, key, part) {
  const c = pane.chat;
  upsertChatRow(pane, key, 'tool', (row) => {
    row.innerHTML =
      '<details class="chat-fold chat-tool"><summary>' +
      '<span class="chat-tool-name"></span> <span class="chat-tool-sum"></span>' +
      '</summary><pre class="chat-pre chat-tool-input"></pre>' +
      '<pre class="chat-pre chat-tool-result hidden"></pre></details>';
    row.querySelector('.chat-tool-name').textContent = part.name || 'tool';
    row.querySelector('.chat-tool-sum').textContent = toolSummary(part);
    let inputJson = '';
    try { inputJson = JSON.stringify(part.input || {}, null, 2); } catch (_) { /* ignore */ }
    row.querySelector('.chat-tool-input').textContent = clipResult(inputJson);
  });
  if (part.id) {
    c.toolByUseId.set(part.id, key);
    // The matching result can outrun the tool row on a backfill batch.
    const early = c.pendingResults.get(part.id);
    if (early) {
      c.pendingResults.delete(part.id);
      attachToolResult(pane, early.part, early.toolUseResult);
    }
  }
}

// AskUserQuestion is a prompt *for the human*, not plumbing — render it as a
// full card (question, options) instead of a collapsed tool fold. Clicking an
// option presses its number in the hidden TUI, the same quick-key path the
// attention banner uses; the card greys out once the answer's tool_result
// lands. While the answer is outstanding the tool_use id sits in
// pendingQuestions, which drives the pane's "needs you" state.
function addQuestionRow(pane, key, part) {
  const c = pane.chat;
  // A real tool_use from the transcript supersedes the screen-parsed stand-in
  // (it only lands once the question was answered and the menu left the
  // screen). Stamp the supersede so a probe tick racing one last repaint of
  // the answered menu can't resurrect the stand-in (syncScreenQuestion).
  if (part.id && part.id.indexOf('screenq:') !== 0) {
    if (c.screenQSig) { c.screenQSupSig = c.screenQSig; c.screenQSupAt = Date.now(); }
    removeScreenQuestion(pane);
  }
  const questions = part.input.questions.filter((q) => q && typeof q === 'object');
  const isScreenCard = !!(part.id && part.id.indexOf('screenq:') === 0);
  upsertChatRow(pane, key, 'prompt', (row) => {
    // The checked look is local echo of the digits this card sent — carry it
    // across a re-render (transcript re-emits) so clicks don't visually vanish.
    // Not for screen-parsed cards: there the TUI's own checkbox state is
    // authoritative, and the same row morphs into the review screen's card —
    // carrying the old highlights would pre-select "Submit answers".
    const prevSel = new Set(isScreenCard ? [] :
      [...row.querySelectorAll('.chat-question-opt.selected')].map((b) => b.dataset.opt));
    // Keep the plan fold's collapsed/expanded choice across re-renders (the
    // card re-renders when the plan content lands or changes).
    const prevFold = row.querySelector('.chat-plan-fold');
    const planFoldOpen = prevFold ? prevFold.open : true;
    row.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'chat-question';
    let anyMulti = false;
    questions.forEach((q, qi) => {
      anyMulti = anyMulti || !!q.multiSelect;
      const head = document.createElement('div');
      head.className = 'chat-question-head';
      if (q.header) {
        const chip = document.createElement('span');
        chip.className = 'chat-question-chip';
        chip.textContent = String(q.header);
        head.appendChild(chip);
      }
      const text = document.createElement('span');
      text.className = 'chat-question-text';
      text.textContent = String(q.question || '');
      head.appendChild(text);
      card.appendChild(head);
      // A plan-approval card carries the plan itself — rendered as markdown
      // in a collapsible fold above the options, with the whole review
      // experience embedded: comment highlights, highlight-to-comment, the
      // comment rail, and Request changes (see "Chat-card plan review").
      if (typeof q.planMd === 'string' && q.planMd.trim()) {
        const fold = document.createElement('details');
        fold.className = 'chat-plan-fold';
        fold.open = planFoldOpen;
        const sum = document.createElement('summary');
        const heading = /^#{1,3}\s+(.+)$/m.exec(q.planMd);
        sum.textContent = '📋 ' + (heading ? heading[1].trim() : 'The plan');
        fold.appendChild(sum);
        buildCardPlanReview(pane, fold, q.planMd);
        card.appendChild(fold);
      }
      const opts = document.createElement('div');
      opts.className = 'chat-question-options';
      (Array.isArray(q.options) ? q.options : []).forEach((o, i) => {
        const label = typeof o === 'string' ? o : String((o && o.label) || '');
        const btn = document.createElement('button');
        btn.className = 'chat-question-opt';
        btn.dataset.opt = qi + ':' + i;
        // Screen-parsed options carry the TUI's own checkbox state — that's
        // authoritative (this card re-renders whenever it changes). Transcript
        // options don't, so the local click echo is all there is.
        const hasChecked = typeof o === 'object' && o && typeof o.checked === 'boolean';
        if (hasChecked ? o.checked : prevSel.has(btn.dataset.opt)) {
          btn.classList.add('selected');
        }
        if (q.multiSelect) {
          const box = document.createElement('span');
          box.className = 'chat-question-check';
          btn.appendChild(box);
        }
        const num = document.createElement('span');
        num.className = 'chat-question-num';
        num.textContent = (i + 1) + '.';
        const body = document.createElement('span');
        body.className = 'chat-question-optbody';
        const lbl = document.createElement('span');
        lbl.className = 'chat-question-label';
        lbl.textContent = label;
        body.appendChild(lbl);
        const desc = typeof o === 'object' && o && o.description ? String(o.description) : '';
        if (desc) {
          const d = document.createElement('span');
          d.className = 'chat-question-desc';
          d.textContent = desc;
          body.appendChild(d);
        }
        btn.append(num, body);
        if (i >= 9) {
          // "10" is two keystrokes — the first would answer a single-select
          // menu as option 1 and leak a stray "0" into whatever follows.
          btn.disabled = true;
          btn.title = `Option ${i + 1} — answer in the terminal (digit keys stop at 9)`;
        } else {
          btn.title = q.multiSelect
            ? `Toggle "${label}" — presses ${i + 1} in the hidden terminal`
            : `Answer "${label}" — presses ${i + 1} in the hidden terminal`;
        }
        btn.onclick = (e) => {
          e.stopPropagation();
          if (c.viewingHistory || card.classList.contains('answered') || card.dataset.sent ||
              pane.state === 'dead' || pane.state === 'error') return;
          // Send only when the live screen still shows this menu — screen
          // cards verify the full shape, transcript cards (whose menu content
          // is the tool input, not the screen) settle for a menu being up.
          if (isScreenCard ? !cardMenuLive(pane, q) : !menuOnScreen(screenText(pane))) return;
          // Mirror the toggle locally — the TUI checks/unchecks out of sight.
          if (q.multiSelect) btn.classList.toggle('selected');
          else {
            [...opts.children].forEach((x) => x.classList.remove('selected'));
            btn.classList.add('selected');
            // A single-select answers on the digit — one shot. Self-expire in
            // case the keystroke was swallowed and the menu never advanced.
            card.dataset.sent = '1';
            setTimeout(() => { delete card.dataset.sent; }, 2500);
          }
          sendToPane(pane, String(i + 1));
        };
        opts.appendChild(btn);
      });
      card.appendChild(opts);
    });
    const foot = document.createElement('div');
    foot.className = 'chat-question-foot';
    const hint = document.createElement('span');
    hint.className = 'chat-question-hint';
    hint.textContent = anyMulti
      ? 'Multi-select — click options to toggle, then Review to submit. Custom answers need the terminal.'
      : 'Click an option to answer. For a custom answer, open the terminal.';
    foot.appendChild(hint);
    if (anyMulti) {
      // Enter no longer submits a multi-select (it toggles the highlighted
      // option) — Tab moves to the Submit tab, whose review screen then
      // appears as its own card with a "Submit answers" option.
      const review = document.createElement('button');
      review.className = 'chat-question-key';
      review.textContent = 'Review ⇥';
      review.title = 'Press Tab in the hidden terminal (open the review step, then click Submit answers)';
      review.onclick = (e) => {
        e.stopPropagation();
        if (c.viewingHistory || card.classList.contains('answered') ||
            pane.state === 'dead' || pane.state === 'error') return;
        // Same staleness rule as the option buttons — a Tab into a menu that
        // already advanced lands in the next screen.
        if (isScreenCard ? !cardMenuLive(pane, questions[0])
                         : !menuOnScreen(screenText(pane))) return;
        sendToPane(pane, '\t');
      };
      foot.appendChild(review);
    }
    if (questions.some((q) => q.planReview)) {
      // Comments and request-changes live on the card itself now — this just
      // offers the same review as a full window for reading room.
      const planBtn = document.createElement('button');
      planBtn.className = 'chat-question-key';
      planBtn.textContent = '📋 Open as window';
      planBtn.title = 'Open this plan review in its own window — same plan, comments, and actions';
      planBtn.onclick = (e) => { e.stopPropagation(); openPlanReview(pane); };
      foot.appendChild(planBtn);
    }
    const openTerm = document.createElement('button');
    openTerm.className = 'chat-question-key';
    openTerm.textContent = 'Open terminal';
    openTerm.onclick = (e) => { e.stopPropagation(); setPaneView(pane, 'term'); };
    foot.appendChild(openTerm);
    card.appendChild(foot);
    const answer = document.createElement('pre');
    answer.className = 'chat-question-answer hidden';
    card.appendChild(answer);
    row.appendChild(card);
  });
  if (part.id) {
    c.toolByUseId.set(part.id, key);
    if (!c.viewingHistory) {
      const brief = String((questions[0] && questions[0].question) || 'Claude is asking a question')
        .replace(/\s+/g, ' ').trim().slice(0, 200);
      c.pendingQuestions.set(part.id, brief);
      updateChatBanner(pane);
    }
    const early = c.pendingResults.get(part.id);
    if (early) {
      c.pendingResults.delete(part.id);
      attachToolResult(pane, early.part, early.toolUseResult);
    }
  }
}

function attachToolResult(pane, part, toolUseResult) {
  const c = pane.chat;
  const key = c.toolByUseId.get(part.tool_use_id);
  if (!key) {
    c.pendingResults.set(part.tool_use_id, { part, toolUseResult });
    return;
  }
  const row = c.byKey.get(key);
  if (!row) return;
  let text = '';
  if (typeof part.content === 'string') text = part.content;
  else if (Array.isArray(part.content)) {
    text = part.content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text).join('\n');
  }
  if (!text && toolUseResult) {
    text = typeof toolUseResult === 'string' ? toolUseResult : safeJson(toolUseResult);
  }
  const card = row.querySelector('.chat-question');
  if (card) {
    if (c.pendingQuestions.delete(part.tool_use_id)) updateChatBanner(pane);
    card.classList.add('answered');
    const ans = card.querySelector('.chat-question-answer');
    if (ans) {
      ans.textContent = clipResult(text || '(answered)');
      ans.classList.remove('hidden');
    }
    row.classList.toggle('tool-error', !!part.is_error);
    return;
  }
  const out = row.querySelector('.chat-tool-result');
  if (!out) return;
  out.textContent = clipResult(text || '(no output)');
  out.classList.remove('hidden');
  row.classList.toggle('tool-error', !!part.is_error);
}

function safeJson(v) {
  try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
}

// -- Composer ------------------------------------------------------------------

// Recall previously-sent messages in the composer with ↑/↓, shell-style.
// dir: -1 = older, +1 = newer. Returns true when it consumed the keypress.
// Only hijacks the arrow when it can't usefully move the caret in the textarea
// (↑ on the first line, ↓ on the last), so multi-line editing still works.
function chatHistoryNav(pane, dir) {
  const c = pane.chat;
  if (!c || c.viewingHistory || !c.history.length) return false;
  const input = c.input;
  const val = input.value;
  const pos = input.selectionStart;
  if (dir < 0) {
    if (val.slice(0, pos).includes('\n')) return false; // caret not on first line
  } else {
    if (val.slice(pos).includes('\n')) return false;    // caret not on last line
  }
  if (c.histIdx === null) {
    if (dir > 0) return false;          // nothing newer than the live draft
    c.histDraft = val;                  // stash the in-progress draft
    c.histIdx = c.history.length;
  }
  const idx = c.histIdx + dir;
  if (idx >= c.history.length) {
    // Stepped past the newest entry — restore the stashed draft.
    c.histIdx = null;
    input.value = c.histDraft;
  } else {
    c.histIdx = Math.max(0, idx);
    input.value = c.history[c.histIdx];
  }
  autosizeComposer(input);
  const end = input.value.length;
  input.setSelectionRange(end, end);
  return true;
}

function sendChatMessage(pane) {
  const c = pane.chat;
  if (!c) return;
  // A prompt is waiting in the terminal — a typed line won't reach it (the TUI
  // wants a menu keypress), so the composer is locked; ignore stray sends too.
  if (pane.state === 'attention' && !c.viewingHistory) return;
  const raw = c.input.value.replace(/\r\n?/g, '\n');
  let text = raw.trim();
  if (!text && !c.attachments.length) return;
  // Learn from fixes the user made to dictated text before sending (covers
  // both the command path below and ordinary messages).
  voiceLearnHarvest(c.input, text);
  // A message addressed to Hivemind itself ("Hivemind, open a new thread…")
  // is an app command — run it instead of sending it to the thread. Anything
  // starting with the wake word is consumed (unrecognized commands toast an
  // error); mentioning Hivemind mid-sentence sends as a normal message.
  const hmCmd = matchHivemindCommand(text);
  // A message starting with "todo" is a checklist entry for the Todo panel,
  // handled by Hivemind itself — same swallow-and-clear path as app commands.
  const todoText = hmCmd === null ? matchTodoPrefix(text) : null;
  if (hmCmd !== null || todoText !== null) {
    if (todoText !== null) captureTodo(todoText);
    else runHivemindCommand(hmCmd, pane);
    if (text && c.history[c.history.length - 1] !== text) {
      c.history.push(text);
      if (c.history.length > 200) c.history.shift();
    }
    c.histIdx = null;
    c.histDraft = '';
    c.input.value = '';
    autosizeComposer(c.input);
    if (c.ac) c.ac.hide();
    return;
  }
  // The thread's process has exited — there's no live PTY to receive a message,
  // so delivering it would silently drop the text (and leave a fake "pending"
  // echo). Keep the composer contents and tell the user to restart. (Sends from
  // the history view are allowed: they respawn the thread via --resume.)
  if (pane.state === 'dead' && !c.viewingHistory) {
    hmToast('This thread has exited — restart it before sending a message.', 'err');
    return;
  }
  const typed = text; // the user's typed text, recallable later with ↑
  // Attachments ride along as quoted paths appended to the message — except
  // images on codex threads, which are handed to typePrompt to paste as real
  // image attachments (the Codex model can't view an image from a path in
  // message text; only files ride along as paths there).
  let images = [];
  if (c.attachments.length) {
    const attached = pane.agent === 'codex' ? c.attachments.filter((a) => a.isImage) : [];
    images = attached.map((a) => a.path);
    const paths = c.attachments.filter((a) => !attached.includes(a))
      .map((a) => quotePath(a.path)).join(' ');
    if (paths) text = text ? text + '\n' + paths : paths;
    for (const a of c.attachments) {
      if (a.thumbUrl && a.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(a.thumbUrl);
    }
    c.attachments.length = 0;
    renderChatAttachments(pane);
  }
  c.input.value = '';
  autosizeComposer(c.input);
  if (c.ac) c.ac.hide();
  // Record for ↑/↓ recall, skipping consecutive duplicates; cap the backlog.
  if (typed && c.history[c.history.length - 1] !== typed) {
    c.history.push(typed);
    if (c.history.length > 200) c.history.shift();
  }
  c.histIdx = null;
  c.histDraft = '';
  // Sending while viewing a past conversation continues *that* conversation:
  // the thread restarts on it (claude --resume <session>) with this message.
  recordPromptHistory(typed, pane.agent); // per-hive Prompt History panel
  if (c.viewingHistory && c.historySession) {
    continueHistorySession(pane, c.historySession, text);
    return;
  }
  deliverPrompt(pane, text, images);
}

// Continue a past conversation from the history view: restart the thread's
// claude resuming that session, delivering the typed message as the CLI
// prompt (the only safe delivery at spawn time — see spawnPty). Claude Code
// keeps writing under the resumed session id, so the rebuilt chat view binds
// to that exact file and backfills — past messages plus the new turn.
function continueHistorySession(pane, sess, text) {
  const id = String(sess.name || '').replace(/\.jsonl$/i, '');
  if (pane.agent !== 'claude' || !/^[a-zA-Z0-9-]+$/.test(id)) {
    // Not resumable (custom agent / odd filename) — fall back to the live chat.
    exitHistory(pane);
    if (text) deliverPrompt(pane, text);
    return;
  }
  respawnPane(pane, { resume: id, initialPrompt: text });
}

// Optimistic echo: show the message immediately; the transcript's real user
// line replaces it (confirmEcho) when it lands.
function addEchoRow(pane, text) {
  const c = pane.chat;
  const key = 'echo:' + (++c.echoSeq);
  upsertChatRow(pane, key, 'user', (row) => {
    row.innerHTML = '<div class="chat-bubble user pending"></div>';
    row.firstChild.textContent = text;
    if (pane.state === 'busy') {
      const note = document.createElement('div');
      note.className = 'chat-echo-note';
      note.textContent = 'queued — thread is working…';
      row.firstChild.appendChild(note);
    }
  });
  c.pendingEcho.push({ key, text });
  c.pinned = true;
  c.list.scrollTop = c.list.scrollHeight;
}

function confirmEcho(pane, text) {
  const c = pane.chat;
  if (!c.pendingEcho.length) return;
  let i = c.pendingEcho.findIndex((p) => p.text === String(text).trim());
  if (i === -1) i = 0; // the TUI can reshape the text slightly — this real user
                       // line still corresponds to the oldest unconfirmed send
  const [p] = c.pendingEcho.splice(i, 1);
  const row = c.byKey.get(p.key);
  if (row) row.remove();
  c.byKey.delete(p.key);
}

// -- Attention: inline prompt card + composer lock ---------------------------

// Stable row key for the inline prompt card, and the placeholder shown while
// the composer is locked because the terminal is waiting on a prompt.
const PROMPT_CARD_KEY = 'attn-prompt';
const PROMPT_LOCK_PLACEHOLDER =
  'Answer the prompt above to continue — open the terminal to type a custom reply';

// The text shown in the inline prompt card: the process-exit note, the last
// error lines, or the prompt scraped from the visible screen (starting at the
// line the attention scan matched, so a menu/approval's options follow the
// header rather than trailing the spinner line above them — unless that line
// is the select-menu footer itself, where the content sits above it).
function promptCardText(pane, state) {
  if (state === 'dead') return 'The process behind this thread exited.';
  if (state === 'error') {
    if (pane.errorText) return pane.errorText;
    const lines = (pane.buf || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(-3);
    return lines.join('\n') || 'The thread hit an error.';
  }
  const lines = screenText(pane).split('\n').map((s) => s.trim()).filter(Boolean);
  const i = lines.findIndex((l) =>
    MENU_PATTERNS.some((re) => re.test(l)) || QUESTION_PATTERNS.some((re) => re.test(l)));
  let block;
  if (i < 0) {
    block = lines.slice(-3);
  } else if (SELECT_FOOTER_RE.test(lines[i])) {
    // Only the footer chrome matched — a menu the structured parsers couldn't
    // handle (e.g. codex's usage menu numbers only its enabled option) sits
    // *above* that line; slicing downward would show nothing but the chrome.
    // The footer's own keys are already the card's buttons.
    block = lines.slice(Math.max(0, i - 8), i);
    if (!block.length) block = [lines[i]];
  } else {
    block = lines.slice(i, i + 6);
  }
  return block.join('\n') || 'The thread needs your input.';
}

// Surface the hidden TUI's prompt (permission/menu/error/exit) as an inline
// card in the message flow — the same embedded look as a question card, rather
// than a separate banner strip. Quick keys and Open terminal act on the PTY.
function renderPromptCard(pane, state) {
  const c = pane.chat;
  const isErr = state === 'error' || state === 'dead';
  const text = promptCardText(pane, state);
  const row = upsertChatRow(pane, PROMPT_CARD_KEY, 'prompt', (r) => {
    r.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'chat-prompt-card' + (isErr ? ' error' : '');
    const body = document.createElement('pre');
    body.className = 'chat-prompt-text';
    body.textContent = text;
    card.appendChild(body);
    const foot = document.createElement('div');
    foot.className = 'chat-prompt-foot';
    // Errors and process exits have nothing to answer — only offer the terminal.
    if (!isErr) {
      const keys = document.createElement('span');
      keys.className = 'chat-prompt-keys';
      // Digit keys only make sense on a numbered menu — a prose "(y/n)" or
      // "press enter" prompt would receive digits it never asked for.
      const menuKeys = menuOnScreen(screenText(pane));
      for (const [label, seq, hint] of [
        ...(menuKeys ? [['1', '1', 'Choose option 1'], ['2', '2', 'Choose option 2']] : []),
        ['Enter', '\r', 'Press Enter'],
        ['Esc', '\x1b', 'Press Escape'],
      ]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = `${hint} in the hidden terminal`;
        b.onclick = (e) => {
          e.stopPropagation();
          // This card lags the screen by up to a probe tick — only actuate
          // while the pane still reads attention AND a prompt is actually on
          // screen; a stale Enter/Esc would land in a live turn.
          if (c.viewingHistory || pane.state !== 'attention') return;
          if (!promptVisibleOnScreen(screenText(pane))) {
            removePromptCard(pane);
            return;
          }
          sendToPane(pane, seq);
        };
        keys.appendChild(b);
      }
      foot.appendChild(keys);
    }
    const openTerm = document.createElement('button');
    openTerm.className = 'chat-prompt-open';
    openTerm.textContent = 'Open terminal';
    openTerm.onclick = (e) => { e.stopPropagation(); setPaneView(pane, 'term'); };
    foot.appendChild(openTerm);
    card.appendChild(foot);
    r.appendChild(card);
  });
  // Keep the card trailing the newest message, just above the working swirl.
  c.list.insertBefore(row, c.working);
  if (c.pinned) c.list.scrollTop = c.list.scrollHeight;
}

function removePromptCard(pane) {
  const c = pane.chat;
  const row = c.byKey.get(PROMPT_CARD_KEY);
  if (row) { row.remove(); c.byKey.delete(PROMPT_CARD_KEY); }
}

// Lock the composer while the thread is waiting on a prompt: text typed there
// would never reach the TUI (which wants a menu keypress, not a pasted line),
// so disable it and point the user at the card's keys or the terminal. History
// mode owns the composer itself, so it never locks — and keeps its own
// placeholder (updateHistoryChrome).
function updateComposerLock(pane) {
  const c = pane.chat;
  if (!c) return;
  const locked = pane.state === 'attention' && !c.viewingHistory;
  c.input.disabled = locked;
  c.sendBtn.disabled = locked;
  c.wrap.classList.toggle('composer-locked', locked);
  if (c.viewingHistory) return;
  c.input.placeholder = locked ? PROMPT_LOCK_PLACEHOLDER : CHAT_PLACEHOLDER;
}

// Mirror the pane's heuristic state into the chat view: when the hidden TUI is
// waiting on a prompt (or errored/exited), surface it as an inline card and
// lock the composer. A recognized question already renders as its own inline
// card, so skip the generic prompt card there to avoid doubling up.
function updateChatBanner(pane) {
  const c = pane.chat;
  if (!c) return;
  updateComposerLock(pane);
  // While browsing history the swirl and prompt card don't apply to the (past,
  // finished) conversation on screen — keep them hidden.
  if (c.viewingHistory) {
    c.working.classList.add('hidden');
    removePromptCard(pane);
    return;
  }
  const state = pane.state;
  const wasHidden = c.working.classList.contains('hidden');
  c.working.classList.toggle('hidden', state !== 'busy');
  // The swirl sits under the last message; when it appears, keep a pinned
  // view scrolled to the bottom so it's actually visible.
  if (wasHidden && state === 'busy' && c.pinned) c.list.scrollTop = c.list.scrollHeight;
  const show = state === 'attention' || state === 'error' || state === 'dead';
  // The exited-process card must never be suppressed by a question that can
  // no longer be answered (death also clears pendingQuestions — this is
  // belt-and-braces for ordering).
  if (!show || (state !== 'dead' && chatHasPendingQuestion(pane))) { removePromptCard(pane); return; }
  // In the two-tick window after a menu leaves the screen the state still
  // reads 'attention' but there's nothing to answer — a card rendered now
  // would show spinner chrome with live keys.
  if (state === 'attention' && !promptVisibleOnScreen(screenText(pane))) {
    removePromptCard(pane);
    return;
  }
  renderPromptCard(pane, state);
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

// -- Sidebar resizing -------------------------------------------------------
// Drag the divider between the sidebar and the workspace to set the sidebar
// width; the docked Explorer/Git/Todo panels resize with it. Width is clamped
// to the CSS min/max and remembered across restarts. Double-click resets it.
const SIDEBAR_W_MIN = 180;
const SIDEBAR_W_MAX = 600;
const SIDEBAR_W_DEFAULT = 230;
(() => {
  const sidebar = $('sidebar');
  const handle = $('sidebar-resizer');
  if (!sidebar || !handle) return;

  const clampW = (w) => Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX, w));
  const applyW = (w, persist = true) => {
    const cw = clampW(w);
    sidebar.style.width = cw + 'px';
    if (persist) localStorage.setItem('hm.sidebarWidth', String(cw));
  };

  const saved = parseInt(localStorage.getItem('hm.sidebarWidth'), 10);
  if (Number.isFinite(saved)) applyW(saved, false);

  let startX = 0;
  let startW = 0;
  const refit = () => { if (typeof fitBoard === 'function' && activeBoardId) fitBoard(activeBoardId); };
  const onMove = (e) => { applyW(startW + (e.clientX - startX)); refit(); };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    handle.classList.remove('dragging');
    document.body.classList.remove('col-resizing');
    localStorage.setItem('hm.sidebarWidth', String(Math.round(sidebar.getBoundingClientRect().width)));
    refit();
  };
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.classList.add('col-resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('dblclick', () => { applyW(SIDEBAR_W_DEFAULT); refit(); });
})();

const boardListEl = $('board-list');
const gridEl = $('grid');
const emptyState = $('empty-state');
const boardTitle = $('board-title');
const boardMeta = $('board-meta');
const addTermBtn = $('add-term');
const buildBtn = $('build-portable');
const BUILD_BTN_TEXT = buildBtn ? buildBtn.textContent : '';
const BUILD_BTN_TITLE = buildBtn ? buildBtn.title : '';

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
async function persist() {
  await window.api.saveBoards(boards.map((b) => ({
    id: b.id, name: b.name, dir: b.dir, startupCommand: b.startupCommand,
    resumeOnStart: !!b.resumeOnStart, muted: !!b.muted,
    layout: grids.has(b.id) ? serializeLayout(b.id) : (b.layout || null),
  })));
}

// Capture the live grid (columns, splits, per-pane name/model/font) so a board's
// whole workspace can be rebuilt on next launch. PTYs aren't serializable — only
// the shape and thread metadata are saved.
function serializeLayout(boardId) {
  const g = grids.get(boardId);
  if (!g) return null;
  const cols = g.columns.map((col) => ({
    flex: col.flex,
    panes: col.panes.filter((p) => !p.disposed).map((p) => ({
      name: p.name, agent: p.agent, model: p.model, codexModel: p.codexModel, perm: p.permMode, fontSize: p.fontSize,
      flex: p.flex, caption: p.captionText || '', autoName: !!p.autoName,
      planId: p.planId || undefined, // stable per-thread key for ⟳-requested plans
      planFile: (p.plan && p.plan.file) || undefined,     // last known plan file (plan review)
      planSource: (p.plan && p.plan.source) || undefined, // 'native' | 'hivemind'
      // This thread's Claude session (resume-on-start). Only once the session
      // file exists — fresh threads pre-generate an id for --session-id, and
      // resuming an id claude never wrote dies with "No conversation found".
      sessionId: (p.sessionBound && p.sessionId) || undefined,
      view: p.view, chatFilters: p.chatFilters,
    })),
  })).filter((c) => c.panes.length);
  return cols.length ? cols : null;
}

// Update one board's saved layout from its live grid, then persist everything.
function persistLayout(boardId) {
  const b = boards.find((x) => x.id === boardId);
  if (b && grids.has(boardId)) b.layout = serializeLayout(boardId);
  persist();
}

// Recreate a board's columns/panes from a saved layout. Threads start fresh
// (with `claude --continue` when the board opts into resume).
function rebuildFromLayout(board) {
  const g = grids.get(board.id);
  if (!g) return;
  let maxNum = 0;
  for (const col of board.layout) {
    const colObj = { el: document.createElement('div'), flex: col.flex || 1, panes: [] };
    colObj.el.className = 'column';
    g.columns.push(colObj);
    for (const pd of (col.panes || [])) {
      // Layouts saved before autoName existed: treat a "<cmd> <n>" name as auto.
      const agent = isValidAgent(pd.agent) ? pd.agent : 'claude';
      const cmd = agent === 'claude' ? (board.startupCommand || 'claude') : agentFor(agent).command;
      const looksAuto = new RegExp('^' + cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\d+$').test(pd.name || '');
      const autoName = pd.autoName !== undefined ? pd.autoName : looksAuto;
      const pane = createPane(board, colObj, {
        name: pd.name, agent, model: pd.model, codexModel: pd.codexModel, perm: pd.perm, fontSize: pd.fontSize,
        flex: pd.flex, caption: pd.caption, autoName, planId: pd.planId,
        planFile: pd.planFile, planSource: pd.planSource,
        sessionId: pd.sessionId, view: pd.view, chatFilters: pd.chatFilters,
      });
      colObj.panes.push(pane);
      const m = /(\d+)\s*$/.exec(pd.name || '');
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
  }
  board._seq = maxNum;
  layout(board.id);
  // Panes are attached now — spawn each PTY at its real size. Resume-on-start
  // reopens each thread's own saved session (`--resume <id>`); `--continue`
  // (most recent session in the directory — wrong thread when several share
  // it) remains only for layouts saved before session ids were tracked.
  for (const col of g.columns) {
    for (const pane of col.panes) {
      spawnPanePty(pane, {
        resume: board.resumeOnStart ? (pane.sessionId || true) : false,
      });
    }
  }
  const first = g.columns[0] && g.columns[0].panes[0];
  if (first) focusPane(first);
}

// ---------------------------------------------------------------------------
// Board list rendering
// ---------------------------------------------------------------------------
function renderBoardList() {
  boardListEl.innerHTML = '';
  for (const b of boards) {
    const li = document.createElement('li');
    li.className = 'board-item' + (b.id === activeBoardId ? ' active' : '');
    li.dataset.id = b.id;

    const row = document.createElement('div');
    row.className = 'row';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'name-wrap';
    const sdot = document.createElement('span');
    sdot.className = 'status-dot none';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = b.name;
    nameWrap.append(sdot, name);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.title = 'Threads waiting for you';

    const actions = document.createElement('div');
    actions.className = 'actions';
    const edit = document.createElement('button');
    edit.textContent = '✎';
    edit.title = 'Edit hive';
    edit.onclick = (e) => { e.stopPropagation(); openModal(b); };
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.title = 'Delete hive';
    del.onclick = (e) => { e.stopPropagation(); deleteBoard(b); };
    actions.append(edit, del);
    row.append(nameWrap, badge, actions);

    const dir = document.createElement('div');
    dir.className = 'dir';
    dir.textContent = b.dir || '(no directory)';
    dir.title = b.dir || '';

    li.append(row, dir);
    li.onclick = () => selectBoard(b.id);

    // Drag to reorder hives.
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      dragBoardId = b.id;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      if (!dragBoardId || dragBoardId === b.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drop-target');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drop-target');
      reorderBoards(dragBoardId, b.id);
      dragBoardId = null;
    });

    boardListEl.appendChild(li);
  }
  // Repaint status dots / badges for any board that already has terminals.
  for (const b of boards) updateBoardStatus(b.id);
}

// Reorder: drop the dragged hive into the target hive's slot, then persist.
let dragBoardId = null;
function reorderBoards(srcId, targetId) {
  if (!srcId || srcId === targetId) return;
  const from = boards.findIndex((b) => b.id === srcId);
  const to = boards.findIndex((b) => b.id === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = boards.splice(from, 1);
  boards.splice(to, 0, moved);
  persist();
  renderBoardList();
}

// ---------------------------------------------------------------------------
// Board selection / switching (PTYs stay alive in the background)
// ---------------------------------------------------------------------------
function selectBoard(id) {
  activeBoardId = id;
  const board = boards.find((b) => b.id === id);
  if (!board) return;

  emptyState.classList.add('hidden');
  gridEl.classList.remove('hidden');
  addTermBtn.disabled = false;
  if (typeof voiceToggleBtn !== 'undefined' && voiceToggleBtn) voiceToggleBtn.disabled = false;

  boardTitle.textContent = board.name;
  boardMeta.textContent = board.dir || '';

  // Watch this board's directory so the Git/Files panels can auto-refresh.
  window.api.setWatch(board.dir || null);

  // Show the active grid, hide the rest — BEFORE building a new grid, so pane
  // measurements during the build see the full workspace width (a still-visible
  // previous grid would flex-share the row and halve it).
  for (const [bid, g] of grids) {
    g.el.style.display = bid === id ? 'flex' : 'none';
  }

  // Build the grid lazily the first time a board is opened.
  if (!grids.has(id)) {
    const g = { el: document.createElement('div'), columns: [] };
    g.el.className = 'board-grid';
    g.el.style.cssText = 'display:flex;flex:1;min-height:0;min-width:0;width:100%;';
    gridEl.appendChild(g.el);
    grids.set(id, g);
    if (board.layout && board.layout.length) {
      rebuildFromLayout(board); // restore last session's threads + splits
    } else {
      addTerminal(board); // open the first terminal automatically
    }
  }
  renderBoardList();
  if (typeof gitToggle !== 'undefined' && gitToggle) gitToggle.disabled = false;
  if (typeof gitOnBoardChange === 'function') gitOnBoardChange();
  if (typeof filesToggle !== 'undefined' && filesToggle) filesToggle.disabled = false;
  if (typeof filesOnBoardChange === 'function') filesOnBoardChange();
  if (typeof todoToggle !== 'undefined' && todoToggle) todoToggle.disabled = false;
  if (typeof todoOnBoardChange === 'function') todoOnBoardChange();
  if (typeof historyToggle !== 'undefined' && historyToggle) historyToggle.disabled = false;
  if (typeof historyOnBoardChange === 'function') historyOnBoardChange();
  fitBoard(id);
}

// ---------------------------------------------------------------------------
// Layout: columns -> panes, rebuilt with gutters whenever structure changes
// ---------------------------------------------------------------------------
function layout(boardId) {
  const g = grids.get(boardId);
  if (!g) return;
  g.el.innerHTML = '';

  // Zoom (tmux-style): if a pane is zoomed and still alive, show only it.
  if (g.zoomed && !g.zoomed.disposed) {
    const pane = g.zoomed;
    // A tab strip across the top surfaces the threads hidden behind the maximized
    // one — otherwise there's no sign they exist. Click a tab to maximize that one.
    const allPanes = g.columns.flatMap((c) => c.panes);
    if (allPanes.length > 1) {
      g.el.style.flexDirection = 'column';
      g.el.appendChild(buildZoomTabs(boardId, g, allPanes, pane));
    } else {
      g.el.style.flexDirection = '';
    }
    pane.el.style.flexGrow = 1;
    pane.el.style.flexBasis = '0';
    pane.el.classList.add('zoomed');
    g.el.appendChild(pane.el);
    fitBoard(boardId);
    return;
  }
  g.el.style.flexDirection = ''; // back to a row of columns
  if (g.zoomed) g.zoomed = null; // zoomed pane went away

  g.columns.forEach((col, ci) => {
    // Rebuild a column's inner pane list with row-gutters.
    col.el.innerHTML = '';
    col.el.style.flexGrow = col.flex;
    col.el.style.flexBasis = '0';
    col.panes.forEach((pane, pi) => {
      pane.el.style.flexGrow = pane.flex;
      pane.el.style.flexBasis = '0';
      col.el.appendChild(pane.el);
      if (pi < col.panes.length - 1) {
        col.el.appendChild(makeGutter('row', boardId, ci, pi));
      }
    });
    g.el.appendChild(col.el);
    if (ci < g.columns.length - 1) {
      g.el.appendChild(makeGutter('col', boardId, ci, null));
    }
  });
  fitBoard(boardId);
}

// Toggle a pane between maximized (fills the grid) and tiled. PTYs are never
// touched — only which elements are mounted — so background threads keep running.
function toggleZoom(pane) {
  if (!pane || pane.disposed) return;
  const g = grids.get(pane.board.id);
  if (!g) return;
  if (g.zoomed === pane) {
    g.zoomed = null;
    pane.el.classList.remove('zoomed');
  } else {
    if (g.zoomed) g.zoomed.el.classList.remove('zoomed');
    g.zoomed = pane;
  }
  layout(pane.board.id);
  focusPane(pane);
}

// The short label a thread shows in its header, tabs, and command toasts: its
// name ("Leo") — the caption lives in the chat top bar, not the label.
function paneLabel(pane) {
  return pane.name || (pane.captionText || '').trim() || 'thread';
}

// Build the tab strip shown above a maximized thread. One tab per thread on the
// board; the active tab is highlighted and each carries a status dot mirroring
// the thread's live state so background activity/errors are visible while zoomed.
function buildZoomTabs(boardId, g, allPanes, active) {
  const strip = document.createElement('div');
  strip.className = 'zoom-tabs';
  allPanes.forEach((p) => {
    const tab = document.createElement('button');
    tab.className = 'zoom-tab' + (p === active ? ' active' : '');
    const d = document.createElement('span');
    d.className = 'zoom-tab-dot ' + (p.state || '') + (p.doneGlow ? ' done' : '');
    const label = document.createElement('span');
    label.className = 'zoom-tab-label';
    label.textContent = paneLabel(p);
    tab.__pane = p; d.__pane = p; label.__pane = p;
    tab.append(d, label);
    tab.title = paneLabel(p);
    tab.onmousedown = (e) => e.stopPropagation();
    tab.onclick = (e) => {
      e.stopPropagation();
      if (p === g.zoomed) return;
      if (g.zoomed) g.zoomed.el.classList.remove('zoomed');
      g.zoomed = p;
      layout(boardId);
      focusPane(p);
    };
    strip.appendChild(tab);
  });
  return strip;
}

// Keep a maximized board's tab strip in sync with live thread state/labels
// without rebuilding the whole layout.
function refreshZoomTabs(boardId) {
  const g = grids.get(boardId);
  if (!g || !g.zoomed) return;
  const strip = g.el.querySelector('.zoom-tabs');
  if (!strip) return;
  strip.querySelectorAll('.zoom-tab-dot').forEach((d) => {
    if (d.__pane) d.className = 'zoom-tab-dot ' + (d.__pane.state || '') + (d.__pane.doneGlow ? ' done' : '');
  });
  strip.querySelectorAll('.zoom-tab-label').forEach((l) => {
    if (l.__pane) { l.textContent = paneLabel(l.__pane); l.parentElement.title = paneLabel(l.__pane); }
  });
}

function makeGutter(kind, boardId, index, subIndex) {
  const el = document.createElement('div');
  el.className = kind === 'col' ? 'gutter-col' : 'gutter-row';
  el.addEventListener('mousedown', (e) => startDrag(e, kind, boardId, index, subIndex));
  return el;
}

// Drag a gutter: redistribute flex-grow between the two neighbours by pixels.
function startDrag(e, kind, boardId, index, subIndex) {
  e.preventDefault();
  const g = grids.get(boardId);
  if (!g) return;

  let a, b, totalPx, horizontal;
  if (kind === 'col') {
    a = g.columns[index];
    b = g.columns[index + 1];
    if (!a || !b) return;
    horizontal = true;
    totalPx = a.el.getBoundingClientRect().width + b.el.getBoundingClientRect().width;
  } else {
    const col = g.columns[index];
    a = col.panes[subIndex];
    b = col.panes[subIndex + 1];
    if (!a || !b) return;
    horizontal = false;
    totalPx = a.el.getBoundingClientRect().height + b.el.getBoundingClientRect().height;
  }

  const startPos = horizontal ? e.clientX : e.clientY;
  const flexSum = a.flex + b.flex;
  const startAPx = horizontal ? a.el.getBoundingClientRect().width : a.el.getBoundingClientRect().height;

  const onMove = (ev) => {
    const pos = horizontal ? ev.clientX : ev.clientY;
    let aPx = startAPx + (pos - startPos);
    aPx = Math.max(60, Math.min(totalPx - 60, aPx));
    a.flex = flexSum * (aPx / totalPx);
    b.flex = flexSum - a.flex;
    a.el.style.flexGrow = a.flex;
    b.el.style.flexGrow = b.flex;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
    fitBoard(boardId);
    persistLayout(boardId); // remember the new split sizes
  };
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ---------------------------------------------------------------------------
// Panes / terminals
// ---------------------------------------------------------------------------

// Every new thread gets a short random name ("Leo", "Nina") so Hivemind
// commands can address it — "tell Leo to…", "run the tests in Leo". Names are
// unique per hive; if the pool ever runs dry the old "<cmd> N" numbering
// takes over.
const PANE_NAMES = [
  'Leo', 'Nina', 'Ivy', 'Max', 'Ruby', 'Finn', 'Cleo', 'Zoe', 'Ace', 'Juno',
  'Milo', 'Kai', 'Nova', 'Remy', 'Sage', 'Otis', 'Wren', 'Enzo', 'Lila', 'Theo',
  'Gus', 'Iris', 'Jax', 'Luna', 'Moss', 'Nico', 'Opal', 'Pax', 'Rio', 'Skye',
  'Tess', 'Uma', 'Vera', 'Ash', 'Beau', 'Cora', 'Dax', 'Elle', 'Faye', 'Gwen',
  'Hugo', 'Kit', 'Mara', 'Nell', 'Pip', 'Quin', 'Rex', 'Suki', 'Tobi', 'Yara',
];
function pickPaneName(board) {
  const used = new Set(boardPanes(board).map((p) => (p.name || '').trim().toLowerCase()));
  const free = PANE_NAMES.filter((n) => !used.has(n.toLowerCase()));
  return free.length ? free[Math.floor(Math.random() * free.length)] : null;
}

function addTerminal(board, opts = {}) {
  const g = grids.get(board.id);
  if (!g) return;
  if (g.zoomed) { g.zoomed.el.classList.remove('zoomed'); g.zoomed = null; } // show the new pane

  // Tiling: grow columns up to 4 across, then stack into the shortest column.
  const total = g.columns.reduce((s, c) => s + c.panes.length, 0) + 1;
  const targetCols = Math.min(4, total);

  let col;
  if (g.columns.length < targetCols) {
    col = { el: document.createElement('div'), flex: 1, panes: [] };
    col.el.className = 'column';
    g.columns.push(col);
  } else {
    col = g.columns.reduce((min, c) => (c.panes.length < min.panes.length ? c : min), g.columns[0]);
  }

  if (!opts.name) {
    const nick = pickPaneName(board);
    if (nick) {
      // Not autoName: the name is how you address the thread, so it stays put
      // across agent switches and never gives way to the caption.
      opts = Object.assign({ name: nick }, opts);
    } else {
      board._seq = (board._seq || 0) + 1;
      const baseCmd = (opts.agent && opts.agent !== 'claude')
        ? agentFor(opts.agent).command
        : (board.startupCommand || 'claude');
      opts = Object.assign({ name: `${baseCmd} ${board._seq}`, autoName: true }, opts);
    }
  }
  const pane = createPane(board, col, opts);
  col.panes.push(pane);
  layout(board.id);
  focusPane(pane);
  spawnPanePty(pane, { resume: opts.resume, initialPrompt: opts.initialPrompt });
  persistLayout(board.id);
  return pane;
}

// Spawn a pane's PTY at the pane's true size. Must run after layout() has
// attached the pane to the DOM, and must stay synchronous: fit() forces a
// layout read that works even in a hidden window, whereas a deferred
// (requestAnimationFrame) re-fit is throttled when the window is occluded or
// starting up busy — it can then land after the 600ms startup delay, so Claude
// boots into an 80x24 PTY and the late ConPTY resize-reflow strands phantom
// characters at the start of the input line that can't be typed over or
// backspaced across.
function spawnPanePty(pane, { resume, initialPrompt } = {}) {
  try { pane.fitAddon.fit(); } catch (_) { /* keep xterm defaults */ }
  // Pin down which Claude Code session this pane owns, so the transcript
  // binder can claim `<sessionId>.jsonl` outright instead of pairing files to
  // panes by timing (which mixed threads up when several shared a directory):
  //   fresh spawn        → generate a UUID, start claude with --session-id
  //   resume <id string> → --resume <id>; claude reuses that same session id
  //   resume true        → --continue (id unknown until the binder finds the
  //                        file — legacy fallback, e.g. layouts saved before
  //                        session ids were tracked)
  if (pane.agent === 'claude') {
    if (isSessionId(resume)) pane.sessionId = resume;
    else pane.sessionId = resume ? null : newSessionId();
    // Resuming a known id means the session file exists on disk; a fresh (or
    // --continue) spawn hasn't created one yet — transcript entries arriving
    // (onEntries) flip this on once claude writes it.
    pane.sessionBound = isSessionId(resume);
  }
  window.api.spawnPty({
    id: pane.id,
    cwd: pane.board.dir,
    cols: pane.term.cols,
    rows: pane.term.rows,
    startupCommand: paneCommand(pane),
    model: pane.agent === 'claude' ? pane.model
         : pane.agent === 'codex' ? pane.codexModel
         : 'default',
    permissionMode: pane.agent === 'claude' ? pane.permMode : 'default',
    resume: resume || false, // true → --continue, session-id string → --resume <id>
    initialPrompt: ((pane.agent === 'claude' || pane.agent === 'codex') && initialPrompt) || undefined,
    sessionId: (pane.agent === 'claude' && !resume && pane.sessionId) || undefined,
  });
  // Transcript-backed chat (Claude, ChatGPT): bind this pane to the session
  // log its CLI is about to create (or, on resume, continue) for the board's
  // project directory. sessionId/resume are Claude concepts — codex binds by
  // rollout cwd + timing/first-message matching instead.
  if (transcriptSupported(pane)) {
    window.api.transcript.bind({
      paneId: pane.id, cwd: pane.board.dir,
      agent: pane.agent,
      resume: pane.agent === 'claude' && !!resume,
      sessionId: (pane.agent === 'claude' && pane.sessionId) || undefined,
    });
    // An initial prompt reaches claude as a CLI argument, not via the composer,
    // so report it to the binder ourselves — otherwise the new session file
    // can't be text-matched to this pane and can bind to another thread that's
    // still waiting in the same directory. Mirror main.js's normalization so
    // the noted text equals the transcript's first user message.
    if (initialPrompt) {
      const p = String(initialPrompt).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (p) window.api.transcript.noteSent(pane.id, p);
    }
  }
  markActivity(pane, ''); // start out "working" until the first quiet period
}

function createPane(board, col, opts = {}) {
  const id = nextId('term');
  const startAgent = isValidAgent(opts.agent) ? opts.agent : 'claude';
  const startName = opts.name ||
    (startAgent === 'claude' ? (board.startupCommand || 'claude') : agentFor(startAgent).command);
  const startModel = isValidModel(opts.model) ? opts.model : defaultModel;
  const startCodexModel = isValidCodexModel(opts.codexModel) ? opts.codexModel : defaultCodexModel;
  const startPerm = isValidPerm(opts.perm) ? opts.perm : defaultPerm;
  const startFont = opts.fontSize ? clampFont(opts.fontSize) : defaultFontSize;
  const el = document.createElement('div');
  el.className = 'pane';
  el.style.setProperty('--pane-font', startFont + 'px'); // chat view text scale

  const header = document.createElement('div');
  header.className = 'pane-header';
  const dot = document.createElement('span');
  dot.className = 'dot';

  // Editable thread name — double-click to rename so panes are distinguishable.
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = startName;
  title.title = 'Double-click to rename this thread';

  // Caption — a short summary of the last prompt sent to this thread, so you
  // can see what it's working on at a glance. Lives in the chat view's top
  // bar (left of 🕘 History, appended there in initChatUI), not the header —
  // the header title is the thread's name.
  const caption = document.createElement('span');
  caption.className = 'chat-caption';

  const titleWrap = document.createElement('span');
  titleWrap.className = 'title-wrap';
  titleWrap.append(title);

  const fontDownBtn = document.createElement('button');
  fontDownBtn.className = 'font-btn';
  fontDownBtn.textContent = 'A−';
  fontDownBtn.title = 'Smaller text (Ctrl+−)';
  const fontUpBtn = document.createElement('button');
  fontUpBtn.className = 'font-btn';
  fontUpBtn.textContent = 'A+';
  fontUpBtn.title = 'Bigger text (Ctrl+=)';
  const zoomBtn = document.createElement('button');
  zoomBtn.className = 'zoom-btn';
  zoomBtn.textContent = '⛶';
  zoomBtn.title = 'Maximize this thread (Ctrl+Enter)';
  const agentSelect = document.createElement('select');
  agentSelect.className = 'model-select agent-select';
  agentSelect.title = 'Agent for this thread (Claude, ChatGPT, or Gemini)';
  for (const a of AGENTS) {
    const opt = document.createElement('option');
    opt.value = a.value;
    opt.textContent = a.label;
    agentSelect.appendChild(opt);
  }
  agentSelect.value = startAgent;
  const modelSelect = document.createElement('select');
  modelSelect.className = 'model-select';
  modelSelect.title = 'Claude model for this thread';
  for (const m of MODELS) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = startModel;
  if (startAgent !== 'claude') modelSelect.style.display = 'none';
  // ChatGPT model this thread runs Codex with (see setPaneCodexModel).
  const codexModelSelect = document.createElement('select');
  codexModelSelect.className = 'model-select';
  codexModelSelect.title = 'ChatGPT model for this thread — changing it restarts the thread';
  for (const m of CODEX_MODELS) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    codexModelSelect.appendChild(opt);
  }
  codexModelSelect.value = startCodexModel;
  if (startAgent !== 'codex') codexModelSelect.style.display = 'none';
  // Permission mode this thread starts Claude Code in (see setPanePerm).
  const permSelect = document.createElement('select');
  permSelect.className = 'model-select perm-select';
  permSelect.title = 'Permission mode for this thread — changing it restarts the thread';
  for (const p of PERMS) {
    const opt = document.createElement('option');
    opt.value = p.value;
    opt.textContent = p.label;
    permSelect.appendChild(opt);
  }
  permSelect.value = startPerm;
  if (startAgent !== 'claude') permSelect.style.display = 'none';
  const statusEl = document.createElement('span');
  statusEl.className = 'status';
  // Estimated API-price cost of this conversation (Claude threads only —
  // see costIngest / renderPaneCost). Hidden until there's usage to price.
  const costEl = document.createElement('span');
  costEl.className = 'cost';
  costEl.style.display = 'none';
  // "📋 plan ready" chip — shown while this thread drafts a plan / waits on
  // plan approval; clicking it opens the plan review (see "Plan review").
  const planChip = document.createElement('button');
  planChip.className = 'pane-plan-chip hidden';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close thread';
  // Chat/terminal view toggle (Claude threads only — see initChatUI).
  const viewBtn = document.createElement('button');
  viewBtn.className = 'font-btn view-btn';
  header.append(dot, titleWrap, planChip, costEl, statusEl, agentSelect, modelSelect, codexModelSelect, permSelect, viewBtn, fontDownBtn, fontUpBtn, zoomBtn, closeBtn);

  const termWrap = document.createElement('div');
  termWrap.className = 'pane-term';

  // Per-pane find bar (Ctrl+F). Hidden until opened.
  const findBar = document.createElement('div');
  findBar.className = 'find-bar hidden';
  const findInput = document.createElement('input');
  findInput.type = 'text';
  findInput.placeholder = 'Find in scrollback…';
  findInput.spellcheck = false;
  const findPrev = document.createElement('button');
  findPrev.textContent = '↑'; findPrev.title = 'Previous (Shift+Enter)';
  const findNext = document.createElement('button');
  findNext.textContent = '↓'; findNext.title = 'Next (Enter)';
  const findClose = document.createElement('button');
  findClose.textContent = '✕'; findClose.title = 'Close (Esc)';
  findBar.append(findInput, findPrev, findNext, findClose);

  // The terminal and the chat overlay share a positioned body. The chat view
  // covers the terminal instead of replacing it (never display:none on the
  // terminal): the xterm keeps its real layout box, so fit()/ConPTY sizing
  // stay correct while hidden and revealing the terminal is instant.
  const body = document.createElement('div');
  body.className = 'pane-body';
  body.appendChild(termWrap);
  el.append(header, findBar, body);

  const term = new Terminal({
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: startFont,
    cursorBlink: true,
    allowProposedApi: true,
    theme: THEME,
    scrollback: 5000,
    // Tell xterm it's driven by ConPTY on Windows so its line-wrap/reflow model
    // matches the backend. Without this, full-screen TUIs that redraw with
    // absolute cursor moves (e.g. Codex / "ChatGPT") make the cursor bounce to
    // stale positions. Harmless/omitted off Windows.
    ...(window.api.platform === 'win32'
      ? { windowsPty: { backend: 'conpty', buildNumber: window.api.osBuild || undefined } }
      : {}),
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  // Scrollback search (optional — only if the addon loaded).
  let searchAddon = null;
  try {
    if (window.SearchAddon && window.SearchAddon.SearchAddon) {
      searchAddon = new window.SearchAddon.SearchAddon();
      term.loadAddon(searchAddon);
    }
  } catch (_) { /* search unavailable */ }
  term.open(termWrap);

  const pane = {
    id, el, term, fitAddon, searchAddon, dot, statusEl, costEl, planChip, agentSelect, modelSelect, codexModelSelect, permSelect, title, caption,
    findBar, findInput, viewBtn, flex: opts.flex || 1, col, board, disposed: false,
    name: startName, state: null, buf: '', idleTimer: null, probeTimer: null, menuMiss: 0,
    fontSize: startFont, agent: startAgent, model: startModel, codexModel: startCodexModel, permMode: startPerm, captionText: '', capBuf: '',
    errored: false, hintShown: false,
    // Cost-estimate accumulator (see costIngest). Rebuilt from transcript
    // backfill on every bind; costFile detects /clear session rollovers.
    costSeen: new Set(), costByModel: {}, costFile: null,
    planId: opts.planId || null, // assigned lazily the first time a ⟳ plan request needs it
    // Plan-review lifecycle (see the "Plan review" section). The file/source
    // survive restarts via the layout; the rest is rebuilt from transcript
    // backfill and the screen probe.
    plan: {
      state: 'none', file: opts.planFile || null, source: opts.planSource || null,
      menu: null, menuMiss: 0, exitIds: new Set(), exitPlanText: null,
      cardText: null, cardFetch: null,
      cardComments: null, cardCmtFetch: null, cardDraft: null, cardNote: '',
    },
    // Claude Code session id this pane owns. Set before spawn (fresh threads
    // get a generated UUID passed as --session-id; resumes reuse the old id)
    // and updated whenever the transcript binder reports the bound file — so
    // it survives /clear rollovers and app restarts (it's saved in the layout).
    // sessionBound: the session file has been seen on disk (bound, or spawned
    // as a resume of it) — claude only creates it on the first message, so an
    // unbound sessionId must not be `--resume`d.
    sessionId: isSessionId(opts.sessionId) ? opts.sessionId : null,
    sessionBound: false,

    // Chat wrapper: which layer is on top ('chat' | 'term'), what the chat view
    // shows, and its live render state (built in initChatUI).
    view: opts.view === 'chat' || opts.view === 'term'
      ? opts.view
      : (chatSupported({ agent: startAgent }) ? 'chat' : 'term'),
    chatFilters: Object.assign(globalChatFilters(), opts.chatFilters || {}),
    chat: null,

    // Legacy flag: pre-nickname layouts auto-named threads "claude 1" and let
    // the running command rename them on agent switches. New threads always
    // arrive with a name (random nickname), so this is false for them.
    autoName: opts.autoName !== undefined ? !!opts.autoName : !opts.name,
  };

  if (opts.caption) setPaneCaption(pane, opts.caption, { persist: false });
  paintPermSelect(pane);
  initChatUI(pane, body);

  // Wire IO
  term.onData((data) => sendToPane(pane, data));
  el.addEventListener('mousedown', (e) => focusPane(pane, e));

  // Double-click the title to rename the thread (single click still focuses).
  title.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(pane); });

  // Zoom / maximize.
  zoomBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  zoomBtn.onclick = (e) => { e.stopPropagation(); toggleZoom(pane); };

  // 📋 chip → open this thread's plan review (clicking still focuses the pane).
  planChip.onclick = (e) => { e.stopPropagation(); focusPane(pane); openPlanReview(pane); };

  // Find bar wiring.
  const runFind = (back) => {
    if (!pane.searchAddon || !findInput.value) return;
    try {
      back ? pane.searchAddon.findPrevious(findInput.value)
           : pane.searchAddon.findNext(findInput.value);
    } catch (_) { /* ignore */ }
  };
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runFind(e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(pane); }
  });
  findNext.onclick = () => runFind(false);
  findPrev.onclick = () => runFind(true);
  findClose.onclick = () => closeFind(pane);

  // Agent dropdown: switch which CLI this thread runs (restarts the thread).
  // Each dropdown hands focus back to the pane after a pick — the mousedown
  // stopPropagation (needed so opening the dropdown doesn't steal focus)
  // otherwise leaves keyboard focus stranded on the <select>, where typing is
  // swallowed and arrow keys silently change the value again.
  agentSelect.addEventListener('mousedown', (e) => e.stopPropagation());
  agentSelect.onchange = (e) => { e.stopPropagation(); setPaneAgent(pane, agentSelect.value); persistLayout(board.id); focusPane(pane); };

  // Model dropdown: switch the model this thread runs (live, if it's started).
  modelSelect.addEventListener('mousedown', (e) => e.stopPropagation());
  modelSelect.onchange = (e) => { e.stopPropagation(); setPaneModel(pane, modelSelect.value); persistLayout(board.id); focusPane(pane); };

  // ChatGPT model dropdown: switch the Codex model (restarts a running thread).
  codexModelSelect.addEventListener('mousedown', (e) => e.stopPropagation());
  codexModelSelect.onchange = (e) => { e.stopPropagation(); setPaneCodexModel(pane, codexModelSelect.value); persistLayout(board.id); focusPane(pane); };

  // Permission dropdown: change the mode Claude starts in (restarts the thread).
  permSelect.addEventListener('mousedown', (e) => e.stopPropagation());
  permSelect.onchange = (e) => { e.stopPropagation(); setPanePerm(pane, permSelect.value); persistLayout(board.id); focusPane(pane); };

  // Drag-and-drop / paste an image into the pane. We can't feed raw image bytes
  // through the PTY, so instead we drop the image to a file and type its path
  // into the prompt — Claude Code picks up image paths from the input line.
  termWrap.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some((it) => it.kind === 'file')) {
      e.preventDefault();
      el.classList.add('drag-over');
    }
  });
  termWrap.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  termWrap.addEventListener('drop', async (e) => {
    el.classList.remove('drag-over');
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    // Always swallow file drops — otherwise Electron navigates the window to
    // the dropped file. We only act on the images among them.
    e.preventDefault();
    if (!files.some(isImageFile)) return;
    focusPane(pane);
    for (const f of files) {
      if (!isImageFile(f)) continue;
      // A dragged file already lives on disk — use its real path; only fall
      // back to copying bytes if Electron didn't expose one.
      const p = f.path || (await persistImage(f));
      if (p) await typePathIntoPane(pane, p);
    }
  });
  // Capture phase: this must run before xterm's own paste handler, which would
  // otherwise consume the event before it bubbles up to us.
  termWrap.addEventListener('paste', async (e) => {
    const cd = e.clipboardData;
    const items = Array.from((cd && cd.items) || []);
    const types = Array.from((cd && cd.types) || []);
    const imgItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));

    if (imgItem) {
      // Screenshot exposed as a DataTransfer file — read it straight from there.
      e.preventDefault();
      e.stopPropagation();
      const file = imgItem.getAsFile();
      const p = file && (await persistImage(file));
      if (p) await typePathIntoPane(pane, p);
      return;
    }

    // A real text paste: hand it back to xterm untouched.
    if (types.includes('text/plain')) return;

    // Otherwise the clipboard may hold a raw bitmap (e.g. a Win+Shift+S
    // screenshot) that never surfaces as a DataTransfer file. This isn't a text
    // paste, so stop xterm now — preventDefault is ignored once we await — then
    // pull the bitmap from the native clipboard via the main process.
    e.preventDefault();
    e.stopPropagation();
    const p = await window.api.clipboardImage();
    if (p) await typePathIntoPane(pane, p);
  }, true);

  closeBtn.onclick = (e) => { e.stopPropagation(); closePane(pane); };

  // Font sizing: header buttons, Ctrl +/-/0, and Ctrl+scroll.
  fontDownBtn.onclick = (e) => { e.stopPropagation(); setPaneFontSize(pane, pane.fontSize - 1); focusPane(pane); };
  fontUpBtn.onclick = (e) => { e.stopPropagation(); setPaneFontSize(pane, pane.fontSize + 1); focusPane(pane); };
  // One custom key handler covers every shortcut. xterm stores a SINGLE handler
  // (calling attachCustomKeyEventHandler twice overwrites), so paste-passthrough,
  // font sizing, find, and pane nav all live here.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;

    // Let the browser handle Ctrl+V natively so our `paste` listener (image +
    // text) fires; otherwise xterm swallows it as a literal ^V.
    if (mod && !e.altKey && (e.key === 'v' || e.key === 'V')) return false;

    // Ctrl+F opens this pane's find bar instead of sending ^F to the shell.
    if (mod && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openFind(pane);
      return false;
    }

    if (!mod) return true;

    // Font sizing: Ctrl +/-/0.
    let delta = null;
    if (e.key === '=' || e.key === '+') delta = pane.fontSize + 1;
    else if (e.key === '-' || e.key === '_') delta = pane.fontSize - 1;
    else if (e.key === '0') delta = FONT_DEFAULT;
    if (delta === null) return true;
    e.preventDefault();           // don't also zoom the whole Electron page
    setPaneFontSize(pane, delta);
    return false;
  });
  termWrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    setPaneFontSize(pane, pane.fontSize + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false, capture: true });

  // No PTY yet: the pane is still detached, so nothing useful can be measured.
  // The caller attaches it via layout() and then calls spawnPanePty().
  return pane;
}

// Swap the title span for an input to rename a thread; commit on Enter/blur.
function beginRename(pane) {
  if (pane.disposed) return;
  const span = pane.title;
  const input = document.createElement('input');
  input.className = 'title-edit';
  input.value = pane.name;
  input.spellcheck = false;
  span.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v) { pane.name = v; pane.autoName = false; }
    span.textContent = pane.name;
    input.replaceWith(span);
    refreshZoomTabs(pane.board.id);
    persistLayout(pane.board.id);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); input.replaceWith(span); }
  });
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('blur', commit);
}

// -- Find bar --------------------------------------------------------------
function openFind(pane) {
  if (!pane || pane.disposed) return;
  if (!pane.searchAddon) return; // search addon not available in this build
  pane.findBar.classList.remove('hidden');
  pane.findInput.focus();
  pane.findInput.select();
}
function closeFind(pane) {
  if (!pane) return;
  pane.findBar.classList.add('hidden');
  try { if (pane.searchAddon) pane.searchAddon.clearDecorations(); } catch (_) { /* ignore */ }
  try { pane.term.focus(); } catch (_) { /* ignore */ }
}

function closePane(pane) {
  if (pane.disposed) return;
  pane.disposed = true;
  if (typeof planModalPane !== 'undefined' && planModalPane === pane) closePlanReview();
  clearTimeout(pane.idleTimer);
  stopAttentionProbe(pane);
  window.api.killPty(pane.id);
  window.api.transcript.unbind(pane.id);
  try { pane.term.dispose(); } catch (_) { /* ignore */ }

  const g = grids.get(pane.board.id);
  if (g.zoomed === pane) g.zoomed = null; // un-zoom if the maximized pane closed
  const col = pane.col;
  col.panes = col.panes.filter((p) => p !== pane);
  if (col.panes.length === 0) {
    g.columns = g.columns.filter((c) => c !== col);
  }
  updateBoardStatus(pane.board.id);

  // If the board has no panes left, drop back to a fresh single terminal.
  const remaining = g.columns.reduce((s, c) => s + c.panes.length, 0);
  if (remaining === 0) {
    addTerminal(pane.board);
  } else {
    layout(pane.board.id);
    persistLayout(pane.board.id);
  }
}

let focusedPane = null;
function focusPane(pane, ev) {
  if (focusedPane && focusedPane !== pane) focusedPane.el.classList.remove('focused');
  focusedPane = pane;
  pane.el.classList.add('focused');
  setDoneGlow(pane, false); // visiting the thread acknowledges its finished turn
  try {
    // Terminal-backed chat: a click landing on the visible terminal is direct
    // TUI interaction (approval menus want raw arrow keys, which the composer
    // would swallow as history recall) — give the terminal the focus. Any
    // other route into the pane focuses the composer as usual.
    const termClick = ev && pane.el.classList.contains('term-chat') &&
      pane.term.element && pane.term.element.contains(ev.target);
    if (pane.view === 'chat' && pane.chat && !termClick) pane.chat.input.focus();
    else pane.term.focus();
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------
function fitBoard(boardId) {
  const g = grids.get(boardId);
  if (!g || g.el.style.display === 'none') return;
  requestAnimationFrame(() => {
    for (const col of g.columns) {
      for (const pane of col.panes) {
        if (pane.disposed) continue;
        try {
          pane.fitAddon.fit();
          window.api.resizePty(pane.id, pane.term.cols, pane.term.rows);
        } catch (_) { /* terminal not ready */ }
      }
    }
  });
}

window.addEventListener('resize', () => {
  if (activeBoardId) fitBoard(activeBoardId);
});

// ---------------------------------------------------------------------------
// PTY events from main
// ---------------------------------------------------------------------------
window.api.onPtyData(({ id, data }) => {
  const pane = findPane(id);
  if (pane && !pane.disposed) {
    pane.term.write(data);
    markActivity(pane, data);
  }
});

window.api.onPtyExit(({ id }) => {
  const pane = findPane(id);
  if (pane && !pane.disposed) {
    clearTimeout(pane.idleTimer);
    stopAttentionProbe(pane);
    setPaneState(pane, 'dead');
    pane.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
  }
});

// ---------------------------------------------------------------------------
// Per-thread cost estimate
//
// Sums the token usage of every assistant message streamed from this pane's
// Claude transcript and prices it at API list rates (MODEL_PRICES), so the
// header shows what the conversation would have cost if it weren't covered by
// the plan. Mirrors usage.js: dedup by message.id + requestId (streamed
// messages appear as several transcript lines sharing one usage block), skip
// `<synthetic>`. Backfill on bind replays the whole session file, so the total
// always covers the full conversation — nothing is persisted.
// ---------------------------------------------------------------------------
function costIngest(pane, entries) {
  let changed = false;
  for (const e of entries) {
    if (!e || e.type !== 'assistant' || !e.message || !e.message.usage) continue;
    const model = e.message.model || 'unknown';
    if (model === '<synthetic>') continue;
    const key = (e.message.id || '') + ':' + (e.requestId || '');
    if (key !== ':' && pane.costSeen.has(key)) continue;
    pane.costSeen.add(key);
    const u = e.message.usage;
    const m = pane.costByModel[model] || (pane.costByModel[model] = {
      input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0,
    });
    m.input += u.input_tokens || 0;
    m.output += u.output_tokens || 0;
    m.cacheRead += u.cache_read_input_tokens || 0;
    // Newer transcripts break cache writes down by TTL (1-hour writes cost
    // more); older ones only have the flat total — price those as 5-minute.
    const cc = u.cache_creation;
    if (cc && typeof cc === 'object' && (cc.ephemeral_5m_input_tokens || cc.ephemeral_1h_input_tokens)) {
      m.cacheCreate5m += cc.ephemeral_5m_input_tokens || 0;
      m.cacheCreate1h += cc.ephemeral_1h_input_tokens || 0;
    } else {
      m.cacheCreate5m += u.cache_creation_input_tokens || 0;
    }
    changed = true;
  }
  if (changed) renderPaneCost(pane);
}

function costUsd(m, p) {
  return (m.input * p.input
    + m.output * p.output
    + m.cacheRead * 0.1 * p.input
    + m.cacheCreate5m * 1.25 * p.input
    + m.cacheCreate1h * 2 * p.input) / 1e6;
}

function resetPaneCost(pane) {
  pane.costSeen = new Set();
  pane.costByModel = {};
  renderPaneCost(pane);
}

function renderPaneCost(pane) {
  if (!pane.costEl) return;
  let total = 0;
  const lines = [];
  for (const model of Object.keys(pane.costByModel).sort()) {
    const m = pane.costByModel[model];
    const usd = costUsd(m, priceForModel(model));
    total += usd;
    const write = m.cacheCreate5m + m.cacheCreate1h;
    lines.push(`${model}: $${usd.toFixed(2)} — in ${fmtTokens(m.input)}, out ${fmtTokens(m.output)}, `
      + `cache read ${fmtTokens(m.cacheRead)}, cache write ${fmtTokens(write)}`);
  }
  if (pane.agent !== 'claude' || total <= 0) {
    pane.costEl.textContent = '';
    pane.costEl.style.display = 'none';
    return;
  }
  pane.costEl.style.display = '';
  pane.costEl.textContent = '~$' + (total >= 10 ? String(Math.round(total)) : total.toFixed(2));
  pane.costEl.title = 'Estimated cost of this conversation at Claude API list prices\n'
    + '(informational — usage is covered by your plan)\n' + lines.join('\n');
}

// Transcript entries/status for the chat view (see "Chat wrapper" section).
// Plan detection scans first: chatIngest bails while the user browses history,
// but the plan lifecycle must never miss an entry (see "Plan review" section).
window.api.transcript.onEntries(({ paneId, entries, backfill }) => {
  const pane = findPane(paneId);
  if (!pane || pane.disposed) return;
  // Entries can only come from a session file that exists on disk — the
  // 'bound' status alone doesn't prove that (a deterministic bind claims the
  // file before claude creates it), and `--resume` of a never-written session
  // dies with "No conversation found".
  if (pane.agent === 'claude' && entries && entries.length) pane.sessionBound = true;
  try { planScanEntries(pane, entries || [], !!backfill); } catch (_) { /* never block the chat */ }
  chatIngest(pane, entries || [], !!backfill);
  if (pane.agent === 'claude') {
    try { costIngest(pane, entries || []); } catch (_) { /* cost chip is best-effort */ }
  }
});

window.api.transcript.onStatus(({ paneId, status, file }) => {
  const pane = findPane(paneId);
  if (!pane || pane.disposed) return;
  // Remember which session this pane is bound to (the file is
  // `<session-id>.jsonl`). Heuristic binds and /clear rollovers are how a
  // pane learns its id; it's persisted in the layout so a restart can
  // `--resume` this exact conversation instead of `--continue`-ing whatever
  // session in the directory happens to be the most recent. Claude only:
  // codex rollout filenames also end in a uuid, but it isn't resumable here.
  if (pane.agent === 'claude' && status === 'bound' && typeof file === 'string') {
    // NOTE: 'bound' does NOT mean the file exists — a deterministic bind
    // claims it before claude creates it. sessionBound is set by onEntries
    // (entries prove the file is real) instead.
    const sid = (/([0-9a-f-]{36})\.jsonl$/i.exec(file) || [])[1];
    if (isSessionId(sid) && sid !== pane.sessionId) {
      pane.sessionId = sid;
      persistLayout(pane.board.id);
    }
    // A different session file means a new conversation (/clear rollover) —
    // start the cost estimate over; the new file's backfill repopulates it.
    if (pane.costFile !== file) {
      pane.costFile = file;
      if (pane.costSeen.size) resetPaneCost(pane);
    }
  }
  chatBindStatus(pane, status);
});

// Click anywhere outside an open history menu closes it.
document.addEventListener('mousedown', (e) => {
  for (const g of grids.values()) {
    for (const col of g.columns) {
      for (const pane of col.panes) {
        const c = pane.chat;
        if (!c || c.historyMenu.classList.contains('hidden')) continue;
        if (c.historyMenu.contains(e.target) || e.target === c.historyBtn) continue;
        hideHistoryMenu(pane);
      }
    }
  }
}, true);

function findPane(id) {
  for (const g of grids.values()) {
    for (const col of g.columns) {
      for (const pane of col.panes) if (pane.id === id) return pane;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Board CRUD + modal
// ---------------------------------------------------------------------------
let editingBoard = null;
const backdrop = $('modal-backdrop');
const mName = $('modal-name');
const mDir = $('modal-dir');
const mCmd = $('modal-cmd');
const mResume = $('modal-resume');
const mMuted = $('modal-muted');

function openModal(board) {
  editingBoard = board || null;
  $('modal-title').textContent = board ? 'Edit hive' : 'New hive';
  mName.value = board ? board.name : '';
  mDir.value = board ? board.dir : '';
  mCmd.value = board ? (board.startupCommand || '') : 'claude';
  if (mResume) mResume.checked = board ? !!board.resumeOnStart : false;
  if (mMuted) mMuted.checked = board ? !!board.muted : false;
  backdrop.classList.remove('hidden');
  mName.focus();
}
function closeModal() { backdrop.classList.add('hidden'); editingBoard = null; }

$('modal-browse').onclick = async () => {
  const dir = await window.api.pickDir();
  if (dir) mDir.value = dir;
};

$('modal-cancel').onclick = closeModal;
$('modal-save').onclick = async () => {
  const name = mName.value.trim() || 'Untitled hive';
  const dir = mDir.value.trim();
  const cmd = mCmd.value.trim() || 'claude';
  const resumeOnStart = !!(mResume && mResume.checked);
  const muted = !!(mMuted && mMuted.checked);
  if (editingBoard) {
    editingBoard.name = name;
    editingBoard.dir = dir;
    editingBoard.startupCommand = cmd;
    editingBoard.resumeOnStart = resumeOnStart;
    editingBoard.muted = muted;
  } else {
    const b = { id: nextId('board'), name, dir, startupCommand: cmd, resumeOnStart, muted };
    boards.push(b);
    activeBoardId = b.id;
  }
  await persist();
  renderBoardList();
  if (!editingBoard) selectBoard(activeBoardId);
  else { // refresh header if editing the active board
    if (editingBoard.id === activeBoardId) {
      boardTitle.textContent = editingBoard.name;
      boardMeta.textContent = editingBoard.dir || '';
      updateBuildButton(editingBoard); // directory may have changed
    }
  }
  closeModal();
};

async function deleteBoard(board) {
  if (!confirm(`Delete hive "${board.name}"? Its threads will be closed.`)) return;
  const g = grids.get(board.id);
  if (g) {
    for (const col of g.columns) {
      for (const pane of col.panes) {
        pane.disposed = true;
        clearTimeout(pane.idleTimer);
        stopAttentionProbe(pane);
        window.api.killPty(pane.id);
        // Tell the main-process transcript binder to stop tailing this pane's
        // session JSONL — otherwise deleting a hive with live threads leaks a
        // watcher streaming entries to a pane id that no longer exists.
        window.api.transcript.unbind(pane.id);
        try { pane.term.dispose(); } catch (_) { /* ignore */ }
      }
    }
    g.el.remove();
    grids.delete(board.id);
  }
  boards = boards.filter((b) => b.id !== board.id);
  await persist();
  if (activeBoardId === board.id) {
    activeBoardId = null;
    if (boards.length) selectBoard(boards[0].id);
    else showEmpty();
  }
  renderBoardList();
}

function showEmpty() {
  gridEl.classList.add('hidden');
  emptyState.classList.remove('hidden');
  addTermBtn.disabled = true;
  if (typeof voiceToggleBtn !== 'undefined' && voiceToggleBtn) voiceToggleBtn.disabled = true;
  if (typeof stopVoice === 'function') stopVoice();
  window.api.setWatch(null); // nothing active to watch
  { const g = $('build-group'); if (g) g.classList.add('hidden'); }
  boardTitle.textContent = 'No hive selected';
  boardMeta.textContent = '';
  if (typeof gitToggle !== 'undefined' && gitToggle) {
    gitToggle.disabled = true;
    gitToggle.classList.remove('active');
  }
  if (typeof gitPanel !== 'undefined' && gitPanel) gitPanel.classList.add('hidden');
  if (typeof filesToggle !== 'undefined' && filesToggle) {
    filesToggle.disabled = true;
    filesToggle.classList.remove('active');
  }
  if (typeof filesPanel !== 'undefined' && filesPanel) filesPanel.classList.add('hidden');
  if (typeof planOpen === 'function' && planOpen()) closePlanReview();
  if (typeof todoToggle !== 'undefined' && todoToggle) {
    todoToggle.disabled = true;
    todoToggle.classList.remove('active');
  }
  if (typeof todoPanel !== 'undefined' && todoPanel) todoPanel.classList.add('hidden');
  if (typeof historyToggle !== 'undefined' && historyToggle) {
    historyToggle.disabled = true;
    historyToggle.classList.remove('active');
  }
  if (typeof historyPanel !== 'undefined' && historyPanel) historyPanel.classList.add('hidden');
  const sb = $('sidebar'); if (sb) sb.classList.remove('git-open', 'files-open', 'todo-open', 'history-open');
}

// ---------------------------------------------------------------------------
// Wire top-level buttons
// ---------------------------------------------------------------------------
$('add-board').onclick = () => openModal(null);
$('empty-add-board').onclick = () => openModal(null);
addTermBtn.onclick = () => {
  const board = boards.find((b) => b.id === activeBoardId);
  if (board) addTerminal(board);
};
backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });

// A clicked notification jumps to the board + pane that needs attention.
window.api.onFocusPane(({ paneId, boardId }) => {
  if (boardId && boardId !== activeBoardId) selectBoard(boardId);
  const pane = findPane(paneId);
  if (pane) focusPane(pane);
});

// ---------------------------------------------------------------------------
// Keyboard pane navigation
//   Ctrl+1..9        focus the Nth thread on the active hive
//   Ctrl+Shift+] / [ cycle focus forward / back
//   Ctrl+Enter       maximize / restore the focused thread
// A capture-phase listener runs before xterm consumes the key. Ctrl+Shift+[/]
// is used for cycling (not Ctrl+[/]) so terminal apps keep Ctrl+[ as ESC.
// ---------------------------------------------------------------------------
function orderedPanes(boardId) {
  const g = grids.get(boardId);
  if (!g) return [];
  const out = [];
  for (const col of g.columns) for (const p of col.panes) if (!p.disposed) out.push(p);
  return out;
}
function focusPaneByIndex(i) {
  const ps = orderedPanes(activeBoardId);
  if (ps[i]) focusPane(ps[i]);
}
function cycleFocus(dir) {
  const ps = orderedPanes(activeBoardId);
  if (!ps.length) return;
  let idx = ps.indexOf(focusedPane);
  if (idx < 0) idx = 0;
  focusPane(ps[(idx + dir + ps.length) % ps.length]);
}
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const t = e.target;
  // xterm's hidden textarea and the chat composer count as "the pane", not as
  // form fields — pane shortcuts must keep working while typing in them.
  const isPaneInput = t && t.classList &&
    (t.classList.contains('xterm-helper-textarea') || t.classList.contains('chat-input'));
  const editable = t && !isPaneInput && (
    t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
  );
  if (editable) return; // don't hijack our own text fields
  if (!activeBoardId) return;

  if (e.key === 'Enter' && !e.shiftKey) {
    if (focusedPane) { e.preventDefault(); e.stopImmediatePropagation(); toggleZoom(focusedPane); }
    return;
  }
  if (e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
    e.preventDefault(); e.stopImmediatePropagation();
    cycleFocus(e.code === 'BracketRight' ? 1 : -1);
    return;
  }
  if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    e.preventDefault(); e.stopImmediatePropagation();
    focusPaneByIndex(parseInt(e.code.slice(5), 10) - 1);
  }
}, true);

// Files on disk changed (a thread edited something) — refresh the Source Control
// panel live. The File Explorer is left to its manual ⟳ so expanded folders don't
// collapse out from under you on every keystroke a thread makes.
window.api.onFsChanged(({ cwd }) => {
  const dir = activeDir();
  if (!dir || dir !== cwd) return;
  // Don't rebuild the panel while the ⋯ menu is open — that would tear the open
  // menu out of the DOM mid-interaction (looks like it "disappears on hover").
  if (typeof gitPanelOpen === 'function' && gitPanelOpen() && !gitBusy && !gitMenuOpen) {
    refreshGit({ keepMsg: true });
  }
  // A thread may have just (re)written a `.hivemind/plans/` file — the open
  // review polls anyway, but a project-tree change gets it there sooner.
  // (Native plan files live outside the watched tree; the poll covers those.)
  if (typeof planOpen === 'function' && planOpen() && planModalPane && !planDrafting &&
      panePlan(planModalPane).source !== 'native') refreshPlanReview();
  // Todos may have changed on disk (a thread edited todos.json). Re-render, but
  // not while the user is mid-edit in the panel — that would clobber their input.
  if (typeof todoPanelOpen === 'function' && todoPanelOpen() &&
      !(document.activeElement && todoPanel.contains(document.activeElement))) {
    refreshTodo();
  }
});

// ---------------------------------------------------------------------------
// Source Control (Git) panel
//
// Operates on the active board's project directory. The panel mirrors Visual
// Studio's "Git Changes": branch + ahead/behind, fetch/pull/push, a commit
// box, staged/unstaged change lists, per-file stage/unstage/discard, and a
// click-to-view diff.
// ---------------------------------------------------------------------------
const gitToggle = $('git-toggle');
const gitPanel = $('git-panel');
const gitBody = $('git-body');
const gitMsgbar = $('git-msgbar');
let gitBusy = false;
let gitMenuOpen = false; // the ⋯ overflow menu is open; suppress auto-refresh so it isn't wiped
let lastStatus = null;
let lastLog = []; // recent commits shown at the bottom of the panel

function activeBoard() { return boards.find((b) => b.id === activeBoardId) || null; }
function activeDir() { const b = activeBoard(); return b && b.dir ? b.dir : null; }
const baseName = (p) => p.replace(/\/$/, '').split('/').pop();
const dirName = (p) => { const i = p.replace(/\/$/, '').lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; };

// ---------------------------------------------------------------------------
// "Build Portable" — only shown when the active hive points at the Hivemind
// source checkout. Runs electron-builder's portable target, streams progress
// into the button (stage label + live elapsed timer), then reveals the dist
// folder and notifies on finish.
// ---------------------------------------------------------------------------
let buildCheckToken = 0; // ignore stale async checks when boards switch quickly

async function updateBuildButton(board) {
  const group = $('build-group');
  if (!group) return;
  group.classList.add('hidden');
  const dir = board && board.dir;
  if (!dir) return;
  const token = ++buildCheckToken;
  let isHivemind = false;
  try { isHivemind = await window.api.build.isHivemind(dir); } catch (_) { /* hide */ }
  if (token !== buildCheckToken) return; // a different board was selected meanwhile
  group.classList.toggle('hidden', !isHivemind);
}

// electron-builder doesn't emit a real percentage, so map its log lines to a
// short, friendly stage name. We surface the stage rather than a misleading
// number; the always-incrementing elapsed timer signals liveness.
function buildStageLabel(line) {
  const l = line.toLowerCase();
  if (l.includes('downloading')) return 'Downloading Electron';
  if (l.includes('rebuilding') || l.includes('install')) return 'Preparing';
  if (l.includes('packaging')) return 'Packaging';
  if (l.includes('signing') || l.includes('signtool')) return 'Signing';
  if (l.includes('block map')) return 'Finalizing';
  if (l.includes('committing version') || l.includes('publishing release') || l.includes('uploading')) return 'Publishing';
  if (l.includes('target=portable') || l.includes('building')) return 'Compressing';
  return null;
}

// Entry point shared by the Settings button and the "hivemind build …"
// command; assigned inside the guard so it exists only when the button does.
let startPortableBuild = null;

if (buildBtn) {
  let buildStage = 'Building';
  let buildStart = 0;
  let buildTimer = null;

  const paintBuildBtn = () => {
    const secs = Math.max(0, Math.round((Date.now() - buildStart) / 1000));
    const mm = Math.floor(secs / 60);
    const ss = String(secs % 60).padStart(2, '0');
    buildBtn.textContent = `⏳ ${buildStage}… ${mm}:${ss}`;
  };

  startPortableBuild = async () => {
    const dir = activeDir();
    if (!dir || buildBtn.dataset.busy) return;
    buildBtn.dataset.busy = '1';
    buildBtn.disabled = true;
    buildBtn.classList.add('building');
    buildStage = 'Building';
    buildStart = Date.now();
    paintBuildBtn();
    buildTimer = setInterval(paintBuildBtn, 1000);
    let res;
    try {
      res = await window.api.build.portable(dir);
    } catch (err) {
      // An unexpected rejection (e.g. the main handler throwing) must not leave
      // the button stuck disabled with the timer ticking forever.
      res = { ok: false, message: (err && err.message) || String(err) };
    } finally {
      clearInterval(buildTimer);
      buildTimer = null;
      delete buildBtn.dataset.busy;
      buildBtn.disabled = false;
      buildBtn.classList.remove('building');
      buildBtn.textContent = BUILD_BTN_TEXT;
      buildBtn.title = BUILD_BTN_TITLE;
    }
    if (res && res.ok && res.published) {
      window.api.notify({ title: 'Hivemind', body: `v${res.version} built and published to GitHub — opening the dist folder.` });
      window.api.files.reveal(dir, 'dist');
    } else if (res && res.ok) {
      const why = res.publishMessage || 'unknown error';
      window.api.notify({ title: 'Hivemind', body: `v${res.version} built, but publishing to GitHub failed: ${why}` });
      hmToast(`v${res.version} built but NOT published — clients will not receive this update. ${why}`, 'err');
      window.api.files.reveal(dir, 'dist');
    } else {
      const why = (res && res.message) || 'see terminal output';
      window.api.notify({ title: 'Hivemind', body: 'Portable build failed: ' + why });
      hmToast('Portable build failed: ' + why, 'err');
    }
  };
  buildBtn.onclick = startPortableBuild;

  if (window.api.onBuildProgress) {
    window.api.onBuildProgress(({ line }) => {
      if (!buildBtn.dataset.busy || !line) return;
      buildBtn.title = line.slice(0, 200); // full line still available on hover
      const stage = buildStageLabel(line);
      if (stage) { buildStage = stage; paintBuildBtn(); }
    });
  }
}

function setGitMsg(text, kind) {
  if (!text) { gitMsgbar.classList.add('hidden'); gitMsgbar.textContent = ''; return; }
  gitMsgbar.textContent = text;
  gitMsgbar.className = 'git-msgbar' + (kind ? ' ' + kind : '');
}

function gitPanelOpen() { return gitPanel && !gitPanel.classList.contains('hidden'); }

const sidebarEl = $('sidebar');
function setGitOpen(open) {
  if (open && typeof setFilesOpen === 'function') setFilesOpen(false); // one panel at a time
  if (open && typeof setTodoOpen === 'function') setTodoOpen(false);
  if (open && typeof setHistoryOpen === 'function') setHistoryOpen(false);
  if (open && typeof setHmChatOpen === 'function') setHmChatOpen(false);
  gitPanel.classList.toggle('hidden', !open);
  gitToggle.classList.toggle('active', open);
  sidebarEl.classList.toggle('git-open', open); // board list yields its space
}

gitToggle.onclick = () => {
  const open = gitPanel.classList.contains('hidden');
  setGitOpen(open);
  if (open) refreshGit();
};
$('git-close').onclick = () => setGitOpen(false);
$('git-refresh').onclick = () => refreshGit({ forceFetch: true });

function gitOnBoardChange() {
  if (gitPanelOpen()) refreshGit();
}

// -- Run a git op with a busy guard, then refresh + report ------------------
async function gitRun(label, fn, { refresh = true, okMsg } = {}) {
  if (gitBusy) return;
  const dir = activeDir();
  if (!dir) { setGitMsg('This hive has no project directory set.', 'err'); return; }
  gitBusy = true;
  setGitMsg(label + '…');
  try {
    const res = await fn(dir);
    if (res && typeof res.code === 'number' && res.code !== 0) {
      setGitMsg((res.stderr || res.stdout || 'Failed.').trim(), 'err');
    } else if (okMsg) {
      const detail = res && (res.stdout || res.stderr) ? '\n' + (res.stdout || res.stderr).trim() : '';
      setGitMsg(okMsg + detail, 'ok');
    } else {
      setGitMsg('');
    }
    return res;
  } catch (e) {
    setGitMsg(String((e && e.message) || e), 'err');
  } finally {
    gitBusy = false;
    if (refresh) await refreshGit({ keepMsg: true });
  }
}

// -- Load status and (re)render the panel -----------------------------------
async function refreshGit(opts = {}) {
  if (!gitPanelOpen()) return;
  const dir = activeDir();
  if (!dir) { renderGitState({ ok: false, reason: 'no-dir' }); return; }
  const [st, log] = await Promise.all([
    window.api.git.status(dir),
    window.api.git.log(dir, 3),
  ]);
  lastStatus = st;
  lastLog = st.ok ? log : [];
  renderGitState(st, opts);
  if (!opts.noFetch && st.ok && st.hasRemote) autoFetchGit(dir, opts.forceFetch);
}

// -- Background fetch: keep the ↓/↑ counters honest --------------------------
// `git status` compares against the *local* copy of the remote ref, so ↓ can't
// move until something actually talks to GitHub. Fetch quietly after a status
// load (throttled) and on a slow tick while the panel stays open, then repaint
// if the user is still looking at the same repo.
const GIT_AUTOFETCH_MS = 3 * 60 * 1000;
const gitLastFetch = new Map(); // dir -> epoch ms of the last completed fetch
let gitFetching = false;        // single-flight: one fetch at a time

async function autoFetchGit(dir, force) {
  if (!dir || gitFetching) return;
  if (!force && Date.now() - (gitLastFetch.get(dir) || 0) < GIT_AUTOFETCH_MS) return;
  gitFetching = true;
  try {
    const res = await window.api.git.fetch(dir);
    if (res && res.code === 0) gitLastFetch.set(dir, Date.now());
  } catch (_) {
    // Offline or auth trouble — keep showing the local view, try again later.
  } finally {
    gitFetching = false;
  }
  // Same guards as the fs-watcher refresh: never repaint mid-op or while the
  // ⋯ menu is open, and only if the panel still shows the repo we fetched.
  if (gitPanelOpen() && activeDir() === dir && !gitBusy && !gitMenuOpen) {
    refreshGit({ keepMsg: true, noFetch: true });
  }
}

setInterval(() => {
  if (gitPanelOpen() && !gitBusy && lastStatus && lastStatus.ok && lastStatus.hasRemote) {
    autoFetchGit(activeDir());
  }
}, 60 * 1000);

function renderGitState(st, opts = {}) {
  gitMenuOpen = false; // any prior overflow menu is about to be torn out of the DOM
  gitBody.innerHTML = '';
  if (!opts.keepMsg) setGitMsg('');

  if (!st || !st.ok) {
    const wrap = document.createElement('div');
    wrap.className = 'git-empty';
    if (!st || st.reason === 'no-dir') {
      wrap.textContent = 'This hive has no project directory set. Edit the hive to choose one.';
    } else if (st.reason === 'no-git') {
      wrap.textContent = st.message || 'git was not found on PATH. Install Git for Windows and reopen Hivemind.';
    } else if (st.reason === 'not-repo') {
      wrap.textContent = 'This folder is not a Git repository yet.';
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.textContent = 'Initialize Repository';
      btn.onclick = () => gitRun('Initializing', (d) => window.api.git.init(d), { okMsg: 'Initialized empty repository.' });
      wrap.appendChild(btn);
    } else {
      wrap.textContent = (st.message || 'Could not read git status.').trim();
    }
    gitBody.appendChild(wrap);
    return;
  }

  gitBody.appendChild(renderBranchBar(st));
  if (!st.hasRemote) gitBody.appendChild(renderPublishBanner());
  gitBody.appendChild(renderCommitBox(st));

  const staged = st.files.filter((f) => f.staged);
  const unstaged = st.files.filter((f) => f.unstaged);
  if (staged.length) gitBody.appendChild(renderSection('Staged Changes', staged, true));
  gitBody.appendChild(renderSection('Changes', unstaged, false));

  if (!staged.length && !unstaged.length) {
    const clean = document.createElement('div');
    clean.className = 'git-empty';
    clean.textContent = 'No changes. Working tree clean.';
    gitBody.appendChild(clean);
  }

  if (lastLog.length) gitBody.appendChild(renderCommitLog(lastLog));
}

function renderBranchBar(st) {
  const bar = document.createElement('div');
  bar.className = 'git-branchbar';

  const line = document.createElement('div');
  line.className = 'git-branchline';
  const branchBtn = document.createElement('button');
  branchBtn.className = 'branch-select';
  branchBtn.title = 'Switch or create a branch';
  branchBtn.innerHTML = '<span>⑂</span>';
  const bname = document.createElement('span');
  bname.className = 'bname';
  bname.textContent = st.detached ? '(detached HEAD)' : (st.branch || '(no branch)');
  branchBtn.appendChild(bname);
  branchBtn.onclick = openBranchMenu;

  const counts = document.createElement('span');
  counts.className = 'git-counts';
  if (st.upstream) {
    counts.innerHTML = `<span class="behind">↓${st.behind}</span> <span class="ahead">↑${st.ahead}</span>`;
    counts.title = `Behind ${st.behind}, ahead ${st.ahead} of ${st.upstream}`;
  } else {
    counts.textContent = 'no upstream';
  }
  line.append(branchBtn, counts);

  // Open the project's page on GitHub (or whatever host origin points at) in the
  // system browser. Only shown when the remote maps to a browsable https URL.
  if (st.remoteWebUrl) {
    const gh = document.createElement('button');
    gh.className = 'git-openweb';
    gh.title = 'Open project on GitHub';
    gh.setAttribute('aria-label', 'Open project on GitHub');
    gh.innerHTML =
      '<svg class="gh-mark" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">' +
      '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>' +
      // Small "opens externally" arrow that fades in on hover so the control
      // reads as a link out to the browser, not an in-app action.
      '<svg class="gh-out" viewBox="0 0 24 24" width="9" height="9" fill="none" ' +
      'stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M7 17 17 7M9 7h8v8"/></svg>';
    gh.onclick = () => window.api.openExternal(st.remoteWebUrl);
    line.append(gh);
  }

  // Remote actions (Pull / Push / Revert) live in the commit box below, next to
  // the message they act on. The branch bar is just the branch picker + counts.
  bar.append(line);
  return bar;
}

function doRevertToRemote() {
  const st = lastStatus;
  if (!st || !st.hasRemote) { setGitMsg('This repository is not connected to GitHub yet.', 'err'); return; }
  const target = st.upstream || (st.branch ? 'origin/' + st.branch : 'the remote branch');
  const warn =
    'Revert to GitHub?\n\n' +
    'This resets the current branch to ' + target + ' and DELETES all local changes:\n' +
    '  • uncommitted edits\n' +
    '  • staged changes\n' +
    '  • commits you have not pushed\n' +
    '  • untracked files\n\n' +
    'This cannot be undone. Continue?';
  if (!confirm(warn)) return;
  gitRun('Reverting to GitHub', (d) => window.api.git.resetToRemote(d, st.branch), { okMsg: 'Reverted to GitHub.' });
}

function renderPublishBanner() {
  const wrap = document.createElement('div');
  wrap.className = 'git-publish';
  const txt = document.createElement('div');
  txt.className = 'git-publish-text';
  txt.textContent = "This repository isn't connected to GitHub yet.";
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = '⑂ Connect to GitHub';
  btn.onclick = openGitHubWizard;
  wrap.append(txt, btn);
  return wrap;
}

function renderCommitBox(st) {
  const wrap = document.createElement('div');

  // Header row with the AI "draft for me" action.
  const msgHead = document.createElement('div');
  msgHead.className = 'git-msg-head';
  const lbl = document.createElement('span');
  lbl.textContent = 'Message';
  const genBtn = mkBtn('✨ Generate', () => doGenerateCommitMsg(genBtn));
  genBtn.className = 'git-gen-btn';
  genBtn.title = 'Draft a commit message from the current diff using Claude';
  const spc = document.createElement('span');
  spc.className = 'spacer';
  msgHead.append(lbl, spc, genBtn);

  const ta = document.createElement('textarea');
  ta.id = 'git-msg';
  ta.placeholder = 'Commit message (Ctrl+Enter to push)';
  ta.value = gitDraftMsg;
  ta.oninput = () => { gitDraftMsg = ta.value; };
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doPush(); }
  });

  // Remote actions, side by side:
  //   Pull  — bring GitHub's commits down into this branch.
  //   Push  — stage everything, commit (auto-drafting a message if the box is
  //           empty), then push. Publishes to GitHub the first time.
  //   ⋯     — a small overflow menu for rare/destructive actions (Revert),
  //           kept out of the way so it isn't an easy mis-click.
  const actions = document.createElement('div');
  actions.className = 'git-actions';

  const pullBtn = mkBtn('Pull ↓', doPull);
  pullBtn.className = 'git-pull';
  pullBtn.title = 'Bring down commits made on GitHub and merge them into this branch';
  if (!st.hasRemote) pullBtn.disabled = true;

  const pushBtn = mkBtn('Push ↑', doPush);
  pushBtn.className = 'primary git-push';
  pushBtn.title = st.hasRemote
    ? 'Commit your changes and push them up to GitHub'
    : 'Connect this repository to GitHub, then push everything';

  actions.append(pullBtn, pushBtn);

  // Overflow menu holds the destructive "Revert to GitHub" action so it stays
  // tucked away. Only meaningful once the repo is connected to GitHub.
  if (st.hasRemote) {
    const moreWrap = document.createElement('div');
    moreWrap.className = 'git-more-wrap';

    const moreBtn = mkBtn('⋯', null);
    moreBtn.className = 'git-more-btn';
    moreBtn.title = 'More actions';
    moreBtn.setAttribute('aria-label', 'More actions');

    const menu = document.createElement('div');
    menu.className = 'git-more-menu hidden';
    const revertItem = mkBtn('Revert to GitHub', () => { closeMenu(); doRevertToRemote(); });
    revertItem.className = 'git-more-item danger';
    revertItem.title = 'Discard all local changes and reset this branch to what is on GitHub';
    menu.appendChild(revertItem);

    function onOutside(e) { if (!moreWrap.contains(e.target)) closeMenu(); }
    function closeMenu() {
      gitMenuOpen = false;
      menu.classList.add('hidden');
      document.removeEventListener('mousedown', onOutside);
      gitBody.removeEventListener('scroll', closeMenu, true);
    }
    moreBtn.onclick = (e) => {
      e.stopPropagation();
      if (menu.classList.contains('hidden')) {
        // Unhide first so we can measure the menu, then anchor it above the
        // button (right edges aligned). Fixed positioning keeps it clear of
        // #git-body's overflow clipping.
        gitMenuOpen = true; // suppress FS-triggered re-renders that would wipe the menu
        menu.classList.remove('hidden');
        const r = moreBtn.getBoundingClientRect();
        menu.style.top = (r.top - menu.offsetHeight - 6) + 'px';
        menu.style.left = (r.right - menu.offsetWidth) + 'px';
        document.addEventListener('mousedown', onOutside);
        gitBody.addEventListener('scroll', closeMenu, true);
      } else {
        closeMenu();
      }
    };

    moreWrap.append(moreBtn, menu);
    actions.append(moreWrap);
  }

  wrap.append(msgHead, ta, actions);
  return wrap;
}

// Pull GitHub's commits down into the current branch.
function doPull() {
  const st = lastStatus;
  if (!st || !st.hasRemote) { setGitMsg('This repository is not connected to GitHub yet.', 'err'); return; }
  gitRun('Pulling from GitHub', (d) => window.api.git.pull(d), { okMsg: 'Pulled the latest from GitHub.' });
}

// Commit, then push. Stages everything and commits any working-tree changes
// (auto-drafting a message if the box is empty), then pushes — publishing the
// repo to GitHub if it isn't connected yet. Does NOT pull; if the push is
// rejected because the branch is behind, use Pull first.
async function doPush() {
  const st = lastStatus;
  if (!st || !st.ok) { setGitMsg('No repository here.', 'err'); return; }

  // Not connected to GitHub yet → run the publish wizard (create or link a repo;
  // it pushes the current branch as part of finishing).
  if (!st.hasRemote) { openGitHubWizard(); return; }

  const dir = activeDir();
  const hasChanges = st.files && st.files.length > 0;

  // 1) Commit any working-tree changes.
  if (hasChanges) {
    let msg = gitDraftMsg.trim();
    if (!msg) {
      // No typed message — draft one so the push needs no extra input.
      setGitMsg('Drafting a commit message…');
      try {
        const r = await window.api.git.aiCommitMessage(dir);
        if (r && r.code === 0 && r.message) msg = r.message.trim();
      } catch { /* fall through to a default */ }
      if (!msg) msg = 'Update from Hivemind';
    }
    if (!st.files.some((f) => f.staged)) {
      const staged = await gitRun('Staging all', (d) => window.api.git.stageAll(d), { refresh: false });
      if (!staged || staged.code !== 0) { await refreshGit({ keepMsg: true }); return; }
    }
    const res = await gitRun('Committing', (d) => window.api.git.commit(d, msg), { refresh: false });
    if (!res || res.code !== 0) { await refreshGit({ keepMsg: true }); return; }
    gitDraftMsg = '';
  }

  // 2) Push (setting the upstream the first time the branch is published).
  const setUpstream = !st.upstream;
  await gitRun(
    'Pushing to GitHub',
    (d) => window.api.git.push(d, st.branch, setUpstream),
    { okMsg: 'Pushed your changes to GitHub.' },
  );
}

let gitDraftMsg = '';

// Ask Claude to draft a commit message from the current diff and drop it into
// the message box. Runs a one-shot `claude -p` via the main process (in a
// scratch dir, so the session never shows up in the hive's chat threads).
async function doGenerateCommitMsg(btn) {
  const dir = activeDir();
  if (!dir) { setGitMsg('This hive has no project directory set.', 'err'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '✨ Drafting…'; }
  setGitMsg('Asking Claude to draft a commit message…');
  try {
    const res = await window.api.git.aiCommitMessage(dir);
    if (!res || res.code !== 0) {
      setGitMsg((res && res.message) || 'Could not draft a message.', 'err');
      return;
    }
    gitDraftMsg = res.message;
    const ta = $('git-msg');
    if (ta) { ta.value = res.message; ta.focus(); }
    setGitMsg('Drafted a commit message — review and edit before committing.', 'ok');
  } catch (e) {
    setGitMsg(String((e && e.message) || e), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Generate'; }
  }
}

function renderSection(label, files, staged) {
  const sec = document.createElement('div');
  sec.className = 'git-section';
  const head = document.createElement('div');
  head.className = 'git-section-head';
  const title = document.createElement('span');
  title.textContent = label;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = String(files.length);
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  head.append(title, count, spacer);

  if (files.length) {
    const allBtn = document.createElement('button');
    allBtn.textContent = staged ? '−' : '+';
    allBtn.title = staged ? 'Unstage all' : 'Stage all';
    allBtn.onclick = () => staged
      ? gitRun('Unstaging all', (d) => window.api.git.unstageAll(d))
      : gitRun('Staging all', (d) => window.api.git.stageAll(d));
    head.appendChild(allBtn);
  }
  sec.appendChild(head);

  const ul = document.createElement('ul');
  ul.className = 'git-files';
  for (const f of files) ul.appendChild(renderFileRow(f, staged));
  sec.appendChild(ul);
  return sec;
}

// Read-only list of the last few commits on the current branch, shown at the
// bottom of the panel so a push/commit is immediately visible in context.
function renderCommitLog(commits) {
  const sec = document.createElement('div');
  sec.className = 'git-section';
  const head = document.createElement('div');
  head.className = 'git-section-head';
  const title = document.createElement('span');
  title.textContent = 'Recent Commits';
  head.append(title);
  sec.appendChild(head);

  const ul = document.createElement('ul');
  ul.className = 'git-log';
  for (const c of commits) {
    const li = document.createElement('li');
    li.className = 'git-log-row';
    const subj = document.createElement('span');
    subj.className = 'git-log-subject';
    subj.textContent = c.subject;
    subj.title = `${c.hash} — ${c.author}, ${c.when}\n${c.subject}`;
    const meta = document.createElement('span');
    meta.className = 'git-log-meta';
    meta.textContent = `${c.hash} · ${c.when}`;
    li.append(subj, meta);
    ul.appendChild(li);
  }
  sec.appendChild(ul);
  return sec;
}

function statusLetter(f, staged) {
  if (f.conflicted) return 'U';
  if (f.untracked) return 'A';
  if (f.renamed) return 'R';
  const ch = staged ? f.x : f.y;
  return ch === '?' ? 'A' : ch;
}

function renderFileRow(f, staged) {
  const li = document.createElement('li');
  li.className = 'git-file';
  const letter = statusLetter(f, staged);
  const stat = document.createElement('span');
  stat.className = 'fstat ' + letter;
  stat.textContent = letter;
  stat.title = f.untracked ? 'Untracked' : (staged ? 'Staged' : 'Modified');

  const name = document.createElement('span');
  name.className = 'fname';
  const base = baseName(f.path);
  const dir = dirName(f.path);
  name.textContent = base;
  if (dir) { const d = document.createElement('span'); d.className = 'fdir'; d.textContent = '  ' + dir; name.appendChild(d); }
  name.title = f.path;

  const act = document.createElement('div');
  act.className = 'fact';
  if (staged) {
    act.appendChild(mkMini('−', 'Unstage', (e) => { e.stopPropagation(); gitRun('Unstaging', (d) => window.api.git.unstage(d, [f.path])); }));
  } else {
    act.appendChild(mkMini('↩', 'Discard changes', (e) => {
      e.stopPropagation();
      if (!confirm(`Discard changes to ${f.path}? This cannot be undone.`)) return;
      gitRun('Discarding', (d) => window.api.git.discard(d, [{ path: f.path, untracked: f.untracked }]));
    }));
    act.appendChild(mkMini('+', 'Stage', (e) => { e.stopPropagation(); gitRun('Staging', (d) => window.api.git.stage(d, [f.path])); }));
  }

  li.append(stat, name, act);
  li.onclick = () => showDiff(f, staged);
  return li;
}

// ---------------------------------------------------------------------------
// File Explorer panel
//
// Mirrors the Source Control panel: docked inside the sidebar, operates on the
// active board's project directory. Shows a lazy file tree — folders expand on
// click. Clicking a file opens it in the OS default app; per-row actions insert
// its path into the focused thread or reveal it in the OS file manager.
// ---------------------------------------------------------------------------
const filesToggle = $('files-toggle');
const filesPanel = $('files-panel');
const filesBody = $('files-body');
const filesMsgbar = $('files-msgbar');

function filesPanelOpen() { return filesPanel && !filesPanel.classList.contains('hidden'); }

function setFilesMsg(text, kind) {
  if (!text) { filesMsgbar.classList.add('hidden'); filesMsgbar.textContent = ''; return; }
  filesMsgbar.textContent = text;
  filesMsgbar.className = 'git-msgbar' + (kind ? ' ' + kind : '');
}

function setFilesOpen(open) {
  if (open) setGitOpen(false); // one panel at a time
  if (open && typeof setTodoOpen === 'function') setTodoOpen(false);
  if (open && typeof setHistoryOpen === 'function') setHistoryOpen(false);
  if (open && typeof setHmChatOpen === 'function') setHmChatOpen(false);
  filesPanel.classList.toggle('hidden', !open);
  filesToggle.classList.toggle('active', open);
  sidebarEl.classList.toggle('files-open', open); // board list yields its space
}

filesToggle.onclick = () => {
  const open = filesPanel.classList.contains('hidden');
  setFilesOpen(open);
  if (open) refreshFiles();
};
$('files-close').onclick = () => setFilesOpen(false);
$('files-refresh').onclick = () => refreshFiles();

function filesOnBoardChange() {
  if (filesPanelOpen()) refreshFiles();
}

async function refreshFiles() {
  if (!filesPanelOpen()) return;
  setFilesMsg('');
  const dir = activeDir();
  if (!dir) { renderFilesState({ ok: false, reason: 'no-dir' }); return; }
  const res = await window.api.files.list(dir, '');
  renderFilesState(res);
}

function renderFilesState(res) {
  filesBody.innerHTML = '';
  if (!res || !res.ok) {
    const wrap = document.createElement('div');
    wrap.className = 'git-empty';
    if (!res || res.reason === 'no-dir') {
      wrap.textContent = 'This hive has no project directory set. Edit the hive to choose one.';
    } else if (res.reason === 'not-found') {
      wrap.textContent = 'This directory no longer exists.';
    } else {
      wrap.textContent = (res.message || 'Could not read this directory.').trim();
    }
    filesBody.appendChild(wrap);
    return;
  }
  if (!res.entries.length) {
    const wrap = document.createElement('div');
    wrap.className = 'git-empty';
    wrap.textContent = 'This folder is empty.';
    filesBody.appendChild(wrap);
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'fx-tree';
  for (const e of res.entries) ul.appendChild(renderFxItem(e, 0));
  filesBody.appendChild(ul);
}

function renderFxItem(entry, depth) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'fx-item';
  row.style.paddingLeft = (6 + depth * 12) + 'px';

  const twisty = document.createElement('span');
  twisty.className = 'fx-twisty';
  twisty.textContent = entry.isDir ? '▸' : '';
  const icon = document.createElement('span');
  icon.className = 'fx-icon';
  icon.textContent = entry.isDir ? '📁' : '📄';
  const name = document.createElement('span');
  name.className = 'fx-name';
  name.textContent = entry.name;
  name.title = entry.path;
  row.append(twisty, icon, name);
  li.appendChild(row);

  if (entry.isDir) {
    let childUl = null; // null = collapsed
    row.onclick = async () => {
      if (childUl) {
        childUl.remove();
        childUl = null;
        twisty.textContent = '▸';
        icon.textContent = '📁';
        return;
      }
      const dir = activeDir();
      if (!dir) return;
      const res = await window.api.files.list(dir, entry.path);
      if (!res || !res.ok) {
        setFilesMsg((res && res.message) || 'Could not open this folder.', 'err');
        return;
      }
      childUl = document.createElement('ul');
      childUl.className = 'fx-children';
      for (const e of res.entries) childUl.appendChild(renderFxItem(e, depth + 1));
      li.appendChild(childUl);
      twisty.textContent = '▾';
      icon.textContent = '📂';
    };
  } else {
    const act = document.createElement('div');
    act.className = 'fx-act';
    act.appendChild(mkMini('⤓', 'Insert path into focused thread', (e) => {
      e.stopPropagation();
      insertPathIntoPane(entry.path);
    }));
    act.appendChild(mkMini('⧉', 'Reveal in file manager', (e) => {
      e.stopPropagation();
      window.api.files.reveal(activeDir(), entry.path);
    }));
    row.appendChild(act);
    row.onclick = () => openFile(entry.path);
  }
  return li;
}

async function openFile(rel) {
  const dir = activeDir();
  if (!dir) return;
  const res = await window.api.files.open(dir, rel);
  if (res && !res.ok) setFilesMsg(res.message || 'Could not open this file.', 'err');
}

function insertPathIntoPane(rel) {
  const pane = focusedPane;
  if (!pane || pane.disposed || pane.state === 'dead') {
    setFilesMsg('Click a thread first, then insert the path.', 'err');
    return;
  }
  const text = /\s/.test(rel) ? `"${rel}"` : rel;
  sendToPane(pane, text);
  setFilesMsg('Inserted ' + rel + ' into the focused thread.', 'ok');
}

// ---------------------------------------------------------------------------
// Autocorrect
//
// As-you-type spelling autocorrect for every plain text field that has
// spell-check on: the chat composer, the todo add box and inline edits, the
// commit message, plan comments… Whenever a word boundary is typed (space,
// punctuation, Enter) the word just finished goes to the main process
// ('spell:correct', nspell over the same en-US dictionary that paints the
// squiggles) and, if it's a clear one-slip typo, is replaced in place. The
// replacement runs through execCommand so Ctrl+Z undoes it, and right-click →
// Add to dictionary permanently protects a word. Fields opt out exactly the
// way they opt out of squiggles — spellcheck=false — which already covers
// xterm's hidden textarea, find bars, names, branches and paths.
// ---------------------------------------------------------------------------
let autocorrectEnabled = localStorage.getItem('hm.autocorrect') !== '0'; // default on

const AC_BOUNDARY = new Set([' ', '.', ',', ';', ':', '!', '?']);

function acEligibleField(el) {
  if (!autocorrectEnabled || !el || !el.spellcheck) return false;
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text');
}

// The word ending at `end` (exclusive) in `value`, or null when the token
// isn't a plain lower/Capitalized word standing on its own — skips @paths,
// /commands, --flags, snake_case, dotted.names, camelCase, ALLCAPS, digits.
function acWordAt(value, end) {
  let start = end;
  while (start > 0 && /[A-Za-z']/.test(value[start - 1])) start--;
  if (end - start < 3) return null;
  const before = start > 0 ? value[start - 1] : '';
  if (before && !/[\s"“”‘(\[{]/.test(before)) return null; // part of a bigger token
  const word = value.slice(start, end);
  if (!/^[A-Za-z][a-z']*$/.test(word)) return null;
  return { word, start };
}

// Fix the word ending at `end`, keeping the caret where the user left it.
function acApply(el, end) {
  if (end == null || end <= 0) return;
  const found = acWordAt(el.value, end);
  if (!found) return;
  const fixed = window.api.spellCorrect(found.word);
  if (!fixed || fixed === found.word) return;
  const caret = el.selectionStart;
  el.setSelectionRange(found.start, end);
  if (!document.execCommand('insertText', false, fixed)) {
    // execCommand refused (shouldn't happen) — splice directly, losing undo.
    el.value = el.value.slice(0, found.start) + fixed + el.value.slice(end);
  }
  const pos = caret + (fixed.length - found.word.length);
  el.setSelectionRange(pos, pos);
}

// Space/punctuation (and Shift+Enter's line break) arrive as input events; the
// word sits just before the character that was inserted.
document.addEventListener('input', (e) => {
  const el = e.target;
  if (e.isComposing || !acEligibleField(el)) return;
  const boundary =
    e.inputType === 'insertLineBreak' ||
    (e.inputType === 'insertText' && e.data && e.data.length === 1 && AC_BOUNDARY.has(e.data));
  if (boundary && el.selectionStart === el.selectionEnd) acApply(el, el.selectionStart - 1);
});

// Enter usually *commits* the field (send the message, add the todo, push the
// commit) before any input event can fire, so catch it on the way down —
// document capture runs before the field's own keydown handler — and fix the
// trailing word first.
document.addEventListener('keydown', (e) => {
  const el = e.target;
  if (e.key !== 'Enter' || e.isComposing || !acEligibleField(el)) return;
  if (el.selectionStart !== el.selectionEnd) return;
  acApply(el, el.selectionStart);
}, true);

// ---------------------------------------------------------------------------
// Todo panel
//
// A per-hive checklist, docked in the sidebar like Source Control / Explorer.
// The list lives in `.hivemind/todos.json` in the project dir; add items, tick
// them off, double-click to rename, delete, or clear completed. Items nest to
// any depth — each has a `children` array, and hovering a row reveals a ＋ to
// add a sub-item. Scoped to the active board (cwd), not the focused thread —
// one shared list per hive. A thread may also edit the file directly, so we
// re-render on fs changes.
// ---------------------------------------------------------------------------
const todoToggle = $('todo-toggle');
const todoPanel = $('todo-panel');
const todoBody = $('todo-body');
const todoMsgbar = $('todo-msgbar');
const todoInput = $('todo-input');

let todoItems = []; // tree of { id, text, done, collapsed, children: [...] }
let todoLoadFailed = false; // last read hit a corrupt/locked file — don't overwrite it
let todoPendingEdit = null; // { item, span } to focus once the tree is in the DOM

function todoPanelOpen() { return todoPanel && !todoPanel.classList.contains('hidden'); }

function setTodoMsg(text, kind) {
  if (!text) { todoMsgbar.classList.add('hidden'); todoMsgbar.textContent = ''; return; }
  todoMsgbar.textContent = text;
  todoMsgbar.className = 'git-msgbar' + (kind ? ' ' + kind : '');
}

function setTodoOpen(open) {
  if (open) { // one panel at a time
    setGitOpen(false);
    setFilesOpen(false);
    if (typeof setHistoryOpen === 'function') setHistoryOpen(false);
    if (typeof setHmChatOpen === 'function') setHmChatOpen(false);
  }
  todoPanel.classList.toggle('hidden', !open);
  todoToggle.classList.toggle('active', open);
  sidebarEl.classList.toggle('todo-open', open); // board list yields its space
}

todoToggle.onclick = () => {
  const open = todoPanel.classList.contains('hidden');
  setTodoOpen(open);
  if (open) refreshTodo();
};
$('todo-close').onclick = () => setTodoOpen(false);
$('todo-refresh').onclick = () => refreshTodo();

function todoOnBoardChange() { if (todoPanelOpen()) refreshTodo(); }

async function refreshTodo() {
  if (!todoPanelOpen()) return;
  setTodoMsg('');
  const dir = activeDir();
  if (!dir) { todoItems = []; renderTodo({ ok: false, reason: 'no-dir' }); return; }
  const res = await window.api.todo.read(dir);
  todoLoadFailed = !!(res && res.ok === false && (res.reason === 'corrupt' || res.reason === 'unreadable'));
  todoItems = (res && res.ok && Array.isArray(res.todos)) ? normalizeTodos(res.todos) : [];
  renderTodo(res);
}

// Persist the current list. `.hivemind/` is kept out of Git the same way plans
// are. Failures surface in the message bar but don't lose the in-memory list.
async function saveTodo() {
  const dir = activeDir();
  if (!dir) return;
  if (todoLoadFailed) {
    setTodoMsg('Todos file is unreadable — not overwriting it. Fix or remove .hivemind/todos.json, then reopen.', 'err');
    return;
  }
  window.api.todo.ensureIgnored(dir);
  const res = await window.api.todo.write(dir, todoItems);
  if (!res || !res.ok) setTodoMsg((res && res.message) || 'Could not save todos.', 'err');
  else setTodoMsg('');
}

function addTodo(text) {
  const t = (text || '').trim();
  if (!t || !activeDir()) return;
  if (todoLoadFailed) {
    setTodoMsg('Todos file is unreadable — not overwriting it. Fix or remove .hivemind/todos.json, then reopen.', 'err');
    return;
  }
  todoItems.push({ id: nextId('todo'), text: t, done: false, children: [] });
  saveTodo();
  renderTodo({ ok: true });
}

// -- "todo …" capture from the composer / dictation ---------------------------
// A message starting with "todo" (or "TODO:", "to-do", …) is a checklist entry
// for this hive's Todo panel, not a prompt for Claude. Matches only the exact
// word at the start ("todos need work" is not captured). Returns the item text
// ('' if the word stood alone) or null when the message isn't a todo.
const TODO_PREFIX_RE = /^to-?do\b[\s:,.!?-]*/i;
function matchTodoPrefix(text) {
  const t = String(text || '').trim();
  const m = TODO_PREFIX_RE.exec(t);
  return m ? t.slice(m[0].length).trim() : null;
}

// Append one item to this hive's todos. Reads the list from disk first — the
// panel's in-memory copy is only current while the panel is open, and saving a
// stale copy would clobber items added elsewhere (e.g. by a Claude thread).
async function addTodoItem(text) {
  const t = String(text || '').trim();
  const dir = activeDir();
  if (!dir) return { ok: false, message: 'No hive is open.' };
  if (!t) return { ok: false, message: 'Nothing to add.' };
  const res = await window.api.todo.read(dir);
  if (res && res.ok === false && (res.reason === 'corrupt' || res.reason === 'unreadable')) {
    return { ok: false, message: 'Todos file is unreadable — not overwriting it.' };
  }
  const list = (res && res.ok && Array.isArray(res.todos)) ? normalizeTodos(res.todos) : [];
  list.push({ id: nextId('todo'), text: t, done: false, children: [] });
  window.api.todo.ensureIgnored(dir);
  const w = await window.api.todo.write(dir, list);
  if (!w || !w.ok) return { ok: false, message: (w && w.message) || 'Could not save the todo.' };
  todoItems = list;
  if (todoPanelOpen()) renderTodo({ ok: true });
  return { ok: true };
}

// Shared entry point for the "todo …" prefix and the "Hivemind, add a todo …"
// command: add the item and confirm with a toast. A bare "todo" with no text
// just opens the panel.
async function captureTodo(text) {
  const t = String(text || '').trim();
  if (!t) {
    setTodoOpen(true);
    refreshTodo();
    hmToast('Todo panel opened — say "todo <something>" to add an item.');
    return;
  }
  const res = await addTodoItem(t);
  if (res.ok) hmToast('Added todo: ' + t);
  else hmToast('Could not add todo: ' + res.message, 'err');
}

// Add a blank sub-item under `parent`, expand it, and open the editor on the new
// row. A blank row abandoned (Esc, or blurred empty) is discarded.
function addSubTodo(parent) {
  if (!activeDir()) return;
  parent.children = parent.children || [];
  parent.collapsed = false;
  const child = { id: nextId('todo'), text: '', done: false, children: [] };
  parent.children.push(child);
  renderTodo({ ok: true }, child.id);
}

// Older todos.json (pre-nesting) has no `children`; give every node one so the
// tree helpers below can recurse freely.
function normalizeTodos(list) {
  if (!Array.isArray(list)) return [];
  list.forEach((it) => { it.children = normalizeTodos(it.children || []); });
  return list;
}

// Remove `item` from whichever list holds it, searching the whole tree.
function removeTodo(item, list) {
  const i = list.indexOf(item);
  if (i !== -1) { list.splice(i, 1); return true; }
  return list.some((it) => removeTodo(item, it.children || []));
}

// Set `item` and every descendant to `done` (checking a parent checks its kids).
function setSubtreeDone(item, done) {
  item.done = done;
  (item.children || []).forEach((c) => setSubtreeDone(c, done));
}

// Checking sub-items never auto-checks the parent — the parent is ticked only
// by hand (which then checks its whole subtree). But a checked parent can't
// stay done once any of its sub-items is undone, so clear it bottom-up.
function reconcileTodos(list) {
  list.forEach((it) => {
    const kids = it.children || [];
    if (kids.length) {
      reconcileTodos(kids);
      if (!kids.every((c) => c.done)) it.done = false;
    }
  });
}

// done/total counted over leaf items only — parents are containers, not tasks.
function todoStats(list) {
  let done = 0, total = 0;
  const walk = (arr) => arr.forEach((it) => {
    const kids = it.children || [];
    if (kids.length) walk(kids);
    else { total++; if (it.done) done++; }
  });
  walk(list);
  return { done, total };
}

// Prune done items without orphaning an undone descendant: a done parent stays
// as long as any child survives.
function pruneDoneTodos(list) {
  return list.filter((it) => {
    it.children = pruneDoneTodos(it.children || []);
    return !it.done || it.children.length > 0;
  });
}

// -- Push a todo to a new thread ----------------------------------------------
// The item's text (plus any unfinished sub-items) becomes a brand-new thread's
// initial prompt, exactly like "Hivemind, open a new thread and <task>" — the
// new Claude starts working on it the moment it boots. The todo itself is left
// unticked; the thread finishing the work is what earns the checkmark.

// Flatten an item into a one-line task: initialPrompt rides along as claude's
// positional argument (main.js collapses newlines), so sub-items are folded in
// as a "; "-separated list rather than a multi-line checklist.
function todoThreadPrompt(item) {
  const subs = [];
  (function walk(kids) {
    (kids || []).forEach((k) => {
      const t = String(k.text || '').trim();
      if (!k.done && t) subs.push(t);
      walk(k.children);
    });
  })(item.children);
  const t = String(item.text || '').trim();
  if (!t) return '';
  return subs.length ? t + ' — sub-tasks: ' + subs.join('; ') : t;
}

function pushTodoToThread(item) {
  const board = activeBoard();
  if (!board) { hmToast('No hive is open — create one first.', 'err'); return; }
  const task = todoThreadPrompt(item);
  if (!task) { hmToast('This todo is empty — give it some text first.', 'err'); return; }
  const p = addTerminal(board, { initialPrompt: task });
  if (p) setPaneCaption(p, String(item.text || '').trim());
  hmToast('Opened a new thread — starting on: ' + String(item.text || '').trim());
}

// Swap a todo's label for an inline text editor; Enter/blur commits, Esc cancels.
// `removeIfEmpty` (used for freshly-added sub-items) discards a never-named row.
function startEditTodo(item, span, opts) {
  const removeIfEmpty = !!(opts && opts.removeIfEmpty);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'todo-edit';
  input.spellcheck = true;
  input.value = item.text;
  let committed = false;
  const finish = (cancel) => {
    if (committed) return;
    committed = true;
    const t = input.value.trim();
    if (!cancel && t) item.text = t;
    if (removeIfEmpty && !item.text) removeTodo(item, todoItems);
    saveTodo();
    renderTodo({ ok: true });
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(false); }
    else if (e.key === 'Escape') { finish(true); }
  };
  input.onblur = () => finish(false);
  span.replaceWith(input);
  input.focus();
  input.select();
}

function renderTodo(res, focusEditId) {
  todoBody.innerHTML = '';
  todoPendingEdit = null;
  if (res && !res.ok && res.reason === 'no-dir') {
    const wrap = document.createElement('div');
    wrap.className = 'git-empty';
    wrap.textContent = 'This hive has no project directory set. Edit the hive to choose one.';
    todoBody.appendChild(wrap);
  } else if (!todoItems.length) {
    const wrap = document.createElement('div');
    wrap.className = 'git-empty';
    wrap.textContent = 'No todos yet. Add one above to get started.';
    todoBody.appendChild(wrap);
  } else {
    todoBody.appendChild(buildTodoList(todoItems, 0, focusEditId));
  }
  // The edited row's span must be in the document before we can focus it.
  if (todoPendingEdit) {
    const { item, span } = todoPendingEdit;
    todoPendingEdit = null;
    startEditTodo(item, span, { removeIfEmpty: true });
  }
  renderTodoCount();
}

// Build a <ul> for `list` at nesting `depth`, recursing into children. Rows are
// indented by depth; items with children get a collapse caret.
function buildTodoList(list, depth, focusEditId) {
  const ul = document.createElement('ul');
  ul.className = 'todo-list';
  list.forEach((item) => {
    const kids = item.children || [];
    const hasKids = kids.length > 0;

    const li = document.createElement('li');
    li.className = 'todo-item' + (item.done ? ' done' : '');
    li.style.paddingLeft = (6 + depth * 16) + 'px';

    const caret = document.createElement('button');
    caret.className = 'todo-caret';
    if (hasKids) {
      caret.textContent = item.collapsed ? '▸' : '▾';
      caret.title = item.collapsed ? 'Expand' : 'Collapse';
      caret.onclick = () => { item.collapsed = !item.collapsed; saveTodo(); renderTodo({ ok: true }); };
    } else {
      caret.classList.add('todo-caret-empty');
      caret.tabIndex = -1;
    }

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'todo-check';
    cb.checked = !!item.done;
    if (hasKids) {
      const s = todoStats([item]);
      cb.indeterminate = s.done > 0 && s.done < s.total;
    }
    cb.title = 'Toggle done';
    cb.onchange = () => {
      setSubtreeDone(item, cb.checked);
      reconcileTodos(todoItems);
      saveTodo();
      renderTodo({ ok: true });
    };

    const span = document.createElement('span');
    span.className = 'todo-text';
    span.textContent = item.text;
    span.title = 'Double-click to edit';
    span.ondblclick = () => startEditTodo(item, span);

    const push = document.createElement('button');
    push.className = 'todo-push';
    push.title = 'Start in a new thread';
    push.textContent = '▶';
    push.onclick = () => pushTodoToThread(item);

    const addSub = document.createElement('button');
    addSub.className = 'todo-sub';
    addSub.title = 'Add sub-item';
    addSub.textContent = '＋';
    addSub.onclick = () => addSubTodo(item);

    const del = document.createElement('button');
    del.className = 'todo-del';
    del.title = 'Delete';
    del.textContent = '✕';
    del.onclick = () => {
      removeTodo(item, todoItems);
      reconcileTodos(todoItems);
      saveTodo();
      renderTodo({ ok: true });
    };

    li.appendChild(caret);
    li.appendChild(cb);
    li.appendChild(span);
    li.appendChild(push);
    li.appendChild(addSub);
    li.appendChild(del);
    ul.appendChild(li);

    if (focusEditId && item.id === focusEditId) todoPendingEdit = { item, span };

    if (hasKids && !item.collapsed) ul.appendChild(buildTodoList(kids, depth + 1, focusEditId));
  });
  return ul;
}

// Footer: "<done>/<total> done" plus a "Clear completed" action when relevant.
function renderTodoCount() {
  const footer = $('todo-footer');
  const countEl = $('todo-count');
  const clearBtn = $('todo-clear-done');
  if (!footer || !countEl || !clearBtn) return;
  const { done, total } = todoStats(todoItems);
  if (!total) { footer.classList.add('hidden'); return; }
  footer.classList.remove('hidden');
  countEl.textContent = `${done}/${total} done`;
  clearBtn.style.display = done ? '' : 'none';
}

if (todoInput) {
  todoInput.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTodo(todoInput.value); todoInput.value = ''; }
  };
}
$('todo-add').onclick = () => { addTodo(todoInput.value); todoInput.value = ''; todoInput.focus(); };
$('todo-clear-done').onclick = () => {
  todoItems = pruneDoneTodos(todoItems);
  saveTodo();
  renderTodo({ ok: true });
};
// ---------------------------------------------------------------------------
// Prompt History panel
//
// A per-hive log of prompts sent to threads, stored in
// `.hivemind/prompt-history.json` (shared per project, like todos — not
// per-thread). Prompts are captured in sendChatMessage after the Hivemind /
// todo command interception, so only text actually delivered to a thread is
// recorded. Clicking an entry reposts it to the focused live thread.
// ---------------------------------------------------------------------------
const historyToggle = $('history-toggle');
const historyPanel = $('history-panel');
const historyBody = $('history-body');
const historyMsgbar = $('history-msgbar');

let historyEntries = []; // [{ id, text, ts, agent }] oldest→newest (rendered reversed)
let historyRefreshGen = 0; // bumped on refresh/mutation so stale disk reads are discarded

function historyPanelOpen() { return historyPanel && !historyPanel.classList.contains('hidden'); }

function setHistoryMsg(text, kind) {
  if (!text) { historyMsgbar.classList.add('hidden'); historyMsgbar.textContent = ''; return; }
  historyMsgbar.textContent = text;
  historyMsgbar.className = 'git-msgbar' + (kind ? ' ' + kind : '');
}

function setHistoryOpen(open) {
  if (open) { // one panel at a time
    setGitOpen(false);
    setFilesOpen(false);
    setTodoOpen(false);
    setHmChatOpen(false);
  }
  historyPanel.classList.toggle('hidden', !open);
  historyToggle.classList.toggle('active', open);
  sidebarEl.classList.toggle('history-open', open); // board list yields its space
}

historyToggle.onclick = () => {
  const open = historyPanel.classList.contains('hidden');
  setHistoryOpen(open);
  if (open) refreshHistory();
};
$('history-close').onclick = () => setHistoryOpen(false);
$('history-refresh').onclick = () => refreshHistory();
$('history-clear').onclick = async () => {
  const dir = activeDir();
  if (!dir) return;
  historyRefreshGen++; // an in-flight read must not resurrect the list
  historyEntries = [];
  const res = await window.api.promptHistory.write(dir, []);
  if (!res || !res.ok) setHistoryMsg((res && res.message) || 'Could not clear history.', 'err');
  renderHistory();
};

function historyOnBoardChange() { if (historyPanelOpen()) refreshHistory(); }

async function refreshHistory() {
  if (!historyPanelOpen()) return;
  setHistoryMsg('');
  const gen = ++historyRefreshGen;
  const dir = activeDir();
  if (!dir) { historyEntries = []; renderHistory(); return; }
  const res = await window.api.promptHistory.read(dir);
  if (gen !== historyRefreshGen) return; // superseded by a newer refresh or a mutation
  historyEntries = (res && res.ok && Array.isArray(res.entries)) ? res.entries : [];
  renderHistory();
}

function renderHistory() {
  historyBody.innerHTML = '';
  if (!historyEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Prompts you send to threads will appear here.';
    historyBody.appendChild(empty);
    return;
  }
  for (let i = historyEntries.length - 1; i >= 0; i--) { // newest first
    const entry = historyEntries[i];
    if (!entry || !entry.text) continue;
    const row = document.createElement('div');
    row.className = 'history-row';
    row.title = entry.text;

    const main = document.createElement('div');
    main.className = 'history-row-main';
    const text = document.createElement('div');
    text.className = 'history-row-text';
    text.textContent = entry.text;
    const time = document.createElement('div');
    time.className = 'history-row-time';
    time.textContent = relTimeShort(entry.ts || 0);
    main.appendChild(text);
    main.appendChild(time);

    const send = document.createElement('button');
    send.className = 'history-row-send';
    send.title = 'Send again to the focused thread';
    send.textContent = '↩';
    send.onclick = (e) => {
      e.stopPropagation();
      repostPrompt(entry);
    };

    const speak = document.createElement('button');
    speak.className = 'history-row-speak';
    speak.title = 'Re-speak this prompt in voice training — read it aloud and get dictionary fixes for anything misheard';
    speak.textContent = '🎤';
    speak.onclick = (e) => {
      e.stopPropagation();
      openVoiceTraining({ text: entry.text });
    };

    const del = document.createElement('button');
    del.className = 'history-row-del';
    del.title = 'Remove from history';
    del.textContent = '🗑';
    del.onclick = async (e) => {
      e.stopPropagation();
      historyRefreshGen++; // an in-flight read must not resurrect the row
      historyEntries = historyEntries.filter((x) => x !== entry);
      const dir = activeDir();
      if (dir) {
        const res = await window.api.promptHistory.write(dir, historyEntries);
        if (!res || !res.ok) setHistoryMsg((res && res.message) || 'Could not save history.', 'err');
      }
      renderHistory();
    };

    row.appendChild(main);
    row.appendChild(speak);
    row.appendChild(send);
    row.appendChild(del);
    row.onclick = () => revealPrompt(entry);
    historyBody.appendChild(row);
  }
}

// Repost a history entry to the focused thread — same delivery path as the
// composer. Guards mirror sendChatMessage: never type into a pending TUI menu,
// and never into a pane from another hive or one viewing a past session.
async function repostPrompt(entry) {
  const pane = (focusedPane && !focusedPane.disposed && focusedPane.state !== 'dead'
                && focusedPane.board && focusedPane.board.id === activeBoardId)
    ? focusedPane : null;
  if (!pane) { setHistoryMsg('Focus a running thread first.', 'err'); return; }
  if (pane.state === 'attention') { setHistoryMsg('Thread is waiting on an answer — respond to it first.', 'err'); return; }
  if (pane.chat && pane.chat.viewingHistory) { setHistoryMsg('Thread is viewing a past conversation — return to live first.', 'err'); return; }
  deliverPrompt(pane, entry.text);
  await recordPromptHistory(entry.text, pane.agent); // move-to-top with a fresh stamp
  setHistoryMsg('Sent to ' + (pane.name || 'thread') + '.', 'ok'); // after the refresh, which clears the bar
}

// Jump to a history entry's prompt where it appears in a thread's chat — like
// an anchor link. The focused pane is searched first, then the rest of the
// board (history is per-hive, so the prompt may have gone to any thread).
// Within a pane the last matching bubble wins: history dedupes repeats, so the
// newest occurrence is the one the entry's timestamp refers to.
function revealPrompt(entry) {
  const g = grids.get(activeBoardId);
  if (!g) { setHistoryMsg('Open a hive first.', 'err'); return; }
  const panes = [];
  if (focusedPane && !focusedPane.disposed && focusedPane.chat
      && focusedPane.board && focusedPane.board.id === activeBoardId) panes.push(focusedPane);
  for (const col of g.columns) {
    for (const p of col.panes) {
      if (p.disposed || !p.chat || panes.includes(p)) continue; // Gemini panes have no chat
      panes.push(p);
    }
  }
  for (const pane of panes) {
    const bubbles = pane.chat.list.querySelectorAll('.chat-row[data-kind="user"] > .chat-bubble.user');
    for (let i = bubbles.length - 1; i >= 0; i--) {
      if (bubbles[i].textContent.trim() !== entry.text) continue;
      jumpToChatRow(pane, bubbles[i].parentElement);
      return;
    }
  }
  setHistoryMsg('Prompt not found in an open conversation — it may be from a past session or a closed thread.', 'err');
}

// Focus the pane, make its chat visible, and scroll the row to center with a
// brief highlight flash. Scrolling away from the bottom unpins auto-scroll via
// the chat list's scroll handler, so a mid-turn thread won't yank the view back.
function jumpToChatRow(pane, row) {
  const g = grids.get(pane.board.id);
  if (g && g.zoomed && g.zoomed !== pane) { // board maximized on another thread — swap, like a zoom tab click
    g.zoomed.el.classList.remove('zoomed');
    g.zoomed = pane;
    layout(pane.board.id);
  }
  if (focusedPane !== pane) focusPane(pane);
  if (pane.view !== 'chat') setPaneView(pane, 'chat', { persist: false }); // a jump shouldn't overwrite the remembered view
  pane.chat.pinned = false; // unpin NOW — a transcript entry landing mid-smooth-scroll must not yank back to bottom
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (row.__hiliteTimer) clearTimeout(row.__hiliteTimer);
  row.classList.remove('hilite');
  void row.offsetWidth; // restart the flash animation on a re-click
  row.classList.add('hilite');
  row.__hiliteTimer = setTimeout(() => row.classList.remove('hilite'), 1800);
}

// Record one sent prompt into this hive's history. Appending happens in the
// main process (read-modify-write on disk) so sends from several threads and
// an open panel never clobber each other — same rationale as addTodoItem.
async function recordPromptHistory(text, agent) {
  const t = String(text || '').trim();
  const dir = activeDir();
  if (!t || !dir) return;
  window.api.promptHistory.ensureIgnored(dir);
  await window.api.promptHistory.append(dir, { id: nextId('ph'), text: t, ts: Date.now(), agent: agent || '' });
  if (historyPanelOpen()) refreshHistory(); // live update while the panel is open
}
// ---------------------------------------------------------------------------
// Plan review
//
// A thread's plan as a full document — the VS Code-extension experience. Two
// sources feed the same review window:
//
//  * Native Claude Code plan mode. The transcript shows the plan file being
//    written (a Write/Edit tool_use targeting `~/.claude/plans/<slug>.md`) —
//    that flips the pane to "drafting" and gives us the file to render live.
//    When Claude finishes, its "Ready to code?" approval menu appears in the
//    terminal; the screen probe spots it ("readiness" can't come from the
//    transcript — Claude Code only flushes the ExitPlanMode line after the
//    menu is answered), maps the menu options by label, and the review pops
//    up (focused pane) or a 📋 header chip appears (unfocused). Approve /
//    Request-changes answer that menu by pressing its option number in the
//    hidden terminal; the eventual ExitPlanMode tool_result in the transcript
//    settles the final state (approved / changes requested).
//
//  * Hivemind-requested plans (ChatGPT threads, or any thread outside plan
//    mode): the ⟳ button types a request to write `.hivemind/plans/<id>.md`
//    into the thread, exactly as before.
//
// Either way the document renders as markdown, the user highlights passages
// and attaches comments (sidecar `.comments.json` under `.hivemind/plans/`,
// keyed to the quoted text so they re-anchor on every re-render), and
// "Request changes" sends the comments back so the thread can revise.
// ---------------------------------------------------------------------------
const planBackdrop = $('plan-backdrop');
const planModal = $('plan-modal');
const planDocStatus = $('plan-doc-status');
const planDocTitle = $('plan-doc-title');
const planDocThread = $('plan-doc-thread');
const planDocBody = $('plan-doc-body');
const planCommentsEl = $('plan-doc-comments');
const planDocMsg = $('plan-doc-msg');
const planDocNote = $('plan-doc-note');
const planReqChangesBtn = $('plan-req-changes');
const planApproveManualBtn = $('plan-approve-manual');
const planApproveAutoBtn = $('plan-approve-auto');
const planCommentBtn = $('plan-doc-comment-btn');

let planModalPane = null;    // the pane whose plan the review window shows
let planText = null;         // raw markdown, or null when there's no plan file
let planRenderedMtime = 0;   // mtime of the content currently rendered
let planComments = [];       // [{ id, quote, occurrence, body, resolved, sent }]
let planPendingSel = null;   // { quote, occurrence } captured for a new comment
let planDrafting = false;    // an inline comment editor is open
let planPollTimer = null;    // live-refresh poll while the review is open

// A plan file written by a thread, wherever it lives: Claude Code's native
// plan-mode files (~/.claude/plans/…) or Hivemind's own (.hivemind/plans/…).
const PLAN_FILE_RE = /[\\/]\.(?:claude|hivemind)[\\/]plans[\\/][^\\/]+\.md$/i;
// The plan-approval menu ("Ready to code?" / v2.1.21x "…ready to execute.
// Would you like to proceed?"), matched by option label — the option numbers
// shift with optional entries (clear-context, publish-as-artifact, Ultraplan),
// so digits are always derived from the live screen parse. The run-with-it
// option's label depends on the thread's permission mode (verified against
// Claude Code v2.1.211): "Yes, auto-accept edits" in default mode, "Yes, and
// bypass permissions" / "Yes, and use auto mode" otherwise. The "Yes, clear
// context (N% used) and …" first-slot variant is deliberately not matched —
// its keep-context sibling is always present. If wording drifts and nothing
// matches, the buttons degrade to "answer in the terminal" rather than
// sending blind digits.
const PLAN_MENU_KEEP_RE = /keep planning/i;
// The keep-planning option in v2.1.21x is an inline input — its label is
// still "No, keep planning" but the screen renders its placeholder ("Tell
// Claude what to change") instead, so match either.
const PLAN_MENU_FEEDBACK_RE = /^(No, keep planning|Tell Claude what to change)/i;
const PLAN_MENU_AUTO_RE = /^Yes, (auto-accept edits|and (bypass permissions|use auto mode))/i;
const PLAN_MENU_MANUAL_RE = /^Yes, manually approve/i;
// Deterministic ExitPlanMode tool_result strings (approval vs. kept planning).
const PLAN_APPROVED_RE = /^User has approved your plan/i;
// Placeholder of the inline feedback field "No, keep planning" opens.
const PLAN_FEEDBACK_INPUT_RE = /Tell Claude what to change/i;

const PLAN_STATE_LABEL = {
  none: 'No plan',
  drafting: 'Drafting…',
  ready: 'Ready for review',
  'pending-result': 'Waiting…',
  approved: 'Approved',
  'changes-requested': 'Changes requested',
};

// Per-pane plan lifecycle state (lazily created — panes predate this feature).
function panePlan(pane) {
  if (!pane.plan) {
    pane.plan = {
      state: 'none', file: null, source: null, // 'native' | 'hivemind'
      menu: null, menuMiss: 0,                 // live "Ready to code?" option map
      exitIds: new Set(),                      // ExitPlanMode tool_use ids seen
      exitPlanText: null,                      // input.plan — content of last resort
      cardText: null, cardFetch: null,         // chat-card plan cache (planCardText)
      cardComments: null, cardCmtFetch: null,  // chat-card comment cache
      cardDraft: null,                         // in-progress card comment draft
      cardNote: '',                            // card's overall-feedback input
    };
  }
  return pane.plan;
}

function planSetState(pane, state) {
  const pl = panePlan(pane);
  if (pl.state === state) return;
  pl.state = state;
  if (state !== 'ready') pl.menuMiss = 0;
  if (state === 'drafting' || state === 'none') pl.menu = null;
  updatePlanChip(pane);
  if (planModalPane === pane && planOpen()) paintPlanActions();
}

// The 📋 chip in the pane header: visible while a plan is being drafted and,
// pulsing, once it's ready for review. Click to open the review window.
function updatePlanChip(pane) {
  const chip = pane.planChip;
  if (!chip) return;
  const pl = panePlan(pane);
  const show = pl.state === 'ready' || pl.state === 'drafting';
  chip.classList.toggle('hidden', !show);
  chip.classList.toggle('ready', pl.state === 'ready');
  chip.textContent = pl.state === 'ready' ? '📋 plan ready' : '📋 planning';
  chip.title = pl.state === 'ready'
    ? 'This thread finished a plan and is waiting for approval — click to review it'
    : 'This thread is writing a plan — click to watch it live';
}

// --- Detection hook A: the transcript --------------------------------------
// Runs on every entry batch, before chatIngest (which bails while the user
// browses history). Live plan-file writes flip the pane to "drafting"; the
// ExitPlanMode tool_result settles approved / changes-requested. Backfill
// (replayed history after a bind/restart) only reconstructs state — it never
// pops the review or messages the user.
function planScanEntries(pane, entries, backfill) {
  const pl = panePlan(pane);
  let cardStale = false;
  for (const e of entries) {
    if (!e || e.isSidechain || !e.message) continue;
    const content = Array.isArray(e.message.content) ? e.message.content : null;
    if (!content) continue;
    if (e.type === 'assistant') {
      for (const part of content) {
        if (!part || part.type !== 'tool_use') continue;
        if ((part.name === 'Write' || part.name === 'Edit') && part.input &&
            typeof part.input.file_path === 'string' && PLAN_FILE_RE.test(part.input.file_path)) {
          pl.file = part.input.file_path;
          pl.source = /[\\/]\.hivemind[\\/]/i.test(part.input.file_path) ? 'hivemind' : 'native';
          cardStale = true;
          if (!backfill) {
            planSetState(pane, 'drafting');
            if (planModalPane === pane && planOpen() && !planDrafting) refreshPlanReview();
          }
        } else if (part.name === 'ExitPlanMode') {
          if (part.id) pl.exitIds.add(part.id);
          const inp = part.input || {};
          if (typeof inp.planFilePath === 'string' && inp.planFilePath) {
            pl.file = inp.planFilePath;
            pl.source = /[\\/]\.hivemind[\\/]/i.test(inp.planFilePath) ? 'hivemind' : 'native';
          }
          if (typeof inp.plan === 'string' && inp.plan) pl.exitPlanText = inp.plan;
          cardStale = true;
        }
      }
    } else if (e.type === 'user') {
      for (const part of content) {
        if (!part || part.type !== 'tool_result' || !pl.exitIds.has(part.tool_use_id)) continue;
        planApplyResult(pane, PLAN_APPROVED_RE.test(planToolResultText(part)), backfill);
      }
    }
  }
  // The transcript can reveal the plan (file or text) after the screen probe
  // already drew the approval card — and probes stop once the PTY goes quiet,
  // so nothing else would refresh the card's plan fold. Re-sync: it re-parses
  // the screen, which re-kicks planCardText with the newly known source.
  if (cardStale) syncScreenQuestion(pane);
}

function planToolResultText(part) {
  const c = part && part.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => (x && x.type === 'text' && typeof x.text === 'string') ? x.text : '').join('\n');
  }
  return '';
}

function planApplyResult(pane, approved, backfill) {
  planSetState(pane, approved ? 'approved' : 'changes-requested');
  if (backfill || planModalPane !== pane || !planOpen()) return;
  if (approved) {
    setPlanDocMsg('✓ Approved — the thread is implementing.', 'ok');
    setTimeout(() => {
      if (planModalPane === pane && panePlan(pane).state === 'approved') closePlanReview();
    }, 1600);
  } else {
    setPlanDocMsg('Staying in plan mode — the thread will revise the plan.');
  }
}

// --- Detection hook B: the visible screen -----------------------------------
// Called from probeAttention/evaluateIdle with the screen they already read.
// The "Ready to code?" menu is the only reliable readiness signal (see the
// section comment); its parsed options double as the label→digit map the
// Approve / Request-changes buttons need. Two consecutive probe misses while
// "ready" mean the menu was answered somewhere else — actions disable and the
// transcript result resolves the state.
// Parse the approval menu's numbered options off the visible screen. The
// plan dialog draws none of the "Enter to select … Esc to cancel" footer
// chrome parseScreenQuestion anchors on, so this anchors on the numbering
// itself: the bottom-most "1." line with options counting up from it,
// validated by the option every variant of the menu ends with — the
// keep-planning entry ("No, keep planning", or its "Tell Claude what to
// change" placeholder once it became an inline input in v2.1.21x) — plus at
// least one "Yes, …" option (the manual-approve entry is unconditional).
// Non-option lines in between are wrapped labels or option descriptions.
function parsePlanMenu(screen) {
  // The dialog is a bordered box — shed the │ box chrome so the line-anchored
  // option regex sees "❯ 1. Yes, …" rather than "│ ❯ 1. Yes, … │".
  const lines = screen.split('\n')
    .map((l) => l.replace(/^[\s│┃]+/, '').replace(/[\s│┃]+$/, ''));
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = SCREEN_OPT_RE.exec(lines[i]);
    if (!m || m[2] !== '1') continue;
    const options = [];
    for (let j = i; j < lines.length; j++) {
      const om = SCREEN_OPT_RE.exec(lines[j]);
      if (om && Number(om[2]) === options.length + 1) options.push({ label: om[3].trim() });
    }
    // The bottom-most numbered block either is the menu or there is no menu
    // on screen (a numbered list inside the plan preview fails the check).
    return options.length >= 2
      && options.some((o) => PLAN_MENU_FEEDBACK_RE.test(o.label))
      && options.some((o) => /^Yes, /i.test(o.label))
      ? options : null;
  }
  return null;
}

// The plan markdown for the chat approval card. The screen probe parses
// synchronously, so this serves a per-pane cache and refreshes it in the
// background: content comes from the plan file the transcript revealed
// (native or hivemind), the legacy ⟳ file, or the ExitPlanMode input — the
// same order refreshPlanReview uses. When a read lands with new content the
// screen question re-syncs, which re-renders the card with the plan body.
function planCardText(pane) {
  const pl = panePlan(pane);
  // The probe re-enters this every 700 ms while a plan card is showing —
  // throttle the IPC file read; 2 s is plenty live for a plan being edited.
  if (!pl.cardFetch && (!pl.cardFetchAt || Date.now() - pl.cardFetchAt > 2000)) {
    pl.cardFetchAt = Date.now();
    pl.cardFetch = (async () => {
      const dir = pane.board && pane.board.dir;
      let res = null;
      if (pl.file) res = await window.api.plan.readFile(dir, pl.file);
      if ((!res || !res.ok) && dir && pane.planId) {
        const legacy = await window.api.plan.read(dir, pane.planId);
        if (legacy && legacy.ok) res = legacy;
      }
      const text = res && res.ok ? res.content : pl.exitPlanText;
      if (typeof text === 'string' && text !== pl.cardText && !pane.disposed) {
        pl.cardText = text;
        syncScreenQuestion(pane);
      }
    // The body completes synchronously when there's nothing to read (both
    // reads are conditional) — clearing the flag inside the body would be
    // clobbered by this assignment, so clear it in a .finally, which always
    // runs after the assignment. Also clears on a rejected read.
    })().finally(() => { pl.cardFetch = null; });
  }
  return typeof pl.cardText === 'string' ? pl.cardText : null;
}

function planScreenCheck(pane, screen) {
  if (pane.agent !== 'claude' || pane.disposed || pane.state === 'dead') return;
  const pl = panePlan(pane);
  if (PLAN_MENU_KEEP_RE.test(screen) || PLAN_FEEDBACK_INPUT_RE.test(screen)) {
    const opts = parsePlanMenu(screen);
    if (opts) {
      pl.menu = { options: opts };
      pl.menuMiss = 0;
      if (pl.state !== 'ready' && pl.state !== 'pending-result') planBecameReady(pane);
      return;
    }
  }
  if (pl.state === 'ready' && ++pl.menuMiss >= 2) {
    pl.menu = null;
    planSetState(pane, 'pending-result');
    if (planModalPane === pane && planOpen()) {
      setPlanDocMsg('The approval menu was answered in the terminal — waiting for the result…');
    }
  }
}

function planBecameReady(pane) {
  planSetState(pane, 'ready');
  // The existing attention path already badges the pane and fires the OS
  // notification (the menu matches MENU_PATTERNS); here we surface the doc.
  if (planModalPane === pane && planOpen()) { refreshPlanReview(); return; }
  if (localStorage.getItem('hm.planAutoOpen') === '0') return;
  // In the chat view the approval card embeds the whole review (plan,
  // comments, request-changes) — popping the window over it would be noise.
  if (pane === focusedPane && !planOpen() && pane.view !== 'chat') openPlanReview(pane);
}

// --- The review window -------------------------------------------------------
function planOpen() { return !planBackdrop.classList.contains('hidden'); }

function openPlanReview(pane) {
  planModalPane = pane || null;
  planDrafting = false;
  planPendingSel = null;
  planRenderedMtime = 0;
  planDocNote.value = '';
  setPlanDocMsg('');
  planBackdrop.classList.remove('hidden');
  refreshPlanReview();
  startPlanPoll();
}

function closePlanReview() {
  planBackdrop.classList.add('hidden');
  stopPlanPoll();
  hideCommentBtn();
  planModalPane = null;
  planText = null;
  planDrafting = false;
  planPendingSel = null;
}

$('plan-doc-close').onclick = () => closePlanReview();
$('plan-doc-request').onclick = () => requestPlanFromThread();
$('plan-doc-copy').onclick = async () => {
  if (planText == null) { setPlanDocMsg('No plan to copy.', 'err'); return; }
  try { await navigator.clipboard.writeText(planText); setPlanDocMsg('Copied ✓', 'ok'); }
  catch (_) { setPlanDocMsg('Could not copy to the clipboard.', 'err'); }
};
planBackdrop.addEventListener('mousedown', (e) => { if (e.target === planBackdrop) closePlanReview(); });
planDocNote.addEventListener('input', () => paintPlanActions());

function setPlanDocMsg(text, kind) {
  planDocMsg.textContent = text || '';
  planDocMsg.className = kind || '';
}

// A live, non-dead focused thread (same guard the voice/insert paths use).
function livePane() {
  return focusedPane && !focusedPane.disposed && focusedPane.state !== 'dead' ? focusedPane : null;
}

// Assign a stable plan id to a pane the first time it's needed, and persist it.
function ensurePlanId(pane) {
  if (!pane.planId) {
    pane.planId = nextId('plan');
    if (pane.board) persistLayout(pane.board.id);
  }
  return pane.planId;
}

// While waiting for a ⟳-requested rewrite: { pane, since } (the plan file's
// mtime at request time) so the refresh can tell when the thread actually wrote.
let planAwait = null;

// The pane the review's actions should drive: the one it was opened on, or
// the focused thread as a fallback when that pane is gone.
function planActionPane() {
  if (planModalPane && !planModalPane.disposed && planModalPane.state !== 'dead') return planModalPane;
  return livePane();
}

// Type a request into the thread asking it to (re)write its plan file — the
// manual path for ChatGPT threads and threads outside plan mode.
async function requestPlanFromThread() {
  const pane = planActionPane();
  if (!pane) { setPlanDocMsg('Click a thread first, then ask it for a plan.', 'err'); return; }
  const planId = ensurePlanId(pane);
  const dir = pane.board && pane.board.dir;
  // Opting into plans → keep `.hivemind/` out of the project's Source Control.
  if (dir) window.api.plan.ensureIgnored(dir);
  // Note the plan's current mtime so we can detect the thread's rewrite.
  let since = 0;
  if (dir) { const cur = await window.api.plan.read(dir, planId); if (cur && cur.ok) since = cur.mtime || 0; }
  const rel = '.hivemind/plans/' + planId + '.md';
  typePrompt(pane, `Write your current plan to ${rel} as GitHub-flavoured markdown, overwriting any existing file. Create the folder if needed.`);
  setPlanDocMsg('Asked the thread to write its plan — it will appear here once written.', 'ok');
  const token = { pane, since };
  planAwait = token;
  setTimeout(() => {
    if (planAwait === token) {
      planAwait = null;
      if (planModalPane === pane && planOpen()) {
        setPlanDocMsg('No plan written yet — the thread may still be working.');
      }
    }
  }, 30000);
}

// Read the shown pane's plan + comments and render them. Content source, in
// order: the plan file the transcript revealed (native or hivemind), the
// legacy ⟳ file keyed by planId, and the ExitPlanMode input as a last resort
// (it can be truncated in transit, so the file is always preferred).
async function refreshPlanReview() {
  if (!planOpen()) return;
  const pane = planModalPane;
  if (!pane) { renderPlanDocState({ ok: false, reason: 'no-thread' }); return; }
  const pl = panePlan(pane);
  const dir = pane.board && pane.board.dir;
  if (!dir) { renderPlanDocState({ ok: false, reason: 'no-dir' }); return; }
  let res = null;
  if (pl.file) res = await window.api.plan.readFile(dir, pl.file);
  if ((!res || !res.ok) && pane.planId) {
    const legacy = await window.api.plan.read(dir, pane.planId);
    if (legacy && legacy.ok) { res = legacy; if (!pl.file) pl.source = 'hivemind'; }
  }
  if ((!res || !res.ok) && pl.exitPlanText) res = { ok: true, content: pl.exitPlanText, mtime: 0 };
  const key = planCommentsKey(pane);
  const cmtRes = key ? await window.api.plan.readComments(dir, key) : null;
  if (planModalPane !== pane || !planOpen()) return; // moved on during the reads
  planComments = (cmtRes && cmtRes.comments) || [];
  if (!res || !res.ok) { renderPlanDocState(res || { ok: false, reason: 'not-found' }); return; }
  planText = res.content;
  planRenderedMtime = res.mtime || 0;
  // If we were waiting on a ⟳ request and the file is now newer, confirm it.
  const confirmed = planAwait && planAwait.pane === pane && (res.mtime || 0) > planAwait.since;
  if (confirmed) planAwait = null;
  renderPlan();
  if (confirmed) setPlanDocMsg('Plan updated ✓', 'ok');
}

// Live refresh while the review is open: re-read on mtime change (the same
// polling transcript.js uses — fs.watch misses appends on Windows, and native
// plan files live outside the watched project tree anyway). Paused while a
// comment draft is open so a re-render can't clobber it.
function startPlanPoll() {
  if (!planPollTimer) planPollTimer = setInterval(planPollTick, 1200);
}
function stopPlanPoll() {
  clearInterval(planPollTimer);
  planPollTimer = null;
}
async function planPollTick() {
  if (!planOpen() || planDrafting) return;
  const pane = planModalPane;
  if (!pane) return;
  const pl = panePlan(pane);
  const dir = pane.board && pane.board.dir;
  if (!dir) return;
  let res = null;
  if (pl.file) res = await window.api.plan.readFile(dir, pl.file);
  else if (pane.planId) res = await window.api.plan.read(dir, pane.planId);
  if (!planOpen() || planModalPane !== pane || planDrafting) return;
  if (res && res.ok && ((res.mtime || 0) !== planRenderedMtime || planText == null)) refreshPlanReview();
}

function renderPlanDocState(res) {
  planText = null;
  planRenderedMtime = 0;
  planDocBody.innerHTML = '';
  planCommentsEl.innerHTML = '';
  planCommentsEl.classList.add('hidden');
  planDocTitle.textContent = 'Plan';
  paintPlanActions();
  const wrap = document.createElement('div');
  wrap.className = 'git-empty';
  const reason = res && res.reason;
  if (reason === 'no-dir') {
    wrap.textContent = 'This hive has no project directory set. Edit the hive to choose one.';
  } else if (reason === 'no-thread') {
    wrap.textContent = 'Click a thread first, then open the plan review.';
  } else if (reason === 'not-found') {
    const p = document.createElement('p');
    p.textContent = 'No plan yet. Start the thread in the Plan permission mode and its plan appears here on its own — or ask for one now:';
    const btn = document.createElement('button');
    btn.className = 'plan-send-btn plan-empty-btn';
    btn.textContent = 'Ask this thread to write a plan';
    btn.onclick = () => requestPlanFromThread();
    wrap.append(p, btn);
  } else {
    wrap.textContent = (res && res.message ? res.message : 'Could not read the plan.').trim();
  }
  planDocBody.appendChild(wrap);
}

// Render the markdown, re-anchor comment highlights, and draw the comment list.
function renderPlan() {
  const pane = planModalPane;
  const pl = pane ? panePlan(pane) : null;
  planDocBody.innerHTML = markdownToHtml(planText || '');
  // Native plan-mode files belong to Claude Code while it plans — render
  // their task checkboxes read-only instead of writing into ~/.claude/plans.
  if (!pl || pl.source !== 'hivemind') {
    planDocBody.querySelectorAll('input.plan-check').forEach((cb) => { cb.disabled = true; });
  }
  for (const c of planComments) {
    if (c.resolved) continue;
    c._anchored = highlightOccurrence(planDocBody, c.quote, c.occurrence || 0, c.id);
  }
  const heading = /^#{1,3}\s+(.+)$/m.exec(planText || '');
  planDocTitle.textContent = heading ? heading[1].trim() : 'Plan';
  paintPlanActions();
  renderCommentList();
}

// Status chip + action-button enablement for the current pane/state.
function paintPlanActions() {
  const pane = planModalPane;
  const pl = pane ? panePlan(pane) : null;
  const state = pl ? pl.state : 'none';
  planDocStatus.textContent = PLAN_STATE_LABEL[state] || state;
  planDocStatus.className = 'plan-chip ' + state;
  planDocThread.textContent = pane ? ('— ' + (pane.captionText || pane.name || '')) : '';
  const live = pane && !pane.disposed && pane.state !== 'dead';
  const menu = (live && pl && pl.state === 'ready' && pl.menu && pl.menu.options) || null;
  // The run-with-it label varies by permission mode ("Yes, and bypass
  // permissions", …) — surface the exact option the button will pick.
  const autoOpt = menu && menu.find((o) => PLAN_MENU_AUTO_RE.test(o.label));
  planApproveAutoBtn.disabled = !autoOpt;
  planApproveAutoBtn.title = autoOpt
    ? 'Approve the plan — picks “' + autoOpt.label + '” in the thread'
    : 'Approve the plan — edits are auto-accepted';
  planApproveManualBtn.disabled = !(menu && menu.some((o) => PLAN_MENU_MANUAL_RE.test(o.label)));
  // Request-changes also works without the menu (hivemind/manual plans): it
  // then just types the comments into the thread.
  const hasFeedback = planComments.some((c) => !c.resolved && !c.sent) || !!planDocNote.value.trim();
  planReqChangesBtn.disabled = !live || !hasFeedback || planText == null;
}

// --- Minimal, dependency-free markdown -> HTML ------------------------------
// Escapes first, then handles the GitHub-flavoured subset a plan uses: headings,
// fenced/inline code, bold/italic, links, blockquotes, horizontal rules, pipe
// tables, and nested unordered/ordered/task lists. Task-list checkboxes carry a
// `data-line` index back to the source markdown so they can be toggled in place
// (see the checkbox handler below).
const MD_LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const MD_TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const MD_TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function mdInline(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  // [text](url) — only web/mail links become anchors; anything else stays text.
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) =>
    /^(https?:|mailto:)/i.test(url) ? `<a href="${url}" class="plan-link">${txt}</a>` : txt);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return t;
}

// Split a table row on unescaped pipes, dropping the optional edge pipes.
function mdTableCells(row) {
  const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((c) => c.trim());
}

// Render a tree of list items (built by parseMdList) into nested <ul>/<ol>.
function renderMdItems(children) {
  if (!children.length) return '';
  const tag = children[0].ordered ? 'ol' : 'ul';
  let html = `<${tag}>`;
  for (const c of children) {
    const task = MD_TASK_RE.exec(c.content);
    if (task) {
      const checked = task[1].toLowerCase() === 'x';
      html += '<li class="plan-task">' +
        `<input type="checkbox" class="plan-check" data-line="${c.line}"${checked ? ' checked' : ''}>` +
        `<span>${mdInline(task[2])}</span>`;
    } else {
      html += `<li>${mdInline(c.content)}`;
    }
    html += renderMdItems(c.children) + '</li>';
  }
  return html + `</${tag}>`;
}

// Consume consecutive list lines from `start`, building an indent-based tree.
// Returns [html, nextIndex]. Each node keeps its source line for checkboxes.
function parseMdList(lines, start) {
  const root = { indent: -1, children: [] };
  const stack = [root];
  let i = start;
  while (i < lines.length) {
    const m = MD_LIST_RE.exec(lines[i]);
    if (!m) break;
    const indent = m[1].replace(/\t/g, '  ').length;
    const node = { indent, ordered: /\d/.test(m[2]), content: m[3], line: i, children: [] };
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
    i++;
  }
  return [renderMdItems(root.children), i];
}

function markdownToHtml(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {                       // fenced code block
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // closing fence
      out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const n = h[1].length; out.push(`<h${n}>${mdInline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; } // rule
    // Pipe table: a header row followed by a --- separator row.
    if (line.includes('|') && i + 1 < lines.length && MD_TABLE_SEP_RE.test(lines[i + 1])) {
      const head = mdTableCells(line);
      i += 2; // header + separator
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(mdTableCells(lines[i])); i++; }
      const th = head.map((c) => `<th>${mdInline(c)}</th>`).join('');
      const body = rows.map((r) => '<tr>' + head.map((_, k) => `<td>${mdInline(r[k] || '')}</td>`).join('') + '</tr>').join('');
      out.push(`<table class="plan-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {                    // blockquote
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + mdInline(buf.join(' ')) + '</blockquote>');
      continue;
    }
    if (MD_LIST_RE.test(line)) {                    // nested / task list
      const [html, next] = parseMdList(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }      // blank
    const buf = [];                                 // paragraph (until a block)
    while (i < lines.length && !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6}\s|```|\s*>\s|\s*([-*_])(\s*\2){2,}\s*$)/.test(lines[i]) && !MD_LIST_RE.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push('<p>' + mdInline(buf.join(' ')) + '</p>');
  }
  return out.join('\n');
}

// Wrap the Nth (0-based) occurrence of `quote` inside `root` in a <mark>, even
// when it spans element boundaries. Returns true if it anchored.
function highlightOccurrence(root, quote, occurrence, id) {
  if (!quote) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let full = '';
  let n;
  while ((n = walker.nextNode())) { nodes.push({ node: n, start: full.length }); full += n.nodeValue; }
  let idx = -1;
  for (let k = 0; k <= occurrence; k++) { idx = full.indexOf(quote, idx + 1); if (idx === -1) return false; }
  const gStart = idx, gEnd = idx + quote.length;
  const segs = [];
  for (const { node, start } of nodes) {
    const nEnd = start + node.nodeValue.length;
    const s = Math.max(gStart, start), e = Math.min(gEnd, nEnd);
    if (s < e) segs.push({ node, s: s - start, e: e - start });
  }
  // Apply last-to-first so earlier offsets stay valid as text nodes split.
  for (let j = segs.length - 1; j >= 0; j--) {
    const r = document.createRange();
    r.setStart(segs[j].node, segs[j].s);
    r.setEnd(segs[j].node, segs[j].e);
    const mark = document.createElement('mark');
    mark.className = 'plan-cmt';
    mark.dataset.id = id;
    try { r.surroundContents(mark); } catch (_) { /* skip un-wrappable segment */ }
  }
  return segs.length > 0;
}

// Links in rendered markdown open in the OS browser, not the file:// renderer
// window. Document-level: the same anchors appear in the plan review window,
// chat bubbles, and the chat plan-approval card.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.plan-link');
  if (a) {
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href) window.api.openExternal(href);
  }
});

// Toggling a task checkbox flips `[ ]`<->`[x]` on its source line and writes the
// plan file back, so plan progress edited here persists (and the thread sees it).
// Only for hivemind-source plans — native checkboxes render disabled.
planDocBody.addEventListener('change', async (e) => {
  const cb = e.target;
  if (!cb || !cb.classList || !cb.classList.contains('plan-check') || cb.disabled) return;
  const ln = parseInt(cb.dataset.line, 10);
  const pane = planModalPane;
  const dir = pane && pane.board && pane.board.dir;
  const key = planCommentsKey(pane); // hivemind plans: same basename as the .md
  if (!Number.isInteger(ln) || planText == null || !dir || !key) return;
  const lines = planText.split('\n');
  if (ln < 0 || ln >= lines.length) return;
  const mark = cb.checked ? 'x' : ' ';
  const next = lines[ln].replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/, `$1[${mark}]`);
  if (next === lines[ln]) return;       // source line didn't match — leave it be
  lines[ln] = next;
  planText = lines.join('\n');
  renderPlan();                          // instant feedback; re-anchors comments
  const res = await window.api.plan.write(dir, key, planText);
  if (res && !res.ok) setPlanDocMsg(res.message || 'Could not update the plan file.', 'err');
  else if (res && res.ok) planRenderedMtime = res.mtime || planRenderedMtime;
});

// --- Highlight-to-comment ---------------------------------------------------
function hideCommentBtn() { planCommentBtn.classList.add('hidden'); }

// The `.hivemind/plans/` key that comments (and hivemind plan write-backs)
// are stored under: the plan file's basename when it's filesystem-safe
// (covers both `plan-….md` and native `<slug>.md`), a hash of the path
// otherwise, and the pane's legacy planId when no file is known yet.
function planCommentsKey(pane) {
  if (!pane) return null;
  const pl = panePlan(pane);
  if (pl.file) {
    const base = String(pl.file).split(/[\\/]/).pop().replace(/\.md$/i, '');
    if (/^[A-Za-z0-9._-]+$/.test(base)) return base;
    let h = 5381;
    const s = String(pl.file).toLowerCase();
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 'native-' + h.toString(16);
  }
  return pane.planId || null;
}

// Show the floating "＋ Comment" button when the user selects plan text.
planDocBody.addEventListener('mouseup', () => {
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideCommentBtn(); return; }
    const range = sel.getRangeAt(0);
    if (!planDocBody.contains(range.commonAncestorContainer)) { hideCommentBtn(); return; }
    const rect = range.getBoundingClientRect();
    const host = planModal.getBoundingClientRect();
    planCommentBtn.style.top = (rect.bottom - host.top + 4) + 'px';
    planCommentBtn.style.left = Math.max(4, rect.left - host.left) + 'px';
    planCommentBtn.classList.remove('hidden');
  }, 0);
});

// Capture the selection's quote + occurrence and open an inline editor.
planCommentBtn.onclick = () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { hideCommentBtn(); return; }
  const quote = sel.toString();
  const range = sel.getRangeAt(0);
  // Global offset of the selection start within the plan's plaintext.
  const pre = document.createRange();
  pre.setStart(planDocBody, 0);
  pre.setEnd(range.startContainer, range.startOffset);
  const startIndex = pre.toString().length;
  const full = planDocBody.textContent;
  let occ = 0, from = 0, at;
  while ((at = full.indexOf(quote, from)) !== -1 && at < startIndex) { occ++; from = at + 1; }
  planPendingSel = { quote, occurrence: occ };
  sel.removeAllRanges();
  hideCommentBtn();
  planDrafting = true;
  renderCommentList();
};

// Draw the comment rail (plus an inline draft editor when adding one).
function renderCommentList() {
  planCommentsEl.innerHTML = '';
  const unresolved = planComments.filter((c) => !c.resolved);
  planCommentsEl.classList.toggle('hidden', !unresolved.length && !planDrafting);
  paintPlanActions();

  if (planDrafting && planPendingSel) {
    const box = document.createElement('div');
    box.className = 'plan-cmt-draft';
    const q = document.createElement('div');
    q.className = 'plan-cmt-quote';
    q.textContent = '“' + planPendingSel.quote + '”';
    const ta = document.createElement('textarea');
    ta.className = 'plan-cmt-input';
    ta.placeholder = 'Add a comment…';
    const row = document.createElement('div');
    row.className = 'plan-cmt-actions';
    const save = document.createElement('button');
    save.className = 'plan-send-btn';
    save.textContent = 'Comment';
    save.onclick = () => saveDraftComment(ta.value);
    const cancel = document.createElement('button');
    cancel.className = 'plan-mini-btn';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => { planDrafting = false; planPendingSel = null; renderCommentList(); };
    row.append(save, cancel);
    box.append(q, ta, row);
    planCommentsEl.appendChild(box);
    ta.focus();
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveDraftComment(ta.value); }
    });
  }

  if (!unresolved.length && !planDrafting) return;

  unresolved.forEach((c, n) => {
    const item = document.createElement('div');
    item.className = 'plan-cmt-item' +
      (c._anchored === false ? ' orphaned' : '') + (c.sent ? ' sent' : '');
    const num = document.createElement('span');
    num.className = 'plan-cmt-num';
    num.textContent = String(n + 1);
    const main = document.createElement('div');
    main.className = 'plan-cmt-main';
    const q = document.createElement('div');
    q.className = 'plan-cmt-quote';
    q.textContent = '“' + c.quote + '”' + (c._anchored === false ? '  (not found in current plan)' : '');
    q.onclick = () => {
      const mark = planDocBody.querySelector('mark.plan-cmt[data-id="' + c.id + '"]');
      if (mark) mark.scrollIntoView({ block: 'center' });
    };
    const body = document.createElement('div');
    body.className = 'plan-cmt-text';
    body.textContent = c.body;
    main.append(q, body);
    const act = document.createElement('div');
    act.className = 'plan-cmt-act';
    if (c.sent) {
      const tag = document.createElement('span');
      tag.className = 'plan-cmt-tag';
      tag.textContent = 'sent';
      tag.title = 'Already sent to the thread with a Request-changes round';
      item.append(num, main, tag, act);
    } else {
      item.append(num, main, act);
    }
    act.appendChild(mkMini('✓', 'Resolve (remove) this comment', () => resolveComment(c.id)));
    planCommentsEl.appendChild(item);
  });
}

async function saveDraftComment(text) {
  const body = (text || '').trim();
  if (!body || !planPendingSel) { planDrafting = false; planPendingSel = null; renderCommentList(); return; }
  planComments.push({
    id: nextId('cmt'), quote: planPendingSel.quote,
    occurrence: planPendingSel.occurrence, body, resolved: false, sent: false,
  });
  planDrafting = false;
  planPendingSel = null;
  await persistComments();
  renderPlan();
}

async function resolveComment(id) {
  planComments = planComments.filter((c) => c.id !== id);
  await persistComments();
  renderPlan();
}

async function persistComments() {
  const pane = planModalPane;
  const dir = pane && pane.board && pane.board.dir;
  const key = planCommentsKey(pane);
  if (!dir || !key) return;
  window.api.plan.ensureIgnored(dir); // sidecars live in `.hivemind/` — keep it out of Git
  const res = await window.api.plan.writeComments(dir, key, planComments);
  if (res && !res.ok) setPlanDocMsg(res.message || 'Could not save comments.', 'err');
  // Keep the chat card's embedded rail in step with what the window changed.
  if (pane) { panePlan(pane).cardComments = null; refreshCardPlan(pane); }
}

// --- Approve / Request changes ----------------------------------------------
// Both drive Claude Code's own "Ready to code?" menu in the hidden terminal,
// finding the option to press by label in the live screen parse (the digits
// move when optional menu entries appear).
function planAnswerMenu(labelRe, busyMsg) {
  const pane = planModalPane;
  if (!pane || pane.disposed || pane.state === 'dead') {
    setPlanDocMsg('This thread is no longer running.', 'err');
    return;
  }
  const pl = panePlan(pane);
  const opts = (pl.menu && pl.menu.options) || [];
  const idx = opts.findIndex((o) => labelRe.test(o.label));
  if (pl.state !== 'ready' || idx < 0) {
    setPlanDocMsg('The thread isn’t showing its approval menu right now — answer in the terminal.', 'err');
    paintPlanActions();
    return;
  }
  sendToPane(pane, String(idx + 1));
  planSetState(pane, 'pending-result');
  setPlanDocMsg(busyMsg);
}

planApproveAutoBtn.onclick = () => planAnswerMenu(PLAN_MENU_AUTO_RE, 'Approving (auto-accept edits)…');
planApproveManualBtn.onclick = () => planAnswerMenu(PLAN_MENU_MANUAL_RE, 'Approving (manual edits)…');

// Wait for the screen to show `re` (e.g. the feedback input's placeholder)
// before pasting — pasting into a menu that hasn't opened its input yet would
// scatter keystrokes into the select.
async function planAwaitScreen(pane, re, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pane.disposed || pane.state === 'dead') return false;
    if (re.test(screenText(pane))) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

// Deliver review feedback to a thread — the shared core behind the review
// window's Request changes button and the chat card's. When the approval menu
// is up, pick "No, keep planning", wait for its inline feedback input, and
// paste the comments; otherwise type the revision request directly. Marks the
// comments sent — persisting them is the caller's job (the window and the
// card each own their copy of the comment list).
async function planSendFeedback(pane, unsent, note) {
  const parts = unsent.map((c, n) => `[${n + 1}] Re "${c.quote}": ${c.body}`);
  if (note) parts.push(`[${parts.length + 1}] ${note}`);
  const feedback = 'Please revise the plan. Comments:\n' + parts.join('\n');
  const pl = panePlan(pane);
  const opts = (pl.menu && pl.menu.options) || [];
  const keepIdx = opts.findIndex((o) => PLAN_MENU_FEEDBACK_RE.test(o.label));
  if (pl.state === 'ready' && keepIdx >= 0) {
    // Native plan mode: pick "No, keep planning", wait for its inline feedback
    // input to appear, then paste the comments as the revision request. In the
    // v2.1.21x menu the input (and its placeholder) is always on screen, so
    // the await returns immediately — the fixed delay keeps the paste from
    // racing the digit keypress that moves selection onto the input row.
    sendToPane(pane, String(keepIdx + 1));
    planSetState(pane, 'pending-result');
    await new Promise((r) => setTimeout(r, 200));
    await planAwaitScreen(pane, PLAN_FEEDBACK_INPUT_RE, 2500);
    typePrompt(pane, feedback);
  } else {
    // No approval menu (hivemind/manual plans): just ask the thread directly.
    typePrompt(pane, feedback + '\nThen rewrite the plan file at the same path.');
  }
  unsent.forEach((c) => { c.sent = true; });
}

planReqChangesBtn.onclick = async () => {
  const pane = planModalPane;
  if (!pane || pane.disposed || pane.state === 'dead') {
    setPlanDocMsg('This thread is no longer running.', 'err');
    return;
  }
  const unsent = planComments.filter((c) => !c.resolved && !c.sent);
  const note = planDocNote.value.trim();
  if (!unsent.length && !note) { setPlanDocMsg('Add a comment (or overall feedback) first.', 'err'); return; }
  setPlanDocMsg('Sending your feedback…');
  await planSendFeedback(pane, unsent, note);
  planDocNote.value = '';
  await persistComments();
  renderCommentList();
  setPlanDocMsg('Feedback sent — the thread will revise the plan.', 'ok');
};

// --- Chat-card plan review ---------------------------------------------------
// The review window's whole experience, embedded in the chat's plan-approval
// card: comment highlights, highlight-to-comment, the comment rail, and an
// overall-feedback line with Request changes. Approve lives on the card
// already — its menu options are the approval menu. The window and the card
// share the same sidecar comments (each invalidates the other's cache after a
// write), and everything mid-flight on the card (an unsaved draft, the
// feedback line) is kept on panePlan so the screen probe's card re-renders
// can't lose it.

// The card's comment list, from a per-pane cache; a missing cache kicks a
// background read that re-renders the card section when it lands.
function cardPlanComments(pane) {
  const pl = panePlan(pane);
  if (pl.cardComments) return pl.cardComments;
  if (!pl.cardCmtFetch) {
    pl.cardCmtFetch = (async () => {
      const dir = pane.board && pane.board.dir;
      const key = planCommentsKey(pane);
      const res = dir && key ? await window.api.plan.readComments(dir, key) : null;
      if (pane.disposed) return;
      pl.cardComments = (res && res.comments) || [];
      refreshCardPlan(pane);
    })().finally(() => { pl.cardCmtFetch = null; });
  }
  return null;
}

async function cardPersistComments(pane) {
  const dir = pane.board && pane.board.dir;
  const key = planCommentsKey(pane);
  if (!dir || !key) return;
  window.api.plan.ensureIgnored(dir); // sidecars live in `.hivemind/` — keep it out of Git
  const res = await window.api.plan.writeComments(dir, key, panePlan(pane).cardComments || []);
  if (res && !res.ok) hmToast(res.message || 'Could not save comments.', 'err');
  // Keep an open review window on this thread in step with the card.
  if (planModalPane === pane && planOpen()) refreshPlanReview();
}

// Rebuild the plan section of this pane's approval card in place (comments
// changed under it) — a no-op when no card is showing.
function refreshCardPlan(pane) {
  const c = pane.chat;
  if (!c) return;
  const row = c.byKey.get(screenQuestionKey(pane));
  const fold = row && row.querySelector('.chat-plan-fold');
  if (fold && fold._hmRebuild) fold._hmRebuild();
}

// Build (or rebuild) everything under the fold's summary: the rendered plan
// with comment highlights and a floating ＋ Comment button, the comment rail,
// and the feedback row.
function buildCardPlanReview(pane, fold, planMd) {
  const pl = panePlan(pane);
  fold._hmRebuild = () => {
    while (fold.childElementCount > 1) fold.lastElementChild.remove(); // keep the <summary>
    buildCardPlanReview(pane, fold, planMd);
  };

  const body = document.createElement('div');
  body.className = 'chat-md chat-plan-body';
  body.innerHTML = markdownToHtml(planMd);
  // Native plan-mode files belong to Claude Code while it plans — their
  // checkboxes render read-only; hivemind-written plans tick and write back,
  // same as the review window.
  if (pl.source !== 'hivemind') {
    body.querySelectorAll('input.plan-check').forEach((cb) => { cb.disabled = true; });
  } else {
    body.addEventListener('change', async (e) => {
      const cb = e.target;
      if (!cb || !cb.classList || !cb.classList.contains('plan-check') || cb.disabled) return;
      const ln = parseInt(cb.dataset.line, 10);
      const dir = pane.board && pane.board.dir;
      const key = planCommentsKey(pane);
      if (!Number.isInteger(ln) || !dir || !key) return;
      const lines = planMd.split('\n');
      if (ln < 0 || ln >= lines.length) return;
      const mark = cb.checked ? 'x' : ' ';
      const next = lines[ln].replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/, `$1[${mark}]`);
      if (next === lines[ln]) return;   // source line didn't match — leave it be
      lines[ln] = next;
      pl.cardText = lines.join('\n');
      const res = await window.api.plan.write(dir, key, pl.cardText);
      if (res && !res.ok) hmToast(res.message || 'Could not update the plan file.', 'err');
      syncScreenQuestion(pane);         // planMd changed → the card re-renders
    });
  }

  const comments = cardPlanComments(pane) || [];
  for (const c of comments) {
    if (c.resolved) continue;
    c._anchored = highlightOccurrence(body, c.quote, c.occurrence || 0, c.id);
  }

  // Floating ＋ Comment over a text selection. It lives next to the body (not
  // inside it — its label would pollute the body's textContent, which is what
  // quotes anchor to), so it doesn't track the body's internal scroll: hide it
  // when the body scrolls and let the next mouseup re-place it.
  const wrap = document.createElement('div');
  wrap.className = 'chat-plan-wrap';
  const cmtBtn = document.createElement('button');
  cmtBtn.className = 'plan-comment-btn hidden';
  cmtBtn.textContent = '＋ Comment';
  cmtBtn.title = 'Comment on the selected text';
  wrap.append(body, cmtBtn);
  body.addEventListener('scroll', () => cmtBtn.classList.add('hidden'));
  body.addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) { cmtBtn.classList.add('hidden'); return; }
      const range = sel.getRangeAt(0);
      if (!body.contains(range.commonAncestorContainer)) { cmtBtn.classList.add('hidden'); return; }
      const rect = range.getBoundingClientRect();
      const host = wrap.getBoundingClientRect();
      cmtBtn.style.top = (rect.bottom - host.top + 4) + 'px';
      cmtBtn.style.left = Math.max(4, rect.left - host.left) + 'px';
      cmtBtn.classList.remove('hidden');
    }, 0);
  });
  cmtBtn.onclick = (e) => {
    e.stopPropagation();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { cmtBtn.classList.add('hidden'); return; }
    const quote = sel.toString();
    const range = sel.getRangeAt(0);
    // Global offset of the selection start within the plan's plaintext.
    const pre = document.createRange();
    pre.setStart(body, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const startIndex = pre.toString().length;
    const full = body.textContent;
    let occ = 0, from = 0, at;
    while ((at = full.indexOf(quote, from)) !== -1 && at < startIndex) { occ++; from = at + 1; }
    sel.removeAllRanges();
    pl.cardDraft = { quote, occurrence: occ, text: '', fresh: true };
    fold._hmRebuild();
  };

  // Comment rail: the in-progress draft, then the unresolved comments.
  const rail = document.createElement('div');
  rail.className = 'chat-plan-cmts';
  const unresolved = comments.filter((c) => !c.resolved);
  const draft = pl.cardDraft;
  rail.classList.toggle('hidden', !unresolved.length && !draft);
  let focusTa = null;
  if (draft) {
    const box = document.createElement('div');
    box.className = 'plan-cmt-draft';
    const q = document.createElement('div');
    q.className = 'plan-cmt-quote';
    q.textContent = '“' + draft.quote + '”';
    const ta = document.createElement('textarea');
    ta.className = 'plan-cmt-input';
    ta.placeholder = 'Add a comment…';
    ta.value = draft.text || '';
    ta.addEventListener('input', () => { draft.text = ta.value; });
    const save = async () => {
      const text = ta.value.trim();
      pl.cardDraft = null;
      if (text) {
        (pl.cardComments || (pl.cardComments = [])).push({
          id: nextId('cmt'), quote: draft.quote, occurrence: draft.occurrence,
          body: text, resolved: false, sent: false,
        });
        await cardPersistComments(pane);
      }
      fold._hmRebuild();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    });
    const actions = document.createElement('div');
    actions.className = 'plan-cmt-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'plan-send-btn';
    saveBtn.textContent = 'Comment';
    saveBtn.onclick = save;
    const cancel = document.createElement('button');
    cancel.className = 'plan-mini-btn';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => { pl.cardDraft = null; fold._hmRebuild(); };
    actions.append(saveBtn, cancel);
    box.append(q, ta, actions);
    rail.appendChild(box);
    // Focus only on the rebuild the ＋ Comment click triggered — background
    // re-renders (comments loading, plan updating) must not steal the caret.
    if (draft.fresh) { delete draft.fresh; focusTa = ta; }
  }
  unresolved.forEach((c, n) => {
    const item = document.createElement('div');
    item.className = 'plan-cmt-item' +
      (c._anchored === false ? ' orphaned' : '') + (c.sent ? ' sent' : '');
    const num = document.createElement('span');
    num.className = 'plan-cmt-num';
    num.textContent = String(n + 1);
    const main = document.createElement('div');
    main.className = 'plan-cmt-main';
    const q = document.createElement('div');
    q.className = 'plan-cmt-quote';
    q.textContent = '“' + c.quote + '”' + (c._anchored === false ? '  (not found in current plan)' : '');
    q.onclick = () => {
      const mark = body.querySelector('mark.plan-cmt[data-id="' + c.id + '"]');
      if (mark) mark.scrollIntoView({ block: 'nearest' });
    };
    const text = document.createElement('div');
    text.className = 'plan-cmt-text';
    text.textContent = c.body;
    main.append(q, text);
    const act = document.createElement('div');
    act.className = 'plan-cmt-act';
    act.appendChild(mkMini('✓', 'Resolve (remove) this comment', async () => {
      pl.cardComments = (pl.cardComments || []).filter((x) => x.id !== c.id);
      await cardPersistComments(pane);
      fold._hmRebuild();
    }));
    if (c.sent) {
      const tag = document.createElement('span');
      tag.className = 'plan-cmt-tag';
      tag.textContent = 'sent';
      tag.title = 'Already sent to the thread with a Request-changes round';
      item.append(num, main, tag, act);
    } else {
      item.append(num, main, act);
    }
    rail.appendChild(item);
  });

  // Feedback row: overall note + Request changes (Approve is the card's own
  // menu options right below).
  const foot = document.createElement('div');
  foot.className = 'chat-plan-feedback';
  const note = document.createElement('input');
  note.type = 'text';
  note.placeholder = 'Overall feedback (optional)…';
  note.spellcheck = true;
  note.value = pl.cardNote || '';
  const send = document.createElement('button');
  send.className = 'plan-mini-btn';
  send.textContent = 'Request changes';
  send.title = 'Pick “No, keep planning” in the thread and send your comments as feedback';
  const paintSend = () => {
    const live = !pane.disposed && pane.state !== 'dead';
    const hasFeedback = (pl.cardComments || []).some((c) => !c.resolved && !c.sent) || !!note.value.trim();
    send.disabled = !live || !hasFeedback;
  };
  note.addEventListener('input', () => { pl.cardNote = note.value; paintSend(); });
  paintSend();
  send.onclick = async (e) => {
    e.stopPropagation();
    if (pane.disposed || pane.state === 'dead') { hmToast('This thread is no longer running.', 'err'); return; }
    const unsent = (pl.cardComments || []).filter((c) => !c.resolved && !c.sent);
    const noteText = note.value.trim();
    if (!unsent.length && !noteText) { hmToast('Add a comment (or overall feedback) first.', 'err'); return; }
    send.disabled = true;
    await planSendFeedback(pane, unsent, noteText);
    pl.cardNote = '';
    await cardPersistComments(pane);
    fold._hmRebuild();
    hmToast('Feedback sent — the thread will revise the plan.');
  };
  foot.append(note, send);

  fold.append(wrap, rail, foot);
  if (focusTa) focusTa.focus();
}

// -- Diff viewer ------------------------------------------------------------
const diffBackdrop = $('diff-backdrop');
const diffBody = $('diff-body');
const diffTitle = $('diff-title');

async function showDiff(f, staged) {
  const dir = activeDir();
  if (!dir) return;
  diffTitle.textContent = f.path;
  diffBody.innerHTML = '<span class="diff-meta">Loading…</span>';
  diffBackdrop.classList.remove('hidden');
  const res = await window.api.git.diff(dir, f.path, staged, f.untracked);
  diffBody.innerHTML = renderDiff(res.text || '(no changes)');
}

function escapeHtml(s) {
  // Escapes `"` and `'` as well as the angle brackets, so values interpolated
  // into HTML attributes (e.g. the href in mdInline's link rendering) can't
  // break out of the quoted attribute and inject new attributes/handlers.
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDiff(text) {
  return text.split('\n').map((line) => {
    let cls = '';
    if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-meta';
    else if (line.startsWith('@@')) cls = 'diff-hunk';
    else if (line.startsWith('+')) cls = 'diff-add';
    else if (line.startsWith('-')) cls = 'diff-del';
    else if (/^(diff |index |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) cls = 'diff-meta';
    const safe = escapeHtml(line) || ' ';
    return cls ? `<span class="${cls}">${safe}</span>` : safe;
  }).join('\n');
}

$('diff-close').onclick = () => diffBackdrop.classList.add('hidden');
diffBackdrop.addEventListener('mousedown', (e) => { if (e.target === diffBackdrop) diffBackdrop.classList.add('hidden'); });

// -- Branch menu ------------------------------------------------------------
const branchBackdrop = $('branch-backdrop');
const branchListEl = $('branch-list');
const branchNew = $('branch-new');

async function openBranchMenu() {
  const dir = activeDir();
  if (!dir) return;
  branchListEl.innerHTML = '<li>Loading…</li>';
  branchNew.value = '';
  branchBackdrop.classList.remove('hidden');
  const list = await window.api.git.branches(dir);
  const current = lastStatus && lastStatus.branch;
  branchListEl.innerHTML = '';
  for (const b of list) {
    const li = document.createElement('li');
    li.textContent = b;
    if (b === current) { li.className = 'current'; li.textContent = '✓ ' + b; }
    else li.onclick = () => switchBranch(b);
    branchListEl.appendChild(li);
  }
  if (!list.length) branchListEl.innerHTML = '<li>No branches yet — make your first commit.</li>';
  setTimeout(() => branchNew.focus(), 0);
}

function switchBranch(name) {
  branchBackdrop.classList.add('hidden');
  gitRun('Switching to ' + name, (d) => window.api.git.checkout(d, name), { okMsg: 'Switched to ' + name + '.' });
}

$('branch-create').onclick = () => {
  const name = branchNew.value.trim();
  if (!name) return;
  branchBackdrop.classList.add('hidden');
  gitRun('Creating ' + name, (d) => window.api.git.createBranch(d, name), { okMsg: 'Created and switched to ' + name + '.' });
};
branchNew.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('branch-create').click(); });
$('branch-cancel').onclick = () => branchBackdrop.classList.add('hidden');
branchBackdrop.addEventListener('mousedown', (e) => { if (e.target === branchBackdrop) branchBackdrop.classList.add('hidden'); });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Training stacks above Settings — close it first.
  if (voiceTrainIsOpen()) { closeVoiceTraining(); return; }
  if (!planBackdrop.classList.contains('hidden')) closePlanReview();
  else if (!diffBackdrop.classList.contains('hidden')) diffBackdrop.classList.add('hidden');
  else if (!branchBackdrop.classList.contains('hidden')) branchBackdrop.classList.add('hidden');
  else if (!ghBackdrop.classList.contains('hidden')) closeWizard();
  else { const ub = document.getElementById('usage-backdrop'); if (ub && !ub.classList.contains('hidden')) { ub.classList.add('hidden'); return; } const hb = document.getElementById('help-backdrop'); if (hb && !hb.classList.contains('hidden')) { hb.classList.add('hidden'); return; } const sb = document.getElementById('settings-backdrop'); if (sb && !sb.classList.contains('hidden')) sb.classList.add('hidden'); }
});

// ---------------------------------------------------------------------------
// Connect-to-GitHub wizard
//
// Two paths from the first screen:
//   1. Create a new repo  — uses the GitHub CLI (gh) to make a repo from this
//      folder, wire up origin, and push. Walks through gh install / sign-in.
//   2. Link an existing repo — paste a URL, set origin, push.
// ---------------------------------------------------------------------------
const ghBackdrop = $('gh-backdrop');
const ghBody = $('gh-body');
const ghMsg = $('gh-msg');
let ghBusy = false;

function ghSetMsg(text, kind) {
  if (!text) { ghMsg.classList.add('hidden'); ghMsg.textContent = ''; return; }
  ghMsg.textContent = text;
  ghMsg.className = 'gh-msg' + (kind ? ' ' + kind : '');
}

function closeWizard() { ghBackdrop.classList.add('hidden'); ghSetMsg(''); }

function openGitHubWizard() {
  const dir = activeDir();
  if (!dir) { setGitMsg('This hive has no project directory set.', 'err'); return; }
  if (lastStatus && lastStatus.reason === 'not-repo') {
    setGitMsg('Initialize a Git repository first, then connect it to GitHub.', 'err');
    return;
  }
  ghSetMsg('');
  ghBackdrop.classList.remove('hidden');
  renderWizardChoice();
}

$('gh-close').onclick = closeWizard;
ghBackdrop.addEventListener('mousedown', (e) => { if (e.target === ghBackdrop) closeWizard(); });

// -- Step 1: choose a path --------------------------------------------------
function renderWizardChoice() {
  ghBody.innerHTML = '';
  ghBody.appendChild(el('p', 'gh-intro', "Link this hive's project to a GitHub repository."));
  const opts = document.createElement('div');
  opts.className = 'gh-options';
  opts.append(
    wizardCard('＋ Create a new repository',
      'Make a brand-new GitHub repo from this folder and push your commits. Uses the GitHub CLI (gh).',
      startCreateFlow),
    wizardCard('🔗 Link an existing repository',
      'Already created a repo on GitHub? Paste its URL to connect this folder and push.',
      renderLinkStep),
  );
  ghBody.appendChild(opts);
}

function wizardCard(title, desc, onclick) {
  const c = document.createElement('button');
  c.className = 'gh-card';
  c.append(el('span', 'gh-card-title', title), el('span', 'gh-card-desc', desc));
  c.onclick = onclick;
  return c;
}

// -- Step 2a: create a new repo via gh --------------------------------------
async function startCreateFlow() {
  ghBody.innerHTML = '';
  ghBody.appendChild(el('p', 'gh-intro', 'Checking the GitHub CLI…'));
  const gh = await window.api.git.ghCheck();
  if (!gh.installed) { renderGhMissing(); return; }
  if (!gh.authenticated) { renderGhSignin(); return; }
  renderCreateForm(gh);
}

function renderGhMissing() {
  ghBody.innerHTML = '';
  ghBody.appendChild(el('p', 'gh-intro', 'The GitHub CLI (gh) is required to create a new repository from here.'));
  ghBody.appendChild(el('p', 'gh-note', 'Install it from https://cli.github.com, then come back and try again. Or link an existing repository instead.'));
  ghBody.appendChild(wizardActions({
    backTo: renderWizardChoice,
    right: [
      ['Link existing instead', renderLinkStep],
      ['Re-check', startCreateFlow, true],
    ],
  }));
}

function renderGhSignin() {
  ghBody.innerHTML = '';
  ghBody.appendChild(el('p', 'gh-intro', "You're not signed in to GitHub yet."));
  ghBody.appendChild(el('p', 'gh-note', 'Open a thread on this hive and run the command below, follow the browser prompts, then click “I’ve signed in”.'));
  ghBody.appendChild(el('div', 'gh-code', 'gh auth login'));
  ghBody.appendChild(wizardActions({
    backTo: renderWizardChoice,
    right: [["I've signed in — check again", startCreateFlow, true]],
  }));
}

function renderCreateForm(gh) {
  ghBody.innerHTML = '';
  const dir = activeDir();
  const folder = (dir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'my-project';

  ghBody.appendChild(el('p', 'gh-intro', `Signed in as ${gh.user || 'your GitHub account'}. Create a new repository:`));

  const nameLabel = document.createElement('label');
  nameLabel.append(document.createTextNode('Repository name'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.spellcheck = false; // repo names aren't words — no squiggles/autocorrect
  nameInput.value = folder;
  nameInput.placeholder = 'repo  (or  owner/repo  for an org)';
  nameLabel.appendChild(nameInput);
  ghBody.appendChild(nameLabel);

  let visibility = 'private';
  const visLabel = document.createElement('label');
  visLabel.append(document.createTextNode('Visibility'));
  const radios = document.createElement('div');
  radios.className = 'gh-radios';
  const mk = (val, title, sub) => {
    const r = document.createElement('button');
    r.type = 'button';
    r.className = 'gh-radio' + (val === visibility ? ' sel' : '');
    r.innerHTML = `<span><strong>${title}</strong><small>${sub}</small></span>`;
    r.onclick = () => {
      visibility = val;
      [...radios.children].forEach((c) => c.classList.remove('sel'));
      r.classList.add('sel');
    };
    return r;
  };
  radios.append(
    mk('private', 'Private', 'Only you can see it'),
    mk('public', 'Public', 'Anyone can see it'),
  );
  visLabel.appendChild(radios);
  ghBody.appendChild(visLabel);

  ghBody.appendChild(wizardActions({
    backTo: renderWizardChoice,
    right: [['Create & Push', () => doCreateRepo(nameInput.value, visibility), true]],
  }));
  setTimeout(() => nameInput.focus(), 0);
}

async function doCreateRepo(name, visibility) {
  if (ghBusy) return;
  const n = (name || '').trim();
  if (!n) { ghSetMsg('Enter a repository name.', 'err'); return; }
  ghBusy = true;
  ghSetMsg('Creating repository on GitHub…');
  try {
    const res = await window.api.git.ghCreateRepo(activeDir(), { name: n, visibility, push: true });
    if (!res || res.code !== 0) {
      ghSetMsg((res && (res.stderr || res.stdout) || 'Failed to create repository.').trim(), 'err');
      return;
    }
    const url = (res.stdout || '').trim().split(/\s+/).find((s) => /^https?:\/\//.test(s));
    renderDone('Repository created and pushed to GitHub.' + (url ? '\n' + url : ''));
  } catch (e) {
    ghSetMsg(String((e && e.message) || e), 'err');
  } finally {
    ghBusy = false;
  }
}

// -- Step 2b: link an existing repo -----------------------------------------
function renderLinkStep() {
  ghBody.innerHTML = '';
  ghBody.appendChild(el('p', 'gh-intro', 'Paste the URL of an existing GitHub repository.'));

  const label = document.createElement('label');
  label.append(document.createTextNode('Repository URL'));
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false; // URLs aren't words — no squiggles/autocorrect
  input.placeholder = 'https://github.com/owner/repo.git';
  label.appendChild(input);
  ghBody.appendChild(label);
  ghBody.appendChild(el('p', 'gh-note', "This sets the repo as “origin” and pushes the current branch. For an empty repo, HTTPS pushes use your Git credential helper."));

  ghBody.appendChild(wizardActions({
    backTo: renderWizardChoice,
    right: [['Connect & Push', () => doLink(input.value), true]],
  }));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLink(input.value); });
  setTimeout(() => input.focus(), 0);
}

async function doLink(url) {
  if (ghBusy) return;
  const u = (url || '').trim();
  if (!u) { ghSetMsg('Enter a repository URL.', 'err'); return; }
  ghBusy = true;
  ghSetMsg('Connecting…');
  try {
    const res = await window.api.git.setRemote(activeDir(), u);
    if (!res || res.code !== 0) {
      ghSetMsg((res && (res.stderr || res.stdout) || 'Failed to set remote.').trim(), 'err');
      return;
    }
    const st = lastStatus;
    if (st && st.branch) {
      ghSetMsg('Pushing…');
      const p = await window.api.git.push(activeDir(), st.branch, true);
      if (!p || p.code !== 0) {
        ghSetMsg('Connected, but the push failed:\n' + ((p && (p.stderr || p.stdout)) || '').trim(), 'err');
        refreshGit({ keepMsg: true });
        return;
      }
    }
    renderDone('Connected to GitHub and pushed.\n' + u);
  } catch (e) {
    ghSetMsg(String((e && e.message) || e), 'err');
  } finally {
    ghBusy = false;
  }
}

// -- Final step -------------------------------------------------------------
function renderDone(summary) {
  ghSetMsg('');
  ghBody.innerHTML = '';
  ghBody.appendChild(el('p', 'gh-intro', '✓ All set.'));
  if (summary) ghBody.appendChild(el('div', 'gh-code', summary));
  const actions = document.createElement('div');
  actions.className = 'gh-actions';
  const done = document.createElement('button');
  done.textContent = 'Done';
  done.className = 'primary';
  done.onclick = () => { closeWizard(); refreshGit(); };
  const right = document.createElement('div');
  right.className = 'gh-right';
  right.appendChild(done);
  actions.appendChild(right);
  ghBody.appendChild(actions);
}

// Footer row: a Back button on the left, action buttons on the right.
// right entries are [label, onclick, isPrimary?].
function wizardActions({ backTo, right = [] }) {
  const bar = document.createElement('div');
  bar.className = 'gh-actions';
  if (backTo) { const b = document.createElement('button'); b.textContent = '← Back'; b.onclick = backTo; bar.appendChild(b); }
  const r = document.createElement('div');
  r.className = 'gh-right';
  for (const [label, onclick, primary] of right) {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (primary) btn.className = 'primary';
    btn.onclick = onclick;
    r.appendChild(btn);
  }
  bar.appendChild(r);
  return bar;
}

// -- Small DOM helpers ------------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function mkBtn(text, onclick) { const b = document.createElement('button'); b.textContent = text; b.onclick = onclick; return b; }
function mkMini(text, title, onclick) { const b = document.createElement('button'); b.textContent = text; b.title = title; b.onclick = onclick; return b; }

// ---------------------------------------------------------------------------
// Voice typing
//
// Dictate straight into the focused thread. Speech is transcribed locally and
// offline by Moonshine running in a worker (see voice-worker.js) — the
// browser's Web Speech API is unusable in Electron (it relies on a Google
// speech key that ships only in Chrome). We capture the mic, detect utterance
// boundaries with the Silero VAD model (speech probability per frame, scored
// in the same worker; an adaptive energy gate remains as the fallback), and
// hand each spoken segment to the worker for transcription. Whatever text
// comes back is run through a user-editable dictionary
// (to fix words it keeps mishearing) and then written to the target pane's PTY
// — so it lands at the terminal cursor exactly like typing. The ~ key toggles
// listening from anywhere in the app.
// ---------------------------------------------------------------------------

// -- Persisted settings + dictionary ----------------------------------------
const VOICE_DEFAULT_DICT = [
  { from: 'cloud code', to: 'Claude Code' },
  { from: 'claude code', to: 'Claude Code' },
  { from: 'get hub', to: 'GitHub' },
  { from: 'git hub', to: 'GitHub' },
  { from: 'hive mind', to: 'Hivemind' },
];

function loadVoiceDict() {
  try {
    const raw = localStorage.getItem('hm.voiceDict');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((e) => e && typeof e.from === 'string' && e.from);
    }
  } catch (_) { /* fall through to defaults */ }
  return VOICE_DEFAULT_DICT.slice();
}

let voiceDict = loadVoiceDict();
let voiceHotkeyEnabled = localStorage.getItem('hm.voiceHotkey') !== '0';   // default on
let voiceAutoEnter = localStorage.getItem('hm.voiceAutoEnter') === '1';    // default off
let voiceAutoSpace = localStorage.getItem('hm.voiceAutoSpace') !== '0';    // default on
let voiceReplyEnabled = localStorage.getItem('hm.voiceReply') === '1';     // spoken replies in Chat with Hivemind — default off

// Speech-to-text model registry. The first is bundled; the rest download into
// userData on first use via window.api.stt.ensureModel — keep the repo ids in
// sync with STT_DOWNLOADS in main.js. Two kinds of entry:
//  - transformers.js models, served offline over hm://models and run in the
//    voice worker (`dtype` goes straight to the pipeline);
//  - `native: true` models, decoded by sherpa-onnx in a main-process utility
//    process (STT_NATIVE in main.js) — far more accurate, needs the one-time
//    big download. The voice worker still runs, VAD-only, for Silero.
// Every entry must be English-only, so the worker's audio-only transcribe
// path (no language/task) stays valid.
const STT_MODELS = [
  { value: 'onnx-community/moonshine-base-ONNX', label: 'Moonshine Base — fast, bundled (default)',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
  { value: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    label: 'Parakeet TDT 0.6B — best accuracy (~630 MB one-time download)', native: true },
  { value: 'onnx-community/whisper-base.en', label: 'Whisper Base (English) — downloads on first use',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
];
const isValidSttModel = (m) => STT_MODELS.some((x) => x.value === m);
let sttModelId = localStorage.getItem('hm.voiceModel') || STT_MODELS[0].value;
if (!isValidSttModel(sttModelId)) sttModelId = STT_MODELS[0].value;

function saveVoiceDict() {
  try { localStorage.setItem('hm.voiceDict', JSON.stringify(voiceDict)); } catch (_) { /* quota */ }
}

// Phrases that, said on their own, submit the line instead of being typed.
const VOICE_ENTER_RE = /^\s*(new ?line|press enter|hit enter|submit|send it)\s*[.!?]?\s*$/i;

// -- Engine state ------------------------------------------------------------
let voiceActive = false;        // the user wants to be listening
let voiceTargetPane = null;     // pane that receives this dictation session
let voiceTargetHmChat = false;  // dictation goes to the Chat with Hivemind dialog instead of a pane

// Speech (Moonshine) worker + its load lifecycle. The worker is created lazily on first
// use and kept alive after that, so the model only loads once per app run.
let sttWorker = null;
let sttReady = false;           // the active engine (worker or native) finished loading
let sttNative = false;          // segments go to the main-process sherpa engine, not the worker
let sttLoadPromise = null;      // in-flight load(), resolves on 'ready'
let sttSegId = 0;               // ids correlate transcribe requests/results
let sttInFlight = 0;            // segments currently being transcribed
let sttPending = [];            // segments spoken while the model was still loading

// Mic capture graph (built on start, torn down on stop).
let micStream = null;
let audioCtx = null;
let micSource = null;
let micProcessor = null;
let micSink = null;

// VAD + segmentation. We accumulate audio while you're speaking and flush a
// segment to the worker once you pause (or the segment gets long). 16 kHz mono
// is what the model wants, so we run the AudioContext at that rate directly.
// The speech/silence call for each frame comes from the Silero VAD model
// running in the voice worker — a real speech detector, so soft word onsets
// aren't clipped and keyboard clatter isn't mistaken for talking. Verdicts are
// asynchronous: each frame is queued (vadAwait) until its probability comes
// back, then run through the segmenter; sample counts, not wall clock, drive
// all timing, so late verdicts (e.g. while the worker is busy transcribing)
// only delay a flush, never mis-cut it. Frames the worker can't score (model
// still loading, Silero unavailable) fall back to the old adaptive energy
// gate, decided synchronously.
const STT_SAMPLE_RATE = 16000;
const VAD_FRAME_SAMPLES = 1024;    // 64 ms per VAD tick — fine-grained boundaries
const VAD_RMS_FLOOR = 0.006;       // fallback gate: absolute minimum level that can count as speech
const VAD_NOISE_FACTOR = 2.5;      // fallback gate: speech must exceed the noise estimate by this
const VAD_SPEECH_PROB = 0.4;       // Silero probability that starts an utterance
const VAD_EXIT_PROB = 0.15;        // lower keep-talking bar so soft trailing words aren't cut
const VAD_SILENCE_MS = 550;        // trailing quiet that ends an utterance
const VAD_MIN_SPEECH_MS = 250;     // ignore blips shorter than this
const VAD_MAX_SEGMENT_MS = 15000;  // force a flush so long talk still lands
const VAD_PREROLL_MS = 320;        // quiet audio kept before onset so the first word isn't clipped
const VAD_AWAIT_MAX = 500;         // outstanding verdicts (~32 s) before declaring the worker wedged
let vadFrames = [];                // Float32Array frames of the current segment
let vadSpeechMs = 0;
let vadSilenceMs = 0;
let vadInSpeech = false;
let vadPreroll = [];               // recent quiet frames (≤ VAD_PREROLL_MS total)
let vadNoiseRms = 0.005;           // fallback gate's background-level estimate (adapts during quiet)
let vadGen = 0;                    // capture-session counter; verdicts from an old gen are stale
let vadAwait = [];                 // frames sent for scoring, FIFO-paired with worker verdicts
let vadDegraded = false;           // worker stopped answering — energy gate for the rest of the session

const voiceToggleBtn = $('voice-toggle');
const VOICE_BTN_TITLE = voiceToggleBtn ? voiceToggleBtn.title : '';
const voiceHud = $('voice-hud');
const voiceHudText = $('voice-hud-text');
const voiceHudTarget = $('voice-hud-target');

// -- Dictionary application --------------------------------------------------
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function applyVoiceDict(text) {
  let out = text;
  for (const { from, to } of voiceDict) {
    if (!from) continue;
    // Whole word/phrase, case-insensitive. \b anchors at the alnum edges, so
    // "cloud code" matches as a unit without clobbering longer words.
    const re = new RegExp('\\b' + escapeRegex(from) + '\\b', 'gi');
    out = out.replace(re, to == null ? '' : to);
  }
  // Collapse any double spaces a removal-entry might have left behind.
  return out.replace(/ {2,}/g, ' ').trim();
}

// -- Correction learning -----------------------------------------------------
// When dictation lands in a composer and the user fixes it up before sending,
// the fix is better dictionary material than anything they'd think to add by
// hand. Each dictated utterance is remembered per input element; on send the
// dictated words are diffed against what was actually sent, and a substitution
// seen VOICE_LEARN_MIN_SEEN times triggers a one-click "add to dictionary?"
// offer above the command toast. Candidate counts persist in localStorage so
// the repeat occurrence can be days later. Terminal-bound dictation is typed
// straight into the TUI with no edit window, so only the chat composer and the
// Chat with Hivemind input feed this.
const VOICE_LEARN_KEY = 'hm.voiceLearn';
const VOICE_LEARN_MIN_SEEN = 2;    // offer once the same fix is seen this often
const VOICE_LEARN_MAX_PAIRS = 100; // stored candidates (oldest pruned beyond this)
const VOICE_LEARN_MAX_UTTER = 8;   // dictated utterances remembered per composer
const VOICE_LEARN_MAX_RUN = 3;     // longest phrase (words) either side of a fix

const voiceLearnBuffers = new WeakMap(); // input element → dictated strings awaiting send

function loadVoiceLearn() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_LEARN_KEY) || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch (_) { /* corrupt/absent — start fresh */ }
  return {};
}
let voiceLearn = loadVoiceLearn();

function saveVoiceLearn() {
  // Insertion order ≈ age; drop the oldest candidates once over the cap.
  const keys = Object.keys(voiceLearn);
  for (let i = 0; i < keys.length - VOICE_LEARN_MAX_PAIRS; i++) delete voiceLearn[keys[i]];
  try { localStorage.setItem(VOICE_LEARN_KEY, JSON.stringify(voiceLearn)); } catch (_) { /* quota */ }
}

function vlPairKey(from, to) { return from.toLowerCase() + '\u0000' + to.toLowerCase(); }

function voiceLearnRecord(inputEl, text) {
  if (!inputEl || !text) return;
  let buf = voiceLearnBuffers.get(inputEl);
  if (!buf) voiceLearnBuffers.set(inputEl, (buf = []));
  buf.push(text);
  if (buf.length > VOICE_LEARN_MAX_UTTER) buf.shift();
}

// Tokens compare case-insensitively with edge punctuation stripped, so adding
// a comma or capitalizing a word doesn't read as a correction.
function vlTokens(text) {
  return String(text).split(/\s+/).filter(Boolean).map((w) => ({
    raw: w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ''),
    norm: w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''),
  }));
}

// Word-level diff (LCS): matched-token anchors plus runs where tokens on one
// side were *replaced* by tokens on the other. Pure insertions and deletions
// are ignored — only swaps are dictionary material. The anchor count doubles
// as a similarity measure (used by dictionary training).
function vlAlign(A, B) {
  const n = A.length, m = B.length;
  if (!n || !m || n > 200 || m > 200) return { anchors: [], subs: [] };
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i].norm && A[i].norm === B[j].norm
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk the LCS path collecting matched pairs; a virtual end anchor closes a
  // trailing gap so a fix at the end of the message still counts.
  const anchors = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i].norm && A[i].norm === B[j].norm) { anchors.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const subs = [];
  let pi = 0, pj = 0;
  for (const [ai, aj] of anchors.concat([[n, m]])) {
    if (ai > pi && aj > pj) subs.push({ from: A.slice(pi, ai), to: B.slice(pj, aj) });
    pi = ai + 1; pj = aj + 1;
  }
  return { anchors, subs };
}

function vlSubstitutions(A, B) { return vlAlign(A, B).subs; }

// Called on send with the input the dictation went into and the text that was
// actually sent. Diffs, counts, and maybe raises the suggestion popup.
function voiceLearnHarvest(inputEl, sentText) {
  const buf = inputEl && voiceLearnBuffers.get(inputEl);
  if (buf) voiceLearnBuffers.delete(inputEl);
  if (!buf || !buf.length) return;
  voiceLearnFromTexts(buf.join(' ').trim(), String(sentText || '').trim(), 1);
}

// Diff a heard/corrected text pair, count each substitution `weight` times, and
// maybe raise the "add to dictionary?" offer. Pre-send fixes count 1 apiece
// (an offer needs VOICE_LEARN_MIN_SEEN sightings); an explicit edit-and-reapply
// of an already-sent command passes the full threshold so it offers right away.
function voiceLearnFromTexts(heard, corrected, weight) {
  if (!heard || !corrected || heard === corrected) return;
  const subs = vlSubstitutions(vlTokens(heard), vlTokens(corrected));
  let offer = null;
  let changed = false;
  for (const s of subs) {
    if (s.from.length > VOICE_LEARN_MAX_RUN || s.to.length > VOICE_LEARN_MAX_RUN) continue;
    const from = s.from.map((t) => t.norm).join(' ').trim();
    const to = s.to.map((t) => t.raw).join(' ').trim();
    // Too short/empty to be a phrase, no letters, or a case-only change —
    // not worth a dictionary entry.
    if (from.length < 3 || !to || !/[a-z]/.test(from)) continue;
    if (from === to.toLowerCase()) continue;
    const key = vlPairKey(from, to);
    const entry = voiceLearn[key] || (voiceLearn[key] = { from, to, n: 0 });
    entry.n += weight;
    changed = true;
    if (!offer && !entry.dismissed && entry.n >= VOICE_LEARN_MIN_SEEN
        && !voiceDict.some((e) => e.from.toLowerCase() === from)) {
      offer = entry;
    }
  }
  if (changed) saveVoiceLearn();
  if (offer) voiceSuggestShow(offer);
}

// -- Suggestion popup --------------------------------------------------------
let voiceSuggestTimer = null;
let voiceSuggestPair = null;

function voiceSuggestShow(pair) {
  const box = $('voice-suggest');
  const label = $('voice-suggest-text');
  if (!box || !label) return;
  voiceSuggestPair = pair;
  label.textContent = `You keep fixing “${pair.from}” to “${pair.to}” — add it to the voice dictionary?`;
  box.classList.remove('hidden');
  clearTimeout(voiceSuggestTimer);
  // Auto-hide without dismissing: the pair stays pending and offers again on
  // the next occurrence.
  voiceSuggestTimer = setTimeout(voiceSuggestHide, 15000);
}

function voiceSuggestHide() {
  clearTimeout(voiceSuggestTimer);
  voiceSuggestTimer = null;
  voiceSuggestPair = null;
  const box = $('voice-suggest');
  if (box) box.classList.add('hidden');
}

(function wireVoiceSuggest() {
  const add = $('voice-suggest-add');
  const no = $('voice-suggest-no');
  if (add) add.onclick = () => {
    const p = voiceSuggestPair;
    if (!p) return;
    upsertVoiceDict(p.from, p.to);
    delete voiceLearn[vlPairKey(p.from, p.to)];
    saveVoiceLearn();
    voiceSuggestHide();
    hmToast(`Added “${p.from} → ${p.to}” to the voice dictionary (⚙ Settings → Voice).`);
  };
  if (no) no.onclick = () => {
    const p = voiceSuggestPair;
    if (!p) return;
    const entry = voiceLearn[vlPairKey(p.from, p.to)];
    if (entry) { entry.dismissed = true; saveVoiceLearn(); }
    voiceSuggestHide();
  };
})();

// The pane dictation flows into: the one focused when voice started, falling
// back to whatever is focused now if that one has gone away.
function currentVoicePane() {
  if (voiceTargetPane && !voiceTargetPane.disposed && voiceTargetPane.state !== 'dead') return voiceTargetPane;
  if (focusedPane && !focusedPane.disposed && focusedPane.state !== 'dead') {
    voiceTargetPane = focusedPane;
    return focusedPane;
  }
  return null;
}

function commitVoiceText(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return;

  // Training-bound dictation: while the training modal is open, raw
  // transcripts feed the trainer. It must see the *pre-dictionary* text —
  // what the model actually heard — so this runs before applyVoiceDict and
  // every other routing rule. Live check, like the hmChat branch below.
  if (voiceTrainIsOpen()) { voiceTrainCommit(trimmed); return; }

  // Dialog-bound dictation: while the Chat with Hivemind dialog is the voice
  // target, phrases land in its input instead of a thread. The check stays
  // live (not snapshotted) so speech still buffered when voice toggles off is
  // routed correctly as long as the dialog remains open.
  if (voiceTargetHmChat && hmChatIsOpen()) { hmChatVoiceCommit(trimmed); return; }

  const pane = currentVoicePane();
  if (!pane) { flagVoiceError('No live thread to type into — click a thread and try again.'); return; }
  // In chat view the terminal is covered — dictation must land in the visible
  // composer textarea, not the hidden TUI behind it.
  const chatInput = (pane.view === 'chat' && pane.chat) ? pane.chat.input : null;

  // A bare command phrase submits the line rather than typing the words.
  if (voiceAutoEnter && VOICE_ENTER_RE.test(trimmed)) {
    if (chatInput) sendChatMessage(pane);
    else sendToPane(pane, '\r');
    return;
  }

  let text = applyVoiceDict(trimmed);
  if (!text) return;

  // A dictated utterance addressed to Hivemind ("Hivemind, open a new thread…")
  // runs as an app command instead of being typed into the thread. Anything
  // starting with the wake word is consumed (unrecognized phrasing toasts an
  // error); mentioning Hivemind mid-sentence types as normal. Fuzzy matching
  // covers misheard wake words ("half mine, open a thread").
  const hmCmd = matchHivemindCommand(text, true);
  if (hmCmd !== null) { runHivemindCommand(hmCmd, pane); return; }

  // A dictated utterance starting with "todo" becomes a Todo-panel item
  // instead of being typed into the thread.
  const todoText = hmCmd === null ? matchTodoPrefix(text) : null;
  if (todoText !== null) { captureTodo(todoText); return; }

  if (voiceAutoSpace) text += ' ';

  if (chatInput) {
    const start = chatInput.selectionStart != null ? chatInput.selectionStart : chatInput.value.length;
    const end = chatInput.selectionEnd != null ? chatInput.selectionEnd : start;
    chatInput.value = chatInput.value.slice(0, start) + text + chatInput.value.slice(end);
    chatInput.selectionStart = chatInput.selectionEnd = start + text.length;
    // Fire the composer's input handler (autosize + autocomplete refresh).
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    // Remember what was dictated so edits made before sending can be learned
    // as dictionary corrections (harvested in sendChatMessage).
    voiceLearnRecord(chatInput, text.trim());
  } else {
    sendToPane(pane, text);
  }
  updateVoiceHudTarget();
}

// -- Speech worker -----------------------------------------------------------
// The model lives in a worker so transcription never blocks the UI (or the
// terminals). We boot it from a tiny blob module: a file:// page can't spawn a
// cross-origin hm:// worker directly, but it can spawn a same-origin blob
// worker, and that blob can `import` the real worker over hm:// (CORS-allowed
// by the protocol handler in main.js).
// Drop the cached worker so the next ensureSttWorker() boots fresh — used when
// the user switches speech models (the worker holds one loaded model for its
// lifetime, so a new model means a new worker).
function resetSttWorker() {
  if (sttWorker) { try { sttWorker.terminate(); } catch (_) { /* already gone */ } }
  sttWorker = null;
  sttReady = false;
  sttLoadPromise = null;
  sttInFlight = 0;
  sttPending = [];
  vadGen++;          // verdicts from the dying worker must not pair with new frames
  vadAwait = [];
  if (sttNative) { sttNative = false; try { window.api.stt.nativeStop(); } catch (_) { /* main handles */ } }
}

function ensureSttWorker() {
  if (sttLoadPromise) return sttLoadPromise;

  const entry = STT_MODELS.find((m) => m.value === sttModelId) || STT_MODELS[0];

  // Two async steps: make sure the model's files are on disk (a non-default one
  // downloads on first use), then boot the engine and wait for it to load them.
  // Native models load in the main process; the worker still boots (VAD-only)
  // so Silero keeps scoring frames — its failure is non-fatal (energy gate).
  sttLoadPromise = (async () => {
    if (entry.native) {
      const vadBoot = bootSttWorker(entry, { vadOnly: true });
      vadBoot.catch(() => {});
      const ensured = await window.api.stt.ensureModel(entry.value);
      if (!ensured || !ensured.ok) {
        throw new Error((ensured && ensured.error) || 'could not fetch the speech model');
      }
      const loaded = await window.api.stt.nativeLoad(entry.value);
      if (!loaded || !loaded.ok) {
        throw new Error((loaded && loaded.error) || 'native speech engine failed to load');
      }
      sttNative = true;
      sttReady = true;
      clearVoiceError();
      await vadBoot.catch(() => {});
      return;
    }
    const ensured = await window.api.stt.ensureModel(entry.value);
    if (!ensured || !ensured.ok) {
      throw new Error((ensured && ensured.error) || 'could not fetch the speech model');
    }
    await bootSttWorker(entry);
  })();
  // A failed load clears the cache so the next attempt can retry from scratch.
  sttLoadPromise.catch(() => { sttLoadPromise = null; });
  return sttLoadPromise;
}

// Spawn the module worker and resolve once it posts 'ready' for `entry`.
// With opts.vadOnly the worker loads just Silero (transcription is native);
// its 'ready' then must NOT flip sttReady — the native engine decides that.
function bootSttWorker(entry, opts = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      const bootstrap = "import 'hm://app/voice-worker.js';";
      const url = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
      worker = new Worker(url, { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }

    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'ready') {
        if (!opts.vadOnly) {
          sttReady = true;
          clearVoiceError();
        }
        resolve();
      } else if (msg.type === 'progress') {
        // Surface the one-time model download/warm-up so the HUD isn't silent.
        if (!sttReady && msg.data && msg.data.status === 'progress' && msg.data.file) {
          const pct = Math.round(msg.data.progress || 0);
          setVoiceHudText('Loading speech model… ' + pct + '%');
        }
      } else if (msg.type === 'error') {
        sttLoadPromise = null;
        reject(new Error(msg.message || 'speech model failed to load'));
      } else if (msg.type === 'vad') {
        onVadVerdict(msg);
      } else if (msg.type === 'vadstatus') {
        console.log('[voice] silero vad ' + (msg.ok ? 'ready'
          : 'unavailable — using energy gate (' + (msg.message || 'unknown error') + ')'));
      } else if (msg.type === 'result') {
        onSttResult(msg.text || '', msg.error);
      }
    };
    worker.onerror = (e) => {
      if (!sttReady) { sttLoadPromise = null; reject(new Error(e.message || 'voice worker crashed')); }
    };

    sttWorker = worker;
    worker.postMessage(opts.vadOnly
      ? { type: 'load', vadOnly: true }
      : { type: 'load', model: entry.value, dtype: entry.dtype });
  });
}

// One finished transcription, from either engine (worker 'result' message or
// the native IPC promise). Books the in-flight count, surfaces errors, types
// the text, and fires anything that was deferred until transcription drained.
function onSttResult(text, error) {
  sttInFlight = Math.max(0, sttInFlight - 1);
  console.log('[voice] result text=' + JSON.stringify(text || '') +
    ' pane=' + (currentVoicePane() ? (currentVoicePane().name || currentVoicePane().id) : 'NONE') +
    (error ? ' error=' + JSON.stringify(error) : ''));
  // A per-utterance inference failure comes back as an empty result with
  // an error string. Surface it instead of silently typing nothing — an
  // engine that fails every segment would otherwise look "stuck listening".
  if (error) flagVoiceError(voiceErrMessage(new Error(error)));
  if (text) commitVoiceText(text);
  // An empty transcription with no error means the model heard the
  // segment but made nothing of it. Say so briefly — silence here is
  // indistinguishable from the feature being broken.
  else if (!error && voiceActive) flashVoiceNotice('Didn’t catch that — try again');
  // A mic stop with this segment still transcribing deferred the chat
  // send to here — fire it once the last in-flight result is committed.
  if (hmChatSendOnStop && sttInFlight === 0) hmChatVoiceSend();
  if (voiceTrainCheckOnStop && sttInFlight === 0) { voiceTrainCheckOnStop = false; voiceTrainCheck(); }
  renderVoiceListening();
}

// -- Mic capture + VAD -------------------------------------------------------
function resetVad() {
  vadFrames = [];
  vadSpeechMs = 0;
  vadSilenceMs = 0;
  vadInSpeech = false;
  vadPreroll = [];
  // vadNoiseRms deliberately survives resets — the room doesn't change between
  // utterances, and re-learning it from scratch would mis-gate the next one.
}

function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

// Hand the current utterance to the worker and start a fresh segment.
function flushSegment() {
  const frames = vadFrames;
  const speechMs = vadSpeechMs;
  resetVad();
  if (speechMs < VAD_MIN_SPEECH_MS || !frames.length) return;

  let total = 0;
  for (const f of frames) total += f.length;
  const audio = new Float32Array(total);
  let off = 0;
  for (const f of frames) { audio.set(f, off); off += f.length; }

  if (!sttReady) {
    // The model is still loading: hold the segment and send it once ready, so
    // words spoken right after toggling voice on aren't lost. Cap the backlog
    // at ~60s of audio (oldest dropped first) in case the load never finishes.
    sttPending.push(audio);
    let held = 0;
    for (const a of sttPending) held += a.length;
    while (sttPending.length > 1 && held > STT_SAMPLE_RATE * 60) {
      held -= sttPending[0].length;
      sttPending.shift();
    }
    return;
  }
  postSegment(audio);
}

function postSegment(audio) {
  sttInFlight++;
  renderVoiceListening();
  if (sttNative) {
    // Native engine: the segment goes over IPC to the sherpa utility process.
    // Same result funnel as the worker path, so stop/send bookkeeping holds.
    window.api.stt.nativeTranscribe(audio).then(
      (r) => onSttResult((r && r.text) || '', (r && (r.ok === false ? (r.error || 'speech engine failed') : r.error)) || undefined),
      (err) => onSttResult('', (err && err.message) || String(err))
    );
    return;
  }
  // Transfer the backing buffer so we don't copy the audio across threads.
  sttWorker.postMessage({ type: 'transcribe', id: ++sttSegId, audio }, [audio.buffer]);
}

// One VAD tick: `frame` is VAD_FRAME_SAMPLES of 16 kHz mono Float32 we own.
// Ship it to the worker for a Silero speech probability; the segmenter runs
// when the verdict returns. No worker (still booting) or a wedged one → decide
// synchronously with the energy gate instead, so dictation never goes dark.
function onAudioFrame(frame) {
  if (!voiceActive) return;
  if (sttWorker && !vadDegraded) {
    vadAwait.push(frame);
    // Structured clone, deliberately no transfer: the frame must survive here
    // to be accumulated once its verdict comes back.
    sttWorker.postMessage({ type: 'vad', gen: vadGen, audio: frame });
    if (vadAwait.length > VAD_AWAIT_MAX) {
      // The worker stopped answering (crashed after load?). Don't lose the
      // audio: push everything queued through the energy gate and stay there
      // for the rest of this session.
      console.warn('[voice] silero verdicts stopped arriving — energy-gate fallback');
      vadDegraded = true;
      vadGen++;                                  // straggler verdicts become stale
      const backlog = vadAwait;
      vadAwait = [];
      for (const f of backlog) applyVadDecision(f, null);
    }
    return;
  }
  applyVadDecision(frame, null);
}

// A Silero verdict from the worker: pair it with its queued frame (FIFO — the
// worker answers every 'vad' message, in order) and run the segmenter.
function onVadVerdict(msg) {
  if (msg.gen !== vadGen) return;                // stale: old session/worker
  const frame = vadAwait.shift();
  if (!frame || !voiceActive) return;
  applyVadDecision(frame, msg.prob);
}

// The segmenter: one frame plus its speech verdict. `prob` is Silero's speech
// probability, or null when unscored — then the adaptive energy gate decides.
function applyVadDecision(frame, prob) {
  const frameMs = (frame.length / STT_SAMPLE_RATE) * 1000;
  const level = rms(frame);
  let speaking;
  if (prob != null) {
    // Hysteresis: a confident onset opens the utterance, a much lower bar
    // keeps it open so quiet word tails aren't chopped mid-sentence.
    speaking = vadInSpeech ? prob >= VAD_EXIT_PROB : prob >= VAD_SPEECH_PROB;
  } else {
    speaking = level >= Math.max(VAD_RMS_FLOOR, vadNoiseRms * VAD_NOISE_FACTOR);
  }

  if (speaking) {
    if (!vadInSpeech) {
      vadInSpeech = true;
      for (const f of vadPreroll) vadFrames.push(f);  // recover the word's onset
      vadPreroll = [];
    }
    vadFrames.push(frame);
    vadSpeechMs += frameMs;
    vadSilenceMs = 0;
  } else if (vadInSpeech) {
    vadFrames.push(frame);                          // keep trailing quiet for context
    vadSilenceMs += frameMs;
  } else {
    // Not speaking: adapt the noise estimate (quiet frames only, so speech
    // never inflates it) and keep a short rolling pre-roll for the next onset.
    vadNoiseRms = vadNoiseRms * 0.95 + level * 0.05;
    vadPreroll.push(frame);
    const maxFrames = Math.ceil(VAD_PREROLL_MS / frameMs);
    while (vadPreroll.length > maxFrames) vadPreroll.shift();
  }

  const segMs = vadSpeechMs + vadSilenceMs;
  if (vadInSpeech && (vadSilenceMs >= VAD_SILENCE_MS || segMs >= VAD_MAX_SEGMENT_MS)) {
    flushSegment();
  }
}

async function startCapture() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  audioCtx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
  if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (_) {} }
  micSource = audioCtx.createMediaStreamSource(micStream);

  // Prefer an AudioWorklet: it captures on the realtime audio thread, so heavy
  // main-thread work (xterm rendering across many panes) can't stall or drop
  // mic audio the way the deprecated ScriptProcessor can — dropped frames turn
  // directly into missing words. The tiny processor accumulates the 128-sample
  // render quanta into VAD_FRAME_SAMPLES chunks and transfers them here.
  try {
    const src = `registerProcessor('hm-mic-capture', class extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(${VAD_FRAME_SAMPLES}); this.n = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch) return true;
        let i = 0;
        while (i < ch.length) {
          const take = Math.min(ch.length - i, this.buf.length - this.n);
          this.buf.set(ch.subarray(i, i + take), this.n);
          this.n += take; i += take;
          if (this.n === this.buf.length) {
            this.port.postMessage(this.buf, [this.buf.buffer]);
            this.buf = new Float32Array(${VAD_FRAME_SAMPLES}); this.n = 0;
          }
        }
        return true;
      }
    });`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    await audioCtx.audioWorklet.addModule(url);
    micProcessor = new AudioWorkletNode(audioCtx, 'hm-mic-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    micProcessor.port.onmessage = (ev) => onAudioFrame(ev.data);
    micSource.connect(micProcessor);
  } catch (_) {
    // Fallback: ScriptProcessor (deprecated but universal). Its buffer is
    // reused by the browser, so copy each callback's samples before queuing.
    micProcessor = audioCtx.createScriptProcessor(VAD_FRAME_SAMPLES, 1, 1);
    micProcessor.onaudioprocess = (ev) => onAudioFrame(new Float32Array(ev.inputBuffer.getChannelData(0)));
    micSource.connect(micProcessor);
  }

  // A muted sink keeps the graph pulling audio without playing the mic back.
  micSink = audioCtx.createGain();
  micSink.gain.value = 0;
  micProcessor.connect(micSink);
  micSink.connect(audioCtx.destination);
  resetVad();
  // Fresh scoring session: stale verdicts drop, and a worker that wedged last
  // session gets another chance.
  vadGen++;
  vadAwait = [];
  vadDegraded = false;
}

function stopCapture() {
  if (micProcessor) {
    try {
      micProcessor.disconnect();
      if (micProcessor.port) micProcessor.port.onmessage = null;   // AudioWorkletNode
      micProcessor.onaudioprocess = null;                          // ScriptProcessor fallback
    } catch (_) {}
  }
  if (micSource) { try { micSource.disconnect(); } catch (_) {} }
  if (micSink) { try { micSink.disconnect(); } catch (_) {} }
  if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
  if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
  micProcessor = micSource = micSink = micStream = audioCtx = null;
  resetVad();
  vadGen++;          // any verdicts still in flight are for a dead session
  vadAwait = [];
}

// -- Public controls ---------------------------------------------------------
async function startVoice() {
  if (voiceActive) return;
  // The training modal takes dictation over everything; otherwise an open
  // Chat with Hivemind dialog takes it in preference to a thread — the ~
  // hotkey lands here while either is open.
  const training = voiceTrainIsOpen();
  voiceTargetHmChat = !training && hmChatIsOpen();
  const pane = focusedPane && !focusedPane.disposed && focusedPane.state !== 'dead' ? focusedPane : null;
  if (!pane && !voiceTargetHmChat && !training) { flagVoiceError('Open or click a thread first, then start voice typing.'); return; }
  voiceTargetPane = pane;
  voiceActive = true;
  sttInFlight = 0;
  sttPending = [];
  hmChatSendOnStop = false;   // a fresh session voids any armed auto-send
  clearVoiceError();
  renderVoiceState();
  setVoiceHudText(sttReady ? 'Listening…' : 'Loading speech model… (you can start speaking)');
  try {
    // Open the mic and load the model concurrently: the VAD holds segments
    // spoken during the load (see flushSegment), so early words aren't lost.
    const loading = ensureSttWorker();
    loading.catch(() => {});                        // handled below; avoid unhandled rejection if capture throws first
    await startCapture();
    if (!voiceActive) { stopCapture(); return; }    // toggled off while the mic was opening
    await loading;
    if (!voiceActive) return;                       // toggled off while loading
    const backlog = sttPending;
    sttPending = [];
    for (const audio of backlog) postSegment(audio);
    renderVoiceListening();
  } catch (err) {
    flagVoiceError(voiceErrMessage(err));
    // A mic/model failure shouldn't fire off whatever sits in the chat input.
    stopVoice({ send: false });
  }
}

function stopVoice({ send = true } = {}) {
  const wasActive = voiceActive;
  // Speech still buffered when the user toggles off is speech they said —
  // transcribe and type it rather than throw it away. Frames still awaiting a
  // Silero verdict are part of that speech too: drain them through the energy
  // gate synchronously so the tail of the last sentence isn't dropped.
  const vadBacklog = vadAwait;
  vadAwait = [];
  vadGen++;
  for (const f of vadBacklog) { if (voiceActive) applyVadDecision(f, null); }
  if (vadInSpeech && sttReady && vadSpeechMs >= VAD_MIN_SPEECH_MS) flushSegment();
  sttPending = [];
  voiceActive = false;
  stopCapture();
  setVoiceHudText('');
  renderVoiceState();
  // Chat dictation: stopping the mic sends the command. If a transcription is
  // still in flight, arm the send and let the worker's result handler fire it.
  if (send && wasActive && voiceTargetHmChat && hmChatIsOpen()) {
    if (sttInFlight > 0) hmChatSendOnStop = true;
    else hmChatVoiceSend();
  }
  // Training: stopping the mic checks the sentence, deferred the same way so
  // the tail of what was read isn't cut off.
  if (send && wasActive && voiceTrainIsOpen()) {
    if (sttInFlight > 0) voiceTrainCheckOnStop = true;
    else voiceTrainCheck();
  }
}

function toggleVoice() { if (voiceActive) stopVoice(); else startVoice(); }

// Turn a worker/capture failure into a sentence that points at the fix.
function voiceErrMessage(err) {
  // Include both name and message: DOMException mic errors carry the useful
  // part in .name (NotAllowedError, …), while model/worker failures carry it in
  // .message. Using only .name would mask real messages as a bare "Error".
  const m = String((err && [err.name, err.message].filter(Boolean).join(': ')) || err || '');
  if (/NotAllowedError|Permission/i.test(m)) {
    return 'Microphone access was blocked. Allow the mic for Hivemind, then toggle voice again.';
  }
  if (/NotFoundError|NotReadable|audio/i.test(m)) {
    return 'No usable microphone was found.';
  }
  // The native (sherpa) engine failed to start or died — model files download
  // in-app, so "run fetch-model" advice would be wrong here.
  if (/speech engine|sherpa/i.test(m)) {
    return 'Native speech engine problem (' + m + '). Toggle voice again to retry, or pick a different model in Settings → Voice.';
  }
  // An ONNX-runtime backend failure (e.g. WebGPU adapter missing) — the model
  // files are present; the engine just couldn't start. Don't send the user to
  // re-download the model.
  if (/backend|adapter|webgpu|wasm|gpu/i.test(m)) {
    return 'Speech engine failed to start (' + m + '). Try restarting Hivemind; if it persists this is a backend issue, not a missing model.';
  }
  // Most often: the model files aren't bundled yet.
  return 'Speech model could not load. Run "npm run fetch-model" to download it, then restart Hivemind. (' + m + ')';
}

// -- HUD / button state ------------------------------------------------------
function renderVoiceState() {
  if (voiceToggleBtn) voiceToggleBtn.classList.toggle('listening', voiceActive);
  voiceTrainSyncMic();
  if (!voiceHud) return;
  voiceHud.classList.toggle('hidden', !voiceActive);
  if (voiceActive) updateVoiceHudTarget();
}
function updateVoiceHudTarget() {
  if (!voiceHudTarget) return;
  if (voiceTrainIsOpen()) { voiceHudTarget.textContent = '→ training'; return; }
  if (voiceTargetHmChat) { voiceHudTarget.textContent = '→ Hivemind chat'; return; }
  const pane = currentVoicePane();
  voiceHudTarget.textContent = pane ? '→ ' + (pane.name || 'thread') : '→ (no thread)';
}
function setVoiceHudText(t) { if (voiceHudText) voiceHudText.textContent = t || ''; }

// The model transcribes a whole utterance at once, so there's no live word-by-word
// interim text; instead the HUD shows whether we're listening or working.
function renderVoiceListening() {
  if (!voiceActive) return;
  if (voiceNoticeTimer) return;   // a transient notice is showing; don't stomp it
  setVoiceHudText(sttInFlight > 0 ? 'Transcribing…' : 'Listening…');
  updateVoiceHudTarget();
}

// Show a short-lived message in the HUD, then fall back to Listening…/Transcribing…
let voiceNoticeTimer = null;
function flashVoiceNotice(text) {
  if (voiceNoticeTimer) clearTimeout(voiceNoticeTimer);
  setVoiceHudText(text);
  voiceNoticeTimer = setTimeout(() => {
    voiceNoticeTimer = null;
    renderVoiceListening();
  }, 1600);
}

function flagVoiceError(msg) {
  if (voiceToggleBtn) { voiceToggleBtn.classList.add('error'); voiceToggleBtn.title = msg; }
  setVoiceModalMsg(msg, 'err');
  if (voiceTrainIsOpen()) voiceTrainSetMsg(msg, 'err');
  console.warn('[voice]', msg);
}
function clearVoiceError() {
  if (voiceToggleBtn) { voiceToggleBtn.classList.remove('error'); voiceToggleBtn.title = VOICE_BTN_TITLE; }
}

// -- Hotkey: the ~ (backquote) key toggles listening ------------------------
// A single capture-phase listener covers the whole app, terminals included, so
// it fires before xterm consumes the key. We let the backquote through only
// when the user is typing into one of our own text fields (so a literal ` can
// still be entered there); inside a thread — the terminal's xterm textarea or
// the chat view's composer — it toggles voice instead.
document.addEventListener('keydown', (e) => {
  if (!voiceHotkeyEnabled) return;
  if (e.code !== 'Backquote' || e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target;
  const isThreadInput = t && t.classList && (
    t.classList.contains('xterm-helper-textarea') || t.classList.contains('chat-input') ||
    t.classList.contains('hm-chat-input')   // dialog input: ~ toggles dictation there too
  );
  const editable = t && !isThreadInput && (
    t.isContentEditable ||
    t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
  );
  if (editable) return; // let UI fields receive a literal backtick
  e.preventDefault();
  e.stopImmediatePropagation();
  toggleVoice();
}, true);

// -- Settings + dictionary modal --------------------------------------------
const settingsBackdrop = $('settings-backdrop');
const voiceModalMsg = $('voice-modal-msg');
const vHotkey = $('voice-hotkey-enabled');
const vAutoEnter = $('voice-auto-enter');
const vAutoSpace = $('voice-auto-space');
const vReply = $('voice-reply-enabled');
const vModel = $('voice-model');
const vFrom = $('voice-dict-from');
const vTo = $('voice-dict-to');
const vDictList = $('voice-dict-list');
const vDictEmpty = $('voice-dict-empty');

function setVoiceModalMsg(text, kind) {
  if (!voiceModalMsg) return;
  if (!text) { voiceModalMsg.classList.add('hidden'); voiceModalMsg.textContent = ''; return; }
  voiceModalMsg.textContent = text;
  voiceModalMsg.className = 'voice-msg' + (kind ? ' ' + kind : '');
}

function renderVoiceDict() {
  if (!vDictList) return;
  vDictList.innerHTML = '';
  if (!voiceDict.length) { vDictEmpty.classList.remove('hidden'); return; }
  vDictEmpty.classList.add('hidden');
  voiceDict.forEach((entry, i) => {
    const li = document.createElement('li');
    const from = el('span', 'vd-from', entry.from);
    const arrow = el('span', 'vd-arrow', '→');
    const to = el('span', 'vd-to', entry.to ? entry.to : '(remove)');
    const del = document.createElement('button');
    del.className = 'vd-del';
    del.textContent = '🗑';
    del.title = 'Remove this correction';
    del.onclick = () => { voiceDict.splice(i, 1); saveVoiceDict(); renderVoiceDict(); };
    li.append(from, arrow, to, del);
    vDictList.appendChild(li);
  });
}

// Add or replace a correction — shared by the Settings form and the learned-
// correction suggestion popup.
function upsertVoiceDict(from, to) {
  const idx = voiceDict.findIndex((e) => e.from.toLowerCase() === from.toLowerCase());
  if (idx >= 0) voiceDict[idx] = { from, to };
  else voiceDict.push({ from, to });
  saveVoiceDict();
  renderVoiceDict();
}

function addVoiceDictEntry() {
  const from = vFrom.value.trim();
  const to = vTo.value.trim();
  if (!from) { setVoiceModalMsg('Type the word or phrase voice keeps mishearing.', 'err'); vFrom.focus(); return; }
  upsertVoiceDict(from, to);
  vFrom.value = '';
  vTo.value = '';
  vFrom.focus();
  setVoiceModalMsg('Saved.', 'ok');
}

// -- Settings modal (tabbed: General + Voice) -------------------------------
// Switch the visible tab + panel.
function setSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.settings-panel').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.panel !== tab);
  });
}

// Populate the voice tab's fields from the persisted settings.
function syncVoiceFields() {
  vHotkey.checked = voiceHotkeyEnabled;
  vAutoEnter.checked = voiceAutoEnter;
  vAutoSpace.checked = voiceAutoSpace;
  if (vReply) {
    vReply.checked = voiceReplyEnabled;
    if (!window.speechSynthesis) {
      vReply.disabled = true;
      vReply.parentElement.title = 'Speech synthesis is not available in this build.';
    }
  }
  if (vModel) {
    if (!vModel.options.length) {
      for (const m of STT_MODELS) {
        const opt = document.createElement('option');
        opt.value = m.value; opt.textContent = m.label;
        vModel.appendChild(opt);
      }
    }
    vModel.value = sttModelId;
  }
  renderVoiceDict();
  setVoiceModalMsg('');
}

// Populate the general tab's fields from the current defaults.
function syncGeneralFields() {
  const st = $('set-theme');
  if (st && !st.options.length) {
    for (const [id, t] of Object.entries(THEMES)) {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = t.label;
      st.appendChild(opt);
    }
  }
  if (st) st.value = currentTheme;
  const sm = $('set-default-model');
  if (sm && !sm.options.length) {
    for (const m of MODELS) {
      const opt = document.createElement('option');
      opt.value = m.value; opt.textContent = m.label;
      sm.appendChild(opt);
    }
  }
  if (sm) sm.value = defaultModel;
  const scm = $('set-default-codex-model');
  if (scm && !scm.options.length) {
    for (const m of CODEX_MODELS) {
      const opt = document.createElement('option');
      opt.value = m.value; opt.textContent = m.label;
      scm.appendChild(opt);
    }
  }
  if (scm) scm.value = defaultCodexModel;
  const sf = $('set-default-font');
  if (sf) sf.value = String(defaultFontSize);
  const sn = $('set-notify');
  if (sn) sn.checked = !notifyMuted;
  const sp = $('set-plan-autopopup');
  if (sp) sp.checked = localStorage.getItem('hm.planAutoOpen') !== '0';
  const sa = $('set-autocorrect');
  if (sa) sa.checked = autocorrectEnabled;
  const sv = $('set-app-version');
  if (sv) sv.textContent = window.api.appVersion ? `v${window.api.appVersion}` : 'unknown';
}

function openSettings(tab) {
  syncGeneralFields();
  syncVoiceFields();
  // Reveal the "Build portable copy" group only when the active hive is the
  // Hivemind source checkout (the group is not per-board, so check on open).
  updateBuildButton(activeBoard());
  setSettingsTab(tab || 'general');
  settingsBackdrop.classList.remove('hidden');
}
function closeSettings() { settingsBackdrop.classList.add('hidden'); }

// -- Wire it all up ----------------------------------------------------------
if (voiceToggleBtn) voiceToggleBtn.onclick = toggleVoice;
const settingsBtn = $('settings-btn');
if (settingsBtn) settingsBtn.onclick = () => openSettings('general');
$('settings-close').onclick = closeSettings;

// -- Voice dictionary training -----------------------------------------------
// "Train dictionary" (Settings → Voice): practice sentences built from this
// hive's own prompt history are read aloud; the raw transcript — what the
// model heard *before* the dictionary ran — is diffed against the target and
// mismatched runs become proposed corrections the user accepts or skips one by
// one. Misheard terms are re-drilled: woven into extra sentences later in the
// session, and seeded to the front of the next "Train again". Routing lives in
// commitVoiceText; the deferred check mirrors hmChatSendOnStop so the tail of
// a reading isn't cut off.

const vtBackdrop = $('voice-train-backdrop');
const vtSentenceEl = $('voice-train-sentence');
const vtHeardEl = $('voice-train-heard');
const vtCandsEl = $('voice-train-cands');
const vtProgressEl = $('voice-train-progress');
const vtMsgEl = $('voice-train-msg');
const vtDoneEl = $('voice-train-done');
const vtMicBtn = $('voice-train-mic');

let voiceTrainState = null;        // { sentences, idx, added, heardSegs, phase: 'listen'|'review'|'done' }
let voiceTrainCheckOnStop = false; // mic stopped mid-transcription — check when the result lands

// Everyday words that don't mark a prompt as project vocabulary. Anything the
// speech model handles fine already — the point is to surface the unusual.
const VT_COMMON_WORDS = new Set(('the a an and or but of in on at to for with from into onto over under about after before ' +
  'again more most some any all each every no not only just also very too so than then when where while which what who whom ' +
  'whose why how this that these those there here it its it\'s is are was were be been being am do does did done doing have ' +
  'has had having will would shall should can could may might must let lets get gets got getting go goes going gone come ' +
  'comes came make makes made making take takes took taken use uses used using see sees saw seen look looks looked looking ' +
  'want wants wanted need needs needed like likes liked work works worked working try tries tried trying keep keeps kept ' +
  'put puts say says said tell tells told know knows knew think thinks thought find finds found give gives gave show shows ' +
  'showed add adds added remove removes removed delete deletes deleted change changes changed fix fixes fixed update updates ' +
  'updated create creates created open opens opened close closes closed move moves moved run runs ran running start starts ' +
  'started stop stops stopped check checks checked test tests tested build builds built write writes wrote read reads new ' +
  'old good bad big small long short high low first last next same other another back down up out off please thanks yes ' +
  'now never always often sometimes right left top bottom side both few many much little own able sure still yet ever ' +
  'instead rather really actually maybe perhaps around between through during without within across behind above below ' +
  'if else because since until unless once twice one two three four five six seven eight nine ten they them their we us ' +
  'our you your i me my he him his she her mine yours something anything nothing everything someone anyone everyone ' +
  'thing things way ways time times day days part parts number list item items text line lines word words name names ' +
  'file files code page user users button click clicks type types set sets end top bit lot kind sort case point').split(/\s+/));

const VT_STOPWORDS = new Set(['the', 'a', 'an', 'to', 'and', 'or', 'of', 'in', 'on', 'at', 'it', 'is', 'are', 'was', 'be',
  'i', 'you', 'we', 'that', 'this', 'for', 'with', 'as', 'by', 'do', 'my', 'me', 'so', 'no', 'not']);

function voiceTrainIsOpen() {
  return !!(vtBackdrop && !vtBackdrop.classList.contains('hidden'));
}

function voiceTrainSetMsg(text, kind) {
  if (!vtMsgEl) return;
  vtMsgEl.textContent = text || '';
  vtMsgEl.className = 'voice-msg' + (kind ? ' ' + kind : '');
  vtMsgEl.classList.toggle('hidden', !text);
}

// Mirror the mic state on the modal's big toggle (called from renderVoiceState).
function voiceTrainSyncMic() {
  if (!vtMicBtn || !voiceTrainIsOpen()) return;
  vtMicBtn.classList.toggle('listening', voiceActive);
  vtMicBtn.textContent = voiceActive ? '🎤 Listening — click (or ~) to stop & check' : '🎤 Start reading';
  voiceTrainRenderHeard();
}

// Distinctive-term mining: project vocabulary the speech model likely trips
// on — identifiers, filenames, product names, uncommon words. Ranked by how
// often (then how recently) they appear across the history.
function vtExtractTerms(entries, seedTerms) {
  const stats = new Map(); // lowercased term -> { forms: Map, count, last }
  const bump = (surface, weight, last) => {
    const lower = surface.toLowerCase();
    let s = stats.get(lower);
    if (!s) stats.set(lower, (s = { forms: new Map(), count: 0, last: -1 }));
    s.count += weight;
    s.last = Math.max(s.last, last);
    s.forms.set(surface, (s.forms.get(surface) || 0) + weight);
  };
  entries.forEach((en, idx) => {
    for (let w of String(en && en.text || '').split(/\s+/)) {
      w = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      if (w.length < 2 || w.length > 24) continue;
      if (/:\/\//.test(w) || /[/\\]/.test(w) || /^\d+$/.test(w)) continue;
      const lower = w.toLowerCase();
      const distinctive =
        /[a-z][A-Z]/.test(w) ||                        // camelCase / mixed case
        /[A-Za-z0-9][_-][A-Za-z0-9]/.test(w) ||        // snake_case / kebab-case
        /^[\w-]+\.[A-Za-z0-9]{1,5}$/.test(w) ||        // dotted filename (renderer.js)
        /^[A-Z]{2,5}$/.test(w) ||                      // acronym (STT, VAD)
        (/^[A-Z][a-z]+$/.test(w) && !VT_COMMON_WORDS.has(lower)) ||   // product name
        (/^[a-z]+$/.test(w) && w.length >= 4 && /[aeiouy]/.test(w) && !VT_COMMON_WORDS.has(lower));
      if (distinctive) bump(w, 1, idx);
    }
  });
  // Dictionary targets are proven trouble words — always worth practicing.
  for (const e of voiceDict) {
    if (e.to && e.to.trim()) bump(e.to.trim(), 3, entries.length);
  }
  // Terms misheard last session outrank everything — re-drill them first.
  for (const t of seedTerms || []) {
    if (t && t.trim()) bump(t.trim(), 5, entries.length);
  }
  if (!stats.size) for (const t of ['Hivemind', 'Claude Code', 'GitHub']) bump(t, 1, 0);
  return [...stats.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .map((s) => [...s.forms.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}

// Template sentences packed with the ranked terms, consuming the list without
// reuse until it runs dry. A mix of short commands and longer prompt-shaped
// requests — the kind actually dictated to a thread — so a session exercises
// both clipped and conversational speech.
const VT_TEMPLATES = [
  (a, b) => `Open ${a} and check ${b}.`,
  (a, b) => `Update ${a} in ${b}.`,
  (a, b) => `Add a test for ${a} in ${b}.`,
  (a, b) => `Fix the bug in ${a} near ${b}.`,
  (a, b, c) => `Rename ${a} to ${b} and run ${c}.`,
  (a, b) => `Search ${a} for ${b}.`,
  (a, b) => `Show me ${a} before changing ${b}.`,
  (a) => `Do a deep dive into the ${a} code and determine where the issue could be.`,
  (a) => `Have ${a} redo the user interface and look for ways to improve it.`,
  (a) => `Take a pass over ${a} and tell me what you would simplify.`,
  (a, b) => `I want more tests added to ${a} to help cover ${b}.`,
  (a, b) => `Take a closer look at ${a} and figure out why ${b} keeps breaking.`,
  (a, b) => `Walk me through how ${a} works and explain where ${b} fits in.`,
  (a, b) => `Refactor ${a} so it is easier to test, then double check ${b}.`,
  (a, b) => `Before changing anything, summarize what ${a} and ${b} are responsible for.`,
];

function vtGenerateSentences(terms, n) {
  // Shuffle so repeat sessions draw different templates — the pool is larger
  // than one session consumes.
  const templates = VT_TEMPLATES.slice();
  for (let i = templates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [templates[i], templates[j]] = [templates[j], templates[i]];
  }
  const out = [];
  let i = 0;
  const next = () => terms.length ? terms[i++ % terms.length] : null;
  for (let t = 0; out.length < n && terms.length; t++) {
    const tpl = templates[t % templates.length];
    const slots = Array.from({ length: tpl.length }, next);
    if (slots.some((s) => !s)) break;
    out.push(tpl(...slots));
    if (i >= terms.length && out.length >= Math.min(n, Math.ceil(terms.length / 2))) break;
  }
  return out;
}

// Past prompts that read naturally aloud: short, single-line, prose-like.
// Longer prompts contribute their first sentence when that alone qualifies.
function vtPickPrompts(entries, n, terms) {
  const termSet = new Set(terms.map((t) => t.toLowerCase()));
  const readable = (text) => {
    if (!text || /\n/.test(text) || /[`]/.test(text) || /:\/\//.test(text)) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 4 || words.length > 14 || text.length > 90) return false;
    const alpha = words.filter((w) => /^[A-Za-z][A-Za-z'’]*[.,!?]?$/.test(w)).length;
    if (alpha / words.length < 0.7) return false;
    if (words.filter((w) => /[/\\]|[^\x20-\x7E]/.test(w)).length > 1) return false;
    return true;
  };
  const seen = new Set();
  const withTerm = [], plain = [];
  for (const en of entries.slice().reverse()) {   // newest first
    let text = String(en && en.text || '').trim();
    if (!readable(text)) {
      const first = text.split(/(?<=[.!?])\s+/)[0];
      if (first && first !== text && readable(first)) text = first;
      else continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hasTerm = text.split(/\s+/).some((w) => termSet.has(w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toLowerCase()));
    (hasTerm ? withTerm : plain).push(text);
  }
  return withTerm.concat(plain).slice(0, n);
}

// A session: ~10 sentences alternating generated / verbatim, from whatever
// material the hive's history offers (fallback seed terms guarantee at least one).
async function vtBuildSession(seedTerms) {
  const TARGET = 10;
  let entries = [];
  const dir = activeDir();
  if (dir && window.api.promptHistory) {
    try {
      const res = await window.api.promptHistory.read(dir);
      entries = (res && res.ok && Array.isArray(res.entries)) ? res.entries : [];
    } catch (_) { entries = []; }
  }
  const terms = vtExtractTerms(entries, seedTerms);
  const gen = vtGenerateSentences(terms, Math.ceil(TARGET / 2));
  const verb = vtPickPrompts(entries, TARGET, terms);
  const sentences = [];
  for (let i = 0; sentences.length < TARGET && (i < gen.length || i < verb.length); i++) {
    if (i < gen.length) sentences.push(gen[i]);
    if (sentences.length < TARGET && i < verb.length) sentences.push(verb[i]);
  }
  return {
    sentences,
    idx: 0,
    added: 0,
    heardSegs: [],
    phase: 'listen',
    missed: [],     // misheard terms awaiting a re-drill sentence this session
    allMissed: [],  // every miss this session — seeds the next "Train again"
    extra: 0,       // re-drill sentences appended so far (capped)
  };
}

// One extra sentence built from terms the model just misheard, appended to the
// end of the session so the correction (or a freshly added rule) gets verified
// in a different context a few sentences later.
const VT_REDRILL_MAX = 3;

function vtRedrillSentence(terms) {
  const pool = VT_TEMPLATES.filter((t) => t.length <= terms.length);
  const tpl = pool[Math.floor(Math.random() * pool.length)];
  const slots = Array.from({ length: tpl.length }, (_, i) => terms[i % terms.length]);
  return tpl(...slots);
}

function voiceTrainRenderHeard() {
  if (!vtHeardEl || !voiceTrainState) return;
  const heard = voiceTrainState.heardSegs.join(' ');
  vtHeardEl.classList.toggle('vt-heard-empty', !heard);
  vtHeardEl.textContent = heard
    || (voiceActive ? 'Listening — read the sentence aloud…' : 'Mic is off — click Start reading.');
}

function voiceTrainRender() {
  const st = voiceTrainState;
  if (!st || !vtBackdrop) return;
  const done = st.phase === 'done';
  if (vtProgressEl) vtProgressEl.textContent = done ? '' : `Sentence ${st.idx + 1} / ${st.sentences.length}`;
  if (vtSentenceEl) vtSentenceEl.textContent = done ? '' : st.sentences[st.idx];
  $('voice-train-read').classList.toggle('hidden', done);
  vtDoneEl.classList.toggle('hidden', !done);
  if (done) $('voice-train-done-text').textContent = st.added
    ? `Added ${st.added} correction${st.added === 1 ? '' : 's'} to the voice dictionary.`
    : 'No new corrections needed — the dictionary already covers how you speak.';
  $('voice-train-check').classList.toggle('hidden', st.phase !== 'listen');
  $('voice-train-next').classList.toggle('hidden', st.phase !== 'review');
  $('voice-train-retry').classList.toggle('hidden', done);
  $('voice-train-skip').classList.toggle('hidden', done);
  if (st.phase === 'listen' && vtCandsEl) vtCandsEl.innerHTML = '';
  voiceTrainSyncMic();
  voiceTrainRenderHeard();
}

// A VAD segment's transcript landed while the modal is open (see commitVoiceText).
function voiceTrainCommit(trimmed) {
  const st = voiceTrainState;
  if (!st || st.phase !== 'listen') return;   // ignore chatter during review/done
  st.heardSegs.push(trimmed);
  voiceTrainRenderHeard();
}

// Diff what was heard against the target sentence and propose corrections.
function voiceTrainCheck() {
  const st = voiceTrainState;
  if (!st || st.phase !== 'listen' || !voiceTrainIsOpen()) return;
  const target = st.sentences[st.idx];
  const heard = st.heardSegs.join(' ').trim();
  if (!heard) { voiceTrainSetMsg('Didn’t catch anything — read the sentence, then press Check.', 'err'); return; }

  const A = vlTokens(heard), B = vlTokens(target);
  const { anchors, subs } = vlAlign(A, B);
  const sim = (2 * anchors.length) / (A.length + B.length);
  if (sim < 0.45) {
    voiceTrainSetMsg('That didn’t sound like the sentence — press Retry and read it again, or Skip it.', 'err');
    return;
  }

  const normEq = (x, y) => x.map((t) => t.norm).join(' ') === y.map((t) => t.norm).join(' ');
  if (normEq(A, B) || normEq(vlTokens(applyVoiceDict(heard)), B)) {
    st.phase = 'review';
    voiceTrainSetMsg('Perfect — your dictionary already handles this one.', 'ok');
    voiceTrainRender();
    return;
  }

  // Substitution runs → candidate entries, filtered like voiceLearnHarvest.
  const cands = [];
  for (const s of subs) {
    if (s.from.length > VOICE_LEARN_MAX_RUN || s.to.length > VOICE_LEARN_MAX_RUN) continue;
    const from = s.from.map((t) => t.norm).join(' ').trim();
    const to = s.to.map((t) => t.raw).join(' ').trim();
    if (from.length < 3 || !to || !/[a-z]/.test(from)) continue;
    if (VT_STOPWORDS.has(from)) continue;               // a rule on a bare stopword would corrupt dictation
    // Case-only differences only matter when the target has an internal
    // capital (github → GitHub); anything else is sentence-position noise.
    if (from === to.toLowerCase() && !/[A-Z]/.test(to.slice(1))) continue;
    // Already fixed by an existing rule, or an exact duplicate entry.
    if (applyVoiceDict(from).trim().toLowerCase() === to.toLowerCase()) continue;
    if (voiceDict.some((e) => e.from.toLowerCase() === from && (e.to || '').toLowerCase() === to.toLowerCase())) continue;
    if (cands.some((c) => c.from === from)) continue;
    cands.push({ from, to });
  }

  // Every miss is re-drill material, whether or not a rule gets added — the
  // point is verifying the term survives a second reading.
  for (const c of cands) {
    if (!st.missed.includes(c.to)) st.missed.push(c.to);
    if (!st.allMissed.includes(c.to)) st.allMissed.push(c.to);
  }

  st.phase = 'review';
  if (!cands.length) {
    voiceTrainSetMsg('Close enough — nothing worth adding.', 'ok');
    voiceTrainRender();
    return;
  }
  voiceTrainSetMsg(`Heard ${cands.length} difference${cands.length === 1 ? '' : 's'} — add the ones worth fixing.`, '');
  voiceTrainRender();
  for (const c of cands) {
    const li = document.createElement('li');
    const mkSpan = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
    li.appendChild(mkSpan('vd-from', c.from));
    li.appendChild(mkSpan('vd-arrow', '→'));
    li.appendChild(mkSpan('vd-to', c.to));
    const add = document.createElement('button');
    add.className = 'primary';
    add.textContent = 'Add';
    const skip = document.createElement('button');
    skip.textContent = 'Skip';
    const settle = (accepted) => {
      add.remove(); skip.remove();
      li.classList.add(accepted ? 'vt-added' : 'vt-skipped');
      li.appendChild(mkSpan('vt-cand-state', accepted ? '✓ Added' : 'Skipped'));
    };
    add.onclick = () => { upsertVoiceDict(c.from, c.to); voiceTrainState.added++; settle(true); };
    skip.onclick = () => settle(false);
    li.appendChild(add);
    li.appendChild(skip);
    vtCandsEl.appendChild(li);
  }
}

function voiceTrainAdvance() {
  const st = voiceTrainState;
  if (!st) return;
  // Weave pending misses back in: append one re-drill sentence to the end of
  // the queue so the trouble terms come around again in a fresh context.
  if (st.missed.length && st.extra < VT_REDRILL_MAX) {
    st.sentences.push(vtRedrillSentence(st.missed.splice(0, 2)));
    st.extra++;
  }
  st.idx++;
  st.heardSegs = [];
  st.phase = st.idx >= st.sentences.length ? 'done' : 'listen';
  voiceTrainSetMsg('');
  if (st.phase === 'done' && voiceActive) stopVoice({ send: false });
  voiceTrainRender();
}

function voiceTrainRetry() {
  const st = voiceTrainState;
  if (!st || st.phase === 'done') return;
  st.heardSegs = [];
  st.phase = 'listen';
  voiceTrainSetMsg('');
  voiceTrainRender();
}

// A session built from one specific prompt (Prompt History → 🎤): the prompt
// is split into spoken-size sentence chunks and read back verbatim, so a
// prompt the model garbled can be re-drilled directly. Miss re-drills and
// "Train again" then behave exactly like a normal session.
function vtSessionFromText(text) {
  const whole = String(text || '').trim();
  const parts = whole
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    sentences: parts.length ? parts : [whole],
    idx: 0,
    added: 0,
    heardSegs: [],
    phase: 'listen',
    missed: [],
    allMissed: [],
    extra: 0,
  };
}

async function openVoiceTraining(opts) {
  if (voiceTrainIsOpen()) return;
  voiceTrainState = (opts && opts.text) ? vtSessionFromText(opts.text) : await vtBuildSession();
  voiceTrainCheckOnStop = false;
  vtBackdrop.classList.remove('hidden');
  voiceTrainSetMsg('');
  voiceTrainRender();
  // Mic on for the whole session; a failure surfaces in the modal via
  // flagVoiceError. Already-running dictation just reroutes here.
  if (!voiceActive) startVoice();
  updateVoiceHudTarget();
}

function closeVoiceTraining() {
  if (!vtBackdrop) return;
  vtBackdrop.classList.add('hidden');   // hide first so stopVoice doesn't fire a check
  voiceTrainCheckOnStop = false;
  if (voiceActive) stopVoice({ send: false });
  voiceTrainState = null;
}

if (vtBackdrop) {
  $('voice-train-open').onclick = () => openVoiceTraining();
  $('voice-train-close').onclick = closeVoiceTraining;
  $('voice-train-finish').onclick = closeVoiceTraining;
  $('voice-train-again').onclick = async () => {
    // Seed the fresh session with this session's misses so they lead it.
    voiceTrainState = await vtBuildSession(voiceTrainState ? voiceTrainState.allMissed : []);
    voiceTrainSetMsg('');
    voiceTrainRender();
    if (!voiceActive) startVoice();
  };
  vtMicBtn.onclick = toggleVoice;
  $('voice-train-check').onclick = () => { if (voiceActive) stopVoice(); else voiceTrainCheck(); };
  $('voice-train-next').onclick = voiceTrainAdvance;
  $('voice-train-skip').onclick = voiceTrainAdvance;
  $('voice-train-retry').onclick = voiceTrainRetry;
  vtBackdrop.addEventListener('mousedown', (e) => { if (e.target === vtBackdrop) closeVoiceTraining(); });
  // Enter advances the flow (Check while listening, Next in review) unless a
  // button inside the modal is focused — the button's own click wins then.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !voiceTrainIsOpen() || !voiceTrainState) return;
    if (e.target && e.target.tagName === 'BUTTON' && vtBackdrop.contains(e.target)) return;
    e.preventDefault();
    const ph = voiceTrainState.phase;
    if (ph === 'listen') $('voice-train-check').click();
    else if (ph === 'review') voiceTrainAdvance();
    else closeVoiceTraining();
  });
}

// -- Claude usage (toolbar pill + modal) --------------------------------------
// The pill shows the most-constrained plan limit (the one closest to running
// out); the modal breaks down every limit window plus today's per-model token
// totals from the local Claude Code transcripts.
const usageBackdrop = $('usage-backdrop');
const usageBtn = $('usage-btn');
const usageBody = $('usage-body');
let usageData = null;

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// "resets 8:30 PM (in 2h 4m)" from an ISO timestamp.
function fmtReset(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t)) return '';
  const clock = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let mins = Math.max(0, Math.round((t - Date.now()) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  const rel = h >= 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : h ? `in ${h}h ${m}m` : `in ${m}m`;
  return `resets ${clock} (${rel})`;
}

function usageSeverity(pct) {
  if (pct >= 85) return 'crit';
  if (pct >= 60) return 'warn';
  return 'ok';
}

function renderUsagePill() {
  if (!usageBtn) return;
  usageBtn.classList.remove('ok', 'warn', 'crit');
  const d = usageData;
  if (!d || !d.limits || !d.limits.length) {
    usageBtn.textContent = 'Usage';
    usageBtn.title = d && d.limitsError
      ? 'Claude usage — ' + d.limitsError
      : 'Claude usage — how much of your plan\'s limits you\'ve used';
    return;
  }
  // The binding constraint is whichever window is fullest — that's the number
  // that decides how much Claude you have left right now.
  const top = d.limits.reduce((a, b) => (b.percent > a.percent ? b : a), d.limits[0]);
  usageBtn.textContent = `${Math.round(top.percent)}%`;
  usageBtn.classList.add(usageSeverity(top.percent));
  usageBtn.title = d.limits
    .map((l) => `${l.label}: ${Math.round(l.percent)}% used — ${fmtReset(l.resetsAt)}`)
    .join('\n') + '\nClick for details.';
}

function renderUsageModal() {
  if (!usageBody) return;
  usageBody.innerHTML = '';
  const d = usageData;
  if (!d) { usageBody.appendChild(el('p', 'help-note', 'Loading…')); return; }

  // -- Plan limits ----------------------------------------------------------
  const limitsGroup = el('div', 'settings-group');
  const planName = d.subscriptionType ? ` (${d.subscriptionType} plan)` : '';
  limitsGroup.appendChild(el('div', 'settings-group-title', 'Plan limits' + planName));
  if (d.limitsError) {
    limitsGroup.appendChild(el('p', 'help-note', d.limitsError));
  } else if (!d.limits.length) {
    limitsGroup.appendChild(el('p', 'help-note', 'No limit information reported for this account.'));
  } else {
    for (const l of d.limits) {
      const row = el('div', 'usage-limit');
      const head = el('div', 'usage-limit-head');
      head.appendChild(el('span', 'usage-limit-label', l.label));
      head.appendChild(el('span', 'usage-limit-detail',
        `${Math.round(l.percent)}% used · ${100 - Math.round(l.percent)}% left · ${fmtReset(l.resetsAt)}`));
      const bar = el('div', 'usage-bar');
      const fill = el('div', 'usage-bar-fill ' + usageSeverity(l.percent));
      fill.style.width = Math.min(100, Math.max(0, l.percent)) + '%';
      bar.appendChild(fill);
      row.append(head, bar);
      limitsGroup.appendChild(row);
    }
    limitsGroup.appendChild(el('small', '',
      'Same windows as Claude Code\'s /usage — the session window covers rolling 5-hour blocks; weekly windows cap the whole week.'));
  }
  usageBody.appendChild(limitsGroup);

  // -- Today's tokens ---------------------------------------------------------
  const tokGroup = el('div', 'settings-group');
  tokGroup.appendChild(el('div', 'settings-group-title', 'Tokens used today'));
  const models = Object.keys((d.tokens && d.tokens.byModel) || {});
  if (d.tokensError) {
    tokGroup.appendChild(el('p', 'help-note', d.tokensError));
  } else if (!models.length) {
    tokGroup.appendChild(el('p', 'help-note', 'No Claude activity recorded today.'));
  } else {
    const table = document.createElement('table');
    table.className = 'usage-table';
    const mkRow = (cells, header) => {
      const tr = document.createElement('tr');
      for (const c of cells) {
        const td = document.createElement(header ? 'th' : 'td');
        td.textContent = c;
        tr.appendChild(td);
      }
      return tr;
    };
    table.appendChild(mkRow(['Model', 'Msgs', 'Input', 'Output', 'Cache read', 'Cache write'], true));
    const total = { messages: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    for (const model of models.sort()) {
      const m = d.tokens.byModel[model];
      table.appendChild(mkRow([model, String(m.messages), fmtTokens(m.input),
        fmtTokens(m.output), fmtTokens(m.cacheRead), fmtTokens(m.cacheCreate)]));
      for (const k of Object.keys(total)) total[k] += m[k];
    }
    if (models.length > 1) {
      const tr = mkRow(['Total', String(total.messages), fmtTokens(total.input),
        fmtTokens(total.output), fmtTokens(total.cacheRead), fmtTokens(total.cacheCreate)]);
      tr.className = 'usage-total';
      table.appendChild(tr);
    }
    tokGroup.appendChild(table);
    tokGroup.appendChild(el('small', '',
      'Counted from this machine\'s Claude Code transcripts (all projects, since midnight). Cache reads are heavily discounted against your limits.'));
  }
  usageBody.appendChild(tokGroup);
}

async function refreshUsage() {
  try {
    usageData = await window.api.usage.get();
  } catch (err) {
    usageData = {
      limits: [], limitsError: (err && err.message) || String(err),
      tokens: { byModel: {} }, tokensError: null, subscriptionType: null,
    };
  }
  renderUsagePill();
  if (usageBackdrop && !usageBackdrop.classList.contains('hidden')) renderUsageModal();
}

function openUsage() {
  if (!usageBackdrop) return;
  renderUsageModal(); // show whatever we have, then refresh in place
  usageBackdrop.classList.remove('hidden');
  refreshUsage();
}
function closeUsage() { if (usageBackdrop) usageBackdrop.classList.add('hidden'); }

if (usageBtn) usageBtn.onclick = openUsage;
const usageCloseBtn = $('usage-close');
if (usageCloseBtn) usageCloseBtn.onclick = closeUsage;
const usageRefreshBtn = $('usage-refresh');
if (usageRefreshBtn) usageRefreshBtn.onclick = refreshUsage;
if (usageBackdrop) usageBackdrop.addEventListener('mousedown', (e) => { if (e.target === usageBackdrop) closeUsage(); });

refreshUsage();
setInterval(refreshUsage, 60 * 1000);

// -- Help modal -------------------------------------------------------------
const helpBackdrop = $('help-backdrop');
function openHelp() { if (helpBackdrop) helpBackdrop.classList.remove('hidden'); }
function closeHelp() { if (helpBackdrop) helpBackdrop.classList.add('hidden'); }
const helpBtn = $('help-btn');
if (helpBtn) helpBtn.onclick = openHelp;
const helpCloseBtn = $('help-close');
if (helpCloseBtn) helpCloseBtn.onclick = closeHelp;
if (helpBackdrop) helpBackdrop.addEventListener('mousedown', (e) => { if (e.target === helpBackdrop) closeHelp(); });
$('voice-hud-stop').onclick = stopVoice;
settingsBackdrop.addEventListener('mousedown', (e) => { if (e.target === settingsBackdrop) closeSettings(); });
document.querySelectorAll('.settings-tab').forEach((b) => {
  b.onclick = () => setSettingsTab(b.dataset.tab);
});

// General-tab controls.
const setThemeSel = $('set-theme');
if (setThemeSel) setThemeSel.addEventListener('change', () => {
  if (isValidTheme(setThemeSel.value)) applyTheme(setThemeSel.value);
});
const setModelSel = $('set-default-model');
if (setModelSel) setModelSel.addEventListener('change', () => {
  if (isValidModel(setModelSel.value)) {
    defaultModel = setModelSel.value;
    localStorage.setItem('hm.model', defaultModel);
  }
});
const setCodexModelSel = $('set-default-codex-model');
if (setCodexModelSel) setCodexModelSel.addEventListener('change', () => {
  if (isValidCodexModel(setCodexModelSel.value)) {
    defaultCodexModel = setCodexModelSel.value;
    localStorage.setItem('hm.codexModel', defaultCodexModel);
  }
});
const setFontInput = $('set-default-font');
if (setFontInput) setFontInput.addEventListener('change', () => {
  defaultFontSize = clampFont(parseInt(setFontInput.value, 10) || FONT_DEFAULT);
  setFontInput.value = String(defaultFontSize);
  localStorage.setItem('hm.fontSize', String(defaultFontSize));
});
const setNotify = $('set-notify');
if (setNotify) setNotify.addEventListener('change', () => {
  notifyMuted = !setNotify.checked;
  localStorage.setItem('hm.muteNotifications', notifyMuted ? '1' : '0');
});
const setPlanAuto = $('set-plan-autopopup');
if (setPlanAuto) setPlanAuto.addEventListener('change', () => {
  localStorage.setItem('hm.planAutoOpen', setPlanAuto.checked ? '1' : '0');
});
const setAutocorrect = $('set-autocorrect');
if (setAutocorrect) setAutocorrect.addEventListener('change', () => {
  autocorrectEnabled = setAutocorrect.checked;
  localStorage.setItem('hm.autocorrect', autocorrectEnabled ? '1' : '0');
});

$('voice-dict-add').onclick = addVoiceDictEntry;
vFrom.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); vTo.focus(); } });
vTo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addVoiceDictEntry(); } });
vHotkey.addEventListener('change', () => {
  voiceHotkeyEnabled = vHotkey.checked;
  localStorage.setItem('hm.voiceHotkey', voiceHotkeyEnabled ? '1' : '0');
});
vAutoEnter.addEventListener('change', () => {
  voiceAutoEnter = vAutoEnter.checked;
  localStorage.setItem('hm.voiceAutoEnter', voiceAutoEnter ? '1' : '0');
});
vAutoSpace.addEventListener('change', () => {
  voiceAutoSpace = vAutoSpace.checked;
  localStorage.setItem('hm.voiceAutoSpace', voiceAutoSpace ? '1' : '0');
});
if (vReply) vReply.addEventListener('change', () => {
  voiceReplyEnabled = vReply.checked;
  localStorage.setItem('hm.voiceReply', voiceReplyEnabled ? '1' : '0');
  if (!voiceReplyEnabled && window.speechSynthesis) speechSynthesis.cancel();
});
if (vModel) vModel.addEventListener('change', () => {
  if (!isValidSttModel(vModel.value) || vModel.value === sttModelId) return;
  sttModelId = vModel.value;
  localStorage.setItem('hm.voiceModel', sttModelId);
  // The worker holds one model for its life, so switching means a fresh worker.
  // If we're mid-dictation, restart so the new model loads (and downloads, if
  // it's the first time) right away instead of on the next toggle.
  const wasActive = voiceActive;
  if (wasActive) stopVoice();
  resetSttWorker();
  if (wasActive) startVoice();
});
// Model download progress (first use of a non-bundled model) → HUD. Big files
// (the native Parakeet encoder is ~620 MB) report byte progress so the HUD
// isn't stuck on a file count for minutes.
if (window.api.onSttDownloadProgress) window.api.onSttDownloadProgress((p) => {
  if (sttReady || !p || !p.total) return;
  if (p.totalBytes > 20e6) {
    setVoiceHudText('Downloading speech model… ' + Math.round((p.bytes || 0) / 1e6) + ' / '
      + Math.round(p.totalBytes / 1e6) + ' MB'
      + (p.total > 1 ? ' (file ' + Math.min(p.done + 1, p.total) + ' of ' + p.total + ')' : ''));
  } else {
    setVoiceHudText('Downloading speech model… ' + p.done + '/' + p.total + ' files');
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
(async function init() {
  boards = (await window.api.listBoards()) || [];
  renderBoardList();
  if (boards.length) selectBoard(boards[0].id);
  else showEmpty();
})();
