# Hivemind architecture overview

Hivemind is a Windows Electron app that runs a swarm of Claude Code (and Codex)
threads in tiled terminal panes, organized into boards where each board is tied
to one project directory. This doc is the top-level map; each subsystem has its
own deep doc (see `docs/README.md` for the index and routing table).

> Line numbers cited anywhere in `docs/` drift as the code changes. Treat
> function/variable names as the stable anchors and line numbers as hints.

## Process model

Two processes, strictly separated:

- **Main process** (`main.js` + helper modules at repo root): window lifecycle,
  PTY spawning via node-pty/ConPTY, all filesystem and git access, transcript
  tailing, model downloads, packaging, auto-update. The renderer is fully
  sandboxed — no Node access, no navigation, no child windows.
- **Renderer** (`src/renderer.js`, one ~10,000-line file, plus `src/index.html`
  and `src/styles.css`): all UI — boards, the split-grid of xterm.js terminals,
  the chat view, source control, plan review, voice typing, settings.

Everything crosses the boundary through `preload.js`'s context bridge
(`window.api.*`), which maps 1:1 onto IPC channels registered in `main.js`.
A dedicated web worker (`src/voice-worker.js`) runs speech-to-text off the UI
thread.

## The core object: a pane (thread)

A **board** owns a project directory and a **grid** of **panes**. Each pane is
one agent thread:

- Main spawns a shell PTY in the board's directory, waits ~600 ms, then *types*
  a composed command (e.g. `claude --session-id <uuid>`) into it — the agent is
  never exec'd directly, so anything needed at startup must ride that command
  string.
- The renderer renders the PTY through xterm.js and runs a status state machine
  over the visible screen (working / needs you / ready / exited) that drives
  pane dots, board badges, and notifications.
- Because Claude is started with an explicit `--session-id`, the pane's chat
  view binds deterministically to its session JSONL under
  `~/.claude/projects/<encoded-dir>/`; `transcript.js` (main process) tails it
  and streams normalized entries back. Heuristic binding remains as fallback
  and for Codex.
- A pane can show either the raw terminal or the **chat view** (a rendered
  conversation with a composer); the chat view covers the terminal, it never
  replaces it — the PTY is always the delivery path for prompts.

## Subsystems at a glance

| Subsystem | Files | Deep doc |
|---|---|---|
| Main process, IPC hub, PTYs, security | `main.js`, `preload.js` | `docs/main-process.md` |
| All UI (boards, panes, chat, modals, shortcuts) | `src/renderer.js`, `src/index.html`, `src/styles.css` | `docs/renderer.md` |
| Git panel + file explorer backends | `git.js`, `files.js` | `docs/git-and-files.md` |
| Per-project sidecars: plans, todos, prompt history, transcripts, usage | `plan.js`, `todo.js`, `promptHistory.js`, `transcript.js`, `usage.js` | `docs/sidecar-modules.md` |
| Voice typing (offline STT) | `src/voice-worker.js`, `scripts/fetch-model.mjs`, `models/` | `docs/voice-dictation.md` |
| Build, packaging, releases, auto-update | `build.js`, `updater.js`, `scripts/before-build.js`, package.json `build` | `docs/build-and-release.md` |
| Dev environment, live testing, toolchain pins | — | `docs/development.md` |

## IPC surface (grouped)

The complete channel-by-channel table lives in `docs/main-process.md`. Groups:

- `boards:*` — board persistence (boards.json in userData)
- `pty:*` — spawn/write/resize/kill + `pty:data`/`pty:exit` pushes
- `git:*`, `gh:*`, `hm:interpret` — source control (see `docs/git-and-files.md`)
- `files:*`, `watch:set`/`fs:changed` — file explorer + live refresh
- `plan:*`, `todo:*`, `promptHistory:*`, `usage:get` — sidecars
- `transcript:*` + `transcript:entries`/`transcript:status` pushes — chat view
- `stt:ensureModel`/`stt:downloadProgress` — voice model downloads; `stt:nativeLoad`/`stt:nativeTranscribe`/`stt:nativeStop` — the sherpa-onnx native speech engine (`stt-native.js` utility process)
- `build:*` — in-app portable build
- `dialog:*`, `image:*`, `attach:stage`, `notify`, `open:external`,
  `focus-pane` — shell/UX plumbing
- `spell:correct` — **synchronous** IPC (autocorrect); must always set
  `event.returnValue`

## Where data lives

| Location | Contents |
|---|---|
| userData (`%APPDATA%\hivemind`, or `HM_USER_DATA` override) | `boards.json` (boards + layouts), downloaded STT models under `models/` |
| `<project>\.hivemind\` | per-project sidecars: `todos.json`, `prompt-history.json`, `plans/` (`kanban.json` is legacy — nothing reads it) |
| `~/.claude/projects/<encoded-dir>/*.jsonl` | Claude Code session transcripts (read-only input to the chat view) |
| `~/.codex/sessions/YYYY/MM/DD/` | Codex rollouts (same role for Codex panes) |
| `models/` (repo / asar-unpacked) | bundled Moonshine + Silero VAD ONNX models |
| `dist/` | build artifacts (`Hivemind <ver> portable.exe`) |

## Cross-cutting invariants (the "do not break" list)

1. **Help modal sync:** any user-facing feature/shortcut/button change must
   update `#help-modal` in `src/index.html` in the same change (CLAUDE.md
   rule). Exception: `#hm-cmd-list` is auto-generated from `HM_COMMANDS`.
2. **The user's live instance is usually running — never kill electron.exe by
   name.** Isolate tests with `HM_USER_DATA` (see `docs/development.md`).
3. **Renderer reload vs full relaunch:** main-process files (main.js,
   transcript.js, git.js, …) only take effect after a full app relaunch.
4. **Mis-bound transcript ≠ mis-delivered prompt.** Prompt delivery goes
   through the PTY; the chat view is a display layered on top.
5. **Security guards are load-bearing:** sandboxed renderer, regex-validated
   values spliced into PTY command strings, `safeRef`/`--` argument-injection
   guards in git.js, no `innerHTML` for user/agent text.
6. **Concurrent writers:** the user's own agent threads edit this repo and the
   `.hivemind/` JSON files in parallel — atomic writes, per-file locks, and the
   unreadable-vs-empty distinction in todo.js/promptHistory.js exist for this;
   re-read files between your own edits too.
7. **Electron is pinned to 29.4.6** (node-pty prebuilt ABI ceiling; no compiler
   on this machine). Don't bump majors casually.
8. **Version bump before any portable build**; the GitHub repo
   (mikemcs121/hivemind) must stay public or auto-update dies. Use the
   `release` skill.
9. **Packaged-path discipline:** any fs-read asset must be in `asarUnpack`;
   models resolve over the `hm://` protocol; SharedArrayBuffer switches are set
   before app ready — losing them silently degrades the voice worker.
10. **Keep `docs/` truthful:** if your change makes any doc here wrong, fix the
    doc in the same change.
