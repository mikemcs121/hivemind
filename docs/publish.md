# Publish to website (FTP)

## Purpose

`publish.js` is the main-process backend for the **Publish** panel — the sidebar
panel that uploads a hive's website to a web host over FTP. It is deliberately
shaped like Source Control (`docs/git-and-files.md`): docked in the sidebar,
operating on the active board's project directory, with a changed/unchanged file
list and one big action button.

The model for the feature is the hand-written `deploy.ps1` in the user's
PlasterSite project: curl over FTP with an explicit file allowlist and a
DPAPI-encrypted credential file. This is that, generalised and per-hive.

| File | Role |
|---|---|
| `publish.js` | Config store, credential encryption, change detection, curl uploads |
| `main.js` | `publish:*` IPC handlers (registered next to the `files:*` block) |
| `preload.js` | `window.api.publish.*` |
| `src/renderer.js` | The `Publish panel (publish to website over FTP)` section |
| `src/index.html` | `#publish-panel`, `#publish-toggle`, `#publish-pick-backdrop` |
| `src/styles.css` | `Publish panel` section |

## Security model — read this before changing anything here

Three rules, all load-bearing:

1. **Settings live in userData, never in the project.** The whole record —
   host, port, username, remote folder, file list, upload state *and* the
   encrypted password — is one entry in
   `%APPDATA%\hivemind\publish.json` (or `$HM_USER_DATA\publish.json`), keyed by
   the resolved, case-folded project directory. The project folder is committed,
   pushed, zipped and shared, and the agent threads Hivemind spawns run *inside*
   it — anything stored there is neither private nor safe. Do not add a
   `.hivemind/publish.json`.

2. **The password is encrypted at rest and never reaches the renderer.**
   `safeStorage.encryptString` (Windows DPAPI, scoped to the logged-in Windows
   account) produces the base64 `secret` field. `getConfig` returns
   `hasPassword: true|false` — there is no IPC channel that returns the
   plaintext. If `safeStorage.isEncryptionAvailable()` is false the password is
   held in the `sessionSecrets` in-memory map for the session and **not written
   to disk**; the UI says so (`passwordSessionOnly`).

3. **The password never appears in a command line.** argv is world-readable in
   the Windows process list, so the credential goes to curl over stdin as a
   config file (`--config -` with a single `user = "user:pass"` line) rather
   than deploy.ps1's `-u user:pass`. `curlQuote` escapes `\` then `"`; curl's
   config parser understands both, and escaping the backslash first neutralises
   any `\n`/`\t` sequence. Control characters are rejected at validation time
   (`CTRL_RE`) because the config format is line-based.

Two further guards:

- **curl is resolved absolutely.** `curlBin` prefers
  `%SystemRoot%\System32\curl.exe`, and no `cwd` is set on the spawn. Windows
  `CreateProcess` searches the application/current directory before PATH, and
  agent threads write files into the project folder — a stray `curl.exe` next to
  the user's website must never win.
- **A denylist backstops the allowlist.** `denyReason` refuses `.git`, `.svn`,
  `.hg`, `.hivemind`, `.claude`, `.vscode`, `.vs`, `.idea`, `node_modules`,
  `__pycache__` (as any path segment) and `.env*`, `.ftp-cred`, `.netrc`,
  `.npmrc`, `.git*`, `id_rsa`-style keys, `*.pem|key|pfx|p12|ppk|keystore|jks`,
  `Thumbs.db`/`desktop.ini`/`.DS_Store` (as the file name). It is applied when
  walking a ticked folder, when scanning, **and again immediately before each
  upload** — the tree can change between scan and send.

## publish.js API

All functions take the project dir first. Nothing throws across IPC; failures
come back as `{ ok: false, message }`.

| Export | Args | Returns |
|---|---|---|
| `getConfig(dir)` | — | `{ ok, configured, canEncrypt, site }`; `site` carries `hasPassword`/`passwordSessionOnly`, never the secret |
| `setConfig(dir, patch)` | partial site | Validates and merges, then returns `getConfig`. A `password` key is forwarded to `setPassword` |
| `setPassword(dir, password)` | plaintext or `''` | Encrypts + stores (or clears); returns `getConfig`, with `warning` when it fell back to session-only |
| `forget(dir)` | — | Deletes the whole record and any session secret |
| `scan(dir)` | — | `{ ok, configured, files: [{ rel, size, mtime, changed, uploadedAt }], problems: [{ entry, message }], changed }` |
| `test(dir)` | — | `NLST` the remote folder — `{ ok, message, entries }` |
| `publish(dir, { all }, onProgress)` | — | Uploads; `{ ok, cancelled, uploaded, files, failed, skipped, message }` |
| `cancel(dir)` | — | Stops the in-flight run after the current file |
| `denyPaths(rels)` | array | `{ rel: reason }` for the picker — keeps the denylist in one place |

### The file allowlist

`site.files` holds project-relative, `/`-separated entries. A trailing `/` marks
a folder, which publishes **recursively**; anything else is a single file.
`cleanEntry` strips `./`, rejects `..` segments and anything `safeJoin` says
escapes the project. Editing the list prunes upload state for paths no longer
covered, so re-adding a file later republishes it instead of trusting a stale
fingerprint.

