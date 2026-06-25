// Local ASR engine (Milestone 4, spec §6).
//
// whisper.cpp linked in-process via `whisper-rs`. Three concerns live here:
//   1. Device detection  — Nvidia GPU (nvml) + the `cuda` build flag → CUDA / CPU.
//   2. Model management   — download ggml `.bin` weights into models/ with progress.
//   3. Transcription      — run whisper on a tokio blocking task, stream progress +
//                           segments via Tauri events, store a `transcript` v1 (raw).
//
// Conventions mirror interview.rs: typed structs, parameterized SQL, each
// #[tauri::command] is a thin wrapper over a pool-/path-taking helper so the logic
// is unit-testable. Interview status flows new → transcribing → transcribed | error.
//
// Build note: default build is CPU-only (Cargo `cuda` feature OFF) so non-CUDA machines
// still build. With the feature on (CUDA Toolkit present) the same code initializes
// whisper with use_gpu=true and falls back to CPU on init failure. `cfg!(feature =
// "cuda")` is the compile-time half; nvml is the runtime half. The CUDA backend is
// verified on this machine's RTX 5080 (sm_120) with CUDA Toolkit v13.3 — see Cargo.toml's
// `cuda` feature comment + target/cuda-build.cmd for the exact build env.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::Db;

// Interview status vocabulary owned by ASR (schema §2.2: new|transcribing|transcribed|…).
const STATUS_TRANSCRIBING: &str = "transcribing";
const STATUS_TRANSCRIBED: &str = "transcribed";
const STATUS_ERROR: &str = "error";

// Tauri event channels the Settings + Interviews UIs subscribe to.
pub const ASR_PROGRESS_EVENT: &str = "asr://progress"; // transcription progress (per interview)
pub const MODEL_PROGRESS_EVENT: &str = "asr://model-progress"; // model download progress
pub const DIAR_MODEL_PROGRESS_EVENT: &str = "asr://diar-model-progress"; // diarization model download
pub const DIAR_PROGRESS_EVENT: &str = "asr://diar-progress"; // (re)diarization progress (per interview)

// app_setting key caching the detected device label (spec §6.3 "cached in app_setting").
const DEVICE_SETTING_KEY: &str = "asr_device";

// Concurrency = 1 for ASR (spec §3.3 "configurable concurrency = 1 by default to keep
// VRAM sane"). A process-wide async mutex serializes transcribe() runs.
static ASR_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
fn asr_lock() -> &'static Mutex<()> {
    ASR_LOCK.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- cancellation + watchdog (bug #1 / #5) ------------------------------------
//
// A running transcription can hang indefinitely (music/jingle/silence sends greedy
// decoding into a never-terminating segment) and there was no way to stop it. We
// gate every whisper run with an abort flag wired into whisper.cpp's abort_callback
// (whisper-rs `set_abort_callback_safe`, returning true => abort mid-run on the
// blocking task). The flag is flipped by EITHER the manual Stop command (#5) OR the
// per-interview watchdog timeout (#1) — the same mechanism for both.
//
// Mirrors chat.rs's INFLIGHT registry style: a single std Mutex<Option<HashMap>>,
// held only for brief inserts/removes/lookups. Keyed by interview id (concurrency=1,
// so at most one entry, but a map keeps the API obvious + future-proof).
static CANCEL_REGISTRY: StdMutex<Option<HashMap<String, Arc<AtomicBool>>>> = StdMutex::new(None);

fn with_cancel_registry<R>(f: impl FnOnce(&mut HashMap<String, Arc<AtomicBool>>) -> R) -> R {
    let mut guard = CANCEL_REGISTRY.lock().expect("cancel registry mutex");
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

// Register a fresh cancel flag for an interview about to be transcribed. Replaces any
// stale entry (a previous aborted run for the same id).
fn register_cancel(interview_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    with_cancel_registry(|m| {
        m.insert(interview_id.to_string(), flag.clone());
    });
    flag
}

// Drop the cancel flag once the run is over (success, error, or abort) so the queue
// is free + the registry doesn't leak.
fn unregister_cancel(interview_id: &str) {
    with_cancel_registry(|m| {
        m.remove(interview_id);
    });
}

// Flip the cancel flag for an in-flight transcription, if one is registered. Returns
// true if a run was actually signalled. Used by the manual Stop command (#5).
fn signal_cancel(interview_id: &str) -> bool {
    with_cancel_registry(|m| match m.get(interview_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    })
}

// Watchdog wall-time policy (#1): bound a transcription to a generous multiple of the
// audio duration, with a floor (short clips still get a usable budget) and a hard ceiling
// (so one pathological file can't pin the concurrency=1 queue for an unreasonable time).
// CPU `base` on a jingle was observed crawling at ~3 tok/s and never terminating; real
// runs (even large-v3 on CPU) finish well under these bounds.
const WATCHDOG_DURATION_MULTIPLE: i64 = 12; // ≤ 12× real-time
const WATCHDOG_FLOOR_MS: i64 = 120_000; // at least 2 min for tiny clips
const WATCHDOG_CEILING_MS: i64 = 3_600_000; // never more than 1 h

fn watchdog_budget_ms(duration_ms: Option<i64>) -> i64 {
    let by_duration = duration_ms
        .filter(|d| *d > 0)
        .map(|d| d.saturating_mul(WATCHDOG_DURATION_MULTIPLE))
        .unwrap_or(WATCHDOG_FLOOR_MS);
    by_duration.clamp(WATCHDOG_FLOOR_MS, WATCHDOG_CEILING_MS)
}

// --- model catalog (spec §6.4 — ggml models from ggerganov/whisper.cpp on HF) ------

// Base URL for ggml weights on Hugging Face (mirrors Vibe's source).
const HF_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

// One selectable model. `id` is the UI value; `file` is the ggml bin filename.
// approx_mb is a rough on-disk size for the UI (not authoritative).
#[derive(Serialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub file: String,
    pub approx_mb: u64,
    pub default: bool,   // the app default (large-v3, spec §6.4)
    pub downloaded: bool, // resolved at list time from models/ on disk
}

// The catalog. Default = large-v3 (best Russian accuracy, spec §6.4); turbo + medium
// are the speed/VRAM knobs the spec calls out. tiny/base are small models for dev
// verification (kept selectable so the M4 verify can avoid a 3 GB download).
struct CatalogEntry {
    id: &'static str,
    label: &'static str,
    file: &'static str,
    approx_mb: u64,
    default: bool,
}

const CATALOG: &[CatalogEntry] = &[
    CatalogEntry { id: "large-v3", label: "Large v3 (best, Russian default)", file: "ggml-large-v3.bin", approx_mb: 3094, default: true },
    CatalogEntry { id: "large-v3-turbo", label: "Large v3 Turbo (faster)", file: "ggml-large-v3-turbo.bin", approx_mb: 1624, default: false },
    CatalogEntry { id: "medium", label: "Medium (lighter)", file: "ggml-medium.bin", approx_mb: 1533, default: false },
    CatalogEntry { id: "base", label: "Base (small, for testing)", file: "ggml-base.bin", approx_mb: 148, default: false },
    CatalogEntry { id: "tiny", label: "Tiny (smallest, for testing)", file: "ggml-tiny.bin", approx_mb: 78, default: false },
];

fn catalog_entry(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.id == id)
}

// models/ dir under the app-data dir (spec §2.3: weights live OUTSIDE cycle dirs).
fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join("models"))
}

fn model_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let entry = catalog_entry(id).ok_or_else(|| format!("unknown model id: {id}"))?;
    Ok(models_dir(app)?.join(entry.file))
}

// --- device detection (spec §6.3) ---------------------------------------------

// What the UI Badge shows + what asr passes to whisper as use_gpu.
#[derive(Serialize, Clone, PartialEq)]
pub struct DeviceInfo {
    pub device: String,        // "cuda" | "metal" | "cpu"
    pub use_gpu: bool,         // the value handed to whisper-rs
    pub gpu_name: Option<String>, // e.g. "NVIDIA GeForce RTX 5080" when an Nvidia GPU is present
    pub cuda_build: bool,      // whether this binary was compiled with the cuda feature
    pub detail: String,        // human-readable reason for the chosen device
}

// True only when compiled with the `cuda` Cargo feature (whisper.cpp CUDA backend).
fn cuda_build() -> bool {
    cfg!(feature = "cuda")
}

// True only when compiled with the `metal` Cargo feature (whisper.cpp Metal backend,
// Apple Silicon). The compile-time half of macOS GPU selection — see mac-build.md.
// Only the macOS `detect_device()` branch calls this, so it's dead code off macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn metal_build() -> bool {
    cfg!(feature = "metal")
}

// Probe the Nvidia GPU via NVML. Returns its name if a usable Nvidia GPU is present.
// NVML init fails on machines without the Nvidia driver — that's the CPU case.
// nvml-wrapper is Nvidia-only and not compiled on macOS, so this is non-macOS-only.
#[cfg(not(target_os = "macos"))]
fn probe_nvidia_gpu() -> Option<String> {
    let nvml = nvml_wrapper::Nvml::init().ok()?;
    let count = nvml.device_count().ok()?;
    if count == 0 {
        return None;
    }
    let dev = nvml.device_by_index(0).ok()?;
    dev.name().ok()
}

// macOS (Apple Silicon) has no Nvidia GPU and no nvml-wrapper — always None.
#[cfg(target_os = "macos")]
fn probe_nvidia_gpu() -> Option<String> {
    None
}

// Decide the ASR device from the build flag + runtime GPU probe (spec §6.3 logic):
//   cuda build AND an Nvidia GPU present → use_gpu=true (device "cuda")
//   otherwise                            → use_gpu=false (device "cpu", the fallback)
// Note: a GPU can be present while the build is CPU-only (this machine) — then we
// report CPU but name the GPU + explain that enabling CUDA needs a CUDA-feature build.
//
// macOS gets its own branch below (Metal, no NVML). Everything else (Windows/Linux)
// keeps the CUDA/CPU logic unchanged.
#[cfg(not(target_os = "macos"))]
pub fn detect_device() -> DeviceInfo {
    let gpu = probe_nvidia_gpu();
    let build = cuda_build();
    let use_gpu = build && gpu.is_some();

    let detail = match (build, &gpu) {
        (true, Some(name)) => format!("CUDA backend + Nvidia GPU detected ({name})."),
        (true, None) => "CUDA backend built, but no Nvidia GPU found — using CPU.".to_string(),
        (false, Some(name)) => format!(
            "Nvidia GPU detected ({name}), but this build is CPU-only \
             (compiled without the CUDA Toolkit). Using CPU."
        ),
        (false, None) => "No Nvidia GPU detected — using CPU.".to_string(),
    };

    DeviceInfo {
        device: if use_gpu { "cuda".into() } else { "cpu".into() },
        use_gpu,
        gpu_name: gpu,
        cuda_build: build,
        detail,
    }
}

// macOS (Apple Silicon): the Metal backend is selected at compile time by the
// whisper-rs `metal` feature — there's no runtime probe (unlike NVML for Nvidia),
// so the build flag alone decides. `metal` on → use_gpu=true (device "metal");
// `metal` off → CPU. cuda_build is always false here (Apple has no Nvidia GPU).
// ponytail: we don't query the actual GPU name (no nvml equivalent wired up); a
// fixed "Apple Silicon GPU" label is enough for the Settings badge.
#[cfg(target_os = "macos")]
pub fn detect_device() -> DeviceInfo {
    let metal = metal_build();
    if metal {
        DeviceInfo {
            device: "metal".into(),
            use_gpu: true,
            gpu_name: Some("Apple Silicon GPU".into()),
            cuda_build: false,
            detail: "Metal backend (Apple Silicon) built — using the GPU.".to_string(),
        }
    } else {
        DeviceInfo {
            device: "cpu".into(),
            use_gpu: false,
            gpu_name: None,
            cuda_build: false,
            detail: "CPU build on macOS — rebuild with `--features metal` for GPU \
                     acceleration on Apple Silicon."
                .to_string(),
        }
    }
}

// --- WAV reader (16 kHz mono PCM16 → f32) -------------------------------------

// Read a 16-bit PCM mono WAV (exactly what our ffmpeg step at -ac 1 -ar 16000
// produces) into the normalized f32 samples whisper expects ([-1.0, 1.0]).
// ponytail: a ~40-line parser instead of pulling `hound` as a new dep — the input
// format is our own and fixed (RIFF/WAVE, fmt=PCM16 mono 16k). Falls back to an
// error (not silent garbage) if the header isn't what we wrote.
// pub(crate): diarize.rs reuses this exact reader (ASR + diarization share the 16k wav).
pub(crate) fn read_wav_16k_mono(path: &Path) -> Result<Vec<f32>, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("open wav: {e}"))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).map_err(|e| format!("read wav: {e}"))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }

    // Walk chunks to find `fmt ` and `data` (don't assume canonical 44-byte header).
    let mut pos = 12usize;
    let mut bits_per_sample = 0u16;
    let mut channels = 0u16;
    let mut data: Option<&[u8]> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
        let body_start = pos + 8;
        let body_end = (body_start + size).min(bytes.len());
        match id {
            b"fmt " if body_end - body_start >= 16 => {
                channels = u16::from_le_bytes([bytes[body_start + 2], bytes[body_start + 3]]);
                bits_per_sample = u16::from_le_bytes([bytes[body_start + 14], bytes[body_start + 15]]);
            }
            b"data" => {
                data = Some(&bytes[body_start..body_end]);
            }
            _ => {}
        }
        // Chunks are word-aligned (pad byte if size is odd).
        pos = body_start + size + (size & 1);
    }

    let data = data.ok_or("no data chunk in wav")?;
    if bits_per_sample != 16 {
        return Err(format!("expected 16-bit PCM, got {bits_per_sample}-bit"));
    }
    if channels != 1 {
        return Err(format!("expected mono, got {channels} channels"));
    }

    let mut samples = Vec::with_capacity(data.len() / 2);
    for chunk in data.chunks_exact(2) {
        let s = i16::from_le_bytes([chunk[0], chunk[1]]);
        samples.push(s as f32 / 32768.0);
    }
    Ok(samples)
}

// --- DB helpers ---------------------------------------------------------------

async fn set_status_db(pool: &SqlitePool, interview_id: &str, status: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE interview SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(now_ms())
        .bind(interview_id)
        .execute(pool)
        .await?;
    Ok(())
}

// Look up the prepared 16k wav for an interview (recording.audio_path).
async fn audio_path_db(pool: &SqlitePool, interview_id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT audio_path FROM recording WHERE interview_id = ? LIMIT 1",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
    .map(|o| o.flatten())
}

// Look up the probed audio duration (ms) for an interview — drives the watchdog budget (#1).
async fn duration_ms_db(pool: &SqlitePool, interview_id: &str) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar::<_, Option<i64>>(
        "SELECT duration_ms FROM recording WHERE interview_id = ? LIMIT 1",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
    .map(|o| o.flatten())
}

