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

// --- structured guide template (the 5 fixed blocks) ---------------------------
//
// The templated guide (req: "шаблонизировать гайд"). A guide is now optionally a STRUCTURED
// document with five fixed blocks the user fills by clicking "+ add":
//   1. hypotheses          — гипотезы, которые надо провалидировать (ids H1, H2, …)
//   2. tasks               — задачи, которые должны решаться интервью (ids G1, G2, … — these
//                            ARE the synthesis "goals", the stable spine the diff aligns on)
//   3. qualifying_questions— квалифицирующие вопросы (question ids Q1, Q2, …)
//   4. main_blocks         — основная часть: question blocks grouped by theme (each block has
//                            a title + its own questions; questions share the global Q counter)
//   5. hypothesis_questions— вопросы по гипотезам (question ids continue the global Q counter)
//
// The template is stored as JSON on the guide (guide.template_json) and is the source the
// structured editor binds to. On every write the backend RENDERS a canonical content_md from
// it (render_template_md) so everything that reads the guide as markdown — derive_goals, the
// chat context pack, back-compat — keeps working unchanged. Ids are STABLE (re-stamped
// positionally on each save, exactly like derive_goals), so the same template across waves
// yields the same H/G/Q ids → the diff can align hypotheses + findings wave-over-wave.

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct TemplateItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub text: String,
}

// One themed block of main questions ("основная часть" sub-block). Title is the theme;
// questions carry global Q ids so per-question synthesis answers stay unambiguous.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct QuestionBlock {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub questions: Vec<TemplateItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct GuideTemplate {
    #[serde(default)]
    pub hypotheses: Vec<TemplateItem>,
    #[serde(default)]
    pub tasks: Vec<TemplateItem>,
    #[serde(default)]
    pub qualifying_questions: Vec<TemplateItem>,
    #[serde(default)]
    pub main_blocks: Vec<QuestionBlock>,
    #[serde(default)]
    pub hypothesis_questions: Vec<TemplateItem>,
}

// One question handed to the model with its section context so it knows WHERE in the guide
// it sits (a qualifying screen vs a main-theme probe vs a hypothesis check). The synthesis
// must answer EVERY one of these, directly or indirectly.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct GuideQuestion {
    pub id: String,
    pub text: String,
    pub section: String, // "qualifying" | "main" | "hypothesis"
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub block: String, // the main-block theme (only for section == "main")
}

impl GuideTemplate {
    // Parse a stored template_json; a blank/invalid blob is an empty template (legacy guide).
    pub fn parse(json: &str) -> GuideTemplate {
        let t = json.trim();
        if t.is_empty() {
            return GuideTemplate::default();
        }
        serde_json::from_str(t).unwrap_or_default()
    }

    // True when the guide carries no structured template (a legacy / free-markdown guide).
    pub fn is_empty(&self) -> bool {
        self.hypotheses.is_empty()
            && self.tasks.is_empty()
            && self.qualifying_questions.is_empty()
            && self.main_blocks.iter().all(|b| b.questions.is_empty() && b.title.trim().is_empty())
            && self.hypothesis_questions.is_empty()
    }

    // Re-stamp stable ids + trim/drop blanks. Hypotheses → H1.., tasks → G1.. (the goal ids),
    // and EVERY question (qualifying, then each main block in order, then hypothesis questions)
    // shares one global Q counter so each has a unique, stable Qn. Mirrors derive_goals'
    // positional id discipline: the SAME template always yields the SAME ids.
    pub fn normalized(&self) -> GuideTemplate {
        let stamp = |items: &[TemplateItem], prefix: &str, start: usize| -> (Vec<TemplateItem>, usize) {
            let mut out = Vec::new();
            let mut n = start;
            for it in items {
                let text = it.text.trim();
                if text.is_empty() {
                    continue;
                }
                out.push(TemplateItem { id: format!("{prefix}{n}"), text: text.to_string() });
                n += 1;
            }
            (out, n)
        };

        let (hypotheses, _) = stamp(&self.hypotheses, "H", 1);
        let (tasks, _) = stamp(&self.tasks, "G", 1);

        let mut q = 1usize;
        let (qualifying_questions, next) = stamp(&self.qualifying_questions, "Q", q);
        q = next;

        let mut main_blocks: Vec<QuestionBlock> = Vec::new();
        for block in &self.main_blocks {
            let (questions, next) = stamp(&block.questions, "Q", q);
            q = next;
            let title = block.title.trim().to_string();
            // Drop a block that is entirely empty (no title, no questions); keep a titled
            // block even if it has no questions yet (the user may be drafting it).
            if title.is_empty() && questions.is_empty() {
                continue;
            }
            main_blocks.push(QuestionBlock { title, questions });
        }

        let (hypothesis_questions, _) = stamp(&self.hypothesis_questions, "Q", q);

        GuideTemplate {
            hypotheses,
            tasks,
            qualifying_questions,
            main_blocks,
            hypothesis_questions,
        }
    }

    // The synthesis "goals" derived from the template's TASKS (ids already G1..). This is the
    // stable spine the cycle synthesis + diff align on when a template is present.
    pub fn goals(&self) -> Vec<Goal> {
        self.tasks
            .iter()
            .map(|t| Goal { id: t.id.clone(), text: t.text.clone() })
            .collect()
    }

    // Every guide question flattened with its section context, in document order. The
    // synthesis must produce an answer for each (direct or indirect).
    pub fn questions(&self) -> Vec<GuideQuestion> {
        let mut out: Vec<GuideQuestion> = Vec::new();
        for it in &self.qualifying_questions {
            out.push(GuideQuestion { id: it.id.clone(), text: it.text.clone(), section: "qualifying".into(), block: String::new() });
        }
        for block in &self.main_blocks {
            for it in &block.questions {
                out.push(GuideQuestion { id: it.id.clone(), text: it.text.clone(), section: "main".into(), block: block.title.clone() });
            }
        }
        for it in &self.hypothesis_questions {
            out.push(GuideQuestion { id: it.id.clone(), text: it.text.clone(), section: "hypothesis".into(), block: String::new() });
        }
        out
    }
}

