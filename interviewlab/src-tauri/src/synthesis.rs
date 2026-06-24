// Cycle synthesis — TWO editable artifacts per wave (Milestone 8 + M10b, spec §8 / §7.3.2
// and feature-roles-and-guides.md §3).
//
// M8 produced ONE cycle-level findings JSON. M10b reworks synthesis into two first-class,
// USER-EDITABLE levels, both grounded on the guide's stable GOALS:
//
//   PER-INTERVIEW summary (the MAP stage, now STORED + viewable + editable): a concise
//     summary of ONE interview structured by the guide's goals (per goal: key points +
//     supporting quotes with segment refs) + notable quotes / surprises. Shown in the
//     transcript editor's "Summary" section with Run/Regenerate + edit + Save.
//
//   CYCLE synthesis (the REDUCE stage): ONE editable MARKDOWN artifact assembled across the
//     per-interview summaries following the guide structure — Executive summary → per goal
//     (finding + confidence + evidence quotes w/ interview refs + recommendation) → optional
//     by-role breakdown. Stored BOTH as `content_md` (the human-editable artifact, rendered/
//     edited via the Plate `.md` editor) AND as the structured `findings_json` (goal_id-tagged
//     findings) so M9's findings-level diff keeps comparing wave-over-wave by goal.
//
// The pipeline still reuses the M6 runner (adapter::run_cli_task) with output JSON schemas:
//   MAP   `cycle-synthesis-extract` — pull goal-relevant points from one interview, each
//         point carrying short verbatim quotes + the segment id they came from. We now ALSO
//         persist each interview's extraction as the per-interview summary artifact.
//   REDUCE `cycle-synthesis-reduce` — given the goals + every interview's points, produce
//         cross-interview FINDINGS (goal_id, statement, confidence, support_count, evidence,
//         recommendation) + an optional by-role breakdown. From those we (a) store the
//         structured doc and (b) render the editable `content_md` markdown report server-side.
//
// GOALS & STABILITY (spec §2 / §8, M9 diff): goals are DERIVED DETERMINISTICALLY from the
// cycle's effective guide ("Goals:" bullets) with positional ids G1, G2, …  Same guide →
// same goal_ids across waves, which the M9 diff aligns on. The goals used are persisted
// inside the cycle row's `findings_json` (alongside findings) so the diff reads them back.
//
// Server-side invariants (NOT trusted from the model), mirroring cleanup.rs's discipline:
//   - every finding's `goal_id` must be one of the derived goals (unknown ids dropped),
//   - evidence refs are clamped to interviews/segments that actually exist (bad refs dropped),
//   - findings ids are re-stamped F1..Fn server-side so they're stable + unique.
//
// Conventions mirror cleanup.rs / transcript.rs: typed structs, parameterized SQL, each
// #[tauri::command] a thin wrapper over a testable helper; the assembly/validation/markdown
// logic is pure and unit-tested with stubbed CLI output. Cuts are marked `// ponytail:`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::Emitter;
use uuid::Uuid;

use crate::transcript::Segment;
use crate::Db;

// Tauri event the Synthesis tab subscribes to for stage progress.
pub const SYNTHESIS_PROGRESS_EVENT: &str = "synthesis://progress";
// Tauri event the per-interview Summary section subscribes to.
pub const INTERVIEW_SUMMARY_PROGRESS_EVENT: &str = "interview-summary://progress";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// PERF: synthesis needs reasoning (cross-interview extraction + reduction), but not the
// CLI's heaviest default model — `sonnet` balances quality and speed for both the MAP
// (per-interview extraction, where extraction quality matters) and the REDUCE. Injected
// per task as `--model sonnet` through the adapter. A single tunable constant.
const SYNTHESIS_MODEL: &str = "sonnet";

// PERF: how many per-interview MAP extractions run concurrently. The MAP stage used to run
// interviews STRICTLY SEQUENTIALLY (one `claude` call per interview, in series). We now run
// up to this many at once, in waves. Conservative (4) to respect the user's Claude
// subscription rate limits — never an unbounded fan-out. A single tunable constant.
const SYNTHESIS_CONCURRENCY: usize = 4;

// Drive a set of futures concurrently to completion, returning outputs in INPUT order (not
// completion order). ponytail: a small hand-rolled poller — we already depend on tokio, so
// this avoids the `futures` crate just for `join_all`. Bounded by the wave width.
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

// --- goals (derived from the guide; stable ids for the M9 diff) ----------------

// A discrete research goal: a stable id (G1, G2, …) + its text. Serialized into the
// synthesis output so the diff (M9) can align findings by goal.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Goal {
    pub id: String,
    pub text: String,
}

// Parse the cycle's guide markdown into discrete goals. Deterministic so the same guide
// always yields the same ids across waves (M9 diff stability).
//
// Heuristic (kept deliberately simple, ponytail): collect bullet/numbered lines that sit
// under a "Goals" heading; if the guide already labels them "G1: …" we keep that label,
// otherwise we assign positional ids G1, G2, …  We stop at a blank line following the
// goals block or at a different heading (e.g. "Target conclusions:"). If no "Goals"
// heading is found, we fall back to every bullet line in the guide. If nothing parses,
// the whole guide becomes a single goal G1 (synthesis still runs, grounded on the guide).
pub fn derive_goals(guide: &str) -> Vec<Goal> {
    let lines: Vec<&str> = guide.lines().collect();

    // Find a "Goals" heading line (e.g. "Goals:", "## Goals").
    let goals_start = lines.iter().position(|l| {
        let t = l.trim().trim_start_matches('#').trim().to_lowercase();
        t == "goals" || t == "goals:" || t.starts_with("goals:")
    });

    // A line is a bullet/numbered item we treat as a goal entry.
    let bullet_text = |line: &str| -> Option<String> {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("- ") {
            return Some(rest.trim().to_string());
        }
        if let Some(rest) = t.strip_prefix("* ") {
            return Some(rest.trim().to_string());
        }
        // "1." / "1)" numbered list.
        if let Some(dot) = t.find(['.', ')']) {
            let (num, rest) = t.split_at(dot);
            if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
                return Some(rest[1..].trim().to_string());
            }
        }
        None
    };

    let mut raw_goals: Vec<String> = Vec::new();

    if let Some(start) = goals_start {
        // Collect bullets after the Goals heading until a blank-after-content or a new
        // non-bullet heading line (e.g. "Target conclusions:").
        let mut seen_any = false;
        for line in lines.iter().skip(start + 1) {
            let trimmed = line.trim();
            if let Some(g) = bullet_text(line) {
                if !g.is_empty() {
                    raw_goals.push(g);
                    seen_any = true;
                }
            } else if trimmed.is_empty() {
                if seen_any {
                    break; // blank line ends the goals block
                }
                // leading blank before the first bullet — keep scanning
            } else {
                // A non-bullet, non-blank line after we've started collecting ends the block
                // (e.g. "Target conclusions:"). Before any bullet, keep scanning.
                if seen_any {
                    break;
                }
            }
        }
    }

    // Fallback 1: no "Goals" heading (or none collected) → every bullet line in the guide.
    if raw_goals.is_empty() {
        for line in &lines {
            if let Some(g) = bullet_text(line) {
                if !g.is_empty() {
                    raw_goals.push(g);
                }
            }
        }
    }

    // Fallback 2: still nothing → the whole (trimmed) guide is a single goal, so synthesis
    // is at least grounded on the guide text rather than free-floating.
    if raw_goals.is_empty() {
        let whole = guide.trim();
        if !whole.is_empty() {
            raw_goals.push(whole.to_string());
        }
    }

    // Assign stable ids. If a line already starts with an explicit "G<number>" tag (the
    // spec's "G1: …" convention), reuse that exact tag so re-parsing/edits keep the id;
    // otherwise use the positional G<index>.
    raw_goals
        .into_iter()
        .enumerate()
        .map(|(i, text)| {
            let (id, text) = split_explicit_id(&text)
                .unwrap_or_else(|| (format!("G{}", i + 1), text.clone()));
            Goal { id, text }
        })
        .collect()
}

// If a goal line begins with an explicit "G<n>" id (e.g. "G1: …", "G2 - …", "G3 …"),
// return (id, remaining text). Keeps researcher-authored ids stable across edits.
fn split_explicit_id(text: &str) -> Option<(String, String)> {
    let t = text.trim();
    let bytes = t.as_bytes();
    if bytes.first().map(|b| b.to_ascii_uppercase()) != Some(b'G') {
        return None;
    }
    // Count the run of digits after the leading G.
    let digits_end = 1 + t[1..].chars().take_while(|c| c.is_ascii_digit()).count();
    if digits_end == 1 {
        return None; // "G" not followed by a digit → not an id tag
    }
    let id = format!("G{}", &t[1..digits_end]);
    // Strip an optional separator (":", "-", "—", whitespace) after the id.
    let rest = t[digits_end..]
        .trim_start()
        .trim_start_matches([':', '-', '—'])
        .trim()
        .to_string();
    let rest = if rest.is_empty() { t.to_string() } else { rest };
    Some((id, rest))
}

// --- input shapes (what we feed the CLI per stage) ----------------------------

// One transcript segment handed to the model with a stable id + the speaker's ROLE
// (joined from participant via speaker_label). Role context matters: the model must
// weight respondent statements over interviewer prompts (spec §8.2).
#[derive(Serialize, Clone, Debug)]
struct RoleSegment {
    id: usize, // index within THIS interview's transcript (stable, for evidence refs)
    speaker_role: String,
    text: String,
}

// One interview's gathered transcript: id/title + role-labeled segments.
#[derive(Serialize, Clone, Debug)]
struct InterviewInput {
    id: String,
    title: String,
    segments: Vec<RoleSegment>,
}

// --- MAP stage output (per-interview extraction) ------------------------------

// One extracted point from a single interview, tied to a goal, with quote evidence.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
struct ExtractedPoint {
    goal_id: String,
    point: String,
    #[serde(default)]
    quotes: Vec<ExtractedQuote>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
struct ExtractedQuote {
    segment_id: usize,
    #[serde(default)]
    quote: String,
}

#[derive(Deserialize, Debug, Default)]
struct ExtractOutput {
    #[serde(default)]
    points: Vec<ExtractedPoint>,
    // M10b: the model may also surface notable quotes / surprises not tied to a single goal.
    #[serde(default)]
    notable: Vec<NotableQuote>,
}

// A notable quote / surprise from one interview (not necessarily goal-bound). Part of the
// per-interview summary artifact.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct NotableQuote {
    #[serde(default)]
    pub segment_id: usize,
    #[serde(default)]
    pub quote: String,
    #[serde(default)]
    pub note: String,
}

// A per-interview extraction result we carry into the reduce stage.
#[derive(Serialize, Clone, Debug)]
struct InterviewExtraction {
    interview_id: String,
    title: String,
    points: Vec<ExtractedPoint>,
}

// --- PER-INTERVIEW summary artifact (M10b, stored + editable) -----------------

// One goal section in a per-interview summary: the goal + the key points it surfaced (each
// with supporting quotes + segment refs).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct InterviewGoalSummary {
    pub goal_id: String,
    pub points: Vec<InterviewPoint>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct InterviewPoint {
    pub point: String,
    #[serde(default)]
    pub quotes: Vec<InterviewQuote>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct InterviewQuote {
    pub segment_id: usize,
    #[serde(default)]
    pub quote: String,
}

// The full per-interview summary doc stored in synthesis.findings_json for a per-interview
// row (interview_id set). Carries the goals used (for grouped rendering) + per-goal points +
// notable quotes/surprises.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct InterviewSummaryDoc {
    pub goals: Vec<Goal>,
    pub by_goal: Vec<InterviewGoalSummary>,
    #[serde(default)]
    pub notable: Vec<NotableQuote>,
}

