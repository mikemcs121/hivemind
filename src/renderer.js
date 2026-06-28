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

// xterm theme
const THEME = {
  background: '#11111b',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b70',
  black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
  blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5', brightWhite: '#a6adc8',
};

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
  defaultFontSize = n;
  localStorage.setItem('hm.fontSize', String(n));
  try {
    pane.fitAddon.fit();
    window.api.resizePty(pane.id, pane.term.cols, pane.term.rows);
  } catch (_) { /* terminal not ready */ }
}

// ---------------------------------------------------------------------------
// Terminal status detection
//
// Claude Code renders an animated spinner while it works, so the PTY emits a
// steady stream of output during a turn. That makes the signal simple: output
// flowing => busy; output gone quiet => the turn is done or it is waiting for
// you. When it goes quiet we scan the recent output for a permission / prompt
// pattern to tell "needs your input" (attention) apart from "finished" (idle).
// ---------------------------------------------------------------------------
const IDLE_MS = 1000; // quiet period before a terminal is no longer "busy"

const STATE_LABEL = {
  busy: 'working…',
  attention: 'needs you',
  idle: 'ready',
  dead: 'exited',
};

// Patterns that mean Claude (or a CLI) is waiting for the user to answer.
const ATTENTION_PATTERNS = [
  /❯\s*1\.\s*Yes/i,
  /\b1\.\s*Yes\b[\s\S]{0,160}\b2\.\s*No\b/i,
  /Do you want to (proceed|create|make|run|allow|continue|trust)/i,
  /Would you like to/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /press\s+enter\s+to\s+continue/i,
  /Continue\?\s*$/im,
];

// Strip ANSI escape / OSC sequences so the pattern scan sees plain text.
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\x1B\][^\x07]*(?:\x07|\x1B\\)/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

let notifyMuted = localStorage.getItem('hm.muteNotifications') === '1';

function markActivity(pane, data) {
  if (pane.disposed || pane.state === 'dead') return;
  if (data) pane.buf = ((pane.buf || '') + stripAnsi(data)).slice(-4000);
  setPaneState(pane, 'busy');
  clearTimeout(pane.idleTimer);
  pane.idleTimer = setTimeout(() => evaluateIdle(pane), IDLE_MS);
}

function evaluateIdle(pane) {
  if (pane.disposed || pane.state === 'dead') return;
  const buf = pane.buf || '';
  const needsYou = ATTENTION_PATTERNS.some((re) => re.test(buf));
  setPaneState(pane, needsYou ? 'attention' : 'idle');
}

