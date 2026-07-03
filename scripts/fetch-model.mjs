// Download the speech-to-text model so it can be bundled with the app.
//
// Runs automatically after `npm install` (postinstall, in --soft mode) and
// before `npm run dist` (predist), so the model is always present without
// anyone remembering to fetch it. Can still be run by hand: npm run fetch-model
//
// Flags:
//   --soft   Never fail the process: a download error prints a warning and
//            exits 0. Used by postinstall so an offline/CI `npm install`
//            still succeeds (voice just won't work until the model is
//            fetched). A normal `npm run fetch-model` and predist fail loudly.
//
// Files land in models/onnx-community/moonshine-base-ONNX/, which the app
// serves over the hm:// scheme and loads fully offline (see main.js +
// src/voice-worker.js). electron-builder bundles models/** automatically.
//
// Moonshine (Useful Sensors) replaces the previous Whisper checkpoints: it is
// more accurate than whisper-base.en and much faster, because its compute
// scales with the actual utterance length instead of Whisper's fixed 30-second
// window. If you still have models/Xenova/whisper-*.en directories from an
// older build, they are unused and safe to delete.

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOFT = process.argv.includes('--soft');

const MODELS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), 'models');

// Config + tokenizer files, plus the q8-quantized ONNX graphs the worker asks
// for (dtype: 'q8' -> the *_quantized.onnx files). Optional files are
// tolerated when missing from the repo.
const MODELS = {
  'onnx-community/moonshine-base-ONNX': {
    required: [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx',
    ],
    optional: [
      'special_tokens_map.json',
      'normalizer.json',
      'added_tokens.json',
      'vocab.json',
      'merges.txt',
    ],
  },
};

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
  for (const [model, files] of Object.entries(MODELS)) {
    console.log(`Fetching ${model} into ${join(MODELS_ROOT, model)}`);
    for (const f of files.required) await download(model, f, true);
    for (const f of files.optional) await download(model, f, false);
  }
  console.log('\nDone. Restart Hivemind and toggle voice typing with the ~ key.');
} catch (err) {
  if (SOFT) {
    // Postinstall path: don't break `npm install` when offline / behind a
    // proxy. Voice typing will report the missing model at runtime and the
    // user can run `npm run fetch-model` once they have a connection.
    console.warn('\nSkipped speech-model download:', err.message);
    console.warn('Voice typing will be unavailable until you run: npm run fetch-model');
    process.exit(0);
  }
  console.error('\nFailed:', err.message);
  console.error('Check your network connection and try again.');
  process.exit(1);
}
