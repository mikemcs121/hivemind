// Run: node --test scripts/test-stt-openai.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createOpenAiStt, encodeWav } = require('../stt-openai');

function setup(t, extra = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-stt-test-'));
  t.after(() => {
    const file = path.join(userData, 'openai-stt-key.enc');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(userData);
  });
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s).map(x => x ^ 0x55),
    decryptString: (b) => Buffer.from(b).map(x => x ^ 0x55).toString(),
  };
  return { userData, service: createOpenAiStt({ userData, safeStorage, env: {}, ...extra }) };
}

test('encodes a mono PCM WAV with correct sample values and rejects invalid inputs', () => {
  const wav = encodeWav(new Float32Array([-2, -1, 0, 0.5, 1, 2]));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 12);
  assert.deepEqual(Array.from({length: 6}, (_, i) => wav.readInt16LE(44 + i * 2)), [-32768, -32768, 0, 16384, 32767, 32767]);
  for (const bad of [[], new Float32Array(), new Float32Array([NaN]), new Float32Array(480001)]) assert.throws(() => encodeWav(bad));
});

test('credentials are encrypted, never returned, and removable with environment fallback', t => {
  const { service, userData } = setup(t, { env: { OPENAI_API_KEY: 'env-test' } });
  assert.equal(service.status().configured, true);
  assert.equal(service.status().saved, false);
  assert.equal(service.saveKey('sk-test-secret').ok, true);
  assert.equal(fs.readFileSync(path.join(userData, 'openai-stt-key.enc')).includes('sk-test-secret'), false);
  assert.equal(JSON.stringify(service.status()).includes('sk-test-secret'), false);
  assert.equal(service.removeKey().saved, false);
  assert.equal(service.status().configured, true);
});

test('missing key and unavailable encryption never trigger uploads or plaintext storage', async t => {
  const { service, userData } = setup(t, {
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: () => assert.fail('must not upload'),
  });
  assert.equal(service.saveKey('sk-test').ok, false);
  assert.equal(fs.existsSync(path.join(userData, 'openai-stt-key.enc')), false);
  assert.match((await service.transcribe(new Float32Array([0]))).error, /API key/);
});

test('uploads an in-memory WAV with the selected model and returns transcript text', async t => {
  const { service } = setup(t, { env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(opts.headers.Authorization, 'Bearer test-key');
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.body.get('model'), 'gpt-transcribe');
    const file = opts.body.get('file');
    assert.equal(file.type, 'audio/wav');
    assert.equal(file.name, 'speech.wav');
    assert.equal((await file.arrayBuffer()).byteLength, 48);
    return { ok: true, json: async () => ({text: ' Hello world. '}) };
  }});
  assert.deepEqual(await service.transcribe(new Float32Array([0, 1])), {ok: true, text: 'Hello world.'});
});

for (const [status, match] of [[401, /API key/], [403, /access/], [404, /unavailable/], [429, /billing/], [500, /HTTP 500/]]) {
  test('HTTP ' + status + ' gives an actionable error without exposing the response', async t => {
    const { service } = setup(t, { env: { OPENAI_API_KEY: 'secret' }, fetchImpl: async () => ({ok: false, status, json: () => assert.fail('do not reflect API error bodies')}) });
    const result = await service.transcribe(new Float32Array([0]));
    assert.equal(result.ok, false); assert.match(result.error, match); assert.doesNotMatch(result.error, /secret/);
  });
}

test('network failures redact raw details and malformed responses fail clearly', async t => {
  let malformed = false;
  const { service } = setup(t, { env: { OPENAI_API_KEY: 'secret' }, fetchImpl: async () => {
    if (!malformed) throw new Error('network details containing secret');
    return {ok: true, json: async () => ({})};
  }});
  assert.doesNotMatch((await service.transcribe(new Float32Array([0]))).error, /secret/);
  malformed = true;
  assert.match((await service.transcribe(new Float32Array([0]))).error, /invalid transcript/);
});

