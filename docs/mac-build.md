# macOS (Apple Silicon M3 Pro+) — readiness & build plan (req 5)

The app is built/verified on **Windows + Nvidia CUDA**. This is the path to run it on **Mac Apple Silicon**. The engines are already cross-platform & **no-Python**; remaining work is feature flags + device detection + bundle config. (Honest limit: we can't run/verify on a real M3 Pro from this Windows box — we make it Mac-ready + documented; final on-device check needs a Mac.)

## Transcription speed/quality levers (no model change) — what's wired
Applied in `asr.rs` / `Cargo.toml`; all keep the same large-v3 weights (no model swap; word accuracy unchanged).
**Fastest Mac build:** `npm run tauri build -- --features metal,coreml` (the `.mlmodelc` ANE encoder is auto-fetched on first model download — see below).
- **Flash attention (`cparams.flash_attn(true)`) — ON:** faster GPU attention on Metal + CUDA. Measured ~21% faster on large-v3 (CUDA, 9-min clip: 49.9s→39.3s). Output is near-identical, not bit-identical (GPU float ordering shifts the odd token/boundary, ~0.6% of chars; word accuracy unchanged) — the standard whisper.cpp GPU recommendation.
- **Decode threads (`set_n_threads`) — ON, backend-aware:** the CPU-side work differs by backend, so `run_whisper` picks the thread count from `use_gpu` in ONE place (no more double-set): a GPU build (Metal/CUDA) offloads encode+decode, leaving only the log-mel front-end + token sampling on the CPU — those stop scaling past ~8 threads (more is contention), so **clamp [4,8]**; a CPU build runs the whole decode on the CPU and uses **all-but-one core**. (Earlier a stray second `set_n_threads(cores-1)` silently overrode the clamp on every GPU run — fixed.)
- **Core ML / ANE encoder (`coreml` feature) — opt-in, now turnkey:** `--features metal,coreml` runs the heavy encoder on the Apple Neural Engine on top of Metal (big win). It needs `ggml-<model>-encoder.mlmodelc` next to the ggml `.bin`; **this is now auto-fetched** — `download_model` best-effort downloads + unzips the bundle from HF `ggerganov/whisper.cpp` right after the `.bin` lands (`ensure_coreml_encoder`/`fetch_coreml_encoder` in `asr.rs`, gated `#[cfg(all(target_os = "macos", feature = "coreml"))]`; runs on both the fresh-download and already-present-`.bin` paths). If the fetch fails or the artifact is absent, whisper.cpp logs a notice and falls back to the Metal encoder — never gating ASR. First ANE run compiles/caches the model (slow once). Build needs Xcode. **Mac-only** — never enable on Windows/Linux (no CoreML framework). The `zip` crate (already in-tree via ffmpeg-sidecar) is declared `default-features=false, features=["deflate"]` to avoid an `lzma-sys` link clash.
- **Quality:** accuracy = model + decoder, **platform-independent** (Metal/CoreML give near-identical text to CPU; not byte-for-byte but same word accuracy). So there's no Mac-specific quality to "recover" — it isn't lost on Mac. The only real accuracy knob is **beam search** (slower).
- **Segment shape (`merge_short_segments`) — ON, platform-independent:** whisper splits on the timestamp tokens it emits, and emits them ever more frequently on harder audio (quieter speech / cross-talk / lower decoder confidence late in a long interview), so a single sentence can come back as several 1-2 word fragments — sometimes a lone pronoun. A post-decode pass in `diarize_and_store` folds runs of consecutive **same-speaker** fragments back into sentence-level segments, breaking at a sentence-final mark (Latin + Russian), a real pause (≥1200ms), a 30s span cap, or a speaker change. It runs AFTER diarization (so turns never merge) at the single storage chokepoint (covers full / resume / range), preserves timing exactly (so media-sync + timing-immutability hold), and logs `coalesced N → M segments`.
- **Diarization:** separate pipeline (sherpa-onnx) — multi-threaded (`num_threads` ≈ cores/2, clamped [2,6]; 8 threads measured a regression) in `diarize.rs`. On macOS it now requests the **CoreML execution provider** (ANE/GPU) for both the segmentation + embedding models (`provider = "coreml"`; CPU elsewhere). ORT falls back to CPU per-op for unsupported nodes, and a missing CoreML EP only fails session-create — which `diarize_and_store` already treats as best-effort (single speaker) — so it can never break transcription. Flip to `"cpu"` in `diarize.rs` if it regresses on-device.

### Available option, NOT yet built — a Speed vs Accuracy toggle
Decoding is currently `SamplingStrategy::Greedy { best_of: 1 }` + temperature fallback (fast, good). The one
lever for **higher accuracy** is **beam search** (e.g. `BeamSearch { beam_size: 5 }`) — ~2-3× slower, but the
speed reclaimed by flash attention + Core ML/ANE makes it affordable on Apple Silicon. To offer it as a user
choice: add a Settings **"Transcription mode: Speed | Accuracy"** preference, thread it to `transcribe_interview`,
and pick the `SamplingStrategy` in `run_whisper` accordingly (Speed = greedy as today; Accuracy = beam search).
This is a code change (backend + a Settings control), not a build flag — implement on request.

## Observability & resilience for slow runs (live progress, resume, chunk re-transcribe) — what's wired
Apple-Silicon **CPU** transcription of a long interview is slow, so the run is now observable + recoverable
(all in `asr.rs` + the editor UI; no model/accuracy change). This is the macOS-motivated work — a slow `@cpu`
run is no longer a black box:
- **Live transcript streaming.** whisper.cpp's **new-segment callback** (`set_segment_callback_safe`) emits
  each segment **as it's decoded** — `state.full()` only returns once the whole file is done, so the post-run
  loop is a burst, not a stream. The callback feeds Tauri's `asr://progress` event (now carrying the full
  `segment`, not just text). The editor can be opened **mid-run** and shows the transcript filling in + the
  real whisper percent, then a distinct **"Diarizing…"** phase (diarization is a separate post-ASR pass; its
  sherpa `process()` is one opaque call, so the editor shows an honest elapsed/estimate, not a fake inner %).
