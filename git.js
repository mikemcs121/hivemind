'use strict';

// ---------------------------------------------------------------------------
// Git backend: thin wrappers around the `git` CLI, run per board directory.
//
// Everything goes through runGit(), which shells out to `git` with no TTY.
// GIT_TERMINAL_PROMPT=0 makes auth fail fast instead of hanging on a prompt —
// GUI credential helpers (e.g. Git Credential Manager) still pop their own
// window, so HTTPS push/pull to GitHub keeps working.
// ---------------------------------------------------------------------------

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Run an arbitrary CLI (git, gh, …) with no TTY. cwd may be undefined to use
// the process default. notFound is the message used when the binary is missing.
function runCmd(cmd, cwd, args, { timeout = 60000, notFound } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: cwd || undefined,
        timeout,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
      },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          resolve({ code: 127, stdout: '', stderr: notFound || `${cmd} was not found on PATH.` });
          return;
        }
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout || '',
          stderr: stderr || (err && err.killed ? `${cmd} timed out.` : ''),
        });
      }
    );
  });
}

function runGit(cwd, args, opts = {}) {
  return runCmd('git', cwd, args, {
    ...opts,
    notFound: 'git was not found on PATH. Install Git for Windows and reopen Hivemind.',
  });
}

const ok = (cwd) => typeof cwd === 'string' && cwd.length > 0;

// A ref/branch name is safe to pass positionally only if it can't be read as an
// option. Git ref names cannot legitimately begin with '-' anyway, so rejecting
// that costs nothing and stops `-f`/`--force`-style argument injection (e.g. a
// branch box holding "-f" turning `git checkout <name>` into `git checkout -f`,
// which would silently discard unstaged changes).
const safeRef = (name) => typeof name === 'string' && name.length > 0 && !name.startsWith('-');

// True only if the project-relative `rel` resolves to a path inside `cwd`.
// Guards the two places git file paths are used directly on the filesystem
// (untracked-file read in diff(), untracked-file delete in discard()) so a
// path that escaped the project tree can't read or delete outside it.
function insideCwd(cwd, rel) {
  const base = path.resolve(cwd);
  const full = path.resolve(base, rel);
  return full === base || full.startsWith(base + path.sep);
}

// ---------------------------------------------------------------------------
// Status: branch, upstream, ahead/behind, and the working-tree change list.
// Parsed from `git status --porcelain=v2 --branch`.
// ---------------------------------------------------------------------------
async function status(cwd) {
  if (!ok(cwd)) return { ok: false, reason: 'no-dir' };

  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code === 127) return { ok: false, reason: 'no-git', message: inside.stderr };
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { ok: false, reason: 'not-repo' };
  }

  const res = await runGit(cwd, ['status', '--porcelain=v2', '--branch']);
  if (res.code !== 0) return { ok: false, reason: 'error', message: res.stderr || res.stdout };

  const out = {
    ok: true,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    files: [],
  };

  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const h = line.slice('# branch.head '.length).trim();
      out.branch = h === '(detached)' ? null : h;
      out.detached = h === '(detached)';
    } else if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { out.ahead = parseInt(m[1], 10); out.behind = parseInt(m[2], 10); }
    } else if (line[0] === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const f = line.split(' ');
      const xy = f[1];
      out.files.push(mkFile(f.slice(8).join(' '), xy));
    } else if (line[0] === '2') {
      // 2 <XY> ... <path>\t<origPath>
      const f = line.split(' ');
      const xy = f[1];
      const rest = f.slice(9).join(' ');
      const p = rest.split('\t')[0];
      out.files.push(mkFile(p, xy, { renamed: true }));
    } else if (line[0] === 'u') {
      const f = line.split(' ');
      out.files.push(mkFile(f.slice(10).join(' '), f[1], { conflicted: true }));
    } else if (line[0] === '?') {
      out.files.push(mkFile(line.slice(2), '??', { untracked: true }));
    }
  }

  out.hasRemote = (await runGit(cwd, ['remote'])).stdout.trim().length > 0;
  if (out.hasRemote) out.remoteWebUrl = webUrlFromRemote(await getRemoteUrl(cwd));
  return out;
}