### Change detection

`state[rel] = { size, mtime, hash, at }`, written **per file, immediately after
that file uploads** — a failure or a cancel halfway through never costs a
re-upload of what already landed.

A file counts as unchanged only if `size` matches *and* either `mtime` matches
or a fresh SHA-256 matches the recorded hash (in which case the new mtime is
recorded). That keeps a touched-but-unmodified file from re-uploading while
still catching an edit that happens to preserve the size.

### Uploading

One `curl` per file, sequential, up to `RETRIES` (3) attempts with a 2 s backoff
— shared hosts throw transient 450/530s. Exit code 67 (bad login) and 127
(no curl) break out early instead of burning two more tries. The remote URL is
built from percent-encoded segments and names the target file explicitly, so
`--ftp-create-dirs` still creates missing directories while odd filenames
survive. `CURL_MSG` maps the common exit codes to sentences a non-developer can
act on.

`security` picks the transport:

| Value | curl flags | Notes |
|---|---|---|
| `ftps-control` (default) | `--ftp-ssl-control` | Encrypts the control channel (the login); data channel plain. Full FTPS breaks on Windows — curl's schannel backend mishandles the TLS shutdown on the data connection and larger files die with `450 Transfer aborted`. Website payloads are public; the login is what matters. |
| `ftps` | `--ssl-reqd` | Fully encrypted, if the host cooperates |
| `plain` | — | No encryption; the panel shows a warning |

`insecureCert` adds `-k` (default on, ignored for `plain`): shared hosting
usually serves a certificate for the provider rather than the per-account host.

## Renderer

State lives in module-level `pub*` variables next to the panel code. The panel
has two modes and **`pubForm` is the single source of truth for which one is
showing** — `renderPublish` sets `pubForm = true` whenever it draws the form
(including the unconfigured first run), and `refreshPublish`/`pubRun` both
bail out of repainting while it is set. Without that, a background refresh or a
failed save would rebuild the inputs and discard half-typed credentials.

| Feature | Renderer | Channel |
|---|---|---|
| Panel open/close, one-panel-at-a-time | `setPublishOpen` | — |
| Load config + scan, repaint | `refreshPublish` (generation-guarded) | `publish:config`, `publish:scan` |
| Busy-guarded op wrapper | `pubRun` | — |
| Target card, warnings, file list, ⋯ menu | `renderPublish` / `renderPubFileRow` | — |
| Connection form | `renderPublishForm` | `publish:setConfig`, `publish:setPassword` |
| "Choose…" picker | `openPublishPicker` / `buildPubPickLevel` / `buildPubPickRow` | `files:list`, `publish:deny`, `publish:setConfig` |
| Publish / Stop | `doPublish` / `doPublishCancel` | `publish:run`, `publish:cancel` |
| ⋯ → Test connection / Forget password / Remove settings | `doPublishTest` / `doPublishForgetPassword` / `doPublishForget` | `publish:test`, `publish:setPassword`, `publish:forget` |
| Live per-file progress | `window.api.publish.onProgress` → `pubRowStatus` | `publish:progress` |
| "Hivemind, publish the site" | `HM_COMMANDS` entry `publish-site` | — |

`pubRowStatus` holds `busy`/`done`/`fail` per row **during** a run. When the run
ends, `doPublish` clears it and re-adds only the failures — otherwise every row
keeps a ✓ and hides the real changed/unchanged state on the next scan.

The picker is a lazy checkbox tree over `files:list`. Ticking a folder removes
any entries already ticked inside it; descendants of a ticked folder render as
checked-and-disabled ("covered"). Denied rows are struck through with the reason
from `publish:deny`.

## Invariants & gotchas

- **Never add an IPC path that returns the password.** `hasPassword` is the
  whole contract with the renderer.
- **Never write publish settings into the project directory.** See rule 1.
- **Re-check `denyReason` and `realInside` at upload time**, not just at scan
  time — `publish()` does, and a new code path must too.
- **`fs:changed` repaints the panel**, but only when not `pubBusy`, `pubRunning`,
  `pubMenuOpen` or `pubForm` — the same repaint hazards the git panel has, plus
  the form.
- **A decrypt failure is expected and handled**: a `publish.json` copied from
  another machine or another Windows user yields `null` from `decryptSecret`,
  and `credFor` explains that rather than failing obscurely.
- **Testing without a real host**: curl is happy talking to a ~120-line
  throwaway Node FTP server. It only needs `USER`, `PASS`, `SYST`, `FEAT`,
  `PWD`, `CWD`, `MKD`, `TYPE`, `EPSV` (and `PASV`), `STOR`, `NLST`/`LIST` and
  `QUIT`; write it to the scratchpad, point a test board's publish settings at
  `127.0.0.1`, and set `security: 'plain'` (a hand-rolled server speaks no TLS).
  Give the test account a password containing a space, a `"` and a `\` — that is
  what exercises `curlQuote`. Drive the panel over CDP per the `verify` skill.
