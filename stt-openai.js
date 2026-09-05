'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The microphone supplies mono float samples at 16 kHz. Keep recordings in
// memory; only the encrypted credential is persisted.
function encodeWav(audio) {
  if (!(audio instanceof Float32Array) || !audio.length || audio.length > 16000 * 30) {
    throw new Error('OpenAI transcription needs between 0 and 30 seconds of speech.');
  }
  const wav = Buffer.alloc(44 + audio.length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(audio.length * 2, 40);
  for (let i = 0; i < audio.length; i++) {
    if (!Number.isFinite(audio[i])) throw new Error('OpenAI transcription received invalid microphone samples.');
    const sample = Math.max(-1, Math.min(1, audio[i]));
    wav.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return wav;
}

function createOpenAiStt({ userData, safeStorage, fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 30000 }) {
  const keyFile = path.join(userData, 'openai-stt-key.enc');
  const requests = new Set();
  function encryptionAvailable() {
    return safeStorage.isEncryptionAvailable() &&
      (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  }
  function readKey() {
    if (fs.existsSync(keyFile)) {
      try {
        if (!encryptionAvailable()) throw new Error();
        return safeStorage.decryptString(fs.readFileSync(keyFile));
      } catch (_) {
        throw new Error('OpenAI API key could not be unlocked. Save it again in Settings → Voice.');
      }
    }
    return (env.OPENAI_API_KEY || '').trim();
  }
  function status() {
    try {
      return { ok: true, configured: !!readKey(), saved: fs.existsSync(keyFile), canSave: encryptionAvailable() };
    } catch (err) { return { ok: false, error: err.message, saved: fs.existsSync(keyFile) }; }
  }
  function cancel() { for (const controller of requests) controller.abort(); }
  function saveKey(key) {
    if (typeof key !== 'string' || !key.trim() || /\s/.test(key.trim()) || key.length > 1024) {
      return { ok: false, error: 'Enter a valid OpenAI API key.' };
    }
    try {
      if (!encryptionAvailable()) return { ok: false, error: 'Secure key storage is unavailable. Set OPENAI_API_KEY before launching Hivemind.' };
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(keyFile, safeStorage.encryptString(key.trim()), { mode: 0o600 });
      cancel();
      return status();
    } catch (_) { return { ok: false, error: 'OpenAI API key could not be saved securely.' }; }
  }
  function removeKey() {
    try {
      if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
      cancel();
      return status();
    } catch (_) { return { ok: false, error: 'OpenAI API key could not be removed.' }; }
  }
  async function transcribe(audio) {
    let controller, timer;
    let timedOut = false;
    try {
      const key = readKey();
      if (!key) return { ok: false, error: 'Add an OpenAI API key in Settings → Voice before using cloud transcription.' };
      const wav = encodeWav(audio);
      const body = new FormData();
      body.append('model', 'gpt-transcribe');
      body.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
      controller = new AbortController();
      requests.add(controller);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + key }, body,
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) {
        const errors = {
          401: 'OpenAI rejected the API key. Replace it in Settings → Voice.',
          403: 'This OpenAI project cannot use transcription. Check its model access.',
          404: 'GPT-Transcribe is unavailable for this OpenAI project. Check its model access.',
          429: 'OpenAI usage limit reached. Check API billing or wait before trying again.',
        };
        return { ok: false, error: errors[response.status] || 'OpenAI transcription failed (HTTP ' + response.status + '). Try again.' };
      }
      const result = await response.json();
      if (typeof result.text !== 'string') return { ok: false, error: 'OpenAI returned an invalid transcript. Try again.' };
      return { ok: true, text: result.text.trim() };
    } catch (err) {
      // Never surface raw network/API errors: they can contain credentials.
      if (timedOut) return { ok: false, error: 'OpenAI transcription timed out. Check your connection and try again.' };
      if (controller && controller.signal.aborted) return { ok: false, error: 'OpenAI transcription cancelled.' };
      if (!controller) return { ok: false, error: /^OpenAI /.test(err.message) ? err.message : 'OpenAI transcription could not start.' };
      return { ok: false, error: 'Could not reach OpenAI transcription. Check your internet connection and try again.' };
    } finally {
      clearTimeout(timer);
      if (controller) requests.delete(controller);
    }
  }
  return { status, saveKey, removeKey, transcribe, cancel };
}

module.exports = { createOpenAiStt, encodeWav };
