// Interview / recording ingest + media prep (Milestone 3).
//
// Mirrors cycle.rs conventions: typed structs map the `interview` + `recording`
// tables (migrations/0001_init.sql) 1:1, all SQL is parameterized, and each
// #[tauri::command] is a thin wrapper over a pool-taking helper (`*_db`) so the
// row logic is unit-testable against a real sqlx SQLite pool.
//
// Flow (spec §3.2): for each dropped path we create an `interview` (status
// 'importing') + a `recording` (source copied into cycles/<id>/media/), then a
// per-file tokio task runs the ffmpeg sidecar to produce <recording_id>.16k.wav
// and probe duration, updates the recording (audio_path/duration_ms) and the
// interview status to 'ready' (spec status vocab calls the prepared-but-not-yet-
// transcribed state... ponytail: the schema's status CHECK is informal, so we use
// 'new' once media is prepped — see note on STATUS_* below).
use std::path::{Path, PathBuf};

use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use tauri::{Emitter, Manager};
use uuid::Uuid;

use crate::Db;

// Status values written to interview.status during ingest. The schema comments a
// vocabulary of 'new'|'transcribing'|... ; M3 only owns the ingest portion:
//   importing -> while ffmpeg runs
//   new       -> media prepared (16k wav + duration), ready for ASR (M4)
//   error     -> ffmpeg/copy failed
const STATUS_IMPORTING: &str = "importing";
const STATUS_READY: &str = "new";
const STATUS_ERROR: &str = "error";

// The Tauri event channel the UI subscribes to for live row updates.
pub const PROGRESS_EVENT: &str = "interview://progress";

// --- row structs (match the tables) ------------------------------------------

// One interview joined with its recording fields for the DataTable. We expose the
// recording's audio_path/duration_ms/format directly so the frontend has one flat
// row. (An interview owns exactly one recording in the ingest flow.)
#[derive(Serialize, FromRow, Clone)]
pub struct InterviewRow {
    pub id: String,
    pub cycle_id: String,
    pub title: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    // recording (LEFT JOINed; nullable until/if a recording exists)
    pub source_path: Option<String>,
    pub audio_path: Option<String>,
    pub duration_ms: Option<i64>,
    pub format: Option<String>,
    pub bytes: Option<i64>,
}

