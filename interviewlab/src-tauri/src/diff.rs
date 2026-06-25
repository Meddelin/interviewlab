// Cycle diff — findings-level diff vs the previous wave (Milestone 9, spec §8.3 / §7.3.3).
//
// This is NOT a text diff. It compares two CYCLE SYNTHESES (the current cycle's findings
// and the previous cycle's findings) at the level of CONCLUSIONS, aligned BY MEANING
// WITHIN EACH GOAL, and classifies each finding as:
//
//   new       — present this wave, no matching finding in the previous wave.
//   changed   — same topic as a previous finding but a shift in confidence / root-cause /
//               recommendation (the `why` says what shifted).
//   dropped   — present last wave, no matching finding this wave.
//   unchanged — same conclusion, no material shift.
//
// M10b: synthesis is now two levels (per-interview + an editable cycle markdown artifact),
// but the diff is unchanged in spirit — it still reads the CYCLE-level row's structured
// `findings_json` (goals + goal_id-tagged findings) via synthesis::get_synthesis_db, which
// now selects the cycle-level row (interview_id IS NULL) and ignores the editable
// `content_md`. The findings shape the diff depends on (goal_id, statement, confidence,
// recommendation) is identical, so the diff keeps comparing wave-over-wave by goal.
//
// PIPELINE (mirrors synthesis.rs's reduce, but it's ONE reduce-style call — the two
// syntheses are already small, so no map stage): gather the current + previous
// SynthesisDoc (read back from the cycle-level `synthesis.findings_json` via
// synthesis::get_synthesis_db) + the SHARED GOALS (matched by stable `goal_id`; if a goal's TEXT changed between waves
// we pass BOTH texts so the model can align them — spec §8.3). The `cycle-diff` task runs
// through the M6 runner (adapter::run_cli_task) with an output JSON schema →
// `structured_output`. Result is stored in the `diff` table (`diff_json`), overwriting any
// prior diff for the (cycle, prev_cycle) pair (re-run replaces, per the brief).
//
// SERVER-SIDE INVARIANTS (NOT trusted from the model, mirroring synthesis.rs's discipline):
//   - every diff entry must reference a valid `goal_id` (one of the shared goals); entries
//     under an unknown goal are dropped,
//   - finding refs must resolve to REAL finding ids in the respective syntheses:
//       * `finding_id`      must exist in the CURRENT synthesis (for new/changed/unchanged),
//       * `prev_finding_id` must exist in the PREVIOUS synthesis (for changed/dropped/unchanged),
//     a ref that doesn't resolve is cleared; an entry left with NO usable ref for its status
//     is dropped,
//   - the `status` enum is normalized (unknown → dropped/kept per available refs); a blank
//     statement falls back to the referenced finding's statement so the UI always has text.
//
// Conventions mirror synthesis.rs: typed structs, each #[tauri::command] a thin wrapper over
// a testable helper; the assembly/validation logic (assemble_diff) is pure and unit-tested
// with stubbed CLI output (no real CLI in unit tests). Cuts are marked `// ponytail:`.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::Emitter;
use uuid::Uuid;

use crate::synthesis::{Goal, SynthesisDoc};
use crate::Db;

// Tauri event the Diff tab subscribes to for progress (single-stage: diffing → done).
pub const DIFF_PROGRESS_EVENT: &str = "diff://progress";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- shared goals (align current + previous guides by stable id) --------------

// A goal shared across the two waves, matched by stable `goal_id`. When the goal TEXT
// changed between waves we carry BOTH so the model can align findings written against
// either phrasing (spec §8.3). `prev_text` is None when the goal is current-only or the
// text is identical.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SharedGoal {
    pub id: String,
    pub text: String, // the current wave's goal text (or the previous text if current-only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_text: Option<String>, // the previous wave's text, only when it differs
}

// Build the union of goals across the two syntheses, keyed by id. The current text wins
// as `text`; if the previous wave had the same id with DIFFERENT text, that goes in
// `prev_text` so the model sees both phrasings. Goals that exist only in the previous wave
// are still included (so dropped findings under a retired goal can be reported), using the
// previous text as `text`. Order: current goals first (in their order), then previous-only.
pub fn shared_goals(current: &[Goal], previous: &[Goal]) -> Vec<SharedGoal> {
    let mut out: Vec<SharedGoal> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();

    for g in current {
        let prev_text = previous
            .iter()
            .find(|p| p.id == g.id)
            .map(|p| p.text.clone())
            .filter(|t| *t != g.text); // only carry it when it actually differs
        out.push(SharedGoal {
            id: g.id.clone(),
            text: g.text.clone(),
            prev_text,
        });
        seen.insert(g.id.as_str());
    }
    // Previous-only goals (retired this wave) — keep them so a `dropped` finding under
    // them still has a valid goal_id to render against.
    for p in previous {
        if !seen.contains(p.id.as_str()) {
            out.push(SharedGoal {
                id: p.id.clone(),
                text: p.text.clone(),
                prev_text: None,
            });
            seen.insert(p.id.as_str());
        }
    }
    out
}

// --- input shape (what we feed the model) -------------------------------------

// A trimmed finding handed to the model: id + goal + statement + the fields a "changed"
// classification hinges on (confidence / recommendation). We do NOT send evidence quotes —
// the diff is about conclusions, and it keeps the single call small (spec §8.3).
#[derive(Serialize, Clone, Debug)]
struct DiffFindingInput {
    id: String,
    goal_id: String,
    statement: String,
    confidence: String,
    recommendation: String,
}

fn to_diff_inputs(doc: &SynthesisDoc) -> Vec<DiffFindingInput> {
    doc.findings
        .iter()
        .map(|f| DiffFindingInput {
            id: f.id.clone(),
            goal_id: f.goal_id.clone(),
            statement: f.statement.clone(),
            confidence: f.confidence.clone(),
            recommendation: f.recommendation.clone(),
        })
        .collect()
}

// --- model output shape (§7.3.3) ----------------------------------------------