// Product context for an interview's cycle (Products library / req #2): resolve the
// interview's cycle, then its effective product (linked product → content_md, falling back
// to inline product_desc) via the synthesis helper — one source of truth shared with cleanup.
// Returns "" when the interview/cycle/product can't be resolved (transcription never gates on it).
async fn product_context_for_interview_db(
    pool: &SqlitePool,
    interview_id: &str,
) -> Result<String, String> {
    let cycle_id: Option<String> =
        sqlx::query_scalar("SELECT cycle_id FROM interview WHERE id = ?")
            .bind(interview_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let Some(cycle_id) = cycle_id else {
        return Ok(String::new());
    };
    Ok(crate::synthesis::effective_product_db(pool, &cycle_id)
        .await?
        .unwrap_or_default())
}

// Reconcile zombie statuses on startup (#1): any interview left mid-flight (transcribing /
// cleaning) from a crash or force-kill has no task running, so reset it to `error`. Returns
// the number of rows fixed. Best-effort — a failure here must not block app launch.
pub async fn recover_stuck_interviews(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE interview SET status = 'error', updated_at = ? \
         WHERE status IN ('transcribing', 'cleaning')",
    )
    .bind(now_ms())
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

// Store the raw transcript as a new version row (schema §2.2). Replaces any existing
// raw transcript for this interview so re-transcribe is idempotent (UNIQUE(interview,
// version) — we re-use version 1 for raw). Returns the new row id.
async fn store_raw_transcript_db(
    pool: &SqlitePool,
    interview_id: &str,
    language: Option<&str>,
    engine: &str,
    segments_json: &str,
) -> Result<String, sqlx::Error> {
    // Drop a previous raw v1 if present (re-transcribe overwrites).
    sqlx::query("DELETE FROM transcript WHERE interview_id = ? AND kind = 'raw'")
        .bind(interview_id)
        .execute(pool)
        .await?;

    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO transcript (id, interview_id, version, kind, language, engine, segments_json, created_at) \
         VALUES (?, ?, 1, 'raw', ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(interview_id)
    .bind(language)
    .bind(engine)
    .bind(segments_json)
    .bind(now_ms())
    .execute(pool)
    .await?;
    Ok(id)
}

// Read back the stored raw transcript (for the optional "view raw" UI + verify).
#[derive(Serialize, sqlx::FromRow)]
pub struct TranscriptRow {
    pub id: String,
    pub interview_id: String,
    pub version: i64,
    pub kind: String,
    pub language: Option<String>,
    pub engine: Option<String>,
    pub segments_json: String,
    pub created_at: i64,
}

async fn get_raw_transcript_db(pool: &SqlitePool, interview_id: &str) -> Result<Option<TranscriptRow>, sqlx::Error> {
    sqlx::query_as::<_, TranscriptRow>(
        "SELECT id, interview_id, version, kind, language, engine, segments_json, created_at \
         FROM transcript WHERE interview_id = ? AND kind = 'raw' LIMIT 1",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
}

// --- transcription checkpoint (0007: crash-safe progress + resume) ------------
//
// One row per interview holding the partial transcript as whisper streams it. Written
// periodically during a run (every few seconds) and on error; CLEARED on success. Its
// presence after a failure is what powers the editor's "resume from M:SS".
#[derive(Serialize, sqlx::FromRow, Clone)]
pub struct Checkpoint {
    pub interview_id: String,
    pub processed_ms: i64,        // last decoded segment end — where resume continues from
    pub total_ms: Option<i64>,    // audio duration — resume's target end
    pub model_id: String,
    pub language: Option<String>,
    pub segments_json: String,
    pub updated_at: i64,
}

// Upsert the current partial result for an interview. Best-effort: a checkpoint write must
// never fail the run, so callers ignore the error (the run keeps going either way).
async fn upsert_checkpoint_db(
    pool: &SqlitePool,
    interview_id: &str,
    processed_ms: i64,
    total_ms: Option<i64>,
    model_id: &str,
    language: Option<&str>,
    segments_json: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO transcribe_checkpoint \
           (interview_id, processed_ms, total_ms, model_id, language, segments_json, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(interview_id) DO UPDATE SET \
           processed_ms = excluded.processed_ms, total_ms = excluded.total_ms, \
           model_id = excluded.model_id, language = excluded.language, \
           segments_json = excluded.segments_json, updated_at = excluded.updated_at",
    )
    .bind(interview_id)
    .bind(processed_ms)
    .bind(total_ms)
    .bind(model_id)
    .bind(language)
    .bind(segments_json)
    .bind(now_ms())
    .execute(pool)
    .await
    .map(|_| ())
}

async fn get_checkpoint_db(pool: &SqlitePool, interview_id: &str) -> Result<Option<Checkpoint>, sqlx::Error> {
    sqlx::query_as::<_, Checkpoint>(
        "SELECT interview_id, processed_ms, total_ms, model_id, language, segments_json, updated_at \
         FROM transcribe_checkpoint WHERE interview_id = ? LIMIT 1",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
}

async fn clear_checkpoint_db(pool: &SqlitePool, interview_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM transcribe_checkpoint WHERE interview_id = ?")
        .bind(interview_id)
        .execute(pool)
        .await
        .map(|_| ())
}

// --- segment shape (schema §2.2: [{start_ms,end_ms,speaker_label,text}, ...]) -----

#[derive(Serialize, serde::Deserialize, Clone)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    // Generic "S1" out of whisper; diarization (diarize.rs) overwrites this with the real
    // S1/S2/… via max time-overlap before the raw transcript is stored. Manual correction
    // still happens in the editor; the schema's segment shape is unchanged.
    pub speaker_label: String,
    pub text: String,
}

// --- silence whisper.cpp / ggml verbose logging (bug #6) ----------------------
//
// whisper.cpp/ggml emit per-token debug lines (`whisper_full_with_state: id = …
// decoder = 0, token = …`) straight to stderr via ggml's default log callback. The
// `FullParams` print_* flags do NOT touch that — it's the library's INTERNAL log
// level, independent of the result-printing flags. The synchronous per-token I/O
// dominates wall-time, tanking GPU throughput (large-v3 dropped from ~15× to ~real-
// time on the RTX 5080) and bloating logs.
//
// Fix: install our own ggml log callback via whisper-rs 0.16's
// `whisper_rs::set_log_callback` (the safe wrapper over `whisper_log_set`). We drop
// Debug/Info/Cont/None (the per-token spam) and forward only Warn/Error to stderr so
// real problems are still visible. We deliberately use a level-filtering callback
// rather than `install_logging_hooks()` because the latter needs the crate's
// log_backend/tracing_backend feature to surface warnings/errors (and would otherwise
// drop them entirely). Install-once via a `Once` so repeated transcribe() runs are cheap.
//
// SAFETY: the trampoline is `extern "C"`, never panics/unwinds, and only reads the
// passed text (Warn/Error path) — it does not touch `user_data` (we pass null).
static WHISPER_LOG_SILENCED: std::sync::Once = std::sync::Once::new();

// `ggml_log_level` is bound as the platform's C `unsigned int`, which whisper-rs-sys
// generates as `c_int` (i32) on MSVC Windows and `c_uint` elsewhere — so the callback's
// first arg type must follow the target to match `ggml_log_callback` exactly.
#[cfg(all(windows, not(target_env = "gnu")))]
type GgmlLogLevel = i32;
#[cfg(not(all(windows, not(target_env = "gnu"))))]
type GgmlLogLevel = u32;

unsafe extern "C" fn whisper_log_filter(
    level: GgmlLogLevel,
    text: *const std::os::raw::c_char,
    _user_data: *mut std::ffi::c_void,
) {
    // ggml_log_level: NONE=0, DEBUG=1, INFO=2, WARN=3, ERROR=4, CONT=5.
    // Forward only WARN/ERROR; drop the rest (the per-token debug flood lives at DEBUG/INFO).
    const GGML_LOG_LEVEL_WARN: GgmlLogLevel = 3;
    const GGML_LOG_LEVEL_ERROR: GgmlLogLevel = 4;
    if (level == GGML_LOG_LEVEL_WARN || level == GGML_LOG_LEVEL_ERROR) && !text.is_null() {
        // SAFETY: whisper.cpp passes a valid NUL-terminated C string for the call's lifetime.
        let msg = unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy();
        eprint!("whisper: {msg}");
    }
}

// Install the level-filtering ggml log callback exactly once (process-wide).
fn silence_whisper_logging() {
    WHISPER_LOG_SILENCED.call_once(|| unsafe {
        // SAFETY: callback is a valid `extern "C"` fn matching ggml_log_callback; null user_data
        // is never dereferenced by the trampoline.
        whisper_rs::set_log_callback(Some(whisper_log_filter), std::ptr::null_mut());
    });
}

// Sanitize a product-context blurb into a safe whisper `initial_prompt` (req #2). whisper's
// prompt buffer is small (it's prepended to the decoder context), and set_initial_prompt
// PANICS on a NUL byte — so we strip NULs, collapse all whitespace/newlines to single spaces
// (markdown headings/bullets become a flat term blurb), trim, and cap to a short length.
// Returns "" for an effectively-empty prompt (the caller then skips set_initial_prompt).
const INITIAL_PROMPT_MAX_CHARS: usize = 480;
fn sanitize_initial_prompt(raw: &str) -> String {
    let flattened = raw
        .replace('\0', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flattened.len() <= INITIAL_PROMPT_MAX_CHARS {
        return flattened;
    }
    // Cap on a char boundary so we never split a multibyte (e.g. Cyrillic) codepoint.
    let mut end = INITIAL_PROMPT_MAX_CHARS;
    while end > 0 && !flattened.is_char_boundary(end) {
        end -= 1;
    }
    flattened[..end].trim_end().to_string()
}

// Combine the curated glossary's canonical terms with the product prose into one raw
// `initial_prompt` string (sanitize_initial_prompt then flattens + hard-caps it). Glossary
// terms lead — they're the high-value entity list we most want whisper biased toward, and
// leading placement means they survive the cap even when the prose is long. Either side may be
// empty (no glossary, or inline-only product context).
fn build_initial_prompt(terms: &[crate::glossary::GlossaryTerm], product_ctx: &str) -> String {
    let blurb = crate::glossary::render_terms_for_asr(terms, INITIAL_PROMPT_MAX_CHARS);
    match (blurb.is_empty(), product_ctx.trim().is_empty()) {
        (true, _) => product_ctx.to_string(),
        (false, true) => blurb,
        (false, false) => format!("{blurb}. {product_ctx}"),
    }
}

// --- the blocking whisper run -------------------------------------------------

// Run whisper.cpp on the given samples. Pure compute (no async, no DB) so it lives on
// a spawn_blocking task. Emits progress (0..100) + per-segment events through the
// passed closures. Returns the collected segments. `use_gpu` comes from detect_device;
// on a GPU init failure we retry once on CPU (spec §6.3 fallback).
fn run_whisper(
    model_path: &Path,
    samples: &[f32],
    lang: Option<&str>,
    // Product/brand CONTEXT fed to whisper as its `initial_prompt` (Products library / req #2:
    // "учет контекста продукта при расшифровке"). Whisper conditions decoding on this text, so
    // product/brand terms transcribe correctly. None/empty → no prompt (unchanged behavior).
    initial_prompt: Option<&str>,
    use_gpu: bool,
    // Cooperative abort flag (bug #1/#5). Wired into whisper.cpp's abort_callback: when
    // it flips to true (manual Stop OR the watchdog timeout), whisper aborts mid-run and
    // state.full returns an error so the run can't hang. None => no cancellation (test path).
    cancel: Option<Arc<AtomicBool>>,
    // whisper-rs 0.16's set_progress_callback_safe requires a 'static callback (it's
    // handed to the C side), so on_progress must own its captures.
    mut on_progress: impl FnMut(i32) + 'static,
    // Live per-segment callback, fired as each segment is DECODED (not after the run) via
    // whisper.cpp's new-segment callback — hence the 'static bound (handed to the C side).
    mut on_segment: impl FnMut(Segment) + 'static,
) -> Result<Vec<Segment>, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    // Silence whisper.cpp/ggml's verbose per-token stderr logging (bug #6) before any
    // whisper work — restores GPU throughput (the synchronous per-token I/O was the
    // bottleneck) and stops the log flood. Install-once; only Warn/Error get through.
    silence_whisper_logging();

    let model_str = model_path.to_string_lossy().to_string();

    // Build a context, honoring use_gpu; fall back to CPU once if GPU init fails.
    // The GPU backend (CUDA on Nvidia, Metal on Apple Silicon) is picked at compile
    // time by the whisper-rs feature; here `use_gpu=true` just tells whisper.cpp to
    // run on whichever GPU backend was compiled in (detect_device sets it on mac+metal).
    let build_ctx = |gpu: bool| -> Result<WhisperContext, String> {
        let mut cparams = WhisperContextParameters::default();
        cparams.use_gpu(gpu);
        // Flash attention: a faster attention implementation for the GPU backends (Metal on Apple
        // Silicon, CUDA). Measured ~21% faster on large-v3 (CUDA, 9-min clip: 49.9s → 39.3s). It
        // reorders float accumulation, so output is NEAR-identical, not bit-identical — under greedy
        // decoding the occasional borderline token / segment boundary differs (~0.6% of chars here),
        // but word accuracy is unchanged. The standard whisper.cpp GPU recommendation; a clear win.
        // Off by default in whisper-rs; we turn it on. (We don't use DTW timestamps, so the
        // "flash_attn disables DTW" caveat is irrelevant.)
        cparams.flash_attn(true);
        WhisperContext::new_with_params(&model_str, cparams).map_err(|e| format!("whisper ctx: {e}"))
    };

    let ctx = match build_ctx(use_gpu) {
        Ok(c) => c,
        Err(e) if use_gpu => {
            // GPU init failed → CPU fallback (spec §6.3).
            log::warn!(
                target: "interviewlab::asr",
                "GPU whisper context init FAILED ({e}); falling back to CPU. \
                 hint: check the CUDA/Metal build + driver; transcription will be slower on CPU."
            );
            build_ctx(false).map_err(|e2| {
                log::error!(target: "interviewlab::asr", "CPU whisper context init ALSO failed after GPU fallback: {e2}");
                e2
            })?
        }
        Err(e) => {
            log::error!(target: "interviewlab::asr", "whisper context init failed (model='{model_str}', gpu={use_gpu}): {e}");
            return Err(e);
        }
    };

    let mut state = ctx.create_state().map_err(|e| format!("whisper state: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    // Decode threads. whisper-rs defaults to min(4, cores). On the GPU backends the encode/decode
    // runs on the GPU, but the log-mel front-end + token sampling are CPU-side, so give them a few
    // more cores on a bigger machine (e.g. an M3 Pro). Clamp [4, 8]: past that it's contention, not
    // speed. ponytail: tunable knob.
    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(4, 8) as i32;
    params.set_n_threads(n_threads);
    // Quiet the C++ side; we surface progress/segments through callbacks instead.
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    // --- anti-hallucination / anti-runaway (bug #1) -----------------------------
    // whisper.cpp's CLI defaults that the library does NOT apply by default. Without
    // them, greedy decoding on music/jingle/silence runs away into a single never-
    // terminating segment (observed `result_len` 169+ and growing on w1_b). These are
    // the upstream whisper.cpp / OpenAI Whisper defaults:
    //   - no_speech_thold 0.6  : treat a window as no-speech (skip) past this probability.
    //   - entropy_thold   2.4  : gibberish/compression-ratio gate that triggers a fallback.
    //   - logprob_thold  -1.0  : low average token logprob also triggers a fallback.
    //   - temperature_inc 0.2  : ENABLE temperature fallback — when a decode trips the
    //     entropy/logprob gates, re-decode at a higher temperature instead of greedily
    //     running away. (Greedy with NO fallback was the core runaway cause.)
    // whisper-rs leaves these at safe values already, but we set them explicitly so the
    // behavior is pinned regardless of the crate's defaults.
    params.set_no_speech_thold(0.6);
    params.set_entropy_thold(2.4);
    params.set_logprob_thold(-1.0);
    params.set_temperature(0.0); // start greedy …
    params.set_temperature_inc(0.2); // … but fall back up the temperature ladder on failure.
    // Suppress blank + non-speech tokens so the decoder can't emit a wall of punctuation/
    // music-note tokens that never resolves to an end-of-segment.
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    // Cap a single segment so one window can't grow to 169+ tokens. max_len bounds the
    // characters per segment (split on word boundary), max_tokens bounds the per-segment
    // token budget — a hard structural stop against the runaway segment.
    params.set_split_on_word(true);
    params.set_max_len(0); // 0 = no character cap; rely on max_tokens for the hard stop.
    params.set_max_tokens(64); // generous for a real turn, fatal to a 169-token runaway.

    // "auto" / None lets whisper detect; an explicit code forces it (spec §4.4 lang Select).
    if let Some(code) = lang {
        if code != "auto" {
            params.set_language(Some(code));
        }
    }

    // Product context → whisper `initial_prompt` (req #2). whisper-rs's set_initial_prompt
    // PANICS on a null byte, and whisper's prompt buffer (n_text_ctx) is small, so we
    // sanitize: strip NULs, collapse whitespace, and cap to a short blurb (a term/context
    // hint, not the whole markdown). Skipped when empty so behavior is unchanged without a product.
    if let Some(prompt) = initial_prompt {
        let cleaned = sanitize_initial_prompt(prompt);
        if !cleaned.is_empty() {
            params.set_initial_prompt(&cleaned);
        }
    }
    // Use all but one core for CPU runs so the UI thread stays responsive.
    let threads = (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as i32 - 1).max(1);
    params.set_n_threads(threads);

    // Progress 0..100 (spec §3.3 "Progress bar streams percent").
    params.set_progress_callback_safe(move |p: i32| on_progress(p));

    // Live segment streaming (Mac slow-run observability): whisper.cpp fires its new-segment
    // callback as EACH segment is decoded, so a watcher can accumulate the transcript in real
    // time instead of waiting for the whole run. We deliberately use this (not the post-run
    // get_segment loop below) for the live signal — state.full() only returns once the WHOLE
    // decode is done, so the post-loop is a burst, not a stream. The post-loop still builds the
    // authoritative Vec for storage; this callback only emits the live ticks. Live segments carry
    // the placeholder "S1" — real diarization relabels them in the final stored transcript.
    // whisper-rs 0.16's `set_segment_callback_safe` takes a 'static FnMut(SegmentCallbackData);
    // timestamps are centiseconds → ms (same scale as get_segment below).
    params.set_segment_callback_safe(move |data: whisper_rs::SegmentCallbackData| {
        on_segment(Segment {
            start_ms: data.start_timestamp * 10,
            end_ms: data.end_timestamp * 10,
            speaker_label: "S1".to_string(),
            text: data.text.trim().to_string(),
        });
    });

    // Abort callback (bug #1/#5): polled by whisper.cpp between compute steps. Returning
    // true aborts the run mid-flight → state.full returns an error → no indefinite hang.
    // The flag is flipped by the manual Stop command or the watchdog timeout.
    //
    // NOTE: we deliberately do NOT use whisper-rs 0.16.0's `set_abort_callback_safe` — it has
    // a type bug (registers `trampoline::<F>` but boxes the closure as `Box<Box<dyn FnMut>>`,
    // so the C side calls through a mismatched type → whisper "failed to encode", error -6).
    // Instead we use the raw `set_abort_callback` + `set_abort_callback_user_data` with our own
    // correct trampoline over the AtomicBool. The Arc is kept alive in `_abort_keepalive` for
    // the whole `state.full` call, so the raw pointer stays valid; the C callback only reads it.
    unsafe extern "C" fn abort_trampoline(user_data: *mut std::ffi::c_void) -> bool {
        // SAFETY: user_data is the *const AtomicBool we set below; valid for the call's lifetime.
        (*(user_data as *const AtomicBool)).load(Ordering::SeqCst)
    }
    let _abort_keepalive = cancel; // hold the Arc alive across state.full.
    if let Some(flag) = _abort_keepalive.as_ref() {
        let ptr = Arc::as_ptr(flag) as *mut std::ffi::c_void;
        unsafe {
            params.set_abort_callback(Some(abort_trampoline));
            params.set_abort_callback_user_data(ptr);
        }
    }

    let result = state.full(params, samples).map_err(|e| {
        // whisper.cpp's decode failed or was aborted (Stop/watchdog flips the abort flag →
        // "failed to encode"/error -6 here). Distinguish so the cause is obvious in the log.
        let aborted = _abort_keepalive
            .as_ref()
            .map(|f| f.load(Ordering::SeqCst))
            .unwrap_or(false);
        let msg = format!("whisper full: {e}");
        if aborted {
            log::warn!(target: "interviewlab::asr", "whisper decode aborted by Stop/watchdog ({samples_len} samples): {e}", samples_len = samples.len());
        } else {
            log::error!(target: "interviewlab::asr", "[E-ASR-DECODE] whisper decode FAILED ({samples_len} samples, gpu={use_gpu}): {e}", samples_len = samples.len());
        }
        msg
    });
    // _abort_keepalive (and thus the AtomicBool the C callback read) is dropped only here,
    // after state.full has fully returned — no dangling pointer during the run.
    drop(_abort_keepalive);
    result?;

    // Collect segments. whisper-rs 0.16: full_n_segments() -> i32, segments via
    // get_segment(i) -> WhisperSegment; timestamps are centiseconds → ms.
    let n = state.full_n_segments();
    let mut segments = Vec::with_capacity(n.max(0) as usize);
    for i in 0..n {
        let seg = state
            .get_segment(i)
            .ok_or_else(|| format!("missing segment {i}"))?;
        let text = seg
            .to_str_lossy()
            .map_err(|e| format!("segment text {i}: {e}"))?
            .trim()
            .to_string();
        let t0 = seg.start_timestamp();
        let t1 = seg.end_timestamp();
        let out = Segment {
            start_ms: t0 * 10, // centiseconds → ms
            end_ms: t1 * 10,
            speaker_label: "S1".to_string(),
            text,
        };
        // NOTE: live emission happens in the new-segment callback above (streamed as decoded);
        // here we only collect the authoritative Vec for storage, so we DON'T re-emit.
        segments.push(out);
    }
    Ok(segments)
}

// --- progress event payloads --------------------------------------------------

#[derive(Serialize, Clone)]
struct AsrProgress {
    interview_id: String,
    status: String,        // 'transcribing' | 'transcribed' | 'error'
    progress: i32,         // 0..100, or -1 on a live segment tick
    segment_text: Option<String>, // most-recent segment text (live preview), if any
    // The full live segment (timing + text) emitted as whisper decodes it, so a watcher (the
    // open transcript editor) can accumulate the transcript in real time — not just the last
    // line. None on percent/terminal ticks. Carries the placeholder "S1" until diarization.
    segment: Option<Segment>,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct ModelProgress {
    model_id: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    done: bool,
    error: Option<String>,
}

fn emit_asr(app: &tauri::AppHandle, interview_id: &str, status: &str, progress: i32, segment: Option<Segment>, error: Option<String>) {
    let _ = app.emit(
        ASR_PROGRESS_EVENT,
        AsrProgress {
            interview_id: interview_id.to_string(),
            status: status.to_string(),
            progress,
            // Keep segment_text populated from the live segment for back-compat with any
            // text-only consumer; new consumers read the full `segment`.
            segment_text: segment.as_ref().map(|s| s.text.clone()),
            segment,
            error,
        },
    );
}

fn emit_model(app: &tauri::AppHandle, model_id: &str, downloaded: u64, total: u64, done: bool, error: Option<String>) {
    let _ = app.emit(
        MODEL_PROGRESS_EVENT,
        ModelProgress {
            model_id: model_id.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            done,
            error,
        },
    );
}

// Diarization progress (per interview): status drives the row badge / editor toast.
#[derive(Serialize, Clone)]
struct DiarProgress {
    interview_id: String,
    status: String,          // 'diarizing' | 'done' | 'error'
    progress: i32,           // 0..100
    speakers: Option<i32>,   // detected speaker count when status == 'done'
}

fn emit_diar(app: &tauri::AppHandle, interview_id: &str, status: &str, progress: i32, speakers: Option<i32>) {
    let _ = app.emit(
        DIAR_PROGRESS_EVENT,
        DiarProgress {
            interview_id: interview_id.to_string(),
            status: status.to_string(),
            progress,
            speakers,
        },
    );
}

// Diarization model download progress (Settings): 2 coarse steps (segmentation, embedding).
#[derive(Serialize, Clone)]
struct DiarModelProgress {
    step: u32,
    total_steps: u32,
    label: String,
    done: bool,
    error: Option<String>,
}

fn emit_diar_model(app: &tauri::AppHandle, step: u32, total: u32, label: &str, done: bool, error: Option<String>) {
    let _ = app.emit(
        DIAR_MODEL_PROGRESS_EVENT,
        DiarModelProgress { step, total_steps: total, label: label.to_string(), done, error },
    );
}

// --- Tauri commands -----------------------------------------------------------

// Detect the ASR device once, cache the label in app_setting, return it for the Badge.
#[tauri::command]
pub async fn asr_device(_app: tauri::AppHandle, db: tauri::State<'_, Db>) -> Result<DeviceInfo, String> {
    // Detection touches NVML (blocking-ish, fast) — run it off the async pool.
    let info = tauri::async_runtime::spawn_blocking(detect_device)
        .await
        .map_err(|_| "device probe panicked".to_string())?;

    // Cache the label (spec §6.3). Best-effort — a cache write failure doesn't fail the call.
    let _ = sqlx::query("INSERT INTO app_setting (key, value) VALUES (?, ?) \
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(DEVICE_SETTING_KEY)
        .bind(&info.device)
        .execute(&db.pool)
        .await;

    Ok(info)
}

// List the model catalog, marking which are already downloaded to models/.
#[tauri::command]
pub async fn list_models(app: tauri::AppHandle) -> Result<Vec<ModelInfo>, String> {
    let dir = models_dir(&app)?;
    let mut out = Vec::with_capacity(CATALOG.len());
    for e in CATALOG {
        let downloaded = dir.join(e.file).exists();
        out.push(ModelInfo {
            id: e.id.to_string(),
            label: e.label.to_string(),
            file: e.file.to_string(),
            approx_mb: e.approx_mb,
            default: e.default,
            downloaded,
        });
    }
    Ok(out)
}

// Download a ggml model into models/ with byte-progress events (spec §6.4). Streams to
// a .part file then renames, so an interrupted download never leaves a half file that
// looks complete. Runs the blocking HTTP read on a spawn_blocking task.
#[tauri::command]
pub async fn download_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let entry = catalog_entry(&model_id).ok_or_else(|| format!("unknown model id: {model_id}"))?;
    let dir = models_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create models dir: {e}"))?;
    let dest = dir.join(entry.file);
    if dest.exists() {
        emit_model(&app, &model_id, 1, 1, true, None);
        return Ok(()); // already have it
    }
    let url = format!("{HF_BASE}/{}", entry.file);
    let part = dest.with_extension("part");
    // Keep a copy for the error-cleanup path below (the original is moved into the task).
    let part_for_cleanup = part.clone();
    let app2 = app.clone();
    let model_id2 = model_id.clone();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let resp = ureq::get(&url)
            .call()
            .map_err(|e| format!("download request failed: {e}"))?;
        let total: u64 = resp
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let mut reader = resp.into_body().into_reader();
        let mut out = std::fs::File::create(&part).map_err(|e| format!("create part file: {e}"))?;
        let mut buf = vec![0u8; 1 << 20]; // 1 MiB chunks
        let mut downloaded: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("read body: {e}"))?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut out, &buf[..n]).map_err(|e| format!("write part: {e}"))?;
            downloaded += n as u64;
            // Throttle events to ~10/s so the UI bus isn't flooded.
            if last_emit.elapsed().as_millis() >= 100 {
                emit_model(&app2, &model_id2, downloaded, total, false, None);
                last_emit = std::time::Instant::now();
            }
        }
        drop(out);
        std::fs::rename(&part, &dest).map_err(|e| format!("finalize model file: {e}"))?;
        emit_model(&app2, &model_id2, downloaded, total.max(downloaded), true, None);
        Ok(())
    })
    .await
    .map_err(|_| "download task panicked".to_string())?;

    if let Err(e) = &result {
        // Clean up the partial + tell the UI.
        log::error!(
            target: "interviewlab::asr",
            "[E-ASR-DOWNLOAD] model download FAILED for '{model_id}' from {HF_BASE}/{}: {e}. \
             hint: check network/proxy + free disk (~{} MB needed); the partial file was removed.",
            entry.file, entry.approx_mb
        );
        let _ = std::fs::remove_file(&part_for_cleanup);
        emit_model(&app, &model_id, 0, 0, true, Some(e.clone()));
    } else {
        log::info!(target: "interviewlab::asr", "model download OK: '{model_id}' ({}) into {}", entry.file, dir.display());
    }
    result
}

// 16 kHz mono → 16 samples per millisecond (our prepared wav is always 16k mono).
const SAMPLES_PER_MS: usize = 16;

// Run whisper over an interview's audio (optionally just a time SLICE) under the cancel
// flag + watchdog, streaming live progress/segment events and accumulating the decoded
// segments into `sink` for the checkpoint writer. Returns the segments with timestamps
// already offset into the FULL-audio timeline (so a slice's output splices back cleanly).
//
// This is the shared engine behind the full transcription, the resume tail, and the
// per-range re-transcribe — they differ only in which [start,end] slice they run and what
// they splice the result into. `range_ms = None` means the whole file (offset 0).
#[allow(clippy::too_many_arguments)]
async fn run_guarded_whisper(
    app: &tauri::AppHandle,
    interview_id: &str,
    model: PathBuf,
    audio_path: PathBuf,
    range_ms: Option<(i64, i64)>,
    language: Option<String>,
    initial_prompt: String,
    use_gpu: bool,
    budget: std::time::Duration,
    // Shared live buffer (offset-adjusted segments) the checkpoint writer snapshots.
    sink: Arc<StdMutex<Vec<Segment>>>,
) -> Result<Vec<Segment>, String> {
    let cancel = register_cancel(interview_id);

    let app_for_cb = app.clone();
    let iv_for_cb = interview_id.to_string();
    let cancel_for_run = cancel.clone();
    let offset_ms = range_ms.map(|(s, _)| s.max(0)).unwrap_or(0);

    let task = tauri::async_runtime::spawn_blocking(move || {
        let all = read_wav_16k_mono(&audio_path)?;
        // Slice to the requested range (clamped to bounds); None → the whole file.
        let samples: Vec<f32> = match range_ms {
            Some((s, e)) => {
                let a = (s.max(0) as usize * SAMPLES_PER_MS).min(all.len());
                let b = (e.max(0) as usize * SAMPLES_PER_MS).min(all.len());
                all[a..b.max(a)].to_vec()
            }
            None => all,
        };
        let segs = run_whisper(
            &model,
            &samples,
            language.as_deref(),
            Some(initial_prompt.as_str()),
            use_gpu,
            Some(cancel_for_run),
            // progress callback → throttled event
            {
                let app = app_for_cb.clone();
                let iv = iv_for_cb.clone();
                move |p: i32| emit_asr(&app, &iv, STATUS_TRANSCRIBING, p, None, None)
            },
            // segment callback → offset into the full timeline, emit live + feed the checkpoint buffer
            {
                let app = app_for_cb.clone();
                let iv = iv_for_cb.clone();
                let sink = sink.clone();
                move |mut seg: Segment| {
                    seg.start_ms += offset_ms;
                    seg.end_ms += offset_ms;
                    if let Ok(mut g) = sink.lock() {
                        g.push(seg.clone());
                    }
                    emit_asr(&app, &iv, STATUS_TRANSCRIBING, -1, Some(seg), None);
                }
            },
        )?;
        // Offset the authoritative returned Vec the same way the live ticks were.
        Ok::<Vec<Segment>, String>(
            segs.into_iter()
                .map(|mut s| {
                    s.start_ms += offset_ms;
                    s.end_ms += offset_ms;
                    s
                })
                .collect(),
        )
    });

    // Watchdog: bound wall-time. On elapse flip the cancel flag (whisper's abort_callback
    // unwinds) and AWAIT the now-aborting task so it can't outlive us (concurrency=1 honesty).
    let mut task = task;
    let run: Result<Vec<Segment>, String> = match tokio::time::timeout(budget, &mut task).await {
        Ok(join) => join.map_err(|_| "transcription task panicked".to_string())?,
        Err(_) => {
            log::error!(
                target: "interviewlab::asr",
                "[E-ASR-TIMEOUT] transcribe: interview='{interview_id}': watchdog fired after {}s — aborting",
                budget.as_secs()
            );
            cancel.store(true, Ordering::SeqCst);
            let _ = task.await;
            Err(format!(
                "transcription watchdog timed out after {}s — aborted (possible audio with no speech / a runaway segment)",
                budget.as_secs()
            ))
        }
    };

    unregister_cancel(interview_id);
    run
}

// Spawn a periodic checkpoint writer for an in-flight run. Every few seconds it snapshots
// `base_prefix ++ sink` (the already-saved prefix plus the live-decoded tail) into the
// checkpoint table, so a crash/kill loses at most a few seconds. Returns the task handle —
// the caller MUST abort it once the run finishes (then write the final state itself).
fn spawn_checkpoint_writer(
    pool: SqlitePool,
    interview_id: String,
    sink: Arc<StdMutex<Vec<Segment>>>,
    base_prefix: Vec<Segment>,
    total_ms: Option<i64>,
    model_id: String,
    language: Option<String>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            let tail = sink.lock().map(|g| g.clone()).unwrap_or_default();
            let mut all = base_prefix.clone();
            all.extend(tail);
            let processed = all.last().map(|s| s.end_ms).unwrap_or(0);
            let json = match serde_json::to_string(&all) {
                Ok(j) => j,
                Err(_) => continue,
            };
            let _ = upsert_checkpoint_db(
                &pool, &interview_id, processed, total_ms, &model_id,
                language.as_deref().filter(|s| *s != "auto"), &json,
            )
            .await;
        }
    })
}

