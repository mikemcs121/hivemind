// The composer's "@" file picker: the whole-project index (files.js) and the
// fuzzy ranking the renderer applies to it.
// Run: node --test scripts/test-file-mentions.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const files = require(path.join(root, 'files.js'));

// Pull the ranking helpers out of the renderer the same way the skill tests do:
// renderer.js is not a module, so evaluate just the functions under test.
const source = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const start = source.indexOf('const AC_WORD_SEP =');
const end = source.indexOf('\n// Fill `el` with `text`', start);
assert.ok(start > 0 && end > start, 'ranking helpers still live in renderer.js');
const ctx = vm.createContext({ console });
vm.runInContext(source.slice(start, end), ctx);
// Top-level `const` lives in the context's lexical scope, not on the context
// object, so read the bindings back with an expression.
const { fuzzyMatchPath, pathDepth } = vm.runInContext('({ fuzzyMatchPath, pathDepth })', ctx);

const rank = (q, paths) => paths
  .map((p) => ({ p, m: fuzzyMatchPath(q.toLowerCase(), p) }))
  .filter((r) => r.m)
  .sort((a, b) => b.m.score - a.m.score || a.p.length - b.p.length)
  .map((r) => r.p);

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hm-mentions-'));
const write = (dir, rel, body = 'x') => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

test('index uses git ls-files inside a repo and honours .gitignore', async () => {
  const res = await files.index(root);
  assert.equal(res.ok, true);
  assert.equal(res.source, 'git');
  assert.ok(res.files.includes('src/renderer.js'));
  assert.ok(res.files.includes('files.js'));
  // node_modules is gitignored, so the picker must never offer it.
  assert.equal(res.files.some((p) => p.startsWith('node_modules/')), false);
  // Paths are project-relative and "/"-separated, matching files.list's `rel`.
  assert.equal(res.files.some((p) => p.includes('\\') || path.isAbsolute(p)), false);
  // Directories are derived from the indexed files, every ancestor included.
  assert.ok(res.dirs.includes('src'));
  assert.ok(res.dirs.includes('.agents/skills/verify'));
  assert.equal(res.dirs.includes('node_modules'), false);
});

test('index falls back to a bounded walk outside a repo', async () => {
  const dir = tmpdir();
  try {
    write(dir, 'README.md');
    write(dir, 'src/app.ts');
    write(dir, 'node_modules/pkg/index.js');
    write(dir, 'dist/bundle.js');
    const res = await files.index(dir);
    assert.equal(res.ok, true);
    assert.equal(res.source, 'walk');
    assert.deepEqual(res.files, ['README.md', 'src/app.ts']);
    assert.deepEqual(res.dirs, ['src']);
    assert.equal(res.truncated, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the walk never follows symlinks out of the project', async () => {
  const dir = tmpdir();
  const outside = tmpdir();
  try {
    write(dir, 'inside.txt');
    write(outside, 'secret.txt');
    try { fs.symlinkSync(outside, path.join(dir, 'link'), 'junction'); }
    catch (_) { return; } // no symlink privilege on this machine — nothing to test
    const res = await files.index(dir);
    assert.deepEqual(res.files, ['inside.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('index refuses a root that is not a directory', async () => {
  assert.equal((await files.index('')).ok, false);
  assert.equal((await files.index(path.join(root, 'files.js'))).ok, false);
  assert.equal((await files.index(path.join(root, 'no-such-folder'))).ok, false);
});

test('a query matches anywhere in the project, not just the current folder', () => {
  const tree = ['src/renderer.js', 'src/styles.css', 'docs/renderer.md', 'main.js'];
  // Typing the file name alone finds it however deep it is.
  assert.equal(rank('rend', tree)[0], 'src/renderer.js');
  // A path fragment still works, and picks the file it names.
  assert.equal(rank('docs/rend', tree)[0], 'docs/renderer.md');
  assert.deepEqual(rank('zzz', tree), []);
});

test('ranking prefers the file name over an incidental path match', () => {
  // "src" appears in both, but only one is actually named for it.
  const ranked = rank('src', ['src/deeply/nested/other.js', 'lib/src.ts']);
  assert.equal(ranked[0], 'lib/src.ts');
  // A file-name prefix beats a scattered subsequence of the same characters.
  assert.equal(rank('main', ['main.js', 'm/a/i/n.js'])[0], 'main.js');
  // Shallower paths win ties.
  assert.equal(rank('app', ['app.js', 'a/b/c/app.js'])[0], 'app.js');
});

test('hits point at the characters that matched, in the file name', () => {
  const m = fuzzyMatchPath('rend', 'src/renderer.js');
  assert.ok(m);
  // Contiguous, and inside the basename rather than on the "r" of "src".
  assert.deepEqual(Array.from(m.hits), [4, 5, 6, 7]); // cross-realm array
  assert.ok(m.hits.every((h) => h >= 'src/'.length));
  assert.equal(fuzzyMatchPath('rend', 'nope.js'), null);
  // Longer than the path can ever match.
  assert.equal(fuzzyMatchPath('renderer.js.extra', 'a.js'), null);
});

test('the better of the two scan directions wins', () => {
  // Backward-greedy would reach past the name to the "d" of ".md"; forward wins.
  assert.deepEqual(Array.from(fuzzyMatchPath('rend', 'docs/renderer.md').hits), [5, 6, 7, 8]);
  // Forward-greedy would anchor on the "r" of "src"; backward wins.
  assert.deepEqual(Array.from(fuzzyMatchPath('rend', 'src/renderer.js').hits), [4, 5, 6, 7]);
  // Both directions still agree that a non-subsequence is no match.
  assert.equal(fuzzyMatchPath('xyz', 'src/renderer.js'), null);
});

test('pathDepth counts folder levels', () => {
  assert.equal(pathDepth('main.js'), 0);
  assert.equal(pathDepth('src/renderer.js'), 1);
  assert.equal(pathDepth('.agents/skills/verify/SKILL.md'), 3);
});
