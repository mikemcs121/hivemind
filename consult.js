'use strict';

// ---------------------------------------------------------------------------
// Thread consult backend: one thread asking another for a second opinion, and
// getting the answer back. Consults live under `.hivemind/consults/` inside the
// board's project directory:
//
//   .hivemind/consults/<id>.md         -- the QUESTION, written by the asking thread
//   .hivemind/consults/<id>.reply.md   -- the ANSWER, written by the answering thread
//   .hivemind/consults/ask-<...>.md    -- an UNSOLICITED question: a thread starting a
//                                         consult on its own (see listRequests)
//   .hivemind/consults/README.md       -- the protocol, the one file Hivemind writes
//
// Same design as handoff.js, plus a return leg. Hivemind writes neither the
// question nor the answer: only the asking agent knows which parts of its own
// context the other thread needs, and only the answering agent has the opinion.
// Hivemind generates the id, watches for each file to land, and carries the
// prompts between the two threads.
//
// Two id shapes exist because they mean different things to the poller:
//   `c-…`   Hivemind started this consult and is already tracking it.
//   `ask-…` a thread wrote the question unprompted; nobody is tracking it yet,
//           so listRequests() surfaces it and the renderer picks it up.
//
// Same house style as plan.js / handoff.js: every path is resolved and checked
// to stay inside `.hivemind/consults`, so a stray id can't read or delete
// outside the project.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const CONSULTS_REL = '.hivemind/consults';

// Consults are disposable — once the answer is back in the asking thread's
// conversation the files are only history. Same week-long sweep as handoff.js.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Unsolicited questions carry this prefix so the inbox poller can tell them
// from the consults Hivemind itself started and is already tracking.
const REQUEST_PREFIX = 'ask-';

// The protocol doc handed to agents. Bumping the marker rewrites it in every
// project on the next consult, so a stale copy can't teach an old protocol.
const README_MARKER = '<!-- hivemind-consult-protocol v1 -->';

const README = [
  README_MARKER,
  '# Asking another thread for a second opinion',
  '',
  'You are running as one thread in Hivemind, alongside other agent threads',
  '(Claude, Codex/ChatGPT, Gemini, Grok) working in this same directory. You can',
  'ask any of them for an opinion and get their answer back in your own',
  'conversation. Hivemind carries the messages; you only write files.',
  '',
  'To ask, write a file `' + CONSULTS_REL + '/' + REQUEST_PREFIX + '<short-slug>.md`:',
  '',
  '```markdown',
  '---',
  'to: gemini',
  'from: $HIVEMIND_THREAD',
  '---',
  '# Question',
  '<the one question you want answered>',
  '',
  '# Context',
  '<everything the other thread needs — it has none of your conversation:',
  ' the goal, the relevant file paths, what you have already tried and ruled',
  ' out, and the constraint that makes this a judgement call>',
  '```',
  '',
  '- `to:` is either the name of another thread on this hive (as shown on its',
  '  pane) or an agent to open a fresh thread on: `claude`, `codex`, `gemini`,',
  '  `grok`. A fresh thread starts with no context, so write the context out.',
  '- `from:` is your own thread name. It is in the `HIVEMIND_THREAD` environment',
  '  variable (`$env:HIVEMIND_THREAD` in PowerShell, `$HIVEMIND_THREAD` in bash);',
  '  run that and paste the value in. Hivemind delivers the answer back there.',
  '- The slug is yours to pick: `[A-Za-z0-9._-]`, no `.reply`.',
  '',
  'Then stop and tell the user you have asked. Hivemind picks the file up within',
  'a few seconds, routes it, and delivers the answer into this conversation as a',
  'new message — you do not poll for it and you do not read the reply file',
  'yourself. Nothing else about your thread changes.',
  '',
  'When you are on the answering side, Hivemind sends you the question and the',
  'path to write your answer to; write only that file.',
  '',
].join('\n');

