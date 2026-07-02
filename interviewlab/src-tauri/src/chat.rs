// Cycle chat — M11 Phase A: the grounded, streaming Q&A backend.
//
// This is the streaming, multi-turn extension of adapter.rs (the M6 single-shot runner),
// driven PLUGIN-FIRST: the runner reads the active plugin descriptor's chat/stream
// capability (the new `chat` block on the Claude Code descriptor — feature-cli-plugins.md
// §3.2) and renders its arg template, rather than hardcoding the `claude` command line.
//
// Phase A scope (feature-cycle-chat.md §8 Phase A):
//   1. thread/message CRUD over migration 0004's tables.
//   2. build_context(cycle_id): a compact markdown context pack (synthesis md + findings +
//      per-interview summaries + guide/goals + diff summary + interview index) + a
//      citation-rules preamble, written to a temp file for --append-system-prompt-file.
//   3. cycle_chat_send: spawn the plugin's chat.stream command (claude -p … stream-json
//      --verbose --include-partial-messages --append-system-prompt-file <pack> isolation
//      flags; --resume <session_id> on follow-up turns), line-stream stdout → parse the
//      named stream parser (claude-stream-json) → emit Tauri events (token/done/error);
//      persist user+assistant messages + the session_id for resume; one in-flight turn
//      per thread; cycle_chat_cancel kills the child.
//
// Phase A grounds on the ARTIFACTS (synthesis/summaries/diff/guide) — NO tools fire
// (--tools "" disables built-ins; we pass no --mcp-config, so no MCP).
//
// Phase B (v3, CLI-agnostic tool-use — still no MCP): the assistant may emit AT MOST ONE
// fenced ```invlab-action block per reply. On stream completion the runner extracts the
// block from the FINAL assistant text (never from user-quoted text — only the assistant's
// message is parsed, and a block nested inside another language's code sample is literal
// content, not a fence), strips it from the stored/displayed content, validates it strictly
// against the whitelist (glossary.add_terms / synthesis.update_finding), executes it, logs
// it to chat_tool_call (with an undo_token), and emits a ChatEvent::Action chip. Undo via
// undo_chat_action. Error family: [E-CHAT-ACTION-*].

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, SqlitePool};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use uuid::Uuid;

use crate::Db;

// In-flight child processes keyed by thread_id, so cycle_chat_cancel can kill the turn
// (feature-cycle-chat.md §4.2). One in-flight turn per thread (the UI also disables the
// composer via isRunning). A std Mutex is fine: we only hold it for the brief swap.
static INFLIGHT: Mutex<Option<HashMap<String, Child>>> = Mutex::new(None);

fn with_inflight<R>(f: impl FnOnce(&mut HashMap<String, Child>) -> R) -> R {
    let mut guard = INFLIGHT.lock().expect("inflight mutex");
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- row types (mirror migration 0004) ----------------------------------------

#[derive(Serialize, FromRow, Clone)]
pub struct ChatThread {
    pub id: String,
    pub cycle_id: String,
    pub title: String,
    pub session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, FromRow, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content: String,
    pub citations_json: String,
    pub status: String,
    pub error: Option<String>,
    pub cost_usd: Option<f64>,
    pub created_at: i64,
}

// --- Tauri event payloads -----------------------------------------------------

// Streamed to the frontend on `chat://<thread_id>`. A discriminated union: `kind`
// distinguishes token / done / error so the panel can append tokens, finalize on done
// (with the persisted message id + session id), or surface an error.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatEvent {
    // A text delta to append to the in-flight assistant message.
    Token { thread_id: String, text: String },
    // The turn finished: the persisted assistant message + the session_id (for resume).
    Done {
        thread_id: String,
        message_id: String,
        session_id: Option<String>,
        cost_usd: Option<f64>,
    },
    // The turn failed (spawn/exit/parse). `message` is user-facing.
    Error { thread_id: String, message: String },
    // Phase B: a whitelisted action from the assistant's final message was processed.
    // status: applied | rejected | failed. summary: a short human string (Russian) the UI
    // renders on the chip, e.g. "Добавлено 3 термина в глоссарий".
    Action {
        thread_id: String,
        tool_call_id: String,
        tool: String,
        status: String,
        summary: String,
    },
}

fn chat_event_name(thread_id: &str) -> String {
    format!("chat://{thread_id}")
}

// --- thread / message CRUD ----------------------------------------------------

