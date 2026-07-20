'use strict';

// Native speech-to-text engine host.
//
// Runs in an Electron utilityProcess (a plain Node child), spawned by main.js
// when the user picks a native speech model (see STT_NATIVE there). Models
// like NVIDIA's Parakeet TDT 0.6B are far more accurate than anything the
// renderer's WASM worker can carry, but they need real native inference:
// sherpa-onnx gets full multi-core CPU here, and a dedicated process means a
// multi-hundred-millisecond decode (or a native crash) can never stall or take
// down the app. Everything stays on-device and offline, same as the WASM path.
//
// Protocol (all via parentPort):
//   in : { type:'load', config, numThreads }  config = absolute file paths
//   out: { type:'ready' } | { type:'error', message }
//   in : { type:'transcribe', id, audio: Float32Array, sampleRate? }
//   out: { type:'result', id, text, error? }
//
// Decoding is synchronous on this process's loop, so queued 'transcribe'
// messages serialize naturally in arrival order.

let recognizer = null;

function post(msg) { process.parentPort.postMessage(msg); }

function load(msg) {
  try {
    const sherpa = require('sherpa-onnx-node');
    const cfg = msg.config || {};
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: cfg.encoder,
          decoder: cfg.decoder,
          joiner: cfg.joiner,
        },
        tokens: cfg.tokens,
        modelType: cfg.modelType || 'nemo_transducer',
        numThreads: msg.numThreads || 4,
        provider: 'cpu',
        debug: 0,
      },
    });
    post({ type: 'ready' });
  } catch (err) {
    recognizer = null;
    post({ type: 'error', message: (err && (err.message || String(err))) || 'failed to load native speech model' });
  }
}

function transcribe(msg) {
  if (!recognizer) { post({ type: 'result', id: msg.id, text: '', error: 'engine not loaded' }); return; }
  try {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: msg.sampleRate || 16000, samples: msg.audio });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    post({ type: 'result', id: msg.id, text: ((result && result.text) || '').trim() });
  } catch (err) {
    post({ type: 'result', id: msg.id, text: '', error: (err && (err.message || String(err))) || 'decode failed' });
  }
}

process.parentPort.on('message', (ev) => {
  const msg = (ev && ev.data) || {};
  if (msg.type === 'load') return load(msg);
  if (msg.type === 'transcribe') return transcribe(msg);
});