- **Crash-safe checkpoint + resume.** New migration **`0007_transcribe_checkpoint.sql`** (table
  `transcribe_checkpoint`, one row per interview). A background writer snapshots decoded segments **every few
  seconds**; cleared on success, kept on error/crash. `recover_stuck_interviews` (startup) flips a killed
  `transcribing` row to `error`, but the checkpoint survives → the editor offers **resume**.
  `resume_transcription` re-runs whisper on **only** the remaining tail `[processed_ms, total_ms]`, appends to
  the saved prefix, then diarizes the whole file — no re-doing completed work.
- **Per-range re-transcribe.** `retranscribe_range(start_ms, end_ms)` runs whisper on a **time slice**
  (16 samples/ms), splices the result over the existing segments in that window, and re-diarizes the **whole**
  audio for globally consistent speakers (a slice diarized alone gets inconsistent cluster labels). Driven from
  the editor by selecting segment rows → "Перетранскрибировать".
- **Shared engine.** The three paths (full / resume / range) share `run_guarded_whisper` (cancel flag +
  watchdog + live-stream + checkpoint buffer) and `diarize_and_store` (whole-audio diarize → store → finalize),
  so the watchdog/cancel/concurrency-1 semantics are identical everywhere. Pure splice/merge logic is unit-tested
  (`splice_*` in `asr.rs`); the whisper paths are validated by `cargo check` (the live-segment callback is an
  `#[ignore]`d real-engine test).

