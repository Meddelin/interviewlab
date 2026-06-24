// Transcript editor backend (Milestone 5, spec §4.3 / §4.5 / §9 M5).
//
// Conventions mirror cycle.rs / interview.rs / asr.rs exactly: typed structs map the
// `transcript` + `participant` tables (migrations/0001_init.sql) 1:1, all SQL is
// parameterized, and each #[tauri::command] is a thin wrapper over a pool-taking
// helper (`*_db`) so the row logic is unit-testable against a real sqlx SQLite pool.
//
// What M5 owns:
//   - read a transcript *version* for an interview (raw | cleaned | edited) + the list
//     of versions that exist (drives the editor's version Select),
//   - list / replace `participant` rows (name + role + speaker_label mapping),
//   - SAVE: persist the edited segments as a new `edited` transcript version AND the
//     participants, then flip interview.status to 'edited'.
//
// Hard invariant (spec §4.5 / §6.7): the editor only ever rewrites a segment's `text`
// and `speaker_label`. start_ms / end_ms are immutable — media sync depends on it. The
// save path does NOT trust the client here: it re-reads the source version's timing and
// re-stamps each saved segment's start/end from it (matched by index), so a buggy or
// malicious frontend can never shift a timestamp. Covered by the timing-immutable test.

use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::Db;

// Interview status M5 writes once an edited version is saved (schema §2.2 vocab).
const STATUS_EDITED: &str = "edited";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- segment shape (schema §2.2: [{start_ms,end_ms,speaker_label,text}, ...]) -----
//
// Same shape asr.rs writes. speaker_label is the per-segment speaker tag the editor
// (re)assigns; participants bind a label → role for colored chips (spec §4.5).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker_label: String,
    pub text: String,
}

// --- row structs (match the tables) -------------------------------------------

// A transcript version row + its parsed segments. We return parsed `segments` (not the
// raw json string) so the frontend doesn't re-parse; the editor edits this directly.
#[derive(Serialize, Clone)]
pub struct TranscriptVersion {
    pub id: String,
    pub interview_id: String,
    pub version: i64,
    pub kind: String, // 'raw' | 'cleaned' | 'edited'
    pub language: Option<String>,
    pub engine: Option<String>,
    pub segments: Vec<Segment>,
    pub created_at: i64,
}

// Lightweight descriptor of an available version (no segments) for the version Select.
#[derive(Serialize, FromRow, Clone)]
pub struct VersionInfo {
    pub kind: String,
    pub version: i64,
    pub created_at: i64,
}

// A participant row — fields match the `participant` table 1:1. speaker_label is
// nullable until the user binds this participant to a transcript speaker tag.
//
// M10a: `role_id` (FK → role.id) is the canonical role binding from the role library;
// `role` keeps the human-readable role NAME (also what M8's synthesis reads as the speaker
// role label). Both are persisted together so the library and back-compat stay in sync.
#[derive(Serialize, FromRow, Deserialize, Clone, Debug)]
pub struct Participant {
    pub id: String,
    pub interview_id: String,
    pub display_name: String,
    pub role: String,             // role NAME (back-compat + M8 synthesis label)
    pub role_id: Option<String>,  // FK → role.id (the library binding)
    pub speaker_label: Option<String>,
}

// Input for replacing the participant set (the editor owns the whole list). id is
// optional: client-generated ids round-trip, but a missing id gets a fresh uuid.
// `role_id` is the library role; `role` (name) is derived server-side from it for M8.
#[derive(Deserialize, Clone)]
pub struct ParticipantInput {
    pub id: Option<String>,
    pub display_name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub role_id: Option<String>,
    pub speaker_label: Option<String>,
}

// Input for the Save action: the edited segments + the participant set, saved together.
#[derive(Deserialize)]
pub struct SaveEditedInput {
    pub interview_id: String,
    pub segments: Vec<Segment>,
    pub participants: Vec<ParticipantInput>,
    pub language: Option<String>,
}

// --- transcript version helpers ------------------------------------------------

// Internal: one transcript row as stored (json string, pre-parse).
#[derive(FromRow)]
struct TranscriptRowRaw {
    id: String,
    interview_id: String,
    version: i64,
    kind: String,
    language: Option<String>,
    engine: Option<String>,
    segments_json: String,
    created_at: i64,
}

