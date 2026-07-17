---
name: verify
description: Launch an isolated Hivemind instance and drive its UI over CDP to verify renderer/main changes end-to-end.
---

# Verifying Hivemind changes live

The user's live instance is usually running (`electron "C:\Projects\hivemind"`,
userData in `%APPDATA%\hivemind`). **Never kill it.** Test runs are isolated via
`HM_USER_DATA`.

## Launch an isolated instance

1. Seed a userData dir with a `boards.json` (array of boards). Minimal board:
   `{ "id": "board-test-1", "name": "Test", "dir": "<repo under test>",
      "startupCommand": "", "resumeOnStart": false, "muted": true,
      "layout": [{ "flex": 1, "panes": [{ "name": "shell", "agent": "claude",
      "perm": "default", "fontSize": 14, "flex": 1, "view": "terminal" }] }] }`
   Empty `startupCommand` spawns plain PowerShell — no Claude session starts.
2. Launch in the background (PowerShell):
   `$env:HM_USER_DATA='<seeded dir>'; npx electron . --remote-debugging-port=9223`

## Drive it over CDP

No Playwright needed — Node 22+ has a global `WebSocket`. A working driver
script from a past session: `scratchpad/drive.mjs` pattern —
`GET http://127.0.0.1:9223/json/list`, pick the `page` target whose URL matches
`index.html`, connect to `webSocketDebuggerUrl`, then `Runtime.evaluate`
(`awaitPromise: true, returnByValue: true`) to click/read DOM, and
`Page.captureScreenshot` for evidence.

Useful DOM handles: `#git-toggle` (opens Source Control), `#git-refresh`,
`.git-counts` (↓/↑ text), `#git-msg` (commit draft), buttons inside `#git-body`
(find Pull/Push by textContent).

## Git fixtures

For remote-ahead scenarios, make a local bare repo + two clones in the
scratchpad; push from clone B so clone A's view of `origin/main` goes stale.
No network or auth involved.

## Teardown

Kill only the test instance — match on the debug port, never by name alone:
`Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -match '9223' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
Child processes (gpu/renderer) die with the main; verify the live instance
(`--user-data-dir=%APPDATA%\hivemind` in its children's command lines) survived.
