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
| `setConfig(dir, patch)` | partial site | Validates and merges, then returns `getConfig`. A `password` key is forwarded to `setPassword`. Clears `state` when the destination (`host`/`port`/`remoteDir`) changes |
| `setPassword(dir, password)` | plaintext or `''` | Encrypts + stores (or clears); returns `getConfig`, with `warning` when it fell back to session-only |
| `forget(dir)` | — | Deletes the whole record and any session secret |
| `scan(dir)` | — | `{ ok, configured, files: [{ rel, size, mtime, changed, uploadedAt }], problems: [{ entry, message }], changed }` |
| `test(dir)` | — | `NLST` the remote folder — `{ ok, message, entries }` |
| `publish(dir, { all }, onProgress)` | — | Uploads; `{ ok, cancelled, uploaded, files, failed, skipped, message, warning }`. `warning` is set (with `ok: true`) when files were uploaded to an empty `remoteDir` — see "Diagnosis" below |
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

State is only meaningful for **one destination** — it fingerprints local files,
not "what is on that server". So `setConfig` **wipes `state` whenever
`host`, `port` or `remoteDir` changes**. Without that, repointing a hive at a new
server or folder leaves every file looking up to date and the next publish
uploads nothing: the same silent no-op that hid the empty-`remoteDir` bug.

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
| `.pub-warn` strips: no remote folder, plain FTP, no password, session-only password | `renderPublish` | — |
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
- **`safeStorage` is keyed by the userData directory, not just the Windows
  account.** On Windows, Electron's `safeStorage` is Chromium OSCrypt: a random
  AES key held in `<userData>/Local State` (`os_crypt.encrypted_key`), and *that*
  key is what DPAPI protects. So a `publish.json` copied into a different
  `HM_USER_DATA` fails to decrypt even as the same Windows user on the same
  machine. Copy `Local State` alongside it — see the testing recipe below.
