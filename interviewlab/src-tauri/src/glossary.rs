// Per-product Glossary — the focused `term → canonical` list that anchors anglicisms,
// technical terms, and local product names across the pipeline (docs/transcription-
// terminology.md "Recommended next step — a dedicated, curated glossary").
//
// WHY: the product `content_md` is prose; ASR-error-correction of named entities works far
// better with a FOCUSED entity phrase-list. A glossary row's `canonical` is the authoritative
// spelling; `aliases` are the wrong/garbled forms the ASR tends to produce. The list feeds:
//   1. the whisper `initial_prompt` (asr.rs) — biases the ASR up-front (entity recovery is far
//      better before the fact than after);
//   2. every cleanup batch + the per-segment rewrite (cleanup.rs) — the entity phrase-list that
//      anchors named-entity spellings AND guarantees cross-batch spelling CONSISTENCY (batches
//      are independent CLI calls; only the glossary + deterministic rules align them).
//
// Three surfaces, all here so there's ONE source of truth:
//   * CRUD (A): manual term management on a product.
//   * suggest_glossary_terms (B): mine candidate terms from a transcript + product context.
//   * suggest_glossary_terms_from_edits (C): mine candidates from the user's own raw→edited
//     corrections, so the glossary LEARNS from manual fixes wave over wave.
//
// Conventions mirror product.rs / guides.rs: a typed struct, parameterized SQL, each
// #[tauri::command] a thin wrapper over a testable `*_db` helper, pure render/dedup helpers
// unit-tested without a CLI.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::transcript::Segment;
use crate::Db;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- types --------------------------------------------------------------------

// A glossary term as the API/UI sees it: aliases as a real array (stored as JSON in the DB).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GlossaryTerm {
    pub id: String,
    pub product_id: String,
    pub canonical: String,
    pub aliases: Vec<String>,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// The raw DB row (aliases as the stored JSON string). Mapped 1:1 from the table, then
// converted to GlossaryTerm (aliases parsed). Kept private — callers see GlossaryTerm.
#[derive(FromRow)]
struct GlossaryRow {
    id: String,
    product_id: String,
    canonical: String,
    aliases_json: String,
    notes: String,
    created_at: i64,
    updated_at: i64,
}

