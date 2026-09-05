// Shared project skill discovery, compatibility entry points, and composer behavior.
// Run: node --test scripts/test-agent-skills.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const start = source.indexOf('async function discoverProjectCommands(');
const end = source.indexOf('\nfunction updateViewBtn(', start);
const fnSource = source.slice(start, end);
const item = (name, isDir = true) => ({ name, isDir });
const fixture = {
  '.agents/skills': [item('verify'), item('release'), item('unfinished'), item('bad name')],
  '.agents/skills/verify': [item('SKILL.md', false)],
  '.agents/skills/release': [item('SKILL.md', false)],
  '.agents/skills/unfinished': [item('references')],
  '.claude/skills': [item('verify'), item('legacy')],
  '.claude/skills/verify': [item('SKILL.md', false)],
  '.claude/skills/legacy': [item('SKILL.md', false)],
  '.gemini/skills': [item('gemini-only')],
  '.gemini/skills/gemini-only': [item('SKILL.md', false)],
  '.claude/commands': [item('command.md', false), item('verify.md', false)],
};
function listFor(tree, calls = []) {
  return async (cwd, rel) => {
    calls.push([cwd, rel]);
    return tree[rel] ? { ok: true, entries: tree[rel] } : { ok: false };
  };
}
function context(extra = {}) {
  const c = vm.createContext({ console, ...extra });
  vm.runInContext(fnSource, c);
  return c;
}
for (const agent of ['claude', 'codex', 'gemini', 'grok']) {
  test(agent + ' gets canonical skills with portable invocation', async () => {
    const c = context(), calls = [];
    const items = await c.discoverProjectCommands(root, agent, listFor(fixture, calls));
    const verify = items.filter(i => i.label === '/verify');
    assert.equal(verify.length, 1);
    assert.ok(verify[0].insert.includes('".agents/skills/verify/SKILL.md"'));
    assert.ok(verify[0].insert.startsWith('Read "AGENTS.md"'));
    assert.equal(items.some(i => i.label === '/unfinished'), false);
    assert.equal(items.some(i => i.label === '/bad name'), false);
    assert.equal(items.some(i => i.label === '/legacy'), agent === 'claude');
    assert.equal(items.some(i => i.label === '/command'), agent === 'claude');
    assert.equal(items.some(i => i.label === '/gemini-only'), agent === 'gemini');
    assert.ok(calls.every(([cwd]) => cwd === root));
  });
}
test('missing or unreadable roots do not hide accessible legacy skills', async () => {
  const c = context();
  const items = await c.discoverProjectCommands(root, 'claude', async (cwd, rel) => {
    if (rel.startsWith('.agents/')) throw new Error('unreadable');
    return listFor(fixture)(cwd, rel);
  });
  assert.ok(items.find(i => i.label === '/legacy'));
  assert.equal(items.find(i => i.label === '/verify').insert, '/verify ');
  assert.equal(items.find(i => i.label === '/legacy').insert, '/legacy ');
});
test('a directory named SKILL.md is not a skill entry point', async () => {
  const c = context();
  const items = await c.discoverProjectCommands(root, 'codex', listFor({
    '.agents/skills': [item('broken')],
    '.agents/skills/broken': [item('SKILL.md')],
  }));
  assert.equal(items.length, 0);
});

