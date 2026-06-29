// Speech-to-text worker.
//
// Runs OpenAI Whisper locally via transformers.js (@huggingface/transformers),
// entirely offline — no API key, no network. The renderer captures microphone
// audio, slices it into utterance-sized segments, and posts each segment here
// as 16 kHz mono Float32 PCM; we transcribe it and post the text back. The
// renderer is responsible for the user dictionary / auto-space / pane routing,
// so this worker only does audio -> text.
//
// Everything is served over the hm:// scheme (see main.js): the library, its
// ONNX-runtime .wasm files, and the bundled model. file:// fetch is blocked by
// Chromium, which is why a custom scheme exists at all.
//
// This file is loaded as a module worker. Because a file:// page can't spawn a
// cross-origin (hm://) worker directly, the renderer boots us from a tiny blob
// module that does `import 'hm://app/voice-worker.js'` — so our own imports
// below resolve against hm://app/ and can reach hm://vendor + hm://models.

// NOTE: import the fully self-contained bundle (transformers.js), NOT
// transformers.web.js — the latter leaves onnxruntime as a bare
// `import 'onnxruntime-common'` specifier, which a browser worker can't resolve
// without an import map, so the whole module fails to evaluate. transformers.js
// inlines onnxruntime, so it loads over hm:// with no extra resolution.
import { pipeline, env } from 'hm://vendor/transformers.js';

// Load only the bundled model; never reach out to the Hugging Face Hub.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'hm://models/';

// Point ONNX-runtime at the .wasm shipped alongside the library. Multi-threaded
// ORT is several times faster than single-thread, and it needs SharedArrayBuffer
// — which Chromium gates behind cross-origin isolation, but Electron exposes in
// workers by default. So probe for it: use a few cores when SharedArrayBuffer is
// present, otherwise fall back to one thread (still correct, just slower). The
// WebGPU path (tried first below) is faster still when a GPU adapter exists.
env.backends.onnx.wasm.wasmPaths = 'hm://vendor/';
env.backends.onnx.wasm.numThreads =
  (typeof SharedArrayBuffer !== 'undefined')
    ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 4))
    : 1;

// Pick the model by backend so we spend the available compute on accuracy:
// WebGPU is fast enough for the larger small.en (noticeably better transcription),
// while the WASM fallback stays on the lighter base.en to keep latency sane.
// Both are bundled under models/Xenova/ by `npm run fetch-model`.
const MODEL_BY_DEVICE = {
  webgpu: 'Xenova/whisper-small.en',
  wasm: 'Xenova/whisper-base.en',
};

let transcriber = null;
let device = null;

// Decide which ONNX backends to try, in order. We CANNOT blindly try
// ['webgpu','wasm']: onnxruntime-web caches its first InferenceSession promise
// process-wide (createInferenceSession's wasmInitPromise) and never resets it on
// failure. So if a webgpu attempt rejects ("Failed to get GPU adapter"), the
// subsequent wasm attempt awaits that same cached rejection and re-throws the
// webgpu error — wasm never actually runs. To avoid poisoning that cache, only
// offer webgpu when a real adapter is obtainable; otherwise go straight to wasm.
// (`'gpu' in navigator` is true in Electron even when no adapter exists, so a
// presence check isn't enough — we must actually request the adapter.)
async function pickDevices() {
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return ['webgpu', 'wasm'];
    }
  } catch (_) { /* no usable adapter — fall through to wasm-only */ }
  return ['wasm'];
}

async function load() {
  if (transcriber) { self.postMessage({ type: 'ready', device }); return; }
  let lastErr = null;
  // Prefer WebGPU (fast, and avoids the single-thread WASM penalty) only when an
  // adapter actually exists; otherwise WASM, which works everywhere.
  for (const dev of await pickDevices()) {
    try {
      transcriber = await pipeline('automatic-speech-recognition', MODEL_BY_DEVICE[dev], {
        device: dev,
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        progress_callback: (p) => self.postMessage({ type: 'progress', data: p }),
      });
      device = dev;
      self.postMessage({ type: 'ready', device });
      return;
    } catch (err) {
      lastErr = err;
      transcriber = null;
    }
  }
  self.postMessage({
    type: 'error',
    message: (lastErr && (lastErr.message || String(lastErr))) || 'failed to load speech model',
  });
}

async function transcribe(id, audio) {
  if (!transcriber) { self.postMessage({ type: 'result', id, text: '' }); return; }
  try {
    // base.en is an English .en checkpoint: language/task are fixed, so we pass
    // only the audio. Segments are already short, so no internal chunking.
    const out = await transcriber(audio);
    const text = (out && out.text) || '';
    console.log('[voice-worker] device=' + device + ' samples=' + audio.length +
      ' text=' + JSON.stringify(text));
    self.postMessage({ type: 'result', id, text });
  } catch (err) {
    self.postMessage({ type: 'result', id, text: '', error: (err && (err.message || String(err))) });
  }
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'load') return void load();
  if (msg.type === 'transcribe') return void transcribe(msg.id, msg.audio);
};