function setPaneState(pane, state) {
  if (pane.state === state) return;
  const prev = pane.state;
  pane.state = state;

  pane.dot.className = 'dot ' + state;
  if (pane.statusEl) {
    pane.statusEl.textContent = STATE_LABEL[state] || '';
    pane.statusEl.className = 'status ' + state;
  }
  updateBoardStatus(pane.board.id);

  // Notify on the transitions that pull a human back: a terminal asking for
  // input, or one finishing a turn while the window is in the background.
  const focusedHere = pane === focusedPane && document.hasFocus();
  if (notifyMuted || focusedHere) return;
  if (state === 'attention') {
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
  const s = { attention: 0, busy: 0, idle: 0, dead: 0, total: 0 };
  const g = grids.get(boardId);
  if (!g) return s;
  for (const col of g.columns) {
    for (const p of col.panes) {
      s.total++;
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
  if (s.attention > 0) summary = 'attention';
  else if (s.busy > 0) summary = 'busy';
  else if (s.idle > 0) summary = 'idle';
  else if (s.dead > 0) summary = 'dead';
  if (sdot) sdot.className = 'status-dot ' + summary;

  if (badge) {
    if (s.attention > 0) {
      badge.textContent = String(s.attention);
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }
  }
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const boardListEl = $('board-list');
const gridEl = $('grid');
const emptyState = $('empty-state');
const boardTitle = $('board-title');
const boardMeta = $('board-meta');
const addTermBtn = $('add-term');

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
async function persist() {
  await window.api.saveBoards(boards.map((b) => ({
    id: b.id, name: b.name, dir: b.dir, startupCommand: b.startupCommand,
  })));
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
    edit.title = 'Edit board';
    edit.onclick = (e) => { e.stopPropagation(); openModal(b); };
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.title = 'Delete board';
    del.onclick = (e) => { e.stopPropagation(); deleteBoard(b); };
    actions.append(edit, del);
    row.append(nameWrap, badge, actions);

    const dir = document.createElement('div');
    dir.className = 'dir';
    dir.textContent = b.dir || '(no directory)';
    dir.title = b.dir || '';

    li.append(row, dir);
    li.onclick = () => selectBoard(b.id);
    boardListEl.appendChild(li);
  }
  // Repaint status dots / badges for any board that already has terminals.
  for (const b of boards) updateBoardStatus(b.id);
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

  boardTitle.textContent = board.name;
  boardMeta.textContent = board.dir || '';

  // Build the grid lazily the first time a board is opened.
  if (!grids.has(id)) {
    const g = { el: document.createElement('div'), columns: [] };
    g.el.className = 'board-grid';
    g.el.style.cssText = 'display:flex;flex:1;min-height:0;min-width:0;width:100%;';
    gridEl.appendChild(g.el);
    grids.set(id, g);
    addTerminal(board); // open the first terminal automatically
  }

  // Show the active grid, hide the rest.
  for (const [bid, g] of grids) {
    g.el.style.display = bid === id ? 'flex' : 'none';
  }
  renderBoardList();
  fitBoard(id);
}

// ---------------------------------------------------------------------------
// Layout: columns -> panes, rebuilt with gutters whenever structure changes
// ---------------------------------------------------------------------------
function layout(boardId) {
  const g = grids.get(boardId);
  if (!g) return;
  g.el.innerHTML = '';

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
  };
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ---------------------------------------------------------------------------
// Panes / terminals
// ---------------------------------------------------------------------------
function addTerminal(board) {
  const g = grids.get(board.id);
  if (!g) return;

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

  const pane = createPane(board, col);
  col.panes.push(pane);
  layout(board.id);
  focusPane(pane);
}

function createPane(board, col) {
  const id = nextId('term');
  const el = document.createElement('div');
  el.className = 'pane';

  const header = document.createElement('div');
  header.className = 'pane-header';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = board.startupCommand || 'claude';
  const fontDownBtn = document.createElement('button');
  fontDownBtn.className = 'font-btn';
  fontDownBtn.textContent = 'A−';
  fontDownBtn.title = 'Smaller text (Ctrl+−)';
  const fontUpBtn = document.createElement('button');
  fontUpBtn.className = 'font-btn';
  fontUpBtn.textContent = 'A+';
  fontUpBtn.title = 'Bigger text (Ctrl+=)';
  const splitBtn = document.createElement('button');
  splitBtn.textContent = '⊞';
  splitBtn.title = 'New thread on this board';
  const statusEl = document.createElement('span');
  statusEl.className = 'status';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close thread';
  header.append(dot, title, statusEl, fontDownBtn, fontUpBtn, splitBtn, closeBtn);

  const termWrap = document.createElement('div');
  termWrap.className = 'pane-term';
  el.append(header, termWrap);

  const term = new Terminal({
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: defaultFontSize,
    cursorBlink: true,
    allowProposedApi: true,
    theme: THEME,
    scrollback: 5000,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(termWrap);

  const pane = {
    id, el, term, fitAddon, dot, statusEl, flex: 1, col, board, disposed: false,
    name: board.startupCommand || 'claude', state: null, buf: '', idleTimer: null,
    fontSize: defaultFontSize,
  };

  // Wire IO
  term.onData((data) => {
    window.api.writePty(id, data);
    markActivity(pane, ''); // typing means this pane is active again
  });
  el.addEventListener('mousedown', () => focusPane(pane));

  splitBtn.onclick = (e) => { e.stopPropagation(); addTerminal(board); };
  closeBtn.onclick = (e) => { e.stopPropagation(); closePane(pane); };

  // Font sizing: header buttons, Ctrl +/-/0, and Ctrl+scroll.
  fontDownBtn.onclick = (e) => { e.stopPropagation(); setPaneFontSize(pane, pane.fontSize - 1); };
  fontUpBtn.onclick = (e) => { e.stopPropagation(); setPaneFontSize(pane, pane.fontSize + 1); };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey)) return true;
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
    setPaneFontSize(pane, pane.fontSize + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  // Spawn the PTY in the board's directory.
  fitAddon.fit();
  window.api.spawnPty({
    id,
    cwd: board.dir,
    cols: term.cols,
    rows: term.rows,
    startupCommand: board.startupCommand || 'claude',
  });

  markActivity(pane, ''); // start out "working" until the first quiet period

  return pane;
}

function closePane(pane) {
  if (pane.disposed) return;
  pane.disposed = true;
  clearTimeout(pane.idleTimer);
  window.api.killPty(pane.id);
  try { pane.term.dispose(); } catch (_) { /* ignore */ }

  const g = grids.get(pane.board.id);
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
  }
}

let focusedPane = null;
function focusPane(pane) {
  if (focusedPane && focusedPane !== pane) focusedPane.el.classList.remove('focused');
  focusedPane = pane;
  pane.el.classList.add('focused');
  try { pane.term.focus(); } catch (_) { /* ignore */ }
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
    setPaneState(pane, 'dead');
    pane.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
  }
});

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

function openModal(board) {
  editingBoard = board || null;
  $('modal-title').textContent = board ? 'Edit board' : 'New board';
  mName.value = board ? board.name : '';
  mDir.value = board ? board.dir : '';
  mCmd.value = board ? (board.startupCommand || '') : 'claude';
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
  const name = mName.value.trim() || 'Untitled board';
  const dir = mDir.value.trim();
  const cmd = mCmd.value.trim() || 'claude';
  if (editingBoard) {
    editingBoard.name = name;
    editingBoard.dir = dir;
    editingBoard.startupCommand = cmd;
  } else {
    const b = { id: nextId('board'), name, dir, startupCommand: cmd };
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
    }
  }
  closeModal();
};

