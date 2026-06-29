# Hivemind

Electron app for running multiple Claude threads ("hives") against project directories.

- `main.js` — Electron main process
- `preload.js` — context bridge
- `src/index.html`, `src/renderer.js`, `src/styles.css` — UI
- `git.js`, `files.js` — Git and filesystem helpers

## Keep the Help modal in sync

The app has an in-app Help modal in `src/index.html` (`#help-modal`, the `.help-list` / `.help-note`
content). It documents getting-started steps, threads & broadcast, keyboard shortcuts, and settings.

**Whenever you add, remove, or change a user-facing feature, keyboard shortcut, or button, update the
Help modal to match in the same change.** This includes:

- New buttons/controls in the toolbar or thread headers
- New or changed keyboard shortcuts (keep the `Shortcuts` list accurate)
- New broadcast/voice/settings behavior

If a change makes the Help modal inaccurate, the change isn't done until the Help modal is updated.
