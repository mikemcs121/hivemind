---
name: release
description: Cut a Hivemind portable release — bump version, build, publish to GitHub releases so the auto-updater picks it up.
---

# Releasing Hivemind

Full background: `docs/build-and-release.md`. This is the executable checklist.
The in-app "Build portable copy" button automates steps 2–6 (`build.js`,
wired in `main.js`); use this manual flow when releasing from a Claude session.

## Checklist (in order)

1. **Preflight:** `gh auth status` must succeed before doing anything
   irreversible. Working tree should be clean apart from the changes being
   released.
2. **Bump the version** in `package.json` (patch bump unless told otherwise).
   Never skip this: the artifact name embeds the version and the updater
   compares versions — a rebuild under an old version is invisible to deployed
   clients.
3. **Build:** `npm run dist` (or `npx electron-builder --win portable` for
   portable only). `scripts/before-build.js` auto-fetches speech models. Run
   from a normal shell — never under Electron-as-Node (`ERR_REQUIRE_ESM`).
4. **Artifacts** land in `dist/`: `Hivemind <ver> portable.exe` (and NSIS
   `Hivemind <ver>.exe` for the full target set).
5. **Commit & push** the version bump only: `git commit -m "Bump version to <ver>"`.
6. **Publish:** `gh release create v<ver> "dist/Hivemind <ver> portable.exe"`
   on **mikemcs121/hivemind** (must stay public — update checks are
   unauthenticated). Tag format is `vX.Y.Z`; the asset name must contain
   `portable` and end in `.exe`.

## What the updater expects

`updater.js` runs once at startup, only in portable builds
(`PORTABLE_EXECUTABLE_FILE` set). It reads
`api.github.com/repos/mikemcs121/hivemind/releases/latest`, compares
`tag_name` to `app.getVersion()`, downloads the first `/portable/i` `.exe`
asset, verifies its size, swaps, and relaunches. Breaking the tag format or
asset naming silently breaks updates for every deployed copy.
