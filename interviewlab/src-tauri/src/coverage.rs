// Guide-coverage analysis (v3 B1, docs/v3-roast-and-plan.md) — "did we ask everything?"
//
// The researcher's biggest fear after an interview is a silently missed guide item. This
// module maps EVERY guide goal + question of an interview's cycle to a coverage status
// (covered | partial | missed), each with evidence (segment indexes + short verbatim
// quotes), an overall 0-100 coverage score, and 2-4 suggested follow-up questions for the
// missed/partial items — one `guide-coverage` CLI task per interview through the adapter.
//
// Conventions mirror glossary.rs/synthesis.rs: typed serde structs, parameterized SQL,
// each #[tauri::command] a thin wrapper over a testable pool-taking `*_db` helper, the
// LLM call goes ONLY through adapter::run_cli_task_model, output shape validated +
// normalized by a PURE function (unit-tested without a CLI). Progress streams on the
// `coverage://progress` Tauri event so the global task center can show the run.
//
// Error code family: [E-COV-RUN] (CLI/parse failure), [E-COV-STORE] (persisting failed),
// [E-COV-NO-GUIDE] (nothing derivable to check against), [E-COV-NO-TRANSCRIPT].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::Emitter;

use crate::synthesis::{derive_goals, Goal, GuideQuestion};
use crate::transcript::Segment;
use crate::Db;

// Tauri event the task center / coverage panel subscribes to.
pub const COVERAGE_PROGRESS_EVENT: &str = "coverage://progress";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- types (the validated, stored coverage document) ---------------------------

// One evidence reference: the transcript segment index + a short verbatim quote proving
// the guide item was (at least partially) covered. Same segment-index convention as the
// synthesis Evidence quotes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CoverageEvidence {
    pub segment_id: usize,
    pub quote: String,
}

// One guide item's coverage verdict. `id`/`text`/`kind`/`section` come from the GUIDE
// (server-stamped, never trusted from the model); only status/evidence/note come from the
// LLM. kind = "goal" | "question"; section (questions only) = qualifying | main | hypothesis.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CoverageItem {
    pub id: String,
    pub text: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub section: String,
    pub status: String, // 'covered' | 'partial' | 'missed'
    #[serde(default)]
    pub evidence: Vec<CoverageEvidence>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

// A suggested follow-up question for a missed/partial item (`related_id` points at it).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CoverageFollowUp {
    #[serde(default)]
    pub related_id: String,
    pub question: String,
}

// The full validated coverage document stored in coverage.coverage_json.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CoverageDoc {
    pub items: Vec<CoverageItem>,
    pub score: i32, // 0..100
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub follow_ups: Vec<CoverageFollowUp>,
}

// A stored coverage row returned to the frontend.
#[derive(Serialize, Clone, Debug)]
pub struct CoverageRow {
    pub interview_id: String,
    pub doc: CoverageDoc,
    pub model_meta: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

// --- the RAW model output (lenient shapes; everything re-validated below) ------

#[derive(Deserialize, Default, Debug)]
struct RawCoverageOutput {
    #[serde(default)]
    items: Vec<RawCoverageItem>,
    #[serde(default)]
    score: Option<i64>,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    follow_ups: Vec<RawFollowUp>,
}

#[derive(Deserialize, Debug)]
struct RawCoverageItem {
    #[serde(default)]
    id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    evidence: Vec<RawEvidence>,
    #[serde(default)]
    note: String,
}

#[derive(Deserialize, Debug)]
struct RawEvidence {
    #[serde(default)]
    segment_id: i64,
    #[serde(default)]
    quote: String,
}

#[derive(Deserialize, Debug)]
struct RawFollowUp {
    #[serde(default)]
    related_id: String,
    #[serde(default)]
    question: String,
}

// --- pure normalization (unit-tested without a DB/CLI) -------------------------

// Caps keeping the stored doc lean even against a rambling model.
const MAX_EVIDENCE_PER_ITEM: usize = 4;
const MAX_FOLLOW_UPS: usize = 6;

fn normalize_status(s: &str) -> Option<&'static str> {
    match s.trim().to_lowercase().as_str() {
        "covered" => Some("covered"),
        "partial" | "partially" | "partially_covered" => Some("partial"),
        "missed" | "missing" | "not_covered" | "uncovered" => Some("missed"),
        _ => None,
    }
}

