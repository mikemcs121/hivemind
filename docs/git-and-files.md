# Git integration and filesystem helpers

## Purpose

`git.js` and `files.js` are main-process backends for two sidebar panels in the renderer:
the **Source Control** panel (a Visual Studio-style "Git Changes" view) and the **File
Explorer** panel. Both operate on the *active board's project directory* (`board.dir`),
passed as `cwd` on every call — neither module holds state between calls.

`git.js` is a thin wrapper around the `git` CLI (plus `gh` for the GitHub wizard and
`claude -p` for AI helpers). Everything shells out through `runGit()`/`runCmd()`
(`git.js:19-51`): `execFile` with no TTY, `GIT_TERMINAL_PROMPT=0`, 60s default timeout
(120s for network ops), 32 MB output buffer. `files.js` lists one directory level at a
time and opens/reveals files via Electron's `shell`.

## git.js API

All functions take `cwd` (absolute project dir) first. Unless noted, they resolve to the
raw CLI result shape `{ code, stdout, stderr }` — **they never reject**; failures are
`code !== 0` (127 = binary not found).

| Export | Args | Returns | Shells out to |
|---|---|---|---|
| `status(cwd)` (`git.js:76`) | cwd | `{ ok, branch, upstream, ahead, behind, detached, files[], hasRemote, remoteWebUrl }` or `{ ok:false, reason: 'no-dir'\|'no-git'\|'not-repo'\|'error' }` | `git rev-parse --is-inside-work-tree`; `git status --porcelain=v2 --branch`; `git remote`; `git remote get-url origin` |
| `diff(cwd, file, staged, untracked)` (`git.js:201`) | file path, flags | `{ code, text }` | `git diff [--staged] -- <file>`; untracked files are read from disk and rendered as all-`+` lines (binary detected by NUL byte) |
| `stage(cwd, files)` (`git.js:225`) | array of paths | CLI result | `git add -- <files>` |
| `stageAll(cwd)` | — | CLI result | `git add -A` |
| `unstage(cwd, files)` | array of paths | CLI result | `git reset -q HEAD -- <files>` |
| `unstageAll(cwd)` | — | CLI result | `git reset -q HEAD` |
| `discard(cwd, files)` (`git.js:230`) | array of `{ path, untracked }` | CLI result (last failure wins) | tracked: `git restore --source=HEAD --staged --worktree -- <files>`; untracked: `fs.rmSync` (guarded by `insideCwd`) |
| `commit(cwd, message)` | message string | CLI result | `git commit -m <message>` |
| `branches(cwd)` (`git.js:248`) | — | `string[]` (empty on error) | `git branch --format=%(refname:short)` |
| `log(cwd, count = 3)` (`git.js:254`) | count clamped to 1–50 | `[{ hash, subject, when, author }]` newest first (empty on error / no commits) | `git log -n <count> --pretty=format:` with `%x1f`/`%x1e` separators |
| `checkout(cwd, name)` | branch name (must pass `safeRef`) | CLI result | `git checkout <name>` |
| `createBranch(cwd, name)` | branch name (`safeRef`) | CLI result | `git checkout -b <name>` |
| `init(cwd)` | — | CLI result | `git init -b main` |
| `fetch(cwd)` | — | CLI result (120s timeout) | `git fetch --all --prune` |
| `pull(cwd)` | — | CLI result (120s) | `git pull` |
| `push(cwd, { branch, setUpstream })` (`git.js:265`) | opts object | CLI result (120s) | `git push` or `git push -u origin <branch>` |
| `resetToRemote(cwd, { branch })` (`git.js:280`) | opts object | CLI result; friendly stdout on success | `git rev-parse @{u}` → `git fetch origin` → `git rev-parse --verify <ref>^{commit}` → `git reset --hard <ref>` → `git clean -fd`. **Destructive**; renderer confirms first |
| `getRemoteUrl(cwd)` (`git.js:323`) | — | URL string or `null` | `git remote get-url origin` |
| `setRemoteOrigin(cwd, url)` (`git.js:334`) | url | CLI result | `git remote add origin <url>` or `set-url` if origin exists |
| `ghCheck()` (`git.js:346`) | none | `{ installed, authenticated, user, message }` | `gh --version`; `gh auth status` |
| `ghCreateRepo(cwd, { name, visibility, push })` (`git.js:367`) | name may be `repo` or `owner/repo` | CLI result (120s) | `gh repo create <n> --source <cwd> --remote origin --private/--public/--internal [--push]` (push only if `HEAD` exists) |
| `ghListRepos({ limit })` | limit clamped 1–500 (default 100) | `{ ok, repos: [{ nameWithOwner, description, visibility, updatedAt, url }] }` or `{ ok:false, message }` | `gh repo list --limit <n> --json …` |
| `ghClone({ target, destParent, folder })` | `target` = owner/repo or URL; `folder` a single path segment (defaults from `target`) | CLI result (300s) plus `dir` (created path, or `null` on failure) | `gh repo clone <target> <destParent>/<folder>` — refuses if the dest already exists |
| `aiCommit(cwd)` (`git.js:445`) | — | `{ code, message }` | `git diff --staged` (fallback `git diff`), truncated at 60 KB, piped on stdin to `claude -p "<fixed instruction>"` run in a temp scratch dir |
| `hmInterpret(payload)` (`git.js:486`) | JSON-able payload (≤100 KB) | `{ code, message }` — one command line or `NONE` | `claude -p --model haiku "<fixed instruction>"` with the payload as stdin JSON. Lives here only because it reuses `runClaudePrompt` |

