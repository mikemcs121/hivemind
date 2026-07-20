# Hivemind docs — read this first

These docs exist so any agent (or human) can develop Hivemind without
re-deriving the codebase. Start with `ARCHITECTURE.md`, then read the one
subsystem doc that covers the files you're about to touch.

> Line numbers in these docs drift; function/variable names are the stable
> anchors. **If your change makes a doc wrong, fix the doc in the same change.**

## Routing table — "I need to touch X, what do I read?"

| If your task involves… | Read | Key files |
|---|---|---|
| Anything (always) | `ARCHITECTURE.md` + `development.md` | — |
| Windows, PTYs, IPC channels, security, userData, spawning agents | `main-process.md` | `main.js`, `preload.js` |
| Any UI: boards, panes, chat view, status dots, modals, shortcuts, settings, themes | `renderer.md` | `src/renderer.js`, `src/index.html`, `src/styles.css` |
| Source Control panel, diffs, commits, push/pull, GitHub wizard, file explorer | `git-and-files.md` | `git.js`, `files.js` |
| Chat-view transcripts, session binding, plans, todos, prompt history, usage pill | `sidecar-modules.md` | `transcript.js`, `plan.js`, `todo.js`, `promptHistory.js`, `usage.js` |
| Voice typing, STT models, mic/VAD, Settings → Voice | `voice-dictation.md` | `src/voice-worker.js`, `scripts/fetch-model.mjs` |
| Building, packaging, releasing, auto-update | `build-and-release.md` | `build.js`, `updater.js`, `scripts/before-build.js` |
| Running/testing the app, dev pitfalls, Electron pin | `development.md` | — |

## Procedures (project skills, in `.claude/skills/`)

- **verify** — launch an isolated Hivemind instance (`HM_USER_DATA`) and drive
  its UI over CDP to verify changes end-to-end. Use for any non-trivial
  renderer/main change.
- **release** — the exact ordered checklist to cut and publish a portable
  release.

## Non-negotiable project rules

1. Update `#help-modal` in `src/index.html` in the same change as any
   user-facing feature/shortcut/button change.
2. Never kill the user's live Hivemind instance; isolate tests with
   `HM_USER_DATA`.
3. Bump `package.json` version before building a portable exe.
4. Main-process changes need a full app relaunch to test; renderer changes need
   a window reload.
5. Other agent threads edit this repo concurrently — check `git status` and
   re-read files before editing.
