# macOS (Apple Silicon M3 Pro+) — readiness & build plan (req 5)

The app is built/verified on **Windows + Nvidia CUDA**. This is the path to run it on **Mac Apple Silicon**. The engines are already cross-platform & **no-Python**; remaining work is feature flags + device detection + bundle config. (Honest limit: we can't run/verify on a real M3 Pro from this Windows box — we make it Mac-ready + documented; final on-device check needs a Mac.)

## Transcription speed/quality levers (no model change) — what's wired
Applied in `asr.rs` / `Cargo.toml`; all keep the same large-v3 weights (no model swap; word accuracy unchanged).
**Fastest Mac build:** `npm run tauri build -- --features metal,coreml` (+ the `.mlmodelc` artifact, see below).
- **Flash attention (`cparams.flash_attn(true)`) — ON:** faster GPU attention on Metal + CUDA. Measured ~21% faster on large-v3 (CUDA, 9-min clip: 49.9s→39.3s). Output is near-identical, not bit-identical (GPU float ordering shifts the odd token/boundary, ~0.6% of chars; word accuracy unchanged) — the standard whisper.cpp GPU recommendation.
- **Decode threads (`set_n_threads`, clamp [4,8]) — ON:** the GPU does encode/decode, but the log-mel front-end + token sampling are CPU-side; default was min(4,cores), now tuned up on bigger machines (e.g. M3 Pro).
- **Core ML / ANE encoder (`coreml` feature) — opt-in:** `--features metal,coreml` runs the heavy encoder on the Apple Neural Engine on top of Metal (big win). Needs `ggml-<model>-encoder.mlmodelc` next to the ggml `.bin` (prebuilt in HF `ggerganov/whisper.cpp`); whisper.cpp falls back to the Metal encoder if absent. First run compiles/caches the ANE model (slow once). Build needs Xcode. **Mac-only** — never enable on Windows/Linux (no CoreML framework). Auto-downloading the `.mlmodelc` alongside the ggml model is a remaining nicety (currently a manual placement / documented step).
- **Quality:** accuracy = model + decoder, **platform-independent** (Metal/CoreML give near-identical text to CPU; not byte-for-byte but same word accuracy). So there's no Mac-specific quality to "recover" — it isn't lost on Mac. The only real accuracy knob is **beam search** (slower).
- **Diarization:** separate pipeline (sherpa-onnx, CPU) — now multi-threaded (`num_threads` ≈ cores) in `diarize.rs`; was the slow pole.

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
- **Diarization (`sherpa-onnx 1.13.3`, `shared`):** cross-platform ONNX Runtime; macOS-arm64 prebuilt is shipped by the crate. Optionally enable the **CoreML** execution provider on Apple Silicon (else CPU ~real-time — fine). The `shared` (DLL/dylib) choice was made to dodge a Windows CRT conflict; it's also correct on macOS.
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
   target never tries to build the Nvidia-only crate. `coreml` is NOT wired (it needs an
   extra CoreML-encoder model artifact); it's left as a commented future toggle in Cargo.toml.
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
3. **sherpa — confirmed cross-platform; dylib bundling is the same follow-up as Windows.**
   `sherpa-onnx 1.13.3` with the `shared` feature ships the macOS-arm64 onnxruntime + sherpa
   **dylibs** via the crate's prebuilt (the `shared` choice that dodged the Windows CRT clash
   is also correct on macOS). As on Windows, the build script drops the shared libs next to the
   binary for `cargo run`/dev. Bundling those shared libs INTO the installer (Windows `.dll` →
   `bundle.resources`, macOS `.dylib`) is NOT yet done on EITHER platform — it's the same
   M5-hardening follow-up (feature-diarization.md §7 M5). We deliberately did not invent a
   macOS-only `resources` entry that Windows lacks; when the Windows DLL bundling lands, mirror
   it for the `.dylib` set on macOS. Optional CoreML execution provider for diarization is a
   later nicety (CPU is ~real-time and fine).
4. **tauri.conf — DONE (bundle target).** `bundle.targets: "all"` already emits `.app`/`.dmg`
   on macOS; added a `bundle.macOS` block with `minimumSystemVersion: "12.0"` (Apple Silicon
   floor). No `resources` key was added — see item 3 (dylib bundling is a shared follow-up, and
   inventing macOS-only paths absent on Windows would be misleading).
5. **Docs — DONE.** See "Build & run on a Mac" below.
6. **Verify — partial (see below).** Cross-checked from Windows with a plain
   `cargo check` (DEFAULT features, no cuda): compiles cleanly, proving the non-macOS
   cfg-gating is correct and the Windows build is intact. `cargo check --target
   aarch64-apple-darwin --features metal` is NOT runnable from this Windows box (no Apple
   toolchain/SDK to link against), so the macOS cfg paths are made obviously correct by
   mirroring the existing CUDA patterns. **A real Mac is still required for the final
   on-device build + run.**

## Build & run on a Mac (Apple Silicon)
Prereq: **Xcode Command Line Tools** (`xcode-select --install`) — provides clang + the macOS
SDK (Metal ships in the SDK; no extra GPU env like the Windows CUDA recipe). Plus Node + Rust
(`aarch64-apple-darwin` is the default host target on Apple Silicon).

- Dev (GPU): `npm run tauri dev -- --features metal`
- Build (GPU, produces `.app`/`.dmg`): `npm run tauri build -- --features metal`
- CPU-only (no Metal): omit `--features metal` — the app falls back to CPU and
  `detect_device()` reports `device="cpu"` with a hint to rebuild with Metal.

Honest limit: everything above is implemented + compiles for the non-macOS targets we can build
here; the final M3-Pro on-device check (Metal init, dylib loading, `.dmg` packaging) still needs
a Mac.

## Web-app alternative (req 5 says "web app OR Tauri")
Tauri packages on both OSes satisfy the requirement. A pure web-app deployment would need a server-side backend (the Rust commands run locally in Tauri); out of scope unless requested.