## Cross-platform audit (current state)
- **whisper.cpp (`whisper-rs 0.16`):** Windows uses the `cuda` feature. Apple Silicon → the **`metal`** feature (`whisper-rs/metal`) for GPU, plus the opt-in **`coreml`** feature (ANE encoder) — see the levers section above; CPU fallback works without either.
- **Diarization (`sherpa-onnx 1.13.3`, `shared`):** cross-platform ONNX Runtime; macOS-arm64 prebuilt is shipped by the crate. The **CoreML** execution provider is now requested on Apple Silicon (`provider = "coreml"` on both models in `diarize.rs`; CPU elsewhere) — best-effort, with ORT per-op CPU fallback. The `shared` (DLL/dylib) choice was made to dodge a Windows CRT conflict; it's also correct on macOS.
- **Device detection (`asr.rs`) — DONE:** `nvml_wrapper` is now cfg-gated off macOS (the probe is a `#[cfg(target_os = "macos")]` stub returning `None`), and `detect_device()` has a macOS/Metal branch: on macOS with the `metal` feature it reports `device=metal, use_gpu=true`; without it, CPU.
- **Process spawn:** `CREATE_NO_WINDOW` is `#[cfg(windows)]` → no-op on Mac ✓.
- **Build env:** `cuda-build.cmd` is Windows-only (vcvars + CUDA 13.3 + Ninja). Mac needs **no special env** — Metal is in the SDK; build via `npm run tauri build -- --features metal` (Xcode Command Line Tools required).
- **Paths/models:** Tauri `app_data_dir()` everywhere (cross-platform) ✓; no hardcoded `C:\` in `src` ✓.

## Work to make the Mac build — STATUS
Implemented from the Windows box (cfg-gating + config + docs). Items are marked done where
the code/config has landed; the on-device run still needs a real Mac (see "Verify").

1. **Cargo — DONE.** Added `metal = ["whisper-rs/metal"]` to `[features]` (mirrors `cuda`,
   OFF by default → CPU build). `cuda` stays Windows/Linux-only in behavior. `nvml-wrapper`
   is scoped under `[target.'cfg(not(target_os = "macos"))'.dependencies]`, so the macOS
   target never tries to build the Nvidia-only crate. `coreml = ["whisper-rs/coreml"]` is
   wired (composes with `metal`); its CoreML-encoder artifact is no longer a manual step —
   it's auto-fetched at model-download time (see item 2). `zip` (deflate-only) was added for
   that unzip, reusing the in-tree copy from ffmpeg-sidecar.
2. **asr.rs — DONE.** `probe_nvidia_gpu()` is cfg-split: the real NVML probe is
   `#[cfg(not(target_os = "macos"))]`, and a `#[cfg(target_os = "macos")]` stub returns `None`
   (so macOS compiles with no `nvml_wrapper` reference). Added `metal_build()`
   (`cfg!(feature = "metal")`). `detect_device()` is cfg-split: non-macOS keeps the exact
   CUDA/CPU logic; the macOS branch reports `device="metal", use_gpu=true,
   gpu_name=Some("Apple Silicon GPU"), cuda_build=false` when the `metal` feature is on, and
   a clear CPU `DeviceInfo` (with a "rebuild with --features metal" hint) when it's off.
   `DeviceInfo.device` doc comment now lists `"metal"`. Whisper still uses
   `cparams.use_gpu(use_gpu)` — Metal is selected by the whisper-rs `metal` feature at compile
   time, so `use_gpu=true` simply runs on whatever GPU backend was compiled in. The
   `detect_device_is_consistent` unit test now tolerates `device="metal"` on macOS without
   changing its Windows behavior.
   Also in `asr.rs`: (a) **decode threads are backend-aware** (clamp [4,8] on a GPU build,
   all-but-one on CPU) from a single `set_n_threads` — fixes a stray override that forced
   `cores-1` on every GPU run (see levers). (b) **CoreML ANE-encoder auto-fetch**:
   `ensure_coreml_encoder` (best-effort) + `fetch_coreml_encoder` (ureq download → `zip`
   unzip), both `#[cfg(all(target_os = "macos", feature = "coreml"))]` with a no-op fallback
   elsewhere, called from `download_model` on both the fresh and already-present-`.bin` paths.
   The macOS+coreml code path was type-checked on Linux by temporarily flipping its cfg gate.
