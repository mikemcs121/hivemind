// Speech-to-text worker.
//
// Runs Moonshine (Useful Sensors) locally via transformers.js
// (@huggingface/transformers), entirely offline — no API key, no network. The
// renderer captures microphone audio, slices it into utterance-sized segments,
// and posts each segment here as 16 kHz mono Float32 PCM; we transcribe it and
// post the text back. The renderer is responsible for the user dictionary /
// auto-space / pane routing, so this worker does audio -> text plus one more
// job: per-frame speech probabilities from the Silero VAD model ('vad'
// messages), which the renderer's segmenter uses to decide where an utterance
// starts and ends. Silero shares the ONNX runtime already loaded here, so the
// extra cost is just its ~2 MB of weights.
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
import { pipeline, env, AutoModel, Tensor } from 'hm://vendor/transformers.js';

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

// -- Silero VAD --------------------------------------------------------------
// A tiny recurrent model (bundled, see scripts/fetch-model.mjs) that scores
// each 512-sample chunk of 16 kHz audio with a speech probability. It replaced
// the renderer's pure loudness gate for deciding utterance boundaries: a
// loudness gate clips soft word onsets and mistakes keyboard clatter for
// speech, and every such mis-cut segment becomes a mistranscription. Loading
// or inference failures are non-fatal — the renderer keeps its energy-gate
// fallback for any frame we can't score.
const VAD_MODEL = 'onnx-community/silero-vad';
const VAD_CHUNK = 512;              // samples per Silero step at 16 kHz
let vadModel = null;
let vadSrTensor = null;             // constant sample-rate input
let vadState = null;                // recurrent state, carried chunk to chunk
let vadStateGen = null;             // capture session the state belongs to
let vadQueue = Promise.resolve();   // serializes inference so state stays ordered

async function loadVad() {
  if (vadModel) return;
  try {
    vadModel = await AutoModel.from_pretrained(VAD_MODEL, {
      config: { model_type: 'custom' },
      dtype: 'fp32',
      device: 'wasm',
    });
    vadSrTensor = new Tensor('int64', new BigInt64Array([16000n]), []);
    self.postMessage({ type: 'vadstatus', ok: true });
  } catch (err) {
    vadModel = null;
    self.postMessage({
      type: 'vadstatus', ok: false,
      message: (err && (err.message || String(err))) || 'failed to load VAD model',
    });
  }
}

// Speech probability for one chunk; the state threading makes order matter,
// which is why callers go through vadQueue.
async function vadProb(chunk) {
  const input = new Tensor('float32', chunk, [1, chunk.length]);
  const out = await vadModel({ input, sr: vadSrTensor, state: vadState });
  vadState = out.stateN;
  return out.output.data[0];
}

// One renderer frame (a multiple of VAD_CHUNK): score every chunk, reply with
// the max — onset sensitivity matters more than a smoothed average at 64 ms
// granularity. `gen` identifies the capture session; a new session gets a
// fresh recurrent state. Always replies (prob: null on any failure) so the
// renderer's frame/verdict pairing never desyncs.
function handleVad(msg) {
  vadQueue = vadQueue.then(async () => {
    let prob = null;
    if (vadModel && msg.audio && msg.audio.length >= VAD_CHUNK) {
      try {
        if (msg.gen !== vadStateGen) {
          vadStateGen = msg.gen;
          vadState = new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
        }
        for (let i = 0; i + VAD_CHUNK <= msg.audio.length; i += VAD_CHUNK) {
          const p = await vadProb(msg.audio.subarray(i, i + VAD_CHUNK));
          prob = (prob == null) ? p : Math.max(prob, p);
        }
      } catch (_) { prob = null; }
    }
    self.postMessage({ type: 'vad', gen: msg.gen, prob });
  });
}

async function load(msg) {
  const model = (msg && msg.model) || DEFAULT_MODEL;
  const dtype = (msg && msg.dtype) || DEFAULT_DTYPE;
  // VAD first: it is small and fast, so utterance boundaries work almost
  // immediately even while the (much larger) speech model is still loading.
  await loadVad();
  // vadOnly: transcription happens elsewhere (a native model in the main
  // process); this worker exists just to score VAD frames.
  if (msg && msg.vadOnly) { self.postMessage({ type: 'ready', device: 'wasm' }); return; }
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
  if (msg.type === 'vad') return void handleVad(msg);
};
