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
// (--tools "" disables built-ins; we pass no --mcp-config, so no MCP). Tool-use is
// Phase B/C. // ponytail: chat_tool_call table exists (migration 0004) but is untouched here.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
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
         FROM chat_message WHERE thread_id = ? ORDER BY created_at, id",
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
const CITATION_PREAMBLE: &str = r#"You are InterviewLab's cycle assistant. Answer questions about THIS user-research cycle, grounded ONLY in the cycle data provided below. Be concise and concrete. If the data doesn't cover something, say so plainly — never invent findings, quotes, or numbers.

Cite every claim inline using these exact tokens (the app turns them into clickable chips):
- [[finding:F1]] — when a claim comes from a synthesis finding (use its id, e.g. F1, F2).
- [[interview:<interview_id>]] — when referring to a whole interview.
- [[iv:<interview_id> seg:<n>]] — when quoting/paraphrasing a transcript segment.
Put the token right after the sentence it supports. Prefer finding citations; they are the most reliable. Do not output the tokens in a code block.

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

    // Cycle name + product description.
    let cycle: Option<(String, String)> =
        sqlx::query_as("SELECT name, product_desc FROM cycle WHERE id = ?")
            .bind(cycle_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let (cycle_name, product_desc) = cycle.ok_or_else(|| "cycle not found".to_string())?;
    out.push_str(&format!("\n# Cycle: {cycle_name}\n"));
    if !product_desc.trim().is_empty() {
        out.push_str(&format!("\n## Product\n{}\n", product_desc.trim()));
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

// The core streaming turn: spawn the plugin's chat command, line-stream stdout, emit
// token/done/error on chat://<thread_id>, persist the assistant message + thread session_id.
// Runs on a spawned task so cycle_chat_send returns immediately and the UI streams live.
async fn run_turn(
    app: tauri::AppHandle,
    pool: SqlitePool,
    adapter: crate::adapter::Adapter,
    thread_id: String,
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
        .stderr(Stdio::piped());
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

    if let Some(stdout) = stdout {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
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
                Ok(None) => break, // EOF
                Err(_) => break,
            }
        }
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

    // Persist the completed assistant message + parse citations from the inline tokens.
    let citations = parse_citations(&full);
    let msg = match append_message_db(
        &pool,
        &thread_id,
        "assistant",
        &full,
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
        run_turn(app2, pool, adapter, thread_id, text, context_pack, resume).await;
    });
    Ok(())
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

    // Citation parser: extracts the three token shapes, ignores malformed ones.
    #[test]
    fn parse_citations_extracts_tokens() {
        let content = "Stalls at connect [[finding:F1]] per [[interview:iv9]] and [[iv:iv9 seg:3]]. Junk [[bogus:x]].";
        let json: Value = serde_json::from_str(&parse_citations(content)).unwrap();
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0]["kind"], "finding");
        assert_eq!(arr[0]["finding_id"], "F1");
        assert_eq!(arr[1]["kind"], "interview");
        assert_eq!(arr[2]["kind"], "segment");
        assert_eq!(arr[2]["segment_id"], 3);
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
