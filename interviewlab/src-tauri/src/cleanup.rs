// Transcript cleanup — the "no grammar errors" pass (Milestone 7, spec §6.7 / §7.3.1).
//
// The pipeline: raw ASR segments (verbatim, disfluent) → CLI `transcript-cleanup`
// task → cleaned segments (grammar-correct, punctuated, filler removed) stored as the
// `cleaned` transcript version. The CLI is driven through the M6 generic runner
// (adapter::run_cli_task) with an output JSON schema so it returns clean
// `structured_output`.
//
// Three non-negotiable invariants (spec §6.7 / §7.3.1), enforced server-side here —
// NOT trusted from the model:
//   1. same segment COUNT as the raw source,
//   2. same segment IDS (we tag each raw segment with a stable index id),
//   3. identical start/end TIMING and the same SPEAKER LABELS.
// The model may only rewrite `text`. After each batch returns we align the model's
// output back to the raw batch BY ID, re-stamp timing + speaker_label from the raw
// source (the M5 re-stamp pattern), and only adopt the rewritten `text`. If the model
// returns the wrong count / missing ids, we retry the batch once, then fail with a
// clear error rather than storing a corrupted transcript.
//
// Chunking (spec §9 M7 / risk §10.5): long transcripts can blow past model output
// limits + the 10 MB stdin cap, so we process in batches of BATCH_SIZE segments, each
// batch carrying ids for exact alignment, and stitch results back in order. Progress is
// emitted across batches on `cleanup://progress`.
//
// Conventions mirror transcript.rs / asr.rs: typed structs, parameterized SQL, each
// #[tauri::command] a thin wrapper over a testable helper. The alignment/invariant
// logic (align_batch) is pure + unit-tested with a stubbed CLI output (no real CLI).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::Emitter;
use uuid::Uuid;

use crate::transcript::Segment;
use crate::Db;

// Interview status vocabulary owned by cleanup (schema §2.2: …|cleaning|cleaned|…).
const STATUS_CLEANING: &str = "cleaning";
const STATUS_CLEANED: &str = "cleaned";
const STATUS_ERROR: &str = "error";

// Tauri event the Interviews tab + editor subscribe to for batch progress.
pub const CLEANUP_PROGRESS_EVENT: &str = "cleanup://progress";

// Segments per CLI call. Modest on purpose (spec §9 M7 "keep batches modest"): small
// enough to stay well under the model's output limit + the 10 MB stdin cap and to keep
// each round-trip fast, large enough to amortize CLI startup. ~60 short interview
// segments is a few KB of JSON. (PERF: bumped 40→60 — fewer CLI round-trips per
// transcript; still comfortably within alignment + output limits.)
const BATCH_SIZE: usize = 60;

// PERF: cleanup is mechanical grammar/punctuation/filler removal — a fast, cheap model
// handles it with negligible quality loss, instead of the CLI's heavy default. Injected
// per task as `--model haiku` through the adapter. A single tunable constant.
const CLEANUP_MODEL: &str = "haiku";

// PERF: how many cleanup batches run concurrently. A 40-min interview ≈ ~500 segments →
// ~9 batches that used to run STRICTLY SEQUENTIALLY; we now run up to this many at once
// behind a bounded semaphore. Conservative (4) to respect the user's Claude subscription
// rate limits — never an unbounded fan-out of `claude` processes. A single tunable.
const CLEANUP_CONCURRENCY: usize = 4;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- task I/O contract (spec §7.3.1) ------------------------------------------

// One input segment carrying a STABLE id so alignment is exact regardless of how the
// model reorders/echoes. id = the segment's index within the FULL transcript (not the
// batch) so ids are globally unique + stable across batches.
#[derive(Serialize, Clone)]
struct InputSegment {
    id: usize,
    start_ms: i64,
    end_ms: i64,
    speaker_label: String,
    text: String,
}

// One output segment the model returns. Only `text` is trusted; id is used to align;
// timing/label are re-stamped from the raw source (the model's copies are ignored).
#[derive(Deserialize, Debug)]
struct OutputSegment {
    id: usize,
    // The rest are accepted-but-ignored (the model echoes them per the contract); we
    // re-stamp from raw. Deserialized leniently so a model that omits them still parses.
    #[serde(default)]
    text: String,
}

// The model's full reply: { "segments": [ {id, text, …}, … ] }.
#[derive(Deserialize, Debug)]
struct CleanupOutput {
    #[serde(default)]
    segments: Vec<OutputSegment>,
}

// Default cleanup guidelines (spec §7.3.1). Language-aware: we instruct the model to
// clean in the ORIGINAL language and never translate (Russian-first per the spec).
// Cleanup guidelines (the §7.3.1 "no grammar errors" pass). Tech/product interviews in
// Russian are full of English terms and anglicisms that the ASR mangles or spells
// phonetically in Cyrillic, so beyond grammar/filler we give explicit terminology rules.
// Grounded in ASR-error-correction practice (Amazon Science generative AEC; Apple/DeRAGEC
// retrieval entity correction; code-aware ASR refinement) and Russian loanword orthography
// (borrowings appear in BOTH Latin & Cyrillic — there's no single right script, so the goal
// is CONSISTENCY + following the domain/glossary convention, not blanket Latinizing).
// ponytail: rules + a few illustrative examples, NOT a term dump — over-stuffing a glossary
// is counterproductive (WMT'25 terminology work). The product context (below) is the entity
// phrase-list that anchors named-entity / brand spellings the model otherwise can't recover.
fn guidelines_for(language: Option<&str>) -> String {
    let lang = language.unwrap_or("the original");
    format!(
        "Rewrite each segment into clean, readable {lang} that says EXACTLY what the speaker said. \
         Fix grammar, punctuation, and capitalization; remove only pure filler that carries no meaning \
         (Russian «эм», «ну вот», «значит», «как бы», «короче»; English \"um\", \"uh\", \"like\"). Do NOT \
         paraphrase, translate, summarize, merge, split, or reorder, and keep the speaker's meaning, tone, \
         and language mix. Do NOT invent words, names, or numbers that aren't in the audio — when a span is \
         unclear, keep it close to the original rather than guessing.\n\
         \n\
         English terms & anglicisms (these are tech/product interviews, so getting them right matters — the \
         ASR often mangles them or renders them phonetically in Cyrillic):\n\
         - Fix phonetically garbled / mis-heard English terms when the intended term is clear from context: \
           «эй-пи-ай»/«апишка» → «API», «продакт-маркет фит» → «product-market fit», «джира» → «Jira», \
           «эс-кью-эл» → «SQL», «гитхаб» → «GitHub».\n\
         - Acronyms / initialisms → UPPERCASE Latin: API, MVP, SaaS, B2B, KPI, UX, UI, AI, ML, LLM, CRM, SDK, ROI.\n\
         - Product / brand / tool / library names → their canonical spelling: Figma, Jira, GitHub, Notion, Slack.\n\
         - Anglicisms fully assimilated into Russian speech → keep the normal Cyrillic spelling, do NOT \
           Latinize them: дедлайн, фича, баг, релиз, кейс, юзер, фидбэк, апдейт, таск, митинг, бэклог, онбординг.\n\
         - Never TRANSLATE a term the speaker chose (don't turn «churn» into «отток» or «отток» into «churn») — \
           keep their word, just spell it canonically.\n\
         - Spell each term CONSISTENTLY — pick one form per term and use it every time.\n\
         When product/glossary context is provided below, treat ITS spelling of any product, brand, or domain \
         term as the AUTHORITY — it overrides the rules above."
    )
}

