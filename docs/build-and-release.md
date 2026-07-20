# Build, Packaging, Release, and Auto-Update

## Purpose

This document explains how Hivemind is built into distributable Windows binaries, how a
release is cut and published to GitHub, and how already-deployed portable copies update
themselves. Read it before touching `build.js`, `updater.js`, `scripts/before-build.js`,
`scripts/fetch-model.mjs`, `scripts/generate-icon.js`, or the `build` section of
`package.json`. The unusual part of this app: it can **build and publish itself** from its
own toolbar (Settings → General → "Build portable copy"), so the build pipeline runs both
from the command line (`npm run dist`) and from inside the packaged app's main process.

## Build pipeline

### npm scripts (`package.json:6-12`)

| Script | Command | What it does |
|---|---|---|
| `start` | `electron .` | Run the app from source (dev mode). |
| `rebuild` | `electron-rebuild -f -w @homebridge/node-pty-prebuilt-multiarch` | Recompile node-pty against the installed Electron ABI. Requires a C++ toolchain + Python — **not present on the primary dev machine** (see Native modules). |
| `fetch-model` | `node scripts/fetch-model.mjs` | Download the bundled speech models into `models/`. Fails loudly on network errors. |
| `postinstall` | `node scripts/fetch-model.mjs --soft` | Same download after `npm install`, but never fails the install (offline/CI safe). |
| `dist` | `electron-builder` | Full packaged build: NSIS installer + portable exe. |

### `scripts/fetch-model.mjs`

Downloads two model sets from Hugging Face into `models/` at the repo root:
`onnx-community/moonshine-base-ONNX` (speech-to-text; config/tokenizer JSON + two
q8-quantized `.onnx` graphs) and `onnx-community/silero-vad` (voice activity detection;
also generates a minimal `config.json` locally because the HF repo ships none,
`fetch-model.mjs:58-64`). Files already present are skipped, so re-runs are cheap.
`--soft` mode (postinstall) exits 0 on failure; plain mode (used by the beforeBuild hook)
exits 1.

### `scripts/before-build.js` — the electron-builder `beforeBuild` hook

Registered at `package.json:34` (`"beforeBuild": "./scripts/before-build.js"`). Runs
before **every** packaging build — both `npm run dist` and the in-app Build Portable
button. This matters: the in-app path (`build.js`) invokes the electron-builder CLI
directly, bypassing npm lifecycle scripts, so a `predist` npm hook would NOT fire there;
only a build-config hook covers both. It runs `fetch-model.mjs` in hard-fail mode and
throws if the model can't be fetched, so a build never silently ships without voice
models. It returns `true` so electron-builder continues its normal dependency handling
(`before-build.js:27`).

### `scripts/generate-icon.js`

Pure-Node icon generator (no native image libs): rasterizes the honeycomb logo with 4x
supersampling, hand-encodes PNGs via zlib, and packs a multi-resolution Vista-style
`.ico`. Writes `build/icon.ico` (16–256 px) and `build/icon-256.png`. Run manually with
`node scripts/generate-icon.js` only when the logo changes; the outputs are checked in
and consumed by electron-builder (`package.json:47`) and the window icon in `main.js`.

### `build.js` — the in-app portable-build backend (main process module)

Not a CLI script; it is `require`d by `main.js:110` and driven by the
`build:portable` IPC handler (`main.js:892-930`). Step by step, per function:

1. `isHivemindProject(cwd)` (`build.js:33`) — gates the toolbar button: true only when
   the hive's directory has `package.json` with `name: "hivemind"` or
   `build.appId === "com.mikem.hivemind"`.
2. `checkGhReady(cwd)` (`build.js:206`) — preflight `gh auth status` **before** anything
   irreversible; a publish failure discovered after the version bump was pushed would
   leave the repo ahead of the newest release forever.
3. `bumpPatchVersion(cwd)` (`build.js:182`) — patch-bumps `package.json` version with a
   minimal string edit (formatting untouched), returns `{ version, prevRaw }` so a failed
   build can restore the file exactly (`restoreVersion`, `build.js:196`). Failed builds
   therefore do not burn version numbers.