// The per-interview summary row returned to the frontend (parsed doc + the editable
// markdown rendering + meta).
#[derive(Serialize, Clone, Debug)]
pub struct InterviewSummaryRow {
    pub id: String,
    pub cycle_id: String,
    pub interview_id: String,
    pub doc: InterviewSummaryDoc,
    pub content_md: String,
    pub model_meta: Option<String>,
    pub created_at: i64,
}

// --- REDUCE stage output (the findings, §7.3.2 + by-role breakdown) ------------

// One evidence reference on a finding: which interview + which segment it came from,
// plus the short verbatim quote (so findings are traceable in the UI).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Evidence {
    pub interview_id: String,
    pub segment_id: usize,
    #[serde(default)]
    pub quote: String,
}

// One finding as the model returns it (id is re-stamped server-side, so accepted-but-
// ignored here). Mirrors the §7.3.2 output shape.
#[derive(Deserialize, Debug)]
struct RawFinding {
    goal_id: String,
    #[serde(default)]
    statement: String,
    #[serde(default)]
    confidence: String,
    #[serde(default)]
    support_count: i64,
    #[serde(default)]
    evidence: Vec<Evidence>,
    #[serde(default)]
    recommendation: String,
}

// One by-role note as the model returns it: what a particular role said about a goal.
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
pub struct RoleNote {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub note: String,
}

// A by-goal grouping of by-role notes (the optional "by-role breakdown", §3 / feedback).
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
pub struct RoleBreakdownGroup {
    #[serde(default)]
    pub goal_id: String,
    #[serde(default)]
    pub notes: Vec<RoleNote>,
}

#[derive(Deserialize, Debug, Default)]
struct ReduceOutput {
    #[serde(default)]
    executive_summary: String,
    #[serde(default)]
    findings: Vec<RawFinding>,
    #[serde(default)]
    open_questions: Vec<String>,
    #[serde(default)]
    by_role: Vec<RoleBreakdownGroup>,
}

// A validated, server-stamped finding stored in synthesis.findings_json (§7.3.2 shape).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Finding {
    pub id: String, // re-stamped F1..Fn server-side
    pub goal_id: String,
    pub statement: String,
    pub confidence: String, // 'high' | 'medium' | 'low' (free-form, surfaced as a badge)
    pub support_count: i64,
    pub evidence: Vec<Evidence>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub recommendation: String,
}

// The full synthesis document stored in the cycle row's synthesis.findings_json. Carries the
// GOALS used (for the M9 diff + grouped UI) alongside the findings, open questions, the
// executive summary, and the optional by-role breakdown (M10b).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct SynthesisDoc {
    pub goals: Vec<Goal>,
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub open_questions: Vec<String>,
    // M10b additions (default so older M8 rows still deserialize cleanly).
    #[serde(default)]
    pub executive_summary: String,
    #[serde(default)]
    pub by_role: Vec<RoleBreakdownGroup>,
}

// The cycle synthesis row returned to the frontend (parsed doc + the editable markdown
// artifact + meta).
#[derive(Serialize, Clone, Debug)]
pub struct SynthesisRow {
    pub id: String,
    pub cycle_id: String,
    pub doc: SynthesisDoc,
    pub content_md: String,
    pub model_meta: Option<String>,
    pub created_at: i64,
}

// --- output JSON schemas handed to the CLI (--json-schema → structured_output) -

fn extract_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["points", "notable"],
        "properties": {
            "points": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["goal_id", "point", "quotes"],
                    "properties": {
                        "goal_id": { "type": "string" },
                        "point": { "type": "string" },
                        "quotes": {
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
                        }
                    }
                }
            },
            "notable": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["segment_id", "quote", "note"],
                    "properties": {
                        "segment_id": { "type": "integer" },
                        "quote": { "type": "string" },
                        "note": { "type": "string" }
                    }
                }
            }
        }
    })
}