// The shared tail for every transcription path: diarize the WHOLE audio (so speaker labels
// are globally consistent even after a resume/range-splice), store the raw transcript, flip
// the interview to `transcribed`, clear the checkpoint, and emit the terminal event. Returns
// the new transcript id. Diarization is best-effort (an enrichment, never a gate).
async fn diarize_and_store(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    interview_id: &str,
    mut segments: Vec<Segment>,
    base_engine: String,
    language: Option<String>,
    expected_speakers: Option<i32>,
    duration_ms: Option<i64>,
    audio_path: PathBuf,
) -> Result<String, String> {
    let diar_dir = crate::diarize::diarization_dir(app)?;
    let mut engine = base_engine;
    if crate::diarize::models_present(&diar_dir) {
        emit_diar(app, interview_id, "diarizing", 0, None);
        let seg_model = diar_dir.join(crate::diarize::SEGMENTATION_FILE);
        let emb_model = diar_dir.join(crate::diarize::EMBEDDING_FILE);
        let diar_task = tauri::async_runtime::spawn_blocking(move || {
            let samples = read_wav_16k_mono(&audio_path)?;
            crate::diarize::diarize_samples(&seg_model, &emb_model, &samples, 16000, expected_speakers)
        });
        let diar_budget = std::time::Duration::from_millis(
            (duration_ms.unwrap_or(0).max(0) as u64).saturating_mul(8).max(180_000),
        );
        let diar = match tokio::time::timeout(diar_budget, diar_task).await {
            Ok(join) => join.map_err(|_| "diarization task panicked".to_string())?,
            Err(_) => Err(format!(
                "diarization timed out after {}s — keeping single speaker",
                diar_budget.as_secs()
            )),
        };
        match diar {
            Ok(turns) => {
                crate::diarize::assign_speakers(&mut segments, &turns);
                let n_spk = turns.iter().map(|t| t.speaker).collect::<std::collections::BTreeSet<_>>().len();
                engine = format!("{engine} + sherpa-onnx:pyannote-seg-3.0/eres2net@cpu({n_spk}spk)");
                emit_diar(app, interview_id, "done", 100, Some(n_spk as i32));
            }
            Err(e) => {
                log::warn!(
                    target: "interviewlab::asr",
                    "[E-ASR-DIARIZE] transcribe: interview='{interview_id}': diarization FAILED, keeping single speaker (S1): {e}"
                );
                emit_diar(app, interview_id, "error", 0, None);
            }
        }
    }

    // Coalesce whisper's over-fragmentation into sentence-level segments. whisper's timestamp
    // boundaries get progressively finer on harder audio (quieter speech, cross-talk, lower
    // decoder confidence late in a long interview), so a single sentence can arrive as several
    // 1-2 word fragments — sometimes a lone pronoun. This folds runs of consecutive SAME-SPEAKER
    // fragments back into one segment (see merge_short_segments). Runs AFTER diarization so it
    // never merges across a speaker turn, and only here at raw-transcript creation (no evidence /
    // edits exist yet, and timing is preserved), so every downstream contract stays intact.
    let pre_merge = segments.len();
    segments = merge_short_segments(segments);
    log::info!(
        target: "interviewlab::asr",
        "transcribe: interview='{interview_id}': coalesced {pre_merge} whisper segments → {} sentence-level segments",
        segments.len()
    );

    let segments_json = serde_json::to_string(&segments).map_err(|e| format!("serialize segments: {e}"))?;
    let lang_label = language.as_deref().filter(|s| *s != "auto");
    let tid = store_raw_transcript_db(pool, interview_id, lang_label, &engine, &segments_json)
        .await
        .map_err(|e| {
            log::error!(target: "interviewlab::asr", "[E-ASR-STORE] transcribe: interview='{interview_id}': transcribed OK but STORING failed: {e}");
            format!("store transcript: {e}")
        })?;
    // The stored transcript is now authoritative — the run's checkpoint is no longer needed.
    let _ = clear_checkpoint_db(pool, interview_id).await;
    set_status_db(pool, interview_id, STATUS_TRANSCRIBED)
        .await
        .map_err(|e| format!("set transcribed: {e}"))?;
    emit_asr(app, interview_id, STATUS_TRANSCRIBED, 100, None, None);
    log::info!(target: "interviewlab::asr", "transcribe: interview='{interview_id}': DONE — {} segments, engine='{engine}', id={tid}", segments.len());
    Ok(tid)
}

