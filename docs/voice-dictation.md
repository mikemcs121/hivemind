# Voice dictation

## Purpose

Voice typing lets the user dictate straight into the focused thread (or into the "Chat with
Hivemind" dialog, or the dictionary-training modal). Speech is transcribed **locally and
offline** — there is no cloud speech API, no API key, and no network use at transcription
time. Two engine kinds exist: transformers.js models (Moonshine default) running in a web
worker, and **native models** (Parakeet TDT 0.6B) decoded by `sherpa-onnx` in a main-process
utility process (`stt-native.js`) for far higher accuracy. Toggled with the `~` key, the 🎤
toolbar button, or the spoken commands "start/stop voice typing".

## Architecture

The full pipeline, all in the renderer process except where noted:

1. **Mic capture** — `startCapture()` at `src/renderer.js:9040`. `getUserMedia` opens the mic
   (permission granted by main-process handlers at `main.js:339-358`; everything else is
   denied). An `AudioContext` runs at 16 kHz (`STT_SAMPLE_RATE`, `renderer.js:8517`); an
   inline `AudioWorkletProcessor` (`'hm-mic-capture'`, `renderer.js:9053`) rebuffers render
   quanta into 1024-sample (64 ms) Float32 frames and transfers them to the main renderer
   thread (`ScriptProcessor` fallback at `renderer.js:9081`). A muted gain sink keeps the
   graph pulling audio.
2. **VAD + segmentation** — each frame goes to the worker as a `vad` message and is queued in
   `vadAwait` until its Silero speech probability comes back (`onAudioFrame`
   `renderer.js:8966`, `onVadVerdict` `renderer.js:8991`, `applyVadDecision`
   `renderer.js:9000`). The segmenter (tunables at `renderer.js:8517-8527`: 0.4 enter / 0.15
   exit probability, 550 ms trailing silence, 250 ms minimum, 15 s max, 320 ms pre-roll)
   accumulates frames while speech is detected and flushes an utterance-sized segment. If the
   worker can't score frames (model loading, Silero failed, >500 unanswered verdicts) it
   degrades to an adaptive RMS energy gate.
3. **Transcription** — `flushSegment()` (`renderer.js:8925`) concatenates the frames and hands
   the utterance to `postSegment()`, which routes by engine: worker models get a `transcribe`
   message (buffer transferred); when `sttNative` is set the segment goes over IPC
   (`window.api.stt.nativeTranscribe`) to the sherpa utility process instead. Both paths land
   in the shared `onSttResult()` funnel, so in-flight counting and deferred sends behave the
   same. Segments spoken while the model is still loading queue in `sttPending` (capped at
   ~60 s of audio) and flush when the active engine is ready.
4. **Worker** — `src/voice-worker.js`, a module worker booted from a blob shim
   (`bootSttWorker`, `renderer.js:8847`) that does `import 'hm://app/voice-worker.js'`,
   because a `file://` page can't spawn a cross-origin `hm://` worker directly. The worker
   runs **two** ONNX models via **transformers.js** (`@huggingface/transformers`, the
   self-contained `transformers.js` bundle — *not* `transformers.web.js`, whose bare
   `onnxruntime-common` import can't resolve in a worker; see `voice-worker.js:28`):
   - the ASR pipeline (Moonshine by default, model id/dtype supplied by the `load` message);
   - Silero VAD (`voice-worker.js:64-130`), sharing the same WASM ONNX runtime, recurrent
     state threaded per capture session (`gen`), inference serialized through `vadQueue`.
   Backend is WASM only — Electron 29 exposes no `navigator.gpu`, so there is no WebGPU path
   (`voice-worker.js:56-58`). Multi-threaded WASM needs `SharedArrayBuffer`, force-enabled at
   `main.js:21`.
5. **hm:// protocol (main process)** — Chromium refuses `fetch()` of `file://` URLs, so
   `main.js:41-103` serves everything the worker needs over a privileged custom scheme:
   `hm://app/` → `src/`, `hm://vendor/` → `node_modules/@huggingface/transformers/dist/`
   (library + ORT `.wasm`), `hm://models/` → `userData/models/` **then** the bundled
   `models/` (first root containing the file wins).
6. **Where text lands** — `commitVoiceText()` (`renderer.js:8744`) routes each transcript, in
   priority order: training modal → "Chat with Hivemind" dialog input → the target pane. For a
   pane in chat view it is inserted into the composer textarea at the caret; otherwise it is
   sent as keystrokes via `sendToPane()`. Before insertion the text passes through the user
   voice dictionary (`applyVoiceDict`, `renderer.js:8547`), the auto-Enter phrase check
   (`VOICE_ENTER_RE`, `renderer.js:8482` — "press enter", "submit", …), the "Hivemind, …"
   spoken-command matcher, and the "todo …" prefix capture.

**Native engine (sherpa-onnx).** Models flagged `native: true` in `STT_MODELS` don't run in
the worker at all. `ensureSttWorker` (`renderer.js`) then boots the worker **VAD-only**
(`load` message with `vadOnly: true` — Silero still scores frames there) and asks main to
start the real engine: `stt:nativeLoad` (main.js) spawns `stt-native.js` via
`utilityProcess.fork`, which requires `sherpa-onnx-node` (^1.13.4, N-API prebuilt — no
electron-rebuild) and builds an `OfflineRecognizer` from the `STT_NATIVE` registry's file
layout (main.js, next to `STT_DOWNLOADS`). Decoding runs with full multi-core CPU
(`numThreads = min(cores-2, 8)`) in that child process, so inference can never stall the UI
and a native crash can't take down the app — main resolves all pending transcriptions with an
error and the renderer surfaces it. One engine at a time; a model switch or app quit kills it
(`stopNativeStt`, also wired to `will-quit`).

## Models

Registry: `STT_MODELS` in `src/renderer.js:8467`; download manifest: `STT_DOWNLOADS` in
`main.js:52`. The two must stay in sync — a repo offered in the renderer but missing from
`STT_DOWNLOADS` can never download.

| Model (HF repo id) | Role | Shipped | Location |
| --- | --- | --- | --- |
| `onnx-community/moonshine-base-ONNX` | Default STT (English, q8, worker) | Bundled | `models/` in the app (asar-unpacked) |
| `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` | Optional STT, **native** (English, int8, ~630 MB, best accuracy) | Downloaded on first selection | `userData/models/<repo>/` |
| `onnx-community/whisper-base.en` | Optional STT (English, q8, worker) | Downloaded on first selection | `userData/models/<repo>/` |
| `onnx-community/silero-vad` | Utterance boundary detection (~2 MB, fp32) | Bundled | `models/` in the app |

Native models additionally need a row in `STT_NATIVE` (main.js) mapping the repo to its
recognizer file layout (`encoder/decoder/joiner/tokens`, `modelType: 'nemo_transducer'`).

Moonshine replaced earlier Whisper checkpoints as the default because its compute scales with
utterance length, while Whisper zero-pads every input to 30 s (`voice-worker.js:14-17`). The
q8 dtype maps to the `*_quantized.onnx` graph files.

Path resolution:

- **Dev**: `models/` at the repo root, populated by `scripts/fetch-model.mjs`.
- **Packaged**: `package.json` `build.asarUnpack` includes `models/**` and
  `node_modules/@huggingface/transformers/dist/**`, so both are real files on disk (ONNX/WASM
  can't load from inside the asar). `__dirname`-relative paths in `HM_ROOTS` resolve into
  `app.asar.unpacked` transparently.
- **User downloads**: `userData/models/` (writable, survives app updates) is searched *before*
  the bundled `models/`, so a downloaded model shadows a bundled one of the same repo id.

`scripts/fetch-model.mjs` downloads the bundled models (Moonshine + Silero) from the Hugging
Face Hub into `models/`, skipping files already present, tolerating 404 on optional files, and
locally generating Silero's missing `config.json` (`{"model_type":"custom"}`). It runs as
`postinstall` with `--soft` (download failure warns and exits 0 so offline `npm install` still
succeeds — voice just reports a missing model at runtime) and can be run by hand via
`npm run fetch-model` (fails loudly). Non-default models are fetched at runtime instead by the
`stt:ensureModel` IPC handler (`main.js:858`), file-by-file with `stt:downloadProgress` events.

## Settings

All voice settings persist in renderer **localStorage** (per userData profile). UI lives in the
Settings modal's Voice tab (`#settings-modal` in `src/index.html`; fields wired at
`renderer.js:9282-9375` and `renderer.js:10095-10132`).

| Setting (UI) | localStorage key | Default | Behavior |
| --- | --- | --- | --- |
| `~` hotkey enabled (`#voice-hotkey-enabled`) | `hm.voiceHotkey` | on | `~` toggles voice unless typing in a field (`renderer.js:9261`) |
| Auto-Enter (`#voice-auto-enter`) | `hm.voiceAutoEnter` | off | Bare "press enter"/"submit"/"send it" submits the line |
| Auto-space (`#voice-auto-space`) | `hm.voiceAutoSpace` | on | Appends a trailing space to each committed utterance |
| Spoken replies (`#voice-reply-enabled`) | `hm.voiceReply` | off | speechSynthesis reads Hivemind-chat replies aloud |
| Speech model (`#voice-model`) | `hm.voiceModel` | Moonshine Base | Change handler (`renderer.js:10115`) saves, terminates the worker (`resetSttWorker`, `renderer.js:8816`), and restarts dictation if it was active — triggering download + reload of the new model |
| Voice dictionary (from/to rows) | `hm.voiceDict` | small default list (`renderer.js:8436`) | Ordered find/replace applied to every utterance (`applyVoiceDict`) |
| (implicit) correction learning | `hm.voiceLearn` | — | Heard→corrected pairs harvested from user edits; after 2 sightings offers "add to dictionary?" (`renderer.js:8565-8730`) |

"Train dictionary" (Settings → Voice, or say "train dictionary") opens a practice modal
(`renderer.js:9436` onward) that drills sentences built from the user's own prompts and
proposes dictionary entries for whatever the model misheard.

## Message protocol

Renderer → worker (`voice-worker.js:176`):

| Type | Payload | Meaning |
| --- | --- | --- |
| `load` | `{ model, dtype }` | Load Silero VAD, then the ASR pipeline. Omitted fields fall back to worker defaults (`voice-worker.js:59`). |
| `transcribe` | `{ id, audio }` (Float32Array, transferred) | Transcribe one utterance segment. |
| `vad` | `{ gen, audio }` (one 1024-sample frame) | Score speech probability; `gen` identifies the capture session (new gen = fresh recurrent state). |

Worker → renderer (handled in `bootSttWorker`, `renderer.js:8859`):

| Type | Payload | Meaning |
| --- | --- | --- |
| `ready` | `{ device: 'wasm' }` | ASR pipeline loaded and warmed up (0.5 s of silence pre-run). |
| `progress` | `{ data }` (transformers.js progress object) | Model file load/download progress → HUD percentage. |
| `error` | `{ message }` | ASR pipeline failed to load (fatal for this worker). |
| `result` | `{ id, text, error? }` | Transcription for segment `id`; empty text + `error` = per-utterance inference failure; empty text, no error = "didn't catch that". |
| `vad` | `{ gen, prob }` | Max Silero probability over the frame; `prob: null` on any failure (the reply is *always* sent so frame/verdict FIFO pairing never desyncs). |
| `vadstatus` | `{ ok, message? }` | Silero loaded or not (not fatal — energy gate fallback). |

IPC (preload `window.api`, `preload.js`):

| Call | Returns / payload |
| --- | --- |
| `stt.ensureModel(repo)` | `{ ok, alreadyPresent?, error? }` — streams each file to `<name>.part`, renames on completion (no truncated files, no whole-file buffering) |
| `stt.nativeLoad(repo)` | `{ ok, error? }` — spawns/loads the sherpa utility process (idempotent per repo) |
| `stt.nativeTranscribe(audio)` | `{ ok, text, error? }` — one utterance (Float32Array) through the native engine |
| `stt.nativeStop()` | fire-and-forget kill of the utility process |
| `onSttDownloadProgress(cb)` | `{ repo, done, total, file, bytes, totalBytes }` — byte fields let the HUD show MB progress on big files (>20 MB) instead of a stuck file count |

The worker's `load` message also accepts `{ vadOnly: true }` (no model/dtype): load Silero,
post `ready`, never load a transcriber. Used whenever the active model is native. In that mode
the worker's `ready` must **not** set `sttReady` — only the native engine's load does
(`bootSttWorker`'s `vadOnly` option).

## Invariants & gotchas

- **Offline at runtime.** `env.allowRemoteModels = false` (`voice-worker.js:36`); the worker
  can only read `hm://models/`. All network fetching happens in Node (fetch-model.mjs at
  install/build time, `stt:ensureModel` in the main process on first selection).
- **The worker holds one model for its lifetime.** Switching models requires
  `resetSttWorker()` + a fresh worker; never post a second `load` expecting a swap
  (`load` returns early `ready` if a transcriber already exists, `voice-worker.js:138`).
- **`STT_MODELS` (renderer) and `STT_DOWNLOADS` (main) must stay in sync**, and every model
  must be **English-only** — the worker's transcribe call passes audio only, no
  language/task options (`voice-worker.js:164`). Native entries also need `STT_NATIVE`
  (main.js) and ship **nothing bundled** — a ~630 MB model must never land in the installer,
  so keep native repos out of `scripts/fetch-model.mjs`.
- **sherpa packages must stay asar-unpacked** (`build.asarUnpack` includes
  `node_modules/sherpa-onnx-node/**` and `node_modules/sherpa-onnx-win-x64/**`) — the `.node`
  addon and its DLLs can't load from inside the asar.
- **VAD frame/verdict pairing is order-based (FIFO), guarded by `gen`.** Stopping capture,
  resetting the worker, or degrading all bump `vadGen` so stragglers are dropped. Any change
  to the worker's `vad` handling must keep the "always reply, even with `prob: null`" rule.
- **hm:// and asarUnpack are load-bearing.** Models and the transformers dist must be plain
  files on disk; adding a new served directory means touching `HM_ROOTS` (`main.js:41`) and
  possibly `build.asarUnpack`. The scheme must be registered before app `ready`.
- **SharedArrayBuffer flag** (`main.js:21`) makes ORT multi-threaded (~4x). If it stops
  applying, the worker silently runs single-threaded — slower, not broken.
- **nspell / spell-check is a separate, typed-text subsystem.** `main.js:418-580` runs an
  nspell (Hunspell) autocorrect over the `spell:correct` IPC for keyboard input in composers.
  Dictated text does **not** pass through it — voice relies on the voice dictionary and
  correction learning instead. Don't route transcripts through autocorrect.
- **Testing:** launch with `HM_USER_DATA` set to isolate userData (including downloaded
  models) from the user's live instance; a full relaunch is needed for main-process changes.
- Per `CLAUDE.md`, any user-facing change here (shortcuts, buttons, settings) must be
  reflected in the Help modal in `src/index.html` in the same change.

## How to extend

**Add a new selectable speech model** (must be a transformers.js-compatible, English-only ASR
ONNX repo; for a sherpa-native model, additionally add its file layout to `STT_NATIVE` in
main.js, mark the `STT_MODELS` entry `native: true`, and skip the `dtype` field):

1. Add an entry to `STT_MODELS` (`src/renderer.js:8467`) — repo id, label, `dtype` map
   (use `q8` unless you ship other quantizations).
2. Add the matching file list to `STT_DOWNLOADS` (`main.js:52`) — config/tokenizer JSON plus
   the exact ONNX graph files that dtype resolves to (q8 → `onnx/*_quantized.onnx`). Missing
   files here mean the download loop never fetches them and the worker 404s over hm://.
3. Nothing else: the Settings dropdown is populated from `STT_MODELS`
   (`syncVoiceFields`, `renderer.js:9365`), download-on-first-use, progress HUD, and worker
   restart all key off the registry. If instead the model should ship **bundled**, add it to
   `MODELS` in `scripts/fetch-model.mjs` rather than `STT_DOWNLOADS`.
4. Test both dev and a packaged build (path resolution differs), and update the Help modal if
   the user-visible wording changes.

**Change transcription post-processing:** the single choke point is `commitVoiceText()`
(`src/renderer.js:8744`). Order matters: training tap (must see raw, pre-dictionary text) →
chat-dialog routing → auto-Enter phrase → `applyVoiceDict()` → Hivemind spoken-command match →
todo prefix → auto-space → insertion. New text transforms belong after `applyVoiceDict` and
before the auto-space append; keep `voiceLearnRecord()` receiving the *final* inserted text so
correction learning diffs against what the user actually sees. Do not transform text inside
the worker — it should stay a pure audio→text function.
