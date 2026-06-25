// Centralized application logging (comprehensive error logging).
//
// Goal: capture EVERY error the app can produce — with special attention to the
// four heavy/fragile subsystems (the local AI CLI integration, ASR/transcription,
// transcript cleanup, and synthesis/diff) — in ONE place, described as fully as
// possible, and persist it to a file the user (or an agent debugging the app) can
// read after the fact. Before this module the backend only had scattered
// `eprintln!`/`println!` (mostly in tests), so a real failure in a packaged build
// left no trace.
//
// Design — matches the codebase's dependency-conservative "ponytail" convention
// (declare only crates ALREADY in the dependency tree so nothing new compiles):
// `log` + `chrono` are both already transitive deps. We add:
//   * a tiny `log::Log` implementor (`TeeLogger`) that TEES every record to
//       (a) stderr — so the dev console / `cargo test --nocapture` keep working, and
//       (b) a size-rolled log file under the OS app-log dir.
//     Installing it as the GLOBAL `log` logger means errors that flow through the
//     `log` facade from libraries are captured for free, on top of our own calls.
//   * a panic hook that routes panics (location + payload) into the same log, so a
//     crash on a background task is no longer silent.
//
// Records are rich + single-line so each is self-contained when grepped:
//   2026-06-25T12:34:56.789+03:00  ERROR  interviewlab_lib::cleanup  cleanup.rs:761  <message>
//
// Usage from anywhere in the backend: the standard `log` macros — `log::error!`,
// `log::warn!`, `log::info!`, `log::debug!`, `log::trace!`. `truncate()` keeps huge
// CLI stdout / payloads from bloating the file while preserving a readable head.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use log::{Level, LevelFilter, Log, Metadata, Record};

// The active log file lives at <app-log-dir>/interviewlab.log. Rolled to
// interviewlab.log.old once it passes MAX_LOG_BYTES so it never grows unbounded
// across long sessions (one backup generation is plenty for debugging).
const LOG_FILE_NAME: &str = "interviewlab.log";
const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

// Targets emitted by our own crate look like `interviewlab_lib::adapter` /
// `interviewlab::…`; everything else is a third-party library.
fn is_ours(target: &str) -> bool {
    target.starts_with("interviewlab")
}

// The open sink: the file handle, a running byte counter (so we roll without a
// stat() per write), and the resolved path (surfaced to the UI via `log_file_path`).
struct Sink {
    file: File,
    written: u64,
    path: PathBuf,
}

struct TeeLogger {
    // None until `attach_file` runs; records before that still reach stderr.
    sink: Mutex<Option<Sink>>,
    // Max verbosity for OUR crate's records.
    our_level: LevelFilter,
    // Max verbosity for third-party library records (quieter by default so library
    // info/debug chatter doesn't drown out our own diagnostics — errors/warns still
    // land in the file).
    other_level: LevelFilter,
}

static LOGGER: OnceLock<TeeLogger> = OnceLock::new();

impl TeeLogger {
    fn level_for(&self, target: &str) -> LevelFilter {
        if is_ours(target) {
            self.our_level
        } else {
            self.other_level
        }
    }

    // Format one record as a single, self-contained line (no trailing newline).
    fn format_line(record: &Record) -> String {
        let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%z");
        let loc = match (record.file(), record.line()) {
            (Some(f), Some(l)) => {
                // Keep just the file name, not the absolute build path.
                let short = f.rsplit(['/', '\\']).next().unwrap_or(f);
                format!("{short}:{l}")
            }
            _ => "-".to_string(),
        };
        format!(
            "{ts}  {:<5}  {}  {}  {}",
            record.level(),
            record.target(),
            loc,
            record.args()
        )
    }
}

impl Log for TeeLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= self.level_for(metadata.target())
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = Self::format_line(record);

        // (a) stderr — keeps the dev console / test output working as before.
        eprintln!("{line}");

        // (b) the rolling log file, when attached. A poisoned mutex or IO error must
        // never panic the logging path itself, so every step is best-effort.
        if let Ok(mut guard) = self.sink.lock() {
            if let Some(sink) = guard.as_mut() {
                let bytes = line.len() as u64 + 1;
                if sink.written.saturating_add(bytes) > MAX_LOG_BYTES {
                    roll(sink);
                }
                if sink.file.write_all(line.as_bytes()).is_ok() && sink.file.write_all(b"\n").is_ok() {
                    sink.written = sink.written.saturating_add(bytes);
                }
                let _ = sink.file.flush();
            }
        }
    }

    fn flush(&self) {
        if let Ok(mut guard) = self.sink.lock() {
            if let Some(sink) = guard.as_mut() {
                let _ = sink.file.flush();
            }
        }
    }
}