// Build the validated CoverageDoc from the guide's OWN item list (goals + questions, in
// guide order — the model can neither invent nor drop an item) and the raw model output.
// Unknown-id model items are dropped; a guide item the model skipped becomes "missed".
// Evidence segment ids are bounds-checked against the transcript; the score is the model's
// (clamped 0..100) or recomputed from the statuses when absent/invalid.
fn normalize_coverage(
    goals: &[Goal],
    questions: &[GuideQuestion],
    segment_count: usize,
    raw: RawCoverageOutput,
) -> CoverageDoc {
    let by_id: HashMap<String, &RawCoverageItem> = raw
        .items
        .iter()
        .map(|i| (i.id.trim().to_string(), i))
        .collect();

    let make_item = |id: &str, text: &str, kind: &str, section: &str| -> CoverageItem {
        let found = by_id.get(id);
        let status = found
            .and_then(|r| normalize_status(&r.status))
            .unwrap_or("missed")
            .to_string();
        let evidence: Vec<CoverageEvidence> = found
            .map(|r| {
                r.evidence
                    .iter()
                    .filter(|e| {
                        e.segment_id >= 0
                            && (e.segment_id as usize) < segment_count
                            && !e.quote.trim().is_empty()
                    })
                    .take(MAX_EVIDENCE_PER_ITEM)
                    .map(|e| CoverageEvidence {
                        segment_id: e.segment_id as usize,
                        quote: e.quote.trim().to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let note = found.map(|r| r.note.trim().to_string()).unwrap_or_default();
        CoverageItem {
            id: id.to_string(),
            text: text.to_string(),
            kind: kind.to_string(),
            section: section.to_string(),
            status,
            evidence,
            note,
        }
    };

    let mut items: Vec<CoverageItem> = Vec::new();
    for g in goals {
        items.push(make_item(&g.id, &g.text, "goal", ""));
    }
    for q in questions {
        items.push(make_item(&q.id, &q.text, "question", &q.section));
    }

    // Score: the model's, clamped; else recomputed (covered = 1, partial = 0.5).
    let score = match raw.score {
        Some(s) if (0..=100).contains(&s) => s as i32,
        Some(s) => s.clamp(0, 100) as i32,
        None => {
            if items.is_empty() {
                0
            } else {
                let pts: f32 = items
                    .iter()
                    .map(|i| match i.status.as_str() {
                        "covered" => 1.0,
                        "partial" => 0.5,
                        _ => 0.0,
                    })
                    .sum();
                ((pts / items.len() as f32) * 100.0).round() as i32
            }
        }
    };

    // Follow-ups: keep non-empty questions; a related_id that doesn't resolve to a guide
    // item is cleared (kept as a general suggestion) rather than dropped.
    let known: std::collections::HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
    let follow_ups: Vec<CoverageFollowUp> = raw
        .follow_ups
        .into_iter()
        .filter_map(|f| {
            let question = f.question.trim().to_string();
            if question.is_empty() {
                return None;
            }
            let related = f.related_id.trim().to_string();
            let related_id = if known.contains(related.as_str()) { related } else { String::new() };
            Some(CoverageFollowUp { related_id, question })
        })
        .take(MAX_FOLLOW_UPS)
        .collect();

    CoverageDoc {
        items,
        score,
        summary: raw.summary.trim().to_string(),
        follow_ups,
    }
}

// --- prompt / schema ------------------------------------------------------------

// UNIFIED LLM-STAGE RULES — kept byte-identical across cleanup.rs / diff.rs / coverage.rs so it
// can be trivially hoisted into ONE Rust constant later (roadmap §4 "общий мини-блок правил одной
// константой во все стадии"). Do NOT diverge the wording across these files. (glossary.rs carries
// the previous wording — owned by a parallel change; re-align it when hoisting.)
const UNIFIED_LLM_RULES: &str = "Unified rules for every LLM stage:\n\
    - Output language = the language of the interview (for Russian interviews — Russian; mirror \
    the interview's language otherwise); do NOT translate terms the speaker used.\n\
    - Own prose (findings, summaries, notes — never transcript text or quotes) must read as \
    natural, professional Russian, not translationese: no канцелярит («имеет место непонимание» → \
    «пользователи не понимают»); state conclusions as assertions, not as «было выявлено, что…».\n\
    - Anti-hallucination: never invent names/numbers/quotes; \"not established / no answer\" is \
    better than guessing.\n\
    - Terminology: in your own prose use the canonical spellings from the glossary; a Latin \
    original, its Cyrillic transliteration, and declined forms are the SAME term \
    (фича = feature, «в Слаке» = Slack). Quotes copied from the transcript stay verbatim.\n\
    - Artifact style: neutral analytical tone, no filler, one consistent format for quotes and \
    numbers, and NO markdown headings inside string fields of the JSON.";

// Coverage-task specifics: what counts as covered vs partial vs missed, and how to cite.
const COVERAGE_GUIDELINES: &str = "You audit ONE user interview against its research guide. \
    For EVERY guide item in `guide_items` (goals and questions), judge from the transcript \
    whether the interviewer actually explored it:\n\
    - covered: the topic was raised AND the respondent gave a substantive answer — directly or \
    indirectly while discussing something else (indirect answers count in full).\n\
    - partial: the topic was touched but the answer is shallow, one-sided, ambiguous, or cut \
    off — a follow-up would be needed. Also partial when the only \"answer\" is the respondent's \
    bare assent to a leading question.\n\
    - missed: the topic never came up (or only the interviewer mentioned it with no answer).\n\
    For covered/partial items cite 1-3 pieces of evidence: the segment index (`segment_id`, the \
    `id` field of the segment) + a SHORT verbatim quote (max ~200 chars) from that segment. \
    Never fabricate quotes; only quote text that appears in the transcript. Give an overall \
    0-100 `score` (weight goals over questions), a 1-2 sentence `summary`, and 2-4 suggested \
    `follow_ups` — concrete questions the researcher should ask next time (or in a follow-up) \
    to close the missed/partial items, each with the `related_id` of the item it targets. \
    Follow-up questions must be открытые, не наводящие, разговорные: exactly ONE idea per \
    question (no double-barreled «и…, и…»), anchored in real past experience — «Расскажите про \
    последний раз, когда…», «Как вы сейчас решаете…?» — never «Согласны ли вы, что…» / «Правда \
    ли, что…», and prefer «что/как/расскажите» over «почему». \
    Write follow-up questions, notes, and the summary in the interview's language — for Russian \
    interviews, natural conversational Russian.";

// The output JSON schema handed to the CLI (`--json-schema`) so the model returns clean
// structured_output. Ids echo the guide items; everything is re-validated server-side.
fn coverage_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["items", "score", "follow_ups"],
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id", "status"],
                    "properties": {
                        "id": { "type": "string" },
                        "status": { "type": "string", "enum": ["covered", "partial", "missed"] },
                        "evidence": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["segment_id", "quote"],
                                "properties": {
                                    "segment_id": { "type": "integer" },
                                    "quote": { "type": "string" }
                                }
                            }
                        },
                        "note": { "type": "string" }
                    }
                }
            },
            "score": { "type": "integer" },
            "summary": { "type": "string" },
            "follow_ups": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["question"],
                    "properties": {
                        "related_id": { "type": "string" },
                        "question": { "type": "string" }
                    }
                }
            }
        }
    })
}

