// Speech-to-text worker.
//
// Runs Moonshine (Useful Sensors) locally via transformers.js
// (@huggingface/transformers), entirely offline — no API key, no network. The
// renderer captures microphone audio, slices it into utterance-sized segments,
// and posts each segment here as 16 kHz mono Float32 PCM; we transcribe it and
// post the text back. The renderer is responsible for the user dictionary /
// auto-space / pane routing, so this worker only does audio -> text.
//
// Moonshine replaced the earlier Whisper checkpoints because it is both more
// accurate than whisper-base.en and far lower-latency: Whisper zero-pads every
// input to a fixed 30-second window (so a 2-second utterance costs a full 30s
// encoder pass), while Moonshine's compute scales with the actual audio length.
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
// ORT is several times faster than single-thread, and it needs
// SharedArrayBuffer — which main.js force-enables via the Chromium
// "SharedArrayBuffer" feature flag (a plain file:// window is not cross-origin
// isolated, so without the flag SAB is absent and ORT silently drops to one
// thread). Probe anyway so we still work, just slower, if the flag ever stops
// applying.
env.backends.onnx.wasm.wasmPaths = 'hm://vendor/';
env.backends.onnx.wasm.numThreads =
  (typeof SharedArrayBuffer !== 'undefined')
    ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 4))
    : 1;

// The model id + dtype now come from the renderer's `load` message (see the
// STT_MODELS registry in renderer.js), so the user can pick between English
// speech models at runtime. These are the defaults if the message omits them.
// WASM is the only backend: this Electron (29 / Chromium 122) exposes no
// navigator.gpu in windows or workers, so a WebGPU path can't run at all —
// re-probe if Electron is ever upgraded.
const DEFAULT_MODEL = 'onnx-community/moonshine-base-ONNX';
const DEFAULT_DTYPE = { encoder_model: 'q8', decoder_model_merged: 'q8' };

let transcriber = null;

async function load(msg) {
  const model = (msg && msg.model) || DEFAULT_MODEL;
  const dtype = (msg && msg.dtype) || DEFAULT_DTYPE;
  if (transcriber) { self.postMessage({ type: 'ready', device: 'wasm' }); return; }
  try {
    // English-only, q8-quantized; the model's files are served over hm://models
    // (bundled for the default, downloaded into userData for the rest).
    transcriber = await pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype,
      progress_callback: (p) => self.postMessage({ type: 'progress', data: p }),
    });
    // Warm-up: the first inference pays one-off WASM compilation/allocation
    // costs. Run half a second of silence through the model now (output
    // discarded) so the user's first real utterance comes back fast.
    try { await transcriber(new Float32Array(8000)); } catch (_) { /* non-fatal */ }
    self.postMessage({ type: 'ready', device: 'wasm' });
  } catch (err) {
    transcriber = null;
    self.postMessage({
      type: 'error',
      message: (err && (err.message || String(err))) || 'failed to load speech model',
    });
  }
}

async function transcribe(id, audio) {
  if (!transcriber) { self.postMessage({ type: 'result', id, text: '' }); return; }
  try {
    // Moonshine is an English-only model: language/task are fixed, so we pass
    // only the audio. Segments are already short, so no internal chunking.
    const out = await transcriber(audio);
    const text = (out && out.text) || '';
    console.log('[voice-worker] samples=' + audio.length +
      ' text=' + JSON.stringify(text));
    self.postMessage({ type: 'result', id, text });
  } catch (err) {
    self.postMessage({ type: 'result', id, text: '', error: (err && (err.message || String(err))) });
  }
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'load') return void load(msg);
  if (msg.type === 'transcribe') return void transcribe(msg.id, msg.audio);
};