fn reduce_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["executive_summary", "findings", "open_questions", "by_role"],
        "properties": {
            "executive_summary": { "type": "string" },
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["goal_id", "statement", "confidence", "support_count", "evidence", "recommendation"],
                    "properties": {
                        "goal_id": { "type": "string" },
                        "statement": { "type": "string" },
                        "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
                        "support_count": { "type": "integer" },
                        "evidence": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["interview_id", "segment_id", "quote"],
                                "properties": {
                                    "interview_id": { "type": "string" },
                                    "segment_id": { "type": "integer" },
                                    "quote": { "type": "string" }
                                }
                            }
                        },
                        "recommendation": { "type": "string" }
                    }
                }
            },
            "open_questions": { "type": "array", "items": { "type": "string" } },
            "by_role": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["goal_id", "notes"],
                    "properties": {
                        "goal_id": { "type": "string" },
                        "notes": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["role", "note"],
                                "properties": {
                                    "role": { "type": "string" },
                                    "note": { "type": "string" }
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

// --- prompt inputs ------------------------------------------------------------

fn build_extract_input(
    product_desc: &str,
    goals: &[Goal],
    interview: &InterviewInput,
) -> Value {
    json!({
        "task": "cycle-synthesis-extract",
        "instructions": "You are summarizing ONE user-research interview, structured by the research goals. \
            For EACH goal, extract the concrete, goal-relevant points THIS interview supports. Attach short \
            VERBATIM quotes (a sentence or two, in the original language — never translate) and the `segment_id` \
            each quote came from. Weight RESPONDENT statements over interviewer prompts. Only include points \
            grounded in the transcript; if a goal has nothing, omit it. ALSO list any `notable` quotes or \
            surprises worth flagging (each with its `segment_id`, the `quote`, and a one-line `note`). Return \
            ONLY JSON matching the schema.",
        "product_desc": product_desc,
        "goals": goals,
        "interview": interview
    })
}

fn build_reduce_input(
    product_desc: &str,
    guide: &str,
    goals: &[Goal],
    extractions: &[InterviewExtraction],
) -> Value {
    json!({
        "task": "cycle-synthesis-reduce",
        "instructions": "You are synthesizing findings ACROSS all interviews in a research wave, FOLLOWING the \
            guide structure. Using the per-interview extracted points below, produce: (1) a 2-4 sentence \
            `executive_summary` of the wave; (2) cross-interview FINDINGS — each MUST be bound to one `goal_id` \
            from the goals list, carry a concise `statement`, a `confidence` (high|medium|low), a `support_count` \
            (how many interviews support it), `evidence` (the strongest verbatim quotes with their `interview_id` \
            + `segment_id`), and a short `recommendation`; (3) `open_questions` the wave did not resolve; and (4) \
            an optional `by_role` breakdown per goal (what each role — e.g. designers vs PMs — said), using the \
            speaker roles present in the transcripts. Confirm or refute the guide's target conclusions where the \
            evidence speaks to them. Every finding ties to a goal — no free-floating themes. Return ONLY JSON \
            matching the schema.",
        "product_desc": product_desc,
        "guide": guide,
        "goals": goals,
        "interviews": extractions
    })
}

// --- assembly / invariant enforcement (the heart of M8, pure + unit-tested) ---

// Build the final findings from the reduce output, enforcing the server-side invariants:
//   - drop findings whose goal_id isn't a known goal (the model can't invent goals),
//   - drop evidence refs to interviews/segments that don't exist (clamp to real refs),
//   - re-stamp finding ids F1..Fn (stable + unique, never trusted from the model),
//   - default a blank/invalid confidence to "medium".
//
// `valid_segments[interview_id]` = the count of segments that interview had, so a
// segment_id is valid iff 0 <= segment_id < count.
fn assemble_findings(
    goals: &[Goal],
    valid_segments: &HashMap<String, usize>,
    output: &ReduceOutput,
) -> Vec<Finding> {
    let goal_ids: std::collections::HashSet<&str> = goals.iter().map(|g| g.id.as_str()).collect();

    let mut findings = Vec::new();
    for raw in &output.findings {
        // Invariant 1: goal_id must be a real goal.
        if !goal_ids.contains(raw.goal_id.as_str()) {
            continue;
        }
        let statement = raw.statement.trim();
        if statement.is_empty() {
            continue; // a finding with no statement is noise
        }

        // Invariant 2: keep only evidence that points at a real interview + segment.
        let evidence: Vec<Evidence> = raw
            .evidence
            .iter()
            .filter(|e| {
                valid_segments
                    .get(&e.interview_id)
                    .is_some_and(|&n| e.segment_id < n)
            })
            .map(|e| Evidence {
                interview_id: e.interview_id.clone(),
                segment_id: e.segment_id,
                quote: e.quote.trim().to_string(),
            })
            .collect();

        let confidence = match raw.confidence.trim().to_lowercase().as_str() {
            "high" => "high",
            "low" => "low",
            _ => "medium",
        }
        .to_string();

        // support_count never below the number of distinct interviews cited (defensive).
        let cited_interviews: std::collections::HashSet<&str> =
            evidence.iter().map(|e| e.interview_id.as_str()).collect();
        let support_count = raw.support_count.max(cited_interviews.len() as i64).max(0);

        findings.push(Finding {
            id: String::new(), // stamped below
            goal_id: raw.goal_id.clone(),
            statement: statement.to_string(),
            confidence,
            support_count,
            evidence,
            recommendation: raw.recommendation.trim().to_string(),
        });
    }

    // Invariant 3: re-stamp ids F1..Fn (grouped by goal order for readable ids).
    findings.sort_by(|a, b| {
        let ga = goals.iter().position(|g| g.id == a.goal_id).unwrap_or(usize::MAX);
        let gb = goals.iter().position(|g| g.id == b.goal_id).unwrap_or(usize::MAX);
        ga.cmp(&gb)
    });
    for (i, f) in findings.iter_mut().enumerate() {
        f.id = format!("F{}", i + 1);
    }
    findings
}

// Keep only by-role groups whose goal_id is real; drop blank notes. Pure + unit-tested.
fn assemble_by_role(goals: &[Goal], output: &ReduceOutput) -> Vec<RoleBreakdownGroup> {
    let goal_ids: std::collections::HashSet<&str> = goals.iter().map(|g| g.id.as_str()).collect();
    output
        .by_role
        .iter()
        .filter(|g| goal_ids.contains(g.goal_id.as_str()))
        .filter_map(|g| {
            let notes: Vec<RoleNote> = g
                .notes
                .iter()
                .filter(|n| !n.note.trim().is_empty())
                .map(|n| RoleNote { role: n.role.trim().to_string(), note: n.note.trim().to_string() })
                .collect();
            if notes.is_empty() {
                None
            } else {
                Some(RoleBreakdownGroup { goal_id: g.goal_id.clone(), notes })
            }
        })
        .collect()
}

// --- editable markdown artifact rendering (pure + unit-tested) -----------------

// Render the CYCLE synthesis as the human-editable markdown report, following the guide
// structure: Executive summary → per goal (heading → findings with confidence + evidence
// quotes w/ interview refs + recommendation) → optional by-role breakdown. `title_for`
// resolves an interview_id to a readable title for evidence refs.
fn render_cycle_markdown(
    doc: &SynthesisDoc,
    title_for: &HashMap<String, String>,
) -> String {
    let mut md = String::new();
    md.push_str("# Cycle synthesis\n\n");

    // Executive summary.
    md.push_str("## Executive summary\n\n");
    if doc.executive_summary.trim().is_empty() {
        md.push_str("_No summary._\n\n");
    } else {
        md.push_str(doc.executive_summary.trim());
        md.push_str("\n\n");
    }

    // Per goal.
    for goal in &doc.goals {
        md.push_str(&format!("## {} · {}\n\n", goal.id, goal.text));
        let findings: Vec<&Finding> = doc.findings.iter().filter(|f| f.goal_id == goal.id).collect();
        if findings.is_empty() {
            md.push_str("_No findings surfaced for this goal in this wave._\n\n");
            continue;
        }
        for f in findings {
            md.push_str(&format!(
                "### {} — _{} confidence · {} interview{}_\n\n",
                f.statement.trim(),
                f.confidence,
                f.support_count,
                if f.support_count == 1 { "" } else { "s" }
            ));
            for e in &f.evidence {
                if e.quote.trim().is_empty() {
                    continue;
                }
                let who = title_for
                    .get(&e.interview_id)
                    .cloned()
                    .unwrap_or_else(|| e.interview_id.clone());
                md.push_str(&format!(
                    "> {}\n> — {} · segment {}\n\n",
                    e.quote.trim(),
                    who,
                    e.segment_id + 1
                ));
            }
            if !f.recommendation.trim().is_empty() {
                md.push_str(&format!("**Recommendation:** {}\n\n", f.recommendation.trim()));
            }
        }
    }

    // Optional by-role breakdown.
    if !doc.by_role.is_empty() {
        md.push_str("## By role\n\n");
        for group in &doc.by_role {
            let goal_text = doc
                .goals
                .iter()
                .find(|g| g.id == group.goal_id)
                .map(|g| g.text.clone())
                .unwrap_or_default();
            md.push_str(&format!("### {} · {}\n\n", group.goal_id, goal_text));
            for n in &group.notes {
                let role = if n.role.trim().is_empty() { "Role" } else { n.role.trim() };
                md.push_str(&format!("- **{}:** {}\n", role, n.note.trim()));
            }
            md.push('\n');
        }
    }

    // Open questions.
    if !doc.open_questions.is_empty() {
        md.push_str("## Open questions\n\n");
        for q in &doc.open_questions {
            md.push_str(&format!("- {}\n", q.trim()));
        }
        md.push('\n');
    }

    md.trim_end().to_string()
}

// Build the per-interview summary doc from one interview's extraction, enforcing invariants
// (goal_id real, segment refs in range) + grouping points by goal in goal order. Pure.
fn assemble_interview_summary(
    goals: &[Goal],
    segment_count: usize,
    output: &ExtractOutput,
) -> InterviewSummaryDoc {
    // Group points by goal (in goal order). Iterating only the real goals enforces the
    // "goal_id must be known" invariant — points under an unknown goal are simply dropped.
    let mut by_goal: Vec<InterviewGoalSummary> = Vec::new();
    for goal in goals {
        let mut points: Vec<InterviewPoint> = Vec::new();
        for p in &output.points {
            if p.goal_id != goal.id {
                continue;
            }
            let text = p.point.trim();
            if text.is_empty() {
                continue;
            }
            let quotes: Vec<InterviewQuote> = p
                .quotes
                .iter()
                .filter(|q| q.segment_id < segment_count)
                .map(|q| InterviewQuote { segment_id: q.segment_id, quote: q.quote.trim().to_string() })
                .collect();
            points.push(InterviewPoint { point: text.to_string(), quotes });
        }
        if !points.is_empty() {
            by_goal.push(InterviewGoalSummary { goal_id: goal.id.clone(), points });
        }
    }

    // notable: keep in-range refs + a non-empty quote or note.
    let notable: Vec<NotableQuote> = output
        .notable
        .iter()
        .filter(|n| n.segment_id < segment_count && !(n.quote.trim().is_empty() && n.note.trim().is_empty()))
        .map(|n| NotableQuote {
            segment_id: n.segment_id,
            quote: n.quote.trim().to_string(),
            note: n.note.trim().to_string(),
        })
        .collect();

    InterviewSummaryDoc { goals: goals.to_vec(), by_goal, notable }
}

// Render a per-interview summary as editable markdown: per goal (heading → points with
// supporting quotes) → notable quotes/surprises. Pure + unit-tested.
fn render_interview_markdown(doc: &InterviewSummaryDoc, title: &str) -> String {
    let mut md = String::new();
    md.push_str(&format!("# Summary · {}\n\n", title.trim()));

    if doc.by_goal.is_empty() {
        md.push_str("_No goal-relevant points were extracted from this interview._\n\n");
    }
    for goal in &doc.goals {
        let Some(group) = doc.by_goal.iter().find(|g| g.goal_id == goal.id) else {
            continue;
        };
        md.push_str(&format!("## {} · {}\n\n", goal.id, goal.text));
        for p in &group.points {
            md.push_str(&format!("- {}\n", p.point.trim()));
            for q in &p.quotes {
                if q.quote.trim().is_empty() {
                    continue;
                }
                md.push_str(&format!("  > {} _(segment {})_\n", q.quote.trim(), q.segment_id + 1));
            }
        }
        md.push('\n');
    }

    if !doc.notable.is_empty() {
        md.push_str("## Notable quotes & surprises\n\n");
        for n in &doc.notable {
            if !n.quote.trim().is_empty() {
                md.push_str(&format!("> {} _(segment {})_\n", n.quote.trim(), n.segment_id + 1));
            }
            if !n.note.trim().is_empty() {
                md.push_str(&format!("- {}\n", n.note.trim()));
            }
            md.push('\n');
        }
    }

    md.trim_end().to_string()
}

// --- progress events ----------------------------------------------------------

#[derive(Serialize, Clone)]
struct SynthesisProgress {
    cycle_id: String,
    stage: String, // 'extract' | 'reduce' | 'done' | 'error'
    // Extract stage: which interview we're on / total interviews.
    done: usize,
    total: usize,
    progress: i32, // 0..100 overall
    error: Option<String>,
}

fn emit_progress(
    app: &tauri::AppHandle,
    cycle_id: &str,
    stage: &str,
    done: usize,
    total: usize,
    progress: i32,
    error: Option<String>,
) {
    let _ = app.emit(
        SYNTHESIS_PROGRESS_EVENT,
        SynthesisProgress {
            cycle_id: cycle_id.to_string(),
            stage: stage.to_string(),
            done,
            total,
            progress,
            error,
        },
    );
}

#[derive(Serialize, Clone)]
struct InterviewSummaryProgress {
    interview_id: String,
    stage: String, // 'running' | 'done' | 'error'
    progress: i32,
    error: Option<String>,
}

fn emit_summary_progress(app: &tauri::AppHandle, interview_id: &str, stage: &str, progress: i32, error: Option<String>) {
    let _ = app.emit(
        INTERVIEW_SUMMARY_PROGRESS_EVENT,
        InterviewSummaryProgress {
            interview_id: interview_id.to_string(),
            stage: stage.to_string(),
            progress,
            error,
        },
    );
}

// --- gathering inputs from the DB ---------------------------------------------

// The effective guide TEXT a cycle's synthesis is grounded on (M10a): prefer the linked
// guide's content_md when cycle.guide_id is set, else fall back to the inline cycle.guide
// text (back-compat). Goals are still derived from this text via derive_goals, so goal_ids
// stay stable whether they come from a library guide or the legacy inline column. Returns
// None if the cycle doesn't exist.
//
// pub(crate) so cycle_goals + run_synthesis (and tests) share one source of truth.
pub(crate) async fn effective_guide_db(pool: &SqlitePool, cycle_id: &str) -> Result<Option<String>, String> {
    let row: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT guide_id, guide FROM cycle WHERE id = ?")
            .bind(cycle_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let (guide_id, inline) = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    // Prefer the linked guide's content when present + non-empty.
    if let Some(gid) = guide_id.filter(|s| !s.is_empty()) {
        let content: Option<String> = sqlx::query_scalar("SELECT content_md FROM guide WHERE id = ?")
            .bind(&gid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(content) = content {
            if !content.trim().is_empty() {
                return Ok(Some(content));
            }
        }
    }
    Ok(Some(inline))
}

// The effective PRODUCT CONTEXT a cycle's pipeline is grounded on (Products library): prefer
// the linked product's content_md when cycle.product_id is set + non-empty, else fall back to
// the inline cycle.product_desc text (back-compat). Mirrors effective_guide_db exactly.
// Returns None if the cycle doesn't exist.
//
// pub(crate) so the ASR + cleanup + synthesis paths (and tests) share one source of truth for
// product context — req #2 "учет контекста продукта при расшифровке".
pub(crate) async fn effective_product_db(
    pool: &SqlitePool,
    cycle_id: &str,
) -> Result<Option<String>, String> {
    let row: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT product_id, product_desc FROM cycle WHERE id = ?")
            .bind(cycle_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let (product_id, inline) = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    // Prefer the linked product's content when present + non-empty.
    if let Some(pid) = product_id.filter(|s| !s.is_empty()) {
        let content: Option<String> = sqlx::query_scalar("SELECT content_md FROM product WHERE id = ?")
            .bind(&pid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(content) = content {
            if !content.trim().is_empty() {
                return Ok(Some(content));
            }
        }
    }
    Ok(Some(inline))
}

// Best transcript per interview: prefer edited → cleaned → raw (spec §8.2 "latest
// cleaned/edited"). Returns the segments of whichever exists, or None if the interview
// has no transcript yet (it's skipped from synthesis).
async fn best_transcript_db(
    pool: &SqlitePool,
    interview_id: &str,
) -> Result<Option<Vec<Segment>>, String> {
    for kind in ["edited", "cleaned", "raw"] {
        let row: Option<String> = sqlx::query_scalar(
            "SELECT segments_json FROM transcript WHERE interview_id = ? AND kind = ? \
             ORDER BY version DESC LIMIT 1",
        )
        .bind(interview_id)
        .bind(kind)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if let Some(json) = row {
            let segments: Vec<Segment> =
                serde_json::from_str(&json).map_err(|e| format!("parse {kind} segments: {e}"))?;
            return Ok(Some(segments));
        }
    }
    Ok(None)
}

// Map speaker_label → role for an interview (from participant). Unmapped labels render as
// "unknown" so the model still sees a role slot.
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

// Build the role-labeled InterviewInput for one interview (best transcript + role join).
// Returns None if the interview has no transcript.
async fn gather_interview(
    pool: &SqlitePool,
    interview_id: &str,
    title: &str,
) -> Result<Option<InterviewInput>, String> {
    let Some(segments) = best_transcript_db(pool, interview_id).await? else {
        return Ok(None);
    };
    let roles = role_map_db(pool, interview_id).await?;
    let role_segments: Vec<RoleSegment> = segments
        .iter()
        .enumerate()
        .map(|(i, s)| RoleSegment {
            id: i,
            speaker_role: roles
                .get(&s.speaker_label)
                .cloned()
                .unwrap_or_else(|| "unknown".to_string()),
            text: s.text.clone(),
        })
        .collect();
    Ok(Some(InterviewInput {
        id: interview_id.to_string(),
        title: title.to_string(),
        segments: role_segments,
    }))
}

// Interview id → title for a cycle, for evidence refs in the rendered markdown.
async fn interview_titles_db(pool: &SqlitePool, cycle_id: &str) -> Result<HashMap<String, String>, String> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, title FROM interview WHERE cycle_id = ?")
            .bind(cycle_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().collect())
}

// --- storing the synthesis ----------------------------------------------------

// Store the CYCLE synthesis (interview_id NULL): the structured doc in findings_json + the
// editable markdown in content_md. Re-run overwrites the single cycle-level row. Returns id.
async fn store_cycle_synthesis_db(
    pool: &SqlitePool,
    cycle_id: &str,
    doc: &SynthesisDoc,
    content_md: &str,
    model_meta: &str,
) -> Result<String, String> {
    let findings_json = serde_json::to_string(doc).map_err(|e| format!("serialize synthesis: {e}"))?;

    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM synthesis WHERE cycle_id = ? AND interview_id IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(cycle_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(id) = existing {
        sqlx::query("UPDATE synthesis SET findings_json = ?, content_md = ?, model_meta = ?, created_at = ? WHERE id = ?")
            .bind(&findings_json)
            .bind(content_md)
            .bind(model_meta)
            .bind(now_ms())
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO synthesis (id, cycle_id, interview_id, findings_json, content_md, model_meta, created_at) \
             VALUES (?, ?, NULL, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(cycle_id)
        .bind(&findings_json)
        .bind(content_md)
        .bind(model_meta)
        .bind(now_ms())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(id)
    }
}

// Update ONLY the cycle synthesis markdown (the user's Save edit). Errors if there's no
// cycle synthesis row yet (you must run synthesis before editing).
async fn save_cycle_markdown_db(pool: &SqlitePool, cycle_id: &str, content_md: &str) -> Result<SynthesisRow, String> {
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM synthesis WHERE cycle_id = ? AND interview_id IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(cycle_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let id = existing.ok_or("no synthesis to edit — run synthesis first")?;
    sqlx::query("UPDATE synthesis SET content_md = ? WHERE id = ?")
        .bind(content_md)
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    get_synthesis_db(pool, cycle_id)
        .await?
        .ok_or_else(|| "synthesis vanished after save".to_string())
}

// pub(crate) so the M9 diff module can read back a cycle's persisted synthesis (goals +
// findings) to feed the findings-level diff. Reads the CYCLE-level row (interview_id NULL).
pub(crate) async fn get_synthesis_db(pool: &SqlitePool, cycle_id: &str) -> Result<Option<SynthesisRow>, String> {
    let row: Option<(String, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, findings_json, content_md, model_meta, created_at FROM synthesis \
         WHERE cycle_id = ? AND interview_id IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(cycle_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    match row {
        Some((id, findings_json, content_md, model_meta, created_at)) => {
            let doc: SynthesisDoc =
                serde_json::from_str(&findings_json).map_err(|e| format!("parse synthesis doc: {e}"))?;
            Ok(Some(SynthesisRow {
                id,
                cycle_id: cycle_id.to_string(),
                doc,
                content_md,
                model_meta,
                created_at,
            }))
        }
        None => Ok(None),
    }
}

// Store a PER-INTERVIEW summary (interview_id set): structured doc + editable markdown.
// Re-run overwrites the single per-interview row. Returns id.
async fn store_interview_summary_db(
    pool: &SqlitePool,
    cycle_id: &str,
    interview_id: &str,
    doc: &InterviewSummaryDoc,
    content_md: &str,
    model_meta: &str,
) -> Result<String, String> {
    let findings_json = serde_json::to_string(doc).map_err(|e| format!("serialize summary: {e}"))?;

    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM synthesis WHERE interview_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(id) = existing {
        sqlx::query("UPDATE synthesis SET findings_json = ?, content_md = ?, model_meta = ?, created_at = ? WHERE id = ?")
            .bind(&findings_json)
            .bind(content_md)
            .bind(model_meta)
            .bind(now_ms())
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO synthesis (id, cycle_id, interview_id, findings_json, content_md, model_meta, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(cycle_id)
        .bind(interview_id)
        .bind(&findings_json)
        .bind(content_md)
        .bind(model_meta)
        .bind(now_ms())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(id)
    }
}

async fn get_interview_summary_db(pool: &SqlitePool, interview_id: &str) -> Result<Option<InterviewSummaryRow>, String> {
    let row: Option<(String, String, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, cycle_id, findings_json, content_md, model_meta, created_at FROM synthesis \
         WHERE interview_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(interview_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    match row {
        Some((id, cycle_id, findings_json, content_md, model_meta, created_at)) => {
            let doc: InterviewSummaryDoc =
                serde_json::from_str(&findings_json).map_err(|e| format!("parse summary doc: {e}"))?;
            Ok(Some(InterviewSummaryRow {
                id,
                cycle_id,
                interview_id: interview_id.to_string(),
                doc,
                content_md,
                model_meta,
                created_at,
            }))
        }
        None => Ok(None),
    }
}

async fn save_interview_markdown_db(pool: &SqlitePool, interview_id: &str, content_md: &str) -> Result<InterviewSummaryRow, String> {
    let existing: Option<String> =
        sqlx::query_scalar("SELECT id FROM synthesis WHERE interview_id = ? ORDER BY created_at DESC LIMIT 1")
            .bind(interview_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let id = existing.ok_or("no interview summary to edit — run it first")?;
    sqlx::query("UPDATE synthesis SET content_md = ? WHERE id = ?")
        .bind(content_md)
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    get_interview_summary_db(pool, interview_id)
        .await?
        .ok_or_else(|| "interview summary vanished after save".to_string())
}

// --- the map-reduce orchestration ---------------------------------------------

// MAP: extract one interview's goal-relevant points through the runner. On a parse/shape
// failure we retry once (run_cli_task already retries on a pure parse failure); a second
// failure yields an empty extraction rather than failing the whole synthesis (one weak
// interview shouldn't sink the wave). Returns the (raw output, extraction).
async fn extract_one(
    adapter: &crate::adapter::Adapter,
    product_desc: &str,
    goals: &[Goal],
    interview: &InterviewInput,
) -> (ExtractOutput, InterviewExtraction) {
    let input = build_extract_input(product_desc, goals, interview);
    let schema = extract_schema();

    // PERF: extraction runs on sonnet (good reasoning, faster than the heavy default).
    let output = match crate::adapter::run_cli_task_model(adapter, "cycle-synthesis-extract", &input, Some(&schema), Some(SYNTHESIS_MODEL)).await
    {
        Ok(value) => serde_json::from_value::<ExtractOutput>(value).unwrap_or_default(),
        Err(_) => ExtractOutput::default(),
    };

    let extraction = InterviewExtraction {
        interview_id: interview.id.clone(),
        title: interview.title.clone(),
        points: output.points.clone(),
    };
    (output, extraction)
}

// REDUCE: synthesize cross-interview findings from the extractions. Retries once on a
// parse/shape failure via run_cli_task; a hard failure surfaces an error (the synthesis
// can't produce findings without the reduce). Returns the validated SynthesisDoc.
async fn reduce(
    adapter: &crate::adapter::Adapter,
    product_desc: &str,
    guide: &str,
    goals: &[Goal],
    extractions: &[InterviewExtraction],
    valid_segments: &HashMap<String, usize>,
) -> Result<SynthesisDoc, String> {
    let input = build_reduce_input(product_desc, guide, goals, extractions);
    let schema = reduce_schema();

    // PERF: the reduce runs on sonnet (cross-interview synthesis; reasoning-heavy but not
    // worth the slowest default model).
    let value = crate::adapter::run_cli_task_model(adapter, "cycle-synthesis-reduce", &input, Some(&schema), Some(SYNTHESIS_MODEL))
        .await
        .map_err(|e| e.to_string())?;

    let output: ReduceOutput = serde_json::from_value(value.clone())
        .map_err(|e| format!("reduce output shape invalid: {e}; got {value}"))?;

    let findings = assemble_findings(goals, valid_segments, &output);
    let by_role = assemble_by_role(goals, &output);
    let open_questions: Vec<String> = output
        .open_questions
        .iter()
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty())
        .collect();

    Ok(SynthesisDoc {
        goals: goals.to_vec(),
        findings,
        open_questions,
        executive_summary: output.executive_summary.trim().to_string(),
        by_role,
    })
}

// The per-interview summaries produced as a side-effect of the MAP stage, keyed by
// interview_id, so run_synthesis can persist them after a successful run.
struct CycleSynthesisResult {
    doc: SynthesisDoc,
    // (interview_id, title, summary doc) per interview that produced points.
    summaries: Vec<(String, String, InterviewSummaryDoc)>,
}

// Run the whole synthesis for a cycle: derive goals, gather interviews, MAP each (storing
// per-interview summaries), REDUCE, validate, return the cycle doc + per-interview summaries.
// `app` is optional so this is testable without a Tauri runtime (progress events skipped).
async fn synthesize_cycle(
    app: Option<&tauri::AppHandle>,
    cycle_id: &str,
    product_desc: &str,
    guide: &str,
    adapter: &crate::adapter::Adapter,
    interviews: &[InterviewInput],
) -> Result<CycleSynthesisResult, String> {
    let goals = derive_goals(guide);
    if goals.is_empty() {
        return Err("no goals could be derived from the guide — add a Goals section first".into());
    }
    if interviews.is_empty() {
        return Err("no transcribed interviews in this cycle to synthesize".into());
    }

    // valid_segments per interview, for evidence-ref validation in the reduce.
    let valid_segments: HashMap<String, usize> = interviews
        .iter()
        .map(|iv| (iv.id.clone(), iv.segments.len()))
        .collect();

    // MAP: extract each interview. PERF: runs with BOUNDED CONCURRENCY
    // (SYNTHESIS_CONCURRENCY) in waves instead of strictly sequentially — the MAP used to be
    // one serial `claude` call per interview. We ALSO build the per-interview summary
    // artifact from each extraction. Results are reassembled in ORIGINAL interview order
    // (join_all_ordered preserves input order); progress is emitted as extractions complete.
    let total = interviews.len();
    let concurrency = SYNTHESIS_CONCURRENCY.max(1);
    let done = std::sync::atomic::AtomicUsize::new(0);
    let mut extractions: Vec<InterviewExtraction> = Vec::with_capacity(total);
    let mut summaries: Vec<(String, String, InterviewSummaryDoc)> = Vec::with_capacity(total);

    for wave in interviews.chunks(concurrency) {
        let wave_futs = wave.iter().map(|iv| {
            let done = &done;
            let goals = &goals;
            async move {
                let (output, extraction) = extract_one(adapter, product_desc, goals, iv).await;
                let summary = assemble_interview_summary(goals, iv.segments.len(), &output);
                let completed = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                if let Some(app) = app {
                    // Reserve the last 20% of the bar for the reduce stage.
                    let pct = ((completed as f32 / total as f32) * 80.0).round() as i32;
                    emit_progress(app, cycle_id, "extract", completed, total, pct, None);
                }
                (iv.id.clone(), iv.title.clone(), summary, extraction)
            }
        });
        for (iv_id, title, summary, extraction) in join_all_ordered(wave_futs).await {
            summaries.push((iv_id, title, summary));
            extractions.push(extraction);
        }
    }

    // REDUCE.
    if let Some(app) = app {
        emit_progress(app, cycle_id, "reduce", total, total, 85, None);
    }
    let doc = reduce(adapter, product_desc, guide, &goals, &extractions, &valid_segments).await?;

    Ok(CycleSynthesisResult { doc, summaries })
}

// --- Tauri commands -----------------------------------------------------------

// Get the stored CYCLE synthesis for a cycle (None before the first run). Drives the tab's
// empty-state vs populated rendering.
#[tauri::command]
pub async fn get_synthesis(db: tauri::State<'_, Db>, cycle_id: String) -> Result<Option<SynthesisRow>, String> {
    get_synthesis_db(&db.pool, &cycle_id).await
}

// Save the user's edit of the cycle synthesis MARKDOWN artifact. Returns the updated row.
#[tauri::command]
pub async fn save_cycle_synthesis(db: tauri::State<'_, Db>, cycle_id: String, content_md: String) -> Result<SynthesisRow, String> {
    save_cycle_markdown_db(&db.pool, &cycle_id, &content_md).await
}

// Get a stored PER-INTERVIEW summary (None before the first run). Drives the editor's
// Summary section.
#[tauri::command]
pub async fn get_interview_summary(db: tauri::State<'_, Db>, interview_id: String) -> Result<Option<InterviewSummaryRow>, String> {
    get_interview_summary_db(&db.pool, &interview_id).await
}

// Save the user's edit of a per-interview summary MARKDOWN artifact. Returns the updated row.
#[tauri::command]
pub async fn save_interview_summary(db: tauri::State<'_, Db>, interview_id: String, content_md: String) -> Result<InterviewSummaryRow, String> {
    save_interview_markdown_db(&db.pool, &interview_id, &content_md).await
}

// Run (or regenerate) the per-interview summary for ONE interview: gather its role-labeled
// transcript + the cycle's goals, run the MAP extract through the active adapter, assemble +
// store the per-interview summary artifact. Emits progress on `interview-summary://progress`.
#[tauri::command]
pub async fn run_interview_summary(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    interview_id: String,
    adapter_id: Option<String>,
) -> Result<InterviewSummaryRow, String> {
    emit_summary_progress(&app, &interview_id, "running", 10, None);

    // Resolve the interview's cycle + title, the cycle's product desc + goals.
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT cycle_id, title FROM interview WHERE id = ?")
            .bind(&interview_id)
            .fetch_optional(&db.pool)
            .await
            .map_err(|e| e.to_string())?;
    let (cycle_id, title) = match row {
        Some(r) => r,
        None => {
            let msg = "interview not found".to_string();
            emit_summary_progress(&app, &interview_id, "error", 0, Some(msg.clone()));
            return Err(msg);
        }
    };

    // Products library: prefer the linked product's content_md, falling back to the inline
    // product_desc column (back-compat), so the per-interview summary is grounded in product context.
    let product_desc = effective_product_db(&db.pool, &cycle_id)
        .await?
        .unwrap_or_default();
    let guide = effective_guide_db(&db.pool, &cycle_id).await?.unwrap_or_default();
    let goals = derive_goals(&guide);
    if goals.is_empty() {
        let msg = "no goals derived from the cycle's guide — add a Goals section first".to_string();
        emit_summary_progress(&app, &interview_id, "error", 0, Some(msg.clone()));
        return Err(msg);
    }

    let Some(iv) = gather_interview(&db.pool, &interview_id, &title).await? else {
        let msg = "this interview has no transcript yet — transcribe it first".to_string();
        emit_summary_progress(&app, &interview_id, "error", 0, Some(msg.clone()));
        return Err(msg);
    };
    if iv.segments.is_empty() {
        let msg = "this interview has no transcript segments to summarize".to_string();
        emit_summary_progress(&app, &interview_id, "error", 0, Some(msg.clone()));
        return Err(msg);
    }

    let id = match adapter_id {
        Some(id) => id,
        None => crate::adapter::active_adapter_id(&db.pool).await?,
    };
    let adapter = crate::adapter::resolve_adapter_pub(&app, Some(&id))?;

    emit_summary_progress(&app, &interview_id, "running", 50, None);
    let (output, _extraction) = extract_one(&adapter, &product_desc, &goals, &iv).await;
    let doc = assemble_interview_summary(&goals, iv.segments.len(), &output);
    let content_md = render_interview_markdown(&doc, &title);
    let model_meta = json!({ "adapter": adapter.id, "goals": doc.goals.len() }).to_string();
    let row_id = store_interview_summary_db(&db.pool, &cycle_id, &interview_id, &doc, &content_md, &model_meta).await?;
    emit_summary_progress(&app, &interview_id, "done", 100, None);

    Ok(InterviewSummaryRow {
        id: row_id,
        cycle_id,
        interview_id,
        doc,
        content_md,
        model_meta: Some(model_meta),
        created_at: now_ms(),
    })
}

// Preview the goals derived from a cycle's current guide (so the UI can show "N goals"
// before a run, and the empty state can hint what synthesis will be grounded on).
#[tauri::command]
pub async fn cycle_goals(db: tauri::State<'_, Db>, cycle_id: String) -> Result<Vec<Goal>, String> {
    // M10a: source goals from the linked guide's content when set, else the inline text.
    let guide = effective_guide_db(&db.pool, &cycle_id)
        .await?
        .ok_or("cycle not found")?;
    Ok(derive_goals(&guide))
}

// Run synthesis for a cycle: gather product desc + goals + role-labeled transcripts, run
// the map-reduce through the active adapter, store BOTH the per-interview summaries AND the
// cycle artifact (structured findings + editable markdown). Emits stage progress on
// `synthesis://progress`. Returns the stored cycle synthesis row.
#[tauri::command]
pub async fn run_synthesis(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    cycle_id: String,
    adapter_id: Option<String>,
) -> Result<SynthesisRow, String> {
    // Cycle context. M10a: the GUIDE the synthesis is grounded on now prefers the cycle's
    // linked guide (cycle.guide_id → guide.content_md), falling back to the inline column.
    // Products library: the PRODUCT CONTEXT likewise prefers the cycle's linked product
    // (cycle.product_id → product.content_md), falling back to the inline product_desc column.
    let name: String = sqlx::query_scalar("SELECT name FROM cycle WHERE id = ?")
        .bind(&cycle_id)
        .fetch_optional(&db.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("cycle not found")?;
    let product_desc = effective_product_db(&db.pool, &cycle_id)
        .await?
        .ok_or("cycle not found")?;
    let guide = effective_guide_db(&db.pool, &cycle_id)
        .await?
        .ok_or("cycle not found")?;

    // Gather every interview's best role-labeled transcript (skip un-transcribed ones).
    let interview_rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, title FROM interview WHERE cycle_id = ? ORDER BY created_at ASC")
            .bind(&cycle_id)
            .fetch_all(&db.pool)
            .await
            .map_err(|e| e.to_string())?;

    let mut interviews: Vec<InterviewInput> = Vec::new();
    for (id, title) in &interview_rows {
        if let Some(iv) = gather_interview(&db.pool, id, title).await? {
            if !iv.segments.is_empty() {
                interviews.push(iv);
            }
        }
    }

    if interviews.is_empty() {
        let msg = "no transcribed interviews in this cycle — transcribe at least one first".to_string();
        emit_progress(&app, &cycle_id, "error", 0, 0, 0, Some(msg.clone()));
        return Err(msg);
    }

    // Resolve the adapter (explicit id → that one; else the active one).
    let id = match adapter_id {
        Some(id) => id,
        None => crate::adapter::active_adapter_id(&db.pool).await?,
    };
    let adapter = crate::adapter::resolve_adapter_pub(&app, Some(&id))?;

    match synthesize_cycle(Some(&app), &cycle_id, &product_desc, &guide, &adapter, &interviews).await {
        Ok(result) => {
            // Persist each per-interview summary (the MAP artifacts).
            for (iv_id, title, summary) in &result.summaries {
                let md = render_interview_markdown(summary, title);
                let meta = json!({ "adapter": adapter.id, "from": "cycle-synthesis" }).to_string();
                let _ = store_interview_summary_db(&db.pool, &cycle_id, iv_id, summary, &md, &meta).await;
            }

            // Render + persist the cycle artifact (structured + editable markdown).
            let titles = interview_titles_db(&db.pool, &cycle_id).await?;
            let content_md = render_cycle_markdown(&result.doc, &titles);
            let model_meta = json!({
                "adapter": adapter.id,
                "cycle": name,
                "interviews": interviews.len(),
                "goals": result.doc.goals.len(),
                "findings": result.doc.findings.len(),
            })
            .to_string();
            let row_id = store_cycle_synthesis_db(&db.pool, &cycle_id, &result.doc, &content_md, &model_meta).await?;
            emit_progress(&app, &cycle_id, "done", interviews.len(), interviews.len(), 100, None);
            Ok(SynthesisRow {
                id: row_id,
                cycle_id,
                doc: result.doc,
                content_md,
                model_meta: Some(model_meta),
                created_at: now_ms(),
            })
        }
        Err(e) => {
            emit_progress(&app, &cycle_id, "error", 0, interviews.len(), 0, Some(e.clone()));
            Err(e)
        }
    }
}

// --- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- goal derivation (stability for M9) -----------------------------------

    #[test]
    fn derive_goals_from_goals_heading_with_explicit_ids() {
        let guide = "Goals:\n- G1: Why do new accounts stall before creating their first funnel?\n\
                     - G2: Which onboarding step confuses most?\n- G3: What drives a teammate invite?\n\n\
                     Target conclusions:\n- A ranked list of blockers.";
        let goals = derive_goals(guide);
        assert_eq!(goals.len(), 3, "stops before Target conclusions");
        assert_eq!(goals[0].id, "G1");
        assert_eq!(goals[1].id, "G2");
        assert_eq!(goals[2].id, "G3");
        assert!(goals[0].text.starts_with("Why do new accounts"));
        // The "Target conclusions" bullet is NOT a goal.
        assert!(!goals.iter().any(|g| g.text.contains("ranked list")));
    }

    #[test]
    fn derive_goals_assigns_positional_ids_without_explicit_tags() {
        let guide = "Goals:\n- Validate the redesigned empty state.\n- Measure perceived setup effort.";
        let goals = derive_goals(guide);
        assert_eq!(goals.len(), 2);
        assert_eq!(goals[0].id, "G1");
        assert_eq!(goals[1].id, "G2");
        assert_eq!(goals[0].text, "Validate the redesigned empty state.");
    }

    #[test]
    fn derive_goals_is_stable_across_calls() {
        // The SAME guide → the SAME ids (M9 diff stability).
        let guide = "Goals:\n- A\n- B\n- C";
        assert_eq!(derive_goals(guide), derive_goals(guide));
        let ids: Vec<String> = derive_goals(guide).into_iter().map(|g| g.id).collect();
        assert_eq!(ids, vec!["G1", "G2", "G3"]);
    }

    #[test]
    fn derive_goals_falls_back_to_all_bullets_then_whole_guide() {
        // No "Goals" heading → every bullet becomes a goal.
        let bullets = "- first\n- second";
        let g = derive_goals(bullets);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].id, "G1");

        // No bullets at all → the whole guide is one goal.
        let prose = "Understand why people churn after the trial.";
        let g2 = derive_goals(prose);
        assert_eq!(g2.len(), 1);
        assert_eq!(g2[0].id, "G1");
        assert_eq!(g2[0].text, prose);

        // Empty guide → no goals (synthesize refuses to run).
        assert!(derive_goals("   ").is_empty());
    }

    #[test]
    fn split_explicit_id_handles_separators() {
        assert_eq!(split_explicit_id("G1: text").unwrap(), ("G1".into(), "text".into()));
        assert_eq!(split_explicit_id("G2 - text").unwrap(), ("G2".into(), "text".into()));
        assert_eq!(split_explicit_id("G10 text").unwrap(), ("G10".into(), "text".into()));
        assert!(split_explicit_id("Goal one").is_none()); // "Goal" not a "G<n>" tag
        assert!(split_explicit_id("Generally important").is_none());
    }

    // --- assemble_findings invariants -----------------------------------------

    fn goals3() -> Vec<Goal> {
        vec![
            Goal { id: "G1".into(), text: "drop-off".into() },
            Goal { id: "G2".into(), text: "confusing step".into() },
            Goal { id: "G3".into(), text: "invite".into() },
        ]
    }

    fn valid_segs() -> HashMap<String, usize> {
        // iv1 has 5 segments (ids 0..5), iv2 has 3 (ids 0..3).
        HashMap::from([("iv1".to_string(), 5usize), ("iv2".to_string(), 3usize)])
    }

    #[test]
    fn assemble_drops_unknown_goal_and_restamps_ids() {
        let output: ReduceOutput = serde_json::from_value(json!({
            "executive_summary": "s",
            "by_role": [],
            "findings": [
                { "goal_id": "G2", "statement": "Event mapping confuses people.", "confidence": "high",
                  "support_count": 3, "evidence": [{ "interview_id": "iv1", "segment_id": 2, "quote": "I guessed." }],
                  "recommendation": "Add a wizard." },
                { "goal_id": "GZ", "statement": "Bogus goal.", "confidence": "low",
                  "support_count": 1, "evidence": [], "recommendation": "" },
                { "goal_id": "G1", "statement": "Users stall at the warehouse connect.", "confidence": "medium",
                  "support_count": 2, "evidence": [{ "interview_id": "iv2", "segment_id": 0, "quote": "stalled" }],
                  "recommendation": "Defer creds." }
            ],
            "open_questions": []
        })).unwrap();

        let findings = assemble_findings(&goals3(), &valid_segs(), &output);
        // The GZ finding is dropped; two remain.
        assert_eq!(findings.len(), 2);
        // Re-stamped + grouped by goal order: G1 finding first (F1), G2 finding (F2).
        assert_eq!(findings[0].id, "F1");
        assert_eq!(findings[0].goal_id, "G1");
        assert_eq!(findings[1].id, "F2");
        assert_eq!(findings[1].goal_id, "G2");
    }

    #[test]
    fn assemble_drops_invalid_evidence_refs() {
        let output: ReduceOutput = serde_json::from_value(json!({
            "executive_summary": "",
            "by_role": [],
            "findings": [
                { "goal_id": "G1", "statement": "valid + bogus evidence mixed.", "confidence": "high",
                  "support_count": 1,
                  "evidence": [
                    { "interview_id": "iv1", "segment_id": 2, "quote": "good" },
                    { "interview_id": "iv1", "segment_id": 99, "quote": "out of range" },
                    { "interview_id": "ivX", "segment_id": 0, "quote": "no such interview" }
                  ],
                  "recommendation": "" }
            ],
            "open_questions": ["did mobile differ?"]
        })).unwrap();

        let findings = assemble_findings(&goals3(), &valid_segs(), &output);
        assert_eq!(findings.len(), 1);
        // Only the in-range, real-interview ref survives.
        assert_eq!(findings[0].evidence.len(), 1);
        assert_eq!(findings[0].evidence[0].segment_id, 2);
        assert_eq!(findings[0].evidence[0].interview_id, "iv1");
    }

    #[test]
    fn assemble_drops_blank_statements_and_normalizes_confidence() {
        let output: ReduceOutput = serde_json::from_value(json!({
            "findings": [
                { "goal_id": "G1", "statement": "   ", "confidence": "high", "support_count": 1, "evidence": [], "recommendation": "" },
                { "goal_id": "G1", "statement": "Real finding.", "confidence": "WHATEVER", "support_count": 0, "evidence": [], "recommendation": "" }
            ],
            "open_questions": []
        })).unwrap();
        let findings = assemble_findings(&goals3(), &valid_segs(), &output);
        assert_eq!(findings.len(), 1, "blank statement dropped");
        assert_eq!(findings[0].confidence, "medium", "unknown confidence → medium");
    }

    #[test]
    fn assemble_support_count_at_least_distinct_interviews() {
        // Model under-reports support_count=1 but cites two distinct interviews.
        let output: ReduceOutput = serde_json::from_value(json!({
            "findings": [
                { "goal_id": "G1", "statement": "Cross-interview pattern.", "confidence": "high",
                  "support_count": 1,
                  "evidence": [
                    { "interview_id": "iv1", "segment_id": 0, "quote": "a" },
                    { "interview_id": "iv2", "segment_id": 1, "quote": "b" }
                  ],
                  "recommendation": "" }
            ],
            "open_questions": []
        })).unwrap();
        let findings = assemble_findings(&goals3(), &valid_segs(), &output);
        assert_eq!(findings[0].support_count, 2, "bumped to distinct cited interviews");
    }

    // --- by-role assembly + markdown rendering (M10b, pure) --------------------

    #[test]
    fn assemble_by_role_drops_unknown_goals_and_blank_notes() {
        let output: ReduceOutput = serde_json::from_value(json!({
            "by_role": [
                { "goal_id": "G1", "notes": [ { "role": "Designer", "note": "wanted templates" }, { "role": "PM", "note": "  " } ] },
                { "goal_id": "GZ", "notes": [ { "role": "X", "note": "ignored" } ] }
            ],
            "findings": [], "open_questions": []
        })).unwrap();
        let by_role = assemble_by_role(&goals3(), &output);
        assert_eq!(by_role.len(), 1, "unknown-goal group dropped");
        assert_eq!(by_role[0].goal_id, "G1");
        assert_eq!(by_role[0].notes.len(), 1, "blank note dropped");
        assert_eq!(by_role[0].notes[0].role, "Designer");
    }

    #[test]
    fn render_cycle_markdown_follows_guide_structure() {
        let doc = SynthesisDoc {
            goals: goals3(),
            findings: vec![Finding {
                id: "F1".into(), goal_id: "G1".into(),
                statement: "Users stall at warehouse connect.".into(),
                confidence: "high".into(), support_count: 4,
                evidence: vec![Evidence { interview_id: "iv1".into(), segment_id: 2, quote: "I stalled.".into() }],
                recommendation: "Defer the connect.".into(),
            }],
            open_questions: vec!["Did mobile differ?".into()],
            executive_summary: "The wave firmed up the data-source blocker.".into(),
            by_role: vec![RoleBreakdownGroup {
                goal_id: "G1".into(),
                notes: vec![RoleNote { role: "Designer".into(), note: "asked for templates".into() }],
            }],
        };
        let titles = HashMap::from([("iv1".to_string(), "P01 — Founder".to_string())]);
        let md = render_cycle_markdown(&doc, &titles);
        // Executive summary first, then per-goal headings, then by-role + open questions.
        assert!(md.contains("## Executive summary"));
        assert!(md.contains("The wave firmed up"));
        assert!(md.contains("## G1 · drop-off"));
        assert!(md.contains("Users stall at warehouse connect."));
        assert!(md.contains("high confidence"));
        // Evidence quote resolves the interview title + 1-based segment.
        assert!(md.contains("P01 — Founder · segment 3"));
        assert!(md.contains("**Recommendation:** Defer the connect."));
        assert!(md.contains("## By role"));
        assert!(md.contains("**Designer:** asked for templates"));
        assert!(md.contains("## Open questions"));
        // Executive summary section precedes the first goal.
        assert!(md.find("## Executive summary").unwrap() < md.find("## G1").unwrap());
    }

    #[test]
    fn assemble_interview_summary_groups_and_validates() {
        let output: ExtractOutput = serde_json::from_value(json!({
            "points": [
                { "goal_id": "G1", "point": "Stalled at the data source.", "quotes": [ { "segment_id": 2, "quote": "no creds" }, { "segment_id": 99, "quote": "oob" } ] },
                { "goal_id": "GZ", "point": "ignored — unknown goal", "quotes": [] },
                { "goal_id": "G2", "point": "Too many fields.", "quotes": [] }
            ],
            "notable": [ { "segment_id": 1, "quote": "five minutes not two days", "note": "wizard ask" }, { "segment_id": 100, "quote": "oob", "note": "" } ]
        })).unwrap();
        let doc = assemble_interview_summary(&goals3(), 5, &output);
        // Only G1 + G2 groups (GZ unknown dropped); points grouped by goal order.
        assert_eq!(doc.by_goal.len(), 2);
        assert_eq!(doc.by_goal[0].goal_id, "G1");
        // Out-of-range quote dropped; in-range kept.
        assert_eq!(doc.by_goal[0].points[0].quotes.len(), 1);
        assert_eq!(doc.by_goal[0].points[0].quotes[0].segment_id, 2);
        assert_eq!(doc.by_goal[1].goal_id, "G2");
        // notable: out-of-range ref dropped.
        assert_eq!(doc.notable.len(), 1);
        assert_eq!(doc.notable[0].segment_id, 1);

        // Markdown renders goal headings + quotes + notable section.
        let md = render_interview_markdown(&doc, "P01 — Founder");
        assert!(md.contains("# Summary · P01 — Founder"));
        assert!(md.contains("## G1 · drop-off"));
        assert!(md.contains("Stalled at the data source."));
        assert!(md.contains("(segment 3)"));
        assert!(md.contains("## Notable quotes & surprises"));
    }

    // --- stubbed-CLI full map-reduce assembly (no real CLI; spec test) --------
    //
    // Exercises the assembly chain end-to-end against a STUBBED reduce output instead of
    // the real `claude` CLI, proving goals→findings validation without subscription usage.
    #[test]
    fn stubbed_reduce_full_assembly_preserves_invariants() {
        let goals = goals3();
        let valid = valid_segs();
        // A realistic-ish reduce reply across two goals with mixed-quality evidence.
        let stub = json!({
            "executive_summary": "Activation stalls at the data-source connect; mapping confuses users.",
            "by_role": [ { "goal_id": "G1", "notes": [ { "role": "PM", "note": "needs creds upfront" } ] } ],
            "findings": [
                { "goal_id": "G1", "statement": "New accounts stall when asked for warehouse credentials they don't have on hand.",
                  "confidence": "high", "support_count": 4,
                  "evidence": [
                    { "interview_id": "iv1", "segment_id": 3, "quote": "I didn't have those credentials on hand, so I stalled." },
                    { "interview_id": "iv2", "segment_id": 1, "quote": "had to go bug our data engineer." },
                    { "interview_id": "iv9", "segment_id": 0, "quote": "ghost interview — should be dropped" }
                  ],
                  "recommendation": "Defer the data-source connect or offer a sample dataset." },
                { "goal_id": "G2", "statement": "The event-mapping screen has too many fields; users guess.",
                  "confidence": "medium", "support_count": 2,
                  "evidence": [ { "interview_id": "iv1", "segment_id": 4, "quote": "I wasn't confident I was picking the right ones. I kind of guessed." } ],
                  "recommendation": "Add a guided three-event setup." },
                { "goal_id": "BOGUS", "statement": "should be dropped", "confidence": "low", "support_count": 0, "evidence": [], "recommendation": "" }
            ],
            "open_questions": ["Did mobile-first users behave differently?", "  "]
        });
        let output: ReduceOutput = serde_json::from_value(stub).unwrap();
        let findings = assemble_findings(&goals, &valid, &output);

        // Bogus goal dropped → 2 findings, F1/F2 grouped by goal.
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].id, "F1");
        assert_eq!(findings[0].goal_id, "G1");
        // Ghost-interview evidence dropped; the two real refs survive.
        assert_eq!(findings[0].evidence.len(), 2);
        assert!(findings[0].evidence.iter().all(|e| valid.contains_key(&e.interview_id)));
        assert_eq!(findings[1].goal_id, "G2");
        assert_eq!(findings[1].evidence[0].segment_id, 4);

        // Build the full doc + assert it round-trips through JSON (what we store).
        let doc = SynthesisDoc {
            goals: goals.clone(),
            findings: findings.clone(),
            open_questions: output.open_questions.iter().map(|q| q.trim().to_string()).filter(|q| !q.is_empty()).collect(),
            executive_summary: output.executive_summary.trim().to_string(),
            by_role: assemble_by_role(&goals, &output),
        };
        assert_eq!(doc.open_questions.len(), 1, "blank open question filtered");
        assert_eq!(doc.by_role.len(), 1, "by-role group kept");
        let json = serde_json::to_string(&doc).unwrap();
        let back: SynthesisDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, doc, "synthesis doc round-trips through findings_json");
        // Every finding ties to a real goal (the M8 verify invariant).
        for f in &back.findings {
            assert!(goals.iter().any(|g| g.id == f.goal_id), "finding {} ties to a real goal", f.id);
        }

        // The markdown artifact renders from the doc (M10b).
        let md = render_cycle_markdown(&doc, &HashMap::new());
        assert!(md.contains("## Executive summary"));
        assert!(md.contains("## G1"));
        assert!(md.contains("## By role"));
    }

    // --- old M8 row back-compat: a findings_json WITHOUT the M10b fields parses ----
    #[test]
    fn old_m8_synthesis_doc_deserializes() {
        // An M8-era doc (no executive_summary / by_role) must still parse (serde default).
        let m8 = json!({
            "goals": [ { "id": "G1", "text": "drop-off" } ],
            "findings": [],
            "open_questions": []
        });
        let doc: SynthesisDoc = serde_json::from_value(m8).unwrap();
        assert_eq!(doc.goals.len(), 1);
        assert!(doc.executive_summary.is_empty());
        assert!(doc.by_role.is_empty());
    }

    // --- DB store/get round-trip ----------------------------------------------

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // M10a: effective_guide_db prefers the linked guide's content over the inline text,
    // and falls back to the inline text when no guide is linked (or it's empty).
    #[tokio::test]
    async fn effective_guide_prefers_linked_guide_then_inline() {
        let pool = test_pool().await;
        let ts = now_ms();

        // A guide in the library + a cycle linked to it, with DIFFERENT inline text.
        let guide_id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO guide (id, name, content_md, goals_json, created_at, updated_at) VALUES (?, 'Lib', 'Goals:\n- From the library', '[]', ?, ?)")
            .bind(&guide_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let linked = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, guide, guide_id, created_at, updated_at) VALUES (?, 'c', 'Goals:\n- From inline', ?, ?, ?)")
            .bind(&linked).bind(&guide_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let g = effective_guide_db(&pool, &linked).await.unwrap().unwrap();
        assert!(g.contains("From the library"), "linked guide wins: {g}");

        // A cycle with NO linked guide → falls back to its inline text.
        let inline_only = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, guide, created_at, updated_at) VALUES (?, 'c2', 'Goals:\n- Inline only', ?, ?)")
            .bind(&inline_only).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let g2 = effective_guide_db(&pool, &inline_only).await.unwrap().unwrap();
        assert!(g2.contains("Inline only"));

        // Missing cycle → None.
        assert!(effective_guide_db(&pool, "nope").await.unwrap().is_none());
    }

    // Products library: effective_product_db prefers the linked product's content over the
    // inline product_desc, and falls back to the inline text when no product is linked.
    #[tokio::test]
    async fn effective_product_prefers_linked_product_then_inline() {
        let pool = test_pool().await;
        let ts = now_ms();

        // A product in the library + a cycle linked to it, with DIFFERENT inline product_desc.
        let product_id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO product (id, name, content_md, created_at, updated_at) VALUES (?, 'Lib', 'Acme from the library', ?, ?)")
            .bind(&product_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let linked = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, product_desc, product_id, created_at, updated_at) VALUES (?, 'c', 'Acme from inline', ?, ?, ?)")
            .bind(&linked).bind(&product_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let p = effective_product_db(&pool, &linked).await.unwrap().unwrap();
        assert!(p.contains("from the library"), "linked product wins: {p}");

        // A cycle with NO linked product → falls back to its inline product_desc.
        let inline_only = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO cycle (id, name, product_desc, created_at, updated_at) VALUES (?, 'c2', 'Inline product only', ?, ?)")
            .bind(&inline_only).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let p2 = effective_product_db(&pool, &inline_only).await.unwrap().unwrap();
        assert!(p2.contains("Inline product only"));

        // Missing cycle → None.
        assert!(effective_product_db(&pool, "nope").await.unwrap().is_none());
    }

    // Product context flows into BOTH synthesis prompts (extract map + reduce). The product
    // description must appear in the assembled prompt input so the model normalizes
    // product/brand terms (req #2). Pure prompt-assembly check — no CLI.
    #[test]
    fn synthesis_prompts_include_product_context() {
        let product = "Acme Analytics — self-serve funnels + retention; activation = first funnel.";
        let goals = goals3();
        let iv = InterviewInput {
            id: "iv1".into(),
            title: "P01".into(),
            segments: vec![],
        };
        let extract = build_extract_input(product, &goals, &iv);
        assert_eq!(
            extract["product_desc"], product,
            "extract prompt carries the product context"
        );
        let reduce = build_reduce_input(product, "Goals:\n- G1", &goals, &[]);
        assert_eq!(
            reduce["product_desc"], product,
            "reduce prompt carries the product context"
        );
    }

    #[tokio::test]
    async fn store_and_get_cycle_synthesis_overwrites_and_carries_markdown() {
        let pool = test_pool().await;
        let cycle_id = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)")
            .bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();

        let doc1 = SynthesisDoc {
            goals: goals3(),
            findings: vec![Finding {
                id: "F1".into(), goal_id: "G1".into(), statement: "first run".into(),
                confidence: "high".into(), support_count: 2,
                evidence: vec![Evidence { interview_id: "iv1".into(), segment_id: 0, quote: "q".into() }],
                recommendation: "do x".into(),
            }],
            open_questions: vec!["q?".into()],
            executive_summary: "summary v1".into(),
            by_role: vec![],
        };
        let id1 = store_cycle_synthesis_db(&pool, &cycle_id, &doc1, "# MD v1", "meta1").await.unwrap();
        let got = get_synthesis_db(&pool, &cycle_id).await.unwrap().unwrap();
        assert_eq!(got.doc.findings[0].statement, "first run");
        assert_eq!(got.content_md, "# MD v1");
        assert_eq!(got.model_meta.as_deref(), Some("meta1"));

        // Re-run overwrites the same row (one cycle synthesis per cycle).
        let mut doc2 = doc1.clone();
        doc2.findings[0].statement = "second run".into();
        let id2 = store_cycle_synthesis_db(&pool, &cycle_id, &doc2, "# MD v2", "meta2").await.unwrap();
        assert_eq!(id1, id2, "re-run overwrites the existing synthesis row");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM synthesis WHERE cycle_id = ? AND interview_id IS NULL")
            .bind(&cycle_id).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1);
        let got2 = get_synthesis_db(&pool, &cycle_id).await.unwrap().unwrap();
        assert_eq!(got2.doc.findings[0].statement, "second run");
        assert_eq!(got2.content_md, "# MD v2");

        // User edits the markdown → persists, structured doc untouched.
        let edited = save_cycle_markdown_db(&pool, &cycle_id, "# Edited by hand").await.unwrap();
        assert_eq!(edited.content_md, "# Edited by hand");
        assert_eq!(edited.doc.findings[0].statement, "second run", "structured layer untouched");
    }

    #[tokio::test]
    async fn store_and_get_interview_summary_overwrites() {
        let pool = test_pool().await;
        let cycle_id = Uuid::new_v4().to_string();
        let iv = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)")
            .bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'iv', 'cleaned', ?, ?)")
            .bind(&iv).bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();

        let doc = InterviewSummaryDoc {
            goals: goals3(),
            by_goal: vec![InterviewGoalSummary {
                goal_id: "G1".into(),
                points: vec![InterviewPoint { point: "Stalled at connect.".into(), quotes: vec![InterviewQuote { segment_id: 0, quote: "no creds".into() }] }],
            }],
            notable: vec![NotableQuote { segment_id: 1, quote: "five minutes".into(), note: "wizard ask".into() }],
        };
        store_interview_summary_db(&pool, &cycle_id, &iv, &doc, "# Summary", "m").await.unwrap();
        // A cycle-level row coexists independently of the per-interview one.
        let count_cycle: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM synthesis WHERE cycle_id = ? AND interview_id IS NULL")
            .bind(&cycle_id).fetch_one(&pool).await.unwrap();
        assert_eq!(count_cycle, 0, "no cycle-level row yet");

        let got = get_interview_summary_db(&pool, &iv).await.unwrap().unwrap();
        assert_eq!(got.doc.by_goal[0].points[0].point, "Stalled at connect.");
        assert_eq!(got.content_md, "# Summary");

        // Re-run overwrites the single per-interview row.
        let mut doc2 = doc.clone();
        doc2.by_goal[0].points[0].point = "Updated point.".into();
        store_interview_summary_db(&pool, &cycle_id, &iv, &doc2, "# Summary 2", "m2").await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM synthesis WHERE interview_id = ?")
            .bind(&iv).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1);
        let got2 = get_interview_summary_db(&pool, &iv).await.unwrap().unwrap();
        assert_eq!(got2.doc.by_goal[0].points[0].point, "Updated point.");

        // Edit the markdown → persists.
        let edited = save_interview_markdown_db(&pool, &iv, "# Edited summary").await.unwrap();
        assert_eq!(edited.content_md, "# Edited summary");
    }

    // gather_interview joins roles onto the best transcript (edited→cleaned→raw).
    #[tokio::test]
    async fn gather_interview_joins_roles_and_prefers_best() {
        let pool = test_pool().await;
        let cycle_id = Uuid::new_v4().to_string();
        let iv = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)")
            .bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'iv', 'cleaned', ?, ?)")
            .bind(&iv).bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();

        let raw = vec![
            Segment { start_ms: 0, end_ms: 1000, speaker_label: "S1".into(), text: "raw q".into() },
            Segment { start_ms: 1000, end_ms: 2000, speaker_label: "S2".into(), text: "raw a".into() },
        ];
        let cleaned = vec![
            Segment { start_ms: 0, end_ms: 1000, speaker_label: "S1".into(), text: "Clean question?".into() },
            Segment { start_ms: 1000, end_ms: 2000, speaker_label: "S2".into(), text: "Clean answer.".into() },
        ];
        sqlx::query("INSERT INTO transcript (id, interview_id, version, kind, language, engine, segments_json, created_at) VALUES (?, ?, 1, 'raw', 'en', 'w', ?, ?)")
            .bind(Uuid::new_v4().to_string()).bind(&iv).bind(serde_json::to_string(&raw).unwrap()).bind(ts).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO transcript (id, interview_id, version, kind, language, engine, segments_json, created_at) VALUES (?, ?, 2, 'cleaned', 'en', 'cli', ?, ?)")
            .bind(Uuid::new_v4().to_string()).bind(&iv).bind(serde_json::to_string(&cleaned).unwrap()).bind(ts).execute(&pool).await.unwrap();

        // Participants bind S1→interviewer, S2→respondent.
        sqlx::query("INSERT INTO participant (id, interview_id, display_name, role, speaker_label) VALUES (?, ?, 'R', 'interviewer', 'S1')")
            .bind(Uuid::new_v4().to_string()).bind(&iv).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO participant (id, interview_id, display_name, role, speaker_label) VALUES (?, ?, 'P', 'respondent', 'S2')")
            .bind(Uuid::new_v4().to_string()).bind(&iv).execute(&pool).await.unwrap();

        let gathered = gather_interview(&pool, &iv, "iv").await.unwrap().expect("transcript exists");
        // Prefers cleaned over raw.
        assert_eq!(gathered.segments[0].text, "Clean question?");
        // Roles joined; segment ids are 0-based indices.
        assert_eq!(gathered.segments[0].speaker_role, "interviewer");
        assert_eq!(gathered.segments[1].speaker_role, "respondent");
        assert_eq!(gathered.segments[0].id, 0);
        assert_eq!(gathered.segments[1].id, 1);
    }

    // --- REAL end-to-end verify against the installed, logged-in `claude` CLI ----------
    //
    // #[ignore]d so the normal suite stays offline/fast + spends no subscription usage.
    // Builds a TINY cycle (2 short Russian interviews ~6 segments each, 3 goals), runs the
    // REAL map-reduce through `claude`, and asserts:
    //   - findings are produced, each maps to a valid goal_id,
    //   - each finding's evidence refs point at real interviews/segments,
    //   - a cycle markdown artifact + per-interview summaries are produced + stored,
    //   - editing the cycle markdown persists,
    //   - cleaned up.
    // Run: cargo test live_m10b_synthesis_verify -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_m10b_synthesis_verify() {
        use crate::adapter;

        let adapter = adapter::builtin_adapter_pub();

        let product_desc = "Acme Analytics — self-serve product analytics for early-stage SaaS. \
            Users connect a data source, define key events, and get funnels + retention. Activation = \
            first funnel created within 24h of signup.";
        let guide = "Goals:\n\
            - G1: Почему новые аккаунты застревают перед созданием первой воронки?\n\
            - G2: Какой шаг онбординга вызывает больше всего путаницы?\n\
            - G3: Что побудило бы пригласить коллегу на первой неделе?\n\n\
            Target conclusions:\n- Ранжированный список блокеров активации.";

        // Two tiny role-labeled Russian interviews (~6 segments each).
        let iv1 = InterviewInput {
            id: "iv1".into(),
            title: "P01 — основатель, dev-tools".into(),
            segments: vec![
                RoleSegment { id: 0, speaker_role: "interviewer".into(), text: "Расскажите, что вы сделали, когда впервые зашли в продукт.".into() },
                RoleSegment { id: 1, speaker_role: "respondent".into(), text: "Я увидел пустой дашборд и не понял, что делать первым.".into() },
                RoleSegment { id: 2, speaker_role: "respondent".into(), text: "Кнопка просила подключить хранилище, а у меня не было доступов под рукой, и я застрял.".into() },
                RoleSegment { id: 3, speaker_role: "interviewer".into(), text: "А что было дальше?".into() },
                RoleSegment { id: 4, speaker_role: "respondent".into(), text: "На экране событий было слишком много полей, я не был уверен и просто угадывал.".into() },
                RoleSegment { id: 5, speaker_role: "respondent".into(), text: "Если бы был мастер настройки, я бы закончил за пять минут вместо двух дней.".into() },
            ],
        };
        let iv2 = InterviewInput {
            id: "iv2".into(),
            title: "P02 — первый продакт, финтех".into(),
            segments: vec![
                RoleSegment { id: 0, speaker_role: "interviewer".into(), text: "Что показалось самым сложным в начале?".into() },
                RoleSegment { id: 1, speaker_role: "respondent".into(), text: "Подключение источника данных — пришлось идти к дата-инженеру за доступами.".into() },
                RoleSegment { id: 2, speaker_role: "respondent".into(), text: "Пока я ждал, я потерял нить того, что вообще настраивал.".into() },
                RoleSegment { id: 3, speaker_role: "respondent".into(), text: "Маппинг событий тоже путал: непонятно, какие из них важны.".into() },
                RoleSegment { id: 4, speaker_role: "interviewer".into(), text: "А что помогло бы позвать коллегу?".into() },
                RoleSegment { id: 5, speaker_role: "respondent".into(), text: "Я бы позвал команду, только когда сам разберусь и будет что показать.".into() },
            ],
        };

        let result = synthesize_cycle(None, "m10b-verify", product_desc, guide, &adapter, &[iv1.clone(), iv2.clone()])
            .await
            .expect("real synthesis should succeed");
        let doc = &result.doc;

        // Goals derived + carried.
        assert_eq!(doc.goals.len(), 3, "three goals derived from the guide");
        assert!(doc.goals.iter().any(|g| g.id == "G1"));

        // Findings produced; each maps to a real goal + has valid evidence refs.
        assert!(!doc.findings.is_empty(), "synthesis produced at least one finding");
        let valid: std::collections::HashMap<String, usize> =
            std::collections::HashMap::from([("iv1".into(), iv1.segments.len()), ("iv2".into(), iv2.segments.len())]);
        for f in &doc.findings {
            assert!(doc.goals.iter().any(|g| g.id == f.goal_id), "finding {} ties to a real goal ({})", f.id, f.goal_id);
            for e in &f.evidence {
                assert!(valid.get(&e.interview_id).is_some_and(|&n| e.segment_id < n),
                    "evidence ref {}#{} must be in range", e.interview_id, e.segment_id);
            }
        }

        // Per-interview summaries produced for each interview.
        assert_eq!(result.summaries.len(), 2, "one per-interview summary per interview");

        // Cycle markdown artifact renders the structure.
        let titles: HashMap<String, String> = HashMap::from([
            ("iv1".to_string(), iv1.title.clone()),
            ("iv2".to_string(), iv2.title.clone()),
        ]);
        let content_md = render_cycle_markdown(doc, &titles);
        assert!(content_md.contains("## Executive summary"));
        assert!(content_md.contains("## G1"));

        println!("\n=== M10b REAL synthesis: {} goals, {} findings ===", doc.goals.len(), doc.findings.len());
        println!("--- cycle markdown artifact (first 1200 chars) ---\n{}", &content_md.chars().take(1200).collect::<String>());
        if let Some((iv_id, _title, summary)) = result.summaries.first() {
            println!("\n--- per-interview summary for {iv_id} ---");
            if let Some(g) = summary.by_goal.first() {
                if let Some(p) = g.points.first() {
                    println!("[{}] {}", g.goal_id, p.point);
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

        let cycle_id = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, '__M10B_VERIFY__', ?, ?)")
            .bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();
        // Real interviews so the per-interview FK holds.
        let iv1_id = Uuid::new_v4().to_string();
        let iv2_id = Uuid::new_v4().to_string();
        for (id, title) in [(&iv1_id, "P01"), (&iv2_id, "P02")] {
            sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'cleaned', ?, ?)")
                .bind(id).bind(&cycle_id).bind(title).bind(ts).bind(ts).execute(&pool).await.unwrap();
        }
        let row_id = store_cycle_synthesis_db(&pool, &cycle_id, doc, &content_md, "live-m10b").await.unwrap();
        assert!(!row_id.is_empty());
        // Store one per-interview summary against a real interview id.
        if let Some((_iv, title, summary)) = result.summaries.first() {
            let md = render_interview_markdown(summary, title);
            store_interview_summary_db(&pool, &cycle_id, &iv1_id, summary, &md, "live-m10b").await.unwrap();
        }
        let stored = get_synthesis_db(&pool, &cycle_id).await.unwrap().expect("synthesis stored");
        assert_eq!(stored.doc.findings.len(), doc.findings.len());
        assert!(!stored.content_md.is_empty(), "cycle markdown stored");
        let stored_iv = get_interview_summary_db(&pool, &iv1_id).await.unwrap().expect("per-interview summary stored");
        assert!(!stored_iv.content_md.is_empty());
        println!("\nstored cycle synthesis id={row_id} findings={} md_len={}", stored.doc.findings.len(), stored.content_md.len());

        // Edit the cycle markdown + confirm it persists (structured layer untouched).
        let edited = save_cycle_markdown_db(&pool, &cycle_id, "# Edited by the researcher\n\nManual note.").await.unwrap();
        assert!(edited.content_md.contains("Edited by the researcher"));
        let reread = get_synthesis_db(&pool, &cycle_id).await.unwrap().unwrap();
        assert!(reread.content_md.contains("Edited by the researcher"), "edit persisted");
        assert_eq!(reread.doc.findings.len(), doc.findings.len(), "structured findings untouched by md edit");
        println!("edit persisted OK");

        sqlx::query("DELETE FROM cycle WHERE id = ?").bind(&cycle_id).execute(&pool).await.unwrap();
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM synthesis WHERE cycle_id = ?")
            .bind(&cycle_id).fetch_one(&pool).await.unwrap();
        assert_eq!(left, 0, "cleanup left synthesis rows");
        println!("M10b live verify OK: per-interview + cycle artifacts stored, edit persisted, cleaned up.\n");
    }

    // ===================================================================================
    // SEED STAGE 3 — synthesis (real `claude` map-reduce) for BOTH waves.
    //
    // Mirrors run_synthesis exactly but headless (app = None): for each seeded cycle,
    // gather every interview's best (cleaned) role-labeled transcript, run
    // synthesize_cycle, then persist per-interview summaries + the cycle artifact
    // (findings_json + editable markdown) via the real store_*_db helpers.
    //
    // Idempotent: skips a cycle that already has a stored cycle synthesis. Real Claude
    // usage: one extract per interview + one reduce per cycle.
    //
    // Run: src-tauri\target\cuda-build.cmd test --features cuda seed_stage3 -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn seed_stage3_synthesis() {
        use crate::adapter;
        use serde_json::json;

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

        let adapter = adapter::builtin_adapter_pub();

        for cycle_id in [CYCLE_W1, CYCLE_W2] {
            if get_synthesis_db(&pool, cycle_id).await.unwrap().is_some() {
                println!("skip {cycle_id}: cycle synthesis already present");
                continue;
            }

            let (name, product_desc): (String, String) =
                sqlx::query_as("SELECT name, product_desc FROM cycle WHERE id = ?")
                    .bind(cycle_id)
                    .fetch_optional(&pool)
                    .await
                    .unwrap()
                    .expect("cycle exists (run stage 1 first)");
            let guide = effective_guide_db(&pool, cycle_id).await.unwrap().expect("guide");

            // Gather interviews exactly like run_synthesis.
            let interview_rows: Vec<(String, String)> =
                sqlx::query_as("SELECT id, title FROM interview WHERE cycle_id = ? ORDER BY created_at ASC")
                    .bind(cycle_id)
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let mut interviews: Vec<InterviewInput> = Vec::new();
            for (id, title) in &interview_rows {
                if let Some(iv) = gather_interview(&pool, id, title).await.unwrap() {
                    if !iv.segments.is_empty() {
                        interviews.push(iv);
                    }
                }
            }
            assert!(!interviews.is_empty(), "no cleaned interviews for {name} (run stage 2 first)");
            println!("synthesizing {name}: {} interviews via claude ...", interviews.len());

            let result = synthesize_cycle(None, cycle_id, &product_desc, &guide, &adapter, &interviews)
                .await
                .expect("real synthesis should succeed");

            // Persist per-interview summaries (MAP artifacts).
            for (iv_id, title, summary) in &result.summaries {
                let md = render_interview_markdown(summary, title);
                let meta = json!({ "adapter": adapter.id, "from": "seed" }).to_string();
                store_interview_summary_db(&pool, cycle_id, iv_id, summary, &md, &meta).await.unwrap();
            }

            // Render + persist the cycle artifact.
            let titles = interview_titles_db(&pool, cycle_id).await.unwrap();
            let content_md = render_cycle_markdown(&result.doc, &titles);
            let model_meta = json!({
                "adapter": adapter.id,
                "cycle": name,
                "interviews": interviews.len(),
                "goals": result.doc.goals.len(),
                "findings": result.doc.findings.len(),
            })
            .to_string();
            let row_id = store_cycle_synthesis_db(&pool, cycle_id, &result.doc, &content_md, &model_meta).await.unwrap();
            println!(
                "  stored synthesis id={row_id}: {} goals, {} findings, {} summaries",
                result.doc.goals.len(),
                result.doc.findings.len(),
                result.summaries.len()
            );
            if let Some(f) = result.doc.findings.first() {
                println!("  sample finding [{}|{}]: {}", f.id, f.goal_id, f.statement.chars().take(120).collect::<String>());
            }
        }

        println!("SEED STAGE 3 OK: cycle synthesis + per-interview summaries for both waves.");
    }
}