// Render the structured template into a canonical markdown guide. Tasks go under a "## Goals"
// heading with explicit "Gn:" tags so derive_goals reads back IDENTICAL goal ids (the single
// source of truth for goals stays derive_goals(content_md)). The other sections are rendered
// for human reading + the chat context pack; their ids round-trip too. Assumes a normalized
// template (call `.normalized()` first). Returns "" for an empty template.
pub fn render_template_md(t: &GuideTemplate) -> String {
    if t.is_empty() {
        return String::new();
    }
    let mut md = String::new();

    let section = |md: &mut String, heading: &str, items: &[TemplateItem]| {
        if items.is_empty() {
            return;
        }
        md.push_str(&format!("## {heading}\n\n"));
        for it in items {
            md.push_str(&format!("- {}: {}\n", it.id, it.text));
        }
        md.push('\n');
    };

    section(&mut md, "Hypotheses", &t.hypotheses);
    // Tasks → "Goals" so derive_goals picks them up as the stable goal spine.
    section(&mut md, "Goals", &t.tasks);
    section(&mut md, "Qualifying questions", &t.qualifying_questions);

    if t.main_blocks.iter().any(|b| !b.title.trim().is_empty() || !b.questions.is_empty()) {
        md.push_str("## Main questions\n\n");
        for (i, block) in t.main_blocks.iter().enumerate() {
            let title = if block.title.trim().is_empty() {
                format!("Block {}", i + 1)
            } else {
                block.title.trim().to_string()
            };
            md.push_str(&format!("### {title}\n\n"));
            for it in &block.questions {
                md.push_str(&format!("- {}: {}\n", it.id, it.text));
            }
            md.push('\n');
        }
    }

    section(&mut md, "Hypothesis questions", &t.hypothesis_questions);

    md.trim_end().to_string()
}

// --- shared analysis system prompt (the rules every guide-grounded stage obeys) ----
//
// One source of truth for HOW the model must read an interview against a templated guide,
// injected as the top-level `system` field of every analysis task's input (extract / reduce /
// diff / chat). The renderer (adapter::render_prompt) serializes the whole input JSON into the
// prompt, so the model always sees these rules. Keeping it in one place means the per-interview
// summary, the cycle synthesis, the diff, and the chat all reason the SAME way (req: "системный
// промпт должен все это описывать агенту который будет работать с интервью … учитывать на
// остальных этапах суммаризации интервью, цикла, диффа").
pub fn analysis_system_prompt() -> &'static str {
    "You are a senior user-research analyst. You work STRICTLY against a templated interview \
     guide and a separate product description. Absolute rules:\n\
     1. ANSWER THE WHOLE GUIDE — never skip anything. Address every hypothesis, every research \
        task/goal, and every question in the guide (qualifying, main, and hypothesis questions). \
        If the interview gives nothing on an item, say so explicitly (\"not answered\" / \
        \"inconclusive\") rather than dropping it.\n\
     2. USE THE PRODUCT DESCRIPTION as context for interpreting what respondents mean (product \
        terms, the activation moment, the value prop). Read answers through that lens, but never \
        let the product description substitute for actual interview evidence.\n\
     3. INDIRECT ANSWERS COUNT. A question is rarely asked verbatim and respondents routinely \
        answer one question while talking about another. Credit an answer to a question whenever \
        the transcript speaks to it, EVEN IF that question was never literally asked — and mark \
        HOW it was answered: directly, indirectly (surfaced while discussing something else), or \
        not answered.\n\
     4. HYPOTHESES: for each hypothesis decide a verdict — confirmed, partially confirmed, \
        refuted, or inconclusive — with a short rationale grounded in evidence. Weigh \
        contradicting evidence honestly; do not force a verdict the transcript doesn't support.\n\
     5. EVIDENCE: weight RESPONDENT statements over interviewer prompts. Quote VERBATIM, in the \
        original language — never translate or paraphrase a quote — and cite the segment_id it \
        came from. Prefer a few strong quotes over many weak ones.\n\
     6. BE HONEST ABOUT GAPS. Do not invent findings, do not overstate confidence, and do not \
        report a hypothesis as confirmed on thin evidence. \"Inconclusive\" and \"not answered\" \
        are valid, useful outcomes.\n\
     Follow the per-task `instructions` for the exact output shape; these rules govern HOW you \
     reason regardless of the stage."
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
    // Templated guide: per-question answers + per-hypothesis signals THIS interview supports.
    #[serde(default)]
    question_answers: Vec<RawQuestionSignal>,
    #[serde(default)]
    hypothesis_signals: Vec<RawHypothesisSignal>,
}

// One per-interview question answer as the model returns it: which guide question, whether it
// was answered directly / indirectly / not at all, a short summary, and the supporting quotes.
#[derive(Deserialize, Debug, Default)]
struct RawQuestionSignal {
    #[serde(default)]
    question_id: String,
    #[serde(default)]
    status: String, // direct | indirect | not_answered
    #[serde(default)]
    summary: String,
    #[serde(default)]
    quotes: Vec<ExtractedQuote>,
}

// One per-interview hypothesis signal as the model returns it: which hypothesis, whether this
// interview supports / contradicts / is mixed-or-neutral on it, a short note, and quotes.
#[derive(Deserialize, Debug, Default)]
struct RawHypothesisSignal {
    #[serde(default)]
    hypothesis_id: String,
    #[serde(default)]
    stance: String, // supports | contradicts | mixed | neutral
    #[serde(default)]
    note: String,
    #[serde(default)]
    quotes: Vec<ExtractedQuote>,
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

// A per-interview answer to one guide question (validated): which question, how it was
// answered (direct / indirect / not_answered), a short summary, and supporting quotes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct InterviewQuestionAnswer {
    pub question_id: String,
    pub status: String, // direct | indirect | not_answered
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub quotes: Vec<InterviewQuote>,
}

// A per-interview signal on one hypothesis (validated): supports / contradicts / mixed /
// neutral, a short note, and supporting quotes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct InterviewHypothesisSignal {
    pub hypothesis_id: String,
    pub stance: String, // supports | contradicts | mixed | neutral
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub quotes: Vec<InterviewQuote>,
}

// The full per-interview summary doc stored in synthesis.findings_json for a per-interview
// row (interview_id set). Carries the goals used (for grouped rendering) + per-goal points +
// notable quotes/surprises, plus (templated guide) the guide's hypotheses/questions with this
// interview's per-question answers + per-hypothesis signals. The new fields default empty so
// older rows (and legacy free-markdown guides) still deserialize + render exactly as before.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct InterviewSummaryDoc {
    pub goals: Vec<Goal>,
    pub by_goal: Vec<InterviewGoalSummary>,
    #[serde(default)]
    pub notable: Vec<NotableQuote>,
    #[serde(default)]
    pub hypotheses: Vec<TemplateItem>,
    #[serde(default)]
    pub questions: Vec<GuideQuestion>,
    #[serde(default)]
    pub question_answers: Vec<InterviewQuestionAnswer>,
    #[serde(default)]
    pub hypothesis_signals: Vec<InterviewHypothesisSignal>,
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

