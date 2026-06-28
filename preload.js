'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Boards persistence
  listBoards: () => ipcRenderer.invoke('boards:list'),
  saveBoards: (boards) => ipcRenderer.invoke('boards:save', boards),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),

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

    // GitHub connection wizard
    remoteUrl: (cwd) => ipcRenderer.invoke('git:remoteUrl', { cwd }),
    setRemote: (cwd, url) => ipcRenderer.invoke('git:setRemote', { cwd, url }),
    ghCheck: () => ipcRenderer.invoke('gh:check'),
    ghCreateRepo: (cwd, opts) => ipcRenderer.invoke('gh:createRepo', Object.assign({ cwd }, opts)),
  },

  // Notifications
  notify: (payload) => ipcRenderer.send('notify', payload),
  onFocusPane: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('focus-pane', h);
    return () => ipcRenderer.removeListener('focus-pane', h);
  },
});