function composer(agent, list) {
  class Element {
    constructor() {
      this.children = [];
      this.classes = new Set();
      this.classList = {
        add: v => this.classes.add(v),
        remove: v => this.classes.delete(v),
        contains: v => this.classes.has(v),
      };
    }
    set className(v) { this.classes = new Set(v.split(' ')); }
    set innerHTML(v) { this.children = []; }
    append(...v) { this.children.push(...v); }
    appendChild(v) { this.append(v); }
    addEventListener() {}
  }
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0,
    focus() {},
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + text.length;
    },
  };
  const host = new Element();
  const doc = { createElement: () => new Element(), activeElement: input };
  let now = 0;
  const c = context({
    document: doc, window: { api: { files: { list } } },
    Date: { now: () => now }, AC_MAX_ITEMS: 8,
    SLASH_COMMANDS: [['/config', 'Claude settings']],
    autosizeComposer() {},
  });
  const pane = { agent, board: { dir: root } };
  const ac = c.initChatAutocomplete(pane, host, input);
  const type = (value, cursor = value.length) => {
    input.value = value;
    input.selectionStart = input.selectionEnd = cursor;
    return ac.refresh();
  };
  const labels = () => host.children[0].children.map(row => row.children[0].textContent);
  return { ac, pane, input, type, labels, advance: ms => { now += ms; } };
}
test('skill acceptance preserves task details and does not submit', async () => {
  const c = composer('codex', listFor(fixture));
  await c.type('/ver inspect the toolbar', 4);
  assert.deepEqual(c.labels(), ['/verify']);
  let prevented = false;
  assert.equal(c.ac.handleKey({ key: 'Enter', preventDefault: () => { prevented = true; } }), true);
  assert.equal(prevented, true);
  assert.ok(c.input.value.includes('".agents/skills/verify/SKILL.md"'));
  assert.ok(c.input.value.endsWith('inspect the toolbar'));
});
test('switching agents invalidates cached Claude commands and built-ins', async () => {
  const c = composer('claude', listFor(fixture));
  await c.type('/');
  assert.ok(c.labels().includes('/config'));
  assert.ok(c.labels().includes('/legacy'));
  c.pane.agent = 'codex';
  await c.type('/');
  assert.deepEqual(c.labels(), ['/release', '/verify']);
});
test('new skills appear after cache expires without reloading the composer', async () => {
  const tree = { ...fixture };
  const c = composer('codex', listFor(tree));
  await c.type('/');
  tree['.agents/skills'] = [...fixture['.agents/skills'], item('new-skill')];
  tree['.agents/skills/new-skill'] = [item('SKILL.md', false)];
  c.advance(5001);
  await c.type('/');
  assert.ok(c.labels().includes('/new-skill'));
});
test('rapid input shares the pending catalog and keeps the latest query', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const calls = [];
  const c = composer('codex', async (cwd, rel) => {
    await barrier;
    return listFor(fixture, calls)(cwd, rel);
  });
  const first = c.type('/v');
  const second = c.type('/ve');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(c.labels(), ['/verify']);
  assert.equal(calls.filter(([, rel]) => rel === '.agents/skills').length, 1);
});
test('entry points and wrappers resolve to the canonical repository files', () => {
  const rules = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  for (const name of ['CLAUDE.md', 'GEMINI.md']) {
    const adapter = fs.readFileSync(path.join(root, name), 'utf8');
    const imported = adapter.match(/^@(.+)$/m);
    assert.ok(imported, name + ' imports the shared rules');
    assert.equal(path.resolve(root, imported[1].trim()), path.join(root, 'AGENTS.md'));
  }
  for (const name of fs.readdirSync(path.join(root, '.agents/skills'))) {
    const rel = '.agents/skills/' + name + '/SKILL.md';
    const canonical = fs.readFileSync(path.join(root, rel), 'utf8');
    const wrapperFile = path.join(root, '.claude/skills', name, 'SKILL.md');
    const wrapper = fs.readFileSync(wrapperFile, 'utf8');
    const frontmatter = s => s.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
    const metadata = require('js-yaml').load(frontmatter(canonical));
    assert.equal(metadata.name, name);
    assert.equal(typeof metadata.description, 'string');
    assert.ok(metadata.description.trim());
    assert.equal(frontmatter(wrapper), frontmatter(canonical));
    assert.match(canonical, new RegExp('^name: ' + name + '$', 'm'));
    assert.match(canonical, /^description: .+$/m);
    assert.ok(rules.includes(rel), 'shared index includes ' + name);
    const target = wrapper.match(/\]\(([^)]+)\)/)[1];
    assert.equal(path.resolve(path.dirname(wrapperFile), target), path.join(root, rel));
  }
});