4. `buildPortable(cwd, onProgress)` (`build.js:77`) — resolves the project-local
   electron-builder CLI (`resolveBuilderCli`, `build.js:44`) and runs it with a **real
   Node** (`resolveNode`, `build.js:69` — `npm_node_execpath` or `node` on PATH), never
   Electron-as-Node, because Electron's loader dies with `ERR_REQUIRE_ESM` on
   electron-builder's ESM deps. Runs `node <cli> --win portable`. On failure the full log
   is written to `dist/portable-build.log` (`build.js:127`).
5. `publishRelease(cwd, version, onProgress)` (`build.js:220`) — verifies
   `dist/Hivemind ${version} portable.exe` exists, commits **only** `package.json`
   (pathspec-limited, so concurrently staged files from other Hivemind threads aren't
   swept in — `build.js:232`), pushes (both best-effort), then
   `gh release create v${version} <exe> --title "Hivemind v${version}"`.

Progress lines stream over the `build:progress` IPC channel (`main.js:897`,
`preload.js:176`) into the Settings button, which maps electron-builder log lines to
stage labels (`src/renderer.js:5436`). Renderer entry points: the button itself and the
"build the portable app" voice/command pattern (`src/renderer.js:1788`, `5464`). A
`buildRunning` flag in `main.js:289` prevents concurrent builds.

### electron-builder config (`package.json:30-52`)

| Key | Value | Why |
|---|---|---|
| `appId` | `com.mikem.hivemind` | Also used by `isHivemindProject` as a fallback identity check. |
| `npmRebuild` | `false` | Never try to compile native modules during packaging — the dev machine has no toolchain; prebuilt binaries are used as-is. |
| `beforeBuild` | `./scripts/before-build.js` | Model download guard (above). |
| `files` | `**/*` | Whole repo goes into `app.asar` (no pruning). |
| `asarUnpack` | `models/**`, `node_modules/@huggingface/transformers/dist/**` | These are served to the renderer via the `hm://` protocol handler (`main.js:41-103`), which resolves real paths and streams them with `net.fetch(file://…)` — they must exist as real files on disk, not asar entries. |
| `win.target` | `nsis`, `portable` | `npm run dist` makes both; the in-app button builds `--win portable` only. |
| `win.icon` | `build/icon.ico` | Generated by `scripts/generate-icon.js`. |
| `portable.artifactName` | `${productName} ${version} portable.exe` | **The version is baked into the filename** — e.g. `Hivemind 0.1.15 portable.exe`. The updater parses versions out of this exact pattern. |

Artifacts land in `dist/`: `Hivemind <ver> portable.exe` (portable),
`Hivemind <ver>.exe` (NSIS installer, `npm run dist` only), `win-unpacked/` (raw app),
`builder-effective-config.yaml`, and on in-app build failures `portable-build.log`.

## Native modules

- **`@homebridge/node-pty-prebuilt-multiarch`** (the ConPTY backend, loaded at
  `main.js:104`): ships **prebuilt** binaries, but only up to **Electron 29 / ABI v121**
  for win32-x64. This is why Electron is pinned to `^29.4.6`. The dev machine has no
  C/C++ compiler or Python, so `npm run rebuild` (electron-rebuild) cannot actually work
  there; instead the prebuilt binary is fetched with
  `node node_modules\prebuild-install\bin.js --runtime electron --target 29.4.6 --arch x64`
  run inside `node_modules\@homebridge\node-pty-prebuilt-multiarch` (README.md:78-102 —
  npm install scripts are disabled in this environment, so this is a manual step after a
  clean `npm install`). If the binary is missing or built for the wrong ABI, `require`
  of `pty.node` fails at startup and no terminal can spawn — the app is dead on arrival.