// Payload emitted on PROGRESS_EVENT after each file finishes (or fails).
#[derive(Serialize, Clone)]
struct ProgressEvent {
    cycle_id: String,
    interview_id: String,
    status: String,
    audio_path: Option<String>,
    duration_ms: Option<i64>,
    error: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Title from a path: the file BASENAME without extension (bug #3). Splits on BOTH `/`
// and `\` regardless of host OS, so a Windows path handed to a Unix build (or vice-versa)
// still yields the bare file name rather than a mangled "dir_dir_file" title. e.g.
//   C:\ai-interview\_e2e\w1_a_short.mp3  -> "w1_a_short"
//   /home/u/clip.wav                     -> "clip"
fn title_from_path(p: &str) -> String {
    // Trim trailing separators, then take everything after the last `/` or `\`.
    let trimmed = p.trim_end_matches(['/', '\\']);
    let basename = trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(trimmed);
    // Drop a single trailing extension (the part after the last '.'), if any.
    let stem = match basename.rsplit_once('.') {
        Some((name, _ext)) if !name.is_empty() => name,
        _ => basename,
    };
    if stem.is_empty() {
        "Untitled".to_string()
    } else {
        stem.to_string()
    }
}

fn ext_from_path(p: &str) -> Option<String> {
    Path::new(p)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
}

// --- pool-taking DB helpers (the real SQL; unit-tested below) ----------------

// Insert interview (status=importing) + its recording (source_path only). Returns
// the new interview id and recording id. Timing/audio are filled in after ffmpeg.
async fn insert_pending_db(
    pool: &SqlitePool,
    cycle_id: &str,
    title: &str,
    source_path: &str,
    format: Option<&str>,
    bytes: Option<i64>,
) -> Result<(String, String), sqlx::Error> {
    let interview_id = Uuid::new_v4().to_string();
    let recording_id = Uuid::new_v4().to_string();
    let ts = now_ms();

    sqlx::query(
        "INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&interview_id)
    .bind(cycle_id)
    .bind(title)
    .bind(STATUS_IMPORTING)
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT INTO recording (id, interview_id, source_path, format, bytes) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&recording_id)
    .bind(&interview_id)
    .bind(source_path)
    .bind(format)
    .bind(bytes)
    .execute(pool)
    .await?;

    Ok((interview_id, recording_id))
}

// After ffmpeg: set the recording's audio_path/duration_ms and flip the interview
// to 'new' (prepared). Bumps updated_at.
async fn mark_ready_db(
    pool: &SqlitePool,
    interview_id: &str,
    recording_id: &str,
    audio_path: &str,
    duration_ms: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE recording SET audio_path = ?, duration_ms = ? WHERE id = ?")
        .bind(audio_path)
        .bind(duration_ms)
        .bind(recording_id)
        .execute(pool)
        .await?;
    sqlx::query("UPDATE interview SET status = ?, updated_at = ? WHERE id = ?")
        .bind(STATUS_READY)
        .bind(now_ms())
        .bind(interview_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn mark_error_db(pool: &SqlitePool, interview_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE interview SET status = ?, updated_at = ? WHERE id = ?")
        .bind(STATUS_ERROR)
        .bind(now_ms())
        .bind(interview_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn list_interviews_db(
    pool: &SqlitePool,
    cycle_id: &str,
) -> Result<Vec<InterviewRow>, sqlx::Error> {
    sqlx::query_as::<_, InterviewRow>(
        "SELECT i.id, i.cycle_id, i.title, i.status, i.created_at, i.updated_at, \
                r.source_path, r.audio_path, r.duration_ms, r.format, r.bytes \
         FROM interview i \
         LEFT JOIN recording r ON r.interview_id = i.id \
         WHERE i.cycle_id = ? \
         ORDER BY i.created_at ASC",
    )
    .bind(cycle_id)
    .fetch_all(pool)
    .await
}

async fn delete_interview_db(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    // recording rows cascade via the schema's ON DELETE CASCADE.
    sqlx::query("DELETE FROM interview WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// --- ffmpeg sidecar work (blocking; run inside spawn_blocking) ----------------

// Convert `src` to a 16 kHz mono WAV at `dst` and return its duration in ms.
// Uses the ffmpeg-sidecar crate (spec §6.5): auto-downloads an LGPL ffmpeg build
// on first use, runs it as a subprocess, and we read the duration off the
// progress events (`Duration`/`Progress.time`) it parses from ffmpeg's stderr.
fn transcode_and_probe(src: &Path, dst: &Path) -> Result<i64, String> {
    use ffmpeg_sidecar::command::FfmpegCommand;
    use ffmpeg_sidecar::event::FfmpegEvent;

    // Ensure ffmpeg exists (download once if missing). No-op if already present.
    ffmpeg_sidecar::download::auto_download()
        .map_err(|e| format!("ffmpeg download failed: {e}"))?;

    let src_s = src.to_string_lossy().to_string();
    let dst_s = dst.to_string_lossy().to_string();

    // OUTPUT options (after -i): drop any video stream, force mono 16 kHz 16-bit PCM. Pinning
    // the codec + rate explicitly (not just `-ar`) guarantees the wav whisper reads is truly
    // 16 kHz — a wrong rate would silently compress every timestamp (see asr::TARGET_SAMPLE_RATE).
    let mut child = FfmpegCommand::new()
        .input(&src_s)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg("-y") // overwrite
        .output(&dst_s)
        .spawn()
        .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;

    // Walk the parsed event stream. `ParsedDuration` carries the source's total
    // length in seconds (authoritative). We keep the last error-level log line so
    // a failed convert reports something useful.
    let mut duration_secs: f64 = 0.0;
    let mut last_error: Option<String> = None;
    for event in child.iter().map_err(|e| format!("ffmpeg iter failed: {e}"))? {
        match event {
            FfmpegEvent::ParsedDuration(d) => {
                if d.duration > duration_secs {
                    duration_secs = d.duration;
                }
            }
            FfmpegEvent::Error(e) => last_error = Some(e),
            FfmpegEvent::Log(level, msg) => {
                if format!("{level:?}").to_lowercase().contains("error") {
                    last_error = Some(msg);
                }
            }
            _ => {}
        }
    }

    if !dst.exists() {
        let msg = last_error.unwrap_or_else(|| "ffmpeg produced no output file".to_string());
        log::error!(
            target: "interviewlab::interview",
            "[E-INGEST-TRANSCODE] transcode FAILED: '{}' → '{}' (mono 16kHz wav): {msg}. \
             hint: the source may be corrupt, a non-media file, or an unsupported codec.",
            src.display(), dst.display()
        );
        return Err(msg);
    }

    log::debug!(
        target: "interviewlab::interview",
        "transcode OK: '{}' → '{}' ({:.1}s)",
        src.display(), dst.display(), duration_secs
    );
    Ok((duration_secs * 1000.0).round() as i64)
}

// Compute the cycle media dir: <app_data>/cycles/<cycle_id>/media (spec §2.3).
fn media_dir(app: &tauri::AppHandle, cycle_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join("cycles").join(cycle_id).join("media"))
}

// --- Tauri commands -----------------------------------------------------------

// Ingest a batch of source paths into a cycle. For each: create rows + copy file
// into media/, then kick off a background ffmpeg task that prepares the 16k wav,
// records duration, and emits a PROGRESS_EVENT. Returns the freshly-created rows
// (status 'importing') immediately so the UI can render them right away.
#[tauri::command]
pub async fn add_interview_files(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    cycle_id: String,
    paths: Vec<String>,
) -> Result<Vec<InterviewRow>, String> {
    let dir = media_dir(&app, &cycle_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create media dir: {e}"))?;

    let mut created: Vec<InterviewRow> = Vec::new();

    for src in paths {
        let title = title_from_path(&src);
        let ext = ext_from_path(&src);
        let bytes = std::fs::metadata(&src).ok().map(|m| m.len() as i64);

        let (interview_id, recording_id) = insert_pending_db(
            &db.pool,
            &cycle_id,
            &title,
            &src,
            ext.as_deref(),
            bytes,
        )
        .await
        .map_err(|e| format!("insert: {e}"))?;

        // Copy the source into media/ as <recording_id>.<ext> (spec §2.3 layout).
        let copied = dir.join(format!(
            "{recording_id}.{}",
            ext.clone().unwrap_or_else(|| "bin".to_string())
        ));
        if let Err(e) = std::fs::copy(&src, &copied) {
            log::error!(
                target: "interviewlab::interview",
                "[E-INGEST-COPY] ingest: copying source '{src}' → '{}' failed: {e} (kind: {:?})",
                copied.display(), e.kind()
            );
            mark_error_db(&db.pool, &interview_id).await.ok();
            emit_progress(&app, &cycle_id, &interview_id, STATUS_ERROR, None, None, Some(format!("copy failed: {e}")));
            // Still return the row so the UI shows the error state.
            created.push(InterviewRow {
                id: interview_id,
                cycle_id: cycle_id.clone(),
                title,
                status: STATUS_ERROR.into(),
                created_at: now_ms(),
                updated_at: now_ms(),
                source_path: Some(src),
                audio_path: None,
                duration_ms: None,
                format: ext,
                bytes,
            });
            continue;
        }

        // Spawn the ffmpeg prep on a background task; emit a progress event when
        // done. ponytail: no concurrency cap in M3 — a handful of files is fine;
        // ASR (M4) is where the spec wants concurrency=1.
        let pool = db.pool.clone();
        let app2 = app.clone();
        let cycle2 = cycle_id.clone();
        let iv = interview_id.clone();
        let rec = recording_id.clone();
        let wav = dir.join(format!("{recording_id}.16k.wav"));
        let audio_path_str = wav.to_string_lossy().into_owned();
        let copied2 = copied.clone();
        tauri::async_runtime::spawn(async move {
            // ffmpeg is blocking I/O → run it off the async pool.
            let result = tauri::async_runtime::spawn_blocking(move || {
                transcode_and_probe(&copied2, &wav)
            })
            .await;

            // Flatten JoinResult<Result<duration, err>> into Result<duration, msg>.
            let outcome: Result<i64, String> = match result {
                Ok(Ok(duration_ms)) => Ok(duration_ms),
                Ok(Err(e)) => Err(e),
                Err(_) => Err("ffmpeg task panicked".to_string()),
            };

            match outcome {
                Ok(duration_ms) => {
                    let audio = audio_path_str;
                    if let Err(e) =
                        mark_ready_db(&pool, &iv, &rec, &audio, duration_ms).await
                    {
                        mark_error_db(&pool, &iv).await.ok();
                        emit_progress(&app2, &cycle2, &iv, STATUS_ERROR, None, None, Some(e.to_string()));
                        return;
                    }
                    emit_progress(&app2, &cycle2, &iv, STATUS_READY, Some(audio), Some(duration_ms), None);
                }
                Err(msg) => {
                    log::error!(target: "interviewlab::interview", "[E-INGEST-TRANSCODE] ingest: interview='{iv}': audio preparation FAILED → status=error: {msg}");
                    mark_error_db(&pool, &iv).await.ok();
                    emit_progress(&app2, &cycle2, &iv, STATUS_ERROR, None, None, Some(msg));
                }
            }
        });

        created.push(InterviewRow {
            id: interview_id,
            cycle_id: cycle_id.clone(),
            title,
            status: STATUS_IMPORTING.into(),
            created_at: now_ms(),
            updated_at: now_ms(),
            source_path: Some(src),
            audio_path: None,
            duration_ms: None,
            format: ext,
            bytes,
        });
    }

    Ok(created)
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &tauri::AppHandle,
    cycle_id: &str,
    interview_id: &str,
    status: &str,
    audio_path: Option<String>,
    duration_ms: Option<i64>,
    error: Option<String>,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        ProgressEvent {
            cycle_id: cycle_id.to_string(),
            interview_id: interview_id.to_string(),
            status: status.to_string(),
            audio_path,
            duration_ms,
            error,
        },
    );
}

#[tauri::command]
pub async fn list_interviews(
    db: tauri::State<'_, Db>,
    cycle_id: String,
) -> Result<Vec<InterviewRow>, String> {
    list_interviews_db(&db.pool, &cycle_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_interview(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    delete_interview_db(&db.pool, &id)
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

    async fn make_cycle(pool: &SqlitePool) -> String {
        let id = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(&id)
            .bind("Test cycle")
            .bind(ts)
            .bind(ts)
            .execute(pool)
            .await
            .unwrap();
        id
    }

    // Ingest row logic against the real migration: insert pending → list shows
    // 'importing' with source set + null audio/duration → mark_ready flips status
    // and fills audio_path/duration_ms (the columns M3 verify checks).
    #[tokio::test]
    async fn ingest_creates_rows_then_marks_ready() {
        let pool = test_pool().await;
        let cycle_id = make_cycle(&pool).await;

        // Drop three files (paths only — no ffmpeg in the unit test).
        let mut ivs = Vec::new();
        for name in ["a.mp3", "b.wav", "c.mp4"] {
            let (iv, rec) = insert_pending_db(
                &pool,
                &cycle_id,
                &title_from_path(name),
                &format!("C:/src/{name}"),
                ext_from_path(name).as_deref(),
                Some(1234),
            )
            .await
            .unwrap();
            ivs.push((iv, rec));
        }

        // Three importing rows, audio/duration still null.
        let rows = list_interviews_db(&pool, &cycle_id).await.unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.status == STATUS_IMPORTING));
        assert!(rows.iter().all(|r| r.audio_path.is_none()));
        assert!(rows.iter().all(|r| r.duration_ms.is_none()));
        assert!(rows.iter().all(|r| r.source_path.is_some()));

        // Simulate ffmpeg completing for each: audio_path + duration set, status 'new'.
        for (i, (iv, rec)) in ivs.iter().enumerate() {
            mark_ready_db(&pool, iv, rec, &format!("C:/media/{rec}.16k.wav"), (i as i64 + 1) * 1000)
                .await
                .unwrap();
        }

        let rows = list_interviews_db(&pool, &cycle_id).await.unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.status == STATUS_READY));
        assert!(rows.iter().all(|r| r.audio_path.is_some()));
        assert!(rows.iter().all(|r| r.duration_ms.unwrap() > 0));
        assert_eq!(rows[0].format.as_deref(), Some("mp3"));
    }

    // bug #3: title is the file BASENAME (no dir, no extension), cross-platform.
    #[test]
    fn title_from_path_uses_basename() {
        // Windows-style backslash path (the e2e repro) → bare stem, not "ai-interview_e2e…".
        assert_eq!(title_from_path(r"C:\ai-interview\_e2e\w1_a_short.mp3"), "w1_a_short");
        // POSIX path.
        assert_eq!(title_from_path("/home/u/recordings/clip.wav"), "clip");
        // Mixed separators.
        assert_eq!(title_from_path(r"C:/ai-interview\sub/take 2.m4a"), "take 2");
        // No directory, just a filename.
        assert_eq!(title_from_path("interview.mp4"), "interview");
        // No extension → the whole basename is the title.
        assert_eq!(title_from_path(r"D:\dir\noext"), "noext");
        // Dotfile-only / odd names don't blow up.
        assert_eq!(title_from_path("file.tar.gz"), "file.tar"); // drops only the last ext
        assert_eq!(title_from_path("/a/b/"), "b"); // trailing slash trimmed
        // Degenerate inputs fall back to a sane title rather than empty.
        assert_eq!(title_from_path(""), "Untitled");
        assert_eq!(title_from_path("/"), "Untitled");
        // A leading-dot name has no real stem before the dot → keep the whole name
        // (matches std file_stem semantics) rather than producing an empty title.
        assert_eq!(title_from_path(".mp3"), ".mp3");
    }

    #[tokio::test]
    async fn mark_error_sets_status() {
        let pool = test_pool().await;
        let cycle_id = make_cycle(&pool).await;
        let (iv, _rec) =
            insert_pending_db(&pool, &cycle_id, "x", "C:/src/x.mov", Some("mov"), None)
                .await
                .unwrap();
        mark_error_db(&pool, &iv).await.unwrap();
        let rows = list_interviews_db(&pool, &cycle_id).await.unwrap();
        assert_eq!(rows[0].status, STATUS_ERROR);
    }

    // End-to-end ffmpeg sidecar verify (M3 manual check). #[ignore]d so the normal
    // suite stays offline/fast; run with `cargo test -- --ignored ffmpeg`.
    // Downloads ffmpeg if missing, generates 3 sine clips of 2/3/4s, runs
    // transcode_and_probe on each, and asserts the 16k wav exists + duration is
    // probed within ~100ms of the synthesized length.
    #[test]
    #[ignore]
    fn ffmpeg_transcode_and_probe_real() {
        use ffmpeg_sidecar::command::FfmpegCommand;

        ffmpeg_sidecar::download::auto_download().expect("ffmpeg download");

        let tmp = std::env::temp_dir().join("ilab_m3_verify");
        std::fs::create_dir_all(&tmp).unwrap();

        for (i, secs) in [2u32, 3, 4].iter().enumerate() {
            let src = tmp.join(format!("gen{i}.mp3"));
            // Generate a sine tone of `secs` seconds as an mp3 source file.
            let ok = FfmpegCommand::new()
                .args(["-f", "lavfi", "-i", &format!("sine=frequency=440:duration={secs}")])
                .arg("-y")
                .output(&src.to_string_lossy())
                .spawn()
                .unwrap()
                .wait()
                .unwrap()
                .success();
            assert!(ok, "ffmpeg failed to generate {src:?}");

            let dst = tmp.join(format!("gen{i}.16k.wav"));
            let dur = transcode_and_probe(&src, &dst).expect("transcode");
            assert!(dst.exists(), "wav not produced for clip {i}");
            let expected = (*secs as i64) * 1000;
            assert!(
                (dur - expected).abs() <= 150,
                "clip {i}: probed {dur}ms vs expected {expected}ms",
            );
        }

        std::fs::remove_dir_all(&tmp).ok();
    }

    // Live-DB end-to-end ingest verify (M3 brief). #[ignore]d. Opens the REAL app
    // database at %APPDATA%/com.interviewlab.app/interviewlab.db, creates a temp
    // cycle, generates 3 sine clips (2/3/4s), then runs the exact production path
    // (insert_pending_db → copy → transcode_and_probe → mark_ready_db) under the
    // real cycles/<id>/media/ layout, asserts 3 rows have audio_path + correct
    // durations and the 16k wavs exist on disk, then cleans up rows + files.
    // Run: cargo test live_db_ingest_verify -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_db_ingest_verify() {
        use ffmpeg_sidecar::command::FfmpegCommand;

        ffmpeg_sidecar::download::auto_download().expect("ffmpeg");

        // Real app-data dir: %APPDATA%/com.interviewlab.app (Tauri identifier).
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let db_path = app_dir.join("interviewlab.db");
        assert!(db_path.exists(), "live DB not found at {db_path:?} — run the app once first");

        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&db_path)
            .foreign_keys(true);
        let pool = sqlx::sqlite::SqlitePool::connect_with(opts).await.unwrap();

        // Temp cycle so we don't disturb the user's data.
        let cycle_id = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(&cycle_id)
            .bind("__M3_VERIFY__")
            .bind(ts)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();

        let media = app_dir.join("cycles").join(&cycle_id).join("media");
        std::fs::create_dir_all(&media).unwrap();
        let gen_dir = std::env::temp_dir().join("ilab_m3_live_src");
        std::fs::create_dir_all(&gen_dir).unwrap();

        for (i, secs) in [2u32, 3, 4].iter().enumerate() {
            // Generate a source clip.
            let src = gen_dir.join(format!("live{i}.mp3"));
            let ok = FfmpegCommand::new()
                .args(["-f", "lavfi", "-i", &format!("sine=frequency=440:duration={secs}")])
                .arg("-y")
                .output(&src.to_string_lossy())
                .spawn()
                .unwrap()
                .wait()
                .unwrap()
                .success();
            assert!(ok);

            // Production path: insert pending → copy into media/ → transcode+probe → mark ready.
            let bytes = std::fs::metadata(&src).ok().map(|m| m.len() as i64);
            let (iv, rec) = insert_pending_db(
                &pool,
                &cycle_id,
                &title_from_path(&src.to_string_lossy()),
                &src.to_string_lossy(),
                Some("mp3"),
                bytes,
            )
            .await
            .unwrap();

            let copied = media.join(format!("{rec}.mp3"));
            std::fs::copy(&src, &copied).unwrap();
            let wav = media.join(format!("{rec}.16k.wav"));
            let dur = transcode_and_probe(&copied, &wav).expect("transcode");
            mark_ready_db(&pool, &iv, &rec, &wav.to_string_lossy(), dur)
                .await
                .unwrap();
        }

        // Assert: 3 ready rows, audio_path set, non-null durations near 2/3/4s, wavs on disk.
        let rows = list_interviews_db(&pool, &cycle_id).await.unwrap();
        assert_eq!(rows.len(), 3, "expected 3 interview rows");
        let mut durations: Vec<i64> = Vec::new();
        for r in &rows {
            assert_eq!(r.status, STATUS_READY);
            let audio = r.audio_path.as_ref().expect("audio_path set");
            assert!(std::path::Path::new(audio).exists(), "wav missing: {audio}");
            let d = r.duration_ms.expect("duration set");
            assert!(d > 0, "duration must be > 0");
            durations.push(d);
            println!("row: title={} duration_ms={} audio_path={}", r.title, d, audio);
        }
        durations.sort();
        for (got, exp) in durations.iter().zip([2000i64, 3000, 4000]) {
            assert!((got - exp).abs() <= 150, "duration {got} vs {exp}");
        }

        // Cleanup: delete the temp cycle (cascades interview+recording) + media dir + sources.
        sqlx::query("DELETE FROM cycle WHERE id = ?")
            .bind(&cycle_id)
            .execute(&pool)
            .await
            .unwrap();
        std::fs::remove_dir_all(app_dir.join("cycles").join(&cycle_id)).ok();
        std::fs::remove_dir_all(&gen_dir).ok();
        println!("M3 live verify OK: 3 rows, audio+duration set, wavs existed, cleaned up.");
    }

    // delete_interview removes the interview and cascades the recording.
    #[tokio::test]
    async fn delete_cascades_recording() {
        let pool = test_pool().await;
        let cycle_id = make_cycle(&pool).await;
        let (iv, rec) =
            insert_pending_db(&pool, &cycle_id, "y", "C:/src/y.m4a", Some("m4a"), None)
                .await
                .unwrap();
        delete_interview_db(&pool, &iv).await.unwrap();
        assert_eq!(list_interviews_db(&pool, &cycle_id).await.unwrap().len(), 0);
        let rec_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recording WHERE id = ?")
            .bind(&rec)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rec_count, 0);
    }
}
