// Focused regression tests for chat's CLI boundary. No agent or GUI required.
// Run: node --test scripts/test-chat.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/renderer.js'), 'utf8');
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function setup(screen = '') {
  const sent = [], timers = [];
  const c = vm.createContext({
    sent, timers, screen, console,
    setTimeout: f => { timers.push(f); },
    sendToPane: (_, data) => sent.push(data),
    screenText: () => c.screen,
    chatHasPendingQuestion: p => !!p.pending,
    SUBMIT_RETRY_MS: 1000,
  });
  const patterns = source.slice(source.indexOf('const SELECT_FOOTER_RE ='), source.indexOf('// Prose questions'));
  vm.runInContext(patterns + '\n' + [
    'joinWrapped', 'menuOnScreen', 'chatComposerBlocked', 'typePrompt', 'confirmSubmit',
  ].map(fn).join('\n') + '\nconst flattenRows = rows => rows.join(" ").replace(/\\s+/g," ").trim();\n' +
    'function promptStuckOnScreen(screen, head) { return screen.includes(head); }', c);
  return c;
}
test('finished prose question allows a reply and actually presses Enter', () => {
  const c = setup('Would you like to continue?\n> ');
  const p = { id: 'one', agent: 'claude', state: 'attention' };
  assert.equal(c.chatComposerBlocked(p), false);
  c.typePrompt(p, 'yes');
  c.timers.shift()();
  assert.deepEqual(c.sent, ['\x1b[200~yes\x1b[201~', '\r']);
});
test('submit retry is not blocked by prose or stale attention', () => {
  const c = setup('Would you like to continue?\n> yes');
  c.confirmSubmit({id:'one', state:'attention'}, 'one', 'yes', 2, {owesEnter:true});
  c.timers.shift()();
  assert.deepEqual(c.sent, ['\r']);
});
for (const [name, screen, extra] of [
  ['numbered approval', '1. Yes\n2. No', {}],
  ['wrapped menu footer', 'Enter to select ·\nEsc to cancel', {}],
  ['yes/no prompt', 'Continue? (y/n)', {}],
  ['press-enter prompt', 'Press Enter to continue', {}],
  ['authentication', '', {needsAuth:true}],
  ['pending question', '', {pending:true}],
]) test(`${name} blocks composer and delayed submission`, () => {
  const c = setup(screen), p = {id:'one', agent:'claude', state:'busy', ...extra};
  assert.equal(c.chatComposerBlocked(p), true);
  c.typePrompt(p, 'test');
  c.timers.shift()();
  assert.equal(c.sent.includes('\r'), false);
  c.timers.shift()();
  assert.equal(c.sent.includes('\r'), false);
});
test('respawn between paste and Enter cancels delayed submission', () => {
  const c = setup(), p = {id:'one', agent:'claude'};
  c.typePrompt(p, 'hello'); p.id = 'two'; c.timers.shift()();
  assert.equal(c.sent.includes('\r'), false);
});
test('menu appearing during paste prevents accidental approval', () => {
  const c = setup(), p = {id:'one', agent:'claude'};
  c.typePrompt(p, 'hello'); c.screen = '1. Yes\n2. No'; c.timers.shift()();
  assert.equal(c.sent.includes('\r'), false);
});

test('an early transcript question does not dismiss the still-live menu', () => {
  let removed = 0;
  const c = vm.createContext({
    upsertChatRow: () => {}, updateChatBanner: () => {},
    removeScreenQuestion: () => removed++,
  });
  vm.runInContext(fn('addQuestionRow'), c);
  const pane = {chat:{screenQSig:'live-menu', toolByUseId:new Map(),
    pendingQuestions:new Map(), pendingResults:new Map()}};
  c.addQuestionRow(pane, 'transcript-row', {id:'question-1', input:{questions:[{question:'Which color?'}]}});
  assert.equal(removed, 0);
  assert.equal(pane.chat.screenQSupSig, undefined);
  assert.equal(pane.chat.pendingQuestions.has('question-1'), true);
});

test('transcript batches reconcile the live question even after output goes quiet', () => {
  let syncs = 0;
  const c = vm.createContext({renderChatEntries:()=>{}, syncScreenQuestion:()=>syncs++,
    screenQuestionKey:()=> 'screenq:one', chatHasPendingQuestion:()=>false});
  vm.runInContext(fn('chatIngest'), c);
  c.chatIngest({chat:{byKey:new Map()}}, [], false);
  assert.equal(syncs, 1);
});

test('Codex approval includes command and reason, not just option labels', () => {
  const c = setup();
  vm.runInContext(source.slice(source.indexOf('const SCREEN_OPT_RE ='), source.indexOf('function previewCutColumn')) +
    '\n' + source.slice(source.indexOf('const CODEX_APPROVAL_HEAD_RE ='), source.indexOf('const screenQuestionKey =')), c);
  const parsed = c.parseCodexApproval({agent:'codex'}, [
    'Would you like to run the following command?',
    'Reason: Verify the fixture', '$ node check.js', '',
    '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)',
    'Press enter to confirm or esc to cancel',
  ].join('\n'));
  assert.ok(parsed.question.includes('$ node check.js'));
  assert.ok(parsed.question.includes('Reason: Verify the fixture'));
  assert.equal(parsed.options[0].label, 'Yes, proceed');
});