// One cross-interview hypothesis verdict as the model returns it (validated server-side).
#[derive(Deserialize, Debug, Default)]
struct RawHypothesisVerdict {
    #[serde(default)]
    hypothesis_id: String,
    #[serde(default)]
    verdict: String, // confirmed | partially | refuted | inconclusive
    #[serde(default)]
    confidence: String, // high | medium | low
    #[serde(default)]
    rationale: String,
    #[serde(default)]
    evidence: Vec<Evidence>,
}

// One cross-interview, consolidated answer to a guide question as the model returns it.
#[derive(Deserialize, Debug, Default)]
struct RawQuestionAnswer {
    #[serde(default)]
    question_id: String,
    #[serde(default)]
    status: String, // answered | partially | not_answered
    #[serde(default)]
    answer: String,
    #[serde(default)]
    evidence: Vec<Evidence>,
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
    // Templated guide: verdicts per hypothesis + consolidated answers per question.
    #[serde(default)]
    hypothesis_verdicts: Vec<RawHypothesisVerdict>,
    #[serde(default)]
    question_answers: Vec<RawQuestionAnswer>,
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

// A validated, cross-interview verdict on one guide hypothesis (templated guide). `verdict`
// is normalized to confirmed|partially|refuted|inconclusive; the diff aligns these by `id`
// wave-over-wave to surface verdict shifts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HypothesisVerdict {
    pub id: String, // H1..  (matches the guide template's hypothesis ids)
    pub text: String,
    pub verdict: String, // confirmed | partially | refuted | inconclusive
    pub confidence: String, // high | medium | low
    #[serde(default)]
    pub rationale: String,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

// A validated, cross-interview consolidated answer to one guide question (templated guide).
// `status` is normalized to answered|partially|not_answered so the UI can flag what the wave
// left open — req: "суммаризация под каждый вопрос … не пропуская ничего".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QuestionAnswer {
    pub id: String, // Q1..  (matches the guide template's question ids)
    pub text: String,
    #[serde(default)]
    pub section: String, // qualifying | main | hypothesis
    #[serde(default)]
    pub block: String, // the main-block theme (only for section == "main")
    pub status: String, // answered | partially | not_answered
    #[serde(default)]
    pub answer: String,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

// The full synthesis document stored in the cycle row's synthesis.findings_json. Carries the
// GOALS used (for the M9 diff + grouped UI) alongside the findings, open questions, the
// executive summary, and the optional by-role breakdown (M10b). Templated guide: also the
// guide's hypotheses + questions with cross-interview verdicts/answers. All new fields default
// so older M8/M10b rows (and legacy free-markdown guides) still deserialize cleanly.
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
    // Templated-guide additions.
    #[serde(default)]
    pub hypotheses: Vec<TemplateItem>,
    #[serde(default)]
    pub questions: Vec<GuideQuestion>,
    #[serde(default)]
    pub hypothesis_verdicts: Vec<HypothesisVerdict>,
    #[serde(default)]
    pub question_answers: Vec<QuestionAnswer>,
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
    // A quote ref array (segment_id + verbatim quote), reused across point/answer/signal.
    let quotes = json!({
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
    });
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["points", "notable", "question_answers", "hypothesis_signals"],
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
                        "quotes": quotes
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
            },
            "question_answers": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["question_id", "status", "summary", "quotes"],
                    "properties": {
                        "question_id": { "type": "string" },
                        "status": { "type": "string", "enum": ["direct", "indirect", "not_answered"] },
                        "summary": { "type": "string" },
                        "quotes": quotes
                    }
                }
            },
            "hypothesis_signals": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["hypothesis_id", "stance", "note", "quotes"],
                    "properties": {
                        "hypothesis_id": { "type": "string" },
                        "stance": { "type": "string", "enum": ["supports", "contradicts", "mixed", "neutral"] },
                        "note": { "type": "string" },
                        "quotes": quotes
                    }
                }
            }
        }
    })
}

fn reduce_schema() -> Value {
    // An evidence ref array (interview_id + segment_id + verbatim quote), reused below.
    let evidence = json!({
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
    });
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["executive_summary", "findings", "open_questions", "by_role", "hypothesis_verdicts", "question_answers"],
        "properties": {
            "executive_summary": { "type": "string" },
            "hypothesis_verdicts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["hypothesis_id", "verdict", "confidence", "rationale", "evidence"],
                    "properties": {
                        "hypothesis_id": { "type": "string" },
                        "verdict": { "type": "string", "enum": ["confirmed", "partially", "refuted", "inconclusive"] },
                        "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
                        "rationale": { "type": "string" },
                        "evidence": evidence.clone()
                    }
                }
            },
            "question_answers": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["question_id", "status", "answer", "evidence"],
                    "properties": {
                        "question_id": { "type": "string" },
                        "status": { "type": "string", "enum": ["answered", "partially", "not_answered"] },
                        "answer": { "type": "string" },
                        "evidence": evidence.clone()
                    }
                }
            },
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
    hypotheses: &[TemplateItem],
    questions: &[GuideQuestion],
    interview: &InterviewInput,
) -> Value {
    json!({
        "task": "cycle-synthesis-extract",
        "system": analysis_system_prompt(),
        "instructions": "You are summarizing ONE user-research interview, structured by the guide. \
            (1) For EACH goal, extract the concrete, goal-relevant `points` THIS interview supports, each with \
            short VERBATIM quotes (original language — never translate) + the `segment_id`. \
            (2) For EVERY guide question in `questions`, output a `question_answers` entry: set `status` to \
            `direct` (asked & answered), `indirect` (answered while discussing something else — credit it even \
            if never asked verbatim), or `not_answered`; give a one-to-two sentence `summary` (empty when \
            not_answered) and the supporting `quotes`. Do not skip any question. \
            (3) For EVERY hypothesis in `hypotheses`, output a `hypothesis_signals` entry: `stance` is \
            `supports`, `contradicts`, `mixed`, or `neutral` (neutral = this interview says nothing about it), \
            with a short `note` + quotes. \
            (4) ALSO list any `notable` quotes or surprises (each with `segment_id`, `quote`, one-line `note`). \
            Weight RESPONDENT statements over interviewer prompts. Use ONLY the goal_ids / question_id / \
            hypothesis_id provided. Return ONLY JSON matching the schema.",
        "product_desc": product_desc,
        "goals": goals,
        "hypotheses": hypotheses,
        "questions": questions,
        "interview": interview
    })
}

