'use strict';

// ---------------------------------------------------------------------------
// Git backend: thin wrappers around the `git` CLI, run per board directory.
//
// Everything goes through runGit(), which shells out to `git` with no TTY.
// GIT_TERMINAL_PROMPT=0 makes auth fail fast instead of hanging on a prompt —
// GUI credential helpers (e.g. Git Credential Manager) still pop their own
// window, so HTTPS push/pull to GitHub keeps working.
// ---------------------------------------------------------------------------

const { execFile } = require('child_process');
const fs = require('fs');
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
  return out;
}

function mkFile(p, xy, extra = {}) {
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

const checkout = (cwd, name) => runGit(cwd, ['checkout', name]);
const createBranch = (cwd, name) => runGit(cwd, ['checkout', '-b', name]);
const init = (cwd) => runGit(cwd, ['init', '-b', 'main']);

const fetch = (cwd) => runGit(cwd, ['fetch', '--all', '--prune'], { timeout: 120000 });
const pull = (cwd) => runGit(cwd, ['pull'], { timeout: 120000 });

function push(cwd, { branch, setUpstream } = {}) {
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

module.exports = {
  status, diff, stage, stageAll, unstage, unstageAll, discard,
  commit, branches, checkout, createBranch, init, fetch, pull, push, resetToRemote,
  getRemoteUrl, setRemoteOrigin, ghCheck, ghCreateRepo,
};