- **`sherpa-onnx-node`**: listed in `dependencies` (`package.json:23`) but currently
  **not referenced anywhere in app code** (voice typing runs Moonshine via
  transformers.js/WASM in `src/voice-worker.js` instead). It ships its own prebuilt
  binaries; with `npmRebuild: false` electron-builder just bundles whatever is in
  `node_modules`. Treat it as inert unless someone wires it up; do not "clean it up"
  without checking with the user.
- **What breaks if you skip the rules**: enabling `npmRebuild` or bumping Electron past
  29 makes electron-builder (or runtime loading) look for binaries that don't exist and
  cannot be compiled locally. Symptom: build fails in "Preparing", or the packaged app
  crashes on launch loading `pty.node`.

## Release procedure

The in-app button does all of this automatically (bump → build → publish). Manual
equivalent, in order:

1. Ensure `gh` CLI is installed and signed in (`gh auth status`).
2. **Bump `package.json` version first** (patch bump, e.g. 0.1.15 → 0.1.16). The
   portable artifact name and the updater's version comparison both come from this
   field. Building without bumping overwrites/duplicates an existing version and the
   updater will never offer it.
3. Build: `npm run dist` (both targets) or `npx electron-builder --win portable`
   (portable only). `beforeBuild` fetches models automatically.
4. Artifacts land in `dist/`: `Hivemind <ver> portable.exe` (+ `Hivemind <ver>.exe`
   installer if NSIS ran).
5. Commit the version bump (only `package.json`) and push:
   `git commit -m "Bump version to <ver>" -- package.json && git push`.
6. Publish: `gh release create v<ver> "dist/Hivemind <ver> portable.exe" --title "Hivemind v<ver>" --notes "..."`
   on the **public** repo `mikemcs121/hivemind`.

What the updater expects from a release:

- **Tag**: `vX.Y.Z` (a leading `v` is stripped before comparison, `updater.js:29`).
- **Asset**: any name matching `/portable/i` and ending `.exe` is accepted for download
  (`updater.js:163`), but for the on-disk cleanup logic the canonical pattern is
  `^hivemind[ .]X.Y.Z[ .]portable.exe$` (`updater.js:26`) — GitHub replaces spaces with
  dots in asset URLs, so both `Hivemind 0.1.7 portable.exe` and
  `Hivemind.0.1.7.portable.exe` match. Do not rename artifacts.