Non-exported helpers worth knowing: `safeRef` (`git.js:60`) rejects ref names starting
with `-` (blocks `-f`-style argument injection); `insideCwd` (`git.js:66`) confines
untracked-file read/delete to the project tree; `unquotePath` (`git.js:159`) reverses
git's C-style quoting of non-ASCII paths; `webUrlFromRemote` (`git.js:140`) maps
ssh/scp/https remote URLs to a browsable https page (or `null`).

## files.js API

Every path is a project-relative, "/"-separated `rel` resolved through `safeJoin`
(`files.js:17`), which returns `null` for anything escaping the project root.

| Export | Args | Returns | Does |
|---|---|---|---|
| `list(root, rel)` (`files.js:27`) | project root, relative dir ('' = root) | `{ ok, entries: [{ name, path, isDir }] }` or `{ ok:false, reason: 'no-dir'\|'not-found'\|'error' }` | `fs.promises.readdir` one level; symlinks-to-dirs treated as dirs; sorted folders-first then case-insensitive alpha |
| `open(root, rel)` (`files.js:60`) | root, rel file | `{ ok }` or `{ ok:false, message }` | `shell.openPath` — OS default application |
| `reveal(root, rel)` (`files.js:68`) | root, rel file | `{ ok }` | `shell.showItemInFolder` — Explorer/Finder highlight |

## UI features backed by these modules

Wiring is uniform: renderer calls `window.api.git.*` / `window.api.files.*` (exposed by
`contextBridge` in `preload.js:61-108`), which `ipcRenderer.invoke`s a channel handled in
`main.js:746-785`, which calls the module function directly. Channel names mirror the
function names (`git:status`, `git:diff`, … `gh:check`, `gh:createRepo`, `gh:listRepos`,
`gh:clone`, `git:aiCommit`, `hm:interpret`, `files:list`, `files:open`, `files:reveal`).
Exception: the GitHub device-flow **sign-in** (`gh:authStart`/`gh:authCancel`, streaming
`gh:authStatus`) is *not* backed by `git.js` — it runs `gh auth login --web` inside a
`node-pty` shell in the main process (`startGhAuth`, `main.js`), because that command needs
a real TTY.