// Roll the active file to <name>.old and reopen a fresh one. Best-effort: if any
// step fails we keep writing to the existing handle (worst case the file exceeds the
// cap, which is harmless).
fn roll(sink: &mut Sink) {
    let _ = sink.file.flush();
    let old = sink.path.with_extension("log.old");
    let _ = fs::remove_file(&old);
    if fs::rename(&sink.path, &old).is_ok() {
        if let Ok(fresh) = OpenOptions::new().create(true).append(true).open(&sink.path) {
            sink.file = fresh;
            sink.written = 0;
        }
    }
}

// Default verbosity for our own crate. Overridable at launch via the INTERVIEWLAB_LOG
// env var (off|error|warn|info|debug|trace) — handy for an agent that wants the full
// firehose while reproducing a bug.
fn our_level_from_env() -> LevelFilter {
    match std::env::var("INTERVIEWLAB_LOG").ok().as_deref().map(str::trim) {
        Some("off") => LevelFilter::Off,
        Some("error") => LevelFilter::Error,
        Some("warn") => LevelFilter::Warn,
        Some("info") => LevelFilter::Info,
        Some("debug") => LevelFilter::Debug,
        Some("trace") => LevelFilter::Trace,
        _ => LevelFilter::Debug,
    }
}

// Install the global logger + a panic hook. Idempotent: a second call (or a logger
// installed by something else) is ignored rather than panicking. Call ONCE, as early
// as possible in `run()`, before any fallible setup — records emitted before
// `attach_file` still reach stderr and are retroactively captured to the file only
// for subsequent records (the file starts at attach time).
pub fn init() {
    let our_level = our_level_from_env();
    let logger = LOGGER.get_or_init(|| TeeLogger {
        sink: Mutex::new(None),
        our_level,
        // Capture third-party WARN/ERROR too (e.g. a library surfacing a failure),
        // but not their info/debug chatter.
        other_level: LevelFilter::Warn,
    });

    // set_logger fails if a logger is already installed — that's fine, we just won't
    // be the global sink, but our explicit `log::*` calls still no-op gracefully.
    if log::set_logger(logger).is_ok() {
        log::set_max_level(our_level.max(LevelFilter::Warn));
        install_panic_hook();
    }
}

// Route panics into the log (with location + payload) AFTER chaining the previous
// hook, so a panic on any thread — including a background ASR/cleanup task — leaves a
// durable trace instead of vanishing.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let thread = std::thread::current().name().unwrap_or("<unnamed>").to_string();
        log::error!(
            target: "interviewlab::panic",
            "PANIC on thread '{thread}' at {location}: {payload}"
        );
        previous(info);
    }));
}

// Point the file sink at <dir>/interviewlab.log, creating the directory if needed,
// and write a session header so each launch is easy to find in a long file. Returns
// the resolved path (or an error string the caller can log/show). Best-effort: a
// failure here must never block app launch — stderr logging keeps working.
pub fn attach_file(dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("create log dir {}: {e}", dir.display()))?;
    let path = dir.join(LOG_FILE_NAME);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open log file {}: {e}", path.display()))?;
    let written = file.metadata().map(|m| m.len()).unwrap_or(0);

    if let Some(logger) = LOGGER.get() {
        if let Ok(mut guard) = logger.sink.lock() {
            *guard = Some(Sink {
                file,
                written,
                path: path.clone(),
            });
        }
    }

    log::info!(
        target: "interviewlab::logging",
        "=== InterviewLab v{} session started — logging to {} (level: {}) ===",
        env!("CARGO_PKG_VERSION"),
        path.display(),
        our_level_from_env()
    );
    Ok(path)
}