fn parse_version(row: TranscriptRowRaw) -> Result<TranscriptVersion, String> {
    let segments: Vec<Segment> = serde_json::from_str(&row.segments_json)
        .map_err(|e| format!("parse segments_json: {e}"))?;
    Ok(TranscriptVersion {
        id: row.id,
        interview_id: row.interview_id,
        version: row.version,
        kind: row.kind,
        language: row.language,
        engine: row.engine,
        segments,
        created_at: row.created_at,
    })
}

// List which versions exist for an interview (one row per kind, latest version of each).
// Drives the editor's raw / cleaned / edited Select — kinds that don't exist are hidden.
async fn list_versions_db(pool: &SqlitePool, interview_id: &str) -> Result<Vec<VersionInfo>, sqlx::Error> {
    // One transcript row per (interview, version); kinds are distinct per the asr/clean/
    // edit flows. Order so 'raw' < 'cleaned' < 'edited' reads naturally in the Select.
    sqlx::query_as::<_, VersionInfo>(
        "SELECT kind, version, created_at FROM transcript \
         WHERE interview_id = ? \
         ORDER BY CASE kind WHEN 'raw' THEN 0 WHEN 'cleaned' THEN 1 WHEN 'edited' THEN 2 ELSE 3 END, version",
    )
    .bind(interview_id)
    .fetch_all(pool)
    .await
}

// Fetch a specific kind's transcript (the latest version of that kind if several).
async fn get_version_db(pool: &SqlitePool, interview_id: &str, kind: &str) -> Result<Option<TranscriptVersion>, String> {
    let row = sqlx::query_as::<_, TranscriptRowRaw>(
        "SELECT id, interview_id, version, kind, language, engine, segments_json, created_at \
         FROM transcript WHERE interview_id = ? AND kind = ? \
         ORDER BY version DESC LIMIT 1",
    )
    .bind(interview_id)
    .bind(kind)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some(r) => Ok(Some(parse_version(r)?)),
        None => Ok(None),
    }
}

// The "best" version timing source for the immutability re-stamp: prefer an existing
// 'edited', else 'cleaned', else 'raw'. Returns just the timing pairs (start,end) in
// segment order. None if the interview has no transcript at all.
async fn timing_source_db(pool: &SqlitePool, interview_id: &str) -> Result<Option<Vec<(i64, i64)>>, String> {
    for kind in ["edited", "cleaned", "raw"] {
        if let Some(v) = get_version_db(pool, interview_id, kind).await? {
            return Ok(Some(v.segments.iter().map(|s| (s.start_ms, s.end_ms)).collect()));
        }
    }
    Ok(None)
}

// The next free transcript version number for an interview (UNIQUE(interview,version)).
async fn next_version_db(pool: &SqlitePool, interview_id: &str) -> Result<i64, sqlx::Error> {
    let max: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM transcript WHERE interview_id = ?")
        .bind(interview_id)
        .fetch_one(pool)
        .await?;
    Ok(max.unwrap_or(0) + 1)
}

// Persist the edited segments as the interview's 'edited' transcript. Re-save overwrites
// the existing 'edited' row (so repeated saves don't pile up versions) by reusing its
// version number; first save takes the next free version. Returns the saved version's id.
async fn save_edited_version_db(
    pool: &SqlitePool,
    interview_id: &str,
    language: Option<&str>,
    segments: &[Segment],
) -> Result<String, String> {
    let segments_json = serde_json::to_string(segments).map_err(|e| format!("serialize segments: {e}"))?;

    // Reuse the existing edited row's version if present (idempotent re-save), else next free.
    let existing: Option<(String, i64)> = sqlx::query_as(
        "SELECT id, version FROM transcript WHERE interview_id = ? AND kind = 'edited' ORDER BY version DESC LIMIT 1",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some((id, version)) = existing {
        sqlx::query("UPDATE transcript SET segments_json = ?, language = ?, created_at = ?, version = ? WHERE id = ?")
            .bind(&segments_json)
            .bind(language)
            .bind(now_ms())
            .bind(version)
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        let version = next_version_db(pool, interview_id).await.map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO transcript (id, interview_id, version, kind, language, engine, segments_json, created_at) \
             VALUES (?, ?, ?, 'edited', ?, 'editor', ?, ?)",
        )
        .bind(&id)
        .bind(interview_id)
        .bind(version)
        .bind(language)
        .bind(&segments_json)
        .bind(now_ms())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(id)
    }
}

async fn set_status_db(pool: &SqlitePool, interview_id: &str, status: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE interview SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(now_ms())
        .bind(interview_id)
        .execute(pool)
        .await?;
    Ok(())
}