// One change entry as the model returns it. `status` is free text here and normalized
// server-side. `finding_id` points at a CURRENT finding; `prev_finding_id` at a PREVIOUS
// one (which of the two are present depends on the status — see assemble_diff).
#[derive(Deserialize, Debug, Default)]
struct RawChange {
    #[serde(default)]
    status: String,
    #[serde(default)]
    finding_id: String,
    #[serde(default)]
    prev_finding_id: String,
    #[serde(default)]
    statement: String,
    #[serde(default)]
    why: String,
}

#[derive(Deserialize, Debug, Default)]
struct RawGoalChanges {
    #[serde(default)]
    goal_id: String,
    #[serde(default)]
    changes: Vec<RawChange>,
}

#[derive(Deserialize, Debug, Default)]
struct RawDiffOutput {
    #[serde(default)]
    by_goal: Vec<RawGoalChanges>,
    #[serde(default)]
    summary: String,
}

// --- validated, stored shape --------------------------------------------------

// The diff status enum, normalized server-side. kebab-cased over the wire to match the
// spec's "new" / "changed" / "dropped" / "unchanged".
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiffStatus {
    New,
    Changed,
    Dropped,
    Unchanged,
}

impl DiffStatus {
    fn parse(s: &str) -> Option<DiffStatus> {
        match s.trim().to_lowercase().as_str() {
            "new" => Some(DiffStatus::New),
            "changed" => Some(DiffStatus::Changed),
            "dropped" | "removed" | "gone" => Some(DiffStatus::Dropped),
            "unchanged" | "same" | "stable" => Some(DiffStatus::Unchanged),
            _ => None,
        }
    }
}

// One validated diff entry (§7.3.3 shape). `finding_id` resolves into the current
// synthesis, `prev_finding_id` into the previous — present only where the status implies.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DiffEntry {
    pub status: DiffStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_finding_id: Option<String>,
    pub statement: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub why: String,
}

// One goal's diff entries (the grouping the UI renders).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct GoalDiff {
    pub goal_id: String,
    pub entries: Vec<DiffEntry>,
}

// The full diff document stored in diff.diff_json. Carries the shared goals (id + text,
// so the UI groups + labels without re-reading either synthesis) + the per-goal entries +
// the one-line summary.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DiffDoc {
    pub goals: Vec<DiffGoalRef>,
    pub by_goal: Vec<GoalDiff>,
    #[serde(default)]
    pub summary: String,
}

// A goal label stored in the diff doc (id + the current/aligned text). Decoupled from
// SharedGoal so the stored doc doesn't carry the transient `prev_text` alignment hint.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DiffGoalRef {
    pub id: String,
    pub text: String,
}

// The diff row returned to the frontend (parsed doc + meta).
#[derive(Serialize, Clone, Debug)]
pub struct DiffRow {
    pub id: String,
    pub cycle_id: String,
    pub prev_cycle_id: String,
    pub doc: DiffDoc,
    pub created_at: i64,
}

// --- output JSON schema handed to the CLI (--json-schema → structured_output) -

fn diff_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["by_goal", "summary"],
        "properties": {
            "by_goal": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["goal_id", "changes"],
                    "properties": {
                        "goal_id": { "type": "string" },
                        "changes": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["status", "finding_id", "prev_finding_id", "statement", "why"],
                                "properties": {
                                    "status": { "type": "string", "enum": ["new", "changed", "dropped", "unchanged"] },
                                    // finding_id: the CURRENT finding (empty "" for dropped).
                                    "finding_id": { "type": "string" },
                                    // prev_finding_id: the PREVIOUS finding (empty "" for new).
                                    "prev_finding_id": { "type": "string" },
                                    "statement": { "type": "string" },
                                    "why": { "type": "string" }
                                }
                            }
                        }
                    }
                }
            },
            "summary": { "type": "string" }
        }
    })
}

// --- prompt input -------------------------------------------------------------

fn build_diff_input(
    goals: &[SharedGoal],
    current: &[DiffFindingInput],
    previous: &[DiffFindingInput],
) -> Value {
    json!({
        "task": "cycle-diff",
        "instructions": "You are comparing two research waves at the level of CONCLUSIONS — \
            this is a FINDINGS-LEVEL diff, NOT a text diff. For EACH goal, align the current \
            wave's findings with the previous wave's findings BY MEANING (same underlying \
            conclusion = a match, even if worded differently), then classify each as: \
            `new` (a conclusion present this wave with no match last wave), \
            `changed` (the same conclusion as a previous finding but with a shift in \
            confidence, root cause, or recommendation), \
            `dropped` (a previous conclusion with no match this wave), or \
            `unchanged` (the same conclusion with no material shift). \
            Give every entry a short `why`; for `changed`, say WHAT shifted (confidence / \
            root cause / recommendation). Reference findings by id: set `finding_id` to the \
            CURRENT finding's id (leave \"\" for `dropped`) and `prev_finding_id` to the \
            PREVIOUS finding's id (leave \"\" for `new`). Use ONLY the goal_ids and finding \
            ids provided. End with a one-line `summary` of what changed this wave. Return \
            ONLY JSON matching the schema.",
        "goals": goals,
        "current_findings": current,
        "previous_findings": previous
    })
}

// --- assembly / invariant enforcement (the heart of M9, pure + unit-tested) ---