async fn list_threads_db(pool: &SqlitePool, cycle_id: &str) -> Result<Vec<ChatThread>, String> {
    sqlx::query_as::<_, ChatThread>(
        "SELECT id, cycle_id, title, session_id, created_at, updated_at \
         FROM chat_thread WHERE cycle_id = ? ORDER BY updated_at DESC",
    )
    .bind(cycle_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

async fn create_thread_db(pool: &SqlitePool, cycle_id: &str, title: &str) -> Result<ChatThread, String> {
    let id = Uuid::new_v4().to_string();
    let ts = now_ms();
    sqlx::query(
        "INSERT INTO chat_thread (id, cycle_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(cycle_id)
    .bind(title)
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    get_thread_db(pool, &id).await
}

async fn get_thread_db(pool: &SqlitePool, id: &str) -> Result<ChatThread, String> {
    sqlx::query_as::<_, ChatThread>(
        "SELECT id, cycle_id, title, session_id, created_at, updated_at FROM chat_thread WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())
}

async fn rename_thread_db(pool: &SqlitePool, id: &str, title: &str) -> Result<ChatThread, String> {
    sqlx::query("UPDATE chat_thread SET title = ?, updated_at = ? WHERE id = ?")
        .bind(title)
        .bind(now_ms())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    get_thread_db(pool, id).await
}

async fn delete_thread_db(pool: &SqlitePool, id: &str) -> Result<(), String> {
    // chat_message / chat_tool_call cascade via the migration's ON DELETE CASCADE.
    sqlx::query("DELETE FROM chat_thread WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn list_messages_db(pool: &SqlitePool, thread_id: &str) -> Result<Vec<ChatMessage>, String> {
    sqlx::query_as::<_, ChatMessage>(
        "SELECT id, thread_id, role, content, citations_json, status, error, cost_usd, created_at \
         FROM chat_message WHERE thread_id = ? ORDER BY created_at, rowid",
    )
    .bind(thread_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

// Append a message. citations are stored as JSON in citations_json (parsed at finalize
// from the assistant's inline [[…]] tokens).
async fn append_message_db(
    pool: &SqlitePool,
    thread_id: &str,
    role: &str,
    content: &str,
    citations_json: &str,
    status: &str,
    error: Option<&str>,
    cost_usd: Option<f64>,
) -> Result<ChatMessage, String> {
    let id = Uuid::new_v4().to_string();
    let ts = now_ms();
    sqlx::query(
        "INSERT INTO chat_message (id, thread_id, role, content, citations_json, status, error, cost_usd, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(thread_id)
    .bind(role)
    .bind(content)
    .bind(citations_json)
    .bind(status)
    .bind(error)
    .bind(cost_usd)
    .bind(ts)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    // Bump the thread's updated_at so the switcher sorts newest-active first.
    let _ = sqlx::query("UPDATE chat_thread SET updated_at = ? WHERE id = ?")
        .bind(ts)
        .bind(thread_id)
        .execute(pool)
        .await;
    sqlx::query_as::<_, ChatMessage>(
        "SELECT id, thread_id, role, content, citations_json, status, error, cost_usd, created_at \
         FROM chat_message WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())
}

// --- context pack (feature-cycle-chat.md §5.1) --------------------------------

// Citation rules preamble: tells the model to answer ONLY from the provided cycle data and
// to cite with the strict tokens the UI parses (§5.4). Kept terse — it's prepended to the
// pack and re-stated every turn.
const CITATION_PREAMBLE: &str = r#"You are InterviewLab's cycle assistant. Answer questions about THIS user-research cycle, grounded ONLY in the cycle data provided below. Answer in the language the user writes in (default: Russian) — natural, professional prose, no translationese, no канцелярит. Be direct and concrete: lead with the answer, no throat-clearing, no restating the question, no filler. If the data doesn't cover something, say so plainly — never invent findings, quotes, or numbers. Interview quotes stay verbatim in their original language; use the glossary's canonical spellings for terms in your own prose.

Cite every claim inline using these exact tokens (the app turns them into clickable chips):
- [[finding:F1]] — when a claim comes from a synthesis finding (use its id, e.g. F1, F2).
- [[hypothesis:H1]] — when answering about a guide hypothesis (use its id, e.g. H1, H2).
- [[question:Q1]] — when answering about a guide question (use its id, e.g. Q1, Q2).
- [[interview:<interview_id>]] — when referring to a whole interview.
- [[iv:<interview_id> seg:<n>]] — when quoting/paraphrasing a transcript segment.
Put the token right after the sentence it supports. Prefer finding/hypothesis/question citations; they are the most reliable. Do not output the tokens in a code block.

"#;

// Action rules — Phase B tool-use. Tells the model HOW to request one of the two whitelisted
// mutations via a fenced `invlab-action` block. The backend parses the block ONLY from the
// assistant's final message (never from user text), strips it before display/storage,
// validates strictly against the whitelist, and makes every applied action undoable.
const ACTION_RULES: &str = r#"## Actions
You MAY change this cycle's data when the user EXPLICITLY asks for it, by emitting AT MOST ONE fenced code block with the exact language tag `invlab-action`, containing exactly ONE JSON object. Put it at the very end of your reply, after your normal prose answer. The app executes it, strips it from the displayed message, and shows an undoable confirmation chip — do not narrate the block or wrap it in another code block, and never emit it merely to illustrate the format.

Whitelisted actions (anything else is rejected):

1. Add terms to the product glossary:
```invlab-action
{"action":"glossary.add_terms","terms":[{"canonical":"API","aliases":["апи","эй-пи-ай"]}]}
```

2. Update ONE synthesis finding's statement and/or confidence (goal_id + finding_id MUST be real ids from the cycle data below; confidence is low|medium|high):
```invlab-action
{"action":"synthesis.update_finding","goal_id":"G1","finding_id":"F2","statement":"...","confidence":"medium"}
```

"#;

// ЕДИНЫЕ ПРАВИЛА LLM-СТАДИЙ — kept verbatim so it can later be hoisted into one Rust const
// shared by every LLM stage (roadmap §4 "общий мини-блок правил одной константой").
const LLM_STAGE_RULES: &str = r#"## Shared LLM-stage rules
- Язык вывода = язык интервью (для русских интервью — русский); термины, которые говорил респондент, НЕ переводить.
- Собственный текст (выводы, ответы, заметки — но не цитаты) — естественный профессиональный русский: без кальки и канцелярита («имеет место непонимание» → «пользователи не понимают»), выводы как утверждения, а не пересказ («было выявлено, что…» — нельзя).
- Анти-галлюцинации: не выдумывать имена/числа/цитаты; «не установлено / нет ответа» лучше, чем додумывание.
- Терминология: использовать каноничные написания из глоссария в прозе и в цитатах; латиница, кириллическая транслитерация и склонённые формы — один и тот же термин (фича = feature, «в Слаке» = Slack).
- Стиль артефактов: нейтральный аналитический тон, без воды, единый формат цитат и чисел, без markdown-заголовков внутри строковых полей JSON.

--- CYCLE DATA ---
"#;

// Assemble the markdown context pack for a cycle. Pulls the cycle-level synthesis markdown
// + structured findings (with ids + evidence), per-interview summaries, the guide/goals,
// the diff summary, and an interview index — exactly the distilled artifacts (§5.1), NOT
// raw transcripts (those are a Phase-B read tool). Returns markdown text (no temp file
// yet; the caller writes it).
pub(crate) async fn build_context(pool: &SqlitePool, cycle_id: &str) -> Result<String, String> {
    let mut out = String::with_capacity(8 * 1024);
    out.push_str(CITATION_PREAMBLE);
    out.push_str(ACTION_RULES);
    out.push_str(LLM_STAGE_RULES);

    // Cycle name + product description.
    let cycle: Option<(String, String)> =
        sqlx::query_as("SELECT name, product_desc FROM cycle WHERE id = ?")
            .bind(cycle_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let (cycle_name, product_desc) = cycle.ok_or_else(|| "cycle not found".to_string())?;
    out.push_str(&format!("\n# Cycle: {cycle_name}\n"));
    // Shared analysis principles — the SAME rules the synthesis/diff stages obey, so the chat
    // reasons about the guide (hypotheses, every question, indirect answers) consistently.
    out.push_str(&format!("\n## Analysis principles\n{}\n", crate::synthesis::analysis_system_prompt()));
    if !product_desc.trim().is_empty() {
        out.push_str(&format!("\n## Product\n{}\n", product_desc.trim()));
    }

    // Glossary (canonical spellings) — the SAME render_for_prompt the ASR/cleanup/synthesis
    // stages use, so the chat answers with the cycle's canonical terms in prose AND in quotes.
    let glossary = crate::glossary::glossary_for_cycle_db(pool, cycle_id).await?;
    let gloss_json = crate::glossary::render_for_prompt(&glossary);
    if gloss_json.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        out.push_str(&format!(
            "\n## Glossary (canonical spellings — use these exact forms)\n{}\n",
            serde_json::to_string(&gloss_json).unwrap_or_else(|_| "[]".into())
        ));
    }

    // Guide + derived goals (reuse synthesis.rs as the single source of truth for both).
    if let Some(guide) = crate::synthesis::effective_guide_db(pool, cycle_id).await? {
        if !guide.trim().is_empty() {
            out.push_str(&format!("\n## Interview guide\n{}\n", guide.trim()));
        }
        let goals = crate::synthesis::derive_goals(&guide);
        if !goals.is_empty() {
            out.push_str("\n## Goals\n");
            for g in &goals {
                out.push_str(&format!("- {}: {}\n", g.id, g.text));
            }
        }
    }

    // Cycle synthesis: the markdown report (content_md) + the structured findings with ids,
    // goal_id, confidence, and evidence refs (so the model has stable finding ids to cite).
    let synth: Option<(String, String)> = sqlx::query_as(
        "SELECT content_md, findings_json FROM synthesis \
         WHERE cycle_id = ? AND interview_id IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(cycle_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some((content_md, findings_json)) = synth {
        if !content_md.trim().is_empty() {
            out.push_str(&format!("\n## Synthesis report\n{}\n", content_md.trim()));
        }
        out.push_str(&render_findings(&findings_json));
        out.push_str(&render_hypotheses(&findings_json));
        out.push_str(&render_question_answers(&findings_json));
    } else {
        out.push_str("\n## Synthesis\n_No synthesis has been run for this cycle yet._\n");
    }

    // Interview index + per-interview summaries (the MAP layer; lets the model answer
    // "which interviews mention X?" without raw transcripts).
    let interviews: Vec<(String, String)> =
        sqlx::query_as("SELECT id, title FROM interview WHERE cycle_id = ? ORDER BY created_at ASC")
            .bind(cycle_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    if !interviews.is_empty() {
        out.push_str("\n## Interviews\n");
        for (iid, title) in &interviews {
            out.push_str(&format!("- interview_id={iid} — {title}\n"));
        }
        for (iid, title) in &interviews {
            let summary: Option<String> = sqlx::query_scalar(
                "SELECT content_md FROM synthesis WHERE interview_id = ? ORDER BY created_at DESC LIMIT 1",
            )
            .bind(iid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            if let Some(md) = summary {
                if !md.trim().is_empty() {
                    out.push_str(&format!(
                        "\n### Summary — {title} (interview_id={iid})\n{}\n",
                        md.trim()
                    ));
                }
            }
        }
    }

    // Diff vs the previous wave (powers "what changed?").
    let diff_json: Option<String> = sqlx::query_scalar(
        "SELECT diff_json FROM diff WHERE cycle_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(cycle_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(dj) = diff_json {
        out.push_str(&render_diff(&dj));
    }

    Ok(out)
}

// Render the structured findings_json into compact markdown the model can cite from. Tolerant:
// missing/odd fields are skipped rather than failing the whole pack.
fn render_findings(findings_json: &str) -> String {
    let Ok(doc): Result<Value, _> = serde_json::from_str(findings_json) else {
        return String::new();
    };
    let findings = doc.get("findings").and_then(Value::as_array);
    let Some(findings) = findings else {
        return String::new();
    };
    if findings.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n## Findings (cite by id)\n");
    for f in findings {
        let id = f.get("id").and_then(Value::as_str).unwrap_or("?");
        let goal = f.get("goal_id").and_then(Value::as_str).unwrap_or("");
        let stmt = f.get("statement").and_then(Value::as_str).unwrap_or("");
        let conf = f.get("confidence").and_then(Value::as_str).unwrap_or("");
        s.push_str(&format!("\n- **{id}** ({goal}, {conf} confidence): {stmt}\n"));
        if let Some(rec) = f.get("recommendation").and_then(Value::as_str) {
            if !rec.trim().is_empty() {
                s.push_str(&format!("  - recommendation: {rec}\n"));
            }
        }
        if let Some(ev) = f.get("evidence").and_then(Value::as_array) {
            for e in ev.iter().take(3) {
                let iv = e.get("interview_id").and_then(Value::as_str).unwrap_or("");
                let seg = e.get("segment_id").and_then(Value::as_u64).unwrap_or(0);
                let quote = e.get("quote").and_then(Value::as_str).unwrap_or("");
                s.push_str(&format!("  - evidence [[iv:{iv} seg:{seg}]]: \"{quote}\"\n"));
            }
        }
    }
    s
}

// Render the cross-interview hypothesis verdicts from findings_json into compact, citable
// markdown (stable ids H1, H2… match the guide template) so the chat can answer "what about
// hypothesis X?" and cite [[hypothesis:H1]]. Tolerant: missing fields are skipped.
fn render_hypotheses(findings_json: &str) -> String {
    let Ok(doc): Result<Value, _> = serde_json::from_str(findings_json) else {
        return String::new();
    };
    let Some(items) = doc.get("hypothesis_verdicts").and_then(Value::as_array) else {
        return String::new();
    };
    if items.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n## Hypotheses (cite [[hypothesis:H1]])\n");
    for h in items {
        let id = h.get("id").and_then(Value::as_str).unwrap_or("?");
        let verdict = h.get("verdict").and_then(Value::as_str).unwrap_or("");
        let conf = h.get("confidence").and_then(Value::as_str).unwrap_or("");
        let text = h.get("text").and_then(Value::as_str).unwrap_or("");
        s.push_str(&format!("\n- **{id}** ({verdict}, {conf} confidence): {text}\n"));
        if let Some(r) = h.get("rationale").and_then(Value::as_str) {
            if !r.trim().is_empty() {
                s.push_str(&format!("  - rationale: {}\n", r.trim()));
            }
        }
    }
    s
}

// Render the consolidated per-question answers from findings_json (stable ids Q1, Q2… match the
// guide template) so the chat can answer "did we answer question Y?" and cite [[question:Q1]].
fn render_question_answers(findings_json: &str) -> String {
    let Ok(doc): Result<Value, _> = serde_json::from_str(findings_json) else {
        return String::new();
    };
    let Some(items) = doc.get("question_answers").and_then(Value::as_array) else {
        return String::new();
    };
    if items.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n## Question answers (cite [[question:Q1]])\n");
    for q in items {
        let id = q.get("id").and_then(Value::as_str).unwrap_or("?");
        let status = q.get("status").and_then(Value::as_str).unwrap_or("");
        let text = q.get("text").and_then(Value::as_str).unwrap_or("");
        s.push_str(&format!("\n- **{id}** ({status}): {text}\n"));
        if let Some(a) = q.get("answer").and_then(Value::as_str) {
            if !a.trim().is_empty() {
                s.push_str(&format!("  - answer: {}\n", a.trim()));
            }
        }
    }
    s
}

// Render the diff doc's summary + per-goal change list into compact markdown.
fn render_diff(diff_json: &str) -> String {
    let Ok(doc): Result<Value, _> = serde_json::from_str(diff_json) else {
        return String::new();
    };
    let mut s = String::from("\n## Change vs previous wave\n");
    if let Some(summary) = doc.get("summary").and_then(Value::as_str) {
        if !summary.trim().is_empty() {
            s.push_str(&format!("{}\n", summary.trim()));
        }
    }
    if let Some(by_goal) = doc.get("by_goal").and_then(Value::as_array) {
        for g in by_goal {
            let goal = g.get("goal_id").and_then(Value::as_str).unwrap_or("");
            if let Some(entries) = g.get("entries").and_then(Value::as_array) {
                for e in entries {
                    let status = e.get("status").and_then(Value::as_str).unwrap_or("");
                    let stmt = e.get("statement").and_then(Value::as_str).unwrap_or("");
                    s.push_str(&format!("- [{goal}] {status}: {stmt}\n"));
                }
            }
        }
    }
    s
}

// --- citation parsing (§5.4) --------------------------------------------------

// Parse the assistant's inline [[…]] tokens into a citations_json list (stored alongside the
// inline tokens for lossless re-render). Recognizes the three token shapes; tolerant of
// whitespace. Unrecognized tokens are ignored (left inline as plain text by the UI).
fn parse_citations(content: &str) -> String {
    #[derive(Serialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum Citation {
        Finding { finding_id: String },
        Hypothesis { hypothesis_id: String },
        Question { question_id: String },
        Interview { interview_id: String },
        Segment { interview_id: String, segment_id: u64 },
    }

    let mut cites: Vec<Citation> = Vec::new();
    let bytes = content.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(end) = content[i + 2..].find("]]") {
                let inner = content[i + 2..i + 2 + end].trim();
                if let Some(rest) = inner.strip_prefix("finding:") {
                    cites.push(Citation::Finding { finding_id: rest.trim().to_string() });
                } else if let Some(rest) = inner.strip_prefix("hypothesis:") {
                    cites.push(Citation::Hypothesis { hypothesis_id: rest.trim().to_string() });
                } else if let Some(rest) = inner.strip_prefix("question:") {
                    cites.push(Citation::Question { question_id: rest.trim().to_string() });
                } else if let Some(rest) = inner.strip_prefix("interview:") {
                    cites.push(Citation::Interview { interview_id: rest.trim().to_string() });
                } else if let Some(rest) = inner.strip_prefix("iv:") {
                    // "iv:<id> seg:<n>"
                    let parts: Vec<&str> = rest.split_whitespace().collect();
                    if parts.len() == 2 {
                        if let Some(seg) = parts[1].strip_prefix("seg:") {
                            if let Ok(n) = seg.trim().parse::<u64>() {
                                cites.push(Citation::Segment {
                                    interview_id: parts[0].trim().to_string(),
                                    segment_id: n,
                                });
                            }
                        }
                    }
                }
                i = i + 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
    serde_json::to_string(&cites).unwrap_or_else(|_| "[]".to_string())
}

// --- action blocks — Phase B tool-use (CLI-agnostic, no MCP) --------------------
//
// Whitelist + lifecycle:
//   extract_action_blocks (assistant final text only) → validate_action (serde tagged enum,
//   unknown/malformed → rejected, never executed) → exec_* (DB mutation, undo_token captured)
//   → chat_tool_call row (status: applied | rejected | failed | undone) → ChatEvent::Action.
//
// Conservative by construction: only a TOP-LEVEL fenced ```invlab-action block in the
// assistant's message is a candidate. A block nested inside another fence (e.g. a ```markdown
// sample quoting the format) is literal content per CommonMark — a closing fence carries no
// info string — so an action can never fire from quoted/example text.

const ACTION_STATUS_APPLIED: &str = "applied";
const ACTION_STATUS_REJECTED: &str = "rejected";
const ACTION_STATUS_FAILED: &str = "failed";
const ACTION_STATUS_UNDONE: &str = "undone";

// The strict whitelist. serde's internally-tagged enum rejects any unknown `action` value and
// any payload that doesn't deserialize into the variant's shape.
#[derive(Deserialize, Debug)]
#[serde(tag = "action")]
enum ChatAction {
    #[serde(rename = "glossary.add_terms")]
    GlossaryAddTerms { terms: Vec<crate::glossary::NewTerm> },
    #[serde(rename = "synthesis.update_finding")]
    SynthesisUpdateFinding {
        goal_id: String,
        finding_id: String,
        #[serde(default)]
        statement: Option<String>,
        #[serde(default)]
        confidence: Option<String>,
    },
}

// A chat_tool_call row (mirrors migration 0004; UNUSED until Phase B — now used).
#[derive(Serialize, FromRow, Clone, Debug)]
pub struct ChatToolCall {
    pub id: String,
    pub message_id: String,
    pub thread_id: String,
    pub tool: String,
    pub kind: String,
    pub args_json: String,
    pub result_json: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub undo_token: Option<String>,
    pub undone_at: Option<i64>,
    pub created_at: i64,
}

// Parse a potential fence line: ≥3 of the same fence char (` or ~) after optional leading
// whitespace. Returns (fence_char, run_length, trimmed_info_string).
fn parse_fence_line(line: &str) -> Option<(char, usize, &str)> {
    let t = line.trim_start();
    let first = t.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let run = t.chars().take_while(|&c| c == first).count();
    if run < 3 {
        return None;
    }
    // fence chars are ASCII → byte index == char index here.
    Some((first, run, t[run..].trim()))
}

// Extract top-level ```invlab-action blocks from the ASSISTANT's final text. Returns the
// text with the block(s) removed + the raw JSON payloads (validation happens later — a
// malformed payload is still extracted so it can be RECORDED as rejected).
//
// CommonMark-faithful where it matters for safety:
//   * a closing fence is backticks/tildes ONLY (no info string), so a "```invlab-action"
//     line INSIDE another open fence is literal content → never extracted;
//   * an unterminated invlab-action fence at EOF is NOT a block — it is restored verbatim.
fn extract_action_blocks(content: &str) -> (String, Vec<String>) {
    #[derive(Clone, Copy)]
    enum St {
        Top,
        InOther(char, usize),
        InAction(usize),
    }

    let mut kept: Vec<&str> = Vec::new();
    let mut blocks: Vec<String> = Vec::new();
    // The opener + body of the action block being scanned, kept so an unterminated block
    // can be restored verbatim instead of silently disappearing.
    let mut pending: Vec<&str> = Vec::new();
    let mut st = St::Top;

    for line in content.lines() {
        match st {
            St::Top => match parse_fence_line(line) {
                Some(('`', len, "invlab-action")) => {
                    pending.clear();
                    pending.push(line);
                    st = St::InAction(len);
                }
                Some((ch, len, _)) => {
                    kept.push(line);
                    st = St::InOther(ch, len);
                }
                None => kept.push(line),
            },
            St::InOther(ch, len) => {
                kept.push(line);
                if let Some((c2, l2, info)) = parse_fence_line(line) {
                    if c2 == ch && l2 >= len && info.is_empty() {
                        st = St::Top;
                    }
                }
            }
            St::InAction(len) => {
                if let Some(('`', l2, info)) = parse_fence_line(line) {
                    if l2 >= len && info.is_empty() {
                        blocks.push(pending[1..].join("\n").trim().to_string());
                        pending.clear();
                        st = St::Top;
                        continue;
                    }
                }
                pending.push(line);
            }
        }
    }
    // Unterminated action fence: restore it verbatim (never execute a half block).
    kept.extend(pending.iter());

    (kept.join("\n").trim_end().to_string(), blocks)
}

// Best-effort action name for LOGGING a rejected block (the payload may be malformed).
fn action_name(raw: &str) -> String {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("action").and_then(Value::as_str).map(String::from))
        .unwrap_or_else(|| "unknown".to_string())
}

// Strict validation: serde whitelist + the semantic constraints serde can't express.
// Err(reason) → the block is recorded as REJECTED and never executed.
fn validate_action(raw: &str) -> Result<ChatAction, String> {
    let action: ChatAction =
        serde_json::from_str(raw).map_err(|e| format!("unknown or malformed action: {e}"))?;
    match &action {
        ChatAction::GlossaryAddTerms { terms } => {
            if terms.iter().all(|t| t.canonical.trim().is_empty()) {
                return Err("glossary.add_terms: no non-empty terms".into());
            }
        }
        ChatAction::SynthesisUpdateFinding { statement, confidence, .. } => {
            if statement.is_none() && confidence.is_none() {
                return Err(
                    "synthesis.update_finding: nothing to update (need statement and/or confidence)"
                        .into(),
                );
            }
            if let Some(c) = confidence {
                if !matches!(c.as_str(), "low" | "medium" | "high") {
                    return Err(format!(
                        "synthesis.update_finding: confidence must be low|medium|high, got '{c}'"
                    ));
                }
            }
        }
    }
    Ok(action)
}

// Russian plural picker (1 / 2–4 / 5+ with the 11–14 exception) for the chip summaries.
// glossary.rs keeps the same rule in its private ru_terms_plural; only this tiny pure helper
// is duplicated here — the actual DB semantics are shared via glossary::add_terms_db.
fn ru_plural<'a>(n: usize, one: &'a str, few: &'a str, many: &'a str) -> &'a str {
    match (n % 100, n % 10) {
        (11..=14, _) => many,
        (_, 1) => one,
        (_, 2..=4) => few,
        _ => many,
    }
}

// "Добавлен 1 термин в глоссарий" / "Добавлено 2 термина в глоссарий" / …
fn ru_terms_added(n: usize) -> String {
    format!(
        "{} {n} {} в глоссарий",
        ru_plural(n, "Добавлен", "Добавлено", "Добавлено"),
        ru_plural(n, "термин", "термина", "терминов")
    )
}

// Chip summary reflecting the MERGE reality of glossary.add_terms: freshly added rows,
// existing terms that gained aliases (merged), or both.
//   (2, 0) → "Добавлено 2 термина в глоссарий"
//   (0, 1) → "Дополнён 1 термин в глоссарии"
//   (2, 1) → "Добавлено 2 термина в глоссарий, дополнён 1 термин"
fn ru_glossary_summary(added: usize, merged: usize) -> String {
    let terms = |n: usize| ru_plural(n, "термин", "термина", "терминов");
    match (added, merged) {
        (_, 0) => ru_terms_added(added),
        (0, m) => format!(
            "{} {m} {} в глоссарии",
            ru_plural(m, "Дополнён", "Дополнено", "Дополнено"),
            terms(m)
        ),
        (_, m) => format!(
            "{}, {} {m} {}",
            ru_terms_added(added),
            ru_plural(m, "дополнён", "дополнено", "дополнено"),
            terms(m)
        ),
    }
}

// The outcome of executing (or refusing) one action, before it's persisted.
struct ActionOutcome {
    status: &'static str,
    // Short human string (Russian) for the UI chip; also stored in result_json.summary.
    summary: String,
    // Extra structured result payload (merged with summary into result_json).
    result: Value,
    error: Option<String>,
    undo_token: Option<String>,
}

impl ActionOutcome {
    fn rejected(detail: String, summary: &str) -> Self {
        ActionOutcome {
            status: ACTION_STATUS_REJECTED,
            summary: summary.to_string(),
            result: json!({}),
            error: Some(detail),
            undo_token: None,
        }
    }
    fn failed(detail: String, summary: &str) -> Self {
        ActionOutcome {
            status: ACTION_STATUS_FAILED,
            summary: summary.to_string(),
            result: json!({}),
            error: Some(detail),
            undo_token: None,
        }
    }
    fn applied(summary: String, result: Value, undo_token: Value) -> Self {
        ActionOutcome {
            status: ACTION_STATUS_APPLIED,
            summary,
            result,
            error: None,
            undo_token: Some(undo_token.to_string()),
        }
    }
}

const TOOL_CALL_COLS: &str = "id, message_id, thread_id, tool, kind, args_json, result_json, \
                              status, error, undo_token, undone_at, created_at";

async fn get_tool_call_db(pool: &SqlitePool, id: &str) -> Result<Option<ChatToolCall>, String> {
    sqlx::query_as::<_, ChatToolCall>(&format!(
        "SELECT {TOOL_CALL_COLS} FROM chat_tool_call WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())
}

async fn list_tool_calls_db(pool: &SqlitePool, thread_id: &str) -> Result<Vec<ChatToolCall>, String> {
    sqlx::query_as::<_, ChatToolCall>(&format!(
        "SELECT {TOOL_CALL_COLS} FROM chat_tool_call WHERE thread_id = ? ORDER BY created_at, rowid"
    ))
    .bind(thread_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}

// Persist one processed action to chat_tool_call. kind is always 'write' — both whitelisted
// actions mutate the DB (reads are Phase C).
async fn insert_tool_call_db(
    pool: &SqlitePool,
    message_id: &str,
    thread_id: &str,
    tool: &str,
    args_json: &str,
    outcome: &ActionOutcome,
) -> Result<ChatToolCall, String> {
    let id = Uuid::new_v4().to_string();
    let mut result = outcome.result.clone();
    result["summary"] = json!(outcome.summary);
    sqlx::query(&format!(
        "INSERT INTO chat_tool_call ({TOOL_CALL_COLS}) \
         VALUES (?, ?, ?, ?, 'write', ?, ?, ?, ?, ?, NULL, ?)"
    ))
    .bind(&id)
    .bind(message_id)
    .bind(thread_id)
    .bind(tool)
    .bind(args_json)
    .bind(result.to_string())
    .bind(outcome.status)
    .bind(outcome.error.as_deref())
    .bind(outcome.undo_token.as_deref())
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    get_tool_call_db(pool, &id)
        .await?
        .ok_or_else(|| "tool call vanished after insert".to_string())
}

// The chip summary for a persisted row (round-trips through result_json.summary so
// list_chat_tool_calls consumers render the same string as the live event).
fn tool_call_summary(row: &ChatToolCall) -> String {
    row.result_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<Value>(j).ok())
        .and_then(|v| v.get("summary").and_then(Value::as_str).map(String::from))
        .unwrap_or_default()
}

// glossary.add_terms — add terms to the CYCLE's product glossary through
// glossary::add_terms_db, the SAME path the seed-import and suggest-accept flows use (single
// source of truth for the dedupe/merge semantics): canonical match is case-insensitive on
// the trimmed canonical, a duplicate NEVER creates a second row — its genuinely-new aliases
// are MERGED into the existing row (existing order preserved), a duplicate contributing
// nothing new is skipped. undo_token captures the FULL pre-action state:
//   { kind, added_ids: [...], merged: [{ id, prev_aliases_json }] }
// so undo can delete the rows the action added AND restore the previous alias list of the
// rows it merged into.
async fn exec_glossary_add_terms(
    pool: &SqlitePool,
    cycle_id: &str,
    terms: &[crate::glossary::NewTerm],
) -> Result<ActionOutcome, String> {
    let product_id: Option<String> = sqlx::query_scalar("SELECT product_id FROM cycle WHERE id = ?")
        .bind(cycle_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(product_id) = product_id.filter(|s| !s.is_empty()) else {
        return Ok(ActionOutcome::failed(
            "cycle has no linked product (the glossary lives on the product)".into(),
            "Действие не выполнено: у цикла нет привязанного продукта",
        ));
    };

    // Snapshot the pre-action alias lists, so undo can restore EXACTLY what a merge changed.
    let pre_aliases: HashMap<String, Vec<String>> =
        crate::glossary::glossary_for_cycle_db(pool, cycle_id)
            .await?
            .into_iter()
            .map(|t| (t.id, t.aliases))
            .collect();

    let out = crate::glossary::add_terms_db(pool, &product_id, terms).await?;
    if out.affected.is_empty() {
        return Ok(ActionOutcome::failed(
            format!(
                "all {} term(s) skipped: already in the glossary with nothing new to merge (or empty)",
                out.skipped
            ),
            "Действие не выполнено: все термины уже есть в глоссарии",
        ));
    }

    // Split the touched rows for undo: not in the snapshot → ADDED (undo deletes the row);
    // in the snapshot → MERGED into (undo restores its previous alias list). A row created
    // AND merged within this one batch counts as added — deleting it IS its pre-state.
    let mut added_ids: Vec<String> = Vec::new();
    let mut merged_prev: Vec<Value> = Vec::new();
    for row in &out.affected {
        match pre_aliases.get(&row.id) {
            None => added_ids.push(row.id.clone()),
            Some(prev) => merged_prev.push(json!({
                "id": row.id,
                "prev_aliases_json": serde_json::to_string(prev).unwrap_or_else(|_| "[]".into()),
            })),
        }
    }

    let term_ids: Vec<&str> = out.affected.iter().map(|t| t.id.as_str()).collect();
    Ok(ActionOutcome::applied(
        ru_glossary_summary(out.added, out.merged),
        json!({ "added": out.added, "merged": out.merged, "skipped": out.skipped, "term_ids": term_ids }),
        json!({ "kind": "glossary.add_terms", "added_ids": added_ids, "merged": merged_prev }),
    ))
}

// synthesis.update_finding — update ONE finding's statement/confidence inside the cycle
// synthesis findings_json. Edits the RAW JSON Value (not the typed SynthesisDoc, whose
// re-serialization would drop unknown fields) so everything else stays byte-intact, and
// content_md is deliberately NOT touched (the md↔findings divergence is B3's concern).
// undo_token = the previous statement + confidence.
async fn exec_update_finding(
    pool: &SqlitePool,
    cycle_id: &str,
    goal_id: &str,
    finding_id: &str,
    statement: Option<&str>,
    confidence: Option<&str>,
) -> Result<ActionOutcome, String> {
    // synthesis::get_synthesis_db returns the typed doc — raw SQL here on purpose (see above).
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT id, findings_json FROM synthesis \
         WHERE cycle_id = ? AND interview_id IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(cycle_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((synthesis_id, findings_json)) = row else {
        return Ok(ActionOutcome::failed(
            "no cycle synthesis to update (run synthesis first)".into(),
            "Действие не выполнено: у цикла ещё нет синтеза",
        ));
    };

    let mut doc: Value = match serde_json::from_str(&findings_json) {
        Ok(v) => v,
        Err(e) => {
            return Ok(ActionOutcome::failed(
                format!("findings_json unreadable: {e}"),
                "Действие не выполнено: синтез повреждён",
            ))
        }
    };
    let Some(findings) = doc.get_mut("findings").and_then(Value::as_array_mut) else {
        return Ok(ActionOutcome::failed(
            "findings_json has no findings array".into(),
            "Действие не выполнено: в синтезе нет выводов",
        ));
    };
    // Revalidate BOTH ids: the finding must exist AND belong to the claimed goal.
    let Some(f) = findings
        .iter_mut()
        .find(|f| f.get("id").and_then(Value::as_str) == Some(finding_id))
    else {
        return Ok(ActionOutcome::failed(
            format!("finding '{finding_id}' not found in the cycle synthesis"),
            format!("Действие не выполнено: вывод {finding_id} не найден").as_str(),
        ));
    };
    let actual_goal = f.get("goal_id").and_then(Value::as_str).unwrap_or("");
    if actual_goal != goal_id {
        return Ok(ActionOutcome::failed(
            format!("finding '{finding_id}' belongs to goal '{actual_goal}', not '{goal_id}'"),
            "Действие не выполнено: цель и вывод не совпадают",
        ));
    }

    let prev_statement = f.get("statement").and_then(Value::as_str).unwrap_or("").to_string();
    let prev_confidence = f.get("confidence").and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(s) = statement {
        f["statement"] = json!(s);
    }
    if let Some(c) = confidence {
        f["confidence"] = json!(c);
    }

    let updated =
        serde_json::to_string(&doc).map_err(|e| format!("serialize findings_json: {e}"))?;
    sqlx::query("UPDATE synthesis SET findings_json = ? WHERE id = ?")
        .bind(&updated)
        .bind(&synthesis_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(ActionOutcome::applied(
        format!("Обновлён вывод {finding_id}"),
        json!({
            "finding_id": finding_id,
            "statement_updated": statement.is_some(),
            "confidence_updated": confidence.is_some(),
        }),
        json!({
            "kind": "synthesis.update_finding",
            "synthesis_id": synthesis_id,
            "finding_id": finding_id,
            "statement": prev_statement,
            "confidence": prev_confidence,
        }),
    ))
}

// Validate + execute ONE raw block, always ending in a persisted chat_tool_call row.
// Err only when the LOG ROW itself couldn't be written.
async fn run_action_block(
    pool: &SqlitePool,
    thread_id: &str,
    cycle_id: &str,
    message_id: &str,
    raw: &str,
) -> Result<ChatToolCall, String> {
    let tool = action_name(raw);
    let outcome = match validate_action(raw) {
        Err(reason) => {
            log::warn!(
                target: "interviewlab::chat",
                "[E-CHAT-ACTION-REJECTED] action '{tool}' rejected (thread='{thread_id}'): {reason}"
            );
            ActionOutcome::rejected(reason, "Действие отклонено: неверный формат")
        }
        Ok(ChatAction::GlossaryAddTerms { terms }) => {
            exec_glossary_add_terms(pool, cycle_id, &terms).await.unwrap_or_else(|e| {
                ActionOutcome::failed(format!("execution error: {e}"), "Действие не выполнено")
            })
        }
        Ok(ChatAction::SynthesisUpdateFinding { goal_id, finding_id, statement, confidence }) => {
            exec_update_finding(
                pool,
                cycle_id,
                &goal_id,
                &finding_id,
                statement.as_deref(),
                confidence.as_deref(),
            )
            .await
            .unwrap_or_else(|e| {
                ActionOutcome::failed(format!("execution error: {e}"), "Действие не выполнено")
            })
        }
    };
    if outcome.status == ACTION_STATUS_FAILED {
        log::error!(
            target: "interviewlab::chat",
            "[E-CHAT-ACTION-FAILED] action '{tool}' failed (thread='{thread_id}'): {}",
            outcome.error.as_deref().unwrap_or("?")
        );
    } else if outcome.status == ACTION_STATUS_APPLIED {
        log::info!(
            target: "interviewlab::chat",
            "chat action '{tool}' applied (thread='{thread_id}'): {}",
            outcome.summary
        );
    }
    insert_tool_call_db(pool, message_id, thread_id, &tool, raw, &outcome).await
}

// Process every extracted block from one assistant message: the FIRST is executed, extras
// are recorded as rejected ("at most one action per reply"). Returns the persisted rows in
// order; a row that couldn't even be persisted is logged and skipped.
async fn process_action_blocks(
    pool: &SqlitePool,
    thread_id: &str,
    cycle_id: &str,
    message_id: &str,
    blocks: &[String],
) -> Vec<ChatToolCall> {
    let mut rows = Vec::new();
    for (i, raw) in blocks.iter().enumerate() {
        let res = if i == 0 {
            run_action_block(pool, thread_id, cycle_id, message_id, raw).await
        } else {
            log::warn!(
                target: "interviewlab::chat",
                "[E-CHAT-ACTION-REJECTED] extra action block #{i} rejected (thread='{thread_id}'): only one per reply"
            );
            let outcome = ActionOutcome::rejected(
                "only one action block per reply is allowed".into(),
                "Действие отклонено: только одно действие за ответ",
            );
            insert_tool_call_db(pool, message_id, thread_id, &action_name(raw), raw, &outcome).await
        };
        match res {
            Ok(row) => rows.push(row),
            Err(e) => log::error!(
                target: "interviewlab::chat",
                "[E-CHAT-ACTION-STORE] could not persist tool call (thread='{thread_id}'): {e}"
            ),
        }
    }
    rows
}

// Undo one APPLIED action from its undo_token. Idempotent: undoing an already-undone call
// returns it unchanged. Rejected/failed calls were never executed → nothing to undo (error).
pub(crate) async fn undo_chat_action_db(
    pool: &SqlitePool,
    tool_call_id: &str,
) -> Result<ChatToolCall, String> {
    let row = get_tool_call_db(pool, tool_call_id)
        .await?
        .ok_or_else(|| format!("tool call '{tool_call_id}' not found"))?;
    if row.status == ACTION_STATUS_UNDONE {
        return Ok(row); // idempotent
    }
    if row.status != ACTION_STATUS_APPLIED {
        return Err(format!(
            "only applied actions can be undone (status: {})",
            row.status
        ));
    }
    let token: Value = serde_json::from_str(row.undo_token.as_deref().unwrap_or(""))
        .map_err(|e| format!("undo token unreadable: {e}"))?;

    match token.get("kind").and_then(Value::as_str) {
        Some("glossary.add_terms") => {
            // Restore the PRE-action state: delete the rows the action ADDED, and put back
            // the previous alias list of the rows it MERGED into. A term the user already
            // deleted by hand is simply gone — the DELETE/UPDATE is a no-op (idempotent).
            // Fallback: `term_ids` is the pre-merge (v1) token shape — those actions only
            // ever inserted rows, so its ids are exactly the added ids.
            let added = token.get("added_ids").or_else(|| token.get("term_ids"));
            if let Some(ids) = added.and_then(Value::as_array) {
                for id in ids.iter().filter_map(Value::as_str) {
                    sqlx::query("DELETE FROM glossary_term WHERE id = ?")
                        .bind(id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            if let Some(merged) = token.get("merged").and_then(Value::as_array) {
                for m in merged {
                    let Some(id) = m.get("id").and_then(Value::as_str) else { continue };
                    let prev = m.get("prev_aliases_json").and_then(Value::as_str).unwrap_or("[]");
                    sqlx::query("UPDATE glossary_term SET aliases_json = ?, updated_at = ? WHERE id = ?")
                        .bind(prev)
                        .bind(now_ms())
                        .bind(id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Some("synthesis.update_finding") => {
            let synthesis_id = token.get("synthesis_id").and_then(Value::as_str).unwrap_or("");
            let finding_id = token.get("finding_id").and_then(Value::as_str).unwrap_or("");
            let findings_json: Option<String> =
                sqlx::query_scalar("SELECT findings_json FROM synthesis WHERE id = ?")
                    .bind(synthesis_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            let Some(findings_json) = findings_json else {
                return Err("the synthesis this action edited no longer exists".into());
            };
            let mut doc: Value = serde_json::from_str(&findings_json)
                .map_err(|e| format!("findings_json unreadable: {e}"))?;
            let f = doc
                .get_mut("findings")
                .and_then(Value::as_array_mut)
                .and_then(|arr| {
                    arr.iter_mut()
                        .find(|f| f.get("id").and_then(Value::as_str) == Some(finding_id))
                })
                .ok_or_else(|| {
                    format!("finding '{finding_id}' no longer exists (synthesis re-run?)")
                })?;
            f["statement"] = token.get("statement").cloned().unwrap_or(json!(""));
            f["confidence"] = token.get("confidence").cloned().unwrap_or(json!(""));
            let updated =
                serde_json::to_string(&doc).map_err(|e| format!("serialize findings_json: {e}"))?;
            sqlx::query("UPDATE synthesis SET findings_json = ? WHERE id = ?")
                .bind(&updated)
                .bind(synthesis_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        other => return Err(format!("unknown undo token kind: {other:?}")),
    }

    sqlx::query("UPDATE chat_tool_call SET status = ?, undone_at = ? WHERE id = ?")
        .bind(ACTION_STATUS_UNDONE)
        .bind(now_ms())
        .bind(tool_call_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    get_tool_call_db(pool, tool_call_id)
        .await?
        .ok_or_else(|| "tool call vanished after undo".to_string())
}

// --- streaming runner (plugin-first) ------------------------------------------

// Render the active plugin's chat.stream arg template, substituting the placeholders we
// fill. PLUGIN-FIRST: the flags come from the descriptor's `chat` block (ChatStream /
// ChatSession in adapter.rs), not hardcoded here. We only know how to fill the named
// placeholders + drop the empty session-args group on turn 1.
//
//   {prompt}              → the user's question
//   {system_prompt_file}  → path to the temp context-pack file
//   {session_args}        → expands to the session.resume_args with {session_id} filled,
//                           or nothing on turn 1 / when the plugin lacks multi-turn.
//
// Phase A passes no MCP / allowed-tools (tools are Phase B/C); the descriptor's stream
// template already includes `--tools ""` so no built-ins fire.
fn render_chat_args(
    adapter: &crate::adapter::Adapter,
    prompt: &str,
    system_prompt_file: &str,
    session_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let chat = adapter
        .chat
        .as_ref()
        .ok_or_else(|| format!("plugin `{}` declares no chat capability", adapter.id))?;
    let stream = chat
        .stream
        .as_ref()
        .ok_or_else(|| format!("plugin `{}` declares no streaming capability", adapter.id))?;

    // The resume args group: only when the plugin supports sessions AND we have an id.
    let session_args: Vec<String> = match (session_id, chat.session.as_ref()) {
        (Some(sid), Some(sess)) => sess
            .resume_args
            .iter()
            .map(|a| a.replace("{session_id}", sid))
            .collect(),
        _ => Vec::new(),
    };

    let mut out: Vec<String> = Vec::with_capacity(stream.args_template.len() + 2);
    for a in &stream.args_template {
        match a.as_str() {
            "{prompt}" => out.push(prompt.to_string()),
            "{system_prompt_file}" => out.push(system_prompt_file.to_string()),
            "{session_args}" => out.extend(session_args.iter().cloned()),
            // Tool/MCP placeholder groups are empty in Phase A (declared but unfilled).
            "{mcp_args}" | "{allowed_tools_args}" => { /* Phase B/C */ }
            other => out.push(other.to_string()),
        }
    }
    Ok(out)
}

// Parse one ndjson line from `claude --output-format stream-json --include-partial-messages`
// (the `claude-stream-json` named parser, feature-cycle-chat.md §4.3) into the text delta +
// terminal session/cost. Tolerant: unrecognized event types return (None, None, None) and
// are skipped, so a schema addition can't break the stream.
//
// Returns (text_delta, session_id, cost_usd). On the final `result` event the session_id +
// cost are populated. Phase A ignores tool_use / tool_result blocks (no tools fire).
struct ParsedLine {
    text: Option<String>,
    session_id: Option<String>,
    cost_usd: Option<f64>,
    is_done: bool,
}

fn parse_stream_line(line: &str) -> ParsedLine {
    let mut p = ParsedLine { text: None, session_id: None, cost_usd: None, is_done: false };
    let Ok(ev): Result<Value, _> = serde_json::from_str(line) else {
        return p;
    };
    let ty = ev.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        // Token-level delta: a stream_event wrapping a raw Anthropic content_block_delta.
        // The CLI nests the API event under `event` (with --include-partial-messages).
        "stream_event" => {
            if let Some(inner) = ev.get("event") {
                if inner.get("type").and_then(Value::as_str) == Some("content_block_delta") {
                    if let Some(delta) = inner.get("delta") {
                        if delta.get("type").and_then(Value::as_str) == Some("text_delta") {
                            if let Some(t) = delta.get("text").and_then(Value::as_str) {
                                p.text = Some(t.to_string());
                            }
                        }
                    }
                }
            }
        }
        // Some CLI builds emit the raw API event at top level (no stream_event wrapper).
        "content_block_delta" => {
            if let Some(delta) = ev.get("delta") {
                if delta.get("type").and_then(Value::as_str) == Some("text_delta") {
                    if let Some(t) = delta.get("text").and_then(Value::as_str) {
                        p.text = Some(t.to_string());
                    }
                }
            }
        }
        // Final result event: carries session_id + total_cost_usd. `result` (the whole
        // answer) is ALSO here — used as a fallback if no partial deltas streamed.
        "result" => {
            p.is_done = true;
            p.session_id = ev.get("session_id").and_then(Value::as_str).map(String::from);
            p.cost_usd = ev.get("total_cost_usd").and_then(Value::as_f64);
            // Fallback whole-answer text (only used when partial deltas didn't arrive).
            if let Some(r) = ev.get("result").and_then(Value::as_str) {
                p.text = Some(r.to_string());
            }
        }
        _ => {}
    }
    p
}

// A neutral cwd so no stray CLAUDE.md / project config is auto-discovered (matches adapter.rs).
fn neutral_cwd() -> std::path::PathBuf {
    std::env::temp_dir()
}

// Idle-timeout (watchdog) for the chat stream: the longest we wait for the NEXT line from the
// CLI before we assume it hung and kill it. The chat path is the one long-running CLI loop with
// no watchdog (ASR has run_guarded_whisper, the batch runner has spawn_once's timeout); a hung
// plugin that stops emitting lines without closing stdout would otherwise pin the thread's
// in-flight slot forever. The budget is generous — first-token latency on a cold model + a long
// answer between two deltas can be slow — but bounded.
const IDLE_TIMEOUT_SECS: u64 = 120;
const CHAT_STREAM_IDLE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(IDLE_TIMEOUT_SECS);

// The core streaming turn: spawn the plugin's chat command, line-stream stdout, emit
// token/done/error on chat://<thread_id>, persist the assistant message + thread session_id.
// Runs on a spawned task so cycle_chat_send returns immediately and the UI streams live.
async fn run_turn(
    app: tauri::AppHandle,
    pool: SqlitePool,
    adapter: crate::adapter::Adapter,
    thread_id: String,
    cycle_id: String,
    prompt: String,
    context_pack: String,
    resume_session_id: Option<String>,
) {
    let evt = chat_event_name(&thread_id);
    log::info!(
        target: "interviewlab::chat",
        "chat turn: thread='{thread_id}' adapter='{}' resume={} prompt_chars={} context_chars={}",
        adapter.id,
        resume_session_id.is_some(),
        prompt.len(),
        context_pack.len()
    );

    // Write the context pack to a temp file for --append-system-prompt-file (sidesteps
    // arg-length + the 10 MB stdin cap; §4.2). Cleaned up after the turn.
    let pack_path = std::env::temp_dir().join(format!("ilab-chat-ctx-{thread_id}.md"));
    if let Err(e) = tokio::fs::write(&pack_path, context_pack.as_bytes()).await {
        emit_error(&app, &evt, &thread_id, format!("could not write context pack: {e}"));
        return;
    }
    let pack_str = pack_path.to_string_lossy().to_string();

    let args = match render_chat_args(&adapter, &prompt, &pack_str, resume_session_id.as_deref()) {
        Ok(a) => a,
        Err(e) => {
            emit_error(&app, &evt, &thread_id, e);
            let _ = tokio::fs::remove_file(&pack_path).await;
            return;
        }
    };

    let mut cmd = Command::new(&adapter.command);
    cmd.args(&args)
        .current_dir(neutral_cwd())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Kill the child if this handle is dropped (panic / early return) so a stuck CLI
        // can't outlive the turn as an orphan (roadmap §H: kill_on_drop on both Commands).
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_error(&app, &evt, &thread_id, format!("could not start `{}`: {e}", adapter.command));
            let _ = tokio::fs::remove_file(&pack_path).await;
            return;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Register the child so cancel can kill it; pull stdout/stderr first (we own the reader).
    with_inflight(|m| {
        m.insert(thread_id.clone(), child);
    });

    let mut full = String::new();
    let mut session_id: Option<String> = None;
    let mut cost_usd: Option<f64> = None;
    let mut got_partial = false;
    // Set when the idle watchdog fires (no line within CHAT_STREAM_IDLE_TIMEOUT): we kill the
    // child below and surface a clear timeout error instead of hanging the thread's slot.
    let mut idle_timed_out = false;

    if let Some(stdout) = stdout {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            // Idle watchdog: bound the wait for the NEXT line. A done `result` event can still be
            // followed by more lines (or EOF); we keep reading until EOF, but never wait forever.
            match tokio::time::timeout(CHAT_STREAM_IDLE_TIMEOUT, lines.next_line()).await {
                Err(_elapsed) => {
                    idle_timed_out = true;
                    break;
                }
                Ok(Ok(Some(line))) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let parsed = parse_stream_line(&line);
                    if parsed.is_done {
                        // The final result carries session_id + cost; its text is the whole
                        // answer (fallback only — don't double-append if we streamed deltas).
                        session_id = parsed.session_id.or(session_id);
                        cost_usd = parsed.cost_usd.or(cost_usd);
                        if !got_partial {
                            if let Some(t) = parsed.text {
                                full.push_str(&t);
                                let _ = app.emit(&evt, ChatEvent::Token { thread_id: thread_id.clone(), text: t });
                            }
                        }
                    } else if let Some(t) = parsed.text {
                        got_partial = true;
                        full.push_str(&t);
                        let _ = app.emit(&evt, ChatEvent::Token { thread_id: thread_id.clone(), text: t });
                    }
                }
                Ok(Ok(None)) => break, // EOF
                Ok(Err(_)) => break,   // read error
            }
        }
    }

    // Idle watchdog fired: kill the child, surface a timeout, drop the partial turn. Done before
    // the normal reap so the killed child is removed from INFLIGHT and the thread slot frees.
    if idle_timed_out {
        if let Some(mut c) = with_inflight(|m| m.remove(&thread_id)) {
            let _ = c.start_kill();
        }
        let _ = tokio::fs::remove_file(&pack_path).await;
        log::error!(
            target: "interviewlab::chat",
            "[E-CHAT-TIMEOUT] chat turn (thread='{thread_id}'): no output from CLI '{}' for {IDLE_TIMEOUT_SECS}s — killed",
            adapter.command
        );
        // Mark the turn failed in the DB too, so a reopened panel reconciles to a failed
        // message instead of a silently vanished turn. Content keeps any partial text.
        let err_txt =
            format!("[E-CHAT-TIMEOUT] no output from the CLI for {IDLE_TIMEOUT_SECS}s; the process was stopped");
        let _ = append_message_db(&pool, &thread_id, "assistant", &full, "[]", "error", Some(&err_txt), None).await;
        emit_error(
            &app,
            &evt,
            &thread_id,
            format!(
                "the assistant stopped responding (no output for {IDLE_TIMEOUT_SECS}s) and was stopped"
            ),
        );
        return;
    }

    // Reap the child + capture stderr. If cancel already removed+killed it, take() returns None.
    let removed = with_inflight(|m| m.remove(&thread_id));
    let cancelled = removed.is_none();
    let mut stderr_text = String::new();
    if let Some(se) = stderr {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let mut se = se;
        let _ = se.read_to_end(&mut buf).await;
        stderr_text = String::from_utf8_lossy(&buf).into_owned();
    }
    let status = match removed {
        Some(mut c) => c.wait().await.ok(),
        None => None,
    };
    let _ = tokio::fs::remove_file(&pack_path).await;

    // Cancelled mid-stream: drop the in-flight assistant message (UI clears it). We don't
    // persist a partial assistant turn in Phase A. (The user message is already persisted.)
    if cancelled {
        emit_error(&app, &evt, &thread_id, "cancelled".to_string());
        return;
    }

    let exit_ok = status.map(|s| s.success()).unwrap_or(false);
    if !exit_ok && full.trim().is_empty() {
        // The CLI produced no usable answer. Log the FULL stderr + exit status (the real
        // diagnostic) before the user-facing emit_error trims it.
        log::error!(
            target: "interviewlab::chat",
            "[E-CHAT-NO-ANSWER] chat turn (thread='{thread_id}'): CLI '{}' exited {:?} with no answer.\n  stderr: {}",
            adapter.command,
            status.map(|s| s.to_string()).unwrap_or_else(|| "<no status>".into()),
            if stderr_text.trim().is_empty() { "<empty>".into() } else { crate::logging::truncate(stderr_text.trim(), 4000) }
        );
        let detail = if stderr_text.trim().is_empty() {
            "the assistant did not return a response".to_string()
        } else {
            stderr_text.trim().to_string()
        };
        emit_error(&app, &evt, &thread_id, detail);
        return;
    }

    // Phase B: pull any invlab-action block(s) out of the FINAL assistant text — the stored/
    // displayed message is the STRIPPED content; the blocks are executed after the message
    // row exists (chat_tool_call.message_id FK).
    let (stripped, action_blocks) = extract_action_blocks(&full);

    // Persist the completed assistant message + parse citations from the inline tokens.
    let citations = parse_citations(&stripped);
    let msg = match append_message_db(
        &pool,
        &thread_id,
        "assistant",
        &stripped,
        &citations,
        "complete",
        None,
        cost_usd,
    )
    .await
    {
        Ok(m) => m,
        Err(e) => {
            emit_error(&app, &evt, &thread_id, format!("could not save the answer: {e}"));
            return;
        }
    };

    // Execute + record the action blocks, emitting a chip event per block so the UI renders
    // them live (they also reload via list_chat_tool_calls). Done BEFORE the Done event so
    // the panel finalizes with the chips already present.
    if !action_blocks.is_empty() {
        let rows = process_action_blocks(&pool, &thread_id, &cycle_id, &msg.id, &action_blocks).await;
        for row in rows {
            let summary = tool_call_summary(&row);
            let _ = app.emit(
                &evt,
                ChatEvent::Action {
                    thread_id: thread_id.clone(),
                    tool_call_id: row.id,
                    tool: row.tool,
                    status: row.status,
                    summary,
                },
            );
        }
    }

    // Store the session_id on the thread for --resume on the next turn.
    if let Some(sid) = &session_id {
        let _ = sqlx::query("UPDATE chat_thread SET session_id = ?, updated_at = ? WHERE id = ?")
            .bind(sid)
            .bind(now_ms())
            .bind(&thread_id)
            .execute(&pool)
            .await;
    }

    let _ = app.emit(
        &evt,
        ChatEvent::Done {
            thread_id: thread_id.clone(),
            message_id: msg.id,
            session_id,
            cost_usd,
        },
    );
}

fn emit_error(app: &tauri::AppHandle, evt: &str, thread_id: &str, message: String) {
    // Central chat-error surface: every failure path routes here, so log here once. A
    // user-initiated "cancelled" is expected (debug), everything else is a real error.
    if message == "cancelled" {
        log::debug!(target: "interviewlab::chat", "chat turn cancelled (thread='{thread_id}')");
    } else {
        // Tag the central chat-failure line so an agent can grep '[E-CHAT-' for every failed
        // turn. The spawn-not-started message gets the more specific E-CHAT-SPAWN code.
        let code = if message.starts_with("could not start") { "E-CHAT-SPAWN" } else { "E-CHAT-TURN" };
        log::error!(target: "interviewlab::chat", "[{code}] chat turn FAILED (thread='{thread_id}'): {message}");
    }
    let _ = app.emit(evt, ChatEvent::Error { thread_id: thread_id.to_string(), message });
}

// --- Tauri commands -----------------------------------------------------------

#[tauri::command]
pub async fn list_chat_threads(db: tauri::State<'_, Db>, cycle_id: String) -> Result<Vec<ChatThread>, String> {
    list_threads_db(&db.pool, &cycle_id).await
}

#[tauri::command]
pub async fn create_chat_thread(
    db: tauri::State<'_, Db>,
    cycle_id: String,
    title: Option<String>,
) -> Result<ChatThread, String> {
    create_thread_db(&db.pool, &cycle_id, title.as_deref().unwrap_or("New chat")).await
}

#[tauri::command]
pub async fn rename_chat_thread(
    db: tauri::State<'_, Db>,
    thread_id: String,
    title: String,
) -> Result<ChatThread, String> {
    rename_thread_db(&db.pool, &thread_id, &title).await
}

#[tauri::command]
pub async fn delete_chat_thread(db: tauri::State<'_, Db>, thread_id: String) -> Result<(), String> {
    // Best-effort: kill any in-flight turn for this thread first.
    if let Some(mut c) = with_inflight(|m| m.remove(&thread_id)) {
        let _ = c.start_kill();
    }
    delete_thread_db(&db.pool, &thread_id).await
}

#[tauri::command]
pub async fn get_chat_messages(db: tauri::State<'_, Db>, thread_id: String) -> Result<Vec<ChatMessage>, String> {
    list_messages_db(&db.pool, &thread_id).await
}

// Persist a user message without sending a turn (assistant-ui's onNew persists first).
// Returns the saved row.
#[tauri::command]
pub async fn cycle_chat_append(
    db: tauri::State<'_, Db>,
    thread_id: String,
    content: String,
) -> Result<ChatMessage, String> {
    append_message_db(&db.pool, &thread_id, "user", &content, "[]", "complete", None, None).await
}

// Send a chat turn: build the context pack, render the plugin's chat command, spawn the
// streaming runner on a task. Emits token/done/error on chat://<thread_id>. The user message
// must already be persisted (cycle_chat_append) — this command does NOT re-persist it.
//
// One in-flight turn per thread: a send while a turn is running is rejected.
#[tauri::command]
pub async fn cycle_chat_send(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    thread_id: String,
    cycle_id: String,
    text: String,
    adapter_id: Option<String>,
) -> Result<(), String> {
    // Guard: one in-flight turn per thread.
    let busy = with_inflight(|m| m.contains_key(&thread_id));
    if busy {
        return Err("a turn is already in progress for this thread".to_string());
    }

    // Resolve the active plugin (default claude-code) + verify it has the chat capability.
    let id = match adapter_id {
        Some(id) => id,
        None => crate::adapter::active_adapter_id(&db.pool).await?,
    };
    let adapter = crate::adapter::resolve_adapter_pub(&app, Some(&id))?;
    // Plugin-first capability gate (feature-cli-plugins.md §3.1): the active plugin must
    // declare `streaming` AND carry the chat.stream block the runner renders.
    if !adapter.has_capability(crate::adapter::CAP_STREAMING)
        || adapter.chat.as_ref().and_then(|c| c.stream.as_ref()).is_none()
    {
        return Err(format!("the active plugin `{}` does not support streaming chat", adapter.id));
    }

    // Resume id (if this thread has had a turn before) for multi-turn continuity.
    let thread = get_thread_db(&db.pool, &thread_id).await?;
    let resume = thread.session_id.clone();

    // Auto-title a brand-new thread from its first question (first ~60 chars).
    if thread.title.is_empty() || thread.title == "New chat" {
        let title = derive_title(&text);
        let _ = rename_thread_db(&db.pool, &thread_id, &title).await;
    }

    let context_pack = build_context(&db.pool, &cycle_id).await?;

    // Spawn the runner; the command returns immediately so the UI streams live.
    let app2 = app.clone();
    let pool = db.pool.clone();
    tauri::async_runtime::spawn(async move {
        run_turn(app2, pool, adapter, thread_id, cycle_id, text, context_pack, resume).await;
    });
    Ok(())
}

// Phase B: the tool-call / action log for a thread (chips + undo state on panel reload).
#[tauri::command]
pub async fn list_chat_tool_calls(
    db: tauri::State<'_, Db>,
    thread_id: String,
) -> Result<Vec<ChatToolCall>, String> {
    list_tool_calls_db(&db.pool, &thread_id).await
}

// Phase B: undo one applied action (restores from undo_token, flips status → undone).
// Idempotent — undoing an already-undone call returns it unchanged.
#[tauri::command]
pub async fn undo_chat_action(
    db: tauri::State<'_, Db>,
    tool_call_id: String,
) -> Result<ChatToolCall, String> {
    undo_chat_action_db(&db.pool, &tool_call_id).await.map_err(|e| {
        log::error!(
            target: "interviewlab::chat",
            "[E-CHAT-ACTION-UNDO] undo failed (tool_call='{tool_call_id}'): {e}"
        );
        e
    })
}

// Cancel the in-flight turn for a thread (Stop). Kills the child; the runner emits an
// error("cancelled") and drops the partial assistant message.
#[tauri::command]
pub async fn cycle_chat_cancel(thread_id: String) -> Result<(), String> {
    if let Some(mut c) = with_inflight(|m| m.remove(&thread_id)) {
        let _ = c.start_kill();
    }
    Ok(())
}

// First non-empty line, trimmed to ~60 chars, as the thread title.
fn derive_title(text: &str) -> String {
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("New chat").trim();
    let mut t: String = first.chars().take(60).collect();
    if first.chars().count() > 60 {
        t.push('…');
    }
    if t.is_empty() {
        t = "New chat".to_string();
    }
    t
}

// --- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn seed_cycle(pool: &SqlitePool) -> String {
        let id = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO cycle (id, name, created_at, updated_at) VALUES (?, 'Test cycle', ?, ?)")
            .bind(&id)
            .bind(ts)
            .bind(ts)
            .execute(pool)
            .await
            .unwrap();
        id
    }

    // 0004 applies + thread CRUD: create → append two messages → read back in order.
    #[tokio::test]
    async fn thread_create_append_read_roundtrip() {
        let pool = test_pool().await;
        let cycle_id = seed_cycle(&pool).await;

        assert_eq!(list_threads_db(&pool, &cycle_id).await.unwrap().len(), 0);

        let thread = create_thread_db(&pool, &cycle_id, "New chat").await.unwrap();
        assert_eq!(thread.cycle_id, cycle_id);
        assert!(thread.session_id.is_none());

        let m1 = append_message_db(&pool, &thread.id, "user", "What are the top objections?", "[]", "complete", None, None)
            .await
            .unwrap();
        let m2 = append_message_db(
            &pool,
            &thread.id,
            "assistant",
            "Mainly the data-source connect. [[finding:F1]]",
            r#"[{"kind":"finding","finding_id":"F1"}]"#,
            "complete",
            None,
            Some(0.01),
        )
        .await
        .unwrap();

        let msgs = list_messages_db(&pool, &thread.id).await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, m1.id);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].id, m2.id);
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].cost_usd, Some(0.01));
    }

    // Cascade: deleting the cycle removes its threads + messages (FK ON DELETE CASCADE).
    #[tokio::test]
    async fn cycle_delete_cascades_threads() {
        let pool = test_pool().await;
        let cycle_id = seed_cycle(&pool).await;
        let thread = create_thread_db(&pool, &cycle_id, "T").await.unwrap();
        append_message_db(&pool, &thread.id, "user", "hi", "[]", "complete", None, None).await.unwrap();

        sqlx::query("DELETE FROM cycle WHERE id = ?").bind(&cycle_id).execute(&pool).await.unwrap();

        let threads: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_thread").fetch_one(&pool).await.unwrap();
        let msgs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_message").fetch_one(&pool).await.unwrap();
        assert_eq!(threads, 0);
        assert_eq!(msgs, 0);
    }

    // Deleting a thread cascades to its messages.
    #[tokio::test]
    async fn thread_delete_cascades_messages() {
        let pool = test_pool().await;
        let cycle_id = seed_cycle(&pool).await;
        let thread = create_thread_db(&pool, &cycle_id, "T").await.unwrap();
        append_message_db(&pool, &thread.id, "user", "hi", "[]", "complete", None, None).await.unwrap();
        delete_thread_db(&pool, &thread.id).await.unwrap();
        let msgs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_message").fetch_one(&pool).await.unwrap();
        assert_eq!(msgs, 0);
    }

    // build_context assembles the pack: cycle name, guide goals, findings (with ids),
    // interview index, diff summary; citation preamble present; under the size budget.
    #[tokio::test]
    async fn build_context_assembles_pack() {
        let pool = test_pool().await;
        let cycle_id = seed_cycle(&pool).await;
        let ts = now_ms();

        // A guide with goals (inline).
        sqlx::query("UPDATE cycle SET guide = ?, product_desc = ? WHERE id = ?")
            .bind("Goals:\n- G1: Why do accounts stall?\n- G2: Which step confuses?")
            .bind("Acme Analytics product.")
            .bind(&cycle_id)
            .execute(&pool)
            .await
            .unwrap();

        // An interview + cycle synthesis with one finding.
        let iv = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO interview (id, cycle_id, title, status, created_at, updated_at) VALUES (?, ?, 'Interview 1', 'edited', ?, ?)")
            .bind(&iv).bind(&cycle_id).bind(ts).bind(ts).execute(&pool).await.unwrap();

        let findings = json!({
            "findings": [{
                "id": "F1", "goal_id": "G1", "confidence": "high",
                "statement": "Accounts stall at the data-source connect.",
                "recommendation": "Offer a sample dataset.",
                "evidence": [{"interview_id": iv, "segment_id": 3, "quote": "I stalled there."}]
            }]
        });
        sqlx::query("INSERT INTO synthesis (id, cycle_id, findings_json, content_md, created_at) VALUES (?, ?, ?, '# Report\nStalls at connect.', ?)")
            .bind(Uuid::new_v4().to_string()).bind(&cycle_id).bind(findings.to_string()).bind(ts)
            .execute(&pool).await.unwrap();

        let pack = build_context(&pool, &cycle_id).await.unwrap();
        assert!(pack.contains("InterviewLab's cycle assistant"), "preamble present");
        assert!(pack.contains("Test cycle"), "cycle name");
        assert!(pack.contains("G1"), "goal id");
        assert!(pack.contains("F1"), "finding id");
        assert!(pack.contains("Accounts stall at the data-source connect"), "finding statement");
        assert!(pack.contains(&iv), "interview index id");
        assert!(pack.contains("Interview 1"), "interview title");
        assert!(pack.len() < 64 * 1024, "pack under 64KB: {}", pack.len());
    }

    // Citation parser: extracts every token shape, ignores malformed ones.
    #[test]
    fn parse_citations_extracts_tokens() {
        let content = "Stalls at connect [[finding:F1]] supports [[hypothesis:H2]] answers [[question:Q3]] per [[interview:iv9]] and [[iv:iv9 seg:3]]. Junk [[bogus:x]].";
        let json: Value = serde_json::from_str(&parse_citations(content)).unwrap();
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 5);
        assert_eq!(arr[0]["kind"], "finding");
        assert_eq!(arr[0]["finding_id"], "F1");
        assert_eq!(arr[1]["kind"], "hypothesis");
        assert_eq!(arr[1]["hypothesis_id"], "H2");
        assert_eq!(arr[2]["kind"], "question");
        assert_eq!(arr[2]["question_id"], "Q3");
        assert_eq!(arr[3]["kind"], "interview");
        assert_eq!(arr[4]["kind"], "segment");
        assert_eq!(arr[4]["segment_id"], 3);
    }

    // The claude-stream-json parser: a content_block_delta yields a text token; the result
    // event yields session_id + cost + is_done.
    #[test]
    fn parse_stream_line_handles_delta_and_result() {
        // Wrapped stream_event form.
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}"#;
        let p = parse_stream_line(delta);
        assert_eq!(p.text.as_deref(), Some("Hello"));
        assert!(!p.is_done);

        // Top-level raw form.
        let delta2 = r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}"#;
        assert_eq!(parse_stream_line(delta2).text.as_deref(), Some(" world"));

        // Final result.
        let result = r#"{"type":"result","subtype":"success","result":"Hello world","session_id":"sess-123","total_cost_usd":0.02}"#;
        let p = parse_stream_line(result);
        assert!(p.is_done);
        assert_eq!(p.session_id.as_deref(), Some("sess-123"));
        assert_eq!(p.cost_usd, Some(0.02));

        // Unknown event: skipped.
        assert!(parse_stream_line(r#"{"type":"system","subtype":"init"}"#).text.is_none());
        // Garbage line: skipped, no panic.
        assert!(parse_stream_line("not json").text.is_none());
    }

    // render_chat_args fills the placeholders from the descriptor + drops the session group
    // on turn 1, and includes it (resume) when a session id is present.
    #[tokio::test]
    async fn render_chat_args_plugin_first() {
        let adapter = crate::adapter::builtin_adapter_pub();
        // Turn 1: no session id → no --resume.
        let args = render_chat_args(&adapter, "summarize objections", "/tmp/ctx.md", None).unwrap();
        assert!(args.contains(&"summarize objections".to_string()), "prompt filled");
        assert!(args.contains(&"/tmp/ctx.md".to_string()), "context file filled");
        assert!(args.iter().any(|a| a == "stream-json"), "stream-json format");
        assert!(args.iter().any(|a| a == "--include-partial-messages"), "partial messages");
        assert!(args.iter().any(|a| a == "--append-system-prompt-file"), "grounding flag");
        assert!(!args.iter().any(|a| a == "--resume"), "no resume on turn 1");
        assert!(!args.iter().any(|a| a == "--bare"), "never --bare (subscription auth)");
        assert!(args.iter().any(|a| a == "--strict-mcp-config"), "isolation");
        // No unfilled placeholder groups leak through.
        assert!(!args.iter().any(|a| a.contains('{')), "no leftover placeholders: {args:?}");

        // Turn 2: a session id → --resume <id>.
        let args2 = render_chat_args(&adapter, "follow up", "/tmp/ctx.md", Some("sess-9")).unwrap();
        let i = args2.iter().position(|a| a == "--resume").expect("resume present");
        assert_eq!(args2[i + 1], "sess-9");
    }

    #[test]
    fn derive_title_truncates() {
        assert_eq!(derive_title("Short question"), "Short question");
        let long = "a".repeat(80);
        let t = derive_title(&long);
        assert!(t.ends_with('…'));
        assert!(t.chars().count() <= 61);
    }

    // --- Phase B: action blocks -------------------------------------------------

    // Seed a cycle LINKED to a product (the glossary lives on the product) + one existing
    // term «Jira» that already carries one alias (so merge-undo can assert exact restore).
    async fn seed_cycle_with_product(pool: &SqlitePool) -> (String, String) {
        let cycle_id = seed_cycle(pool).await;
        let pid = Uuid::new_v4().to_string();
        let ts = now_ms();
        sqlx::query("INSERT INTO product (id, name, content_md, created_at, updated_at) VALUES (?, 'P', '', ?, ?)")
            .bind(&pid).bind(ts).bind(ts).execute(pool).await.unwrap();
        sqlx::query("UPDATE cycle SET product_id = ? WHERE id = ?")
            .bind(&pid).bind(&cycle_id).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO glossary_term (id, product_id, canonical, aliases_json, notes, created_at, updated_at) VALUES (?, ?, 'Jira', '[\"джира\"]', '', ?, ?)")
            .bind(Uuid::new_v4().to_string()).bind(&pid).bind(ts).bind(ts).execute(pool).await.unwrap();
        (cycle_id, pid)
    }

    async fn term_aliases(pool: &SqlitePool, pid: &str, canonical: &str) -> Vec<String> {
        let js: String = sqlx::query_scalar(
            "SELECT aliases_json FROM glossary_term WHERE product_id = ? AND canonical = ?",
        )
        .bind(pid)
        .bind(canonical)
        .fetch_one(pool)
        .await
        .unwrap();
        serde_json::from_str(&js).unwrap()
    }

    // Seed a thread + a persisted assistant message (chat_tool_call has FKs to both).
    async fn seed_thread_message(pool: &SqlitePool, cycle_id: &str) -> (String, String) {
        let thread = create_thread_db(pool, cycle_id, "T").await.unwrap();
        let msg = append_message_db(pool, &thread.id, "assistant", "ok", "[]", "complete", None, None)
            .await
            .unwrap();
        (thread.id, msg.id)
    }

    async fn glossary_count(pool: &SqlitePool, pid: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM glossary_term WHERE product_id = ?")
            .bind(pid)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    // No block: content untouched (modulo trailing whitespace), nothing extracted.
    #[test]
    fn extract_action_blocks_none() {
        let content = "Просто ответ.\n\nС обычным ```rust\nlet x = 1;\n``` кодом.";
        let (stripped, blocks) = extract_action_blocks(content);
        assert!(blocks.is_empty());
        assert_eq!(stripped, content);
    }

    // A real block is extracted and stripped from the stored content.
    #[test]
    fn extract_action_blocks_strips_block() {
        let content = "Добавляю термины.\n\n```invlab-action\n{\"action\":\"glossary.add_terms\",\"terms\":[{\"canonical\":\"API\"}]}\n```";
        let (stripped, blocks) = extract_action_blocks(content);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].contains("glossary.add_terms"));
        assert_eq!(stripped, "Добавляю термины.");
        // The payload is exactly the fence body (valid JSON).
        let v: Value = serde_json::from_str(&blocks[0]).unwrap();
        assert_eq!(v["action"], "glossary.add_terms");
    }

    // A block QUOTED inside another language's code sample is literal content per CommonMark
    // (a closing fence carries no info string) — never extracted, never fired.
    #[test]
    fn extract_action_blocks_ignores_nested_in_other_fence() {
        let content = "Вот формат:\n```markdown\n```invlab-action\n{\"action\":\"glossary.add_terms\",\"terms\":[]}\n```\n```\nконец";
        let (stripped, blocks) = extract_action_blocks(content);
        assert!(blocks.is_empty(), "quoted block must NOT be extracted");
        assert_eq!(stripped, content, "quoted block stays in the displayed text");
    }

    // An unterminated action fence is not a block — restored verbatim, not executed.
    #[test]
    fn extract_action_blocks_unterminated_restored() {
        let content = "Ответ.\n```invlab-action\n{\"action\":\"glossary.add_terms\"";
        let (stripped, blocks) = extract_action_blocks(content);
        assert!(blocks.is_empty());
        assert_eq!(stripped, content);
    }

    // Whitelist validation: malformed json / unknown action / bad payloads are rejected;
    // well-formed whitelisted actions parse.
    #[test]
    fn validate_action_whitelist() {
        assert!(validate_action("{not json").is_err(), "malformed json");
        assert!(validate_action(r#"{"action":"db.drop_everything"}"#).is_err(), "unknown action");
        assert!(validate_action(r#"{"action":"glossary.add_terms","terms":[]}"#).is_err(), "empty terms");
        assert!(
            validate_action(r#"{"action":"synthesis.update_finding","goal_id":"G1","finding_id":"F1"}"#).is_err(),
            "nothing to update"
        );
        assert!(
            validate_action(r#"{"action":"synthesis.update_finding","goal_id":"G1","finding_id":"F1","confidence":"huge"}"#).is_err(),
            "confidence out of range"
        );
        assert!(matches!(
            validate_action(r#"{"action":"glossary.add_terms","terms":[{"canonical":"API","aliases":["апи"]}]}"#),
            Ok(ChatAction::GlossaryAddTerms { .. })
        ));
        assert!(matches!(
            validate_action(r#"{"action":"synthesis.update_finding","goal_id":"G1","finding_id":"F2","statement":"s","confidence":"high"}"#),
            Ok(ChatAction::SynthesisUpdateFinding { .. })
        ));
    }

    #[test]
    fn ru_terms_added_pluralizes() {
        assert_eq!(ru_terms_added(1), "Добавлен 1 термин в глоссарий");
        assert_eq!(ru_terms_added(3), "Добавлено 3 термина в глоссарий");
        assert_eq!(ru_terms_added(5), "Добавлено 5 терминов в глоссарий");
        assert_eq!(ru_terms_added(11), "Добавлено 11 терминов в глоссарий");
    }

    #[test]
    fn ru_glossary_summary_reflects_merges() {
        assert_eq!(ru_glossary_summary(1, 0), "Добавлен 1 термин в глоссарий");
        assert_eq!(ru_glossary_summary(0, 1), "Дополнён 1 термин в глоссарии");
        assert_eq!(ru_glossary_summary(0, 2), "Дополнено 2 термина в глоссарии");
        assert_eq!(ru_glossary_summary(0, 11), "Дополнено 11 терминов в глоссарии");
        assert_eq!(ru_glossary_summary(2, 1), "Добавлено 2 термина в глоссарий, дополнён 1 термин");
        assert_eq!(ru_glossary_summary(3, 5), "Добавлено 3 термина в глоссарий, дополнено 5 терминов");
    }

    // glossary.add_terms: apply via glossary::add_terms_db (same merge semantics as the
    // import path: case-insensitive canonical match, new aliases MERGED into the existing
    // row, nothing-new dupes skipped) → chat_tool_call row → undo restores the FULL
    // pre-action state (added rows deleted, merged rows' alias lists restored exactly);
    // a second undo is an idempotent no-op.
    #[tokio::test]
    async fn glossary_action_apply_and_undo_roundtrip() {
        let pool = test_pool().await;
        let (cycle_id, pid) = seed_cycle_with_product(&pool).await;
        let (thread_id, message_id) = seed_thread_message(&pool, &cycle_id).await;
        assert_eq!(glossary_count(&pool, &pid).await, 1, "seeded Jira");
        assert_eq!(term_aliases(&pool, &pid, "Jira").await, vec!["джира".to_string()]);

        // API → added; jira → merged into the seeded Jira (new alias «жира»); JIRA → dup
        // contributing nothing new → skipped.
        let raw = r#"{"action":"glossary.add_terms","terms":[{"canonical":"API","aliases":["апи"]},{"canonical":"jira","aliases":["жира"]},{"canonical":"JIRA","aliases":["джира"]}]}"#;
        let rows = process_action_blocks(&pool, &thread_id, &cycle_id, &message_id, &[raw.to_string()]).await;
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.status, "applied");
        assert_eq!(row.tool, "glossary.add_terms");
        assert_eq!(row.kind, "write");
        assert!(row.undo_token.is_some());
        assert_eq!(
            tool_call_summary(row),
            "Добавлен 1 термин в глоссарий, дополнён 1 термин",
            "summary reflects added + merged"
        );
        let result: Value = serde_json::from_str(row.result_json.as_deref().unwrap()).unwrap();
        assert_eq!(result["added"], 1);
        assert_eq!(result["merged"], 1);
        assert_eq!(result["skipped"], 1);
        assert_eq!(glossary_count(&pool, &pid).await, 2, "API added; jira merged, never a second row");
        assert_eq!(
            term_aliases(&pool, &pid, "Jira").await,
            vec!["джира".to_string(), "жира".to_string()],
            "merge kept the existing alias order and appended the new alias"
        );

        // The row is listable for the thread (chips on reload).
        let listed = list_tool_calls_db(&pool, &thread_id).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, row.id);

        // Undo: the added term is deleted AND the merged term's alias list is restored
        // exactly to its pre-action value; status flips to undone.
        let undone = undo_chat_action_db(&pool, &row.id).await.unwrap();
        assert_eq!(undone.status, "undone");
        assert!(undone.undone_at.is_some());
        assert_eq!(glossary_count(&pool, &pid).await, 1, "only seeded Jira remains");
        assert_eq!(
            term_aliases(&pool, &pid, "Jira").await,
            vec!["джира".to_string()],
            "undo restored the pre-action alias list exactly"
        );

        // Idempotent: a second undo returns the row unchanged, deletes/restores nothing.
        let again = undo_chat_action_db(&pool, &row.id).await.unwrap();
        assert_eq!(again.status, "undone");
        assert_eq!(glossary_count(&pool, &pid).await, 1);
        assert_eq!(term_aliases(&pool, &pid, "Jira").await, vec!["джира".to_string()]);
    }

    // Undo stays tolerant of the PRE-MERGE (v1) undo_token shape ({term_ids} only): those
    // actions only ever inserted rows, so their ids are treated as added ids and deleted.
    #[tokio::test]
    async fn undo_tolerates_v1_term_ids_token() {
        let pool = test_pool().await;
        let (cycle_id, pid) = seed_cycle_with_product(&pool).await;
        let (thread_id, message_id) = seed_thread_message(&pool, &cycle_id).await;

        let ts = now_ms();
        let term_id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO glossary_term (id, product_id, canonical, aliases_json, notes, created_at, updated_at) VALUES (?, ?, 'API', '[]', '', ?, ?)")
            .bind(&term_id).bind(&pid).bind(ts).bind(ts).execute(&pool).await.unwrap();
        let outcome = ActionOutcome::applied(
            ru_terms_added(1),
            json!({ "added": 1, "skipped": 0, "term_ids": [term_id.clone()] }),
            json!({ "kind": "glossary.add_terms", "term_ids": [term_id] }),
        );
        let row = insert_tool_call_db(&pool, &message_id, &thread_id, "glossary.add_terms", "{}", &outcome)
            .await
            .unwrap();

        let undone = undo_chat_action_db(&pool, &row.id).await.unwrap();
        assert_eq!(undone.status, "undone");
        assert_eq!(glossary_count(&pool, &pid).await, 1, "v1 term_ids deleted; seeded Jira remains");
    }

    // synthesis.update_finding: edits ONE finding in findings_json, preserves unknown fields
    // (Value-level edit), never touches content_md; undo restores the previous values.
    #[tokio::test]
    async fn update_finding_action_apply_and_undo_roundtrip() {
        let pool = test_pool().await;
        let cycle_id = seed_cycle(&pool).await;
        let (thread_id, message_id) = seed_thread_message(&pool, &cycle_id).await;
        let synthesis_id = Uuid::new_v4().to_string();
        let findings = r#"{"goals":[],"findings":[{"id":"F1","goal_id":"G1","statement":"old statement","confidence":"low","support_count":1,"evidence":[]}],"custom_field":"keep-me"}"#;
        sqlx::query("INSERT INTO synthesis (id, cycle_id, interview_id, findings_json, content_md, created_at) VALUES (?, ?, NULL, ?, '# Report md', ?)")
            .bind(&synthesis_id).bind(&cycle_id).bind(findings).bind(now_ms())
            .execute(&pool).await.unwrap();

        let raw = r#"{"action":"synthesis.update_finding","goal_id":"G1","finding_id":"F1","statement":"new statement","confidence":"high"}"#;
        let rows = process_action_blocks(&pool, &thread_id, &cycle_id, &message_id, &[raw.to_string()]).await;
        assert_eq!(rows[0].status, "applied");
        assert_eq!(tool_call_summary(&rows[0]), "Обновлён вывод F1");

        let (fj, md): (String, String) =
            sqlx::query_as("SELECT findings_json, content_md FROM synthesis WHERE id = ?")
                .bind(&synthesis_id).fetch_one(&pool).await.unwrap();
        let doc: Value = serde_json::from_str(&fj).unwrap();
        assert_eq!(doc["findings"][0]["statement"], "new statement");
        assert_eq!(doc["findings"][0]["confidence"], "high");
        assert_eq!(doc["custom_field"], "keep-me", "unknown fields preserved (Value-level edit)");
        assert_eq!(md, "# Report md", "content_md untouched");

        // Undo restores the previous statement + confidence.
        let undone = undo_chat_action_db(&pool, &rows[0].id).await.unwrap();
        assert_eq!(undone.status, "undone");
        let fj2: String = sqlx::query_scalar("SELECT findings_json FROM synthesis WHERE id = ?")
            .bind(&synthesis_id).fetch_one(&pool).await.unwrap();
        let doc2: Value = serde_json::from_str(&fj2).unwrap();
        assert_eq!(doc2["findings"][0]["statement"], "old statement");
        assert_eq!(doc2["findings"][0]["confidence"], "low");
        assert_eq!(doc2["custom_field"], "keep-me");
    }

    // Bad ids fail EXECUTION (recorded as failed, DB untouched); malformed payloads are
    // recorded as rejected and never executed; a rejected/failed row cannot be undone.
    #[tokio::test]
    async fn invalid_actions_recorded_never_executed() {
        let pool = test_pool().await;
        let (cycle_id, pid) = seed_cycle_with_product(&pool).await;
        let (thread_id, message_id) = seed_thread_message(&pool, &cycle_id).await;

        // Unknown finding id → failed (no synthesis at all here).
        let raw_missing = r#"{"action":"synthesis.update_finding","goal_id":"G1","finding_id":"F9","statement":"x"}"#;
        // Malformed JSON → rejected.
        let raw_bad = "{definitely not json".to_string();
        // Unknown action → rejected.
        let raw_unknown = r#"{"action":"interview.delete","interview_id":"iv1"}"#;

        let rows = process_action_blocks(
            &pool, &thread_id, &cycle_id, &message_id,
            &[raw_missing.to_string(), raw_bad, raw_unknown.to_string()],
        )
        .await;
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].status, "failed", "valid shape but no synthesis to edit");
        // Blocks after the first are rejected regardless ("at most one per reply").
        assert_eq!(rows[1].status, "rejected");
        assert_eq!(rows[2].status, "rejected");
        assert_eq!(rows[2].tool, "interview.delete", "tool name recorded for the audit log");
        assert_eq!(glossary_count(&pool, &pid).await, 1, "nothing executed");

        // Rejected/failed rows cannot be undone (nothing was applied).
        assert!(undo_chat_action_db(&pool, &rows[0].id).await.is_err());
        assert!(undo_chat_action_db(&pool, &rows[1].id).await.is_err());
    }

    // Only the FIRST block executes; extras are recorded as rejected.
    #[tokio::test]
    async fn second_action_block_rejected() {
        let pool = test_pool().await;
        let (cycle_id, pid) = seed_cycle_with_product(&pool).await;
        let (thread_id, message_id) = seed_thread_message(&pool, &cycle_id).await;

        let b1 = r#"{"action":"glossary.add_terms","terms":[{"canonical":"API"}]}"#.to_string();
        let b2 = r#"{"action":"glossary.add_terms","terms":[{"canonical":"MVP"}]}"#.to_string();
        let rows = process_action_blocks(&pool, &thread_id, &cycle_id, &message_id, &[b1, b2]).await;
        assert_eq!(rows[0].status, "applied");
        assert_eq!(rows[1].status, "rejected");
        assert_eq!(glossary_count(&pool, &pid).await, 2, "only API landed (plus seeded Jira)");
    }

    // Cycle without a linked product: glossary action fails cleanly (no partial writes).
    #[tokio::test]
    async fn glossary_action_without_product_fails() {
        let pool = test_pool().await;
        let cycle_id = seed_cycle(&pool).await; // no product linked
        let (thread_id, message_id) = seed_thread_message(&pool, &cycle_id).await;
        let raw = r#"{"action":"glossary.add_terms","terms":[{"canonical":"API"}]}"#;
        let rows = process_action_blocks(&pool, &thread_id, &cycle_id, &message_id, &[raw.to_string()]).await;
        assert_eq!(rows[0].status, "failed");
        assert!(rows[0].error.as_deref().unwrap_or("").contains("no linked product"));
    }

    // The context pack now carries the action rules so the model knows the format.
    #[tokio::test]
    async fn build_context_includes_action_rules() {
        let pool = test_pool().await;
        let cycle_id = seed_cycle(&pool).await;
        let pack = build_context(&pool, &cycle_id).await.unwrap();
        assert!(pack.contains("invlab-action"), "action block format documented");
        assert!(pack.contains("glossary.add_terms"), "whitelist documented");
        assert!(pack.contains("synthesis.update_finding"), "whitelist documented");
    }

    // REAL streaming round-trip against the installed, logged-in `claude` CLI. Ignored by
    // default (consumes a little subscription usage). Run with:
    //   cargo test -- --ignored real_chat_stream_round_trip
    // Confirms: tokens stream in (≥2 token lines), a final result carries a session_id, and
    // a --resume follow-up answers a question needing turn-1 context. Mirrors run_turn's
    // spawn + parse loop without the Tauri AppHandle (which a unit test can't construct).
    #[tokio::test]
    #[ignore]
    async fn real_chat_stream_round_trip() {
        use tokio::io::AsyncBufReadExt;
        let adapter = crate::adapter::builtin_adapter_pub();

        // A grounded context pack (tiny) written to a temp file.
        let pack = "You are a test assistant. The user's favorite color is teal. Answer concisely.";
        let pack_path = std::env::temp_dir().join("ilab-chat-livetest.md");
        tokio::fs::write(&pack_path, pack).await.unwrap();
        let pack_str = pack_path.to_string_lossy().to_string();

        // Turn 1.
        async fn one_turn(adapter: &crate::adapter::Adapter, pack: &str, prompt: &str, resume: Option<&str>) -> (usize, Option<String>, String) {
            let args = render_chat_args(adapter, prompt, pack, resume).unwrap();
            let mut cmd = Command::new(&adapter.command);
            cmd.args(&args).current_dir(neutral_cwd()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut child = cmd.spawn().expect("spawn claude");
            let stdout = child.stdout.take().unwrap();
            let mut lines = BufReader::new(stdout).lines();
            let mut tokens = 0usize;
            let mut session = None;
            let mut full = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() { continue; }
                let p = parse_stream_line(&line);
                if let Some(t) = &p.text { if !p.is_done { tokens += 1; } full.push_str(t); }
                if p.is_done { session = p.session_id.clone(); if !full_has_text(&full) { if let Some(t) = p.text { full.push_str(&t); } } }
            }
            let _ = child.wait().await;
            (tokens, session, full)
        }
        fn full_has_text(s: &str) -> bool { !s.trim().is_empty() }

        let (tokens, session, answer1) = one_turn(&adapter, &pack_str, "Say a one-sentence greeting.", None).await;
        eprintln!("turn1 tokens={tokens} session={session:?} answer={answer1}");
        assert!(tokens >= 2, "expected ≥2 streamed token events, got {tokens}");
        assert!(session.is_some(), "expected a session_id from the result event");
        assert!(!answer1.trim().is_empty(), "expected a non-empty answer");

        // Turn 2: resume — ask something that needs turn-1/context memory.
        let (_t2, _s2, answer2) =
            one_turn(&adapter, &pack_str, "What is my favorite color? One word.", session.as_deref()).await;
        eprintln!("turn2 answer={answer2}");
        assert!(answer2.to_lowercase().contains("teal"), "resume should recall context: {answer2}");

        let _ = tokio::fs::remove_file(&pack_path).await;
    }
}