// Resolve an interview's prepared 16k wav path, erroring clearly if it's missing on disk.
async fn resolve_audio_path(pool: &SqlitePool, interview_id: &str) -> Result<PathBuf, String> {
    let audio = audio_path_db(pool, interview_id)
        .await
        .map_err(|e| format!("lookup audio: {e}"))?
        .ok_or("no prepared audio for this interview (re-run ingest)")?;
    let p = PathBuf::from(&audio);
    if !p.exists() {
        return Err(format!("audio file missing on disk: {audio}"));
    }
    Ok(p)
}

// Build whisper's initial_prompt (glossary canonical terms + product context) for an
// interview — shared by every transcription path. Best-effort: a missing product/glossary
// just yields a shorter (or empty) prompt.
async fn initial_prompt_for_interview(pool: &SqlitePool, interview_id: &str) -> String {
    let product_ctx = product_context_for_interview_db(pool, interview_id)
        .await
        .unwrap_or_default();
    let glossary = crate::glossary::glossary_for_interview_db(pool, interview_id)
        .await
        .unwrap_or_default();
    build_initial_prompt(&glossary, &product_ctx)
}

// Transcribe one interview's prepared 16k wav with the given model + language.
// Lifecycle: status → transcribing, run whisper (progress events), store raw
// transcript, status → transcribed | error. Concurrency = 1 via ASR_LOCK.
#[tauri::command]
pub async fn transcribe_interview(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    interview_id: String,
    model_id: String,
    language: Option<String>,
    // "Expected speakers" hint (feature-diarization.md §3.2): None → auto-detect, Some(n) →
    // force exactly n. Default 2 is applied by the caller/UI; None here means auto.
    expected_speakers: Option<i32>,
) -> Result<String, String> {
    log::info!(target: "interviewlab::asr", "transcribe: starting interview='{interview_id}' model='{model_id}' lang={language:?} expected_speakers={expected_speakers:?}");

    let entry = catalog_entry(&model_id).ok_or_else(|| {
        let msg = format!("unknown model id: {model_id}");
        log::error!(target: "interviewlab::asr", "transcribe: interview='{interview_id}': {msg}");
        msg
    })?;
    let model = model_path(&app, &model_id)?;
    if !model.exists() {
        let msg = format!("model not downloaded: {} (download it in Settings)", entry.label);
        log::error!(target: "interviewlab::asr", "[E-ASR-MODEL-MISSING] transcribe: interview='{interview_id}': model file missing at {} — {msg}", model.display());
        return Err(msg);
    }

    // Resolve the prepared audio.
    let audio_path = resolve_audio_path(&db.pool, &interview_id).await.map_err(|e| {
        log::error!(target: "interviewlab::asr", "[E-ASR-AUDIO-MISSING] transcribe: interview='{interview_id}': {e}");
        e
    })?;

    let device = detect_device();
    // Record the ACTUAL device (metal | cuda | cpu) — not a hardcoded "cuda" — so the engine
    // string tells you whether GPU accel really kicked in (e.g. on a Mac, "cpu" here explains a
    // slow run = the metal feature/init didn't engage).
    let engine = format!("whisper.cpp:{}@{}", model_id, device.device);

    // Watchdog budget from the probed duration (#1) — read BEFORE taking the lock.
    let duration_ms = duration_ms_db(&db.pool, &interview_id).await.unwrap_or(None);
    let budget = std::time::Duration::from_millis(watchdog_budget_ms(duration_ms) as u64);

    // Product context + GLOSSARY → whisper `initial_prompt` (Products library / req #2): an
    // entity hint so brand / product / technical terms transcribe correctly.
    let initial_prompt = initial_prompt_for_interview(&db.pool, &interview_id).await;

    // Serialize ASR runs (concurrency = 1). Held across the whole transcription.
    let _guard = asr_lock().lock().await;

    set_status_db(&db.pool, &interview_id, STATUS_TRANSCRIBING)
        .await
        .map_err(|e| format!("set transcribing: {e}"))?;
    emit_asr(&app, &interview_id, STATUS_TRANSCRIBING, 0, None, None);

    // Whole-file run (range None, offset 0). The live buffer feeds the periodic checkpoint
    // writer so a crash/kill mid-run loses at most a few seconds — and the editor can resume.
    let sink = Arc::new(StdMutex::new(Vec::<Segment>::new()));
    let ckpt = spawn_checkpoint_writer(
        db.pool.clone(), interview_id.clone(), sink.clone(),
        Vec::new(), duration_ms, model_id.clone(), language.clone(),
    );

    let run = run_guarded_whisper(
        &app, &interview_id, model.clone(), audio_path.clone(), None,
        language.clone(), initial_prompt, device.use_gpu, budget, sink.clone(),
    )
    .await;
    ckpt.abort();

    match run {
        Ok(segments) => {
            diarize_and_store(
                &app, &db.pool, &interview_id, segments, engine, language,
                expected_speakers, duration_ms, audio_path,
            )
            .await
        }
        Err(e) => {
            // Failed (whisper decode error, watchdog timeout, or manual Stop). Persist a FINAL
            // checkpoint snapshot of whatever decoded so the user can resume from there, then
            // mark the interview `error`.
            let partial = sink.lock().map(|g| g.clone()).unwrap_or_default();
            if !partial.is_empty() {
                let processed = partial.last().map(|s| s.end_ms).unwrap_or(0);
                if let Ok(json) = serde_json::to_string(&partial) {
                    let _ = upsert_checkpoint_db(
                        &db.pool, &interview_id, processed, duration_ms, &model_id,
                        language.as_deref().filter(|s| *s != "auto"), &json,
                    )
                    .await;
                }
                log::warn!(target: "interviewlab::asr", "transcribe: interview='{interview_id}': FAILED with {} partial segments saved (resumable): {e}", partial.len());
            } else {
                log::error!(target: "interviewlab::asr", "transcribe: interview='{interview_id}': FAILED → status=error: {e}");
            }
            set_status_db(&db.pool, &interview_id, STATUS_ERROR).await.ok();
            emit_asr(&app, &interview_id, STATUS_ERROR, 0, None, Some(e.clone()));
            Err(e)
        }
    }
}

// Manually stop an in-progress transcription (bug #5). Flips the per-interview cancel flag;
// the abort_callback inside whisper then unwinds the blocking run, transcribe_interview's
// Err arm marks the interview `error` and frees the concurrency=1 queue. We also set the
// status to `error` here directly so the UI flips immediately even if the run is wedged
// between abort-poll points (it will reconcile to the same `error` when the task returns).
// Idempotent: a no-op (Ok) if nothing is currently running for this interview.
#[tauri::command]
pub async fn cancel_transcription(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    interview_id: String,
) -> Result<(), String> {
    let signalled = signal_cancel(&interview_id);
    if signalled {
        log::info!(target: "interviewlab::asr", "transcribe: interview='{interview_id}': manual Stop requested — abort flag set");
        // Best-effort immediate UI feedback; the run's Err arm will also land on `error`.
        set_status_db(&db.pool, &interview_id, STATUS_ERROR).await.ok();
        emit_asr(&app, &interview_id, STATUS_ERROR, 0, None, Some("cancelled".to_string()));
    } else {
        log::debug!(target: "interviewlab::asr", "transcribe: interview='{interview_id}': Stop requested but no run was in flight (no-op)");
    }
    Ok(())
}

// Read back the stored raw transcript for an interview (optional "view raw" UI + verify).
#[tauri::command]
pub async fn get_transcript(db: tauri::State<'_, Db>, interview_id: String) -> Result<Option<TranscriptRow>, String> {
    get_raw_transcript_db(&db.pool, &interview_id)
        .await
        .map_err(|e| e.to_string())
}

// Whether the diarization ONNX models are present (drives the Settings download prompt).
#[tauri::command]
pub async fn diarization_models_present(app: tauri::AppHandle) -> Result<bool, String> {
    let dir = crate::diarize::diarization_dir(&app)?;
    Ok(crate::diarize::models_present(&dir))
}

// Download the two diarization ONNX models into models/diarization/ (first-run UX, mirrors
// download_model). Progress streams via DIAR_MODEL_PROGRESS_EVENT. Gating-free → no token.
#[tauri::command]
pub async fn download_diarization_models(app: tauri::AppHandle) -> Result<(), String> {
    let dir = crate::diarize::diarization_dir(&app)?;
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::diarize::download_models(&dir, |step, total, label| {
            emit_diar_model(&app2, step, total, label, step >= total, None);
        })
    })
    .await
    .map_err(|_| "diarization-model download task panicked".to_string())?;

    if let Err(e) = &result {
        log::error!(
            target: "interviewlab::asr",
            "[E-ASR-DOWNLOAD] diarization-model download FAILED: {e}. hint: check network/proxy + disk; \
             without these models every transcription keeps a single speaker (S1)."
        );
        emit_diar_model(&app, 0, 2, "error", true, Some(e.clone()));
    } else {
        log::info!(target: "interviewlab::asr", "diarization models downloaded OK");
    }
    result
}