// Build the validated DiffDoc from the model output, enforcing the server-side invariants
// (see the module header). `goal_ids` = the valid shared-goal ids; `current_ids` /
// `prev_ids` = the real finding ids in each synthesis; `current_stmt` / `prev_stmt` look up
// a finding's statement so a blank entry statement can fall back to the referenced finding.
fn assemble_diff(
    goals: &[SharedGoal],
    current: &[DiffFindingInput],
    previous: &[DiffFindingInput],
    output: &RawDiffOutput,
) -> DiffDoc {
    let goal_ids: HashSet<&str> = goals.iter().map(|g| g.id.as_str()).collect();
    let current_ids: HashSet<&str> = current.iter().map(|f| f.id.as_str()).collect();
    let prev_ids: HashSet<&str> = previous.iter().map(|f| f.id.as_str()).collect();
    let current_stmt = |id: &str| current.iter().find(|f| f.id == id).map(|f| f.statement.clone());
    let prev_stmt = |id: &str| previous.iter().find(|f| f.id == id).map(|f| f.statement.clone());

    let mut by_goal: Vec<GoalDiff> = Vec::new();

    for raw_goal in &output.by_goal {
        // Invariant 1: the goal must be a real shared goal.
        if !goal_ids.contains(raw_goal.goal_id.as_str()) {
            continue;
        }

        let mut entries: Vec<DiffEntry> = Vec::new();
        for ch in &raw_goal.changes {
            // Normalize the status; an unparseable status is dropped (noise).
            let Some(status) = DiffStatus::parse(&ch.status) else {
                continue;
            };

            // Invariant 2: resolve finding refs against the REAL ids; a non-resolving ref
            // is cleared.
            let cur_ref = Some(ch.finding_id.trim())
                .filter(|s| !s.is_empty() && current_ids.contains(s))
                .map(|s| s.to_string());
            let prev_ref = Some(ch.prev_finding_id.trim())
                .filter(|s| !s.is_empty() && prev_ids.contains(s))
                .map(|s| s.to_string());

            // An entry must carry the ref its status implies; if the required ref didn't
            // resolve, drop the entry (it would be unrenderable / untraceable).
            let (finding_id, prev_finding_id) = match status {
                DiffStatus::New => {
                    if cur_ref.is_none() {
                        continue;
                    }
                    (cur_ref, None)
                }
                DiffStatus::Dropped => {
                    if prev_ref.is_none() {
                        continue;
                    }
                    (None, prev_ref)
                }
                // changed / unchanged ideally have both, but keep them as long as at least
                // one side resolves (so a real match isn't lost to a single bad id).
                DiffStatus::Changed | DiffStatus::Unchanged => {
                    if cur_ref.is_none() && prev_ref.is_none() {
                        continue;
                    }
                    (cur_ref, prev_ref)
                }
            };

            // Statement: prefer the model's; else fall back to the referenced finding's
            // statement (current first, then previous) so the UI always has text.
            let mut statement = ch.statement.trim().to_string();
            if statement.is_empty() {
                statement = finding_id
                    .as_deref()
                    .and_then(current_stmt)
                    .or_else(|| prev_finding_id.as_deref().and_then(prev_stmt))
                    .unwrap_or_default();
            }
            if statement.is_empty() {
                continue; // nothing to show
            }

            entries.push(DiffEntry {
                status,
                finding_id,
                prev_finding_id,
                statement,
                why: ch.why.trim().to_string(),
            });
        }

        if !entries.is_empty() {
            by_goal.push(GoalDiff {
                goal_id: raw_goal.goal_id.clone(),
                entries,
            });
        }
    }

    // Order goal groups by the shared-goals order (stable, readable).
    by_goal.sort_by_key(|gd| {
        goals
            .iter()
            .position(|g| g.id == gd.goal_id)
            .unwrap_or(usize::MAX)
    });

    DiffDoc {
        goals: goals
            .iter()
            .map(|g| DiffGoalRef { id: g.id.clone(), text: g.text.clone() })
            .collect(),
        by_goal,
        summary: output.summary.trim().to_string(),
    }
}

// --- progress events ----------------------------------------------------------

#[derive(Serialize, Clone)]
struct DiffProgress {
    cycle_id: String,
    stage: String, // 'diffing' | 'done' | 'error'
    progress: i32, // 0..100
    error: Option<String>,
}

fn emit_progress(app: &tauri::AppHandle, cycle_id: &str, stage: &str, progress: i32, error: Option<String>) {
    let _ = app.emit(
        DIFF_PROGRESS_EVENT,
        DiffProgress {
            cycle_id: cycle_id.to_string(),
            stage: stage.to_string(),
            progress,
            error,
        },
    );
}

// --- diff orchestration (pure-ish: the one CLI call + assembly) ---------------

// Run the diff for two syntheses through the adapter: build the shared goals + trimmed
// finding inputs, ONE reduce-style `cycle-diff` call with the output schema, then validate.
// `app` is optional so this is testable without a Tauri runtime (used by the live verify).
async fn diff_syntheses(
    current: &SynthesisDoc,
    previous: &SynthesisDoc,
    adapter: &crate::adapter::Adapter,
    // The user's diff-bucket model override (None → the plugin's manifest default).
    model_override: Option<&str>,
) -> Result<DiffDoc, String> {
    let goals = shared_goals(&current.goals, &previous.goals);
    let cur_inputs = to_diff_inputs(current);
    let prev_inputs = to_diff_inputs(previous);

    let input = build_diff_input(&goals, &cur_inputs, &prev_inputs);
    let schema = diff_schema();

    // The model comes from the user override or the plugin's per-task manifest default
    // (for Claude Code, `sonnet` — findings-level reasoning, not the heavy default).
    let value = crate::adapter::run_cli_task_model(adapter, "cycle-diff", &input, Some(&schema), model_override)
        .await
        .map_err(|e| e.to_string())?;

    let output: RawDiffOutput = serde_json::from_value(value.clone())
        .map_err(|e| format!("diff output shape invalid: {e}; got {value}"))?;

    Ok(assemble_diff(&goals, &cur_inputs, &prev_inputs, &output))
}

// --- storing the diff ---------------------------------------------------------