test('timeout and cancellation settle pending requests', async t => {
  const { service } = setup(t, { env: { OPENAI_API_KEY: 'test' }, timeoutMs: 10,
    fetchImpl: (_url, {signal}) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  assert.match((await service.transcribe(new Float32Array([0]))).error, /timed out/);
  const pending = service.transcribe(new Float32Array([0]));
  service.cancel();
  assert.match((await pending).error, /cancelled/);
});

const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function renderer() {
  const requests = [], results = [];
  const c = vm.createContext({ Promise, Float32Array, requests, results,
    window: {api: {stt: {
      openaiTranscribe: audio => new Promise(resolve => requests.push({audio, resolve})),
      openaiCancel: () => {},
    }}},
    renderVoiceListening: () => {},
    onSttResult: (text, error) => { c.sttInFlight--; results.push({text, error}); },
  });
  vm.runInContext('var sttCloud = true, sttNative = false, sttEpoch = 0, sttInFlight = 0, sttCloudQueue = Promise.resolve();\n' + fn('postSegment'), c);
  return c;
}
test('cloud phrases are delivered in order and count stays pending until the last result', async () => {
  const c = renderer();
  c.postSegment(new Float32Array([1])); c.postSegment(new Float32Array([2]));
  await Promise.resolve();
  assert.equal(c.requests.length, 1); assert.equal(c.sttInFlight, 2);
  c.requests[0].resolve({ok: true, text: 'First'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.requests.length, 2); assert.equal(c.sttInFlight, 1);
  c.requests[1].resolve({ok: true, text: 'Second'});
  await c.sttCloudQueue;
  assert.deepEqual(c.results.map(r => r.text), ['First', 'Second']);
  assert.equal(c.sttInFlight, 0);
});
test('engine reset ignores stale cloud results and skips queued uploads', async () => {
  const c = renderer();
  c.postSegment(new Float32Array([1])); c.postSegment(new Float32Array([2]));
  await Promise.resolve();
  c.sttEpoch++; c.sttInFlight = 0;
  c.requests[0].resolve({ok: true, text: 'Stale'});
  await c.sttCloudQueue;
  assert.equal(c.results.length, 0); assert.equal(c.requests.length, 1);
  assert.equal(c.sttInFlight, 0);
});

test('cloud failure stops capture, cancels remaining uploads, and never auto-sends partial text', () => {
  const sent = [], errors = [];
  const c = vm.createContext({console: {log: () => {}}, sent, errors,
    sttInFlight: 2, sttCloud: true, voiceActive: true,
    hmChatSendOnStop: true, voiceTrainCheckOnStop: true,
    currentVoicePane: () => null,
    flagVoiceError: error => errors.push(error), voiceErrMessage: err => err.message,
    stopVoice: options => { assert.equal(options.send, false); c.voiceActive = false; },
    resetSttWorker: () => { c.sttInFlight = 0; c.sttCloud = false; c.reset = true; },
    commitVoiceText: text => sent.push(text),
    hmChatVoiceSend: () => assert.fail('must not send partial text'),
    voiceTrainCheck: () => assert.fail('must not evaluate partial text'),
    renderVoiceListening: () => {},
  });
  vm.runInContext(fn('onSttResult'), c);
  c.onSttResult('', 'OpenAI usage limit reached.');
  assert.equal(c.reset, true); assert.equal(c.voiceActive, false);
  assert.equal(c.hmChatSendOnStop, false); assert.equal(c.voiceTrainCheckOnStop, false);
  assert.deepEqual(sent, []); assert.deepEqual(errors, ['OpenAI usage limit reached.']);
});

test('the final cloud result is committed before a deferred send', () => {
  const events = [];
  const c = vm.createContext({console: {log: () => {}}, events,
    sttInFlight: 1, sttCloud: true, voiceActive: false,
    hmChatSendOnStop: true, voiceTrainCheckOnStop: false,
    currentVoicePane: () => null,
    commitVoiceText: text => events.push(text),
    hmChatVoiceSend: () => events.push('SEND'), renderVoiceListening: () => {},
  });
  vm.runInContext(fn('onSttResult'), c);
  c.onSttResult('Last phrase.');
  assert.deepEqual(events, ['Last phrase.', 'SEND']);
});
