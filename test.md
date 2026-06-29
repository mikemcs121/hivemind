# Screenshot Paste — Troubleshooting

How pasting a screenshot into a terminal pane is supposed to work, and what to
check if it doesn't.

## How it works

Claude Code in a terminal can't take an inline image — it reads an image **file
path** from the prompt. So when you paste a screenshot, the app:

1. Catches the `paste` event on the pane (`src/renderer.js`, the
   `termWrap.addEventListener('paste', ...)` handler).
2. Gets the image either from the `DataTransfer` file, or — for a raw bitmap like
   Win+Shift+S — from the native clipboard via `window.api.clipboardImage()`
   (`image:fromClipboard` IPC in `main.js`).
3. Saves it to a temp PNG and types that path into the prompt.

So you'll see a **file path appear**, not a thumbnail. That's expected.

## First thing to try

**Fully quit and restart the app.** Electron does not hot-reload — code changes
to `main.js` / `preload.js` / `src/renderer.js` only take effect after restart.

```
npm start
```

## Known issue: Ctrl+V vs. right-click

If **right-click → Paste works but Ctrl+V does nothing**, that's the bug fixed in
`src/renderer.js`: by default xterm swallows Ctrl+V as the control character `^V`
(0x16) and `preventDefault`s it, so the browser never fires a `paste` event and
the pane's paste handler never runs. Right-click → Paste uses Electron's native
paste role, which *does* fire a real `paste` event, so only that path worked.

The pane now installs `term.attachCustomKeyEventHandler(...)` to let the browser
paste natively on Ctrl+V. As always, **fully restart** the app to pick this up.

## Checklist if it still doesn't work

- [ ] **Click into the pane first.** The terminal must be focused when you press
      Ctrl+V (or right-click → Paste). If focus is on a dialog or nothing,
      the paste won't reach the terminal.
- [ ] **Confirm there's actually an image on the clipboard.** Re-take the
      screenshot (Win+Shift+S), then paste.
- [ ] **Open DevTools** (View menu or Ctrl+Shift+I) and check the Console for
      errors like `Could not persist pasted image` or
      `Failed to read clipboard image`.
- [ ] **Try both paste methods:** Ctrl+V and right-click → Paste. Both fire the
      same handler.
- [ ] **Try drag-and-drop instead** — drag an image file onto the pane. If that
      works but paste doesn't, the issue is clipboard-specific.

## Quick clipboard sanity check

Confirms the OS clipboard actually holds an image and Electron can read it:

```bash
node_modules/.bin/electron -e "const{app,clipboard}=require('electron');app.whenReady().then(()=>{const i=clipboard.readImage();console.log('formats',clipboard.availableFormats(),'empty?',i.isEmpty());app.quit();})"
```

Expect to see `image/png` in the formats and `empty? false`.

## Relevant code

- `src/renderer.js` — `paste` / `drop` handlers, `persistImage`, `typePathIntoPane`
- `preload.js` — `saveTempImage`, `clipboardImage` bridge
- `main.js` — `image:saveTemp` and `image:fromClipboard` IPC handlers