- **Testing without a real host**: curl is happy talking to a ~120-line
  throwaway Node FTP server. It only needs `USER`, `PASS`, `SYST`, `FEAT`,
  `PWD`, `CWD`, `MKD`, `TYPE`, `EPSV` (and `PASV`), `STOR`, `NLST`/`LIST` and
  `QUIT`; write it to the scratchpad, point a test board's publish settings at
  `127.0.0.1`, and set `security: 'plain'` (a hand-rolled server speaks no TLS).
  Give the test account a password containing a space, a `"` and a `\` — that is
  what exercises `curlQuote`. Drive the panel over CDP per the `verify` skill.
- **Testing against the real host**: seed the isolated `HM_USER_DATA` with a copy
  of **both** `publish.json` *and* `Local State` from `%APPDATA%\hivemind` (the
  second one carries the DPAPI-wrapped key — without it every run dies with
  "could not be decrypted"), plus a `boards.json` whose board `dir` is the site.
  Then drive `window.api.publish.*` directly over CDP; you never need to know the
  password. Publish to a staging folder, never to the live web root.

## Field report — 2026-08-10: partial publish, and where to test for real

**Resolved 2026-08-10** — see "Diagnosis" below. The section is kept because the
host behaviours it records are still true and still worth designing against.

**The original symptom.** First run of the Publish panel against a real web host
uploaded some files but not others. Not reproduced against the throwaway FTP
server — the local server does not model it, so treat "green against 127.0.0.1"
as insufficient evidence from here on.

**This repo has no website, but the app doesn't need one.** Hivemind is a
desktop app with nothing to publish, so pointing the panel at its own project
directory can only ever exercise protocol mechanics — the real-host behaviours
that matter (transient failures, TLS quirks, path shape, CDN interference) get
no coverage that way. But the panel operates on **the active board's project
directory**, not on this repo, so a board opened on any real website tests the
whole path end to end. That is the way in.

**Use PlasterSite as the end-to-end target.** `C:\xampp\htdocs\PlasterSite` is a
real, live site (Hostinger → randrpaintyourown.com) whose hand-written
`deploy.ps1` is the reference implementation this feature was modelled on. It
ships a 10-entry allowlist over FTP to the same account. Publishing there and
diffing the result against a `deploy.ps1` run is the closest thing to a true
regression test.

Observations from a manual `deploy.ps1` run on 2026-08-10, worth checking the
panel against:

- **The host re-encodes images.** An uploaded PNG comes back from
  `Server: hcdn` with a different byte length *and* different bytes, while
  visibly being the newly-uploaded image. The mp4 (1,874,047 bytes) and the HTML
  round-tripped unchanged, so it is images specifically. Any verification step
  that compares local size or hash against what the URL serves will report a
  false failure for every image. Local-vs-local change detection (`state[rel]`)
  is unaffected — this only bites if a "confirm it landed" check is ever added.
- **Edge caching is aggressive.** Responses carry
  `Cache-Control: public, max-age=31536000` and `x-hcdn-cache-status: HIT`.
  A re-upload under an unchanged filename can keep serving the old asset at the
  edge for a while, which reads exactly like "it didn't publish".
- **The remote path is not what the control panel says.** hPanel calls it
  `public_html`, but the FTP login lands above it; the working value is
  `domains/<domain>/public_html`. A wrong-but-plausible remote folder produces a
  silent no-op rather than an error — a strong candidate for "published some
  things but not others" if the panel and `deploy.ps1` disagree on the path.

The second and third points are both capable of *looking* like a partial
publish without anything having actually failed. **The third one was the
answer** — read on.

### Diagnosis: neither `failed` nor `skipped` — `remoteDir` was empty

The split-the-search-space question had a third answer. `publish()` returned
**18 uploaded, `failed: []`, `skipped: []`** — every file transferred, and every
one of the 18 had a `state[rel]` fingerprint with an `at` timestamp. Nothing
failed and nothing was skipped, so it was neither change detection nor curl.

`remoteDir` in the store was `""`, i.e. the FTP login root, while `deploy.ps1`
uses `domains/randrpaintyourown.com/public_html`. `NLST` of the login root
confirmed it — all 18 files sitting next to `domains`, `.logs` and `.profile`:

```
.htaccess  index.html  styles.css  script.js  robots.txt  sitemap.xml
README.md  MOLD-SOURCES.md  deploy.ps1  assets  tools      ← the panel's run
domains  .logs  .profile  .api_token  .filebrowser  …      ← the account
```

**Why it looked partial rather than total.** The site was still serving what a
manual `deploy.ps1` run had shipped that same day. `deploy.ps1` ships 10 files;
the panel's allowlist expands to 18. So the 10 overlapping files looked present
and current, and the 8 panel-only ones (`README.md`, `MOLD-SOURCES.md`,
`deploy.ps1`, `assets/kit-paint-video.html`, `assets/paint-a-butterfly.gif`,
`assets/social-card.svg`, `tools/*`) 404'd. "Some uploaded, some didn't" was two
tools writing to two different directories, not a partial run.

**The upload path was never wrong.** `remoteDir: ''` is a legitimate value —
`cleanRemoteDir` documents it as "the FTP login root". The trap was in the setup
form: the Remote folder input's **placeholder is the string `public_html`**, so
an empty field reads as a filled-in, plausible one. Combined with a
wrong-but-writable remote folder producing a silent success, the panel had no way
to tell the user anything was off.

**Fixed by making the empty case loud**, in three places — `publish()` still
returns `ok: true` (the transfers really did succeed) but now carries a
`warning`; `doPublish` shows `message + warning` in the msgbar with the `err`
style, so "Published 18 files." can't stand on its own; and `renderPublish`
prints a `.pub-warn` strip plus a yellow
`FTP login root (no remote folder set)` in place of the bare `/` that used to
look configured. Verified against the real host: with `remoteDir: ''` a run
returns `ok: true, uploaded: 1` **and** the warning, and the panel paints the
strip; setting the folder clears both.

### End-to-end result against the real host

Board on `C:\xampp\htdocs\PlasterSite`, `remoteDir` set to
`domains/randrpaintyourown.com/public_html/_pubtest`, upload state cleared for
true first-run semantics:

| Check | Result |
|---|---|
| `publish:run` (18 changed files) | 18 uploaded, 0 failed, 0 skipped, **no retries** |
| `publish:test` NLST `_pubtest` | 11 entries — 9 files + `assets` + `tools` |
| `publish:test` NLST `_pubtest/assets` | all 7 |
| `publish:test` NLST `_pubtest/tools` | both |
| Second `publish:run`, no local edits | "Everything is already up to date." |
| `touch robots.txt`, rescan | `changed: false` — the same-size/new-mtime hash path works |

So `--ftp-create-dirs` builds the `domains/…/_pubtest/{assets,tools}` chain
correctly, the `domains/…` path shape is fine, `ftps-control` + `-k` carries the
whole set including the 3.9 MB GIF and the 1.9 MB mp4 in one pass, and change
detection is accurate in both directions. **The feature works; the config was
pointed at the wrong folder.**

### Two things to know before pointing this at a live web root

- **The allowlist publishes `deploy.ps1`.** It is in `site.files`, so it lands in
  the web root and is served: `/_pubtest/deploy.ps1` returns `200 text/plain`
  with the FTP host IP and username in it. `README.md`, `MOLD-SOURCES.md` and
  `tools/` are served too. `deploy.ps1`'s own `$Files` list deliberately excludes
  all of these ("Build-time sources … stay local"). A denylist can't catch this —
  it is an allowlist the user chose — but the picker inherited the whole project
  root rather than the 10 files `deploy.ps1` ships.
- **Text round-trips exactly.** `index.html` (73,212 B), `README.md` (11,250 B),
  `deploy.ps1` and `tools/render-video.mjs` all came back over HTTPS at exactly
  their local byte length. The re-encoding noted above is images only.

### Ruled out — don't re-hunt these

- **`.htaccess` is not a denylist casualty.** It was the obvious suspect — the
  first file `deploy.ps1` ships, and a dotfile rule would explain the symptom
  exactly — but no entry in `DENY_FILE_RE` matches it (`/^\.git.*$/i` is the only
  broad dotfile pattern) and `walkDir` doesn't skip dotfiles either. It uploaded
  normally in this run.
- **Allowlist folder entries missing a trailing `/`.** `assets/` and `tools/`
  both have theirs, and both expanded correctly (7 and 2 files).