// --- participant helpers -------------------------------------------------------

async fn list_participants_db(pool: &SqlitePool, interview_id: &str) -> Result<Vec<Participant>, sqlx::Error> {
    sqlx::query_as::<_, Participant>(
        "SELECT id, interview_id, display_name, role, role_id, speaker_label \
         FROM participant WHERE interview_id = ? ORDER BY rowid",
    )
    .bind(interview_id)
    .fetch_all(pool)
    .await
}

// Replace the whole participant set for an interview in one transaction (the editor owns
// the list — add/remove/edit all flow through here). Returns the persisted rows.
async fn save_participants_db(
    pool: &SqlitePool,
    interview_id: &str,
    participants: &[ParticipantInput],
) -> Result<Vec<Participant>, String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM participant WHERE interview_id = ?")
        .bind(interview_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    for p in participants {
        let id = p.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
        // Normalize an empty speaker_label / role_id to NULL.
        let label = p.speaker_label.as_deref().filter(|s| !s.is_empty());
        let role_id = p.role_id.as_deref().filter(|s| !s.is_empty());

        // Derive the role NAME (the text `role` column M8 reads) from the library role when
        // a role_id is given; fall back to the client-sent `role` string otherwise. This
        // keeps the back-compat text column accurate as the speaker-role label for synthesis.
        let role_name = match role_id {
            Some(rid) => {
                let name: Option<String> = sqlx::query_scalar("SELECT name FROM role WHERE id = ?")
                    .bind(rid)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                name.unwrap_or_else(|| p.role.clone())
            }
            None => p.role.clone(),
        };

        sqlx::query(
            "INSERT INTO participant (id, interview_id, display_name, role, role_id, speaker_label) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(interview_id)
        .bind(&p.display_name)
        .bind(&role_name)
        .bind(role_id)
        .bind(label)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;
    list_participants_db(pool, interview_id).await.map_err(|e| e.to_string())
}

// --- the combined Save (segments + participants + status), timing-immutable -----

// Save the edited transcript: re-stamp each segment's timing from the stored source
// version (enforcing the spec's timing-immutable invariant regardless of what the
// client sent), persist as the 'edited' version, save participants, set status 'edited'.
async fn save_edited_db(pool: &SqlitePool, input: &SaveEditedInput) -> Result<TranscriptVersion, String> {
    // Authoritative timing comes from the stored source, matched by index. The client's
    // start/end are ignored — only text + speaker_label are user-editable (spec §4.5).
    let source_timing = timing_source_db(pool, &input.interview_id).await?;

    let mut segments = input.segments.clone();
    if let Some(timing) = &source_timing {
        for (i, seg) in segments.iter_mut().enumerate() {
            if let Some((start, end)) = timing.get(i) {
                seg.start_ms = *start;
                seg.end_ms = *end;
            }
            // Defensive: a segment that somehow has end < start gets clamped (never widens timing).
            if seg.end_ms < seg.start_ms {
                seg.end_ms = seg.start_ms;
            }
        }
    }

    let id = save_edited_version_db(pool, &input.interview_id, input.language.as_deref(), &segments).await?;
    save_participants_db(pool, &input.interview_id, &input.participants).await?;
    set_status_db(pool, &input.interview_id, STATUS_EDITED)
        .await
        .map_err(|e| format!("set status edited: {e}"))?;

    // Return the freshly-stored edited version so the client adopts the canonical timing.
    get_version_db(pool, &input.interview_id, "edited")
        .await?
        .ok_or_else(|| "edited version vanished after save".to_string())
        .map(|mut v| {
            v.id = id; // ensure the id matches the row we wrote
            v
        })
}

// --- Tauri commands (thin wrappers; stringify errors for the frontend) ---------

// List which transcript versions exist for an interview (for the version Select).
#[tauri::command]
pub async fn list_transcript_versions(db: tauri::State<'_, Db>, interview_id: String) -> Result<Vec<VersionInfo>, String> {
    list_versions_db(&db.pool, &interview_id).await.map_err(|e| e.to_string())
}

// Get one transcript version (raw | cleaned | edited) with parsed segments.
#[tauri::command]
pub async fn get_transcript_version(
    db: tauri::State<'_, Db>,
    interview_id: String,
    kind: String,
) -> Result<Option<TranscriptVersion>, String> {
    get_version_db(&db.pool, &interview_id, &kind).await
}

#[tauri::command]
pub async fn list_participants(db: tauri::State<'_, Db>, interview_id: String) -> Result<Vec<Participant>, String> {
    list_participants_db(&db.pool, &interview_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_participants(
    db: tauri::State<'_, Db>,
    interview_id: String,
    participants: Vec<ParticipantInput>,
) -> Result<Vec<Participant>, String> {
    save_participants_db(&db.pool, &interview_id, &participants).await
}

// Save the edited transcript + participants atomically-ish (per-step), returns the
// persisted edited version (with canonical, timing-immutable segments).
#[tauri::command]
pub async fn save_edited_transcript(db: tauri::State<'_, Db>, input: SaveEditedInput) -> Result<TranscriptVersion, String> {
    save_edited_db(&db.pool, &input).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // Make a cycle + interview and seed a raw transcript; returns the interview id.
    async fn seed_interview_with_raw(pool: &SqlitePool, raw: &[Segment]) -> String {
        let cycle_id = Uuid::new_v4().to_string();
        let iv = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)")
            .bind(&cycle_id).bind(ts).bind(ts).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'iv', 'transcribed', ?, ?)")
            .bind(&iv).bind(&cycle_id).bind(ts).bind(ts).execute(pool).await.unwrap();
        let json = serde_json::to_string(raw).unwrap();
        sqlx::query("INSERT INTO transcript (id, interview_id, version, kind, language, engine, segments_json, created_at) VALUES (?, ?, 1, 'raw', 'en', 'whisper.cpp:base@cpu', ?, ?)")
            .bind(Uuid::new_v4().to_string()).bind(&iv).bind(&json).bind(ts).execute(pool).await.unwrap();
        iv
    }

    fn sample_raw() -> Vec<Segment> {
        vec![
            Segment { start_ms: 0, end_ms: 4200, speaker_label: "S1".into(), text: "ну вот эээ я обычно захожу и смотрю заказы".into() },
            Segment { start_ms: 4200, end_ms: 8800, speaker_label: "S1".into(), text: "и потом значит проверяю аналитику".into() },
            Segment { start_ms: 8800, end_ms: 13100, speaker_label: "S1".into(), text: "но воронку я так и не настроил".into() },
        ]
    }

    // get_transcript_version returns the raw segments; list_versions shows just 'raw'.
    #[tokio::test]
    async fn read_raw_version_and_list() {
        let pool = test_pool().await;
        let iv = seed_interview_with_raw(&pool, &sample_raw()).await;

        let versions = list_versions_db(&pool, &iv).await.unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].kind, "raw");

        let raw = get_version_db(&pool, &iv, "raw").await.unwrap().expect("raw exists");
        assert_eq!(raw.segments.len(), 3);
        assert_eq!(raw.segments[0].text, "ну вот эээ я обычно захожу и смотрю заказы");
        assert!(get_version_db(&pool, &iv, "edited").await.unwrap().is_none());
    }

    // The M5 verify path: edit text + assign speaker roles + Save → reload shows the
    // persisted edited text & participant assignments, and segment TIMING is unchanged.
    #[tokio::test]
    async fn save_edited_reload_persists_and_timing_immutable() {
        let pool = test_pool().await;
        let raw = sample_raw();
        let iv = seed_interview_with_raw(&pool, &raw).await;

        // Edit text + reassign speaker labels; deliberately send WRONG timing to prove
        // the backend ignores it and re-stamps from the stored raw version.
        let edited_segments = vec![
            Segment { start_ms: 999999, end_ms: 999999, speaker_label: "interviewer".into(), text: "Я обычно захожу и смотрю заказы.".into() },
            Segment { start_ms: -5, end_ms: -5, speaker_label: "respondent".into(), text: "И потом проверяю аналитику.".into() },
            Segment { start_ms: 1, end_ms: 0, speaker_label: "respondent".into(), text: "Но воронку я так и не настроил.".into() },
        ];
        let participants = vec![
            ParticipantInput { id: None, display_name: "Researcher".into(), role: "interviewer".into(), role_id: Some("interviewer".into()), speaker_label: Some("interviewer".into()) },
            ParticipantInput { id: None, display_name: "P01 Founder".into(), role: "respondent".into(), role_id: Some("respondent".into()), speaker_label: Some("respondent".into()) },
        ];

        let saved = save_edited_db(&pool, &SaveEditedInput {
            interview_id: iv.clone(),
            segments: edited_segments,
            participants,
            language: Some("ru".into()),
        }).await.unwrap();

        // Returned version is 'edited', carries the corrected timing (not the bogus client values).
        assert_eq!(saved.kind, "edited");
        assert_eq!(saved.segments.len(), 3);
        assert_eq!(saved.segments[0].text, "Я обычно захожу и смотрю заказы.");

        // Reload from DB and assert persistence + timing-immutability against the raw.
        let reloaded = get_version_db(&pool, &iv, "edited").await.unwrap().expect("edited exists");
        assert_eq!(reloaded.segments.len(), raw.len());
        for (i, seg) in reloaded.segments.iter().enumerate() {
            // Timing matches the ORIGINAL raw exactly — never the client's bogus values.
            assert_eq!(seg.start_ms, raw[i].start_ms, "start_ms must be immutable (seg {i})");
            assert_eq!(seg.end_ms, raw[i].end_ms, "end_ms must be immutable (seg {i})");
        }
        // Text + speaker_label reflect the edit.
        assert_eq!(reloaded.segments[0].text, "Я обычно захожу и смотрю заказы.");
        assert_eq!(reloaded.segments[0].speaker_label, "interviewer");
        assert_eq!(reloaded.segments[1].speaker_label, "respondent");

        // Participants persisted with their role + speaker_label binding. M10a: role_id
        // is the canonical library binding; the text `role` becomes the role NAME.
        let ps = list_participants_db(&pool, &iv).await.unwrap();
        assert_eq!(ps.len(), 2);
        assert_eq!(ps[0].role_id.as_deref(), Some("interviewer"));
        assert_eq!(ps[0].role, "Interviewer"); // resolved name from the seeded role
        assert_eq!(ps[0].speaker_label.as_deref(), Some("interviewer"));
        assert_eq!(ps[1].display_name, "P01 Founder");

        // Interview status flipped to 'edited'.
        let status: String = sqlx::query_scalar("SELECT status FROM interview WHERE id = ?")
            .bind(&iv).fetch_one(&pool).await.unwrap();
        assert_eq!(status, "edited");

        // The raw version is untouched (the editor never mutates earlier versions).
        let still_raw = get_version_db(&pool, &iv, "raw").await.unwrap().unwrap();
        assert_eq!(still_raw.segments, raw);
    }

    // Re-saving overwrites the same 'edited' row rather than piling up versions.
    #[tokio::test]
    async fn re_save_overwrites_edited_version() {
        let pool = test_pool().await;
        let raw = sample_raw();
        let iv = seed_interview_with_raw(&pool, &raw).await;

        let mk = |text: &str| SaveEditedInput {
            interview_id: iv.clone(),
            segments: raw.iter().enumerate().map(|(i, s)| Segment {
                start_ms: s.start_ms, end_ms: s.end_ms, speaker_label: "respondent".into(),
                text: if i == 0 { text.to_string() } else { s.text.clone() },
            }).collect(),
            participants: vec![],
            language: Some("ru".into()),
        };

        save_edited_db(&pool, &mk("first edit")).await.unwrap();
        save_edited_db(&pool, &mk("second edit")).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcript WHERE interview_id = ? AND kind = 'edited'")
            .bind(&iv).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1, "edited version is overwritten, not duplicated");
        let edited = get_version_db(&pool, &iv, "edited").await.unwrap().unwrap();
        assert_eq!(edited.segments[0].text, "second edit");
    }

    // Live-DB end-to-end M5 verify (the brief's runtime check). #[ignore]d so the normal
    // suite stays offline/fast. Opens the REAL app database at
    // %APPDATA%/com.interviewlab.app/interviewlab.db, creates a temp cycle + interview
    // with a raw transcript, then runs the exact production save path
    // (save_edited_db with deliberately-wrong client timing) and asserts on reload:
    //   - edited text + speaker_label persisted,
    //   - participant role assignments persisted,
    //   - segment TIMING equals the original raw (immutable),
    //   - interview.status flipped to 'edited',
    // then deletes the temp cycle (cascades interview + transcript + participant).
    // Run: cargo test live_m5_editor_verify -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_m5_editor_verify() {
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let db_path = app_dir.join("interviewlab.db");
        assert!(db_path.exists(), "live DB not found at {db_path:?} — run the app once first");

        // Mirror init_db's options (create_if_missing + WAL) so opening works even with
        // WAL sidecars present.
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = sqlx::sqlite::SqlitePool::connect_with(opts).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        // Temp cycle + interview + raw transcript so we don't disturb the user's data.
        let cycle_id = Uuid::new_v4().to_string();
        let iv = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, '__M5_VERIFY__', ?, ?)")
            .bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'm5', 'transcribed', ?, ?)")
            .bind(&iv).bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let raw = sample_raw();
        let raw_json = serde_json::to_string(&raw).unwrap();
        sqlx::query("INSERT INTO transcript (id, interview_id, version, kind, language, engine, segments_json, created_at) VALUES (?, ?, 1, 'raw', 'ru', 'whisper.cpp:large-v3@cuda', ?, ?)")
            .bind(Uuid::new_v4().to_string()).bind(&iv).bind(&raw_json).bind(ts).execute(&pool).await.unwrap();

        // Edit text + assign roles, with bogus client timing to prove immutability.
        let edited = vec![
            Segment { start_ms: 7, end_ms: 7, speaker_label: "interviewer".into(), text: "Отредактированный первый сегмент.".into() },
            Segment { start_ms: 7, end_ms: 7, speaker_label: "respondent".into(), text: "Отредактированный второй сегмент.".into() },
            Segment { start_ms: 7, end_ms: 7, speaker_label: "respondent".into(), text: "Отредактированный третий сегмент.".into() },
        ];
        save_edited_db(&pool, &SaveEditedInput {
            interview_id: iv.clone(),
            segments: edited,
            participants: vec![
                ParticipantInput { id: None, display_name: "Researcher".into(), role: "interviewer".into(), role_id: Some("interviewer".into()), speaker_label: Some("interviewer".into()) },
                ParticipantInput { id: None, display_name: "P01".into(), role: "respondent".into(), role_id: Some("respondent".into()), speaker_label: Some("respondent".into()) },
            ],
            language: Some("ru".into()),
        }).await.unwrap();

        // Reload and assert.
        let reloaded = get_version_db(&pool, &iv, "edited").await.unwrap().expect("edited persisted");
        assert_eq!(reloaded.segments.len(), raw.len());
        for (i, seg) in reloaded.segments.iter().enumerate() {
            assert_eq!(seg.start_ms, raw[i].start_ms, "start_ms immutable (seg {i})");
            assert_eq!(seg.end_ms, raw[i].end_ms, "end_ms immutable (seg {i})");
        }
        assert_eq!(reloaded.segments[0].text, "Отредактированный первый сегмент.");
        assert_eq!(reloaded.segments[0].speaker_label, "interviewer");
        let ps = list_participants_db(&pool, &iv).await.unwrap();
        assert_eq!(ps.len(), 2);
        assert_eq!(ps[0].role_id.as_deref(), Some("interviewer"));
        let status: String = sqlx::query_scalar("SELECT status FROM interview WHERE id = ?")
            .bind(&iv).fetch_one(&pool).await.unwrap();
        assert_eq!(status, "edited");
        println!("M5 live verify OK: edited text+roles persisted, timing immutable, status=edited.");

        // Cleanup (cascades interview + transcript + participant).
        sqlx::query("DELETE FROM cycle WHERE id = ?").bind(&cycle_id).execute(&pool).await.unwrap();
        // Sanity: rows gone.
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcript WHERE interview_id = ?")
            .bind(&iv).fetch_one(&pool).await.unwrap();
        assert_eq!(left, 0, "cleanup left transcript rows");
        println!("M5 live verify cleaned up.");
    }

    // save_participants replaces the set (add → remove → edit all go through it).
    #[tokio::test]
    async fn save_participants_replaces_set() {
        let pool = test_pool().await;
        let iv = seed_interview_with_raw(&pool, &sample_raw()).await;

        let first = save_participants_db(&pool, &iv, &[
            ParticipantInput { id: None, display_name: "A".into(), role: "interviewer".into(), role_id: Some("interviewer".into()), speaker_label: Some("S1".into()) },
            ParticipantInput { id: None, display_name: "B".into(), role: "respondent".into(), role_id: Some("respondent".into()), speaker_label: None },
        ]).await.unwrap();
        assert_eq!(first.len(), 2);

        // Replace with a single participant — the previous two are gone.
        let second = save_participants_db(&pool, &iv, &[
            ParticipantInput { id: None, display_name: "Only".into(), role: "observer".into(), role_id: Some("observer".into()), speaker_label: Some("S2".into()) },
        ]).await.unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].display_name, "Only");
        assert_eq!(list_participants_db(&pool, &iv).await.unwrap().len(), 1);
    }
}
