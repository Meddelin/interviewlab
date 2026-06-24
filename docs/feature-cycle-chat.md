# Feature spec: Agentic, context-aware cycle assistant ("Cycle Chat")

> A chat panel on a cycle where the researcher works with an **agentic, context-aware**
> AI assistant. It does two things: (1) **answers** questions grounded in **this cycle's**
> research data with **citations** ("what did designers say about onboarding?", "which
> interviews mention pricing?", "summarize objections", "what changed vs last wave?"); and
> (2) **takes actions** in the context of whatever cycle view is open — fix a transcript
> segment, reassign a speaker role, tighten a synthesis finding, edit a guide, re-run
> synthesis — by calling the app's **existing validated mutations**. It is invokable from
> **anywhere in the cycle UI** and **knows the current view + open entity**, so "fix this
> segment" / "tighten this finding" act on exactly what's on screen.
>
> Built **within** the existing architecture (product-spec §5–§7): AI runs through the
> local **Claude Code CLI** via the M6 adapter, **subscription auth** (`claude login`,
> non-`--bare`), isolation flags. This feature is an **extension of `adapter.rs`** from a
> single-shot runner to a **streaming, multi-turn, tool-using** runner — and reuses Claude
> Code's **native tool-use / MCP** as the agent engine rather than building one.
>
> **Plugin-first (see `feature-cli-plugins.md`):** Claude Code is now the **reference plugin**,
> not a hardcode. The streaming/tool runner described here is driven through the **pluggable
> CLI-adapter layer** — it targets the *active chat plugin's* declared capabilities
> (`streaming`/`multi-turn`/`tool-use`) via a manifest, and the `inv` MCP tool server (§4.3) is
> the **plugin-independent, portable tool layer** any MCP-capable CLI consumes. Read this doc as
> "the Claude Code plugin's behavior"; the generalized architecture (manifest, two integration
> tiers, the stdio adapter-program protocol, graceful degradation, the agent-facing onboarding
> doc) lives in **`feature-cli-plugins.md`**, which is authoritative where they differ.
>
> **Reuse-first stance:** the agent loop is Claude Code's; the tools are a thin **MCP server
> that wraps the app's already-validated Tauri/DB mutations** (so all server-side invariants
> — transcript timing-immutability, schema validation, the role library — still hold); the
> chat UI is assistant-ui + Streamdown. Minimal new moving parts.
>
> Status: design doc for an AI dev agent. Date: 2026-06-23. Targets the codebase at
> `interviewlab/` (Tauri 2 + React 19 + shadcn + Tailwind v4, SQLite via `sqlx`).
> Lands **after M10** (synthesis artifacts); needs migration `0004`.

---

## 1. Feature summary & scope

### What it is
An **agentic, context-aware assistant** docked as a **slide-out side panel** on the cycle
detail, invokable from **anywhere** in the cycle UI (Overview / Interviews / Synthesis /
Diff) and aware of the **current view + open entity**. It does two jobs:

1. **Answers** — grounded, streaming markdown about **this cycle's** data, with **citations**
   back to the interview / segment / finding it used.
2. **Acts** — takes actions / makes edits **in the context of the open view**, by calling
   the app's **existing validated mutations** through a scoped **tool surface** (§6). "Fix
   this segment", "reassign the speaker", "tighten this finding", "edit the guide",
   "re-run synthesis" operate on what's on screen.

Conversations **persist** as threads per cycle; tool-calls/edits are recorded in the thread
for **audit + undo**.

### In scope
- A **slide-out Chat side panel** on the cycle (docked, resizable, collapsible), Linear-styled,
  shadcn-only; toggled from **anywhere in the cycle UI** (header button + Cmd+K + ⌘/Ctrl+J).
- **Context-awareness:** the panel injects the **current route + open entity ids** (cycle /
  interview+transcript / synthesis / guide / diff) into every turn, and **pre-scopes tool args**
  to that context (§6.3).
- **Multi-turn** Q&A + **agentic edits**, with **streaming** token-by-token output and
  **inline tool-call states** (▸running / ✓done / ✕failed).
- **Agentic tool surface (§6):** read tools (get/search transcripts, get synthesis/findings,
  get guide) **and** mutation tools mapping to existing Tauri/DB commands (update segment text,
  set speaker role, save synthesis section, update guide, re-run synthesis, …). **All mutations
  go through the SAME validated paths** — invariants enforced server-side.
- **Safety model:** **auto-apply with visible Undo + an edits/activity log**; **confirm-first**
  for destructive/broad changes (§6.4).
- **Markdown + code rendering**, **stop** (cancels the in-flight agentic turn mid-tool-loop),
  and **regenerate last answer**.
- **Citations**: answers reference interviews / segments / findings; clicking a citation
  navigates to that interview's editor (or the synthesis finding).
- **Context grounding** = a system prompt carrying the cycle's compact artifacts
  (synthesis markdown + per-interview summaries + guide/goals + diff summary), with the
  agent pulling full transcript segments **via a read tool** when a question needs them.
- **Threads + messages + tool-calls persisted per cycle** (multiple threads, rename, delete).
- Reuses the **existing Claude Code adapter + subscription auth + isolation flags**, plus
  Claude Code's **native tool-use / MCP** (`--mcp-config` + `--strict-mcp-config`) as the
  agent engine — no bespoke agent loop.

### Out of scope (explicitly deferred)
- **Cross-cycle chat** (chatting over many cycles at once). One cycle per thread; tools are
  scoped to the open cycle.
- **RAG / embeddings / vector DB.** The lazy grounding strategy (§5) + a `search_transcripts`
  tool avoid it; flagged as a scale-up option, not built.
- **Message editing of prior user turns** (assistant-ui supports it; we wire regenerate + stop
  to keep the surface small — edit is a one-line capability add later).
- **Voice / attachments / image input.**
- **Light theme polish** (dark-first per design-direction.md; chat inherits the theme).
- **Arbitrary file/Bash tools.** The agent gets **only** our MCP tool surface (built-in tools
  disabled via `--tools ""`); it cannot touch the filesystem or shell.

---

## 2. Where it lives in the UI

A **slide-out side panel** (NOT a tab, NOT a separate window): a docked, **resizable**,
**collapsible** panel that slides in from the **right** of the cycle detail page and stays
open **across** the cycle's Overview / Interviews / Synthesis / Diff views — so the researcher
works alongside the data while the agent acts on it. **Invokable from anywhere in the cycle
UI**: a button in the cycle header **and** a Cmd+K action ("Chat about this cycle") **and** a
keyboard shortcut (e.g. ⌘/Ctrl+J) — all three open the **same** panel against whatever view is
currently open. Open/closed + width **persist per cycle**. Reuse **`react-resizable-panels`**
(already in the stack from the M5 editor) to dock + resize it against the main content; shadcn
**Sheet** is the lazy fallback if a docked split is overkill. Component:
`src/components/cycle-chat-panel.tsx`, mounted in `cycle-detail.tsx`'s layout (outside the Tabs)
so it persists as the user switches views.

**Context strip:** a quiet one-line header in the panel shows what the agent is currently
acting on — e.g. `Interview 3 · transcript` / `Synthesis` / `Guide` — derived from the live
route + open entity (§6.3). It updates as the user navigates, and clicking it is a no-op (it's
a status indicator, not a control). This makes "fix this segment" unambiguous: the user can see
the scope the agent will act in.

Layout inside the panel (narrow — Linear discipline, design-direction.md):
- A **thread switcher at the top** (a quiet Select/menu of this cycle's threads, newest first,
  title auto-derived from the first question; "New chat" is a quiet button **and** a Cmd+K
  action) — a top switcher rather than a side rail, since the panel is narrow.
- The **conversation** fills the panel: message list (user quiet/right, assistant full-width
  markdown via Streamdown), a sticky **composer** at the bottom (Textarea that grows, Enter to
  send, Shift+Enter newline, a Stop button while streaming).