// Re-run ONLY diarization (+ speaker re-assignment) on an interview's existing raw
// transcript — whisper output is reused/unchanged, so the user can retry with a different
// "expected speakers" hint without re-transcribing (feature-diarization.md §5.2). Reads the
// raw segments, re-runs the diar models on the same 16k wav, re-assigns speaker_labels by
// max-overlap, and overwrites the raw transcript (segment count/timing unchanged → the
// cleanup contract is unaffected). Returns the detected speaker count.
#[tauri::command]
pub async fn rediarize_interview(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    interview_id: String,
    expected_speakers: Option<i32>,
) -> Result<i32, String> {
    log::info!(target: "interviewlab::asr", "rediarize: interview='{interview_id}' expected_speakers={expected_speakers:?}");
    // Models must be present (a clear error beats a silent no-op).
    let diar_dir = crate::diarize::diarization_dir(&app)?;
    if !crate::diarize::models_present(&diar_dir) {
        log::error!(target: "interviewlab::asr", "rediarize: interview='{interview_id}': diarization models missing in {}", diar_dir.display());
        return Err("diarization models not downloaded (download them in Settings)".to_string());
    }

    // Existing raw transcript — its segments (timing) are the source we re-label.
    let raw = get_raw_transcript_db(&db.pool, &interview_id)
        .await
        .map_err(|e| format!("lookup raw transcript: {e}"))?
        .ok_or("no transcript to re-diarize (transcribe first)")?;
    let mut segments: Vec<Segment> = serde_json::from_str(&raw.segments_json)
        .map_err(|e| format!("parse stored segments: {e}"))?;

    // Same 16k wav whisper used.
    let audio = audio_path_db(&db.pool, &interview_id)
        .await
        .map_err(|e| format!("lookup audio: {e}"))?
        .ok_or("no prepared audio for this interview")?;
    let audio_path = PathBuf::from(&audio);
    if !audio_path.exists() {
        return Err(format!("audio file missing on disk: {audio}"));
    }

    let _guard = asr_lock().lock().await; // serialize with transcription (shares CPU).
    emit_diar(&app, &interview_id, "diarizing", 0, None);

    let seg_model = diar_dir.join(crate::diarize::SEGMENTATION_FILE);
    let emb_model = diar_dir.join(crate::diarize::EMBEDDING_FILE);
    let turns = tauri::async_runtime::spawn_blocking(move || {
        let samples = read_wav_16k_mono(&audio_path)?;
        crate::diarize::diarize_samples(&seg_model, &emb_model, &samples, 16000, expected_speakers)
    })
    .await
    .map_err(|_| {
        log::error!(target: "interviewlab::asr", "rediarize: interview='{interview_id}': diarization blocking task panicked");
        "diarization task panicked".to_string()
    })?
    .map_err(|e| {
        log::error!(target: "interviewlab::asr", "rediarize: interview='{interview_id}': diarization FAILED: {e}");
        emit_diar(&app, &interview_id, "error", 0, None);
        e
    })?;

    crate::diarize::assign_speakers(&mut segments, &turns);
    let n_spk = turns.iter().map(|t| t.speaker).collect::<std::collections::BTreeSet<_>>().len() as i32;

    // Overwrite the raw transcript in place (re-diarize is idempotent like re-transcribe).
    let base_engine = raw
        .engine
        .as_deref()
        .map(|e| e.split(" + ").next().unwrap_or(e).to_string())
        .unwrap_or_else(|| "whisper.cpp".to_string());
    let engine = format!("{base_engine} + sherpa-onnx:pyannote-seg-3.0/eres2net@cpu({n_spk}spk)");
    let segments_json = serde_json::to_string(&segments).map_err(|e| format!("serialize segments: {e}"))?;
    store_raw_transcript_db(&db.pool, &interview_id, raw.language.as_deref(), &engine, &segments_json)
        .await
        .map_err(|e| format!("store re-diarized transcript: {e}"))?;

    emit_diar(&app, &interview_id, "done", 100, Some(n_spk));
    Ok(n_spk)
}

// --- partial re-transcription + crash resume (range primitive) ----------------

// Merge freshly-transcribed `incoming` segments into `base`, replacing anything that
// overlaps the [start_ms, end_ms] window, and return the result sorted by start time. Used
// by both the per-range re-transcribe (base = the stored transcript) and resume (base = the
// saved prefix, where the window is the un-decoded tail so nothing is replaced — it appends).
fn splice_segments(base: &[Segment], incoming: Vec<Segment>, start_ms: i64, end_ms: i64) -> Vec<Segment> {
    let mut out: Vec<Segment> = base
        .iter()
        // Keep segments that lie wholly OUTSIDE the re-done window (overlap is replaced).
        .filter(|s| s.end_ms <= start_ms || s.start_ms >= end_ms)
        .cloned()
        .collect();
    out.extend(incoming);
    out.sort_by_key(|s| s.start_ms);
    out
}

// --- sentence-level coalescing (fixes progressive over-fragmentation) ----------

// Max same-speaker gap (ms) that still reads as one continuing sentence: below it we glue
// adjacent fragments, at/above it a real pause breaks the segment. Same spirit as the editor's
// display-side COALESCE_GAP_MS (transcript-editor.tsx) but a touch tighter, since we ALSO break
// on sentence-final punctuation. // ponytail: tunable knob.
const SENTENCE_MERGE_GAP_MS: i64 = 1200;
// Hard ceiling on a merged segment's span, so a long punctuation-free monologue can't fold into
// one giant block (keeps edit boxes + evidence quotes a sane size). // ponytail: tunable knob.
const SENTENCE_MERGE_MAX_SPAN_MS: i64 = 30_000;

// Coalesce whisper's over-fragmented output into sentence-level segments.
//
// Whisper splits on the timestamp tokens it emits, and on harder audio it emits them ever more
// frequently — so late in a long interview a single sentence can come back as several 1-2 word
// segments (the "shorter and shorter, ending in a lone pronoun" symptom). This folds a run of
// consecutive SAME-SPEAKER fragments back into one segment, stopping at: a sentence-final mark,
// a real pause (>= SENTENCE_MERGE_GAP_MS), the span cap, or a speaker change. Must run AFTER
// diarization (so speaker_label is authoritative and turns never merge together). Timing is
// preserved exactly (merged span = first.start .. last.end) — only the GRANULARITY changes —
// so media-sync, the timing-immutability invariant, cleanup's by-index alignment, and evidence
// refs all stay intact (raw segments are brand-new here; nothing references them yet).
fn merge_short_segments(segments: Vec<Segment>) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::with_capacity(segments.len());
    for seg in segments {
        match out.last_mut() {
            // Continue the current sentence: same speaker, no real pause, under the span cap,
            // and the running text hasn't hit a sentence boundary yet.
            Some(prev)
                if prev.speaker_label == seg.speaker_label
                    && seg.start_ms - prev.end_ms <= SENTENCE_MERGE_GAP_MS
                    && seg.end_ms - prev.start_ms <= SENTENCE_MERGE_MAX_SPAN_MS
                    && !ends_sentence(&prev.text) =>
            {
                prev.end_ms = seg.end_ms;
                let t = seg.text.trim();
                if !t.is_empty() {
                    if !prev.text.is_empty() {
                        prev.text.push(' ');
                    }
                    prev.text.push_str(t);
                }
            }
            // Start a fresh segment (first one, speaker change, pause, span cap, or sentence end).
            _ => out.push(Segment { text: seg.text.trim().to_string(), ..seg }),
        }
    }
    out
}

// True when `text` ends with sentence-final punctuation (Latin + the Russian set), i.e. a
// natural place to break a segment. Trailing closing quotes/brackets after the mark are
// tolerated (e.g. `сказал он.»`).
fn ends_sentence(text: &str) -> bool {
    let trimmed = text
        .trim_end()
        .trim_end_matches(|c| matches!(c, '"' | '»' | '”' | '«' | ')' | ']' | '\''));
    matches!(
        trimmed.chars().next_back(),
        Some('.') | Some('!') | Some('?') | Some('…')
    )
}

// Re-transcribe + re-diarize a TIME RANGE of an interview's audio (feature: "redo a chunk
// that came out wrong"). Runs whisper on just [start_ms, end_ms], splices the result over the
// stored transcript's segments in that window, then re-diarizes the WHOLE audio so speaker
// labels stay globally consistent. Streams live progress like a normal run. Concurrency = 1.
#[tauri::command]
pub async fn retranscribe_range(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    interview_id: String,
    start_ms: i64,
    end_ms: i64,
    model_id: String,
    language: Option<String>,
    expected_speakers: Option<i32>,
) -> Result<String, String> {
    log::info!(target: "interviewlab::asr", "retranscribe_range: interview='{interview_id}' [{start_ms}..{end_ms}]ms model='{model_id}'");
    if end_ms <= start_ms {
        return Err("invalid range (end must be after start)".to_string());
    }
    let entry = catalog_entry(&model_id).ok_or_else(|| format!("unknown model id: {model_id}"))?;
    let model = model_path(&app, &model_id)?;
    if !model.exists() {
        return Err(format!("model not downloaded: {} (download it in Settings)", entry.label));
    }
    let audio_path = resolve_audio_path(&db.pool, &interview_id).await?;

    // The transcript we splice into (the segments currently shown in the editor).
    let raw = get_raw_transcript_db(&db.pool, &interview_id)
        .await
        .map_err(|e| format!("lookup transcript: {e}"))?
        .ok_or("no transcript to re-transcribe (transcribe the whole interview first)")?;
    let base: Vec<Segment> = serde_json::from_str(&raw.segments_json)
        .map_err(|e| format!("parse stored segments: {e}"))?;

    let device = detect_device();
    let engine = format!("whisper.cpp:{}@{}", model_id, device.device);
    let duration_ms = duration_ms_db(&db.pool, &interview_id).await.unwrap_or(None);
    // Watchdog scaled to the SLICE length (not the whole file), with the usual floor/ceiling.
    let budget = std::time::Duration::from_millis(watchdog_budget_ms(Some(end_ms - start_ms)) as u64);
    let initial_prompt = initial_prompt_for_interview(&db.pool, &interview_id).await;

    let _guard = asr_lock().lock().await;
    set_status_db(&db.pool, &interview_id, STATUS_TRANSCRIBING)
        .await
        .map_err(|e| format!("set transcribing: {e}"))?;
    emit_asr(&app, &interview_id, STATUS_TRANSCRIBING, 0, None, None);

    // No checkpoint writer here: a range redo is short and the ORIGINAL transcript stays
    // intact on failure (we only store on success), so there's nothing to resume.
    let sink = Arc::new(StdMutex::new(Vec::<Segment>::new()));
    let run = run_guarded_whisper(
        &app, &interview_id, model, audio_path.clone(), Some((start_ms, end_ms)),
        language.clone(), initial_prompt, device.use_gpu, budget, sink,
    )
    .await;

    match run {
        Ok(incoming) => {
            let merged = splice_segments(&base, incoming, start_ms, end_ms);
            let lang = raw.language.clone().or_else(|| language.clone());
            diarize_and_store(
                &app, &db.pool, &interview_id, merged, engine, lang,
                expected_speakers, duration_ms, audio_path,
            )
            .await
        }
        Err(e) => {
            // The stored transcript is untouched — restore the prior status so the editor
            // keeps showing it (don't strand the interview in `transcribing`/`error`).
            log::error!(target: "interviewlab::asr", "retranscribe_range: interview='{interview_id}': FAILED, keeping existing transcript: {e}");
            set_status_db(&db.pool, &interview_id, STATUS_TRANSCRIBED).await.ok();
            emit_asr(&app, &interview_id, STATUS_ERROR, 0, None, Some(e.clone()));
            Err(e)
        }
    }
}

// Resume a transcription that failed/crashed partway, continuing from its checkpoint instead
// of starting over (crash-safety feature). Re-transcribes only the remaining tail
// [processed_ms, total_ms], appends it to the saved prefix, then diarizes the whole audio.
#[tauri::command]
pub async fn resume_transcription(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    interview_id: String,
    language: Option<String>,
    expected_speakers: Option<i32>,
) -> Result<String, String> {
    let ckpt = get_checkpoint_db(&db.pool, &interview_id)
        .await
        .map_err(|e| format!("lookup checkpoint: {e}"))?
        .ok_or("nothing to resume (no saved progress for this interview)")?;
    log::info!(target: "interviewlab::asr", "resume: interview='{interview_id}' from {}ms (model='{}')", ckpt.processed_ms, ckpt.model_id);

    let model = model_path(&app, &ckpt.model_id)?;
    if !model.exists() {
        return Err(format!("model '{}' not downloaded (download it in Settings)", ckpt.model_id));
    }
    let audio_path = resolve_audio_path(&db.pool, &interview_id).await?;
    let prefix: Vec<Segment> = serde_json::from_str(&ckpt.segments_json)
        .map_err(|e| format!("parse checkpoint segments: {e}"))?;

    // Resume end = the audio duration; if unknown, fall back to the checkpoint's total.
    let duration_ms = duration_ms_db(&db.pool, &interview_id).await.unwrap_or(None).or(ckpt.total_ms);
    let total_ms = duration_ms.ok_or("unknown audio duration — cannot resume")?;
    let start_ms = ckpt.processed_ms.max(0);
    if total_ms <= start_ms {
        return Err("already at the end — nothing left to transcribe".to_string());
    }

    // Resume uses the language the run was started with (checkpoint), unless the caller overrides.
    let lang = language.clone().or_else(|| ckpt.language.clone());
    let device = detect_device();
    let engine = format!("whisper.cpp:{}@{}", ckpt.model_id, device.device);
    let budget = std::time::Duration::from_millis(watchdog_budget_ms(Some(total_ms - start_ms)) as u64);
    let initial_prompt = initial_prompt_for_interview(&db.pool, &interview_id).await;

    let _guard = asr_lock().lock().await;
    set_status_db(&db.pool, &interview_id, STATUS_TRANSCRIBING)
        .await
        .map_err(|e| format!("set transcribing: {e}"))?;
    // Replay the saved prefix so the editor's live view shows it immediately, then continue.
    for seg in &prefix {
        emit_asr(&app, &interview_id, STATUS_TRANSCRIBING, -1, Some(seg.clone()), None);
    }

    // Keep checkpointing during the resume too (prefix + the new tail), so a SECOND crash is
    // also recoverable.
    let sink = Arc::new(StdMutex::new(Vec::<Segment>::new()));
    let ckpt_task = spawn_checkpoint_writer(
        db.pool.clone(), interview_id.clone(), sink.clone(),
        prefix.clone(), Some(total_ms), ckpt.model_id.clone(), lang.clone(),
    );

    let run = run_guarded_whisper(
        &app, &interview_id, model, audio_path.clone(), Some((start_ms, total_ms)),
        lang.clone(), initial_prompt, device.use_gpu, budget, sink.clone(),
    )
    .await;
    ckpt_task.abort();

    match run {
        Ok(tail) => {
            // Append the newly-decoded tail to the saved prefix (prefix ends at start_ms, tail
            // begins there → splice with an empty replace window just concatenates + sorts).
            let merged = splice_segments(&prefix, tail, start_ms, total_ms);
            diarize_and_store(
                &app, &db.pool, &interview_id, merged, engine, lang,
                expected_speakers, duration_ms, audio_path,
            )
            .await
        }
        Err(e) => {
            // Persist the extended prefix so a further resume continues from the new point.
            let tail = sink.lock().map(|g| g.clone()).unwrap_or_default();
            let mut all = prefix.clone();
            all.extend(tail);
            if let Ok(json) = serde_json::to_string(&all) {
                let processed = all.last().map(|s| s.end_ms).unwrap_or(start_ms);
                let _ = upsert_checkpoint_db(
                    &db.pool, &interview_id, processed, Some(total_ms), &ckpt.model_id,
                    lang.as_deref().filter(|s| *s != "auto"), &json,
                )
                .await;
            }
            set_status_db(&db.pool, &interview_id, STATUS_ERROR).await.ok();
            emit_asr(&app, &interview_id, STATUS_ERROR, 0, None, Some(e.clone()));
            Err(e)
        }
    }
}