// Build the task input: the guide items (the checklist), the role-labeled transcript, and
// the grounding context (product + glossary). Pure → unit-tested.
fn build_coverage_input(
    language: Option<&str>,
    product_desc: &str,
    glossary: &Value,
    guide_md: &str,
    goals: &[Goal],
    questions: &[GuideQuestion],
    segments: &[(usize, String, String)], // (id, speaker_role, text)
) -> Value {
    let guide_items: Vec<Value> = goals
        .iter()
        .map(|g| json!({ "id": g.id, "kind": "goal", "text": g.text }))
        .chain(questions.iter().map(|q| {
            let mut o = json!({ "id": q.id, "kind": "question", "text": q.text, "section": q.section });
            if !q.block.is_empty() {
                o["block"] = json!(q.block);
            }
            o
        }))
        .collect();
    let seg_values: Vec<Value> = segments
        .iter()
        .map(|(id, role, text)| json!({ "id": id, "speaker_role": role, "text": text }))
        .collect();
    let mut input = json!({
        "task": "guide-coverage",
        "language": language.unwrap_or("auto"),
        "rules": UNIFIED_LLM_RULES,
        "guidelines": COVERAGE_GUIDELINES,
        "guide_md": guide_md,
        "guide_items": guide_items,
        "segments": seg_values,
    });
    if !product_desc.trim().is_empty() {
        input["product_desc"] = json!(product_desc.trim());
    }
    if glossary.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        input["glossary"] = glossary.clone();
    }
    input
}

