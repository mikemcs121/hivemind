# Developing & testing Hivemind

How to run, test, and safely modify Hivemind on this machine. Read this before
making any change; read the subsystem docs (see `docs/README.md`) before touching
a specific area.

## Running the app

- Dev: `npm start` (runs `electron .` from `C:\Projects\hivemind`).
- End-user launch: `Hivemind.cmd` or the Desktop shortcut — runs the bundled
  Electron runtime as `node_modules\electron\dist\Hivemind.exe`, no global Node
  needed. `Hivemind.exe` is a hard link to `electron.exe` that `Hivemind.cmd`
  (re)creates whenever it is missing or its size no longer matches. It exists so
  the app has its own image name: other hives building Electron apps kill
  Electron by name (`taskkill /IM electron.exe`, `Get-Process electron |
  Stop-Process`), and that took the live instance down twice on 2026-09-03.
- The packaged portable exe lives in `dist/` after a build (see
  `docs/build-and-release.md`).

## The user's live instance — never kill it

The user usually has a live Hivemind running (`Hivemind.exe "C:\Projects\hivemind"`,
userData in `%APPDATA%\hivemind`). **Never kill Hivemind.exe or electron.exe by
name.** Multiple
Hivemind threads (the user's own agents) may also be editing this repo in
parallel — check `git status` and file mtimes, and re-read files between your
edits so you don't clobber concurrent changes.

## Isolated test instances (HM_USER_DATA)

Test runs are isolated from the live instance via the `HM_USER_DATA` env var,
which overrides Electron's userData directory:

1. Seed a userData dir containing a `boards.json` (array of boards). For a shell-only fixture, set
   `startupCommand` to `powershell -NoLogo`; an empty startup command defaults
   to Claude.
2. Launch: `$env:HM_USER_DATA='<seeded dir>'; npx electron . --remote-debugging-port=9223`
3. Drive it over CDP (no Playwright needed — Node 22+ has global `WebSocket`):
   `GET http://127.0.0.1:9223/json/list`, connect to the `page` target matching
   `index.html`, then `Runtime.evaluate` / `Page.captureScreenshot`.
4. Teardown: kill only processes whose command line matches the debug port
   (`9223`), never by process name alone.

The project skill `.agents/skills/verify/SKILL.md` documents this flow in full,
including useful DOM handles and git fixtures. Prefer invoking that skill.

## Simulating a first run (what a new user sees)

Every scrap of per-user state lives in the userData dir — `boards.json`,
`publish.json`, `codex-accounts.json`, `codex-homes/`, downloaded STT models,
and the Local Storage that backs every `hm.*` preference (theme, font size,
default model/permission, voice settings). So "a brand-new user" is just an
empty userData dir, which is what `scripts/fresh-run.js` arranges:

- `npm run fresh` (or double-click **`Fresh Hivemind.cmd`**, which runs the
  script under the bundled Electron in Node mode — no global Node needed)
  wipes a throwaway profile under `%TEMP%\hivemind-fresh\default` and launches
  Hivemind against it. You land on the **setup wizard** (`#setup-backdrop`) over
  `#empty-state`, with no hives and no saved settings.

  The wizard reads *this machine*, not the profile: `agents:detect` reports which
  agent CLIs are installed and signed in for the real user, so a fresh profile on
  a developer box shows Claude/ChatGPT already green. To exercise the "not
  installed" branch, pick an agent you don't have (Gemini or Grok here).
  `hm.setupDone` lives in the profile's Local Storage, so every wipe brings the
  wizard back — and `--keep` is how you check the second run, where it must
  **not** appear.
- `--keep` relaunches the same profile instead of wiping it — that's the
  *second* run, for checking what persists after a new user sets things up.
  (Through npm, flags need the separator: `npm run fresh -- --keep`.)
- `--profile <name>` / `--dir <path>` for independent or explicitly-placed
  profiles; `--sample-project` also creates an empty, non-Git project folder so
  the first hive points at virgin ground rather than a repo that already has a
  `.hivemind/` folder (plans, prompt history) in it.
- `--debug[=port]` adds `--remote-debugging-port` so the `verify` flow above can
  drive the first-run window over CDP; `--detach` launches and returns.

Safety and identification:

- A profile is only ever deleted if it is empty or carries the
  `.hivemind-fresh-profile` marker this script writes — a mistyped `--dir`
  pointing at `%APPDATA%\hivemind` refuses instead of destroying real hives.
- The instance runs as `electron.exe` with an `--hm-fresh` marker argument, so
  it is distinguishable from both the live `Hivemind.exe` and other hives' test
  Electrons. Tear it down by matching that marker, never by name:
  `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -match 'hm-fresh' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
- The script strips `CLAUDECODE` / `CLAUDE_CODE_*` from the child env (see the
  pitfall below), and `ELECTRON_RUN_AS_NODE` so the `.cmd` path still starts a
  GUI.

Bundled models are *not* per-user state: `models/` ships inside the app and the
`hm://models` handler falls back to it, so a fresh profile still sees whatever a
packaged install would ship with.

### Verification pitfalls (these cost real time)

- **Renderer changes** need a window reload; **main-process changes** (main.js,
  transcript.js, git.js, etc.) need a full app relaunch.
- Launching a test Electron **from inside a Claude Code session** leaks
  `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, and
  `CLAUDE_CODE_ENTRYPOINT` into the thread PTYs. A nested `claude` then runs as
  a child session and writes **no transcript at all** — which looks exactly like
  a transcript-binding bug. Scrub those env vars before launching.
- Transcript timing varies by Claude version: older releases deferred pending
  tool messages until resolution; 2.1.261 can write AskUserQuestion before it is
  answered. Verify both orderings, and use a real CLI for menu interaction tests.

### Chat regression checks

Run `node --test scripts/test-chat.cjs` for composer/submission guards and early
question-transcript timing, and `node --test scripts/test-file-mentions.cjs` for
the `@`-mention file index and its fuzzy ranking. Live verification results and limits are recorded in
`docs/chat-verification.md`; use an isolated profile for those tests.

## Toolchain constraints (why Electron is pinned)

This machine has **no C/C++ compiler and no Python**, so native modules cannot
be compiled from source:

- PTY backend is `@homebridge/node-pty-prebuilt-multiarch` (prebuilt binaries),
  which supports up to **Electron 29 (ABI v121)** on win32-x64. **Electron is
  pinned to 29.4.6 for this reason.** Do not bump Electron majors unless
  prebuilds exist for the new ABI or build tools have been installed.
- npm install scripts are disabled here; after a clean `npm install`, prebuilt
  binaries must be fetched manually:
  - PTY: `cd node_modules\@homebridge\node-pty-prebuilt-multiarch` then
    `node ..\..\prebuild-install\bin.js --runtime electron --target 29.4.6 --arch x64`
  - Electron itself: `node node_modules\electron\install.js`, then run
    `Hivemind.cmd` once so `dist\Hivemind.exe` is re-linked to the new binary

## Project conventions

- **Help modal sync rule (from AGENTS.md):** any change to a user-facing
  feature, shortcut, or button must update `#help-modal` in `src/index.html` in
  the same change. The change isn't done until the Help modal matches.
- **Version bump rule:** always bump `package.json` version before building a
  portable exe — the artifact name embeds the version.
- Docs in `docs/` are the map for future agents. **If your change makes a doc
  wrong, fix the doc in the same change.** Line numbers in docs drift; treat
  function/variable names as the stable anchors.

## App icon

`build/icon.ico` (honeycomb) is generated by `node scripts/generate-icon.js` —
pure Node, no image tools. It writes a multi-resolution .ico plus
`build/icon-256.png`. `main.js` uses it for the window; electron-builder picks
it up for packaged builds.