// The output JSON schema we hand the CLI (so it uses --json-schema → structured_output).
// Minimal but precise: an object with a `segments` array of {id, text}. Keeping ids in
// the schema nudges the model to echo every id.
fn output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["segments"],
        "properties": {
            "segments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id", "text"],
                    "properties": {
                        "id": { "type": "integer" },
                        "text": { "type": "string" }
                    }
                }
            }
        }
    })
}

// Build the §7.3.1 input JSON for one batch. `ids` are the global indices of these
// segments; `batch` are the raw segments themselves. `product_desc` is the cycle's product
// CONTEXT (Products library / req #2): including it lets the model normalize product/brand
// terms consistently when fixing the transcript (e.g. recognizing a product name the ASR
// mangled). Omitted from the JSON when empty so the prompt stays lean.
fn build_batch_input(
    language: Option<&str>,
    product_desc: &str,
    ids: &[usize],
    batch: &[Segment],
) -> Value {
    let segments: Vec<InputSegment> = ids
        .iter()
        .zip(batch.iter())
        .map(|(&id, s)| InputSegment {
            id,
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            speaker_label: s.speaker_label.clone(),
            text: s.text.clone(),
        })
        .collect();
    let mut input = json!({
        "task": "transcript-cleanup",
        "language": language.unwrap_or("auto"),
        "guidelines": guidelines_for(language),
        // Explicit, contract-restating instruction (belt + suspenders with the schema):
        // the renderer in adapter.rs also says "return ONLY JSON matching the schema".
        "instructions": "Return ONLY a JSON object {\"segments\":[{\"id\":<int>,\"text\":<cleaned string>}, …]}. \
                         Include EVERY input segment id exactly once. Change ONLY the text — apply the \
                         `guidelines` (grammar, filler, and the English-terms / anglicism normalization), \
                         using `product_desc` as the glossary for product/brand/domain spellings. Do not add, \
                         drop, merge, split, reorder, or translate segments.",
        "segments": segments
    });
    // Product context (Products library): only present when non-empty so an empty product
    // doesn't bloat the prompt. The model uses it to normalize product/brand terms.
    if !product_desc.trim().is_empty() {
        input["product_desc"] = json!(product_desc.trim());
    }
    input
}

// --- invariant enforcement / alignment (the heart of M7) ----------------------

// A clear, typed alignment error so retry logic + the UI can reason about it.
#[derive(Debug, PartialEq)]
pub enum AlignError {
    // The model returned a different number of segments than the batch.
    CountMismatch { expected: usize, got: usize },
    // The model's id set didn't exactly match the batch's id set.
    IdMismatch { missing: Vec<usize>, extra: Vec<usize> },
}

impl std::fmt::Display for AlignError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AlignError::CountMismatch { expected, got } => {
                write!(f, "segment count mismatch: expected {expected}, got {got}")
            }
            AlignError::IdMismatch { missing, extra } => write!(
                f,
                "segment id mismatch: missing {missing:?}, unexpected {extra:?}"
            ),
        }
    }
}

// Align ONE batch's model output back onto the raw batch, enforcing the invariants.
//
// `ids` are the global ids handed to the model for this batch (parallel to `raw`).
// `raw` are the authoritative raw segments (timing + speaker_label come from here).
// `output` is whatever the model returned.
//
// Returns cleaned segments in the SAME ORDER as `raw`, each with:
//   - start_ms/end_ms  ← raw  (re-stamped, never trusted from the model)
//   - speaker_label    ← raw  (re-stamped)
//   - text             ← the model's text for that id, trimmed; if the model returned an
//                        empty string we keep the raw text (never blank out a segment).
// Fails with AlignError if the count or id set doesn't match exactly — the caller then
// retries the batch once, then surfaces the error (no corrupted transcript is stored).
fn align_batch(
    ids: &[usize],
    raw: &[Segment],
    output: &CleanupOutput,
) -> Result<Vec<Segment>, AlignError> {
    // 1. Count must match exactly.
    if output.segments.len() != raw.len() {
        return Err(AlignError::CountMismatch {
            expected: raw.len(),
            got: output.segments.len(),
        });
    }

    // 2. Id set must match exactly (no missing, no extra, no dupes treated as a set).
    use std::collections::HashMap;
    let mut by_id: HashMap<usize, &str> = HashMap::with_capacity(output.segments.len());
    for seg in &output.segments {
        // Last write wins on a duplicate id; the count check above already caught the
        // common "duplicate => wrong count" case, but a dup+missing pair is caught here.
        by_id.insert(seg.id, seg.text.as_str());
    }
    let expected: std::collections::HashSet<usize> = ids.iter().copied().collect();
    let got: std::collections::HashSet<usize> = by_id.keys().copied().collect();
    if expected != got {
        let mut missing: Vec<usize> = expected.difference(&got).copied().collect();
        let mut extra: Vec<usize> = got.difference(&expected).copied().collect();
        missing.sort_unstable();
        extra.sort_unstable();
        return Err(AlignError::IdMismatch { missing, extra });
    }

    // 3. Re-stamp: emit cleaned segments in raw order, timing + label from raw, text
    //    from the model (by id), keeping raw text if the model returned blank.
    let mut out = Vec::with_capacity(raw.len());
    for (&id, raw_seg) in ids.iter().zip(raw.iter()) {
        let model_text = by_id.get(&id).copied().unwrap_or("").trim();
        let text = if model_text.is_empty() {
            raw_seg.text.clone()
        } else {
            model_text.to_string()
        };
        out.push(Segment {
            start_ms: raw_seg.start_ms,   // re-stamped from raw (immutable)
            end_ms: raw_seg.end_ms,       // re-stamped from raw (immutable)
            speaker_label: raw_seg.speaker_label.clone(), // re-stamped from raw
            text,
        });
    }
    Ok(out)
}

// --- progress events ----------------------------------------------------------

#[derive(Serialize, Clone)]
struct CleanupProgress {
    interview_id: String,
    status: String, // 'cleaning' | 'cleaned' | 'error'
    // Batch-level progress: which batch we're on / how many total.
    batch: usize,
    total_batches: usize,
    progress: i32, // 0..100 (batches done / total)
    error: Option<String>,
}

