'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Windows build number (e.g. 26200 from "10.0.26200"), 0 elsewhere. xterm's
// `windowsPty` option needs it to match ConPTY's line-wrap/reflow behaviour.
// This preload is sandboxed and can't require('os'), so main.js computes the
// build and passes it in via webPreferences.additionalArguments (--hm-os-build).
const osBuild = (() => {
  const arg = process.argv.find((a) => a.startsWith('--hm-os-build='));
  return arg ? Number(arg.slice('--hm-os-build='.length)) || 0 : 0;
})();

// App version (from package.json), handed over via argv the same way as
// osBuild since the sandboxed preload can't read package.json itself.
const appVersion = (() => {
  const arg = process.argv.find((a) => a.startsWith('--hm-app-version='));
  return arg ? arg.slice('--hm-app-version='.length) : '';
})();

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  osBuild,
  appVersion,

  // Boards persistence
  listBoards: () => ipcRenderer.invoke('boards:list'),
  saveBoards: (boards) => ipcRenderer.invoke('boards:save', boards),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  // Composer attachments: pick one or more files to attach to a chat message.
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),

  // Images dragged/pasted into a terminal: persist bytes, get back a path.
  saveTempImage: (bytes, ext) => ipcRenderer.invoke('image:saveTemp', { bytes, ext }),
  // A screenshot held on the native clipboard (e.g. Win+Shift+S): persist as
  // PNG and get back a path, or null if the clipboard holds no image.
  clipboardImage: () => ipcRenderer.invoke('image:fromClipboard'),
  // Copy a file into `<cwd>/.hivemind/attachments/` so sandboxed agents
  // (Codex/"ChatGPT") can read it; returns the staged path or null.
  stageAttachment: (cwd, srcPath) => ipcRenderer.invoke('attach:stage', { cwd, srcPath }),

  // PTY lifecycle
  spawnPty: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  writePty: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.send('pty:kill', { id }),

  // PTY events
  onPtyData: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:data', h);
    return () => ipcRenderer.removeListener('pty:data', h);
  },
  onPtyExit: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:exit', h);
    return () => ipcRenderer.removeListener('pty:exit', h);
  },

  // Git (Source Control panel). `cwd` is the active board's project directory.
  git: {
    status: (cwd) => ipcRenderer.invoke('git:status', { cwd }),
    diff: (cwd, file, staged, untracked) => ipcRenderer.invoke('git:diff', { cwd, file, staged, untracked }),
    stage: (cwd, files) => ipcRenderer.invoke('git:stage', { cwd, files }),
    stageAll: (cwd) => ipcRenderer.invoke('git:stageAll', { cwd }),
    unstage: (cwd, files) => ipcRenderer.invoke('git:unstage', { cwd, files }),
    unstageAll: (cwd) => ipcRenderer.invoke('git:unstageAll', { cwd }),
    discard: (cwd, files) => ipcRenderer.invoke('git:discard', { cwd, files }),
    commit: (cwd, message) => ipcRenderer.invoke('git:commit', { cwd, message }),
    branches: (cwd) => ipcRenderer.invoke('git:branches', { cwd }),
    log: (cwd, count) => ipcRenderer.invoke('git:log', { cwd, count }),
    checkout: (cwd, name) => ipcRenderer.invoke('git:checkout', { cwd, name }),
    createBranch: (cwd, name) => ipcRenderer.invoke('git:createBranch', { cwd, name }),
    init: (cwd) => ipcRenderer.invoke('git:init', { cwd }),
    fetch: (cwd) => ipcRenderer.invoke('git:fetch', { cwd }),
    pull: (cwd) => ipcRenderer.invoke('git:pull', { cwd }),
    push: (cwd, branch, setUpstream) => ipcRenderer.invoke('git:push', { cwd, branch, setUpstream }),
    resetToRemote: (cwd, branch) => ipcRenderer.invoke('git:resetToRemote', { cwd, branch }),

    // GitHub connection wizard
    remoteUrl: (cwd) => ipcRenderer.invoke('git:remoteUrl', { cwd }),
    setRemote: (cwd, url) => ipcRenderer.invoke('git:setRemote', { cwd, url }),
    ghCheck: () => ipcRenderer.invoke('gh:check'),
    ghCreateRepo: (cwd, opts) => ipcRenderer.invoke('gh:createRepo', Object.assign({ cwd }, opts)),

    // "Clone from GitHub" New-hive wizard: list repos, device-flow sign-in, clone.
    ghListRepos: (opts) => ipcRenderer.invoke('gh:listRepos', opts || {}),
    ghClone: (opts) => ipcRenderer.invoke('gh:clone', opts || {}),
    ghAuthStart: () => ipcRenderer.invoke('gh:authStart'),
    ghAuthCancel: () => ipcRenderer.invoke('gh:authCancel'),
    onGhAuthStatus: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('gh:authStatus', h);
      return () => ipcRenderer.removeListener('gh:authStatus', h);
    },

    // Draft a commit message from the current diff via `claude -p`.
    aiCommitMessage: (cwd) => ipcRenderer.invoke('git:aiCommit', { cwd }),
  },

  // Conversational Hivemind commands: ask a one-shot `claude -p` (fast model)
  // to map free-form phrasing onto a canonical command from the registry.
  hm: {
    interpret: (payload) => ipcRenderer.invoke('hm:interpret', { payload }),
  },

  // Filesystem watch on the active board's directory (auto-refresh panels).
  setWatch: (cwd) => ipcRenderer.send('watch:set', { cwd }),
  onFsChanged: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('fs:changed', h);
    return () => ipcRenderer.removeListener('fs:changed', h);
  },

  // File Explorer panel. `cwd` is the active board's project directory; `rel`
  // is a "/"-separated path under it ('' for the root).
  files: {
    list: (cwd, rel) => ipcRenderer.invoke('files:list', { cwd, rel }),
    open: (cwd, rel) => ipcRenderer.invoke('files:open', { cwd, rel }),
    reveal: (cwd, rel) => ipcRenderer.invoke('files:reveal', { cwd, rel }),
  },

  // Plan pane. `cwd` is the active board's project directory; `planId` keys the
  // per-thread plan file the thread writes and the comments Hivemind attaches.
  plan: {
    read: (cwd, planId) => ipcRenderer.invoke('plan:read', { cwd, planId }),
    readFile: (cwd, file) => ipcRenderer.invoke('plan:readFile', { cwd, file }),
    write: (cwd, planId, content) => ipcRenderer.invoke('plan:write', { cwd, planId, content }),
    readComments: (cwd, planId) => ipcRenderer.invoke('plan:comments:read', { cwd, planId }),
    writeComments: (cwd, planId, comments) => ipcRenderer.invoke('plan:comments:write', { cwd, planId, comments }),
    clear: (cwd, planId) => ipcRenderer.invoke('plan:clear', { cwd, planId }),
    ensureIgnored: (cwd) => ipcRenderer.invoke('plan:ensureIgnored', { cwd }),
  },

  // Todo panel. `cwd` is the active board's project directory; the checklist is
  // shared per-hive (one `.hivemind/todos.json`), not per-thread.
  todo: {
    read: (cwd) => ipcRenderer.invoke('todo:read', { cwd }),
    write: (cwd, todos) => ipcRenderer.invoke('todo:write', { cwd, todos }),
    ensureIgnored: (cwd) => ipcRenderer.invoke('todo:ensureIgnored', { cwd }),
  },

  // Prompt History panel. `cwd` is the active board's project directory; the
  // log is shared per-hive (one `.hivemind/prompt-history.json`), not per-thread.
  promptHistory: {
    read: (cwd) => ipcRenderer.invoke('promptHistory:read', { cwd }),
    append: (cwd, entry) => ipcRenderer.invoke('promptHistory:append', { cwd, entry }),
    write: (cwd, entries) => ipcRenderer.invoke('promptHistory:write', { cwd, entries }),
    ensureIgnored: (cwd) => ipcRenderer.invoke('promptHistory:ensureIgnored', { cwd }),
  },

  // Chat wrapper: bind a pane to its Claude Code session transcript (JSONL
  // under ~/.claude/projects/) and stream parsed entries back. `noteSent`
  // reports composer sends so binding can match files by first user message.
  transcript: {
    bind: (opts) => ipcRenderer.invoke('transcript:bind', opts),
    unbind: (paneId) => ipcRenderer.send('transcript:unbind', { paneId }),
    noteSent: (paneId, text) => ipcRenderer.send('transcript:noteSent', { paneId, text }),
    // Conversation-history picker: list past sessions, read one, and restore live.
    listSessions: (opts) => ipcRenderer.invoke('transcript:sessions', opts),
    readSession: (opts) => ipcRenderer.invoke('transcript:session', opts),
    refresh: (paneId) => ipcRenderer.send('transcript:refresh', { paneId }),
    onEntries: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('transcript:entries', h);
      return () => ipcRenderer.removeListener('transcript:entries', h);
    },
    onStatus: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('transcript:status', h);
      return () => ipcRenderer.removeListener('transcript:status', h);
    },
  },

  // Autocorrect: look up the word just typed; returns the replacement or null
  // to leave it alone. Synchronous on purpose — the fix has to be in the field
  // before the Enter that committed the word is acted on (send, add todo, …).
  spellCorrect: (word) => ipcRenderer.sendSync('spell:correct', word),

  // Open a web/mail link in the OS default browser (used by plan links).
  openExternal: (url) => ipcRenderer.invoke('open:external', { url }),

  // Portable build (only meaningful when the hive points at the Hivemind source).
  build: {
    isHivemind: (cwd) => ipcRenderer.invoke('build:isHivemind', { cwd }),
    portable: (cwd) => ipcRenderer.invoke('build:portable', { cwd }),
  },
  onBuildProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('build:progress', h);
    return () => ipcRenderer.removeListener('build:progress', h);
  },

  // Claude usage: rate-limit windows + today's token totals.
  usage: {
    get: () => ipcRenderer.invoke('usage:get'),
  },

  // Speech-to-text models. `ensureModel` makes sure the chosen model's files are
  // on disk (downloading a non-default one into userData on first use), and
  // resolves { ok, alreadyPresent } / { ok:false, error }. Download progress for
  // the current fetch streams via onSttDownloadProgress.
  // Native models (`native: true` in the renderer's STT_MODELS) decode in a
  // sherpa-onnx utility process instead of the renderer's WASM worker:
  // nativeLoad boots it, nativeTranscribe sends one utterance's Float32Array
  // and resolves { ok, text } | { ok:false, error }, nativeStop kills it.
  stt: {
    ensureModel: (repo) => ipcRenderer.invoke('stt:ensureModel', { repo }),
    nativeLoad: (repo) => ipcRenderer.invoke('stt:nativeLoad', { repo }),
    nativeTranscribe: (audio) => ipcRenderer.invoke('stt:nativeTranscribe', { audio }),
    nativeStop: () => ipcRenderer.send('stt:nativeStop'),
  },
  onSttDownloadProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('stt:downloadProgress', h);
    return () => ipcRenderer.removeListener('stt:downloadProgress', h);
  },

  // Notifications
  notify: (payload) => ipcRenderer.send('notify', payload),
  onFocusPane: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('focus-pane', h);
    return () => ipcRenderer.removeListener('focus-pane', h);
  },
});