impl From<GlossaryRow> for GlossaryTerm {
    fn from(r: GlossaryRow) -> Self {
        // Lenient: a malformed aliases_json degrades to no aliases rather than failing the row.
        let aliases: Vec<String> = serde_json::from_str(&r.aliases_json).unwrap_or_default();
        GlossaryTerm {
            id: r.id,
            product_id: r.product_id,
            canonical: r.canonical,
            aliases,
            notes: r.notes,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

// A term to add (create/bulk-accept). Shared by manual create + the suggest-accept flow.
#[derive(Deserialize, Clone, Debug)]
pub struct NewTerm {
    pub canonical: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub notes: String,
}

#[derive(Deserialize)]
pub struct CreateGlossaryTerm {
    pub product_id: String,
    pub canonical: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub notes: String,
}

#[derive(Deserialize)]
pub struct UpdateGlossaryTerm {
    pub id: String,
    pub canonical: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub notes: String,
}

// A model-suggested candidate (B/C). `reason` is shown to the user in the review list to help
// them decide; it's NOT persisted (only canonical/aliases/notes become a term on accept).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SuggestedTerm {
    pub canonical: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub reason: String,
}

// The result of a suggest run: the candidates plus the product they'd be saved to (resolved
// from the interview's cycle). product_id is None when the cycle has no LINKED product (only
// inline product_desc) — the UI then tells the user to attach a product first.
#[derive(Serialize, Clone, Debug)]
pub struct SuggestResult {
    pub product_id: Option<String>,
    pub product_name: Option<String>,
    pub terms: Vec<SuggestedTerm>,
}

// --- pure helpers (unit-tested without a DB/CLI) ------------------------------

// Normalize a term key for case-insensitive dedup (trim + lowercase). Anglicisms appear in
// both scripts, so we dedup on the trimmed-lowercased canonical only (e.g. "API" vs "api").
fn term_key(s: &str) -> String {
    s.trim().to_lowercase()
}

// Render the glossary as the compact JSON array the cleanup/synthesis prompts carry:
// [{canonical, aliases, notes}, …]. Empty-canonical rows are skipped. Used as the entity
// phrase-list — the model maps any alias/variant in the text to its canonical spelling.
pub fn render_for_prompt(terms: &[GlossaryTerm]) -> Value {
    let items: Vec<Value> = terms
        .iter()
        .filter(|t| !t.canonical.trim().is_empty())
        .map(|t| {
            let mut o = json!({ "canonical": t.canonical.trim() });
            let aliases: Vec<&str> = t
                .aliases
                .iter()
                .map(|a| a.trim())
                .filter(|a| !a.is_empty())
                .collect();
            if !aliases.is_empty() {
                o["aliases"] = json!(aliases);
            }
            if !t.notes.trim().is_empty() {
                o["notes"] = json!(t.notes.trim());
            }
            o
        })
        .collect();
    json!(items)
}

// Render the CANONICAL terms as a compact comma-separated blurb for the whisper initial_prompt
// (asr.rs). Only the correct spellings (not the garbled aliases) — the point is to BIAS the ASR
// toward producing them. Deduped, order preserved, capped so it doesn't crowd out the product
// prose that follows (the asr sanitizer applies the final hard char cap).
pub fn render_terms_for_asr(terms: &[GlossaryTerm], max_chars: usize) -> String {
    let mut out = String::new();
    let mut seen = std::collections::HashSet::new();
    for t in terms {
        let c = t.canonical.trim();
        if c.is_empty() || !seen.insert(term_key(c)) {
            continue;
        }
        let add = if out.is_empty() { c.to_string() } else { format!(", {c}") };
        if out.len() + add.len() > max_chars {
            break;
        }
        out.push_str(&add);
    }
    out
}

// --- DB helpers ---------------------------------------------------------------

async fn list_for_product_db(pool: &SqlitePool, product_id: &str) -> Result<Vec<GlossaryTerm>, sqlx::Error> {
    let rows: Vec<GlossaryRow> = sqlx::query_as(
        "SELECT id, product_id, canonical, aliases_json, notes, created_at, updated_at \
         FROM glossary_term WHERE product_id = ? ORDER BY canonical COLLATE NOCASE",
    )
    .bind(product_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(GlossaryTerm::from).collect())
}

async fn get_term_db(pool: &SqlitePool, id: &str) -> Result<Option<GlossaryTerm>, sqlx::Error> {
    let row: Option<GlossaryRow> = sqlx::query_as(
        "SELECT id, product_id, canonical, aliases_json, notes, created_at, updated_at \
         FROM glossary_term WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(GlossaryTerm::from))
}

async fn create_term_db(
    pool: &SqlitePool,
    product_id: &str,
    canonical: &str,
    aliases: &[String],
    notes: &str,
) -> Result<GlossaryTerm, String> {
    let id = Uuid::new_v4().to_string();
    let ts = now_ms();
    let aliases_json = serde_json::to_string(aliases).map_err(|e| format!("serialize aliases: {e}"))?;
    sqlx::query(
        "INSERT INTO glossary_term (id, product_id, canonical, aliases_json, notes, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(product_id)
    .bind(canonical.trim())
    .bind(&aliases_json)
    .bind(notes.trim())
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    get_term_db(pool, &id)
        .await
        .map_err(|e| e.to_string())
        .map(|t| t.expect("just inserted"))
}

async fn update_term_db(pool: &SqlitePool, req: &UpdateGlossaryTerm) -> Result<GlossaryTerm, String> {
    let aliases_json =
        serde_json::to_string(&req.aliases).map_err(|e| format!("serialize aliases: {e}"))?;
    sqlx::query(
        "UPDATE glossary_term SET canonical = ?, aliases_json = ?, notes = ?, updated_at = ? WHERE id = ?",
    )
    .bind(req.canonical.trim())
    .bind(&aliases_json)
    .bind(req.notes.trim())
    .bind(now_ms())
    .bind(&req.id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    get_term_db(pool, &req.id)
        .await
        .map_err(|e| e.to_string())
        .map(|t| t.expect("just updated"))
}

async fn delete_term_db(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM glossary_term WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// Bulk-add terms (the suggest-accept flow + a path for importing). Skips any term whose
// canonical is empty, already exists for the product (case-insensitive), or duplicates an
// earlier term in this same batch — so accepting suggestions never creates dupes. Returns the
// rows actually inserted.
async fn add_terms_db(
    pool: &SqlitePool,
    product_id: &str,
    terms: &[NewTerm],
) -> Result<Vec<GlossaryTerm>, String> {
    let existing = list_for_product_db(pool, product_id)
        .await
        .map_err(|e| e.to_string())?;
    let mut seen: std::collections::HashSet<String> =
        existing.iter().map(|t| term_key(&t.canonical)).collect();
    let mut inserted = Vec::new();
    for t in terms {
        let key = term_key(&t.canonical);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        inserted.push(create_term_db(pool, product_id, &t.canonical, &t.aliases, &t.notes).await?);
    }
    Ok(inserted)
}

// --- shared resolution (the glossary for an interview / product) --------------

// The product_id an interview's cycle is LINKED to (None when the cycle has no product row,
// only inline product_desc). The glossary lives on the product, so terms exist only when a
// product is linked. Best-effort: a missing interview/cycle yields None.
pub(crate) async fn product_id_for_interview_db(
    pool: &SqlitePool,
    interview_id: &str,
) -> Result<Option<String>, String> {
    let cycle_id: Option<String> = sqlx::query_scalar("SELECT cycle_id FROM interview WHERE id = ?")
        .bind(interview_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let Some(cycle_id) = cycle_id else {
        return Ok(None);
    };
    let product_id: Option<String> = sqlx::query_scalar("SELECT product_id FROM cycle WHERE id = ?")
        .bind(&cycle_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    Ok(product_id.filter(|s| !s.is_empty()))
}

// The glossary terms for an interview (interview → cycle → product → terms). Empty when the
// cycle has no linked product. pub(crate) so asr.rs + cleanup.rs share one resolution path.
pub(crate) async fn glossary_for_interview_db(
    pool: &SqlitePool,
    interview_id: &str,
) -> Result<Vec<GlossaryTerm>, String> {
    match product_id_for_interview_db(pool, interview_id).await? {
        Some(pid) => list_for_product_db(pool, &pid).await.map_err(|e| e.to_string()),
        None => Ok(Vec::new()),
    }
}

// The glossary terms for a CYCLE (cycle → product → terms). The synthesis-level stages (diff)
// work per-cycle, not per-interview, but the glossary is one-per-product on the cycle, so this is
// the cycle-level twin of glossary_for_interview_db. Empty when the cycle has no linked product.
// pub(crate) so diff.rs shares this one resolution path (roadmap §4: glossary as the spelling
// authority in the diff too).
pub(crate) async fn glossary_for_cycle_db(
    pool: &SqlitePool,
    cycle_id: &str,
) -> Result<Vec<GlossaryTerm>, String> {
    let product_id: Option<String> = sqlx::query_scalar("SELECT product_id FROM cycle WHERE id = ?")
        .bind(cycle_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    match product_id.filter(|s| !s.is_empty()) {
        Some(pid) => list_for_product_db(pool, &pid).await.map_err(|e| e.to_string()),
        None => Ok(Vec::new()),
    }
}

// --- B/C: term extraction via the CLI -----------------------------------------

// The output schema we hand the CLI for the extract task: { "terms": [ {canonical, aliases,
// notes, reason} ] }. Minimal + precise so the model returns clean structured_output.
fn extract_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["terms"],
        "properties": {
            "terms": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["canonical"],
                    "properties": {
                        "canonical": { "type": "string" },
                        "aliases": { "type": "array", "items": { "type": "string" } },
                        "notes":   { "type": "string" },
                        "reason":  { "type": "string" }
                    }
                }
            }
        }
    })
}

// The task name to run for extraction. Prefer the dedicated `glossary-extract` task; fall back
// to `cycle-synthesis-extract` for an adapter that predates it (the renderer is generic — the
// real instructions ride in the input JSON — so the fallback works identically).
fn extract_task_name(adapter: &crate::adapter::Adapter) -> &'static str {
    if adapter.tasks.contains_key("glossary-extract") {
        "glossary-extract"
    } else {
        "cycle-synthesis-extract"
    }
}

#[derive(Deserialize, Debug)]
struct ExtractOutput {
    #[serde(default)]
    terms: Vec<SuggestedTerm>,
}

// Drop candidates whose canonical is empty or already in the glossary (case-insensitive),
// de-duping within the batch too. Trims fields. Pure → unit-tested.
fn filter_candidates(existing: &[GlossaryTerm], candidates: Vec<SuggestedTerm>) -> Vec<SuggestedTerm> {
    let mut seen: std::collections::HashSet<String> =
        existing.iter().map(|t| term_key(&t.canonical)).collect();
    let mut out = Vec::new();
    for mut c in candidates {
        c.canonical = c.canonical.trim().to_string();
        c.aliases = c
            .aliases
            .into_iter()
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .collect();
        c.notes = c.notes.trim().to_string();
        c.reason = c.reason.trim().to_string();
        let key = term_key(&c.canonical);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(c);
    }
    out
}

// Run the extract CLI task over a prepared input, returning filtered candidates. Shared by the
// transcript-mining (B) and edit-mining (C) entry points — they differ only in the input.
async fn run_extract(
    adapter: &crate::adapter::Adapter,
    input: &Value,
    existing: &[GlossaryTerm],
    model_override: Option<&str>,
) -> Result<Vec<SuggestedTerm>, String> {
    let task = extract_task_name(adapter);
    let schema = extract_schema();
    let value = crate::adapter::run_cli_task_model(adapter, task, input, Some(&schema), model_override)
        .await
        .map_err(|e| e.to_string())?;
    let parsed: ExtractOutput = serde_json::from_value(value.clone())
        .map_err(|e| format!("glossary-extract output shape invalid: {e}; got {value}"))?;
    Ok(filter_candidates(existing, parsed.terms))
}

// Join an interview's best transcript text (edited → cleaned → raw) into a single blob for
// mining (B). Capped so a long transcript doesn't blow the stdin limit — a representative slice
// is enough to surface the recurring terms. Returns None when there's no transcript.
const EXTRACT_TEXT_MAX_CHARS: usize = 24_000;

async fn best_transcript_text_db(pool: &SqlitePool, interview_id: &str) -> Result<Option<(Option<String>, String)>, String> {
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
            let mut text = String::new();
            for s in &segments {
                if text.len() >= EXTRACT_TEXT_MAX_CHARS {
                    break;
                }
                text.push_str(s.text.trim());
                text.push('\n');
            }
            return Ok(Some((language, text)));
        }
    }
    Ok(None)
}

// Build the (raw, cleaned/edited) correction PAIRS for an interview (C). Pairs by index (the
// cleanup invariant keeps raw/cleaned the same count + order), keeping only segments whose text
// actually changed. None when there's no cleaned/edited version to compare against.
async fn correction_pairs_db(pool: &SqlitePool, interview_id: &str) -> Result<Option<(Option<String>, Vec<(String, String)>)>, String> {
    let raw: Option<(Option<String>, String)> = sqlx::query_as(
        "SELECT language, segments_json FROM transcript WHERE interview_id = ? AND kind = 'raw' \
         ORDER BY version DESC LIMIT 1",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((language, raw_json)) = raw else { return Ok(None) };

    // Prefer the user's hand-edited version (the real corrections); fall back to cleaned.
    let mut fixed: Option<String> = None;
    for kind in ["edited", "cleaned"] {
        let row: Option<String> = sqlx::query_scalar(
            "SELECT segments_json FROM transcript WHERE interview_id = ? AND kind = ? \
             ORDER BY version DESC LIMIT 1",
        )
        .bind(interview_id)
        .bind(kind)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if row.is_some() {
            fixed = row;
            break;
        }
    }
    let Some(fixed_json) = fixed else { return Ok(None) };

    let raw_segs: Vec<Segment> =
        serde_json::from_str(&raw_json).map_err(|e| format!("parse raw segments: {e}"))?;
    let fixed_segs: Vec<Segment> =
        serde_json::from_str(&fixed_json).map_err(|e| format!("parse fixed segments: {e}"))?;
    let pairs = diff_pairs(&raw_segs, &fixed_segs);
    Ok(Some((language, pairs)))
}

// Pure: pair raw↔fixed by index, keep only the ones whose trimmed text differs. Capped at a
// modest number of pairs so the extract prompt stays lean.
const MAX_CORRECTION_PAIRS: usize = 200;
fn diff_pairs(raw: &[Segment], fixed: &[Segment]) -> Vec<(String, String)> {
    raw.iter()
        .zip(fixed.iter())
        .filter_map(|(r, f)| {
            let (rt, ft) = (r.text.trim(), f.text.trim());
            if rt != ft && !rt.is_empty() && !ft.is_empty() {
                Some((rt.to_string(), ft.to_string()))
            } else {
                None
            }
        })
        .take(MAX_CORRECTION_PAIRS)
        .collect()
}

// UNIFIED LLM-STAGE RULES — kept byte-identical across cleanup.rs / glossary.rs / diff.rs so it
// can be trivially hoisted into ONE Rust constant later (roadmap §4 "общий мини-блок правил одной
// константой во все стадии"). Do NOT diverge the wording per file.
const UNIFIED_LLM_RULES: &str = "Unified rules for every LLM stage:\n\
    - Output language = the language of the interview; do NOT translate terms.\n\
    - Anti-hallucination: never invent names/numbers/quotes; \"not established / no answer\" is \
    better than guessing.\n\
    - Terminology: use the canonical spellings from the glossary, both in prose and inside quotes.\n\
    - Artifact style: neutral analytical tone, no filler, one consistent format for quotes and \
    numbers, and NO markdown headings inside string fields of the JSON.";

// Shared extract instructions: what a glossary term IS and the never-hallucinate guardrails. The
// language / anti-hallucination policy comes from UNIFIED_LLM_RULES (one source of truth); this
// string covers only the extract-task SPECIFICS so it can't drift from the other stages.
const EXTRACT_GUIDELINES: &str = "Build a focused GLOSSARY for fixing speech-to-text of \
    Russian product/tech interviews. A glossary term = a brand / product / tool name, an \
    acronym/initialism, a technical term, or an anglicism that the ASR mis-renders. For each \
    term return its CANONICAL spelling (acronyms → UPPERCASE Latin like API/MVP/SaaS; \
    products/tools → canonical like Figma/Jira/GitHub; assimilated anglicisms → standard \
    Cyrillic like дедлайн/фича/баг — do NOT Latinize those) plus `aliases`: the garbled / \
    phonetic / mis-spelled forms to map to it (e.g. canonical \"API\" with aliases \
    [\"эй-пи-ай\",\"апишка\"]). Only include terms ACTUALLY present in the provided text. Skip \
    ordinary words. Prefer fewer, high-value entries over an exhaustive dump.";

// Build the extract input for the transcript-mining path (B).
fn build_extract_input(
    language: Option<&str>,
    product_desc: &str,
    existing: &[GlossaryTerm],
    transcript_text: &str,
) -> Value {
    let mut input = json!({
        "task": "glossary-extract",
        "language": language.unwrap_or("auto"),
        "rules": UNIFIED_LLM_RULES,
        "guidelines": EXTRACT_GUIDELINES,
        "instructions": "Read `transcript_text` (and `product_desc` for product/brand spellings) \
            and propose NEW glossary terms per `guidelines`. Do NOT propose any term already in \
            `existing_terms`. Return ONLY {\"terms\":[{\"canonical\":…,\"aliases\":[…],\"notes\":…,\
            \"reason\":…}]} — `reason` = a short note on why it's worth adding.",
        "existing_terms": existing.iter().map(|t| t.canonical.as_str()).collect::<Vec<_>>(),
        "transcript_text": transcript_text,
    });
    if !product_desc.trim().is_empty() {
        input["product_desc"] = json!(product_desc.trim());
    }
    input
}

// Build the extract input for the learn-from-edits path (C): the model sees the user's actual
// (before → after) corrections, which is the strongest signal for the right alias→canonical map.
fn build_extract_from_edits_input(
    language: Option<&str>,
    product_desc: &str,
    existing: &[GlossaryTerm],
    corrections: &[(String, String)],
) -> Value {
    let pairs: Vec<Value> = corrections
        .iter()
        .map(|(before, after)| json!({ "before": before, "after": after }))
        .collect();
    let mut input = json!({
        "task": "glossary-extract",
        "language": language.unwrap_or("auto"),
        "rules": UNIFIED_LLM_RULES,
        "guidelines": EXTRACT_GUIDELINES,
        "instructions": "`corrections` are (before → after) edits a human made to the transcript. \
            Find TERM-LEVEL normalizations among them (a brand/acronym/anglicism spelled one way in \
            `before` and canonically in `after`) and turn each into a glossary term: `canonical` = \
            the AFTER spelling, `aliases` = the BEFORE form(s). Ignore pure grammar/filler/wording \
            edits that aren't about a term. Skip anything already in `existing_terms`. Return ONLY \
            {\"terms\":[{\"canonical\":…,\"aliases\":[…],\"notes\":…,\"reason\":…}]}.",
        "existing_terms": existing.iter().map(|t| t.canonical.as_str()).collect::<Vec<_>>(),
        "corrections": pairs,
    });
    if !product_desc.trim().is_empty() {
        input["product_desc"] = json!(product_desc.trim());
    }
    input
}

// --- Tauri commands -----------------------------------------------------------

#[tauri::command]
pub async fn list_glossary_terms(
    db: tauri::State<'_, Db>,
    product_id: String,
) -> Result<Vec<GlossaryTerm>, String> {
    list_for_product_db(&db.pool, &product_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_glossary_term(
    db: tauri::State<'_, Db>,
    req: CreateGlossaryTerm,
) -> Result<GlossaryTerm, String> {
    if req.canonical.trim().is_empty() {
        return Err("a glossary term needs a canonical spelling".into());
    }
    create_term_db(&db.pool, &req.product_id, &req.canonical, &req.aliases, &req.notes).await
}

#[tauri::command]
pub async fn update_glossary_term(
    db: tauri::State<'_, Db>,
    req: UpdateGlossaryTerm,
) -> Result<GlossaryTerm, String> {
    if req.canonical.trim().is_empty() {
        return Err("a glossary term needs a canonical spelling".into());
    }
    update_term_db(&db.pool, &req).await
}

#[tauri::command]
pub async fn delete_glossary_term(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    delete_term_db(&db.pool, &id).await.map_err(|e| e.to_string())
}

// Bulk-accept suggested (or imported) terms into a product's glossary. Returns the rows
// actually inserted (dupes/empties skipped).
#[tauri::command]
pub async fn add_glossary_terms(
    db: tauri::State<'_, Db>,
    product_id: String,
    terms: Vec<NewTerm>,
) -> Result<Vec<GlossaryTerm>, String> {
    add_terms_db(&db.pool, &product_id, &terms).await
}

// B — suggest glossary terms by mining an interview's transcript + its product context. The
// candidates are filtered against the product's existing glossary and returned for the user to
// review/accept (accept → add_glossary_terms). Resolves the target product from the cycle.
#[tauri::command]
pub async fn suggest_glossary_terms(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    interview_id: String,
    adapter_id: Option<String>,
) -> Result<SuggestResult, String> {
    log::info!(target: "interviewlab::glossary", "suggest_glossary_terms: interview '{interview_id}' (adapter override: {adapter_id:?})");

    let product_id = product_id_for_interview_db(&db.pool, &interview_id).await?;
    let (existing, product_name) = match &product_id {
        Some(pid) => (
            list_for_product_db(&db.pool, pid).await.map_err(|e| e.to_string())?,
            sqlx::query_scalar::<_, String>("SELECT name FROM product WHERE id = ?")
                .bind(pid)
                .fetch_optional(&db.pool)
                .await
                .map_err(|e| e.to_string())?,
        ),
        None => (Vec::new(), None),
    };

    let Some((language, transcript_text)) = best_transcript_text_db(&db.pool, &interview_id).await? else {
        return Err("no transcript to mine for terms (transcribe the interview first)".into());
    };

    let adapter = resolve_adapter(&app, &db, adapter_id).await?;
    let product_desc = product_context(&db, &interview_id).await;
    let model_override = crate::adapter::task_model_override(&db.pool, "cycle-synthesis-extract").await;

    let input = build_extract_input(language.as_deref(), &product_desc, &existing, &transcript_text);
    let terms = run_extract(&adapter, &input, &existing, model_override.as_deref()).await?;
    log::info!(target: "interviewlab::glossary", "suggest_glossary_terms: interview '{interview_id}': {} candidate term(s)", terms.len());
    Ok(SuggestResult { product_id, product_name, terms })
}

// C — suggest glossary terms by mining the user's own raw→edited corrections, so the glossary
// learns from manual fixes. Same review/accept flow as B.
#[tauri::command]
pub async fn suggest_glossary_terms_from_edits(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    interview_id: String,
    adapter_id: Option<String>,
) -> Result<SuggestResult, String> {
    log::info!(target: "interviewlab::glossary", "suggest_glossary_terms_from_edits: interview '{interview_id}' (adapter override: {adapter_id:?})");

    let product_id = product_id_for_interview_db(&db.pool, &interview_id).await?;
    let (existing, product_name) = match &product_id {
        Some(pid) => (
            list_for_product_db(&db.pool, pid).await.map_err(|e| e.to_string())?,
            sqlx::query_scalar::<_, String>("SELECT name FROM product WHERE id = ?")
                .bind(pid)
                .fetch_optional(&db.pool)
                .await
                .map_err(|e| e.to_string())?,
        ),
        None => (Vec::new(), None),
    };

    let Some((language, corrections)) = correction_pairs_db(&db.pool, &interview_id).await? else {
        return Err("no cleaned/edited transcript to compare against (clean or edit the interview first)".into());
    };
    if corrections.is_empty() {
        return Ok(SuggestResult { product_id, product_name, terms: Vec::new() });
    }

    let adapter = resolve_adapter(&app, &db, adapter_id).await?;
    let product_desc = product_context(&db, &interview_id).await;
    let model_override = crate::adapter::task_model_override(&db.pool, "cycle-synthesis-extract").await;

    let input = build_extract_from_edits_input(language.as_deref(), &product_desc, &existing, &corrections);
    let terms = run_extract(&adapter, &input, &existing, model_override.as_deref()).await?;
    log::info!(
        target: "interviewlab::glossary",
        "suggest_glossary_terms_from_edits: interview '{interview_id}': {} candidate term(s) from {} correction(s)",
        terms.len(), corrections.len()
    );
    Ok(SuggestResult { product_id, product_name, terms })
}

// --- small shared command helpers ---------------------------------------------

async fn resolve_adapter(
    app: &tauri::AppHandle,
    db: &tauri::State<'_, Db>,
    adapter_id: Option<String>,
) -> Result<crate::adapter::Adapter, String> {
    let id = match adapter_id {
        Some(id) => id,
        None => crate::adapter::active_adapter_id(&db.pool).await?,
    };
    crate::adapter::resolve_adapter_pub(app, Some(&id))
}

// Product context (content_md) for an interview's cycle — the same source cleanup/ASR use.
// Best-effort: returns "" on any failure (suggestion never gates on it).
async fn product_context(db: &tauri::State<'_, Db>, interview_id: &str) -> String {
    let cycle_id: Option<String> = sqlx::query_scalar("SELECT cycle_id FROM interview WHERE id = ?")
        .bind(interview_id)
        .fetch_optional(&db.pool)
        .await
        .ok()
        .flatten();
    let Some(cycle_id) = cycle_id else { return String::new() };
    crate::synthesis::effective_product_db(&db.pool, &cycle_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

// --- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        use sqlx::sqlite::SqlitePoolOptions;
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys=ON").execute(&pool).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn seed_product(pool: &SqlitePool) -> String {
        let id = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO product (id, name, content_md, created_at, updated_at) VALUES (?, 'P', 'ctx', ?, ?)")
            .bind(&id).bind(ts).bind(ts).execute(pool).await.unwrap();
        id
    }

    #[tokio::test]
    async fn crud_roundtrip_with_aliases() {
        let pool = test_pool().await;
        let pid = seed_product(&pool).await;

        let t = create_term_db(&pool, &pid, "  API ", &["эй-пи-ай".into(), "апишка".into()], " the HTTP API ")
            .await
            .unwrap();
        assert_eq!(t.canonical, "API", "canonical trimmed");
        assert_eq!(t.aliases, vec!["эй-пи-ай".to_string(), "апишка".to_string()]);
        assert_eq!(t.notes, "the HTTP API");

        let list = list_for_product_db(&pool, &pid).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].aliases.len(), 2, "aliases round-trip through the JSON column");

        let upd = update_term_db(
            &pool,
            &UpdateGlossaryTerm { id: t.id.clone(), canonical: "API".into(), aliases: vec![], notes: "".into() },
        )
        .await
        .unwrap();
        assert!(upd.aliases.is_empty(), "update can clear aliases");

        delete_term_db(&pool, &t.id).await.unwrap();
        assert_eq!(list_for_product_db(&pool, &pid).await.unwrap().len(), 0);
    }

    // Bulk-add skips empties, existing (case-insensitive), and in-batch dupes.
    #[tokio::test]
    async fn add_terms_dedupes() {
        let pool = test_pool().await;
        let pid = seed_product(&pool).await;
        create_term_db(&pool, &pid, "Jira", &[], "").await.unwrap();

        let added = add_terms_db(
            &pool,
            &pid,
            &[
                NewTerm { canonical: "jira".into(), aliases: vec!["джира".into()], notes: "".into() }, // dup (ci)
                NewTerm { canonical: "API".into(), aliases: vec![], notes: "".into() },                // new
                NewTerm { canonical: "  ".into(), aliases: vec![], notes: "".into() },                 // empty
                NewTerm { canonical: "api".into(), aliases: vec![], notes: "".into() },                // in-batch dup
            ],
        )
        .await
        .unwrap();
        assert_eq!(added.len(), 1, "only API is genuinely new");
        assert_eq!(added[0].canonical, "API");
        assert_eq!(list_for_product_db(&pool, &pid).await.unwrap().len(), 2);
    }

    // Deleting a product cascades its glossary terms (FK ON DELETE CASCADE + pragma).
    #[tokio::test]
    async fn product_delete_cascades_terms() {
        let pool = test_pool().await;
        let pid = seed_product(&pool).await;
        create_term_db(&pool, &pid, "API", &[], "").await.unwrap();
        sqlx::query("DELETE FROM product WHERE id = ?").bind(&pid).execute(&pool).await.unwrap();
        assert_eq!(list_for_product_db(&pool, &pid).await.unwrap().len(), 0, "terms cascade-deleted");
    }

    // interview → cycle → product resolution drives glossary_for_interview_db.
    #[tokio::test]
    async fn resolves_glossary_through_interview_cycle_product() {
        let pool = test_pool().await;
        let pid = seed_product(&pool).await;
        create_term_db(&pool, &pid, "Figma", &["фигма".into()], "").await.unwrap();

        let ts = now_ms();
        let cycle = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, product_desc, product_id, created_at, updated_at) VALUES (?, 'c', '', ?, ?, ?)")
            .bind(&cycle).bind(&pid).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let iv = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 't', 'new', ?, ?)")
            .bind(&iv).bind(&cycle).bind(ts).bind(ts).execute(&pool).await.unwrap();

        let terms = glossary_for_interview_db(&pool, &iv).await.unwrap();
        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].canonical, "Figma");

        // An interview whose cycle has no linked product → empty glossary (not an error).
        let cycle2 = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, product_desc, created_at, updated_at) VALUES (?, 'c2', 'inline', ?, ?)")
            .bind(&cycle2).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let iv2 = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 't', 'new', ?, ?)")
            .bind(&iv2).bind(&cycle2).bind(ts).bind(ts).execute(&pool).await.unwrap();
        assert!(glossary_for_interview_db(&pool, &iv2).await.unwrap().is_empty());
    }

    fn terms(pairs: &[(&str, &[&str])]) -> Vec<GlossaryTerm> {
        pairs
            .iter()
            .map(|(c, al)| GlossaryTerm {
                id: "x".into(),
                product_id: "p".into(),
                canonical: c.to_string(),
                aliases: al.iter().map(|s| s.to_string()).collect(),
                notes: String::new(),
                created_at: 0,
                updated_at: 0,
            })
            .collect()
    }

    #[test]
    fn render_for_prompt_shape() {
        let g = terms(&[("API", &["эй-пи-ай"]), ("дедлайн", &[]), ("   ", &[])]);
        let v = render_for_prompt(&g);
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 2, "empty-canonical row dropped");
        assert_eq!(arr[0]["canonical"], "API");
        assert_eq!(arr[0]["aliases"][0], "эй-пи-ай");
        assert!(arr[1].get("aliases").is_none(), "no aliases key when there are none");
    }

    #[test]
    fn asr_blurb_dedupes_and_caps() {
        let g = terms(&[("API", &[]), ("api", &[]), ("Figma", &[]), ("Jira", &[])]);
        let blurb = render_terms_for_asr(&g, 1000);
        assert_eq!(blurb, "API, Figma, Jira", "case-insensitive dedup, canonical only");
        // A tight cap stops before overflowing.
        let capped = render_terms_for_asr(&g, 5);
        assert_eq!(capped, "API", "cap stops adding once it wouldn't fit");
    }

    #[test]
    fn filter_candidates_drops_existing_and_dupes() {
        let existing = terms(&[("Jira", &[])]);
        let cands = vec![
            SuggestedTerm { canonical: " jira ".into(), aliases: vec![], notes: "".into(), reason: "".into() },
            SuggestedTerm { canonical: "API".into(), aliases: vec![" эй-пи-ай ".into(), "".into()], notes: " n ".into(), reason: "r".into() },
            SuggestedTerm { canonical: "api".into(), aliases: vec![], notes: "".into(), reason: "".into() },
            SuggestedTerm { canonical: "".into(), aliases: vec![], notes: "".into(), reason: "".into() },
        ];
        let out = filter_candidates(&existing, cands);
        assert_eq!(out.len(), 1, "jira(existing), api(in-batch dup), empty all dropped");
        assert_eq!(out[0].canonical, "API");
        assert_eq!(out[0].aliases, vec!["эй-пи-ай".to_string()], "blank alias trimmed away");
        assert_eq!(out[0].notes, "n", "notes trimmed");
    }

    #[test]
    fn diff_pairs_keeps_only_changes() {
        let raw = vec![
            Segment { start_ms: 0, end_ms: 1, speaker_label: "S1".into(), text: "джира тормозит".into() },
            Segment { start_ms: 1, end_ms: 2, speaker_label: "S1".into(), text: "всё ок".into() },
        ];
        let fixed = vec![
            Segment { start_ms: 0, end_ms: 1, speaker_label: "S1".into(), text: "Jira тормозит".into() },
            Segment { start_ms: 1, end_ms: 2, speaker_label: "S1".into(), text: "всё ок".into() },
        ];
        let pairs = diff_pairs(&raw, &fixed);
        assert_eq!(pairs.len(), 1, "only the changed segment becomes a correction pair");
        assert_eq!(pairs[0], ("джира тормозит".to_string(), "Jira тормозит".to_string()));
    }

    #[test]
    fn extract_inputs_carry_context() {
        let existing = terms(&[("Jira", &[])]);
        let b = build_extract_input(Some("ru"), "Acme product", &existing, "джира и апишка");
        assert_eq!(b["language"], "ru");
        assert_eq!(b["product_desc"], "Acme product");
        assert_eq!(b["existing_terms"][0], "Jira");
        assert_eq!(b["transcript_text"], "джира и апишка");

        let c = build_extract_from_edits_input(Some("ru"), "", &existing, &[("джира".into(), "Jira".into())]);
        assert!(c.get("product_desc").is_none(), "empty product context omitted");
        assert_eq!(c["corrections"][0]["before"], "джира");
        assert_eq!(c["corrections"][0]["after"], "Jira");
    }
}
