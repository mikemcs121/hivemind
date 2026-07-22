'use strict';

const { app, BrowserWindow, Menu, MenuItem, ipcMain, dialog, Notification, clipboard, protocol, net, shell, utilityProcess } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const os = require('os');

// Dev escape hatch: point userData somewhere else so test runs don't share the
// real boards.json (plain APPDATA tricks don't isolate Electron on Windows).
// Must run before anything calls app.getPath('userData').
if (process.env.HM_USER_DATA) app.setPath('userData', process.env.HM_USER_DATA);

// Force-enable SharedArrayBuffer so the speech-to-text ONNX runtime can run
// multi-threaded WASM (~4x faster than single-thread). A file:// window is not
// cross-origin isolated, so without this flag Chromium hides SAB and the voice
// worker silently drops to one thread. Must be set before app "ready".
// (The previous `enable-unsafe-webgpu` switch was removed: Electron 29 exposes
// no navigator.gpu in windows or workers even with it, so the GPU path never
// ran — re-probe if Electron is upgraded.)
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// ---------------------------------------------------------------------------
// hm:// custom protocol — serves the local files the speech-to-text engine
// needs. The renderer runs over file://, and Chromium refuses fetch() of
// file:// URLs, so the Whisper model (binary .onnx), the transformers.js
// library + its ONNX-runtime .wasm, and the voice worker are all served from
// a privileged scheme that behaves like a normal secure HTTP origin. Three
// hosts map to three on-disk roots (all inside the app, dev or packaged):
//   hm://app/...     -> src/                                  (the worker)
//   hm://vendor/...  -> node_modules/@huggingface/transformers/dist/
//   hm://models/...  -> userData/models/ then models/         (see below)
// The scheme must be registered before app "ready"; see registerSchemes...
// below. The handler is installed in whenReady().
//
// Each host maps to an *ordered list* of on-disk roots; the first root that
// actually contains the requested file wins. Only `models` uses more than one:
// speech models the user downloads on demand land in userData/models (writable,
// survives app updates) and shadow the bundled models/ that ships the default.
// ---------------------------------------------------------------------------
const HM_ROOTS = {
  app: () => [path.join(__dirname, 'src')],
  vendor: () => [path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'dist')],
  models: () => [path.join(app.getPath('userData'), 'models'), path.join(__dirname, 'models')],
};

// Speech models fetched on demand (see the 'stt:ensureModel' IPC). The default
// Moonshine model is bundled and is NOT listed here. Each entry lists the exact
// files transformers.js asks for at q8: the config/tokenizer JSON plus the two
// quantized ONNX graphs. Keep this in sync with the STT_MODELS registry in
// renderer.js — a repo the renderer offers but omits here can never download.
const STT_DOWNLOADS = {
  'onnx-community/whisper-base.en': [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
  ],
  'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8': [
    'encoder.int8.onnx',
    'decoder.int8.onnx',
    'joiner.int8.onnx',
    'tokens.txt',
  ],
};

// Native speech models: too heavy for the renderer's WASM worker, so they run
// via sherpa-onnx in a utility process (see stt-native.js). Maps repo id to
// the recognizer's file layout; renderer entries with `native: true` in
// STT_MODELS must have a row here (and one in STT_DOWNLOADS to be fetchable).
const STT_NATIVE = {
  'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8': {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    joiner: 'joiner.int8.onnx',
    tokens: 'tokens.txt',
    modelType: 'nemo_transducer',
  },
};

const HM_MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream', '.data': 'application/octet-stream',
  '.txt': 'text/plain', '.css': 'text/css', '.html': 'text/html',
};