| Feature | Renderer | Channel(s) → function |
|---|---|---|
| Source Control panel open/refresh (`#git-toggle`) | `refreshGit()` `renderer.js:5574` | `git:status` → `status`, `git:log` → `log` (fetched in parallel) |
| "Recent Commits" list at the bottom of the panel (last 3, read-only) | `renderCommitLog` `renderer.js` | data from `git:log`, cached in `lastLog` |
| Branch bar: name + `↓behind ↑ahead` counters, GitHub-page button | `renderBranchBar` `renderer.js:5661` | data from `status`; web button uses `remoteWebUrl` via `openExternal` |
| Branch menu (switch / create) | `openBranchMenu` `renderer.js:8108` | `git:branches`, `git:checkout`, `git:createBranch` |
| "Initialize Repository" (non-repo folder) | `renderer.js:5635` | `git:init` |
| Staged/unstaged lists, per-file +/−/↩, section-level stage/unstage all | `renderSection`/`renderFileRow` `renderer.js:5918-5991` | `git:stage`, `git:unstage`, `git:stageAll`, `git:unstageAll`, `git:discard` (confirm() first) |
| Click-a-file diff modal (`#diff-backdrop`) | `showDiff` `renderer.js:8065` | `git:diff` → `diff` |
| Commit box + "✨ Generate" AI draft | `renderCommitBox`, `doGenerateCommitMsg` `renderer.js:5742,5896` | `git:aiCommit` → `aiCommit` |
| Pull button | `doPull` `renderer.js:5840` | `git:pull` |
| Push button (Ctrl+Enter in message box): stages all → commits (auto-drafts message if box empty, fallback "Update from Hivemind") → pushes, `-u origin <branch>` first time | `doPush` `renderer.js:5850` | `git:stageAll`, `git:commit`, `git:aiCommit`, `git:push` |
| ⋯ overflow → "Revert to GitHub" (confirm dialog) | `doRevertToRemote` `renderer.js:5712` | `git:resetToRemote` |
| "Connect to GitHub" wizard (create via gh, or link URL + push) | `renderer.js:8216-8369` | `gh:check`, `gh:createRepo`, `git:setRemote`, `git:push` |
| "Clone a project from GitHub…" in the New-hive modal (`#modal-clone` → `#clone-backdrop`): sign in via device flow, pick a repo (list or URL) + destination, clone, fill the modal's dir/name | `openCloneWizard`/`renderCloneChoose`/`cloneDoClone` `renderer.js` | `gh:check`, `gh:authStart`+`gh:authStatus`, `gh:listRepos`, `gh:clone` |
| `show diff [for <file>]` chat command | `renderer.js:1698` | `git:status`, then `showDiff` |
| File Explorer panel (`#files-toggle`): lazy tree, click = OS-open, ⤓ insert path into thread, ⧉ reveal | `refreshFiles`/`renderFxItem` `renderer.js:6036-6138` | `files:list`, `files:open`, `files:reveal` |
| Slash-command autocomplete (`.claude/commands`, `.claude/skills`) and `@`-path completion in composer | `renderer.js:2768-2810` | `files:list` |
| Build button reveals `dist/` after portable build | `renderer.js:5492` | `files:reveal` |

**Background auto-fetch** (`renderer.js:5584-5616`): `git status` only compares against
the *local* remote-tracking ref, so the ↓ counter is stale until something talks to the
remote. `autoFetchGit(dir, force)` runs `git:fetch` quietly: (a) after each successful
status load when the repo has a remote, (b) on a 60s `setInterval` tick while the panel is
open. Throttled per-directory to one fetch per `GIT_AUTOFETCH_MS` (3 min, tracked in the
`gitLastFetch` map; only successful fetches update it) and single-flighted via
`gitFetching`. The ⟳ button (`renderer.js:5541`) passes `forceFetch: true` to bypass the
throttle. After a fetch, the panel repaints only if it is still open, still showing the
same dir, not mid-operation (`gitBusy`), and the ⋯ menu is closed (`gitMenuOpen`).

**Live refresh on disk changes**: the renderer calls `window.api.setWatch(board.dir)` on
board switch (`renderer.js:4189` → `watch:set` → `fs.watch(..., { recursive: true })` in
`main.js:263`, debounced 600 ms). The resulting `fs:changed` event (`renderer.js:5370`)
re-runs `refreshGit({ keepMsg: true })` — the File Explorer intentionally does *not*
auto-refresh so expanded folders don't collapse under the user.

## Invariants & gotchas

