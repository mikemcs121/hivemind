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
// Broadcast: drive every live thread on a board at once
// ---------------------------------------------------------------------------
let broadcastTyping = false; // mirror keystrokes from the focused pane to all

function liveBoardPanes(boardId) {
  const g = grids.get(boardId);
  if (!g) return [];
  const out = [];
  for (const col of g.columns) {
    for (const p of col.panes) if (!p.disposed && p.state !== 'dead') out.push(p);
  }
  return out;
}

function broadcastRaw(boardId, data) {
  for (const p of liveBoardPanes(boardId)) {
    window.api.writePty(p.id, data);
    markActivity(p, '');
  }
}

function broadcastLine(boardId, text) {
  broadcastRaw(boardId, text + '\r');
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
  broadcastToggle.disabled = false;

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
  updateBcCount();
  if (typeof gitToggle !== 'undefined' && gitToggle) gitToggle.disabled = false;
  if (typeof gitOnBoardChange === 'function') gitOnBoardChange();
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
  updateBcCount();
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
    // With mirror-typing on, keystrokes in the focused pane fan out to every
    // thread on the board; otherwise they go only to this pane.
    if (broadcastTyping && pane === focusedPane) {
      broadcastRaw(pane.board.id, data);
    } else {
      window.api.writePty(id, data);
    }
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
    e.stopPropagation();
    setPaneFontSize(pane, pane.fontSize + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false, capture: true });

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
  updateBcCount();

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
  broadcastToggle.disabled = true;
  broadcastBar.classList.add('hidden');
  broadcastToggle.classList.remove('active');
  boardTitle.textContent = 'No board selected';
  boardMeta.textContent = '';
  if (typeof gitToggle !== 'undefined' && gitToggle) {
    gitToggle.disabled = true;
    gitToggle.classList.remove('active');
  }
  if (typeof gitPanel !== 'undefined' && gitPanel) gitPanel.classList.add('hidden');
  const sb = $('sidebar'); if (sb) sb.classList.remove('git-open');
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
// Broadcast bar wiring
// ---------------------------------------------------------------------------
const broadcastToggle = $('broadcast-toggle');
const broadcastBar = $('broadcast-bar');
const bcInput = $('bc-input');
const bcCount = $('bc-count');
const bcMirror = $('bc-mirror');

function updateBcCount() {
  if (bcCount) bcCount.textContent = String(activeBoardId ? liveBoardPanes(activeBoardId).length : 0);
}

broadcastToggle.onclick = () => {
  const open = broadcastBar.classList.toggle('hidden') === false;
  broadcastToggle.classList.toggle('active', open);
  if (open) { updateBcCount(); bcInput.focus(); }
  if (activeBoardId) fitBoard(activeBoardId); // the bar changes the grid height
};

function sendBroadcast() {
  if (!activeBoardId) return;
  broadcastLine(activeBoardId, bcInput.value);
  bcInput.value = '';
  bcInput.focus();
}

$('bc-send').onclick = sendBroadcast;
bcInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendBroadcast(); }
});
$('bc-enter').onclick = () => { if (activeBoardId) broadcastRaw(activeBoardId, '\r'); };
$('bc-interrupt').onclick = () => { if (activeBoardId) broadcastRaw(activeBoardId, '\x03'); };
bcMirror.onchange = () => {
  broadcastTyping = bcMirror.checked;
  broadcastToggle.classList.toggle('mirror', broadcastTyping);
};

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
let lastStatus = null;

function activeBoard() { return boards.find((b) => b.id === activeBoardId) || null; }
function activeDir() { const b = activeBoard(); return b && b.dir ? b.dir : null; }
const baseName = (p) => p.replace(/\/$/, '').split('/').pop();
const dirName = (p) => { const i = p.replace(/\/$/, '').lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; };

function setGitMsg(text, kind) {
  if (!text) { gitMsgbar.classList.add('hidden'); gitMsgbar.textContent = ''; return; }
  gitMsgbar.textContent = text;
  gitMsgbar.className = 'git-msgbar' + (kind ? ' ' + kind : '');
}

function gitPanelOpen() { return gitPanel && !gitPanel.classList.contains('hidden'); }