// Turn a git remote URL into a browsable https URL for the project page.
// Handles the common GitHub forms:
//   git@github.com:user/repo.git      -> https://github.com/user/repo
//   ssh://git@github.com/user/repo.git-> https://github.com/user/repo
//   https://github.com/user/repo.git  -> https://github.com/user/repo
// Returns null for anything we can't confidently map to an https page.
function webUrlFromRemote(url) {
  if (!url) return null;
  let u = url.trim();
  // scp-like syntax: git@host:path
  const scp = u.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp) u = `https://${scp[1]}/${scp[2]}`;
  u = u.replace(/^ssh:\/\/[^@/]+@/, 'https://').replace(/^git:\/\//, 'https://');
  u = u.replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(u)) return null;
  return u;
}

// Reverse git's C-style path quoting. With core.quotePath on (the default),
// `git status` wraps any path containing "unusual" bytes (non-ASCII, control
// chars, quotes) in double quotes and escapes them — e.g. `résumé.txt` becomes
// `"r\303\251sum\303\251.txt"`. The octal escapes are raw UTF-8 bytes, so decode
// escapes to bytes first and then interpret the whole thing as UTF-8. Passing
// the quoted form straight to `git add -- <path>` / reading it from disk fails
// ("pathspec did not match"), so every parsed path is unquoted here.
function unquotePath(s) {
  if (typeof s !== 'string' || s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const body = s.slice(1, -1);
  const bytes = [];
  const simple = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { bytes.push(c.charCodeAt(0) & 0xff); continue; }
    const n = body[i + 1];
    if (n >= '0' && n <= '7') {
      let oct = n; i++;
      while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') { oct += body[i + 1]; i++; }
      bytes.push(parseInt(oct, 8) & 0xff);
    } else if (n in simple) {
      bytes.push(simple[n]); i++;
    } else {
      bytes.push(c.charCodeAt(0) & 0xff); // stray backslash — keep it literal
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function mkFile(p, xy, extra = {}) {
  p = unquotePath(p);
  const x = xy[0];
  const y = xy[1];
  return {
    path: p,
    x,
    y,
    staged: x !== '.' && x !== '?' && !extra.untracked && !extra.conflicted,
    unstaged: extra.untracked || extra.conflicted || y !== '.',
    untracked: !!extra.untracked,
    conflicted: !!extra.conflicted,
    renamed: !!extra.renamed,
  };
}

// ---------------------------------------------------------------------------
// Diff for a single file (staged or working-tree). Untracked files show their
// full contents as additions, since git has no diff target for them.
// ---------------------------------------------------------------------------
async function diff(cwd, file, staged, untracked) {
  if (!ok(cwd)) return { code: 1, text: '' };
  if (untracked) {
    try {
      if (!insideCwd(cwd, file)) return { code: 1, text: 'refused: path outside project' };
      const full = path.join(cwd, file);
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) return { code: 0, text: '(binary file)' };
      const body = buf.toString('utf8').split('\n').map((l) => '+' + l).join('\n');
      return { code: 0, text: `New file: ${file}\n${body}` };
    } catch (e) {
      return { code: 1, text: String(e.message || e) };
    }
  }
  const args = staged
    ? ['diff', '--staged', '--', file]
    : ['diff', '--', file];
  const res = await runGit(cwd, args);
  return { code: res.code, text: res.stdout || res.stderr };
}

// ---------------------------------------------------------------------------
// Staging, commit, branches, remote ops.
// ---------------------------------------------------------------------------
const stage = (cwd, files) => runGit(cwd, ['add', '--', ...files]);
const stageAll = (cwd) => runGit(cwd, ['add', '-A']);
const unstage = (cwd, files) => runGit(cwd, ['reset', '-q', 'HEAD', '--', ...files]);
const unstageAll = (cwd) => runGit(cwd, ['reset', '-q', 'HEAD']);

async function discard(cwd, files) {
  // files: [{ path, untracked }]
  const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
  const untracked = files.filter((f) => f.untracked).map((f) => f.path);
  let last = { code: 0, stdout: '', stderr: '' };
  if (tracked.length) {
    last = await runGit(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
  }
  for (const f of untracked) {
    if (!insideCwd(cwd, f)) { last = { code: 1, stdout: '', stderr: `refused: path outside project (${f})` }; continue; }
    try { fs.rmSync(path.join(cwd, f), { force: true }); }
    catch (e) { last = { code: 1, stdout: '', stderr: String(e.message || e) }; }
  }
  return last;
}

const commit = (cwd, message) => runGit(cwd, ['commit', '-m', message]);

async function branches(cwd) {
  const res = await runGit(cwd, ['branch', '--format=%(refname:short)']);
  if (res.code !== 0) return [];
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

const checkout = (cwd, name) =>
  safeRef(name) ? runGit(cwd, ['checkout', name])
                : Promise.resolve({ code: 1, stdout: '', stderr: `invalid branch name: ${name}` });
const createBranch = (cwd, name) =>
  safeRef(name) ? runGit(cwd, ['checkout', '-b', name])
                : Promise.resolve({ code: 1, stdout: '', stderr: `invalid branch name: ${name}` });
const init = (cwd) => runGit(cwd, ['init', '-b', 'main']);

const fetch = (cwd) => runGit(cwd, ['fetch', '--all', '--prune'], { timeout: 120000 });
const pull = (cwd) => runGit(cwd, ['pull'], { timeout: 120000 });

function push(cwd, { branch, setUpstream } = {}) {
  if (setUpstream && branch && !safeRef(branch)) {
    return Promise.resolve({ code: 1, stdout: '', stderr: `invalid branch name: ${branch}` });
  }
  const args = setUpstream && branch
    ? ['push', '-u', 'origin', branch]
    : ['push'];
  return runGit(cwd, args, { timeout: 120000 });
}

// Throw away every local change and match the copy on GitHub. Fetches the
// remote first, hard-resets the current branch onto its upstream (so unpushed
// commits and uncommitted edits both go), then cleans untracked files so the
// working tree is byte-for-byte what origin holds. Destructive — the renderer
// confirms before calling.
async function resetToRemote(cwd, { branch } = {}) {
  if (!ok(cwd)) return { code: 1, stdout: '', stderr: 'This board has no project directory set.' };

  // Resolve the upstream ref. Prefer the branch's configured @{u}; fall back to
  // origin/<branch> when the branch has no upstream set yet.
  let ref = null;
  const u = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (u.code === 0 && u.stdout.trim()) {
    ref = u.stdout.trim();
  } else if (branch) {
    ref = `origin/${branch}`;
  }
  if (!ref) {
    return { code: 1, stdout: '', stderr: 'This branch has no GitHub upstream to revert to. Push it first.' };
  }

  const fetched = await runGit(cwd, ['fetch', 'origin'], { timeout: 120000 });
  if (fetched.code !== 0) return fetched;

  // Make sure the ref actually exists after fetching before we nuke anything.
  const verify = await runGit(cwd, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
  if (verify.code !== 0) {
    return { code: 1, stdout: '', stderr: `Could not find ${ref} on the remote.` };
  }

  const reset = await runGit(cwd, ['reset', '--hard', ref]);
  if (reset.code !== 0) return reset;

  const clean = await runGit(cwd, ['clean', '-fd']);
  if (clean.code !== 0) return clean;

  return { code: 0, stdout: `Reverted working tree to ${ref}.`, stderr: '' };
}

// ---------------------------------------------------------------------------
// GitHub connection (used by the "Connect to GitHub" wizard).
//
// Two paths:
//   - getRemoteUrl / setRemoteOrigin: link this folder to an existing repo URL.
//   - ghCheck / ghCreateRepo: use the GitHub CLI (`gh`) to create a brand-new
//     repo from this folder and push it. gh carries its own auth, so HTTPS push
//     works without GIT_TERMINAL_PROMPT.
// ---------------------------------------------------------------------------
async function getRemoteUrl(cwd) {
  if (!ok(cwd)) return null;
  const res = await runGit(cwd, ['remote', 'get-url', 'origin']);
  return res.code === 0 ? res.stdout.trim() : null;
}

async function hasCommits(cwd) {
  return (await runGit(cwd, ['rev-parse', '--verify', 'HEAD'])).code === 0;
}

// Point `origin` at a URL — adding the remote, or repointing it if it exists.
async function setRemoteOrigin(cwd, url) {
  if (!ok(cwd)) return { code: 1, stdout: '', stderr: 'This board has no project directory set.' };
  const u = (url || '').trim();
  if (!u) return { code: 1, stdout: '', stderr: 'A repository URL is required.' };
  const existing = await runGit(cwd, ['remote', 'get-url', 'origin']);
  const args = existing.code === 0
    ? ['remote', 'set-url', 'origin', u]
    : ['remote', 'add', 'origin', u];
  return runGit(cwd, args);
}

// Probe the GitHub CLI: is it installed, and is the user signed in?
async function ghCheck() {
  const ver = await runCmd('gh', undefined, ['--version'], {
    notFound: 'The GitHub CLI (gh) is not installed.',
  });
  if (ver.code === 127) {
    return { installed: false, authenticated: false, user: null, message: ver.stderr };
  }
  // `gh auth status` exits 0 when logged in and prints details to stderr.
  const auth = await runCmd('gh', undefined, ['auth', 'status']);
  const text = `${auth.stdout}\n${auth.stderr}`;
  const m = text.match(/account\s+(\S+)/i) || text.match(/Logged in to \S+ as (\S+)/i);
  return {
    installed: true,
    authenticated: auth.code === 0,
    user: m ? m[1] : null,
    message: text.trim(),
  };
}

// Create a new GitHub repo from this folder, wire up `origin`, and push.
// `name` may be "repo" (personal account) or "owner/repo" (org).
async function ghCreateRepo(cwd, { name, visibility = 'private', push = true } = {}) {
  if (!ok(cwd)) return { code: 1, stdout: '', stderr: 'This board has no project directory set.' };
  const n = (name || '').trim();
  if (!n) return { code: 1, stdout: '', stderr: 'A repository name is required.' };
  const vis = visibility === 'public' ? '--public'
    : visibility === 'internal' ? '--internal'
    : '--private';
  const args = ['repo', 'create', n, '--source', cwd, '--remote', 'origin', vis];
  if (push && (await hasCommits(cwd))) args.push('--push');
  return runCmd('gh', cwd, args, {
    timeout: 120000,
    notFound: 'The GitHub CLI (gh) is not installed.',
  });
}

// ---------------------------------------------------------------------------
// AI commit message: feed the current diff to `claude -p` and return the text.
// Prefers the staged diff; falls back to the full working-tree diff. The
// instruction is a fixed constant (no user data), so running through a shell is
// safe; the diff is passed on stdin to dodge command-length limits.
// ---------------------------------------------------------------------------
const COMMIT_INSTRUCTION =
  'Write a git commit message for the staged diff piped on stdin. ' +
  'Use an imperative subject line under 72 characters, then a blank line and a ' +
  'short body of bullet points only if the change is non-trivial. ' +
  'Output ONLY the commit message, with no preamble, quoting, or code fences.';

// Where headless `claude -p` runs matter: Claude Code writes a session
// transcript under ~/.claude/projects/<cwd-slug>, and the chat view tails the
// hive's project slug — running in the project dir would make a chat pane
// adopt the commit-drafting session and display this prompt as a thread.
// A scratch dir keeps those transcripts out of every hive's history; the diff
// arrives on stdin, so the repo cwd isn't needed.
function scratchDir() {
  const dir = path.join(os.tmpdir(), 'hivemind-ai');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* fall through */ }
  return fs.existsSync(dir) ? dir : os.tmpdir();
}

function runClaudePrompt(instruction, stdinText, timeout = 120000, model = null) {
  return new Promise((resolve) => {
    let child;
    try {
      // shell:true lets Windows resolve `claude.cmd`/`claude` from PATH the same
      // way the terminal panes do. instruction is a constant; embed it quoted.
      const safe = instruction.replace(/"/g, '');
      const modelFlag = model && /^[a-z0-9.-]+$/i.test(model) ? ` --model ${model}` : '';
      child = spawn(`claude -p${modelFlag} "${safe}"`, {
        cwd: scratchDir(),
        shell: true,
        windowsHide: true,
        env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
      });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: String(e.message || e) });
      return;
    }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: 'Could not run `claude`. Is Claude Code installed and on PATH?' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? 1 : code, stdout: out, stderr: err });
    });
    // A write to a process that already exited (e.g. `claude` missing) emits an
    // async 'error' (EPIPE) on the stdin stream; without this listener that
    // would surface as an uncaughtException and could crash the main process.
    // The child's own 'error'/'close' handlers above resolve the promise.
    child.stdin.on('error', () => { /* handled via child 'error'/'close' */ });
    try { child.stdin.write(stdinText); child.stdin.end(); } catch (_) { /* ignore */ }
  });
}

