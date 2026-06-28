'use strict';

const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const git = require('./git');

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

function spawnPty({ id, cwd, cols, rows, startupCommand }, win) {
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
  const cmd = (startupCommand && startupCommand.trim()) || 'claude';
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
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;

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
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Stop flashing the taskbar once the user looks at the window.
  mainWindow.on('focus', () => {
    try { mainWindow.flashFrame(false); } catch (_) { /* ignore */ }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Required on Windows for native notifications to show the app name/icon.
  if (process.platform === 'win32') app.setAppUserModelId('com.hivemind.app');

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
      title: 'Choose project directory for this board',
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
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
  ipcMain.handle('git:checkout', (_e, { cwd, name }) => git.checkout(cwd, name));
  ipcMain.handle('git:createBranch', (_e, { cwd, name }) => git.createBranch(cwd, name));
  ipcMain.handle('git:init', (_e, { cwd }) => git.init(cwd));
  ipcMain.handle('git:fetch', (_e, { cwd }) => git.fetch(cwd));
  ipcMain.handle('git:pull', (_e, { cwd }) => git.pull(cwd));
  ipcMain.handle('git:push', (_e, { cwd, branch, setUpstream }) => git.push(cwd, { branch, setUpstream }));

  // -- IPC: GitHub connection wizard ----------------------------------------
  ipcMain.handle('git:remoteUrl', (_e, { cwd }) => git.getRemoteUrl(cwd));
  ipcMain.handle('git:setRemote', (_e, { cwd, url }) => git.setRemoteOrigin(cwd, url));
  ipcMain.handle('gh:check', () => git.ghCheck());
  ipcMain.handle('gh:createRepo', (_e, { cwd, name, visibility, push }) => git.ghCreateRepo(cwd, { name, visibility, push }));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
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