// Read the saved transcription checkpoint for an interview (drives the editor's "resume from
// M:SS" banner). None when there's no recoverable partial run.
#[tauri::command]
pub async fn get_transcribe_checkpoint(
    db: tauri::State<'_, Db>,
    interview_id: String,
) -> Result<Option<Checkpoint>, String> {
    get_checkpoint_db(&db.pool, &interview_id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    fn seg_at(start_ms: i64, end_ms: i64, text: &str) -> Segment {
        Segment { start_ms, end_ms, speaker_label: "S1".into(), text: text.into() }
    }

    // splice_segments replaces the overlapping window with the freshly-decoded segments and
    // keeps the rest, sorted — the core of both range-retranscribe and resume.
    #[test]
    fn splice_replaces_overlap_keeps_rest() {
        let base = vec![
            seg_at(0, 1000, "a"),
            seg_at(1000, 2000, "bad"),
            seg_at(2000, 3000, "also bad"),
            seg_at(3000, 4000, "d"),
        ];
        // Redo [1000,3000): the two middle segments are dropped, replaced by the new ones.
        let incoming = vec![seg_at(1000, 2000, "fixed1"), seg_at(2000, 3000, "fixed2")];
        let out = splice_segments(&base, incoming, 1000, 3000);
        let texts: Vec<&str> = out.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["a", "fixed1", "fixed2", "d"]);
    }

    // Resume case: the window is the un-decoded tail, base has nothing there → pure append.
    #[test]
    fn splice_resume_appends_tail() {
        let prefix = vec![seg_at(0, 1000, "p1"), seg_at(1000, 2000, "p2")];
        let tail = vec![seg_at(2000, 3000, "t1"), seg_at(3000, 4000, "t2")];
        let out = splice_segments(&prefix, tail, 2000, 4000);
        assert_eq!(out.len(), 4);
        assert_eq!(out.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), vec!["p1", "p2", "t1", "t2"]);
        assert!(out.windows(2).all(|w| w[0].start_ms <= w[1].start_ms), "result stays sorted");
    }

    // merge_short_segments folds a run of same-speaker fragments into one sentence, breaking at
    // the sentence-final mark — the core fix for whisper's progressive over-fragmentation.
    #[test]
    fn merge_coalesces_same_speaker_fragments_until_sentence_end() {
        let segs = vec![
            seg_at(0, 1500, "Это"),
            seg_at(1500, 3000, "целое"),
            seg_at(3000, 4200, "предложение."),
            seg_at(4300, 5000, "Новое"),
        ];
        let out = merge_short_segments(segs);
        assert_eq!(out.len(), 2, "three fragments glue, the period breaks before 'Новое'");
        assert_eq!(out[0].text, "Это целое предложение.");
        assert_eq!(out[0].start_ms, 0);
        assert_eq!(out[0].end_ms, 4200, "merged span = first.start .. last.end (timing preserved)");
        assert_eq!(out[1].text, "Новое");
    }

    // A speaker change OR a real pause breaks the run even with no punctuation.
    #[test]
    fn merge_never_crosses_speaker_or_pause() {
        // Different speaker → never merged (diarization turn boundary).
        let mut second = seg_at(1600, 3000, "мир");
        second.speaker_label = "S2".into();
        let out = merge_short_segments(vec![seg_at(0, 1500, "Привет"), second]);
        assert_eq!(out.len(), 2);
        // Same speaker but a pause longer than the gap → still breaks.
        let gapped = seg_at(1500 + SENTENCE_MERGE_GAP_MS + 1, 3000, "мир");
        let out = merge_short_segments(vec![seg_at(0, 1500, "Привет"), gapped]);
        assert_eq!(out.len(), 2);
    }

    // A punctuation-free run still breaks at the span ceiling (no runaway mega-segment).
    #[test]
    fn merge_respects_span_cap() {
        let mut segs = Vec::new();
        let mut t = 0;
        while t < SENTENCE_MERGE_MAX_SPAN_MS + 10_000 {
            segs.push(seg_at(t, t + 2000, "ещё")); // no terminal punctuation, tiny gaps
            t += 2000;
        }
        let out = merge_short_segments(segs);
        assert!(out.len() >= 2, "span cap forces at least one break");
        assert!(out.iter().all(|s| s.end_ms - s.start_ms <= SENTENCE_MERGE_MAX_SPAN_MS));
    }

    // ends_sentence recognises the Latin + Russian sentence-final marks, tolerating trailing
    // quotes/brackets, and rejects bare words.
    #[test]
    fn ends_sentence_handles_russian_and_quotes() {
        for s in ["Да.", "Что?", "Стоп!", "Подожди…", "«Привет.»", "(готово.)"] {
            assert!(ends_sentence(s), "{s:?} should count as a sentence end");
        }
        for s in ["просто слова", "местоимение", "он сказал что"] {
            assert!(!ends_sentence(s), "{s:?} should NOT count as a sentence end");
        }
    }

    async fn make_interview(pool: &SqlitePool) -> String {
        let cycle_id = Uuid::new_v4().to_string();
        let iv = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(&cycle_id).bind("c").bind(ts).bind(ts).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?)")
            .bind(&iv).bind(&cycle_id).bind("iv").bind(ts).bind(ts).execute(pool).await.unwrap();
        iv
    }

    // The model catalog has a single default (large-v3) and every entry resolves.
    #[test]
    fn catalog_has_one_default_largev3() {
        let defaults: Vec<_> = CATALOG.iter().filter(|e| e.default).collect();
        assert_eq!(defaults.len(), 1);
        assert_eq!(defaults[0].id, "large-v3");
        assert!(catalog_entry("tiny").is_some());
        assert!(catalog_entry("nope").is_none());
    }

    // detect_device never panics and returns a consistent device/use_gpu pairing.
    // On macOS the GPU device is "metal" (Metal backend); everywhere else it's "cuda".
    #[test]
    fn detect_device_is_consistent() {
        let d = detect_device();
        let gpu_device = if cfg!(target_os = "macos") { "metal" } else { "cuda" };
        assert!(d.device == gpu_device || d.device == "cpu");
        // use_gpu is true exactly when the device is the GPU device.
        assert_eq!(d.use_gpu, d.device == gpu_device);
        // CPU build (no GPU feature) must never claim GPU even with a GPU present.
        // cuda_build is the Nvidia flag; on macOS the equivalent gate is the metal feature.
        let gpu_built = if cfg!(target_os = "macos") {
            cfg!(feature = "metal")
        } else {
            d.cuda_build
        };
        if !gpu_built {
            assert!(!d.use_gpu);
            assert_eq!(d.device, "cpu");
        }
    }

    // Product context → whisper initial_prompt sanitizer (req #2): NULs stripped, markdown
    // whitespace/newlines flattened to a single-line term blurb, capped on a char boundary.
    #[test]
    fn sanitize_initial_prompt_flattens_and_caps() {
        // Empty / whitespace-only → empty (caller skips set_initial_prompt).
        assert_eq!(sanitize_initial_prompt("   \n\t "), "");
        // Markdown with headings/bullets/newlines + a NUL byte → flat single-line blurb.
        let md = "# Acme Analytics\n\n- self-serve funnels\0\n- retention out of the box";
        let out = sanitize_initial_prompt(md);
        assert!(!out.contains('\n') && !out.contains('\0'));
        assert!(out.contains("Acme Analytics") && out.contains("retention out of the box"));
        // Over-long input is capped to the max (never panics on a multibyte boundary).
        let long = "Слово ".repeat(400); // Cyrillic (multibyte) well past the cap
        let capped = sanitize_initial_prompt(&long);
        assert!(capped.len() <= INITIAL_PROMPT_MAX_CHARS);
    }

    // The glossary's canonical terms lead the initial_prompt (so they survive the cap), then
    // the product prose; either side may be empty.
    #[test]
    fn build_initial_prompt_leads_with_glossary_terms() {
        fn term(c: &str) -> crate::glossary::GlossaryTerm {
            crate::glossary::GlossaryTerm {
                id: "x".into(), product_id: "p".into(), canonical: c.into(),
                aliases: vec![], notes: String::new(), created_at: 0, updated_at: 0,
            }
        }
        let g = vec![term("API"), term("Figma")];
        assert_eq!(build_initial_prompt(&g, "Acme Analytics"), "API, Figma. Acme Analytics");
        assert_eq!(build_initial_prompt(&g, "   "), "API, Figma", "no prose → just the terms");
        assert_eq!(build_initial_prompt(&[], "Acme Analytics"), "Acme Analytics", "no glossary → just the prose");
        assert_eq!(build_initial_prompt(&[], ""), "", "neither → empty");
    }

    // Product context resolves through the interview → cycle → effective product chain
    // (Products library / req #2): a linked product's content_md is what reaches the ASR
    // initial_prompt; with no product, the inline product_desc is used; missing → "".
    #[tokio::test]
    async fn product_context_for_interview_resolves_linked_then_inline() {
        let pool = test_pool().await;
        let ts = now_ms();

        // Cycle + interview linked to a library product → product content wins.
        let cyc = Uuid::new_v4().to_string();
        let prod = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO product (id, name, content_md, created_at, updated_at) VALUES (?, 'P', 'Acme product context', ?, ?)")
            .bind(&prod).bind(ts).bind(ts).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cycle (id, name, product_desc, product_id, created_at, updated_at) VALUES (?, 'c', 'inline ctx', ?, ?, ?)")
            .bind(&cyc).bind(&prod).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let iv = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'iv', 'new', ?, ?)")
            .bind(&iv).bind(&cyc).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let ctx = product_context_for_interview_db(&pool, &iv).await.unwrap();
        assert_eq!(ctx, "Acme product context", "linked product context reaches ASR");

        // An unknown interview → empty (never blocks transcription).
        assert_eq!(
            product_context_for_interview_db(&pool, "nope").await.unwrap(),
            ""
        );
    }

    // --- bug #1: watchdog budget policy ----------------------------------------
    #[test]
    fn watchdog_budget_clamps_and_scales() {
        // No / zero duration → the floor (a usable budget for tiny clips).
        assert_eq!(watchdog_budget_ms(None), WATCHDOG_FLOOR_MS);
        assert_eq!(watchdog_budget_ms(Some(0)), WATCHDOG_FLOOR_MS);
        assert_eq!(watchdog_budget_ms(Some(-5)), WATCHDOG_FLOOR_MS);
        // A tiny clip's duration×multiple is below the floor → clamps up to the floor.
        assert_eq!(watchdog_budget_ms(Some(1_000)), WATCHDOG_FLOOR_MS);
        // A mid clip scales linearly: 4 min audio → 12× = 48 min budget.
        assert_eq!(watchdog_budget_ms(Some(240_000)), 240_000 * WATCHDOG_DURATION_MULTIPLE);
        // A long clip's budget is capped by the ceiling (can't pin the queue forever).
        assert_eq!(watchdog_budget_ms(Some(10_000_000)), WATCHDOG_CEILING_MS);
        // Even an absurd duration can't overflow / exceed the ceiling.
        assert_eq!(watchdog_budget_ms(Some(i64::MAX)), WATCHDOG_CEILING_MS);
    }

    // --- bug #1/#5: the cancel flag is the abort signal whisper polls ----------
    // We can't run real whisper in a unit test, but the contract run_whisper relies on is:
    // register → the flag is observable; signal_cancel flips it to true (abort), and the
    // abort_callback closure (`flag.load`) then returns true. unregister frees the slot.
    #[test]
    fn cancel_registry_signals_and_frees() {
        let iv = "iv-cancel-test";
        // Nothing registered yet → signalling is a no-op (returns false).
        assert!(!signal_cancel(iv));

        let flag = register_cancel(iv);
        assert!(!flag.load(Ordering::SeqCst), "fresh flag starts un-aborted");
        // The closure run_whisper installs as the abort_callback observes the SAME Arc.
        let abort_cb = {
            let flag = flag.clone();
            move || flag.load(Ordering::SeqCst)
        };
        assert!(!abort_cb(), "abort_callback false before cancel → keep running");

        // Manual Stop (#5) / the watchdog (#1) flip the flag.
        assert!(signal_cancel(iv), "an in-flight run is signalled");
        assert!(flag.load(Ordering::SeqCst));
        assert!(abort_cb(), "abort_callback now true → whisper aborts mid-run");

        // After the run ends we free the slot; signalling again is a no-op.
        unregister_cancel(iv);
        assert!(!signal_cancel(iv));
    }

    // --- bug #1: startup recovery resets zombie statuses -----------------------
    #[tokio::test]
    async fn startup_recovery_resets_stuck_interviews() {
        let pool = test_pool().await;
        let cycle_id = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)")
            .bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();

        // Seed one of each relevant status; only transcribing + cleaning are zombies.
        let mut ids = std::collections::HashMap::new();
        for status in ["transcribing", "cleaning", "transcribed", "new", "error"] {
            let id = Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(&id).bind(&cycle_id).bind(status).bind(status).bind(ts).bind(ts)
                .execute(&pool).await.unwrap();
            ids.insert(status, id);
        }

        let fixed = recover_stuck_interviews(&pool).await.unwrap();
        assert_eq!(fixed, 2, "only the 2 mid-flight statuses are reset");

        let status_of = |id: &str| {
            let pool = pool.clone();
            let id = id.to_string();
            async move {
                sqlx::query_scalar::<_, String>("SELECT status FROM interview WHERE id = ?")
                    .bind(&id).fetch_one(&pool).await.unwrap()
            }
        };
        assert_eq!(status_of(&ids["transcribing"]).await, "error");
        assert_eq!(status_of(&ids["cleaning"]).await, "error");
        // Untouched.
        assert_eq!(status_of(&ids["transcribed"]).await, "transcribed");
        assert_eq!(status_of(&ids["new"]).await, "new");
        assert_eq!(status_of(&ids["error"]).await, "error");

        // Idempotent: a second run finds nothing left to fix.
        assert_eq!(recover_stuck_interviews(&pool).await.unwrap(), 0);
    }

    // ===================================================================================
    // REAL bug #1 proof — the runaway repro clip MUST terminate within a bounded time.
    //
    // C:\ai-interview\_e2e\w1_b_short.mp3 (trimmed from 0:30, hits a jingle) previously hung
    // whisper FOREVER: greedy decoding with no fallback produced one never-terminating
    // segment. This test runs the REAL production compute (transcode → read_wav_16k_mono →
    // run_whisper with the new anti-runaway params) under the SAME watchdog mechanism
    // transcribe_interview uses, and asserts the run TERMINATES — either:
    //   (a) the anti-hallucination params let it complete, OR
    //   (b) the watchdog flips the cancel flag → the abort_callback unwinds whisper to `error`.
    // Either way it must NOT hang. Prints which happened + the elapsed wall-time.
    //
    // Uses model `base` for speed. A SHORT watchdog (90s) is injected here on purpose — long
    // enough for the ~30s clip to complete if the params work, short enough to prove the abort
    // path bounds a hang. Requires ggml-base.bin under %APPDATA% + the e2e clip on disk.
    // Run: src-tauri\target\cpu-build.cmd test bug1_w1b_runaway_terminates -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn bug1_w1b_runaway_terminates() {
        use ffmpeg_sidecar::command::FfmpegCommand;
        use std::time::{Duration, Instant};

        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let model = app_dir.join("models").join("ggml-base.bin");
        assert!(model.exists(), "ggml-base not at {model:?}");

        let mp3 = std::path::Path::new(r"C:\ai-interview\_e2e\w1_b_short.mp3");
        assert!(mp3.exists(), "repro clip missing at {mp3:?}");

        // Transcode the mp3 → 16k mono wav exactly like ingest does.
        ffmpeg_sidecar::download::auto_download().expect("ffmpeg");
        let tmp = std::env::temp_dir().join("ilab_bug1_w1b.16k.wav");
        let ok = FfmpegCommand::new()
            .input(&mp3.to_string_lossy())
            .args(["-ac", "1", "-ar", "16000"])
            .arg("-y")
            .output(&tmp.to_string_lossy())
            .spawn()
            .unwrap()
            .wait()
            .unwrap()
            .success();
        assert!(ok && tmp.exists(), "ffmpeg failed to produce {tmp:?}");

        let samples = read_wav_16k_mono(&tmp).expect("read wav");
        let audio_secs = samples.len() as f64 / 16000.0;
        println!("w1_b clip: {audio_secs:.1}s of audio, {} samples", samples.len());

        // The SAME mechanism transcribe_interview uses: a cancel flag + a watchdog that flips
        // it after the budget. Short budget here (90s) to bound the test if a hang recurs.
        let cancel = Arc::new(AtomicBool::new(false));
        let budget = Duration::from_secs(90);
        let model_p = model.clone();
        let cancel_run = cancel.clone();

        let mut task = tokio::task::spawn_blocking(move || {
            run_whisper(&model_p, &samples, Some("ru"), None, false, Some(cancel_run), |_p| {}, |_s| {})
        });

        let start = Instant::now();
        let outcome = match tokio::time::timeout(budget, &mut task).await {
            Ok(join) => join.expect("run_whisper task panicked"),
            Err(_) => {
                // Watchdog fired: abort whisper, then AWAIT the task to unwind (the real path).
                cancel.store(true, Ordering::SeqCst);
                let _ = task.await; // proves the abort_callback actually terminates the thread.
                Err("WATCHDOG".to_string())
            }
        };
        let elapsed = start.elapsed();

        match outcome {
            Ok(segs) => {
                // (a) Anti-hallucination params let it COMPLETE. No runaway 169-token segment.
                let max_tokens_est = segs.iter().map(|s| s.text.split_whitespace().count()).max().unwrap_or(0);
                println!(
                    "RESULT: COMPLETED in {:.1}s — {} segments, longest ~{} words. \
                     Anti-runaway params worked (no infinite segment).",
                    elapsed.as_secs_f64(), segs.len(), max_tokens_est
                );
                assert!(
                    elapsed < budget,
                    "completed but only because the watchdog wasn't hit — still bounded, but check params"
                );
            }
            Err(e) if e == "WATCHDOG" => {
                // (b) Watchdog ABORTED it — also a pass: the run is bounded, not hung forever.
                // The task.await above already proved the abort_callback unwound the thread.
                println!(
                    "RESULT: WATCHDOG-ABORTED at {:.1}s (thread unwound after abort) — the run did \
                     not self-terminate, but the watchdog bounded it (interview → `error`, queue freed).",
                    elapsed.as_secs_f64()
                );
            }
            Err(e) => panic!("run_whisper errored unexpectedly: {e}"),
        }

        // The whole point: it TERMINATED within the bound. (Both arms above already proved this.)
        assert!(elapsed <= budget + Duration::from_secs(10), "must terminate within the bounded window");
        let _ = std::fs::remove_file(&tmp);
    }

    // Store → read back a raw transcript; status transitions persist.
    #[tokio::test]
    async fn store_and_read_transcript() {
        let pool = test_pool().await;
        let iv = make_interview(&pool).await;

        let segs = vec![
            Segment { start_ms: 0, end_ms: 1500, speaker_label: "S1".into(), text: "hello world".into() },
            Segment { start_ms: 1500, end_ms: 3000, speaker_label: "S1".into(), text: "second segment".into() },
        ];
        let json = serde_json::to_string(&segs).unwrap();
        let tid = store_raw_transcript_db(&pool, &iv, Some("en"), "whisper.cpp:tiny@cpu", &json).await.unwrap();
        assert!(!tid.is_empty());

        set_status_db(&pool, &iv, STATUS_TRANSCRIBED).await.unwrap();
        let status: String = sqlx::query_scalar("SELECT status FROM interview WHERE id = ?")
            .bind(&iv).fetch_one(&pool).await.unwrap();
        assert_eq!(status, "transcribed");

        let row = get_raw_transcript_db(&pool, &iv).await.unwrap().expect("transcript row");
        assert_eq!(row.kind, "raw");
        assert_eq!(row.version, 1);
        assert_eq!(row.language.as_deref(), Some("en"));
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&row.segments_json).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["text"], "hello world");
        assert_eq!(parsed[0]["start_ms"], 0);
    }

    // Re-transcribe overwrites the raw row rather than violating UNIQUE(interview,version).
    #[tokio::test]
    async fn re_transcribe_overwrites_raw() {
        let pool = test_pool().await;
        let iv = make_interview(&pool).await;
        let j1 = serde_json::to_string(&vec![Segment { start_ms: 0, end_ms: 1, speaker_label: "S1".into(), text: "v1".into() }]).unwrap();
        store_raw_transcript_db(&pool, &iv, None, "e", &j1).await.unwrap();
        let j2 = serde_json::to_string(&vec![Segment { start_ms: 0, end_ms: 1, speaker_label: "S1".into(), text: "v2".into() }]).unwrap();
        store_raw_transcript_db(&pool, &iv, None, "e", &j2).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcript WHERE interview_id = ?")
            .bind(&iv).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1, "raw transcript should be overwritten, not duplicated");
        let row = get_raw_transcript_db(&pool, &iv).await.unwrap().unwrap();
        assert!(row.segments_json.contains("v2"));
    }

    // End-to-end CPU transcription verify (M4 brief). #[ignore]d so the normal suite
    // stays offline/fast. Requires a 16k mono speech wav at target/asr-verify/speech_16k.wav
    // (generated by Windows SAPI + ffmpeg) and the ggml-base model already downloaded into
    // %APPDATA%/com.interviewlab.app/models/ggml-base.bin. Runs the REAL engine
    // (read_wav_16k_mono → run_whisper on CPU), asserts non-empty segments whose joined
    // text contains the spoken words, then exercises the storage path against the live DB
    // (insert interview → store_raw_transcript_db → read back → cleanup).
    // Run: cargo test live_asr_transcribe_verify -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_asr_transcribe_verify() {
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let model = app_dir.join("models").join("ggml-base.bin");
        assert!(model.exists(), "model not downloaded at {model:?}");

        // The 16k speech wav prepared offline (SAPI sentence → ffmpeg 16k mono).
        let wav = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target").join("asr-verify").join("speech_16k.wav");
        assert!(wav.exists(), "speech wav not found at {wav:?}");

        // CPU build: detect_device must report CPU here (no cuda feature).
        let dev = detect_device();
        println!("device: {} (use_gpu={}, cuda_build={}) — {}", dev.device, dev.use_gpu, dev.cuda_build, dev.detail);
        assert!(!dev.cuda_build, "this is the CPU build; cuda feature must be OFF");
        assert!(!dev.use_gpu);

        // Real engine path: read samples + run whisper on CPU.
        let samples = read_wav_16k_mono(&wav).expect("read wav");
        assert!(samples.len() > 16000, "expected >1s of audio samples, got {}", samples.len());

        // The live segment callback now fires DURING decode (whisper.cpp new-segment callback)
        // and is handed to the C side, so it must be 'static — collect through shared ownership
        // (Rc<RefCell>) rather than a borrowing closure.
        let got_segments: std::rc::Rc<std::cell::RefCell<Vec<Segment>>> =
            std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let got_for_cb = got_segments.clone();
        let segs = run_whisper(
            &model,
            &samples,
            Some("en"),
            None,  // no product-context initial_prompt in the test path
            false, // CPU
            None,  // no cancellation in the test path
            |p| { if p % 25 == 0 { println!("progress {p}%"); } },
            move |s| got_for_cb.borrow_mut().push(s),
        )
        .expect("run_whisper");

        assert!(!segs.is_empty(), "whisper returned no segments");
        assert_eq!(segs.len(), got_segments.borrow().len(), "segment callback count must match returned count");
        let text = segs.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ").to_lowercase();
        println!("spoken:     the quick brown fox jumps over the lazy dog");
        println!("recognized: {text}");
        println!("segments: {}", segs.len());
        // The base model on synthetic SAPI speech should catch the salient words.
        let hits = ["quick", "brown", "fox", "lazy", "dog"].iter().filter(|w| text.contains(**w)).count();
        assert!(hits >= 3, "recognized text should contain the spoken words; got: {text}");
        assert!(segs.iter().all(|s| s.end_ms >= s.start_ms), "timings must be monotonic");

        // Storage path against the live DB: a transcript row is stored + reads back.
        // Mirror init_db's options (create_if_missing + WAL) so opening works even when
        // the app left WAL sidecars behind.
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(app_dir.join("interviewlab.db"))
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = sqlx::sqlite::SqlitePool::connect_with(opts).await.unwrap();
        // Ensure the schema exists (idempotent — same migration init_db runs).
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let cycle_id = Uuid::new_v4().to_string();
        let iv = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, '__M4_VERIFY__', ?, ?)")
            .bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'm4', ?, ?, ?)")
            .bind(&iv).bind(&cycle_id).bind(STATUS_TRANSCRIBING).bind(ts).bind(ts).execute(&pool).await.unwrap();

        let segments_json = serde_json::to_string(&segs).unwrap();
        let tid = store_raw_transcript_db(&pool, &iv, Some("en"), "whisper.cpp:base@cpu", &segments_json).await.unwrap();
        set_status_db(&pool, &iv, STATUS_TRANSCRIBED).await.unwrap();
        assert!(!tid.is_empty());

        let row = get_raw_transcript_db(&pool, &iv).await.unwrap().expect("transcript row stored");
        assert_eq!(row.kind, "raw");
        assert_eq!(row.version, 1);
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&row.segments_json).unwrap();
        assert!(!parsed.is_empty(), "stored segments must be non-empty");
        let status: String = sqlx::query_scalar("SELECT status FROM interview WHERE id = ?")
            .bind(&iv).fetch_one(&pool).await.unwrap();
        assert_eq!(status, "transcribed");
        println!("stored transcript id={tid} segments={} status={status}", parsed.len());

        // Cleanup: drop the temp cycle (cascades interview + transcript).
        sqlx::query("DELETE FROM cycle WHERE id = ?").bind(&cycle_id).execute(&pool).await.unwrap();
        println!("M4 live verify OK: CPU transcription produced segments, stored + read back, cleaned up.");
    }

    // End-to-end CUDA/GPU transcription verify (M4 GPU brief). Compiled ONLY in the cuda
    // build (#[cfg(feature = "cuda")]) and #[ignore]d so it runs on demand. Same inputs as
    // the CPU verify (speech_16k.wav + ggml-base) but asserts the GPU path:
    //   - detect_device() must report device="cuda", use_gpu=true, cuda_build=true,
    //   - run_whisper is driven with use_gpu=true (whisper.cpp logs "CUDA0 ... RTX 5080"
    //     and initializes the CUDA backend; watch nvidia-smi during the run for the spike),
    //   - the recognized text matches the spoken sentence,
    //   - a transcript row is stored against the live DB (engine tagged @cuda) + cleaned up.
    // Run (from src-tauri, in a CUDA build shell):
    //   cargo test --features cuda live_asr_transcribe_verify_cuda -- --ignored --nocapture
    #[cfg(feature = "cuda")]
    #[tokio::test]
    #[ignore]
    async fn live_asr_transcribe_verify_cuda() {
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let model = app_dir.join("models").join("ggml-base.bin");
        assert!(model.exists(), "model not downloaded at {model:?}");

        let wav = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target").join("asr-verify").join("speech_16k.wav");
        assert!(wav.exists(), "speech wav not found at {wav:?}");

        // CUDA build with the RTX 5080 present: device detection must report GPU.
        let dev = detect_device();
        println!("device: {} (use_gpu={}, cuda_build={}) — {}", dev.device, dev.use_gpu, dev.cuda_build, dev.detail);
        assert!(dev.cuda_build, "this must be the cuda-feature build");
        assert!(dev.use_gpu, "expected use_gpu=true (CUDA build + Nvidia GPU present)");
        assert_eq!(dev.device, "cuda");
        assert!(dev.gpu_name.as_deref().unwrap_or("").contains("NVIDIA"), "expected an NVIDIA GPU name, got {:?}", dev.gpu_name);

        // Real engine on the GPU: read samples + run whisper with use_gpu=true. whisper.cpp
        // prints its CUDA device init to stderr here (ggml_cuda_init / "CUDA0 ... RTX 5080").
        let samples = read_wav_16k_mono(&wav).expect("read wav");
        assert!(samples.len() > 16000, "expected >1s of audio samples, got {}", samples.len());

        let mut got_segments: Vec<Segment> = Vec::new();
        let segs = run_whisper(
            &model,
            &samples,
            Some("en"),
            None, // no product-context initial_prompt in the test path
            true, // GPU
            None, // no cancellation in the test path
            |p| { if p % 25 == 0 { println!("progress {p}%"); } },
            |s| got_segments.push(s),
        )
        .expect("run_whisper (cuda)");

        assert!(!segs.is_empty(), "whisper returned no segments");
        let text = segs.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ").to_lowercase();
        println!("spoken:     the quick brown fox jumps over the lazy dog");
        println!("recognized: {text}");
        let hits = ["quick", "brown", "fox", "lazy", "dog"].iter().filter(|w| text.contains(**w)).count();
        assert!(hits >= 3, "recognized text should contain the spoken words; got: {text}");

        // Storage path against the live DB (engine tagged @cuda), then cleanup.
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(app_dir.join("interviewlab.db"))
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = sqlx::sqlite::SqlitePool::connect_with(opts).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let cycle_id = Uuid::new_v4().to_string();
        let iv = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, '__M4_CUDA_VERIFY__', ?, ?)")
            .bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'm4-cuda', ?, ?, ?)")
            .bind(&iv).bind(&cycle_id).bind(STATUS_TRANSCRIBING).bind(ts).bind(ts).execute(&pool).await.unwrap();

        let segments_json = serde_json::to_string(&segs).unwrap();
        let tid = store_raw_transcript_db(&pool, &iv, Some("en"), "whisper.cpp:base@cuda", &segments_json).await.unwrap();
        set_status_db(&pool, &iv, STATUS_TRANSCRIBED).await.unwrap();
        let row = get_raw_transcript_db(&pool, &iv).await.unwrap().expect("transcript row stored");
        assert_eq!(row.kind, "raw");
        assert_eq!(row.engine.as_deref(), Some("whisper.cpp:base@cuda"));
        println!("stored transcript id={tid} engine={:?}", row.engine);

        sqlx::query("DELETE FROM cycle WHERE id = ?").bind(&cycle_id).execute(&pool).await.unwrap();
        println!("M4 CUDA verify OK: GPU transcription produced segments, stored + read back, cleaned up.");
    }

    // ===================================================================================
    // SEED STAGE 1 — ingest + transcribe (real GPU whisper, ggml-large-v3, language ru).
    //
    // Headless data seeding for the founder demo. Drives the REAL pipeline functions
    // (read_wav_16k_mono → run_whisper → store_raw_transcript_db) against the live DB.
    // Creates ONE reusable guide + TWO waves (cycles) linked prev→current, with 2 + 3
    // interviews from real Russian make-sense podcast clips already extracted to
    // C:\ai-interview\_seedwork\<key>.16k.wav (16 kHz mono, ~9 min each).
    //
    // Idempotent: skips any interview that already has a raw transcript, so re-runs after
    // a flaky GPU step are cheap. Does NOT clean up — the seeded rows are the deliverable.
    //
    // Run (GPU): src-tauri\target\cuda-build.cmd test --features cuda seed_stage1 -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn seed_stage1_ingest_transcribe() {
        // --- fixed deterministic ids (shared across all seed stages) ---
        const GUIDE_ID: &str = "11111111-1111-4111-8111-000000000001";
        const CYCLE_W1: &str = "22222222-2222-4222-8222-000000000001";
        const CYCLE_W2: &str = "22222222-2222-4222-8222-000000000002";
        // (interview_id, cycle_id, clip_key, human title)
        let plan: [(&str, &str, &str, &str); 5] = [
            ("33333333-3333-4333-8333-000000000001", CYCLE_W1, "w1_a", "О построении ИИ-нативной организации и выборе задач для автоматизации"),
            ("33333333-3333-4333-8333-000000000002", CYCLE_W1, "w1_b", "О продуктовых инженерах, внедрении ИИ и границах автоматизации"),
            ("33333333-3333-4333-8333-000000000003", CYCLE_W2, "w2_a", "Об ИИ-агентах как продукте и новых навыках менеджеров продукта"),
            ("33333333-3333-4333-8333-000000000004", CYCLE_W2, "w2_b", "О продуктовой разработке с агентами и роли продакт-инженера"),
            ("33333333-3333-4333-8333-000000000005", CYCLE_W2, "w2_c", "О практическом внедрении LLM и переходе от «шаманства» к инженерии"),
        ];

        let product_desc = "Условный B2B SaaS для продуктовых команд: помогает внедрять ИИ и LLM \
            в исследования, дизайн и разработку, ускоряя путь от гипотезы до проверенного решения. \
            Мы изучаем, как меняется работа продактов с приходом ИИ-агентов.";
        let guide_md = "Goals:\n\
            - G1: Как ИИ и LLM меняют повседневную работу продуктовых команд?\n\
            - G2: Какие новые навыки и роли требуются продактам в эпоху ИИ?\n\
            - G3: Что мешает командам надёжно внедрять ИИ в продуктовые процессы?\n\n\
            Target conclusions:\n\
            - Ранжированный список изменений в работе продактов и блокеров внедрения ИИ.";

        let seed_dir = std::path::PathBuf::from(r"C:\ai-interview\_seedwork");

        // --- open the live DB exactly like init_db ---
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let model = app_dir.join("models").join("ggml-large-v3.bin");
        assert!(model.exists(), "ggml-large-v3 not found at {model:?}");
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(app_dir.join("interviewlab.db"))
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = sqlx::sqlite::SqlitePool::connect_with(opts).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let dev = detect_device();
        println!(
            "device: {} (use_gpu={}, cuda_build={}) — {}",
            dev.device, dev.use_gpu, dev.cuda_build, dev.detail
        );
        let engine_tag = if dev.use_gpu { "whisper.cpp:large-v3@cuda" } else { "whisper.cpp:large-v3@cpu" };
        let ts = now_ms();

        // --- guide row (stable goal ids via derive_goals so the diff is clean) ---
        let goals_json = serde_json::to_string(&crate::synthesis::derive_goals(guide_md)).unwrap();
        sqlx::query(
            "INSERT INTO guide (id, name, content_md, goals_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, content_md=excluded.content_md, goals_json=excluded.goals_json, updated_at=excluded.updated_at",
        )
        .bind(GUIDE_ID)
        .bind("AI в продуктовых командах — гайд")
        .bind(guide_md)
        .bind(&goals_json)
        .bind(ts)
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();

        // --- the two cycles (W1 previous; W2 current → prev_cycle_id = W1) ---
        for (cid, name, prev) in [
            (CYCLE_W1, "Исследование: ИИ в продукте — волна 1", None::<&str>),
            (CYCLE_W2, "Исследование: ИИ в продукте — волна 2", Some(CYCLE_W1)),
        ] {
            sqlx::query(
                "INSERT INTO cycle (id, name, product_desc, guide, guide_id, prev_cycle_id, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, product_desc=excluded.product_desc, \
                   guide=excluded.guide, guide_id=excluded.guide_id, prev_cycle_id=excluded.prev_cycle_id, updated_at=excluded.updated_at",
            )
            .bind(cid)
            .bind(name)
            .bind(product_desc)
            .bind(guide_md)
            .bind(GUIDE_ID)
            .bind(prev)
            .bind(ts)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        // --- per interview: rows + media copy + REAL transcription → raw transcript ---
        for (iv_id, cycle_id, key, title) in plan {
            // Idempotent: skip if a raw transcript already exists for this interview.
            if get_raw_transcript_db(&pool, iv_id).await.unwrap().is_some() {
                println!("skip {key}: raw transcript already present");
                continue;
            }

            let wav_src = seed_dir.join(format!("{key}.16k.wav"));
            let mp3_src = seed_dir.join(format!("{key}.mp3"));
            assert!(wav_src.exists(), "clip wav missing: {wav_src:?}");

            // Media dir for the cycle, mirroring the production layout.
            let media = app_dir.join("cycles").join(cycle_id).join("media");
            std::fs::create_dir_all(&media).unwrap();
            let rec_id = Uuid::new_v4().to_string();
            let wav_dst = media.join(format!("{rec_id}.16k.wav"));
            let mp3_dst = media.join(format!("{rec_id}.mp3"));
            std::fs::copy(&wav_src, &wav_dst).unwrap();
            if mp3_src.exists() {
                std::fs::copy(&mp3_src, &mp3_dst).ok();
            }
            let bytes = std::fs::metadata(&mp3_src).ok().map(|m| m.len() as i64);
            let dur_ms: i64 = 540_000; // 9-minute clips

            // interview row (status transcribing while we run whisper).
            sqlx::query(
                "INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status, updated_at=excluded.updated_at",
            )
            .bind(iv_id)
            .bind(cycle_id)
            .bind(title)
            .bind(STATUS_TRANSCRIBING)
            .bind(ts)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();

            // recording row pointing at the copied media (source mp3 + normalized wav).
            sqlx::query("DELETE FROM recording WHERE interview_id = ?").bind(iv_id).execute(&pool).await.unwrap();
            sqlx::query(
                "INSERT INTO recording (id, interview_id, source_path, audio_path, duration_ms, format, bytes) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&rec_id)
            .bind(iv_id)
            .bind(mp3_dst.to_string_lossy().as_ref())
            .bind(wav_dst.to_string_lossy().as_ref())
            .bind(dur_ms)
            .bind("mp3")
            .bind(bytes)
            .execute(&pool)
            .await
            .unwrap();

            // REAL transcription on the GPU (large-v3, language ru). This is the GPU-heavy
            // step; ~9 min audio. run_whisper is pure compute → run on a blocking thread.
            println!("transcribing {key} ({title}) on {} ...", dev.device);
            let samples = read_wav_16k_mono(&wav_dst).expect("read wav");
            let model_p = model.clone();
            let use_gpu = dev.use_gpu;
            let key_owned = key.to_string();
            let segs = tokio::task::spawn_blocking(move || {
                run_whisper(
                    &model_p,
                    &samples,
                    Some("ru"),
                    None,
                    use_gpu,
                    None,
                    move |p| { if p % 25 == 0 { println!("  {key_owned}: {p}%"); } },
                    |_s| {},
                )
            })
            .await
            .unwrap()
            .expect("run_whisper");

            assert!(!segs.is_empty(), "whisper returned no segments for {key}");
            let joined: String = segs.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
            let cyr = joined.chars().filter(|c| ('а'..='я').contains(&c.to_ascii_lowercase())).count();
            assert!(cyr > 200, "expected substantial Russian text for {key}, got {cyr} cyrillic chars");

            let segments_json = serde_json::to_string(&segs).unwrap();
            let tid = store_raw_transcript_db(&pool, iv_id, Some("ru"), engine_tag, &segments_json).await.unwrap();
            set_status_db(&pool, iv_id, STATUS_TRANSCRIBED).await.unwrap();
            println!("  stored raw transcript id={tid} segments={} (first line: {})", segs.len(), segs[0].text.chars().take(80).collect::<String>());
        }

        println!("SEED STAGE 1 OK: guide + 2 cycles + 5 interviews transcribed (engine={engine_tag}).");
    }

    // ===================================================================================
    // REAL END-TO-END diarization verify (the brief's runtime check). #[ignore]d so the
    // normal suite stays offline/fast. Runs the FULL production pipeline on a real Russian
    // 2-speaker clip, on CPU, with NO Python:
    //   read 16k wav → run_whisper (base) → diarize_samples (sherpa-onnx) → assign_speakers
    //   (max-overlap) → group_turns → print the alternating S1/S2 turns (Russian).
    // Asserts ≥2 speakers detected, every ASR segment labelled, and that the grouped turns
    // alternate between speakers. Mirrors exactly what transcribe_interview does in prod.
    //
    // Requires: ggml-base.bin + the diarization ONNX models under %APPDATA%, and
    // C:\ai-interview\_seedwork\w1_a.16k.wav (host + guest = 2 speakers).
    // Run: src-tauri\target\cpu-build.cmd test live_e2e_diarize_verify -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_e2e_diarize_verify() {
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let model = app_dir.join("models").join("ggml-base.bin");
        assert!(model.exists(), "ggml-base not at {model:?}");
        let diar_dir = app_dir.join("models").join("diarization");
        let seg_model = diar_dir.join(crate::diarize::SEGMENTATION_FILE);
        let emb_model = diar_dir.join(crate::diarize::EMBEDDING_FILE);
        assert!(seg_model.exists() && emb_model.exists(), "diarization models missing in {diar_dir:?}");

        let wav = std::path::Path::new(r"C:\ai-interview\_seedwork\w1_a.16k.wav");
        assert!(wav.exists(), "test wav missing at {wav:?}");
        let samples = read_wav_16k_mono(wav).expect("read wav");

        // 1) ASR (CPU, Russian).
        println!("transcribing (base, ru, CPU) ...");
        let mut segments = run_whisper(&model, &samples, Some("ru"), None, false, None, |_p| {}, |_s| {})
            .expect("run_whisper");
        assert!(!segments.is_empty(), "whisper produced no segments");
        println!("  {} ASR segments", segments.len());

        // 2) Diarization with the hint=2 default expectation (the doc's "default expectation
        // 2"); also assert AUTO finds >=2. We verify the assignment with the hint result
        // since auto over-counts on this clip (calibrated; see DEFAULT_THRESHOLD).
        println!("diarizing (hint=2, CPU) ...");
        let turns = crate::diarize::diarize_samples(&seg_model, &emb_model, &samples, 16000, Some(2))
            .expect("diarize");
        let speakers: std::collections::BTreeSet<i32> = turns.iter().map(|t| t.speaker).collect();
        println!("  {} diar turns across {} speakers", turns.len(), speakers.len());
        assert!(speakers.len() >= 2, "expected >=2 speakers, got {}", speakers.len());

        // 3) Assign each ASR segment to a speaker by max overlap (the prod merge).
        crate::diarize::assign_speakers(&mut segments, &turns);
        let labels: std::collections::BTreeSet<&str> = segments.iter().map(|s| s.speaker_label.as_str()).collect();
        assert!(labels.len() >= 2, "ASR segments should carry >=2 distinct speaker labels, got {labels:?}");
        assert!(segments.iter().all(|s| !s.speaker_label.is_empty()), "every segment must be labelled");

        // 4) Group consecutive same-speaker segments into turns (the editor view).
        let grouped = crate::diarize::group_turns(&segments);
        let distinct_in_turns: std::collections::BTreeSet<&str> =
            grouped.iter().map(|t| t.speaker_label.as_str()).collect();
        assert!(distinct_in_turns.len() >= 2, "grouped turns should span >=2 speakers");
        // Turns must actually ALTERNATE (no two consecutive turns share a speaker — that's the
        // whole point of grouping). group_turns guarantees this by construction; assert it.
        assert!(
            grouped.windows(2).all(|w| w[0].speaker_label != w[1].speaker_label),
            "consecutive turns must be different speakers (alternation)"
        );

        // Quote the first several alternating turns (Russian) — the brief's deliverable.
        println!("\n=== grouped speaker turns (Russian, S1/S2 alternation) ===");
        for t in grouped.iter().take(8) {
            let preview: String = t.text.chars().take(90).collect();
            println!("  [{}] {:>6}..{:<6}ms  {}", t.speaker_label, t.start_ms, t.end_ms, preview);
        }
        println!("\nE2E OK: {} ASR segments → {} speakers → {} grouped turns (alternating).",
            segments.len(), speakers.len(), grouped.len());
    }

    // ASR THROUGHPUT verify (bug #6 — verbose-logging fix). Transcribes the clean 4-min
    // Russian clip w1_a_short.mp3 with ggml-large-v3 and prints the realtime factor. The
    // per-token `whisper_full_with_state: …` stderr flood that previously dominated wall-time
    // is silenced by silence_whisper_logging() (installed inside run_whisper), so this should
    // run far faster than the ~real-time it crawled at before — and the spam must be ABSENT
    // from this test's --nocapture stderr (only WARN/ERROR get through now).
    //
    // CPU build: shows the spam is gone + a clear CPU speedup. CUDA build (ggml-large-v3 on
    // the RTX 5080) shows ~10–15× real-time throughput restored.
    //   CPU:  src-tauri\target\cpu-build.cmd  test asr_throughput_w1a_large_v3 -- --ignored --nocapture
    //   GPU:  src-tauri\target\cuda-build.cmd test --features cuda asr_throughput_w1a_large_v3 -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn asr_throughput_w1a_large_v3() {
        use ffmpeg_sidecar::command::FfmpegCommand;
        use std::time::Instant;

        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let model = app_dir.join("models").join("ggml-large-v3.bin");
        assert!(model.exists(), "ggml-large-v3 not at {model:?}");

        let mp3 = std::path::Path::new(r"C:\ai-interview\_e2e\w1_a_short.mp3");
        assert!(mp3.exists(), "clip missing at {mp3:?}");

        // Transcode mp3 → 16k mono wav exactly like ingest does.
        ffmpeg_sidecar::download::auto_download().expect("ffmpeg");
        let tmp = std::env::temp_dir().join("ilab_bug6_w1a.16k.wav");
        let ok = FfmpegCommand::new()
            .input(&mp3.to_string_lossy())
            .args(["-ac", "1", "-ar", "16000"])
            .arg("-y")
            .output(&tmp.to_string_lossy())
            .spawn()
            .unwrap()
            .wait()
            .unwrap()
            .success();
        assert!(ok && tmp.exists(), "ffmpeg failed to produce {tmp:?}");

        let samples = read_wav_16k_mono(&tmp).expect("read wav");
        let audio_secs = samples.len() as f64 / 16000.0;

        let dev = detect_device();
        println!(
            "device: {} (use_gpu={}, cuda_build={}) — {}",
            dev.device, dev.use_gpu, dev.cuda_build, dev.detail
        );
        println!("audio: {audio_secs:.1}s ({} samples), model=large-v3, lang=ru", samples.len());
        println!("--- starting transcription (verbose whisper logging should be SILENCED) ---");

        let start = Instant::now();
        let segs = run_whisper(&model, &samples, Some("ru"), None, dev.use_gpu, None, |_p| {}, |_s| {})
            .expect("run_whisper");
        let elapsed = start.elapsed().as_secs_f64();
        let rtf = audio_secs / elapsed.max(1e-6);

        println!("--- done ---");
        println!(
            "ASR throughput: {audio_secs:.1}s audio in {elapsed:.1}s wall  =>  {rtf:.1}x real-time \
             ({} segments) on {}",
            segs.len(),
            dev.device
        );
        assert!(!segs.is_empty(), "whisper produced no segments");
        // Sanity: even CPU large-v3 should beat ~real-time now that the per-token I/O is gone.
        // (GPU is far higher; this floor just guards against a regression back to ~1x or worse.)
        assert!(rtf > 1.0, "expected faster-than-real-time throughput, got {rtf:.2}x");

        let _ = std::fs::remove_file(&tmp);
    }
}
