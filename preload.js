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

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  osBuild,

  // Boards persistence
  listBoards: () => ipcRenderer.invoke('boards:list'),
  saveBoards: (boards) => ipcRenderer.invoke('boards:save', boards),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),

  // Images dragged/pasted into a terminal: persist bytes, get back a path.
  saveTempImage: (bytes, ext) => ipcRenderer.invoke('image:saveTemp', { bytes, ext }),
  // A screenshot held on the native clipboard (e.g. Win+Shift+S): persist as
  // PNG and get back a path, or null if the clipboard holds no image.
  clipboardImage: () => ipcRenderer.invoke('image:fromClipboard'),

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

    // Draft a commit message from the current diff via `claude -p`.
    aiCommitMessage: (cwd) => ipcRenderer.invoke('git:aiCommit', { cwd }),
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
    write: (cwd, planId, content) => ipcRenderer.invoke('plan:write', { cwd, planId, content }),
    readComments: (cwd, planId) => ipcRenderer.invoke('plan:comments:read', { cwd, planId }),
    writeComments: (cwd, planId, comments) => ipcRenderer.invoke('plan:comments:write', { cwd, planId, comments }),
    clear: (cwd, planId) => ipcRenderer.invoke('plan:clear', { cwd, planId }),
    ensureIgnored: (cwd) => ipcRenderer.invoke('plan:ensureIgnored', { cwd }),
  },

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
  stt: {
    ensureModel: (repo) => ipcRenderer.invoke('stt:ensureModel', { repo }),
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
