use std::fs;

use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use tauri::Manager;

mod adapter;
mod asr;
mod chat;
mod cleanup;
mod coverage;
mod cycle;
mod diarize;
mod diff;
mod glossary;
mod guides;
mod interview;
mod logging;
mod product;
mod roles;
mod synthesis;
mod transcript;

// Pool handle stored in Tauri state and injected into commands.
// pub(crate) so the cycle module's commands can read the pool.
pub(crate) struct Db {
    pub(crate) pool: SqlitePool,
    path: String,
}

#[derive(Serialize)]
struct DbHealth {
    db_path: String,
    schema_version: i64,
}

// Health check: returns the db file path + the highest applied migration version.
// Called from the frontend on load to render the "backend OK" badge.
#[tauri::command]
async fn db_health(db: tauri::State<'_, Db>) -> Result<DbHealth, String> {
    // _sqlx_migrations is created by sqlx::migrate!; MAX(version) = current schema version.
    let schema_version: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
            .fetch_one(&db.pool)
            .await
            .map_err(|e| e.to_string())?;

    Ok(DbHealth {
        db_path: db.path.clone(),
        schema_version,
    })
}

// The active log file path, for the Settings UI / an "open logs" action. Returns the
// resolved <app-log-dir>/interviewlab.log when the file sink is attached, else None.
#[tauri::command]
fn log_file_path() -> Option<String> {
    logging::log_file_path().map(|p| p.to_string_lossy().into_owned())
}