// The active log file path, for the Settings UI / "open logs" action. None when the
// file sink isn't attached (e.g. the log dir couldn't be created).
pub fn log_file_path() -> Option<PathBuf> {
    LOGGER
        .get()
        .and_then(|l| l.sink.lock().ok())
        .and_then(|g| g.as_ref().map(|s| s.path.clone()))
}

// Truncate a long blob (CLI stdout/stderr, a serialized payload) for logging:
// keep the head and annotate how much was dropped, so a multi-megabyte transcript
// payload can be logged for context without bloating the file. Errors keep their
// FULL stderr (it's the diagnostic); this is for the bulky, lower-signal blobs.
pub fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Respect char boundaries when slicing UTF-8 (CLI output is often Russian).
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}… [truncated, {} of {} bytes shown]",
        &s[..end],
        end,
        s.len()
    )
}

// Convenience for the very common "Level::Error vs Warn" branch some callers want.
#[allow(dead_code)]
pub fn is_error(level: Level) -> bool {
    level == Level::Error
}

// --- agent-navigable error taxonomy -------------------------------------------
//
// Goal (per the product ask): make the log readable by an AI agent that wants to
// triage failures fast and act on them. Every notable error message starts with a
// STABLE, greppable code `[E-<SUBSYS>-<KIND>]` so an agent can:
//   * `grep '\[E-' interviewlab.log` to enumerate every failure class that fired,
//   * map a code → a known remedy without parsing free-form prose,
//   * correlate a user-visible toast with the exact backend code path.
// The human-readable detail + a `hint:`/`fix:` clause still follow the code, so the
// same line serves both a person and an agent. Codes are append-only — never reuse
// or repurpose one, so historical logs stay interpretable.
//
// These consts are the single source of truth for the taxonomy; call sites embed the
// literal (e.g. "[E-CLI-SPAWN] …") for zero-overhead formatting, and this block
// documents what each means + the typical fix an agent can apply. `dead_code` is
// allowed because the consts are reference DOCUMENTATION (the call sites use the
// literal string, kept in sync with these) — a grep target + a place to read the fix.
#[allow(dead_code)]
pub mod codes {
    // CLI integration (adapter.rs / chat.rs) — the local AI CLI the app drives.
    /// CLI binary could not be started — usually not installed / not on PATH. fix: install the CLI or correct `command` in the plugin manifest.
    pub const CLI_SPAWN: &str = "E-CLI-SPAWN";
    /// CLI exceeded its timeout and was killed. fix: raise `io.timeout_sec`, shrink the payload, or check the model isn't overloaded.
    pub const CLI_TIMEOUT: &str = "E-CLI-TIMEOUT";
    /// CLI exited non-zero — see the captured stderr for the CLI's own message. fix: act on the stderr (often auth/quota/bad-flag).
    pub const CLI_EXIT: &str = "E-CLI-EXIT";
    /// CLI output could not be parsed as the expected JSON after a retry. fix: check the plugin's `--output-format` + `result_extract`; the model may be wrapping JSON in prose.
    pub const CLI_PARSE: &str = "E-CLI-PARSE";
    /// Misconfiguration before spawning (payload too big, missing task/io block). fix: correct the plugin manifest or reduce input size.
    pub const CLI_CONFIG: &str = "E-CLI-CONFIG";
    /// Round-trip failed in a way that looks like auth. fix: log the CLI in (e.g. `claude login`) or set the required API-key env var.
    pub const CLI_AUTH: &str = "E-CLI-AUTH";
    /// A plugin manifest was malformed and skipped. fix: correct the manifest against manifest.schema.json.
    pub const CLI_PLUGIN: &str = "E-CLI-PLUGIN";