async function aiCommit(cwd) {
  if (!ok(cwd)) return { code: 1, message: 'This board has no project directory set.' };
  let d = await runGit(cwd, ['diff', '--staged']);
  let diffText = d.stdout || '';
  if (!diffText.trim()) {
    d = await runGit(cwd, ['diff']);
    diffText = d.stdout || '';
  }
  if (!diffText.trim()) return { code: 1, message: 'No changes to describe.' };
  // Keep the prompt within a sane size; truncate very large diffs.
  if (diffText.length > 60000) diffText = diffText.slice(0, 60000) + '\n…(diff truncated)…';

  const res = await runClaudePrompt(COMMIT_INSTRUCTION, diffText);
  if (res.code !== 0) {
    return { code: res.code, message: (res.stderr || 'Claude failed to produce a message.').trim() };
  }
  const message = (res.stdout || '').trim();
  if (!message) return { code: 1, message: 'Claude returned an empty message.' };
  return { code: 0, message };
}

// ---------------------------------------------------------------------------
// Conversational command interpreter: map a free-form request onto one of
// Hivemind's canonical commands via a one-shot `claude -p` on the fast model.
// The instruction is a fixed constant (safe to embed in the shell command);
// everything user-controlled — the request, the command catalog, thread and
// hive names — travels on stdin as JSON.
// ---------------------------------------------------------------------------
const HM_INTERPRET_INSTRUCTION =
  'You translate a user request into one command for Hivemind, a multi-terminal app. ' +
  'stdin is JSON: `request` (what the user said), `commands` (the command catalog: canonical ' +
  'syntax in bold-ish plain text, with a dash and a description), plus context lists such as ' +
  '`threads` (open thread names), `hives`, `themes`, and `models`. ' +
  'Reply with EXACTLY ONE line: the command to run, written in the canonical syntax with any ' +
  '<placeholders> filled in using the request and the context lists (e.g. "tell Leo to run the tests", ' +
  '"theme forest", "open 2 new threads and fix the login bug"). ' +
  'Match the user\'s intent, not their wording. If the request names a thread/hive/theme/model ' +
  'imprecisely, pick the closest one from the context lists. ' +
  'If no command fits, or the request is ordinary conversation or a question you cannot map, ' +
  'reply with exactly NONE. Never explain, never quote, never output more than one line.';

async function hmInterpret(payload) {
  let json = '';
  try { json = JSON.stringify(payload); } catch (_) { /* fall through */ }
  if (!json || json.length > 100000) return { code: 1, message: 'Bad interpret payload.' };
  const res = await runClaudePrompt(HM_INTERPRET_INSTRUCTION, json, 60000, 'haiku');
  if (res.code !== 0) {
    return { code: res.code, message: (res.stderr || 'Claude could not interpret that.').trim() };
  }
  // One line only — take the first non-empty line and strip stray quoting.
  const line = (res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  const message = line.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!message) return { code: 1, message: 'Claude returned nothing.' };
  return { code: 0, message };
}

module.exports = {
  status, diff, stage, stageAll, unstage, unstageAll, discard,
  commit, branches, checkout, createBranch, init, fetch, pull, push, resetToRemote,
  getRemoteUrl, setRemoteOrigin, ghCheck, ghCreateRepo, aiCommit, hmInterpret,
};