- **Nothing rejects.** `runCmd` always resolves; check `res.code !== 0` and read
  `res.stderr || res.stdout` for the message. `status`/`list` return `{ ok:false, reason }`
  objects instead. The renderer's `gitRun()` (`renderer.js:5548`) is the standard wrapper:
  busy-guard, message bar, auto-`refreshGit` afterwards — route new git buttons through it.
- **Missing binaries** surface as `code: 127` with a friendly `notFound` message
  (git → "Install Git for Windows…", gh → "not installed", claude → "Is Claude Code
  installed and on PATH?"). Don't treat 127 as a git error.
- **Argument-injection guards**: branch names go through `safeRef` (no leading `-`), and
  file paths are always passed after a `--` separator. Preserve both patterns in any new
  operation; never interpolate user input into a shell string (only the fixed prompt
  constants are shell-embedded in `runClaudePrompt`, `git.js:406`).
- **Path confinement**: `insideCwd` (git) and `safeJoin` (files) stop `../` escapes.
  Any new function that touches the filesystem from a renderer-supplied path must use one.
- **Windows path quirks**: `files.js` `rel` paths are "/"-separated even on Windows
  (built in `list`, joined with `path.join`); git output paths are also "/"-separated.
  Non-ASCII paths from `git status` arrive C-quoted and are decoded by `unquotePath` —
  new porcelain parsers must reuse it or `git add -- <path>` will fail with "pathspec did
  not match".
- **No remote / no upstream**: `status` sets `hasRemote`; without it Pull is disabled and
  Push opens the GitHub wizard instead. Without an upstream the counters show
  "no upstream" and the first push sets `-u origin <branch>`. `resetToRemote` refuses when
  no upstream can be resolved.
- **Fetch cadence**: never call `git:fetch` in a loop — go through `autoFetchGit` so the
  3-minute throttle and single-flight guard apply. Network ops use a 120s timeout;
  auth prompts can't hang because `GIT_TERMINAL_PROMPT=0` (GUI credential helpers still work).
- **`claude -p` runs in a scratch dir** (`git.js:400`), *not* the project dir — running it
  in the repo would create a Claude Code session transcript under the project's slug and
  the chat-view binder would display it as a hive thread. Keep this for any new AI helper.
- **Big repos/diffs**: `maxBuffer` is 32 MB; `aiCommit` truncates diffs at 60 KB. The diff
  viewer renders whatever `git diff` returns as plain escaped text (`renderDiff`,
  `renderer.js:8087`).
- **Panel repaint hazards**: any code that re-renders the git panel must respect `gitBusy`
  and `gitMenuOpen`, or it will wipe an open ⋯ menu / clobber an in-flight operation.

## How to extend — add a new git operation end-to-end

Example: add `git stash`.

1. **git.js** — add `const stash = (cwd) => runGit(cwd, ['stash', '--include-untracked']);`
   near the other one-liners (`git.js:225-263`) and add `stash` to `module.exports`
   (`git.js:501`). Validate any user-supplied ref with `safeRef`, pass file paths after `--`.
2. **main.js** — register the handler with the git block (`main.js:746`):
   `ipcMain.handle('git:stash', (_e, { cwd }) => git.stash(cwd));`
3. **preload.js** — expose it inside the `git:` object (`preload.js:61`):
   `stash: (cwd) => ipcRenderer.invoke('git:stash', { cwd }),`
4. **renderer.js** — add UI in the Source Control panel (e.g. a button in
   `renderCommitBox` or the ⋯ menu, `renderer.js:5742-5833`) and invoke it through
   `gitRun('Stashing', (d) => window.api.git.stash(d), { okMsg: 'Stashed.' })` so the
   busy-guard, error reporting, and post-op refresh come free. Confirm first if destructive
   (see `doRevertToRemote`, `renderer.js:5712`).
5. **Help modal** — per `CLAUDE.md`, update `#help-modal` in `src/index.html` in the same
   change if the feature is user-visible.
6. Note: a full Electron relaunch is required to pick up main-process changes
   (steps 1-3); renderer-only changes reload with the window.
