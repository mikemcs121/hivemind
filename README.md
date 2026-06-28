# Hivemind

A Windows desktop app for running **multiple Claude threads at once**, organized
into **boards**. Each board is tied to a project directory, and every thread you
open on that board runs in that directory — so a whole board shares one project
context.

## Features

- **Boards** in the left sidebar. Each board has a name, a project directory, and a
  startup command (default: `claude`).
- **Split grid** layout: open as many threads on a board as you want. They tile
  automatically and you can **drag the gutters** between them to resize.
- Every new thread **auto-runs `claude`** (or whatever startup command you set)
  in the board's directory.
- Threads **keep running in the background** when you switch boards.
- **Status at a glance**: each thread shows whether it's *working*, *needs you*
  (waiting on a prompt), *ready* (turn finished), or *exited* — via a colored dot
  and label in the pane header. Boards in the sidebar get a matching dot plus a
  badge counting how many of their threads are waiting for you.
- **Attention notifications**: when a background thread needs your input or
  finishes a turn while the window isn't focused, you get a native notification
  and a taskbar flash. Click the notification to jump straight to that thread.
  Toggle notifications with the 🔔 button in the top bar.
- **Adjustable text size** per thread: use the **A− / A+** buttons in the thread
  header, **Ctrl +** / **Ctrl −** (Ctrl 0 to reset), or **Ctrl + scroll**. The
  size you pick sticks and becomes the default for new threads.
- Boards persist between sessions (stored in the app's userData folder).

## Running

Double-click **`Hivemind.cmd`**, or the **Hivemind** shortcut on your Desktop.
(No global Node install is needed to *run* it — it uses the bundled Electron
runtime.)

From a terminal you can also do:

```
cd C:\Projects\hivemind
npm start
```

## How to use

1. Click **＋** next to "Boards" (or "Create your first board").
2. Give it a name, click **Browse…** to pick the project directory, leave the
   startup command as `claude` (or change it, e.g. `claude --resume`, `pwsh`).
3. The board opens with one thread already running `claude`.
4. Click **＋ Thread** (top right) or the **⊞** icon on any pane to add more
   threads — all sharing that board's directory.
5. Drag the dividers between threads to resize. Click **✕** to close a pane.

## Architecture

| File | Role |
|------|------|
| `main.js` | Electron main process. Spawns a real Windows PTY (ConPTY) per terminal, manages board persistence, handles IPC. |
| `preload.js` | Secure `contextBridge` API exposed to the renderer (no Node access in the page). |
| `src/index.html` / `styles.css` | UI shell + styling. |
| `src/renderer.js` | Board management, the resizable split-grid layout, and xterm.js terminals. |

Terminal rendering: **xterm.js** (`@xterm/xterm` + `@xterm/addon-fit`).
PTY backend: **`@homebridge/node-pty-prebuilt-multiarch`**.

### App icon

`build/icon.ico` (the honeycomb) is generated from pure Node — no image tools
or native libs needed. To regenerate after tweaking the logo:

```
node scripts/generate-icon.js
```

It rasterizes the honeycomb at 16–256 px and packs a multi-resolution `.ico`
(plus `build/icon-256.png` for preview). The window uses it via `icon:` in
`main.js`, and `electron-builder` picks up `build/icon.ico` for packaged builds.

## ⚠️ Build/toolchain note (important if you upgrade Electron)

This machine has **no C/C++ compiler or Python**, so native modules cannot be
built from source. We therefore use `@homebridge/node-pty-prebuilt-multiarch`,
which ships **prebuilt** binaries — but only up to **Electron 29 (ABI v121)** for
win32-x64.

**That is why Electron is pinned to `29.4.6`.** If you bump Electron to a newer
major, there will be no matching prebuilt PTY binary and the app will fail to load
the `pty.node` module. To go newer you'd need to either:

- wait for the package to publish prebuilds for that Electron ABI, **or**
- install Python 3.12 + Visual Studio Build Tools (C++ workload) and compile
  node-pty from source via `npm run rebuild`.

To refetch the prebuilt binary after a clean `npm install`:

```
cd node_modules\@homebridge\node-pty-prebuilt-multiarch
node ..\..\prebuild-install\bin.js --runtime electron --target 29.4.6 --arch x64
```

(npm install scripts are disabled in this environment, so the binary download must
be run manually as above; the Electron binary itself is fetched with
`node node_modules\electron\install.js`.)
