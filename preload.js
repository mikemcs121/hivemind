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

  // Notifications
  notify: (payload) => ipcRenderer.send('notify', payload),
  onFocusPane: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('focus-pane', h);
    return () => ipcRenderer.removeListener('focus-pane', h);
  },
});
