// Download the Whisper speech-to-text model so it can be bundled with the app.
//
// Run once after `npm install`:   npm run fetch-model
//
// Files land in models/Xenova/whisper-base.en/, which the app serves over the
// hm:// scheme and loads fully offline (see main.js + src/voice-worker.js).
// electron-builder bundles models/** automatically.

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two checkpoints: small.en for the fast WebGPU path (more accurate) and base.en
// for the WASM fallback (lighter, lower latency). The voice worker picks one by
// backend at load time (see src/voice-worker.js).
const MODELS = ['Xenova/whisper-small.en', 'Xenova/whisper-base.en'];
const MODELS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), 'models');

// Required config + tokenizer files, plus the q8-quantized ONNX graphs the
// worker asks for (dtype: 'q8'). Optional files are tolerated when missing.
const REQUIRED = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];
const OPTIONAL = [
  'normalizer.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'vocab.json',
  'merges.txt',
];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function download(model, file, required) {
  const dest = join(MODELS_ROOT, model, file);
  if (await exists(dest)) { console.log(`  ✓ ${file} (already present)`); return true; }
  const url = `https://huggingface.co/${model}/resolve/main/${file}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (!required && (res.status === 404)) { console.log(`  – ${file} (not in repo, skipped)`); return true; }
    throw new Error(`${file}: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`  ✓ ${file} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return true;
}

try {
  for (const model of MODELS) {
    console.log(`Fetching ${model} into ${join(MODELS_ROOT, model)}`);
    for (const f of REQUIRED) await download(model, f, true);
    for (const f of OPTIONAL) await download(model, f, false);
  }
  console.log('\nDone. Restart Hivemind and toggle voice typing with the ~ key.');
} catch (err) {
  console.error('\nFailed:', err.message);
  console.error('Check your network connection and try again.');
  process.exit(1);
}
