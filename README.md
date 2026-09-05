# Hivemind

A Windows desktop app for running **several coding agents at once, across several
projects**, with a real conversation view on top of each one's terminal.

Every agent CLI is a TUI: great to work in, awful to supervise. You can watch one
of them, not six. Hivemind keeps the terminal exactly as it is — it is still the
thing that runs, and every prompt is still delivered through it — and layers a
chat view over the top, so a thread reads like a conversation and tells you at a
glance whether it is working, waiting on you, or done.

## The shape of it

- A **hive** is a project directory. Each hive holds as many **threads** as you
  want, tiled in a resizable split grid, all running in that directory.
- A thread is one agent CLI in one terminal. Threads keep running when you switch
  hives, so several projects can make progress at the same time.
- Each thread can run a different agent: **Claude**, **ChatGPT** (Codex CLI),
  **Gemini**, or **Grok**. One hive can mix them.
- Each thread shows a **chat view** by default — the conversation, rendered —
  with the raw terminal one click away (`>_` / `💬` in the thread header).

## The conversation view

This is the part that makes a swarm supervisable.

For Claude and ChatGPT threads, Hivemind reads the agent's own session log and
renders it: messages, tool calls, thinking, subagents — each filterable. On top
of that it surfaces the things you'd otherwise have to catch by staring at a TUI:

- **A question card.** When the agent stops to ask something, its menu is
  rendered as buttons you can click from the chat view. Every button re-checks
  the live screen before it types anything, so a stale click can never actuate a
  menu it wasn't aimed at.
- **A plan card.** Plans come up inline with Approve / Request changes, and you
  can comment on a highlighted passage.
- **Status.** Working / needs you / done / exited, as a dot on the thread, a dot
  and badge on the hive, and an OS notification when a background thread wants
  you (click it to jump straight there).
- **A composer** with `/` command and `@` file autocomplete, image paste and
  drag-drop, `↑`/`↓` history, and an interrupt button.

The chat view *covers* the terminal, it never replaces it. If Hivemind's
rendering of something is wrong, the terminal underneath is still the truth, and
the prompt you send goes through the PTY either way.

## Other things in the app

- **Source Control** — a Git panel in the shape of Visual Studio's "Git Changes":
  branch and ahead/behind, fetch/pull/push, staging, per-file diffs, commit log,
  and a wizard for creating or cloning a GitHub repo.
- **File Explorer** — browse the hive's folder; click a path to insert it into a
  thread's prompt.
- **Prompt History** — a per-hive log of the prompts you've sent, stored in
  `.hivemind/`. Click one to jump to it in the conversation, or resend it.
- **Voice typing** — dictate into the focused thread, transcribed on-device and
  fully offline. Toggle with `~`.
- **Hivemind commands** — start a message with "Hivemind," to address the app
  instead of the thread: *"Hivemind, tell Leo to fix the login bug"*, *"Hivemind,
  open a new thread"*.
- **Usage**, **themes**, per-thread font size, and an in-app **Help** modal that
  documents all of the above.

## Running it

Double-click **`Hivemind.cmd`**, or the **Hivemind** shortcut on your Desktop. No
global Node install is needed — it uses the bundled Electron runtime, launched as
`Hivemind.exe` so the app has its own name in Task Manager.

From a terminal:

```
cd C:\Projects\hivemind
npm start
```

## Getting started

The first time you open Hivemind with no hives, a **setup wizard** walks you
through it:

1. **Pick an agent.** It shows Claude, ChatGPT, Gemini and Grok with a live
   status read from your machine — *ready*, *sign-in needed*, or *not
   installed*.
2. **Get it connected.** If the CLI isn't installed, the wizard hands you the
   exact command with a Copy button and re-checks by itself while you run it in
   another window.
3. **Make your first hive.** Point it at a project directory; the hive opens
   with one thread already running on the agent you picked. Signing in happens
   right there in the thread, in the agent's own sign-in screen.

You can reopen the wizard from **⚙ Settings → General → Agent setup**, from the
**Set up an agent** button on the welcome screen, or by saying *"Hivemind, run
setup"*.

From there: **＋ Thread** (top right) adds more threads — all in the same
directory. Drag the dividers to resize; `Ctrl`+`Enter` maximizes the focused
thread. Pick a different agent or model per thread from its header dropdowns,
and **＋** at the top of the sidebar makes another hive.

The agent CLIs are not bundled. Claude Code you install yourself; ChatGPT needs
`npm install -g @openai/codex` (or the Codex desktop app, which Hivemind finds
automatically), Gemini needs `npm install -g @google/gemini-cli`, and Grok the
installer at <https://x.ai/cli>. Sign each one in once.

## Where things are stored

| Location | What |
|---|---|
| `%APPDATA%\hivemind` | `boards.json` (your hives + layouts), named ChatGPT account homes, downloaded speech models |
| `<project>\.hivemind\` | per-project prompt history, plans |
| `~/.claude/projects/…` | Claude's own session logs — Hivemind only ever reads these |

Credentials never go in the project folder: the agent threads work inside it, and
it gets committed.

## Development

| File | Role |
|------|------|
| `main.js` | Main process: PTYs (ConPTY via node-pty), all filesystem/git access, IPC hub |
| `preload.js` | Context bridge — the sandboxed renderer can only do what `window.api` offers |
| `src/renderer.js` | All UI: hives, the split grid, xterm terminals, chat view, panels, modals |
| `src/index.html`, `src/styles.css` | Markup and styling |
| `transcript.js` | Tails agent session logs and streams normalized entries to the chat view |
| `git.js`, `files.js`, `plan.js`, `promptHistory.js`, `usage.js` | Backends for the panels |
| `codex.js`, `agent-models.js`, `agent-cli.js` | ChatGPT accounts, model discovery, finding CLIs off `PATH` |

**Start with [`docs/README.md`](docs/README.md)** — it has a routing table
mapping each area of the code to the doc that explains it, plus the project's
non-negotiable rules. `CLAUDE.md` is the short version for agents.

Terminal rendering is **xterm.js**; the PTY backend is
**`@homebridge/node-pty-prebuilt-multiarch`**.

### ⚠️ Electron is pinned to 29.4.6

This machine has no C/C++ compiler or Python, so native modules can't be built
from source. `@homebridge/node-pty-prebuilt-multiarch` ships prebuilt binaries
only up to **Electron 29 (ABI v121)** for win32-x64. Bump the major and there
will be no matching `pty.node`, and the app won't load. To go newer you'd need
prebuilds for that ABI, or Python 3.12 + VS Build Tools to compile from source
(`npm run rebuild`).

After a clean `npm install` (install scripts are disabled here), fetch the
binaries manually:

```
cd node_modules\@homebridge\node-pty-prebuilt-multiarch
node ..\..\prebuild-install\bin.js --runtime electron --target 29.4.6 --arch x64
node node_modules\electron\install.js
```

Then run `Hivemind.cmd` once so `dist\Hivemind.exe` is re-linked.

### App icon

`build/icon.ico` (the honeycomb) is generated from pure Node — no image tools:

```
node scripts/generate-icon.js
```

It rasterizes at 16–256 px and packs a multi-resolution `.ico`. `main.js` uses it
for the window; electron-builder picks it up for packaged builds.