// Ensure %APPDATA%/InterviewLab/ exists, open interviewlab.db, run migrations, return the pool.
// Every fallible step is logged with full context BEFORE the `?` propagates it, so a launch
// failure (the one place a bad error is fatal) leaves a precise breadcrumb in the log file —
// not just the generic `.expect("failed to initialize database")` panic message.
async fn init_db(app: &tauri::AppHandle) -> Result<Db, Box<dyn std::error::Error>> {
    // Tauri's resolved app-data dir (spec §2.3). Resolves to %APPDATA%/<bundle identifier>
    // on Windows, i.e. %APPDATA%/com.interviewlab.app. ponytail: using Tauri's resolved
    // dir as the spec says rather than hard-coding "InterviewLab".
    let app_dir = app.path().app_data_dir().map_err(|e| {
        log::error!("[E-DB-INIT] init_db: could not resolve app_data_dir (Tauri path API): {e}");
        e
    })?;
    fs::create_dir_all(&app_dir).map_err(|e| {
        log::error!(
            "init_db: could not create app-data dir {}: {e} (kind: {:?})",
            app_dir.display(),
            e.kind()
        );
        e
    })?;

    let db_path = app_dir.join("interviewlab.db");
    log::info!("init_db: opening SQLite at {}", db_path.display());

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        // Wait up to 5s for a held write lock instead of failing instantly with SQLITE_BUSY —
        // WAL still serializes writers, and our long synthesis/transcript writes can overlap UI reads.
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        // Bounded pool: a handful of connections is plenty for a single-user desktop app, and the
        // cap keeps concurrent writers queued (vs. piling onto the SQLITE_BUSY path) for one SQLite file.
        .max_connections(5)
        .connect_with(options)
        .await
        .map_err(|e| {
            log::error!(
                "init_db: failed to open the SQLite pool at {} (WAL, foreign_keys on): {e}",
                db_path.display()
            );
            e
        })?;

    // Runs every .sql in ./migrations (relative to this crate) once each, tracked in _sqlx_migrations.
    sqlx::migrate!("./migrations").run(&pool).await.map_err(|e| {
        log::error!(
            "init_db: database migrations failed against {} — the schema may be partially \
             applied or corrupt: {e}",
            db_path.display()
        );
        e
    })?;

    log::info!("init_db: database ready at {}", db_path.display());
    Ok(Db {
        pool,
        path: db_path.to_string_lossy().into_owned(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the global logger as the VERY FIRST thing, before any fallible work, so
    // every error from here on is captured (to stderr immediately; to the log file once
    // `attach_file` runs a few lines below).
    logging::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Point the file sink at the OS app-log dir (e.g. %APPDATA%/com.interviewlab.app/logs
            // on Windows, ~/Library/Logs/… on macOS). Best-effort — a failure here only means we
            // log to stderr only; it must not block launch.
            match handle.path().app_log_dir() {
                Ok(dir) => {
                    if let Err(e) = logging::attach_file(&dir) {
                        log::warn!("could not attach the log file (stderr logging only): {e}");
                    }
                }
                Err(e) => log::warn!("could not resolve app_log_dir (stderr logging only): {e}"),
            }

            // block_on the async db init so the pool is in state before any command runs.
            let db = tauri::async_runtime::block_on(init_db(&handle)).unwrap_or_else(|e| {
                // This is genuinely fatal (no DB = no app). We've already logged the precise
                // failing step inside init_db; log the fatal verdict too, then panic.
                log::error!("[E-DB-INIT] FATAL: database initialization failed, aborting launch: {e}");
                panic!("failed to initialize database: {e}");
            });
            // Startup recovery (bug #1): reset any interview left in a mid-flight status
            // (transcribing / cleaning) by a crash or force-kill — no task is running for it,
            // so it's a zombie. Best-effort: a failure here must not block launch.
            match tauri::async_runtime::block_on(asr::recover_stuck_interviews(&db.pool)) {
                Ok(n) if n > 0 => {
                    log::warn!("startup recovery: reset {n} stuck interview(s) (transcribing/cleaning → error)")
                }
                Ok(_) => log::debug!("startup recovery: no stuck interviews to reset"),
                Err(e) => log::error!(
                    "startup recovery failed (non-fatal — zombie interviews may remain mid-flight): {e}"
                ),
            }
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_health,
            log_file_path,
            cycle::list_cycles,
            cycle::get_cycle,
            cycle::create_cycle,
            cycle::update_cycle,
            cycle::delete_cycle,
            interview::add_interview_files,
            interview::list_interviews,
            interview::rename_interview,
            interview::delete_interview,
            asr::asr_device,
            asr::list_models,
            asr::download_model,
            asr::transcribe_interview,
            asr::cancel_transcription,
            asr::get_transcript,
            asr::diarization_models_present,
            asr::download_diarization_models,
            asr::rediarize_interview,
            asr::retranscribe_range,
            asr::resume_transcription,
            asr::get_transcribe_checkpoint,
            transcript::list_transcript_versions,
            transcript::get_transcript_version,
            transcript::list_participants,
            transcript::save_participants,
            transcript::save_edited_transcript,
            transcript::import_transcript_file,
            adapter::list_adapters,
            adapter::rescan_plugins,
            adapter::get_active_adapter,
            adapter::set_active_adapter,
            adapter::get_task_model,
            adapter::set_task_model,
            adapter::test_cli,
            adapter::run_task,
            adapter::adapter_meta_instructions,
            adapter::plugin_manifest_schema,
            adapter::save_plugin_manifest,
            adapter::delete_plugin,
            cleanup::clean_transcript,
            cleanup::rewrite_segment,
            synthesis::get_synthesis,
            synthesis::cycle_goals,
            synthesis::run_synthesis,
            synthesis::save_cycle_synthesis,
            synthesis::get_interview_summary,
            synthesis::run_interview_summary,
            synthesis::save_interview_summary,
            diff::get_diff,
            diff::diff_status,
            diff::run_diff,
            roles::list_roles,
            roles::create_role,
            roles::update_role,
            roles::delete_role,
            guides::list_guides,
            guides::get_guide,
            guides::create_guide,
            guides::update_guide,
            guides::delete_guide,
            product::list_products,
            product::get_product,
            product::create_product,
            product::update_product,
            product::delete_product,
            glossary::list_glossary_terms,
            glossary::create_glossary_term,
            glossary::update_glossary_term,
            glossary::delete_glossary_term,
            glossary::add_glossary_terms,
            glossary::suggest_glossary_terms,
            glossary::suggest_glossary_terms_from_edits,
            chat::list_chat_threads,
            chat::create_chat_thread,
            chat::rename_chat_thread,
            chat::delete_chat_thread,
            chat::get_chat_messages,
            chat::cycle_chat_append,
            chat::cycle_chat_send,
            chat::cycle_chat_cancel,
            coverage::run_guide_coverage,
            coverage::get_guide_coverage,
            guides::generate_guide_draft,
            chat::list_chat_tool_calls,
            chat::undo_chat_action,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