protocol.registerSchemesAsPrivileged([{
  scheme: 'hm',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

function registerHmProtocol() {
  protocol.handle('hm', async (request) => {
    try {
      const url = new URL(request.url);
      const rootsFn = HM_ROOTS[url.host];
      if (!rootsFn) return new Response('Not found', { status: 404 });
      // Decode and normalize once, then try each root in order. Each candidate
      // is traversal-guarded against its own root; the first existing file wins.
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      let abs = null;
      for (const root of rootsFn()) {
        const cand = path.normalize(path.join(root, rel));
        if (cand !== root && !cand.startsWith(root + path.sep)) continue; // traversal
        if (fs.existsSync(cand)) { abs = cand; break; }
      }
      if (!abs) return new Response('Not found', { status: 404 });
      const res = await net.fetch(pathToFileURL(abs).toString());
      const headers = new Headers(res.headers);
      const ext = path.extname(abs).toLowerCase();
      if (HM_MIME[ext]) headers.set('Content-Type', HM_MIME[ext]);
      // Allow the file:// renderer/worker to cross-origin fetch + import these.
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      return new Response('Error: ' + (err && err.message || err), { status: 500 });
    }
  });
}
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const git = require('./git');
const files = require('./files');
const plan = require('./plan');
const todo = require('./todo');
const promptHistory = require('./promptHistory');
const build = require('./build');
const usage = require('./usage');
const transcript = require('./transcript');
const updater = require('./updater');

// ---------------------------------------------------------------------------
// Persistence: boards are stored as JSON in the app's userData directory.
// ---------------------------------------------------------------------------
const boardsFile = () => path.join(app.getPath('userData'), 'boards.json');

function loadBoards() {
  try {
    const raw = fs.readFileSync(boardsFile(), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
  } catch (_) {
    /* no file yet */
  }
  return [];
}

function saveBoards(boards) {
  try {
    fs.writeFileSync(boardsFile(), JSON.stringify(boards, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to save boards:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// PTY management: one node-pty process per terminal pane.
// ---------------------------------------------------------------------------
const ptys = new Map(); // id -> { proc, boardId }

function defaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC && process.env.COMSPEC.toLowerCase().includes('powershell')
      ? process.env.COMSPEC
      : 'powershell.exe';
  }
  return process.env.SHELL || 'bash';
}

function spawnPty({ id, cwd, cols, rows, startupCommand, model, resume, permissionMode, initialPrompt, sessionId }, win) {
  const shell = defaultShell();
  let safeCwd = cwd;
  try {
    if (!safeCwd || !fs.existsSync(safeCwd)) safeCwd = os.homedir();
  } catch (_) {
    safeCwd = os.homedir();
  }

  const proc = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: safeCwd,
    env: Object.assign({}, process.env),
    useConpty: true,
  });

  ptys.set(id, { proc });

  proc.onData((data) => {
    if (!win.isDestroyed()) win.webContents.send('pty:data', { id, data });
  });

  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (!win.isDestroyed()) win.webContents.send('pty:exit', { id, exitCode });
  });

  // Auto-run the startup command (defaults to `claude`) inside the board's dir.
  let cmd = (startupCommand && startupCommand.trim()) || 'claude';
  // When a specific model is chosen, hand it to the agent CLI via `--model` by
  // inserting the flag right after the `claude`/`codex` token (so flags like
  // `claude --resume` still work). Skip for "default" and for other commands.
  // Codex model ids contain dots (e.g. gpt-5.1-codex), hence the [a-z0-9.-].
  if (model && model !== 'default' && /^[a-z0-9.-]+$/i.test(model)) {
    cmd = cmd.replace(/^(claude|codex)(\.exe|\.cmd)?\b/i, (m) => `${m} --model ${model}`);
  }
  // Permission mode: hand the choice to Claude Code as a startup flag. "default"
  // adds nothing; "bypass" uses the dedicated skip flag so the thread never shows
  // the accept-permissions screen. Only meaningful for the `claude` command.
  const permFlag = {
    acceptEdits: '--permission-mode acceptEdits',
    plan: '--permission-mode plan',
    bypass: '--dangerously-skip-permissions',
  }[permissionMode];
  if (permFlag && /^claude(\.exe)?\b/i.test(cmd) &&
      !/--permission-mode\b|--dangerously-skip-permissions\b/.test(cmd)) {
    cmd = cmd.replace(/^claude(\.exe)?\b/i, (m) => `${m} ${permFlag}`);
  }
  // Restoring a saved session: `resume: true` continues the most recent
  // conversation in this directory; a session-id string resumes that specific
  // conversation (Claude keeps writing to that same session id, so the pane's
  // transcript binding stays deterministic). Only meaningful for the `claude`
  // command.
  if (resume && /^claude(\.exe)?\b/i.test(cmd) && !/--continue\b|--resume\b/.test(cmd)) {
    const flag = (typeof resume === 'string' && /^[a-zA-Z0-9-]+$/.test(resume))
      ? `--resume ${resume}`
      : '--continue';
    cmd = cmd.replace(/^claude(\.exe)?\b/i, (m) => `${m} ${flag}`);
  }
  // Fresh session: pin the session id Hivemind generated for this pane, so the
  // transcript file is known up front (`<sessionId>.jsonl`) instead of guessed
  // from timing after the fact. Never combined with a resume flag.
  if (sessionId && !resume && /^claude(\.exe)?\b/i.test(cmd) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) &&
      !/--session-id\b|--continue\b|--resume\b/.test(cmd)) {
    cmd = cmd.replace(/^claude(\.exe)?\b/i, (m) => `${m} --session-id ${sessionId}`);
  }
  // An initial prompt (from a "Hivemind, open a new thread and…" command) rides
  // along as the agent CLI's positional argument. That's the only safe delivery:
  // typing it into the PTY later could hand it to the shell if the CLI is slow.
  if (initialPrompt && /^(claude|codex)(\.exe|\.cmd)?\b/i.test(cmd)) {
    const p = String(initialPrompt).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (p) {
      cmd += process.platform === 'win32'
        ? " '" + p.replace(/'/g, "''") + "'"      // PowerShell literal string
        : " '" + p.replace(/'/g, "'\\''") + "'";  // POSIX shell literal string
    }
  }
  if (cmd) {
    // Small delay so the shell prompt is ready before we type into it.
    setTimeout(() => {
      const live = ptys.get(id);
      if (live) live.proc.write(cmd + '\r');
    }, 600);
  }

  return { id };
}

// ---------------------------------------------------------------------------
// Filesystem watcher: a single recursive watch on the active board's directory.
// Debounced so a burst of writes (e.g. a build) collapses into one refresh.
// ---------------------------------------------------------------------------
let fsWatcher = null;
let fsWatchDebounce = null;
let fsWatchedDir = null;

function clearWatch() {
  if (fsWatcher) {
    try { fsWatcher.close(); } catch (_) { /* ignore */ }
    fsWatcher = null;
  }
  clearTimeout(fsWatchDebounce);
  fsWatchedDir = null;
}

function setWatch(cwd) {
  if (cwd === fsWatchedDir) return; // already watching this directory
  clearWatch();
  if (!cwd) return;
  try {
    fsWatchedDir = cwd;
    fsWatcher = fs.watch(cwd, { recursive: true }, () => {
      clearTimeout(fsWatchDebounce);
      fsWatchDebounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fs:changed', { cwd });
        }
      }, 600);
    });
    fsWatcher.on('error', () => clearWatch());
  } catch (_) {
    fsWatchedDir = null; // recursive watch unsupported here — panels stay manual
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;

// Guards against starting a second portable build while one is in flight.
let buildRunning = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e2e',
    title: 'Hivemind',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload runs sandboxed, so it can't require('os') to read the
      // Windows build number that xterm's windowsPty option needs. Compute it
      // here (full Node) and hand it over via argv, which the sandbox allows.
      additionalArguments: [
        `--hm-os-build=${(/^\d+\.\d+\.(\d+)/.exec(os.release() || '') || [])[1] || 0}`,
        // The app version (from package.json) so the renderer can show it in
        // Settings. Same source the updater uses to compare against releases.
        `--hm-app-version=${app.getVersion()}`,
      ],
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Lock down navigation. The renderer is a local file:// page that should never
  // navigate anywhere else and never open child windows (which would inherit the
  // preload and re-expose window.api). Any http/https/mailto link goes to the OS
  // browser instead; everything else is denied. Backstops the renderer's own
  // escaping so a stray link/injection can't repoint the app or spawn a window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(String(url));
      if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.href);
    } catch (_) { /* malformed URL — just deny */ }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      e.preventDefault();
      try {
        const u = new URL(String(url));
        if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.href);
      } catch (_) { /* malformed URL — stay put */ }
    }
  });

  // Microphone access for the voice-to-text control. The renderer drives speech
  // recognition (Web Speech API), which opens the mic via getUserMedia; without
  // these handlers Chromium denies the request and recognition never starts.
  // This is a local, trusted app, so we grant audio capture outright and leave
  // every other permission to Chromium's default (denied).
  try {
    const ses = mainWindow.webContents.session;
    const isMic = (p) => p === 'media' || p === 'microphone' || p === 'audioCapture';
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      if (isMic(permission)) {
        // For 'media', only approve when audio was actually requested.
        if (permission === 'media' && details && details.mediaTypes &&
            !details.mediaTypes.includes('audio')) {
          return callback(false);
        }
        return callback(true);
      }
      callback(false);
    });
    ses.setPermissionCheckHandler((_wc, permission) => isMic(permission));
  } catch (_) {
    /* older Electron without session permission handlers — best effort */
  }

  // Spell-check stays inert until a dictionary language is loaded. On Windows
  // Electron does NOT infer this from the system locale, so without this call
  // no Hunspell dictionary is downloaded, nothing is flagged, and
  // dictionarySuggestions always comes back empty. Set it explicitly.
  try {
    mainWindow.webContents.session.setSpellCheckerLanguages(['en-US']);
  } catch (_) {
    /* language unavailable on this build — leave spell-check off */
  }

  // Right-click menu for spell-check suggestions on editable fields. The
  // renderer's <input spellcheck="true"> fields get red squiggles once the
  // dictionary above is loaded; this surfaces the suggestions + add-to-dictionary action.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable && !params.misspelledWord) return;
    const menu = new Menu();

    for (const suggestion of params.dictionarySuggestions) {
      menu.append(new MenuItem({
        label: suggestion,
        click: () => mainWindow.webContents.replaceMisspelling(suggestion),
      }));
    }

    if (params.misspelledWord) {
      menu.append(new MenuItem({
        label: 'Add to dictionary',
        click: () => {
          mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord);
          // Keep autocorrect in agreement: a dictionary word must never be "fixed".
          if (spell) spell.add(params.misspelledWord);
          spellCache.clear();
        },
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }));
    menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }));
    menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }));

    menu.popup();
  });

  // Stop flashing the taskbar once the user looks at the window.
  mainWindow.on('focus', () => {
    try { mainWindow.flashFrame(false); } catch (_) { /* ignore */ }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Autocorrect service. Chromium's spell-checker paints the squiggles and feeds
// the right-click suggestions (see the context-menu handler in createWindow)
// but has no API to *ask* it for a suggestion, so autocorrect-as-you-type runs
// its own Hunspell pass: nspell over dictionary-en's .aff/.dic files. The
// renderer sends each word the user finishes typing over a synchronous
// 'spell:correct' (the reply must land before the Enter that committed the
// word is acted on); the reply is the replacement, or null to leave the word
// alone. A word is only "clearly misspelled" when the top suggestion is within
// edit distance 1 (2 for words of 6+ letters) — anything fuzzier stays a
// squiggle for the user to resolve by hand.
// ---------------------------------------------------------------------------
let spell = null;             // nspell instance; null until the dictionary parses
const spellCache = new Map(); // word -> replacement|null (suggest() is pricey)

// Classic typos fixed outright, mostly contractions Hunspell ranks poorly
// ("dont" suggests "cont" before "don't") plus the all-time greats.
const SPELL_TYPOS = {
  teh: 'the', adn: 'and', nad: 'and', waht: 'what', taht: 'that', alot: 'a lot',
  dont: "don't", cant: "can't", wont: "won't", isnt: "isn't", arent: "aren't",
  wasnt: "wasn't", werent: "weren't", doesnt: "doesn't", didnt: "didn't",
  hasnt: "hasn't", havent: "haven't", hadnt: "hadn't", couldnt: "couldn't",
  wouldnt: "wouldn't", shouldnt: "shouldn't", youre: "you're", theyre: "they're",
  thats: "that's", whats: "what's", theres: "there's",
};

// Developer vocabulary Hunspell doesn't know. Without these, autocorrect would
// "fix" real jargon into dictionary words ("linter" → "linger", "json" → "son").
const SPELL_JARGON = [
  'todo', 'todos', 'hivemind', 'claude', 'chatgpt', 'gemini', 'github', 'repo',
  'repos', 'json', 'yaml', 'toml', 'html', 'css', 'svg', 'npm', 'npx', 'nodejs',
  'lint', 'linter', 'linters', 'linting', 'async', 'await', 'config', 'configs',
  'backend', 'frontend', 'fullstack', 'middleware', 'endpoint', 'endpoints',
  'auth', 'oauth', 'api', 'apis', 'cli', 'sdk', 'regex', 'regexes', 'bool',
  'enum', 'enums', 'struct', 'structs', 'param', 'params', 'arg', 'args',
  'stdin', 'stdout', 'stderr', 'localhost', 'url', 'urls', 'uri', 'http',
  'https', 'git', 'gitignore', 'changelog', 'codebase', 'codebases', 'dev',
  'devs', 'devtools', 'docker', 'kubernetes', 'terraform', 'webpack', 'vite',
  'eslint', 'typescript', 'javascript', 'jsx', 'tsx', 'electron', 'chromium',
  'xterm', 'pty', 'markdown', 'readme', 'timestamp', 'timestamps', 'tooltip',
  'tooltips', 'dropdown', 'dropdowns', 'checkbox', 'checkboxes', 'textarea',
  'textareas', 'spellcheck', 'autocorrect', 'whitespace', 'backtick',
  'backticks', 'redis', 'postgres', 'mysql', 'sqlite', 'nginx', 'webhook',
  'webhooks', 'favicon', 'monorepo', 'stacktrace', 'traceback', 'nullable',
];

function loadSpell() {
  try {
    const nspell = require('nspell');
    const base = path.dirname(require.resolve('dictionary-en'));
    spell = nspell(
      fs.readFileSync(path.join(base, 'index.aff')),
      fs.readFileSync(path.join(base, 'index.dic'))
    );
    for (const w of SPELL_JARGON) spell.add(w);
    // The user's own additions (right-click → Add to dictionary) carry over.
    if (mainWindow && !mainWindow.isDestroyed()) {
      Promise.resolve(mainWindow.webContents.session.listWordsInSpellCheckerDictionary())
        .then((words) => (words || []).forEach((w) => { if (spell) spell.add(w); }))
        .catch(() => { /* custom words just won't be exempt */ });
    }
  } catch (err) {
    console.error('Autocorrect dictionary failed to load:', err);
    spell = null;
  }
}

// Optimal-string-alignment distance (Levenshtein + adjacent transposition, so
// "teh"→"the" counts as 1), bailing out early past `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

function sameLetters(a, b) {
  return a.length === b.length &&
    a.split('').sort().join('') === b.split('').sort().join('');
}

// Does `b` equal `a` with one of a doubled letter pair removed ("untill" → "until")?
function dropsDoubledLetter(a, b) {
  for (let i = 0; i < a.length - 1; i++) {
    if (a[i] === a[i + 1] && a.slice(0, i) + a.slice(i + 1) === b) return true;
  }
  return false;
}

// Autocorrect wants precision over recall — a wrong "fix" is far worse than a
// squiggle left alone. Score how confidently `sugg` explains `word` as a typo
// (lower = safer), or null to reject:
//   0  transposed letters              ("wierd" → "weird")
//   1  a letter missing or doubled     ("speling" → "spelling", "untill" → "until")
//   2  one wrong letter                ("definately" → "definitely")
//   3  two letter-shuffles             (rare, letters all present)
// A plain deletion ("json" → "son") is rejected outright: that shape is far
// more often unknown jargon than a typo.
function suggestionRank(word, sugg) {
  const a = word.toLowerCase(), b = sugg.toLowerCase();
  const max = a.length >= 6 ? 2 : 1;
  const d = editDistance(a, b, max);
  if (d < 1 || d > max) return null;
  const anagram = sameLetters(a, b);
  if (d === 1) {
    if (b.length > a.length) return 1;
    if (b.length === a.length) return anagram ? 0 : 2;
    return dropsDoubledLetter(a, b) ? 1 : null;
  }
  return anagram ? 3 : null;
}

function matchCase(word, fixed) {
  return /^[A-Z]/.test(word) ? fixed[0].toUpperCase() + fixed.slice(1) : fixed;
}

function autocorrectWord(word) {
  if (!spell) return null;
  const mapped = SPELL_TYPOS[word.toLowerCase()];
  if (mapped) return matchCase(word, mapped);
  if (spell.correct(word)) return null;
  let best = null;
  for (const s of (spell.suggest(word) || []).slice(0, 5)) {
    const rank = suggestionRank(word, s);
    if (rank !== null && (!best || rank < best.rank)) best = { rank, s };
  }
  return best ? best.s : null;
}

ipcMain.on('spell:correct', (event, word) => {
  let out = null;
  try {
    const w = String(word || '');
    if (spellCache.has(w)) {
      out = spellCache.get(w);
    } else {
      out = autocorrectWord(w);
      if (spellCache.size > 2000) spellCache.clear();
      spellCache.set(w, out);
    }
  } catch (_) {
    out = null;
  }
  event.returnValue = out; // must always be set or the renderer hangs
});

app.whenReady().then(() => {
  // Required on Windows for native notifications to show the app name/icon.
  if (process.platform === 'win32') app.setAppUserModelId('com.mikem.hivemind');

  // Parse the autocorrect dictionary once startup has settled — it costs a few
  // hundred ms of CPU; until it's ready 'spell:correct' just answers null.
  setTimeout(loadSpell, 1500);

  // Serve the speech-to-text assets over hm:// (see top of file).
  registerHmProtocol();

  // -- IPC: notifications ----------------------------------------------------
  // Fired by the renderer when a terminal needs attention or finishes a turn
  // while the window is not focused. Clicking the toast jumps to that pane.
  ipcMain.on('notify', (_e, { title, body, paneId, boardId }) => {
    try {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: title || 'Hivemind',
          body: body || '',
          icon: path.join(__dirname, 'build', 'icon.ico'),
          silent: false,
        });
        n.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('focus-pane', { paneId, boardId });
          }
        });
        n.show();
      }
    } catch (_) {
      /* notifications are best-effort */
    }
    // Flash the taskbar button if the user is looking elsewhere.
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
      try { mainWindow.flashFrame(true); } catch (_) { /* ignore */ }
    }
  });

  // -- IPC: boards ----------------------------------------------------------
  ipcMain.handle('boards:list', () => loadBoards());
  ipcMain.handle('boards:save', (_e, boards) => saveBoards(boards));

  ipcMain.handle('dialog:pickDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose project directory for this hive',
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  // Attach files to a chat message via the composer's 📎 button.
  ipcMain.handle('dialog:pickFiles', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Attach files to this message',
    });
    return res.canceled ? [] : res.filePaths;
  });

  // -- IPC: images ----------------------------------------------------------
  // A screenshot pasted or an image dragged into a terminal arrives as raw
  // bytes. We persist it to a temp file and hand the path back so the renderer
  // can type it into the pane — Claude Code reads image paths from its prompt.
  ipcMain.handle('image:saveTemp', (_e, { bytes, ext }) => {
    try {
      const dir = path.join(os.tmpdir(), 'hivemind-images');
      fs.mkdirSync(dir, { recursive: true });
      const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
      const name = `paste-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${safeExt}`;
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.from(bytes));
      return file;
    } catch (err) {
      console.error('Failed to save pasted image:', err);
      return null;
    }
  });

  // A screenshot captured to the clipboard (Win+Shift+S, Snipping Tool, etc.)
  // lives there as a raw bitmap, not a file — so the renderer's DataTransfer
  // paste path never sees it. Read it straight from the native clipboard here,
  // persist it as a PNG, and hand back the path (or null if no image is held).
  ipcMain.handle('image:fromClipboard', () => {
    try {
      const img = clipboard.readImage();
      if (!img || img.isEmpty()) return null;
      const dir = path.join(os.tmpdir(), 'hivemind-images');
      fs.mkdirSync(dir, { recursive: true });
      const name = `clip-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`;
      const file = path.join(dir, name);
      fs.writeFileSync(file, img.toPNG());
      return file;
    } catch (err) {
      console.error('Failed to read clipboard image:', err);
      return null;
    }
  });

  // Copy an attachment into the project's `.hivemind/attachments/` folder and
  // return the new path. The Codex CLI ("ChatGPT") sandbox can only read files
  // inside its workspace, so temp screenshots and files picked from elsewhere
  // on disk must be staged into the project before their paths are sent to a
  // codex thread. `.hivemind/` is kept out of Git by plan.ensureIgnored.
  ipcMain.handle('attach:stage', (_e, { cwd, srcPath }) => {
    try {
      if (typeof cwd !== 'string' || !cwd || typeof srcPath !== 'string' || !srcPath) return null;
      const dir = path.join(path.resolve(cwd), '.hivemind', 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      plan.ensureIgnored(cwd);
      // Staged copies pile up across sessions; sweep ones older than a week.
      const WEEK = 7 * 24 * 60 * 60 * 1000;
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        try {
          if (Date.now() - fs.statSync(full).mtimeMs > WEEK) fs.unlinkSync(full);
        } catch (_) { /* ignore sweep races */ }
      }
      const base = path.basename(srcPath);
      let dest = path.join(dir, base);
      if (fs.existsSync(dest)) {
        const ext = path.extname(base);
        const stem = base.slice(0, base.length - ext.length);
        dest = path.join(dir, `${stem}-${Date.now()}${ext}`);
      }
      fs.copyFileSync(srcPath, dest);
      return dest;
    } catch (err) {
      console.error('Failed to stage attachment into workspace:', err);
      return null;
    }
  });

  // -- IPC: ptys ------------------------------------------------------------
  ipcMain.handle('pty:spawn', (_e, opts) => spawnPty(opts, mainWindow));

  ipcMain.on('pty:write', (_e, { id, data }) => {
    const live = ptys.get(id);
    if (live) live.proc.write(data);
  });

  ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
    const live = ptys.get(id);
    if (live) {
      try {
        live.proc.resize(Math.max(cols, 1), Math.max(rows, 1));
      } catch (_) {
        /* ignore resize race */
      }
    }
  });

  ipcMain.on('pty:kill', (_e, { id }) => {
    const live = ptys.get(id);
    if (live) {
      try {
        live.proc.kill();
      } catch (_) {
        /* already gone */
      }
      ptys.delete(id);
    }
  });

  // -- IPC: git -------------------------------------------------------------
  // All operations run in the directory passed by the renderer (the active
  // board's project dir). Each returns a plain object the panel can render.
  ipcMain.handle('git:status', (_e, { cwd }) => git.status(cwd));
  ipcMain.handle('git:diff', (_e, { cwd, file, staged, untracked }) => git.diff(cwd, file, staged, untracked));
  ipcMain.handle('git:stage', (_e, { cwd, files }) => git.stage(cwd, files));
  ipcMain.handle('git:stageAll', (_e, { cwd }) => git.stageAll(cwd));
  ipcMain.handle('git:unstage', (_e, { cwd, files }) => git.unstage(cwd, files));
  ipcMain.handle('git:unstageAll', (_e, { cwd }) => git.unstageAll(cwd));
  ipcMain.handle('git:discard', (_e, { cwd, files }) => git.discard(cwd, files));
  ipcMain.handle('git:commit', (_e, { cwd, message }) => git.commit(cwd, message));
  ipcMain.handle('git:branches', (_e, { cwd }) => git.branches(cwd));
  ipcMain.handle('git:log', (_e, { cwd, count }) => git.log(cwd, count));
  ipcMain.handle('git:checkout', (_e, { cwd, name }) => git.checkout(cwd, name));
  ipcMain.handle('git:createBranch', (_e, { cwd, name }) => git.createBranch(cwd, name));
  ipcMain.handle('git:init', (_e, { cwd }) => git.init(cwd));
  ipcMain.handle('git:fetch', (_e, { cwd }) => git.fetch(cwd));
  ipcMain.handle('git:pull', (_e, { cwd }) => git.pull(cwd));
  ipcMain.handle('git:push', (_e, { cwd, branch, setUpstream }) => git.push(cwd, { branch, setUpstream }));
  ipcMain.handle('git:resetToRemote', (_e, { cwd, branch }) => git.resetToRemote(cwd, { branch }));

  // -- IPC: GitHub connection wizard ----------------------------------------
  ipcMain.handle('git:remoteUrl', (_e, { cwd }) => git.getRemoteUrl(cwd));
  ipcMain.handle('git:setRemote', (_e, { cwd, url }) => git.setRemoteOrigin(cwd, url));
  ipcMain.handle('gh:check', () => git.ghCheck());
  ipcMain.handle('gh:createRepo', (_e, { cwd, name, visibility, push }) => git.ghCreateRepo(cwd, { name, visibility, push }));
  ipcMain.handle('git:aiCommit', (_e, { cwd }) => git.aiCommit(cwd));
  // Conversational Hivemind commands: map free-form phrasing onto the command
  // registry with a one-shot `claude -p` (fast model, scratch dir).
  ipcMain.handle('hm:interpret', (_e, { payload }) => git.hmInterpret(payload));

  // -- IPC: filesystem watcher ----------------------------------------------
  // Watch the active board's project directory so the Source Control and File
  // Explorer panels can refresh themselves when threads change files on disk.
  // One watcher at a time (the active board); bursts are debounced in the
  // renderer-facing event.
  ipcMain.on('watch:set', (_e, { cwd }) => setWatch(cwd));

  // -- IPC: file explorer ---------------------------------------------------
  // Operate inside the active board's project directory. `rel` is empty for the
  // root and a "/"-separated path under it for nested entries.
  ipcMain.handle('files:list', (_e, { cwd, rel }) => files.list(cwd, rel));
  ipcMain.handle('files:open', (_e, { cwd, rel }) => files.open(cwd, rel));
  ipcMain.handle('files:reveal', (_e, { cwd, rel }) => files.reveal(cwd, rel));

  // -- IPC: Plan pane ---------------------------------------------------------
  // The thread writes its plan to `.hivemind/plans/<planId>.md`; Hivemind reads
  // it and stores highlight-comments in a sidecar JSON alongside it.
  ipcMain.handle('plan:read', (_e, { cwd, planId }) => plan.readPlan(cwd, planId));
  // Native plan-mode files live outside the project (~/.claude/plans/…); read
  // by absolute path, guarded to that dir plus the project's .hivemind/plans.
  ipcMain.handle('plan:readFile', (_e, { cwd, file }) => plan.readPlanFile(cwd, file));
  ipcMain.handle('plan:write', (_e, { cwd, planId, content }) => plan.writePlan(cwd, planId, content));
  ipcMain.handle('plan:comments:read', (_e, { cwd, planId }) => plan.readComments(cwd, planId));
  ipcMain.handle('plan:comments:write', (_e, { cwd, planId, comments }) => plan.writeComments(cwd, planId, comments));
  ipcMain.handle('plan:clear', (_e, { cwd, planId }) => plan.clearPlan(cwd, planId));
  // Add `.hivemind/` to the project's .gitignore so plan files stay out of Git.
  ipcMain.handle('plan:ensureIgnored', (_e, { cwd }) => plan.ensureIgnored(cwd));

  // -- IPC: Todo panel --------------------------------------------------------
  // A per-hive checklist stored in `.hivemind/todos.json` in the project dir.
  ipcMain.handle('todo:read', (_e, { cwd }) => todo.readTodos(cwd));
  ipcMain.handle('todo:write', (_e, { cwd, todos }) => todo.writeTodos(cwd, todos));
  // Reuse the plan module's helper — both keep the shared `.hivemind/` folder
  // out of Git via the same .gitignore entry.
  ipcMain.handle('todo:ensureIgnored', (_e, { cwd }) => plan.ensureIgnored(cwd));

  // -- IPC: Prompt History panel ----------------------------------------------
  // A per-hive log of sent prompts stored in `.hivemind/prompt-history.json`.
  ipcMain.handle('promptHistory:read', (_e, { cwd }) => promptHistory.readHistory(cwd));
  ipcMain.handle('promptHistory:append', (_e, { cwd, entry }) => promptHistory.appendPrompt(cwd, entry));
  ipcMain.handle('promptHistory:write', (_e, { cwd, entries }) => promptHistory.writeHistory(cwd, entries));
  ipcMain.handle('promptHistory:ensureIgnored', (_e, { cwd }) => plan.ensureIgnored(cwd));

  // -- IPC: open an external link in the OS browser ---------------------------
  // Plan markdown can contain links; the file:// renderer can't navigate to them
  // safely, so route through the OS. Restricted to web / mail schemes.
  ipcMain.handle('open:external', (_e, { url }) => {
    try {
      const u = new URL(String(url));
      if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return { ok: false };
      shell.openExternal(u.href);
      return { ok: true };
    } catch (_) {
      return { ok: false };
    }
  });

  // -- IPC: Claude usage ------------------------------------------------------
  // Snapshot of the account's rate-limit windows (same data as Claude Code's
  // /usage screen) plus today's token totals from the local transcripts.
  ipcMain.handle('usage:get', () => usage.getUsage());

  // -- IPC: transcript tailing (chat wrapper) --------------------------------
  // Each chat-view pane binds to its Claude Code session transcript; parsed
  // JSONL entries stream back over transcript:entries / transcript:status.
  ipcMain.handle('transcript:bind', (_e, opts) =>
    transcript.bind(opts, (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
      }
    }));
  ipcMain.on('transcript:unbind', (_e, { paneId }) => transcript.unbind(paneId));
  ipcMain.on('transcript:noteSent', (_e, { paneId, text }) => transcript.noteSent(paneId, text));
  // Conversation history: list a project's past sessions and read one back to
  // show read-only in the chat overlay; refresh restores the live view.
  ipcMain.handle('transcript:sessions', (_e, opts) => transcript.listSessions(opts));
  ipcMain.handle('transcript:session', (_e, opts) => transcript.readSession(opts));
  ipcMain.on('transcript:refresh', (_e, { paneId }) => transcript.refresh(paneId));

  // -- IPC: speech models (download on first use) ---------------------------
  // The default speech model (Moonshine) ships bundled under models/. Any other
  // model the user picks is fetched from the Hugging Face Hub into userData/models
  // the first time it's selected, then served offline over hm://models forever
  // after (the protocol handler above prefers userData). Renderer calls this and
  // waits for { ok:true } before booting the worker with that model.
  ipcMain.handle('stt:ensureModel', async (evt, { repo }) => {
    const files = STT_DOWNLOADS[repo];
    if (!files) return { ok: true, alreadyPresent: true };   // bundled/default: nothing to fetch
    const dest = path.join(app.getPath('userData'), 'models', repo);
    if (files.every((f) => fs.existsSync(path.join(dest, f)))) {
      return { ok: true, alreadyPresent: true };
    }
    const progress = (payload) => {
      if (evt.sender && !evt.sender.isDestroyed()) evt.sender.send('stt:downloadProgress', payload);
    };
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const out = path.join(dest, f);
        if (fs.existsSync(out)) continue;
        const res = await net.fetch(`https://huggingface.co/${repo}/resolve/main/${f}`);
        if (!res.ok) throw new Error(`${f}: HTTP ${res.status} ${res.statusText}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        // Stream to a .part file: native models run to hundreds of MB, so
        // buffering in memory is off the table, and the rename at the end
        // means a killed download can't leave a truncated file that would
        // pass the existence check above. Byte progress streams to the HUD.
        const totalBytes = Number(res.headers.get('content-length')) || 0;
        const ws = fs.createWriteStream(out + '.part');
        const reader = res.body.getReader();
        let bytes = 0;
        let lastAt = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (!ws.write(Buffer.from(value))) await new Promise((r) => ws.once('drain', r));
          const now = Date.now();
          if (now - lastAt > 250) {
            lastAt = now;
            progress({ repo, done: i, total: files.length, file: f, bytes, totalBytes });
          }
        }
        await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
        fs.renameSync(out + '.part', out);
        progress({ repo, done: i + 1, total: files.length, file: f, bytes, totalBytes });
      }
      return { ok: true, alreadyPresent: false };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // -- IPC: native speech engine (sherpa-onnx in a utility process) ---------
  // Heavy models (Parakeet) decode natively with full multi-core CPU — far
  // beyond what the renderer's WASM worker can do — in a child process, so
  // inference can't stall the UI and a native crash can't take down the app.
  // One engine at a time; picking a different model replaces it.
  let nativeStt = null;   // { proc, repo, pending: Map<id, resolve>, nextId, ready }

  function stopNativeStt() {
    if (!nativeStt) return;
    const st = nativeStt;
    nativeStt = null;
    try { st.proc.kill(); } catch (_) { /* already gone */ }
    for (const resolve of st.pending.values()) resolve({ ok: false, error: 'speech engine stopped' });
    st.pending.clear();
  }

  ipcMain.handle('stt:nativeLoad', (_e, { repo }) => {
    const spec = STT_NATIVE[repo];
    if (!spec) return { ok: false, error: 'not a native speech model: ' + repo };
    if (nativeStt && nativeStt.repo === repo) return nativeStt.ready;
    stopNativeStt();

    // Prefer the user-downloaded copy; tolerate a bundled one for dev setups.
    const roots = [path.join(app.getPath('userData'), 'models', repo), path.join(__dirname, 'models', repo)];
    const dir = roots.find((r) => fs.existsSync(path.join(r, spec.tokens)));
    if (!dir) return { ok: false, error: 'model files missing — download did not complete' };

    const proc = utilityProcess.fork(path.join(__dirname, 'stt-native.js'), [], { serviceName: 'hivemind-stt' });
    const st = { proc, repo, pending: new Map(), nextId: 0, ready: null };
    nativeStt = st;
    st.ready = new Promise((resolve) => {
      proc.once('exit', () => {
        // Covers both a load-time crash (resolve the ready promise with an
        // error) and a later one (fail whatever was in flight).
        resolve({ ok: false, error: 'speech engine process exited' });
        if (nativeStt === st) nativeStt = null;
        for (const res of st.pending.values()) res({ ok: false, error: 'speech engine crashed' });
        st.pending.clear();
      });
      proc.on('message', (msg) => {
        if (!msg) return;
        if (msg.type === 'ready') resolve({ ok: true });
        else if (msg.type === 'error') { resolve({ ok: false, error: msg.message }); stopNativeStt(); }
        else if (msg.type === 'result') {
          const res = st.pending.get(msg.id);
          if (res) { st.pending.delete(msg.id); res({ ok: true, text: msg.text || '', error: msg.error }); }
        }
      });
      proc.postMessage({
        type: 'load',
        config: {
          encoder: path.join(dir, spec.encoder),
          decoder: path.join(dir, spec.decoder),
          joiner: path.join(dir, spec.joiner),
          tokens: path.join(dir, spec.tokens),
          modelType: spec.modelType,
        },
        numThreads: Math.max(1, Math.min(os.cpus().length - 2, 8)),
      });
    });
    return st.ready;
  });

  ipcMain.handle('stt:nativeTranscribe', (_e, { audio }) => {
    const st = nativeStt;
    if (!st) return { ok: false, error: 'speech engine not running' };
    const id = ++st.nextId;
    return new Promise((resolve) => {
      st.pending.set(id, resolve);
      st.proc.postMessage({ type: 'transcribe', id, audio });
    });
  });

  ipcMain.on('stt:nativeStop', () => stopNativeStt());
  app.on('will-quit', () => stopNativeStt());

  // -- IPC: portable build --------------------------------------------------
  // Detect whether a hive's directory is the Hivemind source checkout, and (if
  // so) build+release a portable copy of the app from it: bump the patch
  // version, build, then publish the exe as a GitHub release. One build at a
  // time; progress lines stream to the renderer so the toolbar button can
  // report status.
  ipcMain.handle('build:isHivemind', (_e, { cwd }) => build.isHivemindProject(cwd));
  ipcMain.handle('build:portable', async (_e, { cwd }) => {
    if (buildRunning) return { ok: false, message: 'A build is already running.' };
    buildRunning = true;
    const progress = (line) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('build:progress', { line });
      }
    };
    try {
      // Publishing is the point of the build, so make sure gh is usable
      // before bumping/committing anything — otherwise the pushed version
      // bump ends up ahead of the newest release and clients never update.
      const gh = await build.checkGhReady(cwd);
      if (!gh.ok) return { ok: false, message: gh.message };
      // Bump first so the exe is stamped with the new version; restore on
      // build failure so failed builds don't burn version numbers.
      let bump;
      try {
        bump = await build.bumpPatchVersion(cwd);
      } catch (err) {
        return { ok: false, message: `Could not bump the version: ${err.message}` };
      }
      progress(`Version bumped to ${bump.version}`);
      const res = await build.buildPortable(cwd, progress);
      if (!res.ok) {
        await build.restoreVersion(cwd, bump.prevRaw);
        return res;
      }
      const pub = await build.publishRelease(cwd, bump.version, progress);
      return Object.assign({}, res, {
        version: bump.version,
        published: pub.ok,
        publishMessage: pub.message,
        releaseUrl: pub.url,
      });
    } finally {
      buildRunning = false;
    }
  });

  sweepOldTempImages();
  createWindow();
  // Portable builds only: offer to self-update from the latest GitHub release.
  updater.checkForUpdates(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Pasted/dropped screenshots are persisted to os.tmpdir()/hivemind-images so
// Claude Code can read them by path; nothing else ever deletes them. Sweep files
// older than a week on startup so the temp dir doesn't grow without bound.
function sweepOldTempImages() {
  try {
    const dir = path.join(os.tmpdir(), 'hivemind-images');
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch (_) { /* skip files we can't stat/remove */ }
    }
  } catch (_) { /* no temp dir yet, or unreadable — nothing to sweep */ }
}

app.on('window-all-closed', () => {
  transcript.disposeAll();
  for (const { proc } of ptys.values()) {
    try {
      proc.kill();
    } catch (_) {
      /* ignore */
    }
  }
  ptys.clear();
  if (process.platform !== 'darwin') app.quit();
});