    // ASR / transcription (asr.rs) — расшифровки.
    /// The whisper model weights file is missing. fix: download the model in Settings.
    pub const ASR_MODEL_MISSING: &str = "E-ASR-MODEL-MISSING";
    /// The prepared 16k wav for the interview is missing. fix: re-run ingest for the interview.
    pub const ASR_AUDIO_MISSING: &str = "E-ASR-AUDIO-MISSING";
    /// whisper.cpp decode failed (encode error / bad model / OOM). fix: try a CPU run, a smaller model, or check VRAM.
    pub const ASR_DECODE: &str = "E-ASR-DECODE";
    /// The transcription watchdog killed a runaway/stuck run. fix: check the audio has speech; a jingle/silence can run away.
    pub const ASR_TIMEOUT: &str = "E-ASR-TIMEOUT";
    /// Diarization failed — NON-FATAL, single speaker kept. fix: ensure diar models are present + CPU isn't saturated; retry via re-diarize.
    pub const ASR_DIARIZE: &str = "E-ASR-DIARIZE";
    /// A model/diar-model download failed. fix: check network/proxy + free disk.
    pub const ASR_DOWNLOAD: &str = "E-ASR-DOWNLOAD";
    /// Transcription succeeded but persisting it failed. fix: check the DB/disk; the result was not saved.
    pub const ASR_STORE: &str = "E-ASR-STORE";

    // Transcript cleanup (cleanup.rs) — очистка.
    /// The model broke the segment count/id invariant on a batch. fix: usually transient; a smaller BATCH_SIZE or a stronger model helps if it recurs.
    pub const CLEAN_ALIGN: &str = "E-CLEAN-ALIGN";
    /// The cleanup CLI output had the wrong JSON shape. fix: check the cleanup task's schema + the model.
    pub const CLEAN_SHAPE: &str = "E-CLEAN-SHAPE";
    /// A cleanup batch gave up after its retries. fix: see the preceding align/shape warnings for the root cause.
    pub const CLEAN_GIVEUP: &str = "E-CLEAN-GIVEUP";
    /// A post-cleanup invariant check failed (count/timing/label drift) — refused to store. fix: this is a guard; report it, the transcript is left intact.
    pub const CLEAN_INVARIANT: &str = "E-CLEAN-INVARIANT";
    /// Cleanup succeeded but storing the cleaned transcript failed. fix: check the DB/disk.
    pub const CLEAN_STORE: &str = "E-CLEAN-STORE";

    // Synthesis / diff (synthesis.rs / diff.rs) — синтез.
    /// One interview's MAP extraction failed/empty — NON-FATAL, its points are dropped. fix: re-run synthesis; check that interview's transcript + the CLI.
    pub const SYN_EXTRACT: &str = "E-SYN-EXTRACT";
    /// The REDUCE stage failed — FATAL to the run (no findings). fix: check the CLI + the reduce schema.
    pub const SYN_REDUCE: &str = "E-SYN-REDUCE";
    /// Synthesis/summary succeeded but storing it failed. fix: check the DB/disk.
    pub const SYN_STORE: &str = "E-SYN-STORE";
    /// No goals derivable from the guide. fix: add a Goals section to the cycle's guide.
    pub const SYN_NO_GOALS: &str = "E-SYN-NO-GOALS";
    /// No transcribed interviews to synthesize. fix: transcribe at least one interview first.
    pub const SYN_NO_INTERVIEWS: &str = "E-SYN-NO-INTERVIEWS";
    /// The diff run failed. fix: ensure both waves are synthesized; check the CLI.
    pub const DIFF_RUN: &str = "E-DIFF-RUN";
    /// The diff produced but storing it failed. fix: check the DB/disk.
    pub const DIFF_STORE: &str = "E-DIFF-STORE";

    // Chat (chat.rs) — the agentic CLI chat.
    /// The chat CLI failed to start. fix: same as E-CLI-SPAWN.
    pub const CHAT_SPAWN: &str = "E-CHAT-SPAWN";
    /// The chat CLI produced no answer (non-zero exit). fix: see the captured stderr.
    pub const CHAT_NO_ANSWER: &str = "E-CHAT-NO-ANSWER";
    /// A chat turn failed for another reason. fix: see the message.
    pub const CHAT_TURN: &str = "E-CHAT-TURN";

    // Ingest (interview.rs) + storage/DB.
    /// Copying the source media into the cycle failed. fix: check the path exists + disk space/permissions.
    pub const INGEST_COPY: &str = "E-INGEST-COPY";
    /// ffmpeg transcode → 16k wav failed. fix: the source may be corrupt/non-media/unsupported codec.
    pub const INGEST_TRANSCODE: &str = "E-INGEST-TRANSCODE";
    /// Database initialization failed at launch — FATAL. fix: check the app-data dir is writable + the DB isn't corrupt.
    pub const DB_INIT: &str = "E-DB-INIT";
}
