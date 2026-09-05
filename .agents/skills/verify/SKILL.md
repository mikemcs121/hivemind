---
name: verify
description: Launch an isolated Hivemind instance and drive its UI over CDP to verify renderer/main changes end-to-end.
---

# Verifying Hivemind changes live

Use any agent's shell and UI inspection tools. Run commands from the repository
root. Read `docs/development.md` for toolchain and environment details.

The user's live instance is usually running as `Hivemind.exe` (a hard link to
the bundled Electron, userData in `%APPDATA%\hivemind`). Never kill it, and never
kill Hivemind.exe or electron.exe by name. Isolate tests via `HM_USER_DATA`.

## Launch an isolated instance

Choose a unique test profile and an unused debugging port so concurrent tests
do not share state or processes. The examples below use port 9223.

1. Seed a test userData directory with a `boards.json` (array of boards):
   `{ "id": "board-test-1", "name": "Test", "dir": "<repo under test>",
      "startupCommand": "powershell -NoLogo", "resumeOnStart": false, "muted": true,
      "layout": [{ "flex": 1, "panes": [{ "name": "shell", "agent": "claude",
      "perm": "default", "fontSize": 14, "flex": 1, "view": "terminal" }] }] }`
   The explicit shell startup command avoids starting an agent. The `agent`
   value here is Hivemind's pane metadata, not a requirement to use Claude.
   An empty startup command defaults to Claude and is not a shell-only fixture.
2. Launch from PowerShell in the repository root:

   ```powershell
   $env:HM_USER_DATA = '<seeded test directory>'
   Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
   Get-ChildItem Env: | Where-Object {
     $_.Name -eq 'CLAUDECODE' -or $_.Name -like 'CLAUDE_CODE_*'
   } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
   $testApp = Start-Process -FilePath '.\node_modules\electron\dist\electron.exe' -ArgumentList '.', '--remote-debugging-port=9223' -WindowStyle Hidden -PassThru
   ```

   Keep the returned PID for teardown. The environment cleanup prevents a
   verification run launched from an agent session from inheriting its runtime
   mode or Claude session identity.

## Or: a first-run instance (no seeding)

To test the setup wizard over the empty state, run
`node scripts/fresh-run.js --profile <unique-test-name> --debug=9223 --detach`.
Add `--sample-project` for a virgin project directory or `--keep` to reuse that
profile. The helper resets its marked throwaway profile, scrubs the environment,
and launches with an `--hm-fresh` marker. See `docs/development.md`.

## Drive it over CDP

Use an available CDP client, or Node 22+ with its global `WebSocket`:
`GET http://127.0.0.1:9223/json/list`, select the `page` target whose URL matches
`index.html`, and connect to `webSocketDebuggerUrl`. Use `Runtime.evaluate`
(`awaitPromise: true, returnByValue: true`) to click/read the DOM, and
`Page.captureScreenshot` for visual evidence. Check both visible behavior and
the relevant underlying state; report what was actually exercised.

Useful DOM handles: `#git-toggle`, `#git-refresh`, `.git-counts`, `#git-msg`,
and buttons inside `#git-body` (find Pull/Push by textContent).

## Git fixtures

For remote-ahead scenarios, make a local bare repo and two clones in a test
directory. Push from clone B so clone A's view of `origin/main` goes stale.
No network or authentication is needed.

## Teardown

Stop only the test process you launched. Before stopping a saved PID, verify
its command line still identifies your instance (the unique debugging port or
profile). For a port-9223 instance:

```powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -match '--remote-debugging-port=9223(\s|$)' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Use your chosen port in that filter. Verify the user's live Hivemind instance
survived. Remove only test artifacts that this run owns, if cleanup is needed.