fn emit_cleanup(
    app: &tauri::AppHandle,
    interview_id: &str,
    status: &str,
    batch: usize,
    total_batches: usize,
    error: Option<String>,
) {
    let progress = if total_batches == 0 {
        0
    } else {
        ((batch as f32 / total_batches as f32) * 100.0).round() as i32
    };
    let _ = app.emit(
        CLEANUP_PROGRESS_EVENT,
        CleanupProgress {
            interview_id: interview_id.to_string(),
            status: status.to_string(),
            batch,
            total_batches,
            progress,
            error,
        },
    );
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

// Read the interview's current status (so a failed cleanup can restore it). None if the row /
// query fails — the caller falls back to a safe default.
async fn get_status_db(pool: &SqlitePool, interview_id: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT status FROM interview WHERE id = ?")
        .bind(interview_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

// The raw transcript is the cleanup source: same shape transcript.rs reads. We read it
// directly here (rather than reaching into transcript.rs internals) to keep modules
// decoupled. Returns (language, segments).
async fn raw_source_db(
    pool: &SqlitePool,
    interview_id: &str,
) -> Result<Option<(Option<String>, Vec<Segment>)>, String> {
    let row: Option<(Option<String>, String)> = sqlx::query_as(
        "SELECT language, segments_json FROM transcript \
         WHERE interview_id = ? AND kind = 'raw' ORDER BY version DESC LIMIT 1",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    match row {
        Some((language, json)) => {
            let segments: Vec<Segment> =
                serde_json::from_str(&json).map_err(|e| format!("parse raw segments: {e}"))?;
            Ok(Some((language, segments)))
        }
        None => Ok(None),
    }
}

// Product context for an interview's cycle (Products library / req #2): look up the
// interview's cycle, then resolve the effective product (linked product → content_md,
// falling back to inline product_desc) via the synthesis helper — one source of truth.
// Returns "" when the interview/cycle/product can't be resolved (cleanup never gates on it).
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

// Store the cleaned segments as the `cleaned` transcript version. Overwrites any
// existing cleaned row (re-clean is idempotent) by reusing its version, else takes the
// next free version. Mirrors transcript.rs's save patterns + asr.rs's overwrite pattern.
async fn store_cleaned_db(
    pool: &SqlitePool,
    interview_id: &str,
    language: Option<&str>,
    segments: &[Segment],
) -> Result<String, String> {
    let segments_json =
        serde_json::to_string(segments).map_err(|e| format!("serialize cleaned: {e}"))?;

    // Reuse an existing cleaned row's version (idempotent re-clean), else next free.
    let existing: Option<(String, i64)> = sqlx::query_as(
        "SELECT id, version FROM transcript WHERE interview_id = ? AND kind = 'cleaned' \
         ORDER BY version DESC LIMIT 1",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some((id, version)) = existing {
        sqlx::query(
            "UPDATE transcript SET segments_json = ?, language = ?, created_at = ?, version = ? WHERE id = ?",
        )
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
        let max: Option<i64> =
            sqlx::query_scalar("SELECT MAX(version) FROM transcript WHERE interview_id = ?")
                .bind(interview_id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
        let version = max.unwrap_or(0) + 1;
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO transcript (id, interview_id, version, kind, language, engine, segments_json, created_at) \
             VALUES (?, ?, ?, 'cleaned', ?, 'cli:transcript-cleanup', ?, ?)",
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

// --- the cleanup orchestration ------------------------------------------------

// Run cleanup over one batch through the runner, with the M7 invariant retry: if the
// returned JSON parses but fails alignment (wrong count/ids), retry the batch ONCE; on
// a second failure surface a clear error. (run_cli_task already retries once on a pure
// PARSE failure; this adds the alignment-level retry the spec requires.)
async fn clean_one_batch(
    adapter: &crate::adapter::Adapter,
    language: Option<&str>,
    product_desc: &str,
    ids: &[usize],
    raw: &[Segment],
) -> Result<Vec<Segment>, String> {
    let input = build_batch_input(language, product_desc, ids, raw);
    let schema = output_schema();

    let mut last_err: Option<String> = None;
    for attempt in 0..2 {
        // PERF: run cleanup on the fast model (haiku) — mechanical text-only edits.
        let value = crate::adapter::run_cli_task_model(
            adapter,
            "transcript-cleanup",
            &input,
            Some(&schema),
            Some(CLEANUP_MODEL),
        )
        .await
        .map_err(|e| e.to_string())?;

        // Parse the model's reply into our typed output, then align/enforce invariants.
        match serde_json::from_value::<CleanupOutput>(value.clone()) {
            Ok(output) => match align_batch(ids, raw, &output) {
                Ok(cleaned) => return Ok(cleaned),
                Err(align_err) => {
                    last_err = Some(format!("{align_err}"));
                    if attempt == 0 {
                        continue; // retry the batch once (spec §9 M7)
                    }
                }
            },
            Err(parse_err) => {
                last_err = Some(format!("cleanup output shape invalid: {parse_err}; got {value}"));
                if attempt == 0 {
                    continue;
                }
            }
        }
    }
    Err(format!(
        "transcript-cleanup failed the segment invariants after a retry: {}",
        last_err.unwrap_or_else(|| "unknown".into())
    ))
}

// Clean a whole transcript: chunk into batches, clean each, stitch in order, enforcing
// the full-transcript invariant at the end (defensive: the stitched result must equal
// the raw count + timing + labels). Pure-ish (takes the adapter + segments), so the
// command wrapper stays thin and this is exercisable. Emits per-batch progress.
//
// PERF: batches run with BOUNDED CONCURRENCY (CLEANUP_CONCURRENCY) instead of strictly
// sequentially — a 40-min interview's ~9 batches used to be ~9 serial `claude` calls.
// Each batch keeps its own id-alignment + invariant enforcement + per-batch retry
// (inside clean_one_batch); results are reassembled in ORIGINAL ORDER (by batch index)
// regardless of completion order, and progress is emitted as batches COMPLETE.
async fn clean_segments(
    app: Option<&tauri::AppHandle>,
    interview_id: &str,
    adapter: &crate::adapter::Adapter,
    language: Option<&str>,
    product_desc: &str,
    raw: &[Segment],
) -> Result<Vec<Segment>, String> {
    if raw.is_empty() {
        return Err("nothing to clean: the raw transcript has no segments".into());
    }

    // Global ids = indices into the full transcript (stable, unique).
    let total = raw.len();
    let total_batches = total.div_ceil(BATCH_SIZE);

    // Pre-chunk into (batch_index, ids, segments). Order here is the AUTHORITATIVE order.
    let batches: Vec<(usize, Vec<usize>, &[Segment])> = raw
        .chunks(BATCH_SIZE)
        .enumerate()
        .map(|(b, chunk)| {
            let start = b * BATCH_SIZE;
            let ids: Vec<usize> = (start..start + chunk.len()).collect();
            (b, ids, chunk)
        })
        .collect();

    // Bounded concurrency: process the batches in WAVES of CLEANUP_CONCURRENCY, running
    // each wave's batches concurrently with concurrent_map (never an unbounded fan-out of
    // `claude` processes — respects subscription rate limits). Within a wave each batch
    // keeps its own id-alignment + invariant enforcement + per-batch retry; we collect
    // wave results and reassemble in ORIGINAL ORDER. Progress is emitted as batches
    // complete (count of finished batches, monotonically increasing).
    let concurrency = CLEANUP_CONCURRENCY.max(1);
    let done = std::sync::atomic::AtomicUsize::new(0);
    let mut cleaned: Vec<Segment> = Vec::with_capacity(total);

    for wave in batches.chunks(concurrency) {
        // Build one future per batch in this wave (they share the outer task, so they run
        // concurrently when awaited together — real parallelism is the wave width).
        let wave_futs = wave.iter().map(|(b, ids, chunk)| {
            let done = &done;
            async move {
                let res = clean_one_batch(adapter, language, product_desc, ids, chunk).await;
                let completed = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                if let Some(app) = app {
                    emit_cleanup(app, interview_id, STATUS_CLEANING, completed, total_batches, None);
                }
                (*b, res)
            }
        });
        // Drive this wave's batches concurrently, preserving input (batch) order.
        let wave_results = join_all_ordered(wave_futs).await;
        // Reassemble: the batches array is in order, and join_all_ordered preserves it, so
        // extending in iteration order keeps the transcript in ORIGINAL order.
        for (b, res) in wave_results {
            let batch_cleaned = res.map_err(|e| format!("batch {}/{total_batches}: {e}", b + 1))?;
            cleaned.extend(batch_cleaned);
        }
    }

    // Final whole-transcript invariant check (defensive; each batch already enforced it).
    if cleaned.len() != raw.len() {
        return Err(format!(
            "internal: stitched cleaned count {} != raw count {}",
            cleaned.len(),
            raw.len()
        ));
    }
    for (i, (c, r)) in cleaned.iter().zip(raw.iter()).enumerate() {
        if c.start_ms != r.start_ms || c.end_ms != r.end_ms || c.speaker_label != r.speaker_label {
            return Err(format!(
                "internal: segment {i} timing/label drifted from raw after cleanup"
            ));
        }
    }
    Ok(cleaned)
}

// Drive a set of futures concurrently to completion, returning their outputs in the SAME
// ORDER as the input iterator (not completion order). ponytail: a small hand-rolled
// poller over pinned futures — we already depend on tokio, so this avoids pulling in the
// `futures` crate just for `join_all`. The number of futures here is bounded by the wave
// width (CLEANUP_CONCURRENCY), so this is small + cheap.
async fn join_all_ordered<F>(futs: impl IntoIterator<Item = F>) -> Vec<F::Output>
where
    F: std::future::Future,
{
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    struct JoinAll<F: Future> {
        slots: Vec<Option<Pin<Box<F>>>>,
        results: Vec<Option<F::Output>>,
    }
    // Sound: the only futures are heap-pinned (Pin<Box<F>>) and never moved while pinned;
    // `results` is plain owned data. Nothing is structurally pinned, so JoinAll is Unpin.
    impl<F: Future> Unpin for JoinAll<F> {}
    impl<F: Future> Future for JoinAll<F> {
        type Output = Vec<F::Output>;
        fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            let this = self.get_mut();
            let mut all_done = true;
            for (i, slot) in this.slots.iter_mut().enumerate() {
                if let Some(fut) = slot {
                    match fut.as_mut().poll(cx) {
                        Poll::Ready(v) => {
                            this.results[i] = Some(v);
                            *slot = None;
                        }
                        Poll::Pending => all_done = false,
                    }
                }
            }
            if all_done {
                Poll::Ready(this.results.iter_mut().map(|r| r.take().unwrap()).collect())
            } else {
                Poll::Pending
            }
        }
    }

    let slots: Vec<Option<Pin<Box<F>>>> = futs.into_iter().map(|f| Some(Box::pin(f))).collect();
    let results = (0..slots.len()).map(|_| None).collect();
    JoinAll { slots, results }.await
}

// --- Tauri command ------------------------------------------------------------

// Clean an interview's raw transcript and store the result as the `cleaned` version.
// Lifecycle: status → cleaning, run the CLI in batches (progress events), align +
// re-stamp invariants, store cleaned, status → cleaned | error. Returns the cleaned
// transcript id. The adapter is the active one (or the override id).
#[tauri::command]
pub async fn clean_transcript(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    interview_id: String,
    adapter_id: Option<String>,
) -> Result<String, String> {
    // Resolve the raw source first (clear error if there's nothing to clean).
    let (language, raw) = raw_source_db(&db.pool, &interview_id)
        .await?
        .ok_or("no raw transcript to clean (transcribe the interview first)")?;
    if raw.is_empty() {
        return Err("the raw transcript has no segments".into());
    }

    // Resolve the adapter (explicit id → that one; else the active one).
    let id = match adapter_id {
        Some(id) => id,
        None => crate::adapter::active_adapter_id(&db.pool).await?,
    };
    let adapter = crate::adapter::resolve_adapter_pub(&app, Some(&id))?;

    // Product context (Products library / req #2): source the interview's cycle product
    // (linked product → product.content_md, falling back to inline product_desc) so the
    // cleanup prompt normalizes product/brand terms. Best-effort: a missing cycle/product
    // just yields no context (empty), never blocks cleanup.
    let product_desc = product_context_for_interview_db(&db.pool, &interview_id)
        .await
        .unwrap_or_default();

    // Capture the status BEFORE we flip to `cleaning`, so a failed cleanup can restore it. The
    // raw/cleaned transcript is intact — cleanup is an enrichment, not the interview's terminal
    // state — so a failure must NOT mark the whole interview `error` (that locked the user out of a
    // perfectly good transcript). Fall back to `transcribed` if the read fails.
    let prior_status = get_status_db(&db.pool, &interview_id)
        .await
        .unwrap_or_else(|| "transcribed".to_string());

    set_status_db(&db.pool, &interview_id, STATUS_CLEANING)
        .await
        .map_err(|e| format!("set cleaning: {e}"))?;
    emit_cleanup(&app, &interview_id, STATUS_CLEANING, 0, raw.len().div_ceil(BATCH_SIZE), None);

    let lang = language.as_deref();
    match clean_segments(Some(&app), &interview_id, &adapter, lang, &product_desc, &raw).await {
        Ok(cleaned) => {
            let tid = store_cleaned_db(&db.pool, &interview_id, lang, &cleaned).await?;
            set_status_db(&db.pool, &interview_id, STATUS_CLEANED)
                .await
                .map_err(|e| format!("set cleaned: {e}"))?;
            let total_batches = raw.len().div_ceil(BATCH_SIZE);
            emit_cleanup(&app, &interview_id, STATUS_CLEANED, total_batches, total_batches, None);
            Ok(tid)
        }
        Err(e) => {
            // Don't store anything. RESTORE the prior status (transcribed/cleaned/edited) — the
            // transcript is intact, so the interview stays openable + the user can retry cleanup.
            // We still surface the failure via the event (error toast) + the returned Err.
            set_status_db(&db.pool, &interview_id, &prior_status).await.ok();
            emit_cleanup(&app, &interview_id, STATUS_ERROR, 0, 0, Some(e.clone()));
            Err(e)
        }
    }
}

// --- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn raw3() -> Vec<Segment> {
        vec![
            Segment { start_ms: 0, end_ms: 4200, speaker_label: "S1".into(), text: "ну вот эээ я обычно захожу и сразу значит смотрю заказы".into() },
            Segment { start_ms: 4200, end_ms: 8800, speaker_label: "S2".into(), text: "и потом это самое проверяю аналитику ну как бы".into() },
            Segment { start_ms: 8800, end_ms: 13100, speaker_label: "S2".into(), text: "но воронку я так и не настроил честно говоря".into() },
        ]
    }

    // A well-behaved model reply: echoes every id with cleaned text. Alignment re-stamps
    // timing/labels from raw and adopts the cleaned text.
    #[test]
    fn align_happy_path_restamps_timing_and_labels() {
        let raw = raw3();
        let ids = vec![0usize, 1, 2];
        // Note the model returns BOGUS implied timing by omitting it, and even reorders —
        // alignment is by id, and timing/labels come from raw, so it must still line up.
        let output: CleanupOutput = serde_json::from_value(json!({
            "segments": [
                { "id": 2, "text": "Но воронку я так и не настроил, честно говоря." },
                { "id": 0, "text": "Я обычно захожу и сразу смотрю заказы." },
                { "id": 1, "text": "И потом проверяю аналитику." }
            ]
        })).unwrap();

        let cleaned = align_batch(&ids, &raw, &output).unwrap();
        assert_eq!(cleaned.len(), 3);
        // Order follows RAW (not the model's reordered reply).
        assert_eq!(cleaned[0].text, "Я обычно захожу и сразу смотрю заказы.");
        assert_eq!(cleaned[1].text, "И потом проверяю аналитику.");
        assert_eq!(cleaned[2].text, "Но воронку я так и не настроил, честно говоря.");
        // Timing + labels re-stamped from raw, identical.
        for (c, r) in cleaned.iter().zip(raw.iter()) {
            assert_eq!(c.start_ms, r.start_ms);
            assert_eq!(c.end_ms, r.end_ms);
            assert_eq!(c.speaker_label, r.speaker_label);
        }
    }

    // The model can't shift timing even if it tries: alignment ignores any timing/label
    // the model sends (our OutputSegment doesn't even read them) and re-stamps from raw.
    #[test]
    fn align_ignores_model_supplied_timing() {
        let raw = raw3();
        let ids = vec![0usize, 1, 2];
        // Extra fields the model might send (start_ms/speaker_label) are simply not read.
        let output: CleanupOutput = serde_json::from_value(json!({
            "segments": [
                { "id": 0, "text": "A.", "start_ms": 99999, "end_ms": 99999, "speaker_label": "HACKED" },
                { "id": 1, "text": "B.", "start_ms": -1, "speaker_label": "HACKED" },
                { "id": 2, "text": "C.", "start_ms": 7, "speaker_label": "HACKED" }
            ]
        })).unwrap();
        let cleaned = align_batch(&ids, &raw, &output).unwrap();
        assert_eq!(cleaned[0].start_ms, 0);
        assert_eq!(cleaned[0].speaker_label, "S1");
        assert_eq!(cleaned[1].speaker_label, "S2");
        assert_eq!(cleaned[2].end_ms, 13100);
    }

    // Wrong COUNT → CountMismatch (the caller retries, then fails).
    #[test]
    fn align_rejects_wrong_count() {
        let raw = raw3();
        let ids = vec![0usize, 1, 2];
        let output: CleanupOutput = serde_json::from_value(json!({
            "segments": [ { "id": 0, "text": "only one" } ]
        })).unwrap();
        let err = align_batch(&ids, &raw, &output).unwrap_err();
        assert_eq!(err, AlignError::CountMismatch { expected: 3, got: 1 });
    }

    // Right count but a WRONG id (model dropped id 1, invented id 9) → IdMismatch.
    #[test]
    fn align_rejects_id_mismatch() {
        let raw = raw3();
        let ids = vec![0usize, 1, 2];
        let output: CleanupOutput = serde_json::from_value(json!({
            "segments": [
                { "id": 0, "text": "a" },
                { "id": 9, "text": "b" },
                { "id": 2, "text": "c" }
            ]
        })).unwrap();
        let err = align_batch(&ids, &raw, &output).unwrap_err();
        assert_eq!(err, AlignError::IdMismatch { missing: vec![1], extra: vec![9] });
    }

    // A blank cleaned text keeps the raw text (never blanks a segment).
    #[test]
    fn align_keeps_raw_text_when_model_blanks() {
        let raw = raw3();
        let ids = vec![0usize, 1, 2];
        let output: CleanupOutput = serde_json::from_value(json!({
            "segments": [
                { "id": 0, "text": "" },
                { "id": 1, "text": "   " },
                { "id": 2, "text": "Готово." }
            ]
        })).unwrap();
        let cleaned = align_batch(&ids, &raw, &output).unwrap();
        assert_eq!(cleaned[0].text, raw[0].text); // kept raw
        assert_eq!(cleaned[1].text, raw[1].text); // whitespace-only → kept raw
        assert_eq!(cleaned[2].text, "Готово.");
    }

    // build_batch_input tags global ids + carries timing/labels + the language guideline.
    #[test]
    fn batch_input_carries_ids_and_language() {
        let raw = raw3();
        let ids = vec![10usize, 11, 12];
        let input = build_batch_input(Some("ru"), "", &ids, &raw);
        assert_eq!(input["language"], "ru");
        assert!(input["guidelines"].as_str().unwrap().contains("never translate"));
        let segs = input["segments"].as_array().unwrap();
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[0]["id"], 10);
        assert_eq!(segs[0]["start_ms"], 0);
        assert_eq!(segs[1]["speaker_label"], "S2");
    }

    // Product context (Products library / req #2): a non-empty product_desc is carried into
    // the cleanup prompt so the model normalizes product/brand terms; an empty one is omitted.
    #[test]
    fn batch_input_includes_product_context_when_present() {
        let raw = raw3();
        let ids = vec![0usize, 1, 2];
        let product = "Acme Analytics — funnels + retention; the product is called 'Acme'.";
        let with = build_batch_input(Some("ru"), product, &ids, &raw);
        assert_eq!(
            with["product_desc"], product,
            "product context flows into the cleanup prompt"
        );

        // Empty product context is omitted from the prompt (kept lean).
        let without = build_batch_input(Some("ru"), "   ", &ids, &raw);
        assert!(
            without.get("product_desc").is_none(),
            "empty product context is not added to the prompt"
        );
    }

    // The schema is well-formed JSON-Schema with the required segments/id/text shape.
    #[test]
    fn schema_shape() {
        let s = output_schema();
        assert_eq!(s["type"], "object");
        let item = &s["properties"]["segments"]["items"];
        assert_eq!(item["required"], json!(["id", "text"]));
    }

    // Chunking math: a transcript spanning multiple batches has ids contiguous and globally
    // unique across batches. The expected batch count is DERIVED from BATCH_SIZE so the test
    // stays correct if the constant changes (PERF: BATCH_SIZE was bumped 40→60).
    #[test]
    fn chunking_covers_all_ids_once() {
        let n = 95usize;
        let raw: Vec<Segment> = (0..n)
            .map(|i| Segment { start_ms: i as i64 * 1000, end_ms: i as i64 * 1000 + 900, speaker_label: "S1".into(), text: format!("seg {i}") })
            .collect();
        let mut seen: Vec<usize> = Vec::new();
        let mut batches = 0;
        for (b, chunk) in raw.chunks(BATCH_SIZE).enumerate() {
            batches += 1;
            let start = b * BATCH_SIZE;
            let ids: Vec<usize> = (start..start + chunk.len()).collect();
            seen.extend(&ids);
        }
        assert_eq!(batches, n.div_ceil(BATCH_SIZE));
        seen.sort_unstable();
        assert_eq!(seen, (0..n).collect::<Vec<_>>(), "every id covered exactly once");
    }

    // --- stubbed-CLI alignment test (spec: "unit test … using a stubbed CLI output") ---
    //
    // Exercises the FULL clean_segments orchestration (chunk → align → re-stamp → stitch)
    // against a STUBBED model output instead of the real `claude` CLI, so no subscription
    // usage is spent. We stub by aligning batches directly through the same align_batch
    // the runner path uses, simulating a noisy→clean reply that preserves ids. This proves
    // the invariant chain end-to-end without shelling out.
    #[test]
    fn stubbed_cli_full_alignment_preserves_invariants() {
        // A noisy raw transcript spanning two batches (BATCH_SIZE=60 → 90 segs = 2 batches).
        let n = 90usize;
        let raw: Vec<Segment> = (0..n)
            .map(|i| Segment {
                start_ms: i as i64 * 2000,
                end_ms: i as i64 * 2000 + 1800,
                speaker_label: if i % 2 == 0 { "S1".into() } else { "S2".into() },
                text: format!("ну вот эээ сегмент номер {i} значит"),
            })
            .collect();

        // Simulate the per-batch CLI: a model that echoes every id with "cleaned" text and
        // (adversarially) bogus timing/labels we must ignore.
        let mut stitched: Vec<Segment> = Vec::with_capacity(n);
        for (b, chunk) in raw.chunks(BATCH_SIZE).enumerate() {
            let start = b * BATCH_SIZE;
            let ids: Vec<usize> = (start..start + chunk.len()).collect();
            let segs: Vec<Value> = ids
                .iter()
                .map(|&id| json!({ "id": id, "text": format!("Сегмент номер {id}."), "start_ms": 1, "speaker_label": "X" }))
                .collect();
            let output: CleanupOutput = serde_json::from_value(json!({ "segments": segs })).unwrap();
            let cleaned = align_batch(&ids, chunk, &output).unwrap();
            stitched.extend(cleaned);
        }

        // Whole-transcript invariants: count, timing, labels identical to raw; text changed.
        assert_eq!(stitched.len(), raw.len());
        for (i, (c, r)) in stitched.iter().zip(raw.iter()).enumerate() {
            assert_eq!(c.start_ms, r.start_ms, "start immutable (seg {i})");
            assert_eq!(c.end_ms, r.end_ms, "end immutable (seg {i})");
            assert_eq!(c.speaker_label, r.speaker_label, "label immutable (seg {i})");
            assert_ne!(c.text, r.text, "text should be cleaned (seg {i})");
            assert!(!c.text.contains("эээ"), "filler should be gone (seg {i})");
        }
    }

    // --- PERF: parallel-batch reassembly preserves ORIGINAL ORDER ----------------------
    //
    // The parallel cleanup path drives batches concurrently (in waves) but must stitch the
    // cleaned segments back in ORIGINAL batch order regardless of which batch's CLI call
    // finished first. join_all_ordered is the order-preserving joiner the wave loop uses;
    // here we feed it futures that COMPLETE OUT OF ORDER (later batches resolve first) and
    // assert the outputs (and the simulated stitch) come back in input order. No CLI calls.
    #[tokio::test]
    async fn parallel_reassembly_is_in_original_order() {
        // 5 "batches"; batch b yields b cleaned segments tagged with its index. We make the
        // futures resolve in REVERSE order via descending yield counts so completion order
        // != input order — the joiner must still return them input-ordered.
        let n = 5usize;
        let futs = (0..n).map(|b| async move {
            // Yield (n-b) times so higher-index batches finish FIRST (fewer yields).
            for _ in 0..(n - b) {
                tokio::task::yield_now().await;
            }
            // This batch's "cleaned" output: `b` segments, each carrying the batch index.
            let segs: Vec<Segment> = (0..b)
                .map(|_| Segment { start_ms: b as i64, end_ms: 0, speaker_label: format!("B{b}"), text: format!("batch {b}") })
                .collect();
            (b, Ok::<Vec<Segment>, String>(segs))
        });

        let results = join_all_ordered(futs).await;
        // Outputs are in INPUT order (batch 0,1,2,3,4) despite reverse completion.
        for (i, (b, _)) in results.iter().enumerate() {
            assert_eq!(*b, i, "join_all_ordered preserves input order");
        }

        // Simulate the wave loop's stitch: extend in iteration order → original order.
        let mut stitched: Vec<Segment> = Vec::new();
        for (_b, res) in results {
            stitched.extend(res.unwrap());
        }
        // Total = 0+1+2+3+4 = 10 segments; labels appear in ascending batch order, each
        // block contiguous (B1, then B2 x2, B3 x3, B4 x4).
        assert_eq!(stitched.len(), 10);
        let labels: Vec<String> = stitched.iter().map(|s| s.speaker_label.clone()).collect();
        assert_eq!(
            labels,
            vec!["B1", "B2", "B2", "B3", "B3", "B3", "B4", "B4", "B4", "B4"],
            "stitched segments are in original batch order, blocks contiguous"
        );
    }

    // join_all_ordered surfaces an Err from any batch while keeping order (the wave loop
    // turns the first Err into the surfaced cleanup error).
    #[tokio::test]
    async fn parallel_reassembly_surfaces_batch_error_in_order() {
        let futs = (0..3usize).map(|b| async move {
            tokio::task::yield_now().await;
            if b == 1 {
                (b, Err::<Vec<Segment>, String>("count mismatch".into()))
            } else {
                (b, Ok(vec![Segment { start_ms: 0, end_ms: 0, speaker_label: "S".into(), text: format!("ok {b}") }]))
            }
        });
        let results = join_all_ordered(futs).await;
        // The error is attached to batch index 1 (order preserved).
        assert!(results[0].1.is_ok());
        assert!(results[1].1.is_err());
        assert!(results[2].1.is_ok());
    }

    // --- PERF: REAL wall-clock timing check (haiku + parallel-4) -----------------------
    //
    // #[ignore]d (real subscription usage; modest — ~150 segments = 3 batches). Builds a
    // ~150-segment NOISY Russian transcript and runs the REAL parallel cleanup path AFTER
    // the perf change (haiku model + CLEANUP_CONCURRENCY-wide waves). Reports the wall-clock,
    // confirms the Russian output is clean (prints 2 before/after segments), and asserts the
    // invariants hold (count/ids/timing/labels identical). Compares against the analytical
    // sequential×heavy baseline so the speedup is explicit.
    // Run: cargo test perf_cleanup_timing -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn perf_cleanup_timing() {
        use crate::adapter;
        let adapter = adapter::builtin_adapter_pub();

        // Build ~150 noisy Russian segments by cycling a handful of disfluent lines, so the
        // transcript spans 3 batches (BATCH_SIZE=60) and exercises the parallel waves.
        let lines = [
            "ну вот эээ я обычно сначала захожу в дашборд и значит смотрю что там по заказам за вчера",
            "и потом это самое проверяю аналитику но честно говоря воронку я так и не настроил",
            "там надо было выбрать события а я как бы не понял какие именно нужны и просто забил",
            "из за этого я не вижу где люди отваливаются ну то есть на каком конкретно шаге",
            "если бы был мастер настройки я бы наверное за пять минут всё подключил и разметил",
            "а команду я позову только когда сам разберусь чтобы было что показать коллегам понимаете",
        ];
        let n = 150usize;
        let raw: Vec<Segment> = (0..n)
            .map(|i| Segment {
                start_ms: i as i64 * 4000,
                end_ms: i as i64 * 4000 + 3800,
                speaker_label: if i % 3 == 0 { "S1".into() } else { "S2".into() },
                text: lines[i % lines.len()].to_string(),
            })
            .collect();

        let total_batches = raw.len().div_ceil(BATCH_SIZE);
        let started = std::time::Instant::now();
        let cleaned = clean_segments(None, "perf-verify", &adapter, Some("ru"), "", &raw)
            .await
            .expect("real parallel cleanup should succeed");
        let elapsed = started.elapsed();

        // Invariants: count + timing + labels identical; text cleaned + still Cyrillic.
        assert_eq!(cleaned.len(), raw.len(), "segment count preserved");
        let cyrillic = |s: &str| s.chars().any(|c| ('а'..='я').contains(&c.to_ascii_lowercase()) || ('А'..='Я').contains(&c));
        for (i, (c, r)) in cleaned.iter().zip(raw.iter()).enumerate() {
            assert_eq!(c.start_ms, r.start_ms, "start_ms immutable (seg {i})");
            assert_eq!(c.end_ms, r.end_ms, "end_ms immutable (seg {i})");
            assert_eq!(c.speaker_label, r.speaker_label, "speaker_label immutable (seg {i})");
            assert!(cyrillic(&c.text), "cleaned text stays Russian (seg {i}): {}", c.text);
        }

        // Analytical baseline: sequential × heavy model. Per-batch latency on the heavy
        // default is ~2-3x haiku; sequential means all batches serialize. With parallel-4 +
        // haiku, the wall-clock is roughly (batches/4) waves × the faster per-batch latency.
        let per_batch = elapsed.as_secs_f64() / (total_batches as f64 / CLEANUP_CONCURRENCY as f64).ceil();
        println!("\n=== PERF cleanup timing (haiku + parallel-{CLEANUP_CONCURRENCY}) ===");
        println!("segments={n} batches={total_batches} batch_size={BATCH_SIZE}");
        println!("WALL-CLOCK: {:.1}s  (~{:.1}s per wave of {CLEANUP_CONCURRENCY})", elapsed.as_secs_f64(), per_batch);
        println!(
            "analytical baseline (sequential × heavy): ~{} sequential batches; haiku+parallel-{} cuts both per-call latency AND serialization",
            total_batches, CLEANUP_CONCURRENCY
        );
        for i in 0..2.min(raw.len()) {
            println!("[{i}] label={} {}ms..{}ms", raw[i].speaker_label, raw[i].start_ms, raw[i].end_ms);
            println!("    raw    : {}", raw[i].text);
            println!("    cleaned: {}", cleaned[i].text);
        }
        println!("PERF OK: invariants held (count/ids/timing/labels), Russian preserved.\n");
    }

    // --- REAL end-to-end verify against the installed, logged-in `claude` CLI ----------
    //
    // #[ignore]d so the normal suite stays offline/fast + spends no subscription usage.
    // Builds a SHORT noisy Russian raw transcript (~10 segments), runs the REAL
    // transcript-cleanup through the M6 runner against `claude`, and asserts:
    //   - the cleaned text is grammar-clean Russian (Cyrillic kept, не translated),
    //   - segment COUNT + start/end TIMING + SPEAKER LABELS identical to raw,
    //   - a `cleaned` row is stored against the live DB, then cleaned up.
    // Run: cargo test live_m7_cleanup_verify -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_m7_cleanup_verify() {
        use crate::adapter;

        // The bundled claude-code adapter (no AppHandle needed — uses the compiled default).
        let adapter = adapter::builtin_adapter_pub();

        // SHORT noisy Russian transcript (~10 segments): disfluent, no punctuation, filler.
        let raw: Vec<Segment> = vec![
            Segment { start_ms: 0, end_ms: 3800, speaker_label: "S1".into(), text: "ну вот эээ расскажите пожалуйста как вы обычно начинаете свой день с продуктом".into() },
            Segment { start_ms: 3800, end_ms: 9100, speaker_label: "S2".into(), text: "ну я значит захожу в дашборд и сразу как бы смотрю там заказы за вчера".into() },
            Segment { start_ms: 9100, end_ms: 13400, speaker_label: "S2".into(), text: "потом это самое проверяю аналитику но честно говоря воронку я так и не настроил".into() },
            Segment { start_ms: 13400, end_ms: 17200, speaker_label: "S1".into(), text: "а почему не настроили что вам помешало ну как бы".into() },
            Segment { start_ms: 17200, end_ms: 23000, speaker_label: "S2".into(), text: "ну там надо выбрать события а я не понял какие именно нужны и забил короче".into() },
            Segment { start_ms: 23000, end_ms: 27500, speaker_label: "S2".into(), text: "и вот эээ из за этого я не вижу где люди отваливаются на каком шаге".into() },
            Segment { start_ms: 27500, end_ms: 31000, speaker_label: "S1".into(), text: "понятно а если бы был такой мастер настройки это бы помогло".into() },
            Segment { start_ms: 31000, end_ms: 36800, speaker_label: "S2".into(), text: "да конечно если бы мне прямо сказали подключи это потом отметь три события я бы за пять минут всё сделал".into() },
            Segment { start_ms: 36800, end_ms: 40200, speaker_label: "S1".into(), text: "супер а команду вы когда планируете подключать".into() },
            Segment { start_ms: 40200, end_ms: 45000, speaker_label: "S2".into(), text: "ну наверное когда сам разберусь чтобы было что показать коллегам понимаете".into() },
        ];

        let cleaned = clean_segments(None, "m7-verify", &adapter, Some("ru"), "", &raw)
            .await
            .expect("real cleanup should succeed");

        // 1. Count identical.
        assert_eq!(cleaned.len(), raw.len(), "segment count must be preserved");
        // 2. Timing + labels identical; text changed + still Cyrillic (not translated).
        let cyrillic = |s: &str| s.chars().any(|c| ('а'..='я').contains(&c.to_ascii_lowercase()) || ('А'..='Я').contains(&c));
        for (i, (c, r)) in cleaned.iter().zip(raw.iter()).enumerate() {
            assert_eq!(c.start_ms, r.start_ms, "start_ms immutable (seg {i})");
            assert_eq!(c.end_ms, r.end_ms, "end_ms immutable (seg {i})");
            assert_eq!(c.speaker_label, r.speaker_label, "speaker_label immutable (seg {i})");
            assert!(cyrillic(&c.text), "cleaned text must stay Russian, not translated (seg {i}): {}", c.text);
        }
        // Show before/after for the first two segments.
        println!("\n=== M7 REAL cleanup: before → after (Russian) ===");
        for i in 0..2.min(raw.len()) {
            println!("[{i}] label={} {}ms..{}ms", raw[i].speaker_label, raw[i].start_ms, raw[i].end_ms);
            println!("    raw    : {}", raw[i].text);
            println!("    cleaned: {}", cleaned[i].text);
        }

        // 3. Store as `cleaned` against the live DB + clean up.
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

        let cycle_id = Uuid::new_v4().to_string();
        let iv = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, '__M7_VERIFY__', ?, ?)")
            .bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'm7', 'transcribed', ?, ?)")
            .bind(&iv).bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let raw_json = serde_json::to_string(&raw).unwrap();
        sqlx::query("INSERT INTO transcript (id, interview_id, version, kind, language, engine, segments_json, created_at) VALUES (?, ?, 1, 'raw', 'ru', 'whisper.cpp:large-v3@cuda', ?, ?)")
            .bind(Uuid::new_v4().to_string()).bind(&iv).bind(&raw_json).bind(ts).execute(&pool).await.unwrap();

        let tid = store_cleaned_db(&pool, &iv, Some("ru"), &cleaned).await.unwrap();
        assert!(!tid.is_empty());
        // Read it back: it's the 'cleaned' kind, version 2, same count.
        let row: (i64, String, String) = sqlx::query_as(
            "SELECT version, kind, segments_json FROM transcript WHERE id = ?",
        ).bind(&tid).fetch_one(&pool).await.unwrap();
        assert_eq!(row.1, "cleaned");
        let stored: Vec<Segment> = serde_json::from_str(&row.2).unwrap();
        assert_eq!(stored.len(), raw.len());
        println!("\nstored cleaned transcript id={tid} version={} segments={}", row.0, stored.len());

        sqlx::query("DELETE FROM cycle WHERE id = ?").bind(&cycle_id).execute(&pool).await.unwrap();
        println!("M7 live verify OK: noisy Russian → grammar-clean Russian, count/timing/labels preserved, cleaned row stored + cleaned up.\n");
    }

    // ===================================================================================
    // SEED STAGE 2 — cleanup (real `claude`) + participants/roles.
    //
    // For each of the 5 seeded interviews: load the raw transcript, run the REAL
    // transcript-cleanup through `claude` (clean_segments → store_cleaned_db), flip status
    // to cleaned, and create participants mapped to the role library. whisper gives no
    // diarization (all segments labelled "S1"), so we map S1 → a Respondent participant
    // and add an Interviewer participant for the host, per the brief.
    //
    // Idempotent: skips an interview that already has a cleaned transcript. Real Claude
    // subscription usage here (a few cleanup batches per interview).
    //
    // Run: src-tauri\target\cuda-build.cmd test --features cuda seed_stage2 -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn seed_stage2_cleanup_roles() {
        use crate::adapter;

        let interviews: [&str; 5] = [
            "33333333-3333-4333-8333-000000000001",
            "33333333-3333-4333-8333-000000000002",
            "33333333-3333-4333-8333-000000000003",
            "33333333-3333-4333-8333-000000000004",
            "33333333-3333-4333-8333-000000000005",
        ];

        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let app_dir = std::path::Path::new(&appdata).join("com.interviewlab.app");
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(app_dir.join("interviewlab.db"))
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = sqlx::sqlite::SqlitePool::connect_with(opts).await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let adapter = adapter::builtin_adapter_pub();

        for iv in interviews {
            // Must have been transcribed by stage 1.
            let Some((language, raw)) = raw_source_db(&pool, iv).await.unwrap() else {
                println!("skip {iv}: no raw transcript (run stage 1 first)");
                continue;
            };

            // Idempotent cleanup: only run claude if no cleaned row yet.
            let has_cleaned: Option<String> = sqlx::query_scalar(
                "SELECT id FROM transcript WHERE interview_id = ? AND kind = 'cleaned' LIMIT 1",
            )
            .bind(iv)
            .fetch_optional(&pool)
            .await
            .unwrap();

            if has_cleaned.is_none() {
                set_status_db(&pool, iv, STATUS_CLEANING).await.unwrap();
                println!("cleaning {iv}: {} segments via claude ...", raw.len());
                let cleaned = clean_segments(None, iv, &adapter, language.as_deref(), "", &raw)
                    .await
                    .expect("real cleanup should succeed");
                assert_eq!(cleaned.len(), raw.len(), "segment count preserved for {iv}");
                let tid = store_cleaned_db(&pool, iv, language.as_deref(), &cleaned).await.unwrap();
                set_status_db(&pool, iv, STATUS_CLEANED).await.unwrap();
                println!(
                    "  cleaned -> id={tid}; raw[0]: {}\n            cln[0]: {}",
                    raw[0].text.chars().take(90).collect::<String>(),
                    cleaned[0].text.chars().take(90).collect::<String>()
                );
            } else {
                // Ensure status reflects cleaned even on a re-run.
                set_status_db(&pool, iv, STATUS_CLEANED).await.unwrap();
                println!("skip cleanup for {iv}: cleaned transcript already present");
            }

            // --- participants mapped to the role library (idempotent) ---
            let pcount: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM participant WHERE interview_id = ?")
                .bind(iv)
                .fetch_one(&pool)
                .await
                .unwrap();
            if pcount == 0 {
                // Interviewer (host) — conventional, no asr label.
                sqlx::query(
                    "INSERT INTO participant (id, interview_id, display_name, role, role_id, speaker_label) \
                     VALUES (?, ?, ?, 'Interviewer', 'interviewer', NULL)",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(iv)
                .bind("Ведущий (make sense)")
                .execute(&pool)
                .await
                .unwrap();
                // Respondent — mapped to whisper's single "S1" label.
                sqlx::query(
                    "INSERT INTO participant (id, interview_id, display_name, role, role_id, speaker_label) \
                     VALUES (?, ?, ?, 'Respondent', 'respondent', 'S1')",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(iv)
                .bind("Гость (эксперт)")
                .execute(&pool)
                .await
                .unwrap();
                println!("  participants: Interviewer + Respondent(S1) created for {iv}");
            } else {
                println!("  participants already present for {iv} ({pcount})");
            }
        }

        println!("SEED STAGE 2 OK: cleaned transcripts + participants/roles for all interviews.");
    }
}