// The task to run. Prefer the dedicated `guide-coverage` task; fall back to the extract
// task for a plugin manifest that predates it (a user's on-disk claude-code manifest.json
// written before v3 OVERRIDES the bundled one, so the fallback keeps coverage working —
// same pattern as glossary::extract_task_name).
fn coverage_task_name(adapter: &crate::adapter::Adapter) -> &'static str {
    if adapter.tasks.contains_key("guide-coverage") {
        "guide-coverage"
    } else {
        "cycle-synthesis-extract"
    }
}

// --- DB helpers (pool-taking; unit-tested) --------------------------------------

// Upsert the coverage doc for an interview (PK = interview_id → re-run overwrites).
async fn store_coverage_db(
    pool: &SqlitePool,
    interview_id: &str,
    doc: &CoverageDoc,
    model_meta: &str,
) -> Result<(), String> {
    let coverage_json = serde_json::to_string(doc).map_err(|e| format!("serialize coverage: {e}"))?;
    let ts = now_ms();
    sqlx::query(
        "INSERT INTO coverage (interview_id, coverage_json, model_meta, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(interview_id) DO UPDATE SET \
           coverage_json = excluded.coverage_json, \
           model_meta = excluded.model_meta, \
           updated_at = excluded.updated_at",
    )
    .bind(interview_id)
    .bind(&coverage_json)
    .bind(model_meta)
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn get_coverage_db(pool: &SqlitePool, interview_id: &str) -> Result<Option<CoverageRow>, String> {
    let row: Option<(String, Option<String>, i64, i64)> = sqlx::query_as(
        "SELECT coverage_json, model_meta, created_at, updated_at FROM coverage WHERE interview_id = ?",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((coverage_json, model_meta, created_at, updated_at)) => {
            let doc: CoverageDoc = serde_json::from_str(&coverage_json)
                .map_err(|e| format!("parse stored coverage: {e}"))?;
            Ok(Some(CoverageRow {
                interview_id: interview_id.to_string(),
                doc,
                model_meta,
                created_at,
                updated_at,
            }))
        }
        None => Ok(None),
    }
}

// Latest transcript version for an interview, preferring edited > cleaned > raw (the same
// preference synthesis/glossary apply). Returns (language, segments) or None.
async fn best_transcript_db(
    pool: &SqlitePool,
    interview_id: &str,
) -> Result<Option<(Option<String>, Vec<Segment>)>, String> {
    for kind in ["edited", "cleaned", "raw"] {
        let row: Option<(Option<String>, String)> = sqlx::query_as(
            "SELECT language, segments_json FROM transcript WHERE interview_id = ? AND kind = ? \
             ORDER BY version DESC LIMIT 1",
        )
        .bind(interview_id)
        .bind(kind)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if let Some((language, json)) = row {
            let segments: Vec<Segment> =
                serde_json::from_str(&json).map_err(|e| format!("parse {kind} segments: {e}"))?;
            return Ok(Some((language, segments)));
        }
    }
    Ok(None)
}

// speaker_label → role for an interview (same join synthesis uses; unmapped → "unknown").
async fn role_map_db(pool: &SqlitePool, interview_id: &str) -> Result<HashMap<String, String>, String> {
    let rows: Vec<(Option<String>, String)> =
        sqlx::query_as("SELECT speaker_label, role FROM participant WHERE interview_id = ?")
            .bind(interview_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    let mut map = HashMap::new();
    for (label, role) in rows {
        if let Some(label) = label.filter(|s| !s.is_empty()) {
            map.insert(label, role);
        }
    }
    Ok(map)
}

// --- progress event --------------------------------------------------------------

#[derive(Serialize, Clone)]
struct CoverageProgress {
    interview_id: String,
    stage: String, // 'started' | 'running' | 'done' | 'error'
    progress: i32, // 0..100
    error: Option<String>,
}

fn emit_coverage(app: &tauri::AppHandle, interview_id: &str, stage: &str, progress: i32, error: Option<String>) {
    let _ = app.emit(
        COVERAGE_PROGRESS_EVENT,
        CoverageProgress {
            interview_id: interview_id.to_string(),
            stage: stage.to_string(),
            progress,
            error,
        },
    );
}

// --- Tauri commands ---------------------------------------------------------------

// Get the stored coverage doc for an interview (None before the first run).
#[tauri::command]
pub async fn get_guide_coverage(
    db: tauri::State<'_, Db>,
    interview_id: String,
) -> Result<Option<CoverageRow>, String> {
    get_coverage_db(&db.pool, &interview_id).await
}

// Run (or re-run) the guide-coverage analysis for ONE interview: load its best transcript
// (edited > cleaned > raw), the cycle's guide (goals + questions), product context and
// glossary; one `guide-coverage` CLI call; validate + store. Emits progress on
// `coverage://progress` (started/running/done/error) for the global task center.
#[tauri::command]
pub async fn run_guide_coverage(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    interview_id: String,
    adapter_id: Option<String>,
) -> Result<CoverageRow, String> {
    log::info!(target: "interviewlab::coverage", "run_guide_coverage: starting interview='{interview_id}' (adapter override: {adapter_id:?})");
    emit_coverage(&app, &interview_id, "started", 5, None);

    // A tiny closure so every early-out both logs the coded error and emits the event.
    let fail = |code: &str, msg: String| -> String {
        log::error!(target: "interviewlab::coverage", "[{code}] run_guide_coverage: interview='{interview_id}': {msg}");
        emit_coverage(&app, &interview_id, "error", 0, Some(msg.clone()));
        msg
    };

    // Interview → cycle.
    let cycle_id: Option<String> = sqlx::query_scalar("SELECT cycle_id FROM interview WHERE id = ?")
        .bind(&interview_id)
        .fetch_optional(&db.pool)
        .await
        .map_err(|e| fail("E-COV-RUN", e.to_string()))?;
    let Some(cycle_id) = cycle_id else {
        return Err(fail("E-COV-RUN", "interview not found".into()));
    };

    // The guide checklist: template goals+questions when present, else derived goals.
    let guide_md = crate::synthesis::effective_guide_db(&db.pool, &cycle_id)
        .await
        .map_err(|e| fail("E-COV-RUN", e))?
        .unwrap_or_default();
    let template = crate::synthesis::effective_guide_template_db(&db.pool, &cycle_id)
        .await
        .map_err(|e| fail("E-COV-RUN", e))?;
    let goals = if !template.is_empty() { template.goals() } else { derive_goals(&guide_md) };
    let questions = template.questions();
    if goals.is_empty() && questions.is_empty() {
        return Err(fail(
            "E-COV-NO-GUIDE",
            "у цикла нет гайда с целями/вопросами — заполните гайд, чтобы проверять покрытие".into(),
        ));
    }

    // The transcript (edited > cleaned > raw).
    let Some((language, segments)) = best_transcript_db(&db.pool, &interview_id)
        .await
        .map_err(|e| fail("E-COV-RUN", e))?
    else {
        return Err(fail(
            "E-COV-NO-TRANSCRIPT",
            "у интервью ещё нет транскрипта — сначала расшифруйте запись".into(),
        ));
    };
    if segments.is_empty() {
        return Err(fail("E-COV-NO-TRANSCRIPT", "транскрипт интервью пуст".into()));
    }

    // Grounding context: product + glossary (both best-effort, never gate the run).
    let product_desc = crate::synthesis::effective_product_db(&db.pool, &cycle_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let glossary = crate::glossary::render_for_prompt(
        &crate::glossary::glossary_for_interview_db(&db.pool, &interview_id)
            .await
            .unwrap_or_default(),
    );

    // Role-labeled segments (the id IS the array index — the evidence convention).
    let roles = role_map_db(&db.pool, &interview_id).await.map_err(|e| fail("E-COV-RUN", e))?;
    let role_segments: Vec<(usize, String, String)> = segments
        .iter()
        .enumerate()
        .map(|(i, s)| {
            (
                i,
                roles.get(&s.speaker_label).cloned().unwrap_or_else(|| "unknown".to_string()),
                s.text.clone(),
            )
        })
        .collect();

    // Resolve the adapter (explicit id → that one; else the active one).
    let id = match adapter_id {
        Some(id) => id,
        None => crate::adapter::active_adapter_id(&db.pool).await.map_err(|e| fail("E-COV-RUN", e))?,
    };
    let adapter = crate::adapter::resolve_adapter_pub(&app, Some(&id)).map_err(|e| fail("E-COV-RUN", e))?;
    let task = coverage_task_name(&adapter);
    let model_override = crate::adapter::task_model_override(&db.pool, "guide-coverage").await;

    emit_coverage(&app, &interview_id, "running", 40, None);
    let input = build_coverage_input(
        language.as_deref(),
        &product_desc,
        &glossary,
        &guide_md,
        &goals,
        &questions,
        &role_segments,
    );
    let schema = coverage_schema();
    let value = crate::adapter::run_cli_task_model(&adapter, task, &input, Some(&schema), model_override.as_deref())
        .await
        .map_err(|e| fail("E-COV-RUN", e.to_string()))?;
    let raw: RawCoverageOutput = serde_json::from_value(value.clone())
        .map_err(|e| fail("E-COV-RUN", format!("guide-coverage output shape invalid: {e}; got {value}")))?;

    let doc = normalize_coverage(&goals, &questions, segments.len(), raw);
    let model_meta = json!({
        "adapter": adapter.id,
        "task": task,
        "items": doc.items.len(),
        "score": doc.score,
    })
    .to_string();
    store_coverage_db(&db.pool, &interview_id, &doc, &model_meta)
        .await
        .map_err(|e| fail("E-COV-STORE", format!("coverage computed but STORING it failed: {e}")))?;

    emit_coverage(&app, &interview_id, "done", 100, None);
    log::info!(
        target: "interviewlab::coverage",
        "run_guide_coverage: interview='{interview_id}': DONE — {} item(s), score {}",
        doc.items.len(), doc.score
    );
    let ts = now_ms();
    Ok(CoverageRow {
        interview_id,
        doc,
        model_meta: Some(model_meta),
        created_at: ts,
        updated_at: ts,
    })
}

// --- tests -------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn goals() -> Vec<Goal> {
        vec![
            Goal { id: "G1".into(), text: "Why do accounts stall?".into() },
            Goal { id: "G2".into(), text: "Which step confuses?".into() },
        ]
    }

    fn questions() -> Vec<GuideQuestion> {
        vec![GuideQuestion {
            id: "Q1".into(),
            text: "Walk me through your first session.".into(),
            section: "main".into(),
            block: "Onboarding".into(),
        }]
    }

    // normalize: guide order preserved, unknown model ids dropped, skipped items → missed,
    // out-of-range evidence filtered, unknown related_id cleared, score clamped/kept.
    #[test]
    fn normalize_coverage_validates_shape() {
        let raw = RawCoverageOutput {
            items: vec![
                RawCoverageItem {
                    id: "G1".into(),
                    status: "covered".into(),
                    evidence: vec![
                        RawEvidence { segment_id: 2, quote: "  I got stuck on creds  ".into() },
                        RawEvidence { segment_id: 99, quote: "out of range".into() }, // dropped
                        RawEvidence { segment_id: 1, quote: "   ".into() },           // blank → dropped
                    ],
                    note: " strong answer ".into(),
                },
                RawCoverageItem { id: "Q1".into(), status: "Partially".into(), evidence: vec![], note: String::new() },
                RawCoverageItem { id: "G9".into(), status: "covered".into(), evidence: vec![], note: String::new() }, // unknown id → ignored
            ],
            score: Some(140), // clamped
            summary: " one goal missed ".into(),
            follow_ups: vec![
                RawFollowUp { related_id: "G2".into(), question: " Какой шаг был самым запутанным? ".into() },
                RawFollowUp { related_id: "NOPE".into(), question: "General probe?".into() }, // related cleared
                RawFollowUp { related_id: "G2".into(), question: "  ".into() },               // empty → dropped
            ],
        };
        let doc = normalize_coverage(&goals(), &questions(), 5, raw);

        assert_eq!(doc.items.len(), 3, "exactly the guide's items, in guide order");
        assert_eq!(doc.items[0].id, "G1");
        assert_eq!(doc.items[0].status, "covered");
        assert_eq!(doc.items[0].evidence.len(), 1, "out-of-range + blank evidence dropped");
        assert_eq!(doc.items[0].evidence[0].quote, "I got stuck on creds");
        assert_eq!(doc.items[0].note, "strong answer");
        assert_eq!(doc.items[1].id, "G2");
        assert_eq!(doc.items[1].status, "missed", "item the model skipped defaults to missed");
        assert_eq!(doc.items[2].id, "Q1");
        assert_eq!(doc.items[2].status, "partial", "status spelling normalized");
        assert_eq!(doc.items[2].kind, "question");
        assert_eq!(doc.items[2].section, "main");
        assert_eq!(doc.score, 100, "score clamped to 0..100");
        assert_eq!(doc.summary, "one goal missed");
        assert_eq!(doc.follow_ups.len(), 2, "blank follow-up dropped");
        assert_eq!(doc.follow_ups[0].related_id, "G2");
        assert_eq!(doc.follow_ups[1].related_id, "", "unknown related_id cleared, question kept");
    }

    // When the model returns no score, it's recomputed from the statuses.
    #[test]
    fn normalize_coverage_recomputes_missing_score() {
        let raw = RawCoverageOutput {
            items: vec![
                RawCoverageItem { id: "G1".into(), status: "covered".into(), evidence: vec![], note: String::new() },
                RawCoverageItem { id: "Q1".into(), status: "partial".into(), evidence: vec![], note: String::new() },
                // G2 skipped → missed.
            ],
            score: None,
            summary: String::new(),
            follow_ups: vec![],
        };
        let doc = normalize_coverage(&goals(), &questions(), 3, raw);
        // covered(1) + missed(0) + partial(0.5) over 3 items = 50%.
        assert_eq!(doc.score, 50);
    }

    // The input pack carries the checklist + context; empty product/glossary omitted.
    #[test]
    fn build_input_carries_checklist_and_context() {
        let glossary = json!([{ "canonical": "API" }]);
        let input = build_coverage_input(
            Some("ru"),
            "Acme Analytics",
            &glossary,
            "## Goals\n- G1: stall",
            &goals(),
            &questions(),
            &[(0, "respondent".into(), "я застрял".into())],
        );
        assert_eq!(input["language"], "ru");
        assert_eq!(input["guide_items"].as_array().unwrap().len(), 3);
        assert_eq!(input["guide_items"][0]["id"], "G1");
        assert_eq!(input["guide_items"][2]["kind"], "question");
        assert_eq!(input["guide_items"][2]["block"], "Onboarding");
        assert_eq!(input["segments"][0]["speaker_role"], "respondent");
        assert_eq!(input["product_desc"], "Acme Analytics");
        assert_eq!(input["glossary"][0]["canonical"], "API");

        let empty = build_coverage_input(None, "", &json!([]), "", &goals(), &[], &[]);
        assert!(empty.get("product_desc").is_none(), "empty product omitted");
        assert!(empty.get("glossary").is_none(), "empty glossary omitted");
        assert_eq!(empty["language"], "auto");
    }

    // store/get roundtrip through the real migrations (upsert on re-run).
    #[tokio::test]
    async fn store_get_roundtrip_and_upsert() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys=ON").execute(&pool).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        // Seed a cycle + interview (coverage FK-references interview).
        let ts = now_ms();
        let cycle = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)")
            .bind(&cycle).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let iv = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'iv', 'new', ?, ?)")
            .bind(&iv).bind(&cycle).bind(ts).bind(ts).execute(&pool).await.unwrap();

        assert!(get_coverage_db(&pool, &iv).await.unwrap().is_none(), "none before the first run");

        let doc = CoverageDoc {
            items: vec![CoverageItem {
                id: "G1".into(),
                text: "stall".into(),
                kind: "goal".into(),
                section: String::new(),
                status: "covered".into(),
                evidence: vec![CoverageEvidence { segment_id: 3, quote: "quote".into() }],
                note: String::new(),
            }],
            score: 80,
            summary: "ok".into(),
            follow_ups: vec![CoverageFollowUp { related_id: String::new(), question: "q?".into() }],
        };
        store_coverage_db(&pool, &iv, &doc, "meta1").await.unwrap();
        let row = get_coverage_db(&pool, &iv).await.unwrap().unwrap();
        assert_eq!(row.doc, doc, "doc roundtrips through coverage_json");
        assert_eq!(row.model_meta.as_deref(), Some("meta1"));

        // Re-run upserts (still one row, meta/doc replaced).
        let doc2 = CoverageDoc { score: 55, ..doc.clone() };
        store_coverage_db(&pool, &iv, &doc2, "meta2").await.unwrap();
        let row2 = get_coverage_db(&pool, &iv).await.unwrap().unwrap();
        assert_eq!(row2.doc.score, 55);
        assert_eq!(row2.model_meta.as_deref(), Some("meta2"));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM coverage").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1, "re-run overwrote, no second row");

        // Deleting the interview cascades the coverage row.
        sqlx::query("DELETE FROM interview WHERE id = ?").bind(&iv).execute(&pool).await.unwrap();
        assert!(get_coverage_db(&pool, &iv).await.unwrap().is_none(), "cascade-deleted with the interview");
    }
}