fn build_reduce_input(
    product_desc: &str,
    guide: &str,
    goals: &[Goal],
    hypotheses: &[TemplateItem],
    questions: &[GuideQuestion],
    extractions: &[InterviewExtraction],
) -> Value {
    json!({
        "task": "cycle-synthesis-reduce",
        "system": analysis_system_prompt(),
        "instructions": "You are synthesizing ACROSS all interviews in a research wave, STRICTLY FOLLOWING the \
            guide. Using the per-interview extractions below, produce: \
            (1) a 2-4 sentence `executive_summary` of the wave; \
            (2) `hypothesis_verdicts` — one entry for EVERY hypothesis in `hypotheses`: a `verdict` \
            (`confirmed`|`partially`|`refuted`|`inconclusive`), a `confidence` (high|medium|low), a `rationale`, \
            and `evidence` (strongest verbatim quotes with `interview_id` + `segment_id`). Never omit a \
            hypothesis; use `inconclusive` when the wave is thin. \
            (3) `question_answers` — one entry for EVERY question in `questions`: a `status` \
            (`answered`|`partially`|`not_answered`), a consolidated `answer` across interviews (note when it was \
            answered only indirectly), and `evidence`. Do not skip any question. \
            (4) cross-interview FINDINGS — each bound to one `goal_id`, with a `statement`, `confidence`, \
            `support_count`, `evidence`, and a short `recommendation`; \
            (5) `open_questions` the wave did not resolve; and (6) an optional `by_role` breakdown per goal. \
            Use ONLY the goal_ids / hypothesis_id / question_id provided. Return ONLY JSON matching the schema.",
        "product_desc": product_desc,
        "guide": guide,
        "goals": goals,
        "hypotheses": hypotheses,
        "questions": questions,
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

// Keep only evidence refs that point at a real interview + an in-range segment. Shared by the
// findings / hypothesis / question assembly so every cited quote is traceable (the same
// discipline assemble_findings applies inline).
fn valid_evidence(raw: &[Evidence], valid_segments: &HashMap<String, usize>) -> Vec<Evidence> {
    raw.iter()
        .filter(|e| valid_segments.get(&e.interview_id).is_some_and(|&n| e.segment_id < n))
        .map(|e| Evidence {
            interview_id: e.interview_id.clone(),
            segment_id: e.segment_id,
            quote: e.quote.trim().to_string(),
        })
        .collect()
}

// Build one verdict per guide hypothesis, in guide order — NEVER skipping one (req: answer the
// whole guide). The model's verdict is used when present + valid; a missing/blank hypothesis
// falls back to `inconclusive` so the UI always shows every hypothesis. Verdict + confidence
// are normalized; evidence is clamped to real refs.
fn assemble_hypothesis_verdicts(
    hypotheses: &[TemplateItem],
    valid_segments: &HashMap<String, usize>,
    output: &ReduceOutput,
) -> Vec<HypothesisVerdict> {
    hypotheses
        .iter()
        .map(|h| {
            let raw = output.hypothesis_verdicts.iter().find(|v| v.hypothesis_id == h.id);
            let verdict = raw
                .map(|r| match r.verdict.trim().to_lowercase().as_str() {
                    "confirmed" => "confirmed",
                    "partially" | "partial" | "partially confirmed" => "partially",
                    "refuted" | "rejected" | "disproven" => "refuted",
                    _ => "inconclusive",
                })
                .unwrap_or("inconclusive")
                .to_string();
            let confidence = raw
                .map(|r| match r.confidence.trim().to_lowercase().as_str() {
                    "high" => "high",
                    "low" => "low",
                    _ => "medium",
                })
                .unwrap_or("low")
                .to_string();
            let rationale = raw.map(|r| r.rationale.trim().to_string()).unwrap_or_default();
            let evidence = raw.map(|r| valid_evidence(&r.evidence, valid_segments)).unwrap_or_default();
            HypothesisVerdict { id: h.id.clone(), text: h.text.clone(), verdict, confidence, rationale, evidence }
        })
        .collect()
}

// Build one consolidated answer per guide question, in guide order — NEVER skipping one. A
// missing/blank question falls back to `not_answered`. Status is normalized; evidence clamped.
fn assemble_question_answers(
    questions: &[GuideQuestion],
    valid_segments: &HashMap<String, usize>,
    output: &ReduceOutput,
) -> Vec<QuestionAnswer> {
    questions
        .iter()
        .map(|q| {
            let raw = output.question_answers.iter().find(|a| a.question_id == q.id);
            let answer = raw.map(|r| r.answer.trim().to_string()).unwrap_or_default();
            let mapped = raw
                .map(|r| match r.status.trim().to_lowercase().as_str() {
                    "answered" | "direct" => "answered",
                    "partially" | "partial" | "indirect" => "partially",
                    _ => "not_answered",
                })
                .unwrap_or("not_answered");
            // Defensive: a non-not_answered status with no answer text is really not answered.
            let status = if answer.is_empty() { "not_answered" } else { mapped }.to_string();
            let evidence = raw.map(|r| valid_evidence(&r.evidence, valid_segments)).unwrap_or_default();
            QuestionAnswer {
                id: q.id.clone(),
                text: q.text.clone(),
                section: q.section.clone(),
                block: q.block.clone(),
                status,
                answer,
                evidence,
            }
        })
        .collect()
}

// --- editable markdown artifact rendering (pure + unit-tested) -----------------

// Human-readable labels for hypothesis verdicts / question-answer statuses (used in the
// rendered markdown artifacts; the structured UI maps the same enum values to badges).
fn verdict_label(v: &str) -> &'static str {
    match v {
        "confirmed" => "Confirmed",
        "partially" => "Partially confirmed",
        "refuted" => "Refuted",
        _ => "Inconclusive",
    }
}

fn question_status_label(s: &str) -> &'static str {
    match s {
        "answered" => "Answered",
        "partially" => "Partially answered",
        _ => "Not answered",
    }
}

fn signal_label(s: &str) -> &'static str {
    match s {
        "supports" => "Supports",
        "contradicts" => "Contradicts",
        "mixed" => "Mixed",
        _ => "Neutral",
    }
}


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

    // Hypotheses — each verdict, with rationale + evidence (templated guide).
    if !doc.hypothesis_verdicts.is_empty() {
        md.push_str("## Hypotheses\n\n");
        for h in &doc.hypothesis_verdicts {
            md.push_str(&format!(
                "### {} — {} · _{} confidence_\n\n{}\n\n",
                h.id,
                verdict_label(&h.verdict),
                h.confidence,
                h.text.trim(),
            ));
            if !h.rationale.trim().is_empty() {
                md.push_str(&format!("{}\n\n", h.rationale.trim()));
            }
            for e in &h.evidence {
                if e.quote.trim().is_empty() {
                    continue;
                }
                let who = title_for.get(&e.interview_id).cloned().unwrap_or_else(|| e.interview_id.clone());
                md.push_str(&format!("> {}\n> — {} · segment {}\n\n", e.quote.trim(), who, e.segment_id + 1));
            }
        }
    }

    // Questions — a consolidated answer per guide question (templated guide).
    if !doc.question_answers.is_empty() {
        md.push_str("## Questions\n\n");
        for q in &doc.question_answers {
            md.push_str(&format!("### {} — {}\n\n_{}_\n\n", q.id, question_status_label(&q.status), q.text.trim()));
            if !q.answer.trim().is_empty() {
                md.push_str(&format!("{}\n\n", q.answer.trim()));
            }
            for e in &q.evidence {
                if e.quote.trim().is_empty() {
                    continue;
                }
                let who = title_for.get(&e.interview_id).cloned().unwrap_or_else(|| e.interview_id.clone());
                md.push_str(&format!("> {}\n> — {} · segment {}\n\n", e.quote.trim(), who, e.segment_id + 1));
            }
        }
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
// (goal_id / question_id / hypothesis_id real, segment refs in range) + grouping points by
// goal in goal order. `hypotheses` / `questions` are the guide template's items (empty for a
// legacy free-markdown guide → the new sections stay empty). Pure.
fn assemble_interview_summary(
    goals: &[Goal],
    hypotheses: &[TemplateItem],
    questions: &[GuideQuestion],
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

    // Per-question answers: keep only entries that reference a real guide question; normalize
    // the status; clamp quotes. We keep the model's entries as-is (the cycle reduce is what
    // force-fills "not_answered" for every question); here we just record what this interview
    // surfaced. A quote-ref helper local to this interview's segment count.
    let clamp_quotes = |qs: &[ExtractedQuote]| -> Vec<InterviewQuote> {
        qs.iter()
            .filter(|q| q.segment_id < segment_count)
            .map(|q| InterviewQuote { segment_id: q.segment_id, quote: q.quote.trim().to_string() })
            .collect()
    };
    let q_ids: std::collections::HashSet<&str> = questions.iter().map(|q| q.id.as_str()).collect();
    let question_answers: Vec<InterviewQuestionAnswer> = output
        .question_answers
        .iter()
        .filter(|a| q_ids.contains(a.question_id.as_str()))
        .map(|a| {
            let status = match a.status.trim().to_lowercase().as_str() {
                "direct" => "direct",
                "indirect" => "indirect",
                _ => "not_answered",
            }
            .to_string();
            InterviewQuestionAnswer {
                question_id: a.question_id.clone(),
                status,
                summary: a.summary.trim().to_string(),
                quotes: clamp_quotes(&a.quotes),
            }
        })
        // Drop a not_answered entry with nothing to say (noise); keep answered ones always.
        .filter(|a| a.status != "not_answered" || !a.summary.is_empty() || !a.quotes.is_empty())
        .collect();

    // Per-hypothesis signals: keep real-hypothesis entries; normalize stance; clamp quotes.
    let h_ids: std::collections::HashSet<&str> = hypotheses.iter().map(|h| h.id.as_str()).collect();
    let hypothesis_signals: Vec<InterviewHypothesisSignal> = output
        .hypothesis_signals
        .iter()
        .filter(|s| h_ids.contains(s.hypothesis_id.as_str()))
        .map(|s| {
            let stance = match s.stance.trim().to_lowercase().as_str() {
                "supports" => "supports",
                "contradicts" => "contradicts",
                "mixed" => "mixed",
                _ => "neutral",
            }
            .to_string();
            InterviewHypothesisSignal {
                hypothesis_id: s.hypothesis_id.clone(),
                stance,
                note: s.note.trim().to_string(),
                quotes: clamp_quotes(&s.quotes),
            }
        })
        // Drop a neutral signal with nothing to say; keep supports/contradicts/mixed always.
        .filter(|s| s.stance != "neutral" || !s.note.is_empty() || !s.quotes.is_empty())
        .collect();

    InterviewSummaryDoc {
        goals: goals.to_vec(),
        by_goal,
        notable,
        hypotheses: hypotheses.to_vec(),
        questions: questions.to_vec(),
        question_answers,
        hypothesis_signals,
    }
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

    // Hypothesis signals (templated guide): how this interview bears on each hypothesis.
    if !doc.hypothesis_signals.is_empty() {
        md.push_str("## Hypothesis signals\n\n");
        for s in &doc.hypothesis_signals {
            let text = doc.hypotheses.iter().find(|h| h.id == s.hypothesis_id).map(|h| h.text.clone()).unwrap_or_default();
            md.push_str(&format!("- **{} · {}** — {}\n", s.hypothesis_id, signal_label(&s.stance), text.trim()));
            if !s.note.trim().is_empty() {
                md.push_str(&format!("  {}\n", s.note.trim()));
            }
            for q in &s.quotes {
                if !q.quote.trim().is_empty() {
                    md.push_str(&format!("  > {} _(segment {})_\n", q.quote.trim(), q.segment_id + 1));
                }
            }
        }
        md.push('\n');
    }

    // Question answers (templated guide): what this interview answered, direct or indirect.
    let answered: Vec<&InterviewQuestionAnswer> =
        doc.question_answers.iter().filter(|a| a.status != "not_answered").collect();
    if !answered.is_empty() {
        md.push_str("## Question answers\n\n");
        for a in answered {
            let text = doc.questions.iter().find(|q| q.id == a.question_id).map(|q| q.text.clone()).unwrap_or_default();
            let how = if a.status == "indirect" { " _(indirect)_" } else { "" };
            md.push_str(&format!("- **{}**{} — {}\n", a.question_id, how, text.trim()));
            if !a.summary.trim().is_empty() {
                md.push_str(&format!("  {}\n", a.summary.trim()));
            }
            for q in &a.quotes {
                if !q.quote.trim().is_empty() {
                    md.push_str(&format!("  > {} _(segment {})_\n", q.quote.trim(), q.segment_id + 1));
                }
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

// The structured guide TEMPLATE a cycle's pipeline reasons against (templated guide): the
// linked guide's parsed template_json, or an EMPTY template when the cycle has no linked guide
// / the guide is a legacy free-markdown one. Empty → the synthesis behaves exactly as before
// (goals-only, no hypothesis/question sections). pub(crate) so synthesis + diff share it.
pub(crate) async fn effective_guide_template_db(
    pool: &SqlitePool,
    cycle_id: &str,
) -> Result<GuideTemplate, String> {
    let guide_id: Option<Option<String>> = sqlx::query_scalar("SELECT guide_id FROM cycle WHERE id = ?")
        .bind(cycle_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let Some(Some(gid)) = guide_id.filter(|g| g.as_ref().is_some_and(|s| !s.is_empty())) else {
        return Ok(GuideTemplate::default());
    };
    let template_json: Option<String> = sqlx::query_scalar("SELECT template_json FROM guide WHERE id = ?")
        .bind(&gid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(template_json.map(|j| GuideTemplate::parse(&j)).unwrap_or_default())
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
    hypotheses: &[TemplateItem],
    questions: &[GuideQuestion],
    interview: &InterviewInput,
    // The user's synthesis-bucket model override (None → the plugin's manifest default).
    model_override: Option<&str>,
) -> (ExtractOutput, InterviewExtraction) {
    let input = build_extract_input(product_desc, goals, hypotheses, questions, interview);
    let schema = extract_schema();

    // The model comes from the user override or the plugin's per-task manifest default
    // (for Claude Code, `sonnet` — good reasoning, faster than the heavy default).
    // NOTE: a MAP-stage failure is non-fatal (one interview contributing no points must not
    // sink the whole cycle synthesis), so we degrade to an empty extraction — but we LOG it
    // loudly, because silently dropping an interview's evidence is exactly the kind of thing
    // a debugging agent needs to see (the reduce will be missing this interview's points).
    let output = match crate::adapter::run_cli_task_model(adapter, "cycle-synthesis-extract", &input, Some(&schema), model_override).await
    {
        Ok(value) => match serde_json::from_value::<ExtractOutput>(value.clone()) {
            Ok(o) => o,
            Err(e) => {
                log::warn!(
                    target: "interviewlab::synthesis",
                    "[E-SYN-EXTRACT] extract: interview='{}' ('{}') returned an unparseable shape — dropping its points: {e}. Got: {}",
                    interview.id, interview.title,
                    crate::logging::truncate(&value.to_string(), 1500)
                );
                ExtractOutput::default()
            }
        },
        Err(e) => {
            log::warn!(
                target: "interviewlab::synthesis",
                "[E-SYN-EXTRACT] extract: interview='{}' ('{}') CLI call FAILED — this interview contributes NO points to the synthesis: {e}",
                interview.id, interview.title
            );
            ExtractOutput::default()
        }
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
    hypotheses: &[TemplateItem],
    questions: &[GuideQuestion],
    extractions: &[InterviewExtraction],
    valid_segments: &HashMap<String, usize>,
    // The user's synthesis-bucket model override (None → the plugin's manifest default).
    model_override: Option<&str>,
) -> Result<SynthesisDoc, String> {
    let input = build_reduce_input(product_desc, guide, goals, hypotheses, questions, extractions);
    let schema = reduce_schema();

    // The model comes from the user override or the plugin's per-task manifest default
    // (for Claude Code, `sonnet` — cross-interview synthesis, reasoning-heavy).
    let value = crate::adapter::run_cli_task_model(adapter, "cycle-synthesis-reduce", &input, Some(&schema), model_override)
        .await
        .map_err(|e| {
            // The reduce is the synthesis's spine — without it there are no findings. A failure
            // here sinks the whole run, so it's an ERROR (the extract failures above are warns).
            log::error!(
                target: "interviewlab::synthesis",
                "[E-SYN-REDUCE] reduce: cross-interview synthesis CLI call FAILED over {} interview extraction(s), {} goal(s): {e}",
                extractions.len(), goals.len()
            );
            e.to_string()
        })?;

    let output: ReduceOutput = serde_json::from_value(value.clone()).map_err(|e| {
        log::error!(
            target: "interviewlab::synthesis",
            "[E-SYN-REDUCE] reduce: output shape invalid (no findings can be assembled): {e}. Got: {}",
            crate::logging::truncate(&value.to_string(), 2000)
        );
        format!("reduce output shape invalid: {e}; got {value}")
    })?;

    let findings = assemble_findings(goals, valid_segments, &output);
    let by_role = assemble_by_role(goals, &output);
    let hypothesis_verdicts = assemble_hypothesis_verdicts(hypotheses, valid_segments, &output);
    let question_answers = assemble_question_answers(questions, valid_segments, &output);
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
        hypotheses: hypotheses.to_vec(),
        questions: questions.to_vec(),
        hypothesis_verdicts,
        question_answers,
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
    template: &GuideTemplate,
    adapter: &crate::adapter::Adapter,
    interviews: &[InterviewInput],
    // The user's synthesis-bucket model override (None → the plugin's manifest default).
    model_override: Option<&str>,
) -> Result<CycleSynthesisResult, String> {
    // Goals are the templated guide's TASKS when present (ids already G1..), else derived from
    // the markdown (legacy / free-markdown guide). Hypotheses + questions come from the template
    // (empty for a legacy guide → the new sections simply don't appear).
    let goals = if !template.is_empty() { template.goals() } else { derive_goals(guide) };
    let hypotheses = template.hypotheses.clone();
    let questions = template.questions();
    if goals.is_empty() {
        log::warn!(target: "interviewlab::synthesis", "[E-SYN-NO-GOALS] synthesize: cycle='{cycle_id}': no goals derivable from the guide ({} chars) — aborting", guide.len());
        return Err("no goals could be derived from the guide — add a Goals/tasks section first".into());
    }
    if interviews.is_empty() {
        log::warn!(target: "interviewlab::synthesis", "[E-SYN-NO-INTERVIEWS] synthesize: cycle='{cycle_id}': no transcribed interviews to synthesize — aborting");
        return Err("no transcribed interviews in this cycle to synthesize".into());
    }
    log::info!(
        target: "interviewlab::synthesis",
        "synthesize: cycle='{cycle_id}': MAP {} interview(s) × {} goal(s) then REDUCE (adapter='{}', model={})",
        interviews.len(), goals.len(), adapter.id, model_override.unwrap_or("<plugin-default>")
    );

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
            let hypotheses = &hypotheses;
            let questions = &questions;
            async move {
                let (output, extraction) = extract_one(adapter, product_desc, goals, hypotheses, questions, iv, model_override).await;
                let summary = assemble_interview_summary(goals, hypotheses, questions, iv.segments.len(), &output);
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
    let doc = reduce(adapter, product_desc, guide, &goals, &hypotheses, &questions, &extractions, &valid_segments, model_override).await?;

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
    log::info!(target: "interviewlab::synthesis", "run_interview_summary: starting interview='{interview_id}' (adapter override: {adapter_id:?})");
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
    let template = effective_guide_template_db(&db.pool, &cycle_id).await?;
    let goals = if !template.is_empty() { template.goals() } else { derive_goals(&guide) };
    let hypotheses = template.hypotheses.clone();
    let questions = template.questions();
    if goals.is_empty() {
        let msg = "no goals derived from the cycle's guide — add a Goals/tasks section first".to_string();
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
    // The user's synthesis-bucket model override (None → the plugin's manifest default).
    let model_override =
        crate::adapter::task_model_override(&db.pool, "cycle-synthesis-extract").await;
    let (output, _extraction) = extract_one(&adapter, &product_desc, &goals, &hypotheses, &questions, &iv, model_override.as_deref()).await;
    let doc = assemble_interview_summary(&goals, &hypotheses, &questions, iv.segments.len(), &output);
    let content_md = render_interview_markdown(&doc, &title);
    let model_meta = json!({ "adapter": adapter.id, "goals": doc.goals.len() }).to_string();
    let row_id = store_interview_summary_db(&db.pool, &cycle_id, &interview_id, &doc, &content_md, &model_meta).await.map_err(|e| {
        log::error!(target: "interviewlab::synthesis", "[E-SYN-STORE] run_interview_summary: interview='{interview_id}': storing the summary failed: {e}");
        e
    })?;
    emit_summary_progress(&app, &interview_id, "done", 100, None);
    log::info!(target: "interviewlab::synthesis", "run_interview_summary: interview='{interview_id}': DONE (row id={row_id})");

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
    let template = effective_guide_template_db(&db.pool, &cycle_id).await?;

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

    // The user's synthesis-bucket model override (None → the plugin's manifest default).
    let model_override = crate::adapter::task_model_override(&db.pool, "cycle-synthesis").await;
    log::info!(target: "interviewlab::synthesis", "run_synthesis: cycle='{cycle_id}' ('{name}'): {} interview(s), adapter='{}'", interviews.len(), adapter.id);
    match synthesize_cycle(Some(&app), &cycle_id, &product_desc, &guide, &template, &adapter, &interviews, model_override.as_deref()).await {
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
            let row_id = store_cycle_synthesis_db(&db.pool, &cycle_id, &result.doc, &content_md, &model_meta).await.map_err(|e| {
                log::error!(target: "interviewlab::synthesis", "[E-SYN-STORE] run_synthesis: cycle='{cycle_id}': synthesis succeeded but STORING it failed: {e}");
                e
            })?;
            emit_progress(&app, &cycle_id, "done", interviews.len(), interviews.len(), 100, None);
            log::info!(
                target: "interviewlab::synthesis",
                "run_synthesis: cycle='{cycle_id}': DONE — {} finding(s) across {} goal(s) (row id={row_id})",
                result.doc.findings.len(), result.doc.goals.len()
            );
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
            log::error!(target: "interviewlab::synthesis", "run_synthesis: cycle='{cycle_id}': FAILED: {e}");
            emit_progress(&app, &cycle_id, "error", 0, interviews.len(), 0, Some(e.clone()));
            Err(e)
        }
    }
}

// --- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- templated guide (parse / normalize / render / questions) -------------

    fn sample_template() -> GuideTemplate {
        GuideTemplate {
            hypotheses: vec![
                TemplateItem { id: String::new(), text: "  Users churn after trial because setup is too long.  ".into() },
                TemplateItem { id: "stale".into(), text: "Pricing is the main objection.".into() },
                TemplateItem { id: String::new(), text: "   ".into() }, // blank → dropped
            ],
            tasks: vec![
                TemplateItem { id: String::new(), text: "Understand the activation blocker.".into() },
                TemplateItem { id: String::new(), text: "Map the first-week journey.".into() },
            ],
            qualifying_questions: vec![
                TemplateItem { id: String::new(), text: "What's your role?".into() },
            ],
            main_blocks: vec![
                QuestionBlock {
                    title: "  Onboarding  ".into(),
                    questions: vec![
                        TemplateItem { id: String::new(), text: "Walk me through your first day.".into() },
                        TemplateItem { id: String::new(), text: "Where did you get stuck?".into() },
                    ],
                },
                QuestionBlock { title: "   ".into(), questions: vec![] }, // empty block → dropped
            ],
            hypothesis_questions: vec![
                TemplateItem { id: String::new(), text: "Would you have paid at signup?".into() },
            ],
        }
    }

    #[test]
    fn template_normalized_stamps_stable_ids_and_drops_blanks() {
        let t = sample_template().normalized();
        // Hypotheses: H1, H2 (the blank one dropped; the stale id is re-stamped positionally).
        assert_eq!(t.hypotheses.len(), 2);
        assert_eq!(t.hypotheses[0].id, "H1");
        assert_eq!(t.hypotheses[1].id, "H2");
        assert_eq!(t.hypotheses[0].text, "Users churn after trial because setup is too long.", "text trimmed");
        // Tasks → goal ids G1, G2.
        assert_eq!(t.tasks.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["G1", "G2"]);
        // The empty main block is dropped; the titled one is trimmed.
        assert_eq!(t.main_blocks.len(), 1);
        assert_eq!(t.main_blocks[0].title, "Onboarding");
        // Questions share ONE global Q counter across qualifying → main → hypothesis questions.
        let q_ids: Vec<String> = t.questions().into_iter().map(|q| q.id).collect();
        assert_eq!(q_ids, vec!["Q1", "Q2", "Q3", "Q4"], "global Q numbering in document order");
        // Section context is carried.
        let qs = t.questions();
        assert_eq!(qs[0].section, "qualifying");
        assert_eq!(qs[1].section, "main");
        assert_eq!(qs[1].block, "Onboarding");
        assert_eq!(qs[3].section, "hypothesis");
    }

    #[test]
    fn template_goals_match_derive_goals_of_rendered_md() {
        // The canonical render puts tasks under "## Goals" with explicit Gn tags, so
        // derive_goals(content_md) yields the SAME ids as template.goals() — the diff spine
        // stays consistent whether read from the template or the markdown.
        let t = sample_template().normalized();
        let md = render_template_md(&t);
        assert!(md.contains("## Hypotheses"));
        assert!(md.contains("## Goals"));
        assert!(md.contains("## Main questions"));
        assert!(md.contains("### Onboarding"));
        assert_eq!(derive_goals(&md), t.goals(), "rendered markdown re-derives identical goals");
    }

    #[test]
    fn template_parse_empty_and_is_empty() {
        assert!(GuideTemplate::parse("").is_empty());
        assert!(GuideTemplate::parse("{}").is_empty());
        assert!(GuideTemplate::parse("not json").is_empty());
        assert!(!sample_template().is_empty());
        // Round-trips through JSON (the template_json column).
        let t = sample_template().normalized();
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(GuideTemplate::parse(&json), t);
    }

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

    // --- hypothesis verdicts + question answers (templated guide, pure) --------

    fn hyps2() -> Vec<TemplateItem> {
        vec![
            TemplateItem { id: "H1".into(), text: "Setup is the churn driver.".into() },
            TemplateItem { id: "H2".into(), text: "Price is the top objection.".into() },
        ]
    }

    #[test]
    fn assemble_hypothesis_verdicts_fills_every_hypothesis_and_validates() {
        // The model returns a verdict for H1 (with a bogus + one good evidence ref) and an
        // unknown H9; H2 is OMITTED → must still appear as inconclusive (answer the whole guide).
        let output: ReduceOutput = serde_json::from_value(json!({
            "hypothesis_verdicts": [
                { "hypothesis_id": "H1", "verdict": "confirmed", "confidence": "high",
                  "rationale": "Five of six stalled at setup.",
                  "evidence": [
                    { "interview_id": "iv1", "segment_id": 2, "quote": "took forever" },
                    { "interview_id": "iv1", "segment_id": 99, "quote": "oob" }
                  ] },
                { "hypothesis_id": "H9", "verdict": "refuted", "confidence": "low", "rationale": "x", "evidence": [] }
            ]
        })).unwrap();
        let v = assemble_hypothesis_verdicts(&hyps2(), &valid_segs(), &output);
        assert_eq!(v.len(), 2, "one verdict per guide hypothesis, in order");
        assert_eq!(v[0].id, "H1");
        assert_eq!(v[0].verdict, "confirmed");
        assert_eq!(v[0].evidence.len(), 1, "out-of-range evidence dropped");
        assert_eq!(v[1].id, "H2");
        assert_eq!(v[1].verdict, "inconclusive", "omitted hypothesis defaults to inconclusive");
        assert_eq!(v[1].confidence, "low");
    }

    #[test]
    fn assemble_question_answers_fills_every_question_and_normalizes_status() {
        let questions = vec![
            GuideQuestion { id: "Q1".into(), text: "Role?".into(), section: "qualifying".into(), block: String::new() },
            GuideQuestion { id: "Q2".into(), text: "First day?".into(), section: "main".into(), block: "Onboarding".into() },
            GuideQuestion { id: "Q3".into(), text: "Pay at signup?".into(), section: "hypothesis".into(), block: String::new() },
        ];
        let output: ReduceOutput = serde_json::from_value(json!({
            "question_answers": [
                { "question_id": "Q1", "status": "answered", "answer": "PMs and designers.", "evidence": [] },
                // Q2 says "answered" but the answer is blank → normalized to not_answered.
                { "question_id": "Q2", "status": "answered", "answer": "   ", "evidence": [] },
                // Q3 answered only indirectly → maps to "partially".
                { "question_id": "Q3", "status": "indirect", "answer": "Most would not.", "evidence": [
                    { "interview_id": "iv2", "segment_id": 0, "quote": "not at signup" }
                ] }
                // (no Q-entry omitted here, but a missing one would default to not_answered)
            ]
        })).unwrap();
        let a = assemble_question_answers(&questions, &valid_segs(), &output);
        assert_eq!(a.len(), 3, "one answer per guide question, in order");
        assert_eq!(a[0].status, "answered");
        assert_eq!(a[1].status, "not_answered", "answered-but-blank → not_answered");
        assert_eq!(a[2].status, "partially", "indirect → partially");
        assert_eq!(a[2].evidence.len(), 1);
        assert_eq!(a[2].section, "hypothesis");
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
            ..Default::default()
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
        let doc = assemble_interview_summary(&goals3(), &[], &[], 5, &output);
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
            ..Default::default()
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
        let extract = build_extract_input(product, &goals, &[], &[], &iv);
        assert_eq!(
            extract["product_desc"], product,
            "extract prompt carries the product context"
        );
        assert_eq!(
            extract["system"], analysis_system_prompt(),
            "extract prompt carries the shared analysis system prompt"
        );
        let reduce = build_reduce_input(product, "Goals:\n- G1", &goals, &[], &[], &[]);
        assert_eq!(
            reduce["product_desc"], product,
            "reduce prompt carries the product context"
        );
        assert_eq!(
            reduce["system"], analysis_system_prompt(),
            "reduce prompt carries the shared analysis system prompt"
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
            ..Default::default()
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
            hypotheses: vec![],
            questions: vec![],
            question_answers: vec![],
            hypothesis_signals: vec![],
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

        let result = synthesize_cycle(None, "m10b-verify", product_desc, guide, &GuideTemplate::default(), &adapter, &[iv1.clone(), iv2.clone()], None)
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

            let template = effective_guide_template_db(&pool, cycle_id).await.unwrap();
            let result = synthesize_cycle(None, cycle_id, &product_desc, &guide, &template, &adapter, &interviews, None)
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