// Store the diff doc as the cycle's single diff row vs the given prev cycle (overwrites any
// prior diff for the SAME (cycle, prev) pair — re-run replaces, per the brief). Returns the
// row id.
async fn store_diff_db(
    pool: &SqlitePool,
    cycle_id: &str,
    prev_cycle_id: &str,
    doc: &DiffDoc,
) -> Result<String, String> {
    let diff_json = serde_json::to_string(doc).map_err(|e| format!("serialize diff: {e}"))?;

    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM diff WHERE cycle_id = ? AND prev_cycle_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(cycle_id)
    .bind(prev_cycle_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(id) = existing {
        sqlx::query("UPDATE diff SET diff_json = ?, created_at = ? WHERE id = ?")
            .bind(&diff_json)
            .bind(now_ms())
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO diff (id, cycle_id, prev_cycle_id, diff_json, created_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(cycle_id)
        .bind(prev_cycle_id)
        .bind(&diff_json)
        .bind(now_ms())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(id)
    }
}

async fn get_diff_db(pool: &SqlitePool, cycle_id: &str) -> Result<Option<DiffRow>, String> {
    let row: Option<(String, String, String, i64)> = sqlx::query_as(
        "SELECT id, prev_cycle_id, diff_json, created_at FROM diff \
         WHERE cycle_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(cycle_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    match row {
        Some((id, prev_cycle_id, diff_json, created_at)) => {
            let doc: DiffDoc =
                serde_json::from_str(&diff_json).map_err(|e| format!("parse diff doc: {e}"))?;
            Ok(Some(DiffRow {
                id,
                cycle_id: cycle_id.to_string(),
                prev_cycle_id,
                doc,
                created_at,
            }))
        }
        None => Ok(None),
    }
}

// --- precondition resolution --------------------------------------------------

// The Diff tab's precondition state for a cycle: does it have a prev cycle, and do both
// have a synthesis? Drives the empty states (spec §9 M9 / §4.2 Diff tab) before a run.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum DiffReadiness {
    Ready,             // prev cycle set + both syntheses present → can run
    NoPrevCycle,       // cycle has no prev_cycle_id
    NoCurrentSynthesis, // current cycle has no synthesis yet
    NoPrevSynthesis,   // previous cycle has no synthesis yet
}

// The precondition status the frontend reads to render the right empty state vs the run
// action. `prev_cycle_name` is surfaced so the UI can say which wave it compares against.
#[derive(Serialize, Clone, Debug)]
pub struct DiffStatusRow {
    pub readiness: DiffReadiness,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_cycle_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_cycle_name: Option<String>,
}

async fn diff_status_db(pool: &SqlitePool, cycle_id: &str) -> Result<DiffStatusRow, String> {
    // prev_cycle_id for this cycle.
    let prev_cycle_id: Option<String> = sqlx::query_scalar("SELECT prev_cycle_id FROM cycle WHERE id = ?")
        .bind(cycle_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("cycle not found")?;

    let Some(prev_id) = prev_cycle_id.filter(|s| !s.is_empty()) else {
        return Ok(DiffStatusRow { readiness: DiffReadiness::NoPrevCycle, prev_cycle_id: None, prev_cycle_name: None });
    };

    let prev_name: Option<String> = sqlx::query_scalar("SELECT name FROM cycle WHERE id = ?")
        .bind(&prev_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    // Synthesis presence on each side.
    let has_current = crate::synthesis::get_synthesis_db(pool, cycle_id).await?.is_some();
    let has_prev = crate::synthesis::get_synthesis_db(pool, &prev_id).await?.is_some();

    let readiness = if !has_current {
        DiffReadiness::NoCurrentSynthesis
    } else if !has_prev {
        DiffReadiness::NoPrevSynthesis
    } else {
        DiffReadiness::Ready
    };

    Ok(DiffStatusRow {
        readiness,
        prev_cycle_id: Some(prev_id),
        prev_cycle_name: prev_name,
    })
}

// --- Tauri commands -----------------------------------------------------------

// Get the stored diff for a cycle (None before the first run). Drives the tab's
// empty-state vs populated rendering.
#[tauri::command]
pub async fn get_diff(db: tauri::State<'_, Db>, cycle_id: String) -> Result<Option<DiffRow>, String> {
    get_diff_db(&db.pool, &cycle_id).await
}

// The Diff tab's precondition status (prev cycle? both syntheses?) so the UI shows the
// right empty state vs the "Run diff" action without trying a run that can't succeed.
#[tauri::command]
pub async fn diff_status(db: tauri::State<'_, Db>, cycle_id: String) -> Result<DiffStatusRow, String> {
    diff_status_db(&db.pool, &cycle_id).await
}

// Run the findings-level diff for a cycle vs its previous wave: load both syntheses + the
// shared goals, run the single `cycle-diff` call through the active adapter, validate, and
// store. Emits progress on `diff://progress`. Returns the stored diff row. Re-run overwrites.
#[tauri::command]
pub async fn run_diff(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    cycle_id: String,
    adapter_id: Option<String>,
) -> Result<DiffRow, String> {
    // Resolve preconditions up front so a not-ready cycle fails with a clear message rather
    // than a confusing CLI error.
    let status = diff_status_db(&db.pool, &cycle_id).await?;
    let prev_id = match status.readiness {
        DiffReadiness::Ready => status.prev_cycle_id.clone().ok_or("missing prev cycle")?,
        DiffReadiness::NoPrevCycle => {
            return Err("This cycle has no previous wave set. Pick one in Overview to compare.".into())
        }
        DiffReadiness::NoCurrentSynthesis => {
            return Err("Run synthesis on this cycle first, then diff against the previous wave.".into())
        }
        DiffReadiness::NoPrevSynthesis => {
            return Err("The previous wave has no synthesis yet — synthesize it first, then diff.".into())
        }
    };

    emit_progress(&app, &cycle_id, "diffing", 10, None);

    // Load both syntheses (read back the persisted goals + findings).
    let current = crate::synthesis::get_synthesis_db(&db.pool, &cycle_id)
        .await?
        .ok_or("current synthesis vanished")?;
    let previous = crate::synthesis::get_synthesis_db(&db.pool, &prev_id)
        .await?
        .ok_or("previous synthesis vanished")?;

    // Resolve the adapter (explicit id → that one; else the active one).
    let id = match adapter_id {
        Some(id) => id,
        None => crate::adapter::active_adapter_id(&db.pool).await?,
    };
    let adapter = crate::adapter::resolve_adapter_pub(&app, Some(&id))?;

    emit_progress(&app, &cycle_id, "diffing", 40, None);

    // The user's diff-bucket model override (None → the plugin's manifest default).
    let model_override = crate::adapter::task_model_override(&db.pool, "cycle-diff").await;
    log::info!(
        target: "interviewlab::diff",
        "run_diff: cycle='{cycle_id}' vs prev='{prev_id}' — {} current / {} previous finding(s), adapter='{}'",
        current.doc.findings.len(), previous.doc.findings.len(), adapter.id
    );
    match diff_syntheses(&current.doc, &previous.doc, &adapter, model_override.as_deref()).await {
        Ok(doc) => {
            let row_id = store_diff_db(&db.pool, &cycle_id, &prev_id, &doc).await.map_err(|e| {
                log::error!(target: "interviewlab::diff", "[E-DIFF-STORE] run_diff: cycle='{cycle_id}': diff produced but STORING it failed: {e}");
                e
            })?;
            emit_progress(&app, &cycle_id, "done", 100, None);
            log::info!(target: "interviewlab::diff", "run_diff: cycle='{cycle_id}': DONE (row id={row_id})");
            Ok(DiffRow {
                id: row_id,
                cycle_id,
                prev_cycle_id: prev_id,
                doc,
                created_at: now_ms(),
            })
        }
        Err(e) => {
            log::error!(target: "interviewlab::diff", "[E-DIFF-RUN] run_diff: cycle='{cycle_id}' vs prev='{prev_id}': FAILED: {e}");
            emit_progress(&app, &cycle_id, "error", 0, Some(e.clone()));
            Err(e)
        }
    }
}

// --- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthesis::{Evidence, Finding};

    fn goal(id: &str, text: &str) -> Goal {
        Goal { id: id.into(), text: text.into() }
    }

    fn finding(id: &str, goal_id: &str, stmt: &str, conf: &str) -> Finding {
        Finding {
            id: id.into(),
            goal_id: goal_id.into(),
            statement: stmt.into(),
            confidence: conf.into(),
            support_count: 2,
            evidence: vec![Evidence { interview_id: "iv1".into(), segment_id: 0, quote: "q".into() }],
            recommendation: "do x".into(),
        }
    }

    fn current_doc() -> SynthesisDoc {
        SynthesisDoc {
            goals: vec![goal("G1", "drop-off at step 2"), goal("G2", "confusing step")],
            findings: vec![
                finding("F1", "G1", "Users stall at warehouse connect.", "high"),
                finding("F2", "G2", "Event mapping confuses people.", "medium"),
            ],
            open_questions: vec![],
            ..Default::default()
        }
    }

    fn previous_doc() -> SynthesisDoc {
        SynthesisDoc {
            // G1 text changed slightly between waves; G3 is previous-only (retired).
            goals: vec![goal("G1", "why users drop at step 2"), goal("G3", "pricing objection")],
            findings: vec![
                finding("pF1", "G1", "Users stall at warehouse connect.", "low"),
                finding("pF3", "G3", "Price is the top objection.", "high"),
            ],
            open_questions: vec![],
            ..Default::default()
        }
    }

    // --- shared_goals -----------------------------------------------------------

    #[test]
    fn shared_goals_unions_and_carries_changed_text() {
        let cur = current_doc();
        let prev = previous_doc();
        let goals = shared_goals(&cur.goals, &prev.goals);
        // G1 (current), G2 (current-only), then G3 (previous-only) — current order first.
        let ids: Vec<&str> = goals.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["G1", "G2", "G3"]);
        // G1's text differs across waves → prev_text carried for alignment.
        let g1 = &goals[0];
        assert_eq!(g1.text, "drop-off at step 2");
        assert_eq!(g1.prev_text.as_deref(), Some("why users drop at step 2"));
        // G2 is current-only → no prev_text.
        assert!(goals[1].prev_text.is_none());
        // G3 is previous-only → its text is the previous text, no prev_text.
        assert_eq!(goals[2].text, "pricing objection");
        assert!(goals[2].prev_text.is_none());
    }

    #[test]
    fn shared_goals_no_prev_text_when_identical() {
        let cur = vec![goal("G1", "same text")];
        let prev = vec![goal("G1", "same text")];
        let goals = shared_goals(&cur, &prev);
        assert_eq!(goals.len(), 1);
        assert!(goals[0].prev_text.is_none(), "identical text → no alignment hint");
    }

    // --- assemble_diff invariants ----------------------------------------------

    fn shared() -> Vec<SharedGoal> {
        shared_goals(&current_doc().goals, &previous_doc().goals)
    }
    fn cur_inputs() -> Vec<DiffFindingInput> {
        to_diff_inputs(&current_doc())
    }
    fn prev_inputs() -> Vec<DiffFindingInput> {
        to_diff_inputs(&previous_doc())
    }

    #[test]
    fn assemble_classifies_and_groups_by_goal() {
        let output: RawDiffOutput = serde_json::from_value(json!({
            "by_goal": [
                { "goal_id": "G1", "changes": [
                    { "status": "changed", "finding_id": "F1", "prev_finding_id": "pF1",
                      "statement": "Users stall at warehouse connect.",
                      "why": "Confidence rose low→high; root cause refined to missing creds at signup." }
                ]},
                { "goal_id": "G2", "changes": [
                    { "status": "new", "finding_id": "F2", "prev_finding_id": "",
                      "statement": "Event mapping confuses people.", "why": "No matching finding last wave." }
                ]},
                { "goal_id": "G3", "changes": [
                    { "status": "dropped", "finding_id": "", "prev_finding_id": "pF3",
                      "statement": "Price is the top objection.", "why": "No supporting evidence this cycle." }
                ]}
            ],
            "summary": "Net: 1 new onboarding finding; the pricing objection dropped; the drop-off finding firmed up."
        })).unwrap();

        let doc = assemble_diff(&shared(), &cur_inputs(), &prev_inputs(), &output);

        // Three goal groups, in shared-goal order.
        assert_eq!(doc.by_goal.len(), 3);
        assert_eq!(doc.by_goal[0].goal_id, "G1");
        assert_eq!(doc.by_goal[1].goal_id, "G2");
        assert_eq!(doc.by_goal[2].goal_id, "G3");

        // G1: changed, both refs resolve.
        let g1 = &doc.by_goal[0].entries[0];
        assert_eq!(g1.status, DiffStatus::Changed);
        assert_eq!(g1.finding_id.as_deref(), Some("F1"));
        assert_eq!(g1.prev_finding_id.as_deref(), Some("pF1"));
        assert!(g1.why.contains("Confidence"));

        // G2: new, only current ref.
        let g2 = &doc.by_goal[1].entries[0];
        assert_eq!(g2.status, DiffStatus::New);
        assert_eq!(g2.finding_id.as_deref(), Some("F2"));
        assert!(g2.prev_finding_id.is_none());

        // G3: dropped, only previous ref.
        let g3 = &doc.by_goal[2].entries[0];
        assert_eq!(g3.status, DiffStatus::Dropped);
        assert!(g3.finding_id.is_none());
        assert_eq!(g3.prev_finding_id.as_deref(), Some("pF3"));

        assert!(doc.summary.starts_with("Net:"));
        // Goals carried for the UI.
        assert_eq!(doc.goals.len(), 3);
    }

    #[test]
    fn assemble_drops_unknown_goal() {
        let output: RawDiffOutput = serde_json::from_value(json!({
            "by_goal": [
                { "goal_id": "GZ", "changes": [
                    { "status": "new", "finding_id": "F1", "prev_finding_id": "", "statement": "bogus goal", "why": "" }
                ]}
            ],
            "summary": ""
        })).unwrap();
        let doc = assemble_diff(&shared(), &cur_inputs(), &prev_inputs(), &output);
        assert!(doc.by_goal.is_empty(), "entries under an unknown goal are dropped");
    }

    #[test]
    fn assemble_clears_unresolved_refs_and_drops_unrenderable() {
        let output: RawDiffOutput = serde_json::from_value(json!({
            "by_goal": [
                { "goal_id": "G1", "changes": [
                    // `new` whose finding_id doesn't exist → no usable ref → dropped.
                    { "status": "new", "finding_id": "F99", "prev_finding_id": "", "statement": "ghost", "why": "" },
                    // `dropped` whose prev_finding_id doesn't exist → dropped.
                    { "status": "dropped", "finding_id": "", "prev_finding_id": "pF99", "statement": "ghost", "why": "" },
                    // `changed` with a bad current ref but a good prev ref → kept, current ref cleared.
                    { "status": "changed", "finding_id": "F99", "prev_finding_id": "pF1", "statement": "kept", "why": "shifted" }
                ]}
            ],
            "summary": "s"
        })).unwrap();
        let doc = assemble_diff(&shared(), &cur_inputs(), &prev_inputs(), &output);
        assert_eq!(doc.by_goal.len(), 1);
        let entries = &doc.by_goal[0].entries;
        assert_eq!(entries.len(), 1, "two unrenderable entries dropped, one kept");
        assert_eq!(entries[0].status, DiffStatus::Changed);
        assert!(entries[0].finding_id.is_none(), "bad current ref cleared");
        assert_eq!(entries[0].prev_finding_id.as_deref(), Some("pF1"));
    }

    #[test]
    fn assemble_normalizes_status_and_falls_back_statement() {
        let output: RawDiffOutput = serde_json::from_value(json!({
            "by_goal": [
                { "goal_id": "G1", "changes": [
                    // "same" → unchanged; blank statement falls back to F1's statement.
                    { "status": "same", "finding_id": "F1", "prev_finding_id": "pF1", "statement": "  ", "why": "" },
                    // unknown status → dropped entirely.
                    { "status": "frobnicated", "finding_id": "F1", "prev_finding_id": "", "statement": "x", "why": "" }
                ]}
            ],
            "summary": ""
        })).unwrap();
        let doc = assemble_diff(&shared(), &cur_inputs(), &prev_inputs(), &output);
        assert_eq!(doc.by_goal.len(), 1);
        let entries = &doc.by_goal[0].entries;
        assert_eq!(entries.len(), 1, "unknown-status entry dropped");
        assert_eq!(entries[0].status, DiffStatus::Unchanged, "\"same\" normalized to unchanged");
        assert_eq!(entries[0].statement, "Users stall at warehouse connect.", "blank statement fell back to F1");
    }

    #[test]
    fn diff_doc_round_trips_through_json() {
        let output: RawDiffOutput = serde_json::from_value(json!({
            "by_goal": [
                { "goal_id": "G1", "changes": [
                    { "status": "changed", "finding_id": "F1", "prev_finding_id": "pF1", "statement": "s", "why": "confidence rose" }
                ]}
            ],
            "summary": "one change"
        })).unwrap();
        let doc = assemble_diff(&shared(), &cur_inputs(), &prev_inputs(), &output);
        let json = serde_json::to_string(&doc).unwrap();
        let back: DiffDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, doc, "diff doc round-trips through diff_json");
        // The kebab status survives the round-trip.
        assert!(json.contains("\"changed\""));
    }

    // --- DB store/get round-trip + preconditions -------------------------------

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn insert_cycle(pool: &SqlitePool, id: &str, name: &str, prev: Option<&str>) {
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, prev_cycle_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
            .bind(id).bind(name).bind(prev).bind(ts).bind(ts).execute(pool).await.unwrap();
    }

    async fn insert_synthesis(pool: &SqlitePool, cycle_id: &str, doc: &SynthesisDoc) {
        let id = Uuid::new_v4().to_string();
        let json = serde_json::to_string(doc).unwrap();
        sqlx::query("INSERT INTO synthesis (id, cycle_id, findings_json, model_meta, created_at) VALUES (?, ?, ?, NULL, ?)")
            .bind(&id).bind(cycle_id).bind(&json).bind(now_ms()).execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn store_and_get_diff_overwrites() {
        let pool = test_pool().await;
        insert_cycle(&pool, "prev", "Wave 2", None).await;
        insert_cycle(&pool, "cur", "Wave 3", Some("prev")).await;

        let output: RawDiffOutput = serde_json::from_value(json!({
            "by_goal": [{ "goal_id": "G1", "changes": [
                { "status": "new", "finding_id": "F1", "prev_finding_id": "", "statement": "first", "why": "" }
            ]}],
            "summary": "v1"
        })).unwrap();
        let doc1 = assemble_diff(&shared(), &cur_inputs(), &prev_inputs(), &output);
        let id1 = store_diff_db(&pool, "cur", "prev", &doc1).await.unwrap();

        let got = get_diff_db(&pool, "cur").await.unwrap().unwrap();
        assert_eq!(got.prev_cycle_id, "prev");
        assert_eq!(got.doc.summary, "v1");

        // Re-run overwrites the same (cycle, prev) row.
        let mut doc2 = doc1.clone();
        doc2.summary = "v2".into();
        let id2 = store_diff_db(&pool, "cur", "prev", &doc2).await.unwrap();
        assert_eq!(id1, id2, "re-run overwrites the existing diff row");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM diff WHERE cycle_id = 'cur'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1);
        assert_eq!(get_diff_db(&pool, "cur").await.unwrap().unwrap().doc.summary, "v2");
    }

    #[tokio::test]
    async fn diff_status_reports_each_precondition() {
        let pool = test_pool().await;

        // No prev cycle.
        insert_cycle(&pool, "solo", "Solo", None).await;
        let s = diff_status_db(&pool, "solo").await.unwrap();
        assert_eq!(s.readiness, DiffReadiness::NoPrevCycle);
        assert!(s.prev_cycle_id.is_none());

        // Prev cycle set, but neither has a synthesis → no current synthesis.
        insert_cycle(&pool, "prev", "Wave 2", None).await;
        insert_cycle(&pool, "cur", "Wave 3", Some("prev")).await;
        let s = diff_status_db(&pool, "cur").await.unwrap();
        assert_eq!(s.readiness, DiffReadiness::NoCurrentSynthesis);
        assert_eq!(s.prev_cycle_id.as_deref(), Some("prev"));
        assert_eq!(s.prev_cycle_name.as_deref(), Some("Wave 2"));

        // Current has a synthesis, prev doesn't → no prev synthesis.
        insert_synthesis(&pool, "cur", &current_doc()).await;
        let s = diff_status_db(&pool, "cur").await.unwrap();
        assert_eq!(s.readiness, DiffReadiness::NoPrevSynthesis);

        // Both have a synthesis → ready.
        insert_synthesis(&pool, "prev", &previous_doc()).await;
        let s = diff_status_db(&pool, "cur").await.unwrap();
        assert_eq!(s.readiness, DiffReadiness::Ready);
    }

    // --- REAL end-to-end verify against the installed, logged-in `claude` CLI ----------
    //
    // #[ignore]d so the normal suite stays offline/fast + spends no subscription usage.
    // Builds TWO tiny syntheses (prev + current) sharing goal_ids with deliberately
    // diff-able shifts (a confidence rise, a new finding, a dropped finding), runs the
    // REAL `cycle-diff`, and asserts entries are grouped by goal with valid statuses + why
    // and resolving refs. Stores against the live DB, then cleans up.
    // Run: cargo test live_m9_diff_verify -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_m9_diff_verify() {
        use crate::adapter;

        let adapter = adapter::builtin_adapter_pub();

        // Shared goals G1/G2; current adds G3, drops nothing under it. Previous has a G2
        // pricing-ish finding that's GONE this wave (→ dropped), and a G1 finding whose
        // confidence RISES this wave (→ changed). Current adds a brand-new G3 finding (→ new).
        let previous = SynthesisDoc {
            goals: vec![
                Goal { id: "G1".into(), text: "Почему новые аккаунты застревают перед первой воронкой?".into() },
                Goal { id: "G2".into(), text: "Какой шаг онбординга путает больше всего?".into() },
            ],
            findings: vec![
                Finding { id: "pF1".into(), goal_id: "G1".into(),
                    statement: "Пользователи застревают на подключении хранилища, но данных пока мало.".into(),
                    confidence: "low".into(), support_count: 1,
                    evidence: vec![Evidence { interview_id: "ivA".into(), segment_id: 0, quote: "застрял на подключении".into() }],
                    recommendation: "Возможно, отложить подключение источника.".into() },
                Finding { id: "pF2".into(), goal_id: "G2".into(),
                    statement: "Цена — главное возражение против продолжения онбординга.".into(),
                    confidence: "high".into(), support_count: 3,
                    evidence: vec![Evidence { interview_id: "ivB".into(), segment_id: 2, quote: "слишком дорого".into() }],
                    recommendation: "Пересмотреть прайсинг на этапе активации.".into() },
            ],
            open_questions: vec![],
            ..Default::default()
        };
        let current = SynthesisDoc {
            goals: vec![
                Goal { id: "G1".into(), text: "Почему новые аккаунты застревают перед созданием первой воронки?".into() },
                Goal { id: "G2".into(), text: "Какой шаг онбординга вызывает больше всего путаницы?".into() },
                Goal { id: "G3".into(), text: "Что побудило бы пригласить коллегу на первой неделе?".into() },
            ],
            findings: vec![
                Finding { id: "F1".into(), goal_id: "G1".into(),
                    statement: "Новые аккаунты застревают, потому что подключение хранилища требует доступов, которых нет под рукой при регистрации.".into(),
                    confidence: "high".into(), support_count: 4,
                    evidence: vec![Evidence { interview_id: "iv1".into(), segment_id: 2, quote: "не было доступов под рукой, и я застрял".into() }],
                    recommendation: "Отложить подключение источника или дать демо-датасет, чтобы дойти до первой воронки.".into() },
                Finding { id: "F2".into(), goal_id: "G2".into(),
                    statement: "Экран маппинга событий путает: слишком много полей, пользователи угадывают.".into(),
                    confidence: "medium".into(), support_count: 2,
                    evidence: vec![Evidence { interview_id: "iv1".into(), segment_id: 4, quote: "слишком много полей, я просто угадывал".into() }],
                    recommendation: "Свести маппинг к трём предлагаемым событиям с примерами.".into() },
                Finding { id: "F3".into(), goal_id: "G3".into(),
                    statement: "Люди зовут коллегу только когда сами разберутся и появится что показать.".into(),
                    confidence: "medium".into(), support_count: 2,
                    evidence: vec![Evidence { interview_id: "iv2".into(), segment_id: 5, quote: "позову команду, когда будет что показать".into() }],
                    recommendation: "Откладывать предложение пригласить коллегу до первой воронки.".into() },
            ],
            open_questions: vec![],
            ..Default::default()
        };

        let doc = diff_syntheses(&current, &previous, &adapter, None)
            .await
            .expect("real diff should succeed");

        // Grouped by goal; goals carried for the UI.
        assert!(!doc.by_goal.is_empty(), "diff produced at least one goal group");
        let goal_ids: HashSet<&str> = doc.goals.iter().map(|g| g.id.as_str()).collect();

        // Every entry: a valid goal, a parsed status, resolving refs, a why.
        let cur_ids: HashSet<&str> = current.findings.iter().map(|f| f.id.as_str()).collect();
        let prev_ids: HashSet<&str> = previous.findings.iter().map(|f| f.id.as_str()).collect();
        for gd in &doc.by_goal {
            assert!(goal_ids.contains(gd.goal_id.as_str()), "group goal {} is a real goal", gd.goal_id);
            for e in &gd.entries {
                if let Some(fid) = &e.finding_id {
                    assert!(cur_ids.contains(fid.as_str()), "finding_id {fid} resolves in current");
                }
                if let Some(pid) = &e.prev_finding_id {
                    assert!(prev_ids.contains(pid.as_str()), "prev_finding_id {pid} resolves in previous");
                }
                assert!(!e.statement.is_empty(), "every entry has a statement");
            }
        }

        println!("\n=== M9 REAL diff: {} goal groups ===", doc.by_goal.len());
        println!("summary: {}", doc.summary);
        for gd in &doc.by_goal {
            for e in &gd.entries {
                println!("[{}] {:?}  cur={:?} prev={:?}", gd.goal_id, e.status, e.finding_id, e.prev_finding_id);
                println!("    {}", e.statement);
                if !e.why.is_empty() {
                    println!("    why: {}", e.why);
                }
            }
        }

        // Store against the live DB + clean up.
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let db_path = app_dir.join("interviewlab.db");
        assert!(db_path.exists(), "live DB not found at {db_path:?} — run the app once first");
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = sqlx::sqlite::SqlitePool::connect_with(opts).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        // Two real cycles (prev + current) so the FK on diff.prev_cycle_id holds.
        let prev_id = Uuid::new_v4().to_string();
        let cur_id = Uuid::new_v4().to_string();
        insert_cycle(&pool, &prev_id, "__M9_VERIFY_PREV__", None).await;
        insert_cycle(&pool, &cur_id, "__M9_VERIFY_CUR__", Some(&prev_id)).await;
        let row_id = store_diff_db(&pool, &cur_id, &prev_id, &doc).await.unwrap();
        assert!(!row_id.is_empty());
        let stored = get_diff_db(&pool, &cur_id).await.unwrap().expect("diff stored");
        assert_eq!(stored.doc.by_goal.len(), doc.by_goal.len());
        println!("\nstored diff id={row_id} goal_groups={}", stored.doc.by_goal.len());

        // Cleanup (delete current first, then prev — diff row cascades with current cycle).
        sqlx::query("DELETE FROM cycle WHERE id = ?").bind(&cur_id).execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM cycle WHERE id = ?").bind(&prev_id).execute(&pool).await.unwrap();
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM diff WHERE cycle_id = ?")
            .bind(&cur_id).fetch_one(&pool).await.unwrap();
        assert_eq!(left, 0, "cleanup left diff rows");
        println!("M9 live verify OK: entries grouped by goal, statuses + refs valid, stored + cleaned up.\n");
    }

    // ===================================================================================
    // SEED STAGE 4 — diff (real `claude`) of wave 2 (current) vs wave 1 (previous).
    //
    // Mirrors run_diff headlessly: load both cycle syntheses from the DB
    // (synthesis::get_synthesis_db), run diff_syntheses through claude, store via
    // store_diff_db. Both cycles share the same guide → stable goal ids → clean diff.
    //
    // Idempotent: skips if a diff for the current cycle already exists.
    //
    // Run: src-tauri\target\cuda-build.cmd test --features cuda seed_stage4 -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn seed_stage4_diff() {
        const CYCLE_W1: &str = "22222222-2222-4222-8222-000000000001";
        const CYCLE_W2: &str = "22222222-2222-4222-8222-000000000002";

        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(app_dir.join("interviewlab.db"))
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = sqlx::sqlite::SqlitePool::connect_with(opts).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        if get_diff_db(&pool, CYCLE_W2).await.unwrap().is_some() {
            println!("skip: diff already present for current cycle");
            return;
        }

        let adapter = crate::adapter::builtin_adapter_pub();

        let current = crate::synthesis::get_synthesis_db(&pool, CYCLE_W2)
            .await
            .unwrap()
            .expect("current synthesis (run stage 3 first)");
        let previous = crate::synthesis::get_synthesis_db(&pool, CYCLE_W1)
            .await
            .unwrap()
            .expect("previous synthesis (run stage 3 first)");

        println!(
            "diffing wave2 ({} findings) vs wave1 ({} findings) via claude ...",
            current.doc.findings.len(),
            previous.doc.findings.len()
        );

        let doc = diff_syntheses(&current.doc, &previous.doc, &adapter, None)
            .await
            .expect("real diff should succeed");

        let row_id = store_diff_db(&pool, CYCLE_W2, CYCLE_W1, &doc).await.unwrap();

        let entries: usize = doc.by_goal.iter().map(|g| g.entries.len()).sum();
        println!("SEED STAGE 4 OK: diff id={row_id}, {} goal groups, {} entries", doc.by_goal.len(), entries);
        println!("summary: {}", doc.summary.chars().take(200).collect::<String>());
        'outer: for gd in &doc.by_goal {
            for e in &gd.entries {
                println!("  [{}] {:?}: {}", gd.goal_id, e.status, e.statement.chars().take(110).collect::<String>());
                break 'outer;
            }
        }
    }
}