// Resolve a consult file against the project root and reject anything that
// escapes it (or an id carrying path separators / traversal). `kind` is
// 'question' or 'reply'. Returns the absolute path, or null.
//
// `.reply` is barred from ids on purpose: the id `x.reply` would otherwise
// resolve its *question* onto `x`'s answer file.
function consultPath(root, id, kind) {
  if (typeof root !== 'string' || !root.length) return null;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  if (id.includes('.reply')) return null;
  const base = path.resolve(root);
  const dir = path.resolve(base, CONSULTS_REL);
  const resolved = path.resolve(dir, id + (kind === 'reply' ? '.reply.md' : '.md'));
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

// The project-relative paths the threads are told to use. Kept here so the
// renderer's prompt text and this module's guard can never disagree.
function consultRelPath(id) { return CONSULTS_REL + '/' + id + '.md'; }
function replyRelPath(id) { return CONSULTS_REL + '/' + id + '.reply.md'; }

// Read one side of a consult. A missing file is the normal "the thread hasn't
// written it yet" state the renderer polls on, not an error. `mtime` comes back
// so the caller can wait for the file to stop changing before acting on it — an
// agent may write a draft and then revise it, and acting on a half-written
// question (or answer) loses the rest.
async function readOne(root, id, kind) {
  const p = consultPath(root, id, kind);
  if (!root) return { ok: false, reason: 'no-dir' };
  if (!p) return { ok: false, reason: 'error', message: 'Invalid consult path.' };
  try {
    const content = await fs.promises.readFile(p, 'utf8');
    const { mtimeMs } = await fs.promises.stat(p);
    return { ok: true, content, mtime: mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'not-found' };
    return { ok: false, reason: 'error', message: err.message };
  }
}

function readConsult(root, id) { return readOne(root, id, 'question'); }
function readReply(root, id) { return readOne(root, id, 'reply'); }

// Unsolicited questions waiting to be picked up: `ask-*.md` files that have no
// answer beside them yet. Only ids and mtimes come back — the renderer settles
// on the mtime before it spends a read on the content. A missing folder (no
// thread has ever asked here) is the normal empty case, not an error.
async function listRequests(root) {
  if (typeof root !== 'string' || !root.length) return { ok: false, reason: 'no-dir' };
  const dir = path.resolve(path.resolve(root), CONSULTS_REL);
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, requests: [] };
    return { ok: false, reason: 'error', message: err.message };
  }
  const replied = new Set(
    names.filter((n) => n.endsWith('.reply.md')).map((n) => n.slice(0, -'.reply.md'.length)),
  );
  const requests = [];
  for (const name of names) {
    if (!name.startsWith(REQUEST_PREFIX) || !name.endsWith('.md') || name.endsWith('.reply.md')) continue;
    const id = name.slice(0, -'.md'.length);
    if (replied.has(id)) continue;
    if (!consultPath(root, id, 'question')) continue; // an id this module would refuse to read
    try {
      const { mtimeMs } = await fs.promises.stat(path.join(dir, name));
      requests.push({ id, mtime: mtimeMs });
    } catch (_) { /* vanished between readdir and stat — next tick will see it */ }
  }
  return { ok: true, requests };
}

// Delete one consult, both sides. A missing file is already cleared, not a
// failure.
async function clearConsult(root, id) {
  const q = consultPath(root, id, 'question');
  const r = consultPath(root, id, 'reply');
  if (!q || !r) return { ok: false, message: 'Invalid consult path.' };
  for (const p of [q, r]) {
    try {
      await fs.promises.unlink(p);
    } catch (err) {
      if (err.code !== 'ENOENT') return { ok: false, message: err.message };
    }
  }
  return { ok: true };
}

// Drop consults older than a week. Best-effort: a missing folder and an
// unreadable entry are both fine, and a sweep that fails must never block the
// consult it was called ahead of. README.md is the protocol, not a consult —
// it is kept (and refreshed by ensureConsultDocs).
async function sweepConsults(root) {
  if (typeof root !== 'string' || !root.length) return { ok: false, reason: 'no-dir' };
  const dir = path.resolve(path.resolve(root), CONSULTS_REL);
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, removed: 0 };
    return { ok: false, message: err.message };
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.md') || name === 'README.md') continue;
    const p = path.join(dir, name);
    try {
      const { mtimeMs } = await fs.promises.stat(p);
      if (mtimeMs >= cutoff) continue;
      await fs.promises.unlink(p);
      removed++;
    } catch (_) { /* vanished or locked — leave it for the next sweep */ }
  }
  return { ok: true, removed };
}

// Make sure the folder and the protocol doc exist. This is the one file
// Hivemind writes here, and it is what makes a thread able to start a consult
// *unprompted*: an agent that reads it knows the request format. Rewritten
// whenever the marker changes so an old copy can't teach an old protocol.
// Best-effort — a read-only project must not break consulting, it only means
// threads can't start one on their own.
async function ensureConsultDocs(root) {
  if (typeof root !== 'string' || !root.length) return { ok: false, reason: 'no-dir' };
  const dir = path.resolve(path.resolve(root), CONSULTS_REL);
  const file = path.join(dir, 'README.md');
  try {
    const existing = await fs.promises.readFile(file, 'utf8');
    if (existing.startsWith(README_MARKER)) return { ok: true, written: false };
  } catch (_) { /* missing or unreadable — (re)write it below */ }
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(file, README, 'utf8');
    return { ok: true, written: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = {
  readConsult,
  readReply,
  listRequests,
  clearConsult,
  sweepConsults,
  ensureConsultDocs,
  consultRelPath,
  replyRelPath,
  REQUEST_PREFIX,
};