3. **sherpa — confirmed cross-platform; dylib bundling is the same follow-up as Windows.**
   `sherpa-onnx 1.13.3` with the `shared` feature ships the macOS-arm64 onnxruntime + sherpa
   **dylibs** via the crate's prebuilt (the `shared` choice that dodged the Windows CRT clash
   is also correct on macOS). As on Windows, the build script drops the shared libs next to the
   binary for `cargo run`/dev. Bundling those shared libs INTO the installer (Windows `.dll` →
   `bundle.resources`, macOS `.dylib`) is NOT yet done on EITHER platform — it's the same
   M5-hardening follow-up (feature-diarization.md §7 M5). We deliberately did not invent a
   macOS-only `resources` entry that Windows lacks; when the Windows DLL bundling lands, mirror
   it for the `.dylib` set on macOS. The CoreML execution provider for diarization is now
   wired (`provider = "coreml"` on macOS in `diarize.rs`, CPU elsewhere) — best-effort with
   ORT per-op CPU fallback; on-device speedup still to be measured (item 6).
4. **tauri.conf — DONE (bundle target).** `bundle.targets: "all"` already emits `.app`/`.dmg`
   on macOS; added a `bundle.macOS` block with `minimumSystemVersion: "12.0"` (Apple Silicon
   floor). No `resources` key was added — see item 3 (dylib bundling is a shared follow-up, and
   inventing macOS-only paths absent on Windows would be misleading).
5. **Docs — DONE.** See "Build & run on a Mac" below.
6. **Verify — partial (see below).** Cross-checked off-Mac with a full DEFAULT-features build
   + the whole test suite (**125 passed**): compiles cleanly, proving the non-macOS cfg-gating
   is correct and the build is intact. The macOS-only code paths can't be linked off-Mac (no
   Apple SDK), so they were made obviously correct by mirroring the CUDA patterns AND, for the
   new `#[cfg(all(target_os = "macos", feature = "coreml"))]` encoder-fetch code, type-checked
   on Linux by temporarily flipping the cfg gate to the host target. **Still needs a real Mac
   for the final on-device build + run** — and specifically to MEASURE: (a) the CoreML-EP
   diarization speedup (may be modest on these small models — time the `diarize` phase; flip
   `provider` to `"cpu"` if it regresses), and (b) that the ANE encoder actually engages (first
   run is slow while the ANE compiles/caches the model, fast thereafter).

## Build & run on a Mac (Apple Silicon)
Prereq: **Xcode Command Line Tools** (`xcode-select --install`) — provides clang + the macOS
SDK (Metal ships in the SDK; no extra GPU env like the Windows CUDA recipe). Plus Node + Rust
(`aarch64-apple-darwin` is the default host target on Apple Silicon).

- Dev (GPU + ANE): `npm run tauri dev -- --features metal,coreml`
- Build (fastest, produces `.app`/`.dmg`): `npm run tauri build -- --features metal,coreml`
  — Metal GPU + the ANE encoder (its `.mlmodelc` is auto-fetched on first model download).
- GPU without ANE: `--features metal` (skips the CoreML encoder; uses the Metal encoder).
- CPU-only (no Metal): omit the features — the app falls back to CPU and
  `detect_device()` reports `device="cpu"` with a hint to rebuild with Metal.

Honest limit: everything above is implemented + compiles for the non-macOS targets we can build
here; the final M3-Pro on-device check (Metal init, dylib loading, `.dmg` packaging) still needs
a Mac.

## Web-app alternative (req 5 says "web app OR Tauri")
Tauri packages on both OSes satisfy the requirement. A pure web-app deployment would need a server-side backend (the Rust commands run locally in Tauri); out of scope unless requested.