const sidebarEl = $('sidebar');
function setGitOpen(open) {
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
$('git-refresh').onclick = () => refreshGit();

function gitOnBoardChange() {
  if (gitPanelOpen()) refreshGit();
}

// -- Run a git op with a busy guard, then refresh + report ------------------
async function gitRun(label, fn, { refresh = true, okMsg } = {}) {
  if (gitBusy) return;
  const dir = activeDir();
  if (!dir) { setGitMsg('This board has no project directory set.', 'err'); return; }
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
  const st = await window.api.git.status(dir);
  lastStatus = st;
  renderGitState(st, opts);
}

function renderGitState(st, opts = {}) {
  gitBody.innerHTML = '';
  if (!opts.keepMsg) setGitMsg('');

  if (!st || !st.ok) {
    const wrap = document.createElement('div');
    wrap.className = 'git-empty';
    if (!st || st.reason === 'no-dir') {
      wrap.textContent = 'This board has no project directory set. Edit the board to choose one.';
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

  const actions = document.createElement('div');
  actions.className = 'git-remote-actions';
  const fetchBtn = mkBtn('Fetch', () => gitRun('Fetching', (d) => window.api.git.fetch(d), { okMsg: 'Fetched.' }));
  const pullBtn = mkBtn('Pull ↓', () => gitRun('Pulling', (d) => window.api.git.pull(d), { okMsg: 'Pulled.' }));
  const pushBtn = mkBtn('Push ↑', doPush);
  if (!st.hasRemote) {
    pullBtn.disabled = true;
    pushBtn.textContent = '⑂ Publish';
    pushBtn.title = 'Connect this repository to GitHub';
  }
  actions.append(fetchBtn, pullBtn, pushBtn);

  bar.append(line, actions);
  return bar;
}

function doPush() {
  const st = lastStatus;
  if (!st || !st.hasRemote) { openGitHubWizard(); return; }
  const setUpstream = !st.upstream;
  gitRun('Pushing', (d) => window.api.git.push(d, st.branch, setUpstream), { okMsg: 'Pushed.' });
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
  const ta = document.createElement('textarea');
  ta.id = 'git-msg';
  ta.placeholder = 'Commit message (Ctrl+Enter to commit)';
  ta.value = gitDraftMsg;
  ta.oninput = () => { gitDraftMsg = ta.value; };
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doCommit(false); }
  });

  const actions = document.createElement('div');
  actions.className = 'git-commit-actions';
  const commitBtn = mkBtn('✓ Commit', () => doCommit(false));
  commitBtn.className = 'primary';
  const commitPush = mkBtn('Commit & Push', () => doCommit(true));
  if (!st.hasRemote) commitPush.disabled = true;
  actions.append(commitBtn, commitPush);

  wrap.append(ta, actions);
  return wrap;
}

let gitDraftMsg = '';

async function doCommit(thenPush) {
  const st = lastStatus;
  const msg = gitDraftMsg.trim();
  if (!msg) { setGitMsg('Enter a commit message first.', 'err'); return; }
  if (!st || !st.files.some((f) => f.staged)) {
    setGitMsg('Stage at least one change before committing.', 'err');
    return;
  }
  const res = await gitRun('Committing', (d) => window.api.git.commit(d, msg), { okMsg: 'Committed.', refresh: false });
  if (res && res.code === 0) {
    gitDraftMsg = '';
    if (thenPush) {
      const setUpstream = !st.upstream;
      await gitRun('Pushing', (d) => window.api.git.push(d, st.branch, setUpstream), { okMsg: 'Committed and pushed.' });
    } else {
      await refreshGit({ keepMsg: true });
    }
  } else {
    await refreshGit({ keepMsg: true });
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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  if (!diffBackdrop.classList.contains('hidden')) diffBackdrop.classList.add('hidden');
  else if (!branchBackdrop.classList.contains('hidden')) branchBackdrop.classList.add('hidden');
  else if (!ghBackdrop.classList.contains('hidden')) closeWizard();
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
  if (!dir) { setGitMsg('This board has no project directory set.', 'err'); return; }
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
  ghBody.appendChild(el('p', 'gh-intro', "Link this board's project to a GitHub repository."));
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
  ghBody.appendChild(el('p', 'gh-note', 'Open a thread on this board and run the command below, follow the browser prompts, then click “I’ve signed in”.'));
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
// Init
// ---------------------------------------------------------------------------
(async function init() {
  boards = (await window.api.listBoards()) || [];
  renderBoardList();
  if (boards.length) selectBoard(boards[0].id);
  else showEmpty();
})();