- The **latest** release (GitHub's `/releases/latest`) must be the newest version; the
  updater checks only that endpoint.

## Auto-updater (`updater.js`)

- **Trigger**: exactly once, at startup, from `app.whenReady()` (`main.js:935`). There is
  no cadence/polling and no manual "check for updates" UI. It runs **only** in the
  portable build: electron-builder's portable launcher sets `PORTABLE_EXECUTABLE_FILE`,
  and `checkForUpdates` returns immediately if it's absent (`updater.js:151`) — so dev
  runs and the NSIS install never self-update.
- **Check**: GETs `https://api.github.com/repos/mikemcs121/hivemind/releases/latest`
  (unauthenticated — this is why the repo must be public), 5s timeout, follows
  redirects (`updater.js:80-96`). Compares `tag_name` against `app.getVersion()` with a
  numeric three-part semver compare (`isNewer`, `updater.js:28`).
- **UI surface**: native `dialog.showMessageBox` prompts owned by the main process —
  "Update Available" (Update Now / Later), plus error dialogs. Nothing in the renderer;
  no IPC. The renderer only receives the current version via the
  `--hm-app-version` argument for display in Settings (`main.js:305-310`).
- **Download/swap** (`updater.js:187-268`): downloads the asset to
  `Hivemind <ver> portable.exe.part` next to the running exe (HTTPS-only, redirect-safe,
  120s stall guard), verifies the byte size against the GitHub asset's reported `size`
  (catches proxy-truncated 200s), renames `.part` to the final name, then spawns the new
  exe detached. Deleting the old exe is gated on the child's `spawn` event actually
  firing — a corrupt or AV-quarantined download keeps the old copy and shows an error
  instead. Cleanup of the old exe (locked until this process exits) is done by a
  self-deleting batch file in temp that retries `del` for ~30s (`ping` as the delay,
  because `timeout` needs console input; `updater.js:246-261`), then `app.quit()` with a
  5s `app.exit(0)` failsafe because node-pty's ConPTY children can keep the process
  alive holding the file lock.
- **Startup hygiene**: every portable launch first runs `cleanupStaleExes`
  (`updater.js:58`) — deletes older-versioned sibling exes and orphaned `.part` files,
  so a previously failed cleanup heals on the next run.
- All check-phase errors (offline, rate-limited, bad JSON) are silently swallowed
  (`updater.js:277`); errors after the user clicked "Update Now" get a dialog.

## Invariants & gotchas

- **Bump the version before every portable build.** The artifact name embeds it; the
  updater compares it; publishing a rebuilt exe under an old version is invisible to
  clients. The in-app flow does this for you (and restores on build failure); manual
  builds must not forget.
- **The releases repo must stay public.** The updater calls the GitHub API with no
  token; a private repo returns 404 and every client silently stops updating.
- **Portable vs NSIS**: only the portable exe self-updates (`PORTABLE_EXECUTABLE_FILE`
  gate). The NSIS installer is produced by `npm run dist` but is not published by the
  in-app flow and has no update channel. The portable launcher also extracts to a temp
  dir at each run — `process.execPath` is NOT the user-visible exe; always use
  `PORTABLE_EXECUTABLE_FILE` for anything touching the real file.
- **Dev vs packaged paths**: in dev, `__dirname` is the repo root; packaged, it is
  inside `app.asar`. `models/**` and the transformers `dist/**` work in both only
  because they are `asarUnpack`ed (Electron's fs shim redirects to
  `app.asar.unpacked`). Anything new the `hm://` handler must serve, or any native
  binary loaded by absolute path, needs adding to `asarUnpack`.
- **Never run electron-builder under Electron-as-Node** — `ERR_REQUIRE_ESM`
  (`build.js:62-73`). `build.js` deliberately strips `ELECTRON_RUN_AS_NODE` and resolves
  a real Node.
- **`npmRebuild` must stay `false`** and Electron stays pinned to 29.x until node-pty
  ships newer prebuilds or a compiler toolchain is installed (README.md:78-91).
- The in-app publish commits **only `package.json`** by pathspec — preserve that when
  editing `publishRelease`; other Hivemind threads edit this repo concurrently and a
  bare `git commit -a` would sweep their staged work into the release commit.
- `updater.js` exports `findOlderExes` for reuse/tests; keep `PORTABLE_EXE_RE`
  (`updater.js:26`) in sync with `portable.artifactName` if either ever changes — it must
  match both the space-separated local filename and the dot-separated GitHub asset name.

## How to extend

**Change an update behavior** (e.g. add a periodic re-check or a "skip this version"
option): all logic lives in `updater.js` — it has no renderer/IPC surface, so UI is
native dialogs only. For a re-check, call `updater.checkForUpdates(mainWindow)` again
from `main.js` (e.g. a `setInterval` after `main.js:935`), but keep the
`PORTABLE_EXECUTABLE_FILE` guard and make sure a second prompt can't stack on an
in-flight download (add a module-level in-progress flag). If you change dialog text or
add user-visible update behavior, update the Help modal in `src/index.html` per
CLAUDE.md.

**Add a build step** (e.g. bundle another asset, run a check before packaging): put it
in `scripts/before-build.js` — that is the only hook that runs for **both** `npm run
dist` and the in-app button; an npm `predist` script misses the in-app path. Throw to
abort the build, return `true` to continue. If the new asset must be readable as a real
file at runtime (served over `hm://`, loaded by a native lib), also add it to
`build.asarUnpack` in `package.json`. If you change what the in-app flow does around
the build (bump/publish/commit), that lives in `build.js` + the `build:portable`
handler in `main.js:892`, with progress strings mapped to stage labels in
`src/renderer.js:5436` — add a matching label if you add a new noisy phase.