async function deleteBoard(board) {
  if (!confirm(`Delete board "${board.name}"? Its threads will be closed.`)) return;
  const g = grids.get(board.id);
  if (g) {
    for (const col of g.columns) {
      for (const pane of col.panes) {
        pane.disposed = true;
        window.api.killPty(pane.id);
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
  boardTitle.textContent = 'No board selected';
  boardMeta.textContent = '';
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

// Mute / unmute attention notifications (preference persists across sessions).
const muteBtn = $('mute-toggle');
function renderMuteBtn() {
  if (!muteBtn) return;
  muteBtn.textContent = notifyMuted ? '🔕' : '🔔';
  muteBtn.title = notifyMuted ? 'Notifications muted — click to enable' : 'Notifications on — click to mute';
  muteBtn.classList.toggle('muted', notifyMuted);
}
if (muteBtn) {
  muteBtn.onclick = () => {
    notifyMuted = !notifyMuted;
    localStorage.setItem('hm.muteNotifications', notifyMuted ? '1' : '0');
    renderMuteBtn();
  };
  renderMuteBtn();
}

// A clicked notification jumps to the board + pane that needs attention.
window.api.onFocusPane(({ paneId, boardId }) => {
  if (boardId && boardId !== activeBoardId) selectBoard(boardId);
  const pane = findPane(paneId);
  if (pane) focusPane(pane);
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