- **Empty state**: one calm line + 3–4 **suggested starter questions** as clickable chips
  ("Summarize the top objections", "What did designers say about onboarding?", "What changed
  vs the previous wave?"). Grounds the feature concretely, mirrors the synthesis-tab empty
  state.
- **Citations** render inline as small superscript chips `[iv3 · seg 12]` / `[F2]`; a
  citation list under the answer is the affordance — clicking routes via React Router to
  `/cycles/:id/interviews/:iv` (existing route) or scrolls the Synthesis tab to the finding.
- Streaming: tokens append live; a thin accent caret/shimmer while generating (skeleton, not
  spinner, per design rules). Stop button is always reachable mid-stream.

Styling reuses the existing tokens (`--accent` indigo, status dots, mono numerals for
timestamps/ids, hairline borders) already established in `synthesis-tab.tsx` /
`design-direction.md`.

---

## 3. Chosen reusable chat UI kit

### Decision: **assistant-ui** (`@assistant-ui/react`) with its `useExternalStoreRuntime`.

**License:** MIT. **Maturity (2026):** ~10.7k★, actively maintained (releases through
mid-2026; now multi-platform web/mobile/terminal). Tailwind-based, shadcn-friendly
(primitives you style yourself; an official shadcn-registry path exists).
([repo](https://github.com/assistant-ui/assistant-ui),
[ExternalStoreRuntime docs](https://www.assistant-ui.com/docs/runtimes/custom/external-store))

**Why it wins for our model (the decisive criterion — custom non-HTTP backend):**
Our backend is **not** an HTTP `/api/chat` route — it's a **Tauri command that streams
tokens via Tauri events** from the local `claude` CLI. assistant-ui's
**`useExternalStoreRuntime`** is purpose-built for exactly this: *you* own the messages
array (in our case Zustand/React state fed by Tauri events), and you provide handlers:

| handler | we wire it to | enables |
|---|---|---|
| `messages` | our React state (mirrors the DB thread) | the rendered conversation |
| `convertMessage` | map our `{role, content, citations}` → `ThreadMessageLike` | custom message shape |
| `onNew` (required) | `invoke('cycle_chat_send', …)` + subscribe to stream events | send a turn |
| `onCancel` | `invoke('cycle_chat_cancel', …)` | **Stop** |
| `onReload` | drop last assistant msg, re-`onNew` the prior user msg | **Regenerate** |
| `isRunning` | true while a turn streams | the streaming UI / disabled composer |

UI features are **capability-based**: provide a handler → that button appears. We wire
`onNew` + `onCancel` + `onReload` (send / stop / regenerate) and **omit** `onEdit`
(message editing) and `setMessages` (branching) — they're a later one-line add.
([ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store))

Streaming markdown + code highlighting, message list virtualization, auto-scroll, composer,
and stop are all provided components — we don't build a chat engine.

**Tool-call UIs (needed for the agentic surface).** assistant-ui renders **tool calls** as
first-class message parts: you register a UI per tool name (`makeAssistantToolUI` /
`AssistantToolUI`) and it shows the call, its args, a running/done/error state, and the result
inline in the thread. We map each of our MCP tools (§6.2) to a compact tool-call card
("Updated segment 12 · ✓", "Re-running synthesis…") with an **Undo** affordance on mutations.
Because we own the messages array via `useExternalStoreRuntime`, we drive these states directly
from the parsed `stream-json` tool events (§4.3) — no AI-SDK runtime needed.
([tool UIs](https://www.assistant-ui.com/docs/guides/ToolUI))

**Integration effort against our Tauri-streaming-from-CLI model:** **Low–moderate.** We
write one `convertMessage` adapter and four small handlers; the streaming loop is "on each
token event, append to the in-flight assistant message in state → assistant-ui re-renders."
No HTTP server, no SSE endpoint, no Vercel AI SDK runtime needed. This is the only kit whose
**primary documented custom-runtime path is app-controlled state**, not an HTTP transport.

### Alternatives considered (and why not)
- **Vercel AI SDK UI (`@ai-sdk/react` `useChat`)** — MIT, very mature, *the* default. It now
  exposes a **`DirectChatTransport`** (call an agent's `stream()` in-process, no HTTP) and a
  custom-`ChatTransport` interface. But its transport contract is built around an
  **SSE/stream protocol** and the AI-SDK `Agent`/message-part model; to feed it raw tokens
  from a Tauri event we'd implement a custom `ChatTransport` that bridges events→an SSE-shaped
  `ReadableStream`. Workable, but **more glue** than assistant-ui's "you hold the array"
  store, and it pulls the AI-SDK core in for a protocol we don't otherwise use. Good fallback
  if we later want AI-SDK's tool-call plumbing.
  ([AI SDK transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport),
  [DirectChatTransport](https://ai-sdk.dev/docs/reference/ai-sdk-ui/direct-chat-transport))
- **shadcn-chatbot-kit (Blazity)** — MIT, ~0.8k★, beautiful shadcn-native **components**
  (MessageList, ChatMessage, MarkdownRenderer, PromptInput) copied in via the shadcn CLI. But
  it's **presentational** — its quick-start assumes Vercel AI SDK `useChat` for state/streaming;
  it gives us pretty bubbles, not a runtime. **We still mine it**: if assistant-ui's default
  primitives don't hit the Linear bar, copy shadcn-chatbot-kit's `MarkdownRenderer` /
  `ChatMessage` styling on top of assistant-ui's runtime. ([repo](https://github.com/Blazity/shadcn-chatbot-kit))
- **prompt-kit / AI Elements** — minimal shadcn primitives / AI-SDK-first element set; same
  "components, not runtime" gap. Mine for styling only.
- **llm-ui** — streaming-markdown/code renderer; redundant once assistant-ui renders markdown.

> Net: **assistant-ui for the runtime + components**; keep shadcn-chatbot-kit as a **styling
> donor** to reach the Linear bar. One new dependency family (`@assistant-ui/react`,
> MIT) + its markdown renderer.

### Markdown rendering of the streamed reply: **Streamdown** (Vercel)
Render the assistant message body with **Streamdown** (`streamdown`, Vercel — MIT; ships via the AI-Elements / shadcn registry) instead of assistant-ui's default `@assistant-ui/react-markdown`. Streamdown is purpose-built for **token-by-token streaming**: it safely renders **incomplete/unterminated markdown mid-stream** (open code fences, half-written lists/tables/links don't flash broken), with GFM, code highlighting and Tailwind styling that suits the dark Linear bar. Slot it as the message-content / `MarkdownText` component inside assistant-ui's `<Thread/>` (assistant-ui lets you swap the markdown renderer) — so we keep assistant-ui's runtime + thread primitives AND get Streamdown's stream-safe rendering. (User-requested; replaces llm-ui / the default react-markdown renderer for the assistant turn.)

---

## 4. Architecture

### 4.1 Text flow diagram

```
 React (cycle-chat-panel.tsx)
   assistant-ui <Thread/> driven by useExternalStoreRuntime
   messages = Zustand state (mirrors DB thread) + tool-call parts (assistant-ui Tool UIs)
        │  onNew(userMsg):
        │    1. persist user msg (invoke 'cycle_chat_append')
        │    2. invoke('cycle_chat_send', { threadId, cycleId, text, viewContext })
        │         viewContext = { route, cycleId, interviewId?, transcriptId?, findingId?, guideId?, diffId? }
        │    3. listen Tauri events: chat://<threadId>
        │         { token | tool_call | tool_result | citation | done | error }
        │  onCancel → invoke('cycle_chat_cancel', { threadId })    (kills mid-tool-loop)
        ▼
 ┌──────────────────────────── Tauri Rust core ──────────────────────────────────────────┐
 │  chat.rs  (NEW — sibling of adapter.rs / synthesis.rs)                                 │
 │    cycle_chat_send(thread_id, cycle_id, text, view_context):                          │
 │      ├─ build_context(cycle_id)  ← synthesis.md + per-iv summaries + guide/goals +    │
 │      │     diff summary + interview index  (compact; cached per cycle, §5)            │
 │      ├─ render view_context into the appended prompt (the "you are looking at X")      │
 │      ├─ write mcp_config.json (points at OUR server; §4.3) to a temp path             │
 │      ├─ compute --allowedTools for THIS turn from view_context (pre-scope, §6.3)       │
 │      ├─ load prior turns / session_id for thread_id (multi-turn)                      │
 │      └─ adapter::stream_agent_turn(...)  ◄── NEW streaming, tool-using runner          │
 │             tokio::process::Command spawn `claude`                                     │
 │               -p "<user text>"                                                         │
 │               --output-format stream-json --verbose --include-partial-messages         │
 │               --append-system-prompt-file <pack+context+citation+tool rules>           │
 │               --mcp-config <mcp_config.json> --strict-mcp-config   ◄── TOOL CHANNEL     │
 │               --permission-mode dontAsk                            (only allowed tools) │
 │               --allowedTools "mcp__inv__get_transcript mcp__inv__update_segment …"      │
 │               --tools ""                          (NO built-in Bash/Edit/file tools)   │
 │               --max-turns N --max-budget-usd M    (bound the agentic loop)             │
 │               --resume <session_id>               (after turn 1; else --session-id)    │
 │               --setting-sources ""                (isolation; no --bare → subscription)│
 │             stream stdout (ndjson) → parse text deltas + tool_use + tool_result →      │
 │               app.emit("chat://<thread_id>", ChatEvent::{Token|ToolCall|ToolResult})   │
 │             on final result line → capture session_id + cost → persist; emit Done      │
 │             cancel = child.start_kill() on a stored Child per thread                   │
 │                                                                                        │
 │  ┌─────────── MCP tool server (NEW; §4.3) — in-process or thin sidecar ───────────┐   │
 │  │  Exposes app actions as MCP tools over stdio. Each tool handler calls the SAME  │   │
 │  │  validated command/DB path the UI uses (transcript timing-immutability, schema  │   │
 │  │  validation, role library all enforced here). Reads the SAME SQLite DB.         │   │
 │  │   read:  get_transcript · search_transcripts · get_synthesis · get_guide        │   │
 │  │   write: update_segment_text · set_speaker_role · save_synthesis_section ·      │   │
 │  │          update_guide · rerun_synthesis   →  emit a record for the edits log     │   │
 │  └──────────────────────────────────────────────────────────────────────────────┘   │
 └──────────────────────────────────────────────────────────────────────────────────────┘
        │
   local CLI (Claude Code)  — subscription auth (claude login), tool-use loop, one turn/thread
```

### 4.2 Claude Code as a streaming, multi-turn, **tool-using** backend (verified, 2026)

All flags below are confirmed in the current CLI reference
([CLI reference](https://code.claude.com/docs/en/cli-reference),
[headless](https://code.claude.com/docs/en/headless),
[permission modes](https://code.claude.com/docs/en/permission-modes),
[MCP](https://code.claude.com/docs/en/mcp)):

- **Token streaming:** `--output-format stream-json` emits newline-delimited JSON events as
  they happen. To get **token-level deltas** you need three flags together:
  `-p --output-format stream-json --verbose --include-partial-messages`. `stream-json`
  **requires `--verbose`**; `--include-partial-messages` requires `--print` +
  `stream-json`. Each line is one event; in a tool-using turn the stream interleaves
  assistant text deltas, **`tool_use` blocks**, and **`tool_result`** blocks across multiple
  agentic turns, ending in a final `result` event (§4.3 details the shapes).
- **Multi-turn via session resume:** capture the `session_id` from the first turn's final
  `result` event, store it on the thread, and on subsequent turns pass
  **`--resume <session_id>`** (alias `-r`). `--session-id <uuid>` can pin a known UUID up
  front (must be a valid UUID — generate one per thread). One `-p` invocation per user turn,
  resumed by id, matches the existing one-shot adapter model.
  - Note: `--resume` searches sessions in the **current project dir**; we run with a fixed
    neutral cwd (as the existing adapter does). If resume-by-id proves flaky, fall back to
    **replaying prior turns in the prompt** (we store every turn) — robust plan B, no session
    state. (Tool-calls are server-side history; the replay fallback re-states them as text.)
- **Grounding + context via system prompt:** inject the cycle context **and the current-view
  context** with **`--append-system-prompt-file <path>`** (write to a temp file; sidesteps
  arg-length limits and the 10 MB stdin cap) — preferred over `--system-prompt` (full replace)
  so default safety/tool guidance is kept. The file carries: the cycle context pack (§5.1) +
  the **view context** ("the user is currently looking at interview 3's transcript; segment ids
  in scope: …") + citation rules (§5.4) + tool-use rules (§6.4: when to confirm, cite after
  edits). The **user's question** is the `-p` prompt text. On turn 1 the session captures it;
  resumed turns re-append **only when the cycle data or the view context changed** (§6.3, §9).
- **The tool channel (the agentic core) — `--mcp-config` + `--strict-mcp-config`:** point
  Claude Code at **our** MCP server with `--mcp-config <file>`, and pass **`--strict-mcp-config`**
  so **only** that server loads (the user's global `.mcp.json` / project servers are ignored —
  the agent is isolated to our tool surface). Tools are then callable as
  **`mcp__<server>__<tool>`** (Claude Code's standard convention, e.g. `mcp__inv__get_transcript`).
  See §4.3 / §6.
- **Tool permissions in headless mode — `--permission-mode dontAsk` + `--allowedTools`:** in
  `-p` mode there is no human to answer a permission prompt, so the permission model **is** the
  flags. We run **`--permission-mode dontAsk`** (auto-**denies** anything not pre-approved,
  fully non-interactive) and pass the exact tools allowed for this turn via
  **`--allowedTools "mcp__inv__get_transcript mcp__inv__update_segment …"`** (permission-rule
  syntax). This is how we **pre-scope** the surface per view (§6.3): only the tools relevant to
  the open entity are allow-listed; everything else is denied, so a stray call simply fails
  rather than escaping scope. (For **confirm-first** on destructive tools we additionally use
  **`--permission-prompt-tool`** — §6.4.)
- **Lock out everything else:** **`--tools ""`** disables **all built-in** tools (Bash, Edit,
  Read, file I/O) — the `--tools` flag affects built-ins only; combined with
  `--strict-mcp-config` (no foreign MCP) the agent can do **nothing but call our tools**. No
  filesystem, no shell, no network beyond the model call.
- **Bound the agentic loop:** **`--max-turns N`** caps the number of agentic turns (errors out
  if exceeded) and **`--max-budget-usd M`** caps spend — both print-mode only. These are our
  guardrails against a runaway tool loop (§9).
- **Subscription auth (unchanged from M6):** plain `-p` uses the user's `claude login` session
  (Pro/Max), **never `--bare`** (bare mode skips OAuth/keychain and *forces* `ANTHROPIC_API_KEY`).
  All of `--mcp-config`, `--allowedTools`, `--permission-mode`, tool-use work under subscription
  auth — verified in the headless + MCP docs.
- **Rust streaming design (`chat.rs`, extends `adapter.rs` patterns):**
  - `tokio::process::Command` with the flags above; `stdout(Stdio::piped())`. Same
    `CREATE_NO_WINDOW` flag the adapter already sets on Windows.
  - Wrap stdout in a `tokio::io::BufReader` + `lines()`; for each line `serde_json::from_str`,
    match the event type (§4.3), emit the matching `ChatEvent` on `chat://<thread_id>`.
  - **Cancel/stop:** keep a `Mutex<HashMap<thread_id, Child>>`; `cycle_chat_cancel` calls
    `child.start_kill()` — this halts the agentic loop **between/within tool calls**. Any tool
    already committed stays committed (and is undoable via the edits log); the UI drops the
    in-flight assistant message.
  - **One in-flight turn per thread** (UI disables composer via `isRunning`).
  - On the final `result` event: read `session_id` + usage/cost, persist the completed
    assistant message, its tool-calls, and parsed citations; emit `ChatEvent::Done`.

This is a **direct extension of `adapter.rs`**: same spawn/isolation/auth scaffolding, but
`stream-json` line streaming + the MCP tool channel + a per-thread child handle instead of
`wait_with_output()`.

### 4.3 The MCP tool server + stream-json tool events (verified, 2026)

**Why an MCP server (vs. structured action-proposals).** Two ways to let the agent act:

- **(A) MCP server exposing the app's actions** — the agent calls tools *in the loop*, gets
  results back, and can chain ("read the segment → fix it → verify"). This is Claude Code's
  **native, reusable** agent path: we write tool handlers, Claude Code owns the loop. **Recommended.**
- **(B) Structured action-proposals (no MCP)** — the read-only agent emits a JSON block
  describing an edit; the frontend applies it via the normal mutation and shows undo. Simpler
  (no MCP server, keeps `--tools ""`/no-MCP lock), but the agent gets **no tool feedback** —
  it can't see whether the edit validated, can't read-then-write, can't iterate. It's a
  one-shot "suggest a patch", not an agent.

**Recommendation: (A) MCP server** — it's the genuine agentic path and *reuses* Claude Code's
tool loop rather than reinventing it. Keep **(B) as the fallback** if standing up an MCP server
proves heavier than expected (e.g. ship Phase B read-only with proposals, upgrade to MCP in
Phase C).

**Where the MCP server lives.** Two options, both share the **same SQLite DB and the same
validated mutation functions** the Tauri commands already call:
- **In-process Rust MCP server** spawned by `chat.rs` over stdio (preferred if a mature Rust
  MCP crate fits): the tool handlers call the *exact* command-layer functions the UI invokes,
  so invariants (timing-immutability, schema validation, role library) are enforced in one
  place. No second process, no DB-lock contention design needed beyond what `sqlx` already does.
- **Thin sidecar binary** (e.g. a tiny Rust/Node MCP server) that opens the same DB file and
  calls the same mutation crate. Slightly more moving parts; useful only if in-process MCP-over-
  stdio is awkward to host inside the Tauri process.

  Either way the **MCP config file** we write is the standard Claude Code shape:
  ```json
  { "mcpServers": { "inv": { "command": "<path-to-server>", "args": ["--db", "<db-path>"], "env": {} } } }
  ```
  loaded with `--mcp-config <file> --strict-mcp-config`; tools are then `mcp__inv__<tool>`.

**stream-json tool events we parse** (raw Claude API stream events, confirmed in the streaming
docs):
- **Text deltas:** `content_block_delta` with `delta.type == "text_delta"` → `ChatEvent::Token`.
- **Tool call:** `content_block_start` with `content_block.type == "tool_use"` carries the tool
  `name` (`mcp__inv__update_segment`) and `id`; the input streams as `content_block_delta` with
  `delta.type == "input_json_delta"` (accumulate `partial_json`); `content_block_stop` ends it.
  → emit `ChatEvent::ToolCall { id, name, input }` (the assistant-ui Tool UI shows ▸running).
- **Tool result:** comes back as a subsequent user/tool message containing a `tool_result`
  block keyed by `tool_use_id` → `ChatEvent::ToolResult { id, ok, summary }` (Tool UI flips to
  ✓done / ✕failed; on a mutation, attaches the **Undo** affordance + records the edit, §6.5).
- **Final:** the `result` event carries `session_id` and usage/cost → `ChatEvent::Done`.
  (`system/init` is first; `system/api_retry` may appear — we surface it quietly.)

Tolerant per-line parsing: skip unrecognized event types so a schema addition can't break the
stream (same discipline as the adapter's tolerant JSON extraction).

---

## 5. Context-grounding strategy (lazy first — recommended)

**Recommendation: a compact "cycle context pack" in the system prompt + on-demand retrieval
of full transcript segments via a read tool. NO embeddings/RAG.**

Rationale: a cycle is **small** (a handful to a few dozen interviews). The expensive,
already-distilled artifacts (synthesis, per-interview summaries, diff) are exactly what most
questions need, and they're tiny relative to raw transcripts. Embeddings/a vector store would
be premature infrastructure for a single-cycle, single-user, local app.

### 5.1 What's injected every thread (the context pack)
Assembled by `build_context(cycle_id)` in Rust from existing tables, in priority order:
1. **Cycle synthesis markdown artifact** (`synthesis.content_md`, cycle-level row) — the
   primary distilled source.
2. **Structured findings** (`synthesis.findings_json`: goals + goal-tagged findings with
   evidence refs) — gives the agent stable **finding ids + evidence pointers** to cite.
3. **Per-interview summaries** (`synthesis` rows where `interview_id IS NOT NULL`,
   `content_md`) — lets the agent answer "which interviews mention pricing?" without raw
   transcripts.
4. **Guide + goals** (the cycle's guide content + derived goals) — the frame.
5. **Diff summary** (`diff.diff_json` → the `summary` + per-goal change list) — powers
   "what changed vs last wave?".
6. **An index of interviews** (id, title, participant roles) — so the agent knows what exists
   and can request a transcript by id.

This pack is **markdown**, written to a temp file and passed via
`--append-system-prompt-file`, prefixed with **citation rules** (§7). Typical size: a few KB
to low tens of KB — well under context limits and the 10 MB cap.

### 5.2 On-demand retrieval (via read tools — chosen)
Raw transcripts are **not** injected by default (they're the bulk). Now that we run an MCP tool
surface (§6), the agent pulls them itself:

- **Tool-use retrieval (chosen):** the context pack tells the agent that full transcripts exist,
  addressed by `interview_id`, and that it can call **`get_transcript(interview_id)`** /
  **`search_transcripts(query, interview_id?)`** to pull verbatim segments when a question needs
  them. The agent decides when (e.g. "what exact words did they use about pricing?"), reads, then
  cites. Cleaner and more general than UI-side keyword pre-fetch, and it's free now that the tool
  channel exists. The read tools are **always allow-listed** (cheap, safe) regardless of view.
- **Lazy fallback (no tool needed):** if a turn opens directly on an interview transcript, the
  Rust side can still inline that one interview's segments into the view context (§6.3) so the
  agent doesn't even need a tool round-trip for the obvious case. Pure optimization; the tool
  remains the general path.

### 5.3 Caching & limits
- Cache the assembled context pack per `(cycle_id, synthesis.updated_at, diff.updated_at)` so
  we don't rebuild it every turn; invalidate when synthesis/diff/guide change (stale-context
  risk §8).
- Respect the **10 MB stdin cap** and context budget: the pack is summaries, not transcripts;
  if a cycle is unusually large, truncate per-interview summaries and rely on on-demand
  retrieval. The synthesis map-reduce plumbing already keeps these artifacts compact.

### 5.4 Citation format
The system prompt instructs the agent to **cite inline** using a strict token the UI parses:
- `[[iv:<interview_id> seg:<segment_id>]]` for a transcript-grounded claim,
- `[[finding:<finding_id>]]` for a synthesis finding,
- `[[interview:<interview_id>]]` for an interview-level reference.

The UI post-processes assistant markdown: replace each token with a compact, clickable chip
(`iv3 · seg 12`, `F2`) resolved to the interview title / finding, and collect them into a
**Citations** footer under the message. Clicking routes to the interview editor (existing
route) or the Synthesis finding. Unresolvable citations render as quiet plain text (never a
broken link). This mirrors the existing synthesis **EvidenceQuote** affordance
(`synthesis-tab.tsx`) — same "traceable back to the transcript" discipline.

---

## 6. Agentic design: tool surface, context-scoping, safety

The agent is **agentic and context-aware**: it calls tools (§6.2) that map to the app's
**existing validated mutations**, pre-scoped to the **open view** (§6.3), under an **auto-apply
+ undo / confirm-first** safety model (§6.4), with every tool-call recorded for audit + undo
(§6.5). The engine is Claude Code's native tool loop over our MCP server (§4.3) — we add tools,
not a loop.

### 6.1 Invariant: every mutation goes through the existing validated path
The MCP write tools **do not contain business logic**. Each handler calls the *exact* command-
layer function the UI already calls, so all server-side invariants are enforced once, in one
place:
- **Transcript timing-immutability** — `update_segment_text` edits only the segment's text;
  segment start/end timings are immutable and the existing mutation rejects any timing change.
- **Schema validation** — `save_synthesis_section` writes through the same validator that
  guards the synthesis artifact shape; malformed content is rejected, not persisted.
- **Role library** — `set_speaker_role` accepts only roles in the cycle's role library (same
  check the editor uses); an unknown role errors back to the agent (which can then correct).
The agent therefore *cannot* violate an invariant via a tool; an invalid call returns an error
in the tool_result, which the agent sees and can retry — the in-loop feedback that makes (A)
better than action-proposals (§4.3).

### 6.2 Tool surface (concrete)
Namespaced `mcp__inv__*`. Read tools are cheap/safe and always available; write tools map 1:1
to existing Tauri/DB commands.

**Read (always allow-listed):**
| tool | args | backs onto |
|---|---|---|
| `get_transcript` | `interview_id` | transcript-load command |
| `search_transcripts` | `query`, `interview_id?` | segment text search (no embeddings, §5) |
| `get_synthesis` | `cycle_id` (implicit) | synthesis artifact + `findings_json` |
| `get_guide` | `cycle_id` (implicit) | guide content + goals |

**Write (allow-listed per view; confirm-first where noted):**
| tool | args | backs onto | safety |
|---|---|---|---|
| `update_segment_text` | `interview_id`, `segment_id`, `text` | edit-segment mutation (timing-immutable) | auto-apply + undo |
| `set_speaker_role` | `interview_id`, `segment_id` or `speaker`, `role` | reassign-role mutation (role-library checked) | auto-apply + undo |
| `save_synthesis_section` | `cycle_id`, `section_id`/`finding_id`, `content_md` | save-synthesis mutation (schema-validated) | auto-apply + undo |
| `update_guide` | `cycle_id`, `content_md`/`section` | save-guide mutation | auto-apply + undo |
| `rerun_synthesis` | `cycle_id`, `scope?` | existing synthesis runner (M10) | **confirm-first** (broad/expensive) |

Each write tool, on success, returns a concise result (the new value / a diff summary) **and**
records an entry in the edits log (§6.5) so the UI can render an Undo. New tools are added by
writing one handler that calls one existing command — the lazy extension point.

### 6.3 Context-scoping (how the open view is injected & limits tool args)
Two mechanisms, working together:

1. **Inject the view into the prompt.** The frontend passes `viewContext = { route, cycleId,
   interviewId?, transcriptId?, segmentId?, findingId?, guideId?, diffId? }` with every
   `cycle_chat_send`. `chat.rs` renders it into the appended system prompt:
   *"The user is currently viewing **interview 3's transcript**. Unless they say otherwise,
   'this segment' / 'this finding' refers to the open entity. In-scope ids: interview_id=iv3,
   segments 1–47."* So "fix this segment" resolves without the user repeating ids.
2. **Pre-scope the allowed tools + pre-fill args per turn.** `chat.rs` computes
   `--allowedTools` from `viewContext` so only the relevant write tools are even callable:
   - On a **transcript** view → allow `update_segment_text`, `set_speaker_role` (+ all reads).
   - On a **synthesis** view → allow `save_synthesis_section`, `rerun_synthesis` (+ reads).
   - On a **guide** view → allow `update_guide` (+ reads).
   - On **Overview / Diff** → reads only (no obvious single entity to mutate).
   Because the baseline is `--permission-mode dontAsk`, any non-allow-listed tool call is
   **denied** server-side — the scope is enforced by the permission layer, not just the prompt.
   The tool **args are also pre-bound**: the prompt tells the agent the in-scope `interview_id`
   so it fills it correctly, and the tool handler **defaults/validates** ids against the open
   entity (a call targeting an out-of-scope interview is rejected). This makes "context-aware"
   real on both sides: prompt-level intent *and* permission/handler-level enforcement.

When the user navigates to a different view mid-thread, the next turn re-renders the view
context and recomputes `--allowedTools` — and re-appends the (possibly changed) context (§9
stale-context).

### 6.4 Safety / confirmation model
- **Auto-apply + visible Undo (default for narrow edits).** `update_segment_text`,
  `set_speaker_role`, `save_synthesis_section`, `update_guide` apply immediately (they're
  narrow, reversible, and already validated). The tool-call card shows what changed with an
  **Undo** button; the edits log (§6.5) is the durable record. This keeps the agent fluid —
  no modal per keystroke — while staying fully reversible. (Rationale: same bar as a human
  edit in the editor, which also auto-applies and is undoable.)
- **Confirm-first for destructive/broad changes.** `rerun_synthesis` (expensive, overwrites
  the artifact) and any future bulk/irreversible tool require explicit user confirmation
  **before** they run. Mechanism: keep those tools **out** of `--allowedTools` and route them
  through **`--permission-prompt-tool mcp__inv__confirm`** — a tiny MCP tool whose "permission
  decision" is surfaced as a confirm dialog in the panel; the user's Yes/No becomes the tool's
  allow/deny. (If `--permission-prompt-tool` proves fiddly, the lazy equivalent: the agent
  calls a `propose_rerun` *read* tool that returns "needs confirmation", the UI shows a button,
  and a confirmed click invokes the real command directly — no agent round-trip.)
- **Hard guardrails always on:** `--tools ""` (no Bash/Edit/file/network), `--strict-mcp-config`
  (only our server), `dontAsk` (deny-by-default), `--max-turns` / `--max-budget-usd` (bounded
  loop). The agent's blast radius is exactly the tool table in §6.2, scoped to the open cycle.

### 6.5 Edits / activity log (audit + undo)
Every write tool-call is persisted as a **`chat_tool_call`** row (§7) capturing: the tool, its
args, the result, **`undo_token`** (what's needed to reverse it — e.g. the prior segment text /
prior role / prior section md), and a link to the message + thread. This gives:
- **Inline Undo** on each tool-call card (re-invoke the inverse mutation from `undo_token`).
- An **Activity** view per thread (and optionally per cycle) — "the assistant changed these 6
  things" — for trust and review.
- A reconciliation source if a turn is interrupted (a committed edit is recorded even if the
  turn later errors).

Undo reuses the **same validated mutations** in reverse (restoring prior text is just another
`update_segment_text`), so undo is as safe as the edit and itself logged.

### 6.6 Streaming UX for the agentic turn
- Tool calls render inline as compact cards (assistant-ui Tool UI, §3): **▸ running** while the
  tool executes, **✓ done** with a one-line result (or **✕ failed** with the error the agent
  saw), and an **Undo** on successful mutations.
- Text deltas stream around the tool cards (the agent narrates: "Found the segment — fixing the
  speaker label…" then the card, then continues).
- **Stop** cancels the in-flight agentic turn (`child.start_kill()`) between or during tool
  calls; already-committed edits stay (and are undoable). The composer re-enables.
- A **confirm-first** tool pauses the visible stream on a confirm card until the user answers.

---

## 7. Persistence schema (migration `0004`)

Matches existing conventions (product-spec §2.2 / migrations `0001`–`0003`): `sqlx`, UUID
text ids, unix-ms timestamps, JSON-as-TEXT for whole-blob data (citations, tool args),
`ON DELETE CASCADE` from `cycle`. **Three** tables — threads, messages, and a **tool-call /
edits log** (audit + undo for the agentic surface, §6.5).

```sql
-- migrations/0004_cycle_chat.sql

CREATE TABLE chat_thread (
  id          TEXT PRIMARY KEY,                                   -- uuid
  cycle_id    TEXT NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',                           -- derived from first question; user-renamable
  session_id  TEXT,                                               -- Claude Code session id for --resume (nullable until turn 1 completes)
  created_at  INTEGER NOT NULL,                                   -- unix ms
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_chat_thread_cycle ON chat_thread (cycle_id, updated_at DESC);

CREATE TABLE chat_message (
  id             TEXT PRIMARY KEY,                                -- uuid
  thread_id      TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,                                   -- 'user' | 'assistant'
  content        TEXT NOT NULL,                                   -- markdown (assistant) / plain (user); citation tokens left inline
  citations_json TEXT NOT NULL DEFAULT '[]',                      -- JSON: [{kind:'segment'|'finding'|'interview', interview_id?, segment_id?, finding_id?}]
  status         TEXT NOT NULL DEFAULT 'complete',                -- 'streaming' | 'complete' | 'error' (assistant rows)
  error          TEXT,                                            -- nullable error detail when status='error'
  cost_usd       REAL,                                            -- from the stream-json final result (optional, informational)
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_chat_message_thread ON chat_message (thread_id, created_at);

-- Tool-call / edits log: audit + undo for the agentic surface (§6.5)
CREATE TABLE chat_tool_call (
  id          TEXT PRIMARY KEY,                                  -- uuid (maps to stream tool_use id)
  message_id  TEXT NOT NULL REFERENCES chat_message(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
  tool        TEXT NOT NULL,                                     -- 'mcp__inv__update_segment_text' …
  kind        TEXT NOT NULL,                                     -- 'read' | 'write'
  args_json   TEXT NOT NULL DEFAULT '{}',                        -- the (pre-scoped) tool input
  result_json TEXT,                                              -- concise result / diff summary
  status      TEXT NOT NULL DEFAULT 'done',                      -- 'running' | 'done' | 'error' | 'denied'
  error       TEXT,                                              -- tool error the agent saw (nullable)
  undo_token  TEXT,                                              -- JSON: inverse-mutation payload (write tools only; e.g. prior text/role/section md)
  undone_at   INTEGER,                                           -- set when the user undoes this edit (nullable)
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_chat_tool_call_thread ON chat_tool_call (thread_id, created_at);
CREATE INDEX idx_chat_tool_call_message ON chat_tool_call (message_id, created_at);
```

Notes:
- `session_id` on the **thread** drives `--resume`; if missing/invalid, the runner falls back
  to replaying stored messages in the prompt (plan B, §4.2).
- `citations_json` is parsed from the assistant's inline `[[…]]` tokens at persist time and
  also kept inline in `content` (so re-render is lossless even if the parser changes).
- An assistant row is written as `status='streaming'` when a turn starts and flipped to
  `complete`/`error` at the end — lets a reopened tab reconcile an interrupted stream.
- **`chat_tool_call`** records each tool the agent ran (read + write). For **write** tools,
  `undo_token` holds the inverse-mutation payload so the UI can offer **Undo** (§6.5); `undone_at`
  marks it reversed. Write rows are committed **as the tool returns**, so an edit survives even
  if the turn is later cancelled/errors (reconciliation source). `kind='read'` rows are optional
  (useful for the activity view / debugging) and can be pruned.
- Frontend mirrors this with TanStack Query keys (`["chat-threads", cycleId]`,
  `["chat-messages", threadId]`, `["chat-tool-calls", threadId]`) + a Zustand store for the
  in-flight streaming buffer + live tool-call states, exactly the pattern `synthesis-queries.ts`
  + `synthesis-tab.tsx` use for progress events.

---

## 8. Build plan (phased; AI-agent executable)

Three phases, each independently shippable and verifiable. **Phase A** lands grounded streaming
chat; **Phase B** adds context-awareness + read tools (the agent reads what's open); **Phase C**
adds mutation tools with undo/confirm (the agent acts). This order de-risks the agentic surface:
the streaming + MCP plumbing is proven on safe reads before any write tool exists. Lands after
M10; call this **M11** (A/B/C its sub-milestones). Each step ends with a concrete verification.

### Phase A — grounded streaming chat (no tools)
1. **Schema + store (Rust).** Migration `0004` (all three tables; `chat_tool_call` unused until
   Phase B/C); `chat.rs` with thread/message CRUD + `#[tauri::command]`s: `list_chat_threads`,
   `create_chat_thread`, `get_chat_messages`, `cycle_chat_append`, `rename_chat_thread`,
   `delete_chat_thread`. *Verify:* unit test create thread → append two messages → read back in
   order; cascade delete with the cycle.
2. **Context pack builder (Rust).** `build_context(cycle_id)` assembling §5.1 + the
   citation-rules preamble; cache by `(cycle_id, synthesis.updated_at, diff.updated_at)`.
   *Verify:* on a seeded cycle the pack contains the synthesis md, ≥1 finding id, all interview
   titles, the diff summary; under ~64 KB.
3. **Streaming runner (Rust) — core extension of `adapter.rs`.** `adapter::stream_agent_turn` /
   `chat::cycle_chat_send`: spawn `claude -p <q> --output-format stream-json --verbose
   --include-partial-messages --append-system-prompt-file <pack> --setting-sources "" --tools ""
   --strict-mcp-config` (no `--mcp-config` yet → no tools) (+ `--resume` after turn 1);
   line-stream stdout → `chat://<thread>`; capture `session_id`; `cycle_chat_cancel` kills the
   child. *Verify (ignored live test, like `real_round_trip_ping`):* with `claude login`, a
   question streams ≥2 token events + a `done` with a `session_id`; a `--resume` follow-up
   answers a question needing turn-1 context.
4. **assistant-ui wiring (React).** Add `@assistant-ui/react` + `streamdown`;
   `cycle-chat-panel.tsx` with `useExternalStoreRuntime` (`messages` from Zustand,
   `convertMessage`, `onNew`, `onCancel`, `onReload`). Dev-mock path (`!IN_TAURI`) streams a
   canned answer (matches `dev-mock.ts`). *Verify:* in dev-mock, a question streams a markdown
   answer; Stop halts; Regenerate re-runs.
5. **Citations (React).** Parse `[[iv:… seg:…]]` / `[[finding:…]]` / `[[interview:…]]` → chips
   + Citations footer; route to interview editor / Synthesis finding. *Verify:* citation tokens
   render chips that navigate correctly; unknown ids degrade to plain text.
6. **Side-panel UX + thread switcher + global invoke (React).** Mount the slide-out, resizable,
   collapsible right panel in `cycle-detail.tsx` (outside the Tabs), reusing
   `react-resizable-panels`; **invoke from anywhere** via header button + Cmd+K + ⌘/Ctrl+J;
   persist open/width per cycle. Top thread switcher; empty state with suggested questions; the
   **context strip** (§2) wired to the live route. Linear styling pass. *Verify (Preview MCP):*
   the panel opens from all three triggers on every cycle view, resizes, persists; the context
   strip updates as you navigate; screenshots hit the Linear bar.

### Phase B — context-awareness + read tools (agent reads what's open)
7. **MCP server + read tools (Rust).** Stand up the `inv` MCP server (§4.3, in-process stdio)
   exposing **read** tools (`get_transcript`, `search_transcripts`, `get_synthesis`,
   `get_guide`) that call existing load/search functions; write the `mcp_config.json`; switch
   the runner to add `--mcp-config <file> --permission-mode dontAsk --allowedTools
   "mcp__inv__get_transcript mcp__inv__search_transcripts mcp__inv__get_synthesis
   mcp__inv__get_guide"`. *Verify (live):* "quote what they said about pricing" triggers a
   `get_transcript`/`search_transcripts` tool_use in the stream and the answer quotes a real
   segment; with `--tools ""` no Bash/Edit appears.
8. **View-context injection + scoping (Rust + React).** Frontend sends `viewContext` with each
   turn; `chat.rs` renders it into the appended prompt and (here, harmless) logs the computed
   allow-list. *Verify:* opening interview 3 then asking "summarize this interview" makes the
   agent act on iv3 without the user naming it (check the tool args / answer).
9. **Tool-call UI (React).** Register assistant-ui Tool UIs for the read tools; parse
   `tool_use`/`tool_result` stream events → ▸running/✓done cards inline; persist `chat_tool_call`
   rows (`kind='read'`). *Verify (dev-mock + live):* a read tool renders a running→done card with
   a one-line result; Stop mid-tool cancels cleanly.

### Phase C — mutation tools with undo/confirm (agent acts)
10. **Write tools → existing mutations (Rust).** Add `update_segment_text`, `set_speaker_role`,
    `save_synthesis_section`, `update_guide` to the MCP server, each calling the **exact**
    existing validated command (§6.1); return a concise result + write a `chat_tool_call` row
    with an `undo_token`. *Verify (live):* an `update_segment_text` call persists via the normal
    path; a call attempting a timing change or an unknown role is **rejected** by the existing
    validator and the agent sees the error in `tool_result`.
11. **Per-view allow-listing + arg pre-binding (Rust).** Compute `--allowedTools` from
    `viewContext` (§6.3): transcript→segment/role tools, synthesis→section tool, guide→guide
    tool, overview/diff→reads only; handlers validate ids against the open entity. *Verify:* on
    a synthesis view, a `update_segment_text` call is **denied** (not allow-listed); on a
    transcript view it's allowed.
12. **Auto-apply + Undo + edits log (React).** Tool-call cards for writes show what changed + an
    **Undo** (re-invokes the inverse mutation from `undo_token`, logged); an **Activity** view
    lists a thread's edits. *Verify:* the agent fixes a segment → the editor reflects it → Undo
    restores the prior text and marks `undone_at`.
13. **Confirm-first for `rerun_synthesis` (Rust + React).** Route it through
    `--permission-prompt-tool mcp__inv__confirm` (or the lazy `propose_rerun` fallback, §6.4) →
    a confirm card pauses the stream until the user answers. *Verify:* asking "re-run synthesis"
    shows a confirm card; Yes runs the M10 runner, No declines without mutating.
14. **Hardening.** One-in-flight-turn guard; reopen reconciliation of a `streaming` row +
    committed-but-orphaned `chat_tool_call` rows; error surfacing (CLI stderr → inline error
    bubble + retry, reusing the adapter's typed-error shape); **stale-context** re-append on
    synthesis/diff/guide/transcript edits (incl. the agent's own edits) + recompute allow-list on
    navigation; `--max-turns`/`--max-budget-usd` runaway guard with a clear toast; usage-limit
    handling (partial answer + toast). *Verify:* killing the CLI mid-tool-loop shows an error
    bubble with Retry and leaves any committed edit undoable; the agent editing a segment then
    answering a follow-up uses the refreshed transcript; hitting `--max-turns` surfaces a clear
    message, not a hang.

---

## 9. Risks & mitigations

1. **Runaway / unintended agentic edits (HIGH).** A tool-using agent could make wrong or
   excessive edits (misread "this segment", over-eager rerun, looping). *Mitigation, layered:*
   (a) **deny-by-default** scope — `--permission-mode dontAsk` + a per-view `--allowedTools`
   allow-list (§6.3) means only the handful of tools relevant to the open entity can run;
   anything else is denied. (b) **No raw power** — `--tools ""` (no Bash/Edit/file/network) +
   `--strict-mcp-config` (only our server); the blast radius is exactly §6.2. (c) **Invariants
   server-side** (§6.1) — a tool *cannot* corrupt data (timing-immutability, schema, role
   library reject bad calls). (d) **Auto-apply is reversible** — every write logs an
   `undo_token`; **confirm-first** gates the broad/expensive `rerun_synthesis` (§6.4). (e)
   **Bounded loop** — `--max-turns` / `--max-budget-usd` cap a runaway. (f) **Visible** — every
   tool-call renders inline with Undo and lands in the edits log. Net: an unintended edit is
   contained, reversible, and visible — never silent or unbounded.
2. **Tool-permission safety in headless mode (HIGH).** In `-p` mode there's no human to answer
   a permission prompt, so a misconfigured permission could either over-permit (agent does
   something unscoped) or hang. *Mitigation:* the permission model is fully expressed in flags —
   `dontAsk` (verified: auto-denies anything not pre-approved, fully non-interactive) +
   explicit `--allowedTools`; **never** `bypassPermissions`. Confirm-first tools route through
   `--permission-prompt-tool` (a real prompt surfaced as a UI confirm), not an auto-allow.
   Allow-list is computed server-side per turn (frontend can't widen it). *Verify* the deny
   path in build step 11 (a non-allow-listed tool is denied, not silently run).
3. **Subscription usage on agentic loops (HIGH).** A tool-using turn makes **multiple** model
   round-trips (read → think → write → verify), so it costs more than a plain answer and can hit
   Pro/Max limits mid-loop (same quota as synthesis, product-spec §10.3). *Mitigation:* surface
   per-turn cost/usage from the `stream-json` final `result`; **`--max-budget-usd`** caps a
   single turn's spend; **`--max-turns`** caps the loop length; keep context lean (§5) and the
   allow-list tight so the agent doesn't wander. On a limit error, persist the partial
   answer + any committed (undoable) edits + a clear toast ("Claude usage limit reached"); never
   silently fail.
4. **Stale context after edits — including the agent's own (MEDIUM→HIGH for an editing agent).**
   The user *or the agent* edits a transcript / re-runs synthesis *after* a thread started, so
   the resumed session holds a stale pack and the agent reasons over old data (worse now that
   edits are common, and the agent can edit then immediately follow up). *Mitigation:* cache key
   includes `synthesis.updated_at` / `diff.updated_at` / transcript `updated_at`; on change,
   **re-append the fresh pack** on the next turn and show a quiet "context updated" note. **The
   agent's own write tools bump those timestamps** (they go through the normal mutations), so a
   post-edit follow-up automatically refreshes. Prefer **read tools for verification** over
   trusting the cached pack after a write. Plan-B (replay-from-DB) always uses fresh context.
5. **Context size / 10 MB cap on big cycles (MEDIUM).** A large cycle's summaries could bloat
   the pack. *Mitigation:* the pack is summaries/synthesis, not raw transcripts (the agent pulls
   full transcripts via `get_transcript` on demand, §5.2); truncate per-interview summaries;
   `--append-system-prompt-file` (file, not arg/stdin) sidesteps arg-length and the stdin cap.
6. **Streaming reliability / parsing `stream-json` tool events (MEDIUM).** The ndjson event
   shape can evolve; a dropped line or an unrecognized event (now including `tool_use` /
   `tool_result` / `input_json_delta`) mustn't break the stream. *Mitigation:* tolerant per-line
   parsing (skip unrecognized event types, like the adapter's tolerant JSON extraction); the
   BufReader handles partial lines; treat a non-zero exit / closed stdout as an error event; an
   `--include-partial-messages` regression degrades to whole-message events (chunkier, still
   works). Pin behavior with the live verifies in steps 3, 7, 10.
7. **`--resume` under a neutral cwd (MEDIUM).** Resume-by-id searches the current project dir;
   our neutral cwd could make a session unresolvable (and the agent loses its tool/edit history).
   *Mitigation:* verify in step 3; if flaky, use the **replay-prior-turns-in-prompt** fallback
   (we store every message *and* `chat_tool_call`) — no session state needed, fully robust, at
   the cost of re-sending history each turn.
8. **MCP server reliability (MEDIUM).** A new in-process MCP server is a new dependency in the
   loop; if it fails to start, every tool call fails. *Mitigation:* health-check the server at
   spawn (the `system/init` event lists loaded MCP servers + any `mcp` errors — fail fast with a
   clear message if `inv` isn't loaded); keep handlers thin (they call existing functions); the
   **structured action-proposal fallback (§4.3 B)** is the escape hatch if standing up MCP
   stalls a phase.
9. **assistant-ui API churn (LOW–MEDIUM).** It's evolving fast (v6 / AI-SDK integration in
   2026). *Mitigation:* depend only on the **stable `useExternalStoreRuntime`** surface (messages
   + handlers) + the documented Tool UI registration, not the AI-SDK runtime; pin the version.
10. **Hallucinated / uncited claims (LOW–MEDIUM).** The agent could answer or *edit* beyond the
    data. *Mitigation:* the system prompt instructs "answer only from the provided cycle context;
    read the source with a tool before editing; cite every claim; say what's not in the data";
    citations make ungrounded claims visible (no chip = no source); for edits, the **read-then-
    write** discipline + the validated mutations + Undo bound the damage of a bad edit.
11. **Citation token leakage (LOW).** Malformed `[[…]]` tokens could show raw. *Mitigation:*
    tolerant parser leaves unrecognized tokens as plain text; strip stray brackets in render.

---

## 10. Summary of key decisions (for confirmation)

- **Scope (changed):** **agentic + context-aware**, not read-only. The assistant answers **and
  acts** — calling tools that wrap the app's existing validated mutations — scoped to whatever
  cycle view is open, invokable from **anywhere** in the cycle UI.
- **Agent engine (reuse-first):** Claude Code's **native tool-use / MCP** is the loop. We point
  it at **our** MCP server with **`--mcp-config <file> --strict-mcp-config`** (only our server),
  run **`--permission-mode dontAsk`** + a per-view **`--allowedTools`** allow-list, lock out
  built-ins with **`--tools ""`**, and bound the loop with **`--max-turns` / `--max-budget-usd`**.
  All under **subscription auth** (no `--bare`, no API key) — verified.
- **MCP server vs. structured proposals → MCP server.** An MCP server exposing the app's actions
  gives the agent real in-loop tool feedback (read→write→verify); structured proposals are the
  simpler fallback that loses it. **Recommend MCP** (the genuine agentic, reusable path); keep
  proposals as the escape hatch (§4.3).
- **Tool surface:** read (`get_transcript`, `search_transcripts`, `get_synthesis`, `get_guide`)
  + write (`update_segment_text`, `set_speaker_role`, `save_synthesis_section`, `update_guide`,
  `rerun_synthesis`) — each write calls the **exact** existing validated command, so
  timing-immutability / schema / role-library invariants hold server-side (§6.1–6.2).
- **Context-scoping:** the frontend sends `viewContext` (route + entity ids) each turn;
  `chat.rs` injects it into the prompt **and** computes `--allowedTools` per view + pre-binds
  args — so "fix this segment" is unambiguous and out-of-scope tools are denied (§6.3).
- **Safety:** **auto-apply + visible Undo + edits log** for narrow reversible edits;
  **confirm-first** (via `--permission-prompt-tool`) for broad/expensive ones (`rerun_synthesis`).
  Tool calls render inline (▸running/✓done) with Undo; Stop cancels the in-flight loop (§6.4–6.6).
- **UI kit (unchanged):** **assistant-ui** (MIT) via **`useExternalStoreRuntime`** + its **Tool
  UIs** for tool-call cards; **Streamdown** for stream-safe markdown; mine **shadcn-chatbot-kit**
  for styling. Wire send/stop/regenerate; defer message-edit/branching.
- **Backend (unchanged + layered):** **extend `adapter.rs`** into a streaming, **tool-using**
  runner — `claude -p --output-format stream-json --verbose --include-partial-messages`,
  `--resume` for multi-turn, `--append-system-prompt-file` for grounding+view-context, same
  isolation (`--setting-sources ""`, neutral cwd, no `--bare`); tokio line-streaming of text +
  `tool_use`/`tool_result` events → Tauri events; `child.start_kill()` for stop; one turn/thread.
- **Grounding (unchanged):** **lazy** context pack + **on-demand transcript retrieval via a read
  tool**; **no embeddings/RAG**.
- **Citations (unchanged):** strict `[[iv:… seg:…]]` / `[[finding:…]]` tokens → clickable chips.
- **Persistence:** migration **`0004`** — `chat_thread` (+ `session_id`), `chat_message`
  (+ `citations_json`, `status`), and **`chat_tool_call`** (tool/args/result + **`undo_token`**
  for the edits/audit/undo log), per cycle.
- **Phasing:** **A** grounded streaming chat → **B** context-awareness + read tools → **C**
  mutation tools with undo/confirm. Each phase shippable + verifiable; lands after M10 as **M11**.

### Decisions the founder should confirm
1. **MCP server vs. structured action-proposals** — spec recommends the **in-process MCP
   server** (real agentic loop, reuses Claude Code's tool-use). Confirm we accept a new
   in-process server, or prefer the simpler proposals fallback for v1.
2. **Auto-apply + Undo vs. confirm-first** — spec recommends **auto-apply + Undo** for narrow
   edits, **confirm-first** only for `rerun_synthesis` / broad changes. Confirm that's the right
   line (e.g. should speaker-role reassignment also confirm-first?).
3. **Build phasing** — confirm **A → B → C** (ship grounded chat first, add reads, then writes)
   vs. going straight to the full agentic surface.
4. **Tool scope for v1** — confirm the write-tool table (§6.2). Are `update_guide` /
   `rerun_synthesis` in v1, or is the first agentic cut transcript + synthesis-section edits only?

### Source references (verified June 2026)
- Claude Code CLI flags (`--mcp-config`, `--strict-mcp-config`, `--allowedTools`/`--disallowedTools`,
  `--permission-mode`, `--permission-prompt-tool`, `--tools`, `--max-turns`, `--max-budget-usd`,
  stream-json, `--include-partial-messages`, `--resume`/`--session-id`, `--append-system-prompt(-file)`,
  `--setting-sources`, no `--bare` for subscription auth) — https://code.claude.com/docs/en/cli-reference
- Headless / `claude -p` (tools, `--allowedTools`, permission modes, structured + stream-json output,
  subscription vs. bare/API-key) — https://code.claude.com/docs/en/headless
- Permission modes (`default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions`; `dontAsk`
  = deny-by-default non-interactive; headless `-p` aborts on repeated denials) — https://code.claude.com/docs/en/permission-modes
- MCP (server JSON config shape `{"mcpServers":{…}}` for stdio/http, `mcp__<server>__<tool>` naming,
  allow-listing MCP tools) — https://code.claude.com/docs/en/mcp
- Streaming output / tool events (`content_block_start` `tool_use`, `input_json_delta`,
  `tool_result`, final `result` with session_id + cost) — https://code.claude.com/docs/en/agent-sdk/streaming-output
- assistant-ui (MIT, ExternalStoreRuntime + Tool UIs) — https://github.com/assistant-ui/assistant-ui ; https://www.assistant-ui.com/docs/runtimes/custom/external-store ; https://www.assistant-ui.com/docs/guides/ToolUI
- shadcn-chatbot-kit (MIT, styling donor) — https://github.com/Blazity/shadcn-chatbot-kit
- Vercel AI SDK UI transport / DirectChatTransport (fallback) — https://ai-sdk.dev/docs/ai-sdk-ui/transport ; https://ai-sdk.dev/docs/reference/ai-sdk-ui/direct-chat-transport
