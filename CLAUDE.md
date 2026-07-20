# Hivemind

Electron app for running multiple Claude threads ("hives") against project directories.

- `main.js` — Electron main process
- `preload.js` — context bridge
- `src/index.html`, `src/renderer.js`, `src/styles.css` — UI
- `git.js`, `files.js` — Git and filesystem helpers

## Read the docs before touching code

`docs/` documents every subsystem for agents. **Before modifying a file, read
`docs/README.md`** — its routing table maps each area of the code to the doc
that explains it (architecture, IPC channels, renderer file map, transcript
binding, voice pipeline, build/release, testing). Rules that apply to every
change:

- If your change makes a doc in `docs/` inaccurate, update the doc in the same change.
- Never kill the user's live Hivemind instance; test with an isolated
  `HM_USER_DATA` instance (see the `verify` skill and `docs/development.md`).
- Main-process changes (main.js, transcript.js, git.js, …) need a full app
  relaunch to take effect; renderer changes need a window reload.
- Other agent threads may edit this repo concurrently — check `git status` and
  re-read files before editing.
- Releases: follow the `release` skill (bump version first; see
  `docs/build-and-release.md`).

## Keep the Help modal in sync

The app has an in-app Help modal in `src/index.html` (`#help-modal`, the `.help-list` / `.help-note`
content). It documents getting-started steps, threads, keyboard shortcuts, and settings.

**Whenever you add, remove, or change a user-facing feature, keyboard shortcut, or button, update the
Help modal to match in the same change.** This includes:

- New buttons/controls in the toolbar or thread headers
- New or changed keyboard shortcuts (keep the `Shortcuts` list accurate)
- New voice/settings behavior

If a change makes the Help modal inaccurate, the change isn't done until the Help modal is updated.
