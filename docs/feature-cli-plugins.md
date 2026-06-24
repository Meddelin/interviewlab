# Feature spec: Pluggable CLI-adapter ("agent plugin") architecture

> **The authoritative design for how ANY local AI CLI — including a custom one — is onboarded
> into InterviewLab with minimal effort and WITHOUT touching the app's source code.** The agent
> drops a self-contained **plugin** into a folder the app auto-discovers and loads at runtime.
> One plugin layer serves BOTH the existing **batch tasks** (transcript-cleanup, cycle-synthesis,
> cycle-diff) AND the new **agentic, context-aware cycle chat** (streaming, multi-turn, tool-use
> that edits the app's data).
>
> **Reuse-first stance** (lazy-senior lens): we do **not** invent a plugin framework. We reuse
> two industry-standard bridge patterns we already touch — **MCP** as the universal *tool* layer,
> and a **stable stdio-JSON protocol** (the LSP/DAP/ACP pattern) as the *adapter-program* bridge —
> plus a pure **JSON descriptor** for CLIs whose flags already map to our needs. Claude Code is the
> **reference plugin**, not a hardcode.
>
> **This doc supersedes/extends** product-spec **§7** (the M6 CLI-adapter descriptor + §7.4
> agent-facing meta-instruction) and reframes feature-cycle-chat.md as **plugin-driven** (Claude
> Code = one plugin). product-spec §7 and feature-cycle-chat.md remain accurate for the Claude Code
> case; this doc generalizes them. Where they conflict, **this doc wins.**
>
> Status: design doc for an AI dev agent. Date: 2026-06-23. Targets `interviewlab/` (Tauri 2 +
> Rust core + React 19 + shadcn). Backend home: extends `src-tauri/src/adapter.rs` (batch) and
> `chat.rs` (agentic, feature-cycle-chat.md §4).

---

## 1. Goal, constraints, and what "no source changes" means

### The requirement (core since day one — product-spec §1 "CLI-adapter layer + plugin-instruction spec")
Any AI CLI must work with InterviewLab with **minimal effort from a local AI agent** and **without
modifying the app's source**. The agent's integration lives in a **separate, app-data location the
app discovers and loads at runtime**. This must cover the **batch tasks** *and* the **agentic chat**.

### What "no source changes" precisely means
- **No recompiling the Rust core, no editing TypeScript.** A plugin is data + (optionally) a small
  external program the plugin itself ships. The app already does this for batch adapters today
  (product-spec §7.1: `%APPDATA%/com.interviewlab.app/adapters/*.json` loaded by `adapter.rs`).
- The app exposes **three stable contracts** a plugin targets, and nothing else:
  1. the **manifest schema** (§3) — declarative,
  2. the **task contracts** for batch (§7.3 of product-spec, unchanged) and
  3. the **stdio chat protocol** (§6) for the adapter-program tier + the **MCP tool surface** (§5)
     for the descriptor tier.
- The plugin author (a local AI agent) writes a manifest, optionally an adapter program, and a
  README — then drops the folder in place. The app picks it up. That's the whole onboarding.

### Non-goals (kept lazy)
- **Not** a sandbox/permission framework for arbitrary plugin code — an adapter program runs with
  the user's privileges (same trust model as "the user installed this CLI"); see §10 security.
- **Not** a marketplace, signing, or auto-update system (folder drop-in only; fast-follow if ever).
- **Not** a second agent loop — the agentic loop is the CLI's (Claude Code / any MCP-capable CLI),
  or, for the adapter-program tier, a thin relay; we never build an LLM agent runtime.

---

## 2. Plugin discovery & layout (zero source changes)

### 2.1 The plugins folder (the drop-in location)
```
%APPDATA%/com.interviewlab.app/plugins/
  <plugin-id>/
    manifest.json        # REQUIRED — the plugin descriptor (§3). (alias: adapter.json accepted)
    README.md            # human/agent notes: what CLI, how to install/login, caveats
    adapter[.exe|.js|…]  # OPTIONAL — adapter program for the adapter-program tier (§6)
    assets/              # OPTIONAL — icon, prompt-template overrides, fixtures for self-test
```
- **One folder = one plugin.** The folder name is the canonical `id` (must match `manifest.id`).
- **Back-compat:** the existing flat `adapters/<id>.json` (product-spec §2.3 / §7.1) is **still
  loaded** as a degenerate plugin (manifest only, `capabilities: ["batch-tasks"]`). New plugins use
  the folder form. The loader scans **both** `adapters/*.json` (legacy) and `plugins/*/manifest.json`.
- **Bundled reference plugin:** Claude Code ships **inside the app bundle** as a read-only built-in
  plugin (Tauri `bundle.resources`), copied/registered on first run so the app works out of the box.
  User plugins in `plugins/` **override** a built-in with the same `id`.

### 2.2 Loading, validation, reload behavior
- **On startup** and **on demand** (Settings → "Rescan plugins"), the loader enumerates the folder,
  parses each `manifest.json`, **validates against the manifest JSON Schema** (§3.3), and registers
  valid plugins. Invalid ones are listed in Settings with the validation error (never crash the app).
- **Live reload (lazy):** a filesystem watch on `plugins/` (the `notify` crate, already a small dep)
  triggers a debounced rescan so a freshly dropped plugin appears without an app restart — matching
  the "drop it in and select it" promise. If a watch proves fiddly cross-platform, the **manual
  "Rescan" button is the v1 floor** (zero risk); the watch is a nicety.
- **Activation is per-capability, per-plugin.** Settings shows every registered plugin with its
  declared capabilities (§3) and lets the user pick the **active plugin** for batch and (separately,
  if desired) for chat. The active selection is stored in `app_setting` (product-spec §2.2), exactly
  as the active batch adapter is today.
- **Probe on register/select:** run the manifest `probe` (cheap command, expected exit) to show
  Available / Not found / Not logged in (product-spec §7.2 "Test CLI"), unchanged.

---

## 3. The manifest (extends the M6 descriptor)

The manifest is a **superset** of the product-spec §7.1 adapter descriptor: every existing field is
preserved (so today's `claude-code.json` is a valid manifest with `capabilities:["batch-tasks"]`),
plus a **capability block**, a **chat block**, and a **tools block**.

### 3.1 Capability declaration
```jsonc
"capabilities": ["batch-tasks", "streaming", "multi-turn", "tool-use"]
```
| capability | meaning | drives |
|---|---|---|
| `batch-tasks` | runs the three one-shot tasks (product-spec §7.3) | Clean / Synthesize / Diff |
| `streaming` | emits token-by-token output | live streaming chat UI vs. spinner-then-answer |
| `multi-turn` | sessions / conversation continuity | thread continuity vs. replay-history each turn |
| `tool-use` | can call tools (MCP) **or** relays tool-calls over the stdio protocol | in-loop agentic edits vs. proposal-only |

The app **drives the CLI to exactly its declared capabilities and degrades gracefully** (§8). The UI
reflects what's available (e.g. no Stop button if `streaming` absent; a "proposes edits" banner if
`tool-use` absent).

### 3.2 Manifest schema (full shape)
```jsonc
{
  "manifest_version": 1,
  "id": "claude-code",
  "name": "Claude Code",
  "version": "1.0",
  "vendor": "Anthropic",
  "command": "claude",                       // executable on PATH or absolute path
  "capabilities": ["batch-tasks","streaming","multi-turn","tool-use"],

  "probe": { "args": ["--version"], "expect_exit_code": 0 },   // product-spec §7.1, unchanged
  "auth":  { "type": "session", "env": [], "note": "claude login; never --bare" },  // §7.1, unchanged

  // ---- BATCH tier (descriptor-only; product-spec §7.1 verbatim) ----
  "io": {
    "payload_via": "stdin", "prompt_via": "arg",
    "result_extract": { "format": "json", "json_path": "result" },
    "timeout_sec": 600, "max_stdin_bytes": 10000000
  },
  "tasks": {
    "transcript-cleanup": { "args_template": ["-p","{prompt}","--output-format","json","--setting-sources","","--strict-mcp-config"] },
    "cycle-synthesis":     { "args_template": ["-p","{prompt}","--output-format","json","--setting-sources","","--strict-mcp-config"] },
    "cycle-diff":          { "args_template": ["-p","{prompt}","--output-format","json","--setting-sources","","--strict-mcp-config"] }
  },

  // ---- CHAT tier ----
  "chat": {
    "mode": "descriptor",                    // "descriptor" | "adapter-program"
    "stream": {                              // present iff capabilities includes "streaming"
      "args_template": [
        "-p","{prompt}","--output-format","stream-json","--verbose","--include-partial-messages",
        "--append-system-prompt-file","{system_prompt_file}",
        "--setting-sources","","--permission-mode","dontAsk","--tools","",
        "{mcp_args}","{session_args}","{allowed_tools_args}"
      ],
      // how to read the ndjson stream → our ChatEvent (feature-cycle-chat.md §4.3)
      "parse": "claude-stream-json"          // a named, built-in parser the app ships (see §3.4)
    },
    "session": {                             // present iff capabilities includes "multi-turn"
      "resume_args": ["--resume","{session_id}"],
      "session_id_from": "result.session_id" // where the stream's final event carries the id
    },
    "tools": {                               // present iff capabilities includes "tool-use"
      "transport": "mcp",                    // "mcp" | "stdio-relay"
      "mcp_config_args": ["--mcp-config","{mcp_config_file}","--strict-mcp-config"],
      "allowed_tools_arg": "--allowedTools", // app fills the per-view allow-list (feature-cycle-chat.md §6.3)
      "tool_namespace": "mcp__inv__"         // how this CLI names our MCP tools
    }
  },

  // ---- ADAPTER-PROGRAM tier (only when chat.mode == "adapter-program") ----
  "adapter_program": {
    "command": "adapter.exe",                // relative to the plugin folder; the program the plugin ships
    "args": [],                              // static args; the app speaks the stdio protocol (§6) over stdin/stdout
    "protocol_version": 1
  }
}
```
**Rule of orthogonality:** a plugin declares only the blocks for capabilities it has. A
batch-only CLI ships just `io` + `tasks` (today's file). A streaming-but-no-tools CLI ships
`chat.stream` and omits `chat.tools`. The app reads capabilities and **never invokes a block that
isn't declared** — that's the graceful-degradation mechanism in data form.

### 3.3 Validation
The app ships a **JSON Schema** for the manifest (`assets/manifest.schema.json`, also surfaced in
the agent-facing doc §9). The loader validates on register; the agent self-tests against it (§9.4).
Required: `manifest_version`, `id`, `name`, `command`, `capabilities`, `probe`. Conditional-required:
`tasks`+`io` if `batch-tasks`; `chat.stream` if `streaming`; `chat.session` if `multi-turn`;
`chat.tools` **or** `adapter_program` if `tool-use`.

### 3.4 Named stream parsers (reuse, don't reinvent per plugin)
A descriptor-tier CLI's stream is parsed by a **named parser the app ships**, referenced by
`chat.stream.parse`. v1 ships:
- `claude-stream-json` — Claude Code's `stream-json` events (feature-cycle-chat.md §4.3).
- `gemini-stream-json` — Gemini CLI's `--output-format stream-json` JSONL (same event family;
  verified below).
- `openai-jsonl` — a generic JSONL line parser (text-delta + tool events) for CLIs in that shape.

If a CLI's stream doesn't match a shipped parser, the plugin uses the **adapter-program tier**
(§6), whose program normalizes the stream into our protocol — so we never ask plugin authors to
register a parser inside the app (that *would* be a source change). This is the deliberate seam: **a
new stream shape = an adapter program, not an app patch.**

---

## 4. The two integration tiers

Both tiers are **pure drop-in, no app source changes.** Pick by how well the CLI's native interface
maps to our needs.

### Tier 1 — Descriptor-only (pure JSON)
For CLIs whose flags already map to: one-shot prompt+JSON (batch), and/or a streamable ndjson mode,
session resume, and **MCP** tool config. The plugin is **just `manifest.json`** (+ README). **Zero
code.** Reference: **Claude Code** (full four capabilities). **Gemini CLI** maps nearly 1:1 for
`batch-tasks` + `streaming` + `tool-use` (it has `-p`, `--output-format json|stream-json`, and MCP)
— a second descriptor-only plugin with no app changes (verified §11).

### Tier 2 — Adapter-program (stable stdio-JSON protocol)
For arbitrary CLIs whose native interface does **not** map to a descriptor (bespoke output, no MCP,
exotic session handling, an HTTP-only or library-only agent the plugin wraps). The plugin ships a
**small program** that speaks the app's **stdio chat protocol** (§6); internally it invokes its CLI
however it likes and **normalizes** to our event stream. This is the **LSP/DAP/ACP pattern**: the
host speaks one protocol; an external program implements it (prior art §11). The program is the
plugin author's code, shipped in the plugin folder — **still no app source change.**

> **Why two tiers (lazy justification):** ~all mainstream agent CLIs in 2026 already speak MCP and
> have a headless JSON mode (§11), so **the descriptor tier covers them with zero code**. The
> adapter-program tier exists only for the long tail (custom/in-house CLIs, odd output formats) and
> is the documented **extension point**, not v1 surface area (§12).

---

## 5. Tools, portably: one MCP server is the universal tool layer

**Verified:** MCP is a JSON-RPC 2.0 client/server protocol over **stdio** (local) where a *server*
exposes **tools** (name + JSON-Schema input + `tools/call` execution); any **MCP host/client**
discovers (`tools/list`) and calls them. Hosts that speak MCP in 2026 include **Claude Code, Cursor
(+ Cursor Agents CLI), GitHub Copilot (VS Code agent mode, Feb 2026), OpenAI Codex (plugins bundle
MCP, Jun 2026), and Google Gemini CLI / Antigravity CLI** (§11). So **one MCP server = portable tools
across every MCP-capable CLI.**

### 5.1 The app's `inv` MCP server (single source of truth)
InterviewLab exposes its **edit/read actions as one MCP server** (`inv`), exactly as
feature-cycle-chat.md §4.3/§6.2 specifies: read tools (`get_transcript`, `search_transcripts`,
`get_synthesis`, `get_guide`) and write tools (`update_segment_text`, `set_speaker_role`,
`save_synthesis_section`, `update_guide`, `rerun_synthesis`). **Every tool handler calls the exact
validated command/DB path the UI uses** (timing-immutability, schema validation, role library
enforced server-side — feature-cycle-chat.md §6.1). This server is **plugin-independent**: it's part
of the app, not any plugin.

### 5.2 How each tier reaches the tools
- **Descriptor tier (MCP-capable CLI):** the app writes the standard MCP config file
  `{"mcpServers":{"inv":{…}}}` and the manifest's `chat.tools.mcp_config_args` point the CLI at it
  (`--mcp-config <file> --strict-mcp-config` for Claude Code; Gemini/Codex/Cursor have equivalent
  config). Tools are namespaced `mcp__inv__*` (or the manifest's `tool_namespace`). The app computes
  the per-view `--allowedTools` allow-list (feature-cycle-chat.md §6.3). **The CLI runs the agent
  loop and calls our tools directly.**
- **Adapter-program tier:** the program **relays** tool calls over our stdio protocol (§6): when its
  CLI wants a tool, the program emits a `tool_call` event; the **host executes it against the `inv`
  validated commands** and returns a `tool_result`. The program does not need to host MCP — it just
  forwards. (If the program's CLI *does* speak MCP, the program may instead point that CLI at the
  `inv` MCP server directly and skip relaying — author's choice.)
- **No-tool-use CLI (graceful degrade):** the CLI cannot call tools at all. It degrades to
  **structured action-proposals** — the same fallback feature-cycle-chat.md §4.3(B) defines: the
  read-only agent emits a JSON edit block, the app applies it via the **same validated mutation**
  with the **same Undo/confirm safety** (§8, feature-cycle-chat.md §6.4–6.5). The app parses the
  proposal from the (non-tool) output. So even a dumb CLI can "edit," just one-shot, not in-loop.

---

## 6. The stable stdio-JSON chat protocol (adapter-program tier)

The contract between the **host** (InterviewLab) and an **adapter program**. Newline-delimited JSON
(JSONL) over the program's **stdin (host→adapter)** and **stdout (adapter→host)**; stderr is logs.
Versioned by `adapter_program.protocol_version`. Designed to be trivially implementable in any
language (the lazy bar: a script that reads a line, shells out to its CLI, prints lines).

### 6.1 Host → adapter (one message per user turn, one JSON object per line)
```jsonc
{ "type": "turn",
  "protocol_version": 1,
  "thread_id": "…",
  "session_id": "…|null",          // null on first turn; the adapter returns one to enable multi-turn
  "text": "fix this segment",       // the user's message
  "system": "…cycle context pack + view context + citation rules…",  // feature-cycle-chat.md §5/§6.3
  "tools": [                        // the tool surface the adapter may call this turn (pre-scoped, §6.3 of chat doc)
    { "name": "get_transcript", "input_schema": { … } },
    { "name": "update_segment_text", "input_schema": { … } }
  ]
}
{ "type": "tool_result", "tool_call_id": "tc_1", "ok": true, "result": { … } }   // host's reply to a tool_call
{ "type": "cancel", "thread_id": "…" }                                            // Stop pressed
```

### 6.2 Adapter → host (streamed, one JSON object per line)
```jsonc
{ "type": "token", "text": "Found the segment — " }                 // text delta → ChatEvent::Token
{ "type": "tool_call", "id": "tc_1", "name": "update_segment_text",
  "input": { "interview_id": "iv3", "segment_id": 12, "text": "…" } } // → host executes against inv, replies tool_result
{ "type": "citation", "kind": "segment", "interview_id": "iv3", "segment_id": 12 }
{ "type": "done", "session_id": "…", "cost_usd": 0.0123 }            // turn complete → ChatEvent::Done
{ "type": "error", "message": "…", "retryable": false }             // → ChatEvent error
```

### 6.3 Semantics
- **Streaming:** the adapter emits `token` lines as they arrive. (A non-streaming adapter may emit
  one big `token` then `done` — the app still works, just no live typing; declare `streaming` absent.)
- **Tool-use:** the adapter emits `tool_call`; the **host runs it against the validated `inv`
  command** and writes back `tool_result`; the adapter continues. This makes any adapter-program CLI
  "agentic" without it ever touching our DB. (An adapter for a no-tool CLI simply never emits
  `tool_call` and instead, if it wants to edit, emits an action-proposal as a `tool_call` to a
  designated `propose_edit` tool — unifying the degrade path.)
- **Multi-turn:** the adapter returns `session_id` in `done`; the host stores it and sends it back in
  the next `turn`. An adapter with no session support returns `null` and the host replays prior turns
  in `system`/`text` (plan-B, feature-cycle-chat.md §4.2).
- **Cancel:** host sends `cancel` (and/or kills the child — feature-cycle-chat.md §4.2). The adapter
  should stop promptly; committed tool edits stay (undoable).
- **The host maps these 1:1 to the existing `ChatEvent` enum** (feature-cycle-chat.md §4.1/§4.3), so
  the **frontend is identical** across tiers — assistant-ui renders the same Token/ToolCall/Done
  events whether they came from `claude stream-json` (descriptor) or an adapter program. **This is
  the key reuse:** the protocol exists so the rest of the app doesn't care which tier produced the
  stream.

> **Why this shape:** it is deliberately the **least** protocol that bridges any CLI to our existing
> `ChatEvent`/MCP machinery — a strict subset of what ACP/MCP standardize (turn in, token/tool/done
> out), with tools relayed rather than re-hosted. No capability negotiation handshake beyond
> `protocol_version` (the manifest already declared capabilities). LSP/DAP/ACP/MCP are the prior art
> that this is a thin, app-specific instance of (§11).

---

## 7. How the runner targets a plugin (Rust core)

`adapter.rs` (batch) and `chat.rs` (agentic) become **plugin-driven dispatchers**:

```
run batch task t:                          run chat turn:
  plugin = active_batch_plugin()             plugin = active_chat_plugin()
  assert plugin.has("batch-tasks")           ctx, view, tools = build(...)  (chat doc §5/§6)
  spawn plugin.command + tasks[t].template   match plugin.chat.mode:
  stdin payload; parse io.result_extract       "descriptor":
  → task output JSON (product-spec §7.3)         spawn plugin.command + chat.stream.template
                                                 (+ session/tools args per capabilities)
                                                 parse via named parser (§3.4) → ChatEvent
                                               "adapter-program":
                                                 spawn plugin/adapter_program.command
                                                 speak stdio protocol (§6) → ChatEvent
                                             tool_call → execute inv command → tool_result
                                             (descriptor: CLI calls inv MCP directly)
```
Same spawn/isolation/auth scaffolding the current adapter has (CREATE_NO_WINDOW, neutral cwd, no
`--bare`). The **only new generality** vs. feature-cycle-chat.md is: read the active plugin's
manifest and switch on `chat.mode` + capabilities, instead of hardcoding the `claude` command line.

---

## 8. Graceful-degradation matrix

The app drives each CLI to its declared capabilities; the UI degrades, never breaks. Read top→bottom
as "what the user gets" by tier.

| Capabilities | Batch (Clean/Synth/Diff) | Chat answers | Chat editing | UI behavior |
|---|---|---|---|---|
| `batch-tasks` only | ✅ full | ❌ (no chat plugin) | — | Chat panel hidden / "no chat-capable plugin" note |
| `+ streaming` | ✅ | ✅ **streaming** Q&A, grounded + citations | ❌ read-only | live tokens, Stop button; no tool cards |
| `+ multi-turn` | ✅ | ✅ streaming **multi-turn** Q&A | ❌ read-only | thread continuity via session resume |
| `+ tool-use` (MCP or relay) | ✅ | ✅ | ✅ **full in-loop agentic edits** | tool cards ▸/✓/✕ + Undo; confirm-first for broad |
| streaming **absent** but multi-turn/tools present | ✅ | ✅ non-streaming (spinner → full answer) | ✅ if tool-use | answer appears at once; tool cards still render |
| tool-use **absent**, output parseable | ✅ | ✅ | ⚠️ **proposal-only** edits | agent proposes a JSON edit; app applies via validated mutation + Undo/confirm |
| tool-use **absent**, no structured output | ✅ | ✅ | ❌ | answers only; edits done by hand |

**Honest line:** **true in-loop agentic editing requires tool-use (MCP or the stdio relay).** A
CLI with no tool channel is **proposal-only** — it can suggest one edit per turn that the app applies
safely, but it cannot read-then-write-then-verify in a loop. Everything below "full agentic" is a
real, useful product; the matrix is the contract for "what you get."

---

## 9. Agent-facing meta-instruction — "Onboard a new CLI as a plugin"

> **This standalone section ships in-app (Settings → Add plugin…) and is written so any local AI
> agent can onboard a CLI unaided, with no source code and minimal effort. It extends product-spec
> §7.4 from "author a batch adapter" to "author a full plugin."**

**You are authoring a self-contained InterviewLab plugin so the app can drive a local AI CLI for
batch tasks and/or agentic chat — by dropping a folder into
`%APPDATA%/com.interviewlab.app/plugins/<id>/`. You will NOT edit the app's source.**

### 9.1 Decide the tier (one decision)
Run the CLI's `--help`. Ask:
1. Does it have a **one-shot prompt + machine-readable JSON** mode? (e.g. `-p … --output-format json`)
   → it can do **batch-tasks** descriptor-style.
2. Does it have a **streaming ndjson** mode whose events match a shipped parser
   (`claude-stream-json`, `gemini-stream-json`, `openai-jsonl`)? → **streaming** descriptor-style.
3. Does it have **session/resume**? → **multi-turn**.
4. Does it speak **MCP** (can load an MCP config and call `mcp__…` tools)? → **tool-use** descriptor-style.
**If all the needed answers are "yes" → Tier 1 (descriptor-only): write `manifest.json`, done, no
code.** If any needed piece doesn't map (bespoke output, no MCP, weird sessions) → **Tier 2: write a
small adapter program** that speaks the stdio protocol (§6) and normalizes the CLI.

### 9.2 Write the manifest (§3.2 schema; validate against `manifest.schema.json`)
- Set `id` = folder name; `command` = the executable; `capabilities` = the subset you verified.
- Fill the blocks for **only** those capabilities (orthogonality rule §3.2):
  - `io` + `tasks` for batch (copy product-spec §7.3 contracts; the prompt must say "return ONLY
    JSON matching this schema"; preserve segment ids/timing in cleanup; findings carry `goal_id` +
    evidence; diff is findings-level).
  - `chat.stream` (+ `parse`) for streaming; `chat.session` for multi-turn; `chat.tools` (MCP) for
    tool-use. Use the placeholders the app fills: `{prompt}`, `{system_prompt_file}`,
    `{mcp_config_file}`, `{session_id}`, and the app-managed `{mcp_args}/{session_args}/
    {allowed_tools_args}` groups.
- Write a `probe` (cheap command + exit code) and an `auth` note (prefer the CLI's own login over
  env keys; record any one-time interactive login the user must do once outside the app).

### 9.3 If Tier 2, write the adapter program (§6)
- Read one JSON `turn` line from stdin; invoke your CLI with `text` as the prompt and `system` as the
  system prompt; stream `token` lines to stdout as output arrives; emit `done` with a `session_id`.
- For tools: when your CLI wants to act, emit a `tool_call` line and **wait for the host's
  `tool_result` line** on stdin, then continue. (If your CLI has no tools, never emit `tool_call`;
  to still allow edits, emit a `tool_call` to `propose_edit`.)
- Honor `cancel`. Keep it tiny — a 50-line script is a fine adapter. Set
  `adapter_program.command`/`protocol_version` in the manifest.

### 9.4 Self-test the plugin (no app source; the agent does this)
1. **Manifest validity:** validate `manifest.json` against `assets/manifest.schema.json` (ship a
   checker, or the agent validates with any JSON-Schema tool). Fix errors until clean.
2. **Probe:** run the `probe` command; confirm the expected exit code (and that the CLI is logged in).
3. **Batch fixtures:** for each declared batch task, pipe the §7.3 example input through the exact
   `command + tasks[t].args_template`; confirm valid output JSON of the right shape (cleanup
   preserves ids/timing; synthesis findings have `goal_id`+evidence; diff is findings-level).
4. **Chat smoke (descriptor):** run the `chat.stream` command on a trivial prompt; confirm the named
   parser yields ≥1 token event and a final event carrying a `session_id`. If `tool-use`: point the
   CLI at a stub MCP config and confirm it can list/call a tool.
5. **Chat smoke (adapter-program):** feed one `turn` line to the program; confirm it emits `token…
   done` and, given a `tools` list + a synthesized `tool_result`, completes a `tool_call` round-trip.
6. **Install:** drop the folder in `plugins/<id>/`, open Settings → Rescan, select the plugin, click
   Test CLI → Available. Run one real Clean and (if chat) one real question.

### 9.5 Worked example — Claude Code (the reference plugin)
- **Tier:** descriptor-only (all four capabilities). **Manifest:** §3.2 verbatim. **Why each flag:**
  `-p --output-format json` (batch), `stream-json --verbose --include-partial-messages` (token
  stream), `--resume` (multi-turn), `--mcp-config … --strict-mcp-config` + `--allowedTools` +
  `--tools ""` + `--permission-mode dontAsk` (scoped MCP tools, no built-ins), `--setting-sources ""`
  + neutral cwd + **no `--bare`** (isolation + subscription auth). All verified in
  feature-cycle-chat.md §4.2 and product-spec §7.2. **No adapter program, no code.** This is the
  template an agent clones for the next descriptor-tier CLI (e.g. Gemini CLI: swap `command`, set
  `parse:"gemini-stream-json"`, adjust the MCP-config flag names).

---

## 10. Security & trust model (honest)
- **Descriptor tier** runs only the user's already-installed CLI with app-built args — same trust as
  today's batch adapter; the manifest is data. The agent's **blast radius is the `inv` tool surface**
  (scoped, validated, deny-by-default — feature-cycle-chat.md §6.1/§6.4), not the filesystem
  (`--tools ""`, `--strict-mcp-config`).
- **Adapter-program tier** runs **third-party code** with the user's privileges. This is the same
  trust as "install this CLI," but make it explicit: Settings shows adapter-program plugins with a
  **"runs external program: `<path>`"** label and requires an explicit enable. v1 recommendation:
  **ship descriptor-only by default**; adapter-program is a documented, opt-in extension point (§12).
- All **data mutations** — from any tier — go through the **same validated `inv` commands** with the
  same Undo/confirm/audit log (feature-cycle-chat.md §6.5). A plugin can never bypass invariants.

---

## 11. Research & prior art (verified June 2026 — cite URLs)

**MCP is the universal, stdio, tool layer.** MCP is a JSON-RPC 2.0 protocol; a *server* exposes
**tools** (name + JSON-Schema input + `tools/call`) over **stdio** (local) or Streamable HTTP
(remote); any **host/client** discovers via `tools/list` and invokes via `tools/call`, with
capability negotiation at init. One server therefore serves any MCP-capable host — exactly our
"portable tools" need.
([MCP architecture](https://modelcontextprotocol.io/docs/concepts/architecture))

**MCP-capable agent CLIs in 2026 (so the descriptor tier covers the field):** Claude Code; Cursor
(+ Cursor Agents CLI); GitHub Copilot (VS Code agent mode, MCP native since Feb 2026); OpenAI Codex
(plugins bundle MCP configs, Jun 2026); Google Gemini CLI / Antigravity CLI. "All of these tools now
support MCP, making it the universal standard."
([Best MCP clients 2026](https://toolradar.com/guides/best-mcp-clients),
[AI coding agents 2026](https://lushbinary.com/blog/ai-coding-agents-comparison-cursor-windsurf-claude-copilot-kiro-2026/),
[MCP servers for Claude Code/Cursor/Codex](https://www.totalum.app/blog/best-mcp-servers-2026))

**Headless JSON modes mirror Claude Code (so descriptor batch+stream port cleanly).** Gemini CLI has
`-p/--prompt` headless mode with `--output-format json` (single JSON object: response + usage) and
`--output-format stream-json` (newline-delimited JSONL events) — the same shape feature-cycle-chat.md
parses for Claude Code. This is why a Gemini plugin is descriptor-only (manifest + `parse:
"gemini-stream-json"`), no code.
([Gemini CLI headless](https://geminicli.com/docs/cli/headless/),
[Gemini CLI headless md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md))

**Stable stdio-JSON protocols as the bridge pattern (justifies the adapter-program tier).** The
"host speaks one protocol; an external program implements it" pattern is established prior art: **LSP**
(editors↔language servers), **DAP** (editors↔debuggers), **MCP** itself (hosts↔tool servers), and
**ACP — Agent Client Protocol** ("the LSP for AI coding agents"; JSON-RPC 2.0 over stdin/stdout;
created by Zed, Aug 2025; 25+ agents by Mar 2026 incl. Gemini CLI as first external integration and
GitHub Copilot CLI in Jan 2026; native support in Zed and JetBrains). Our §6 protocol is a thin,
app-specific instance of this family (turn in → token/tool_call/done out), so we adopt the pattern,
not a new framework.
([ACP repo](https://github.com/agentclientprotocol/agent-client-protocol),
[Zed ACP](https://zed.dev/acp),
[ACP = LSP for agents](https://blog.marcnuri.com/agent-client-protocol-acp-introduction),
[ACP external agents in Zed](https://zed.dev/docs/ai/external-agents))

**Capabilities common CLIs expose (so the tiers are realistic):** streaming (Claude Code
`stream-json`, Gemini `stream-json`), sessions/multi-turn (Claude `--resume`; Gemini sessions),
tool-use via MCP (all of the above). Coverage is broad enough that **descriptor-only handles the
mainstream**, leaving the adapter-program tier for the genuine long tail.

> **Note on ACP as an alternative:** we could have made the host an **ACP client** and required
> plugins to be ACP agents. Rejected for v1 as heavier than needed: ACP standardizes editor-style
> concerns (file diffs, permissions, follow) we don't need, and most CLIs reach us fine via the
> descriptor tier's MCP path. Our §6 protocol is intentionally smaller. **If** the adapter-program
> tier ever needs to grow, **adopting ACP wholesale is the documented upgrade** — not reinventing more
> of it.

---

## 12. Feasibility verdict & v1 recommendation

**Verdict: feasible, and largely already built.** The hard parts exist: batch adapters already load
from a drop-in folder with **zero source changes** (product-spec §7), and feature-cycle-chat.md
already specifies the streaming/multi-turn/MCP-tool runner. This doc's net new work is **(a)** widen
the descriptor into a capability-declaring **manifest** (additive, back-compatible), **(b)** make the
runner switch on the active plugin's manifest instead of hardcoding `claude`, and **(c)** the
stdio-protocol **adapter-program tier** — which is the only genuinely new runtime, and is **deferrable**.

**Recommended v1 scope (lazy senior call):**
1. **Descriptor-tier plugins + the capability manifest** (batch + chat), with **Claude Code as the
   bundled reference plugin**. This delivers the full promise for every MCP-capable CLI (the entire
   2026 mainstream) with **near-zero new runtime** — it's mostly the manifest + a plugin-aware
   dispatcher over code feature-cycle-chat.md already calls for.
2. **The MCP `inv` server** (feature-cycle-chat.md §4.3) — the portable tool layer, plugin-independent.
3. **Ship two descriptor plugins as proof** (Antigravity CLI + Qwen Code) to validate "any CLI, no source change."
4. **The adapter-program tier = a fully documented extension point in v1** (§6 protocol frozen at
   `protocol_version: 1`, the agent-facing doc §9.3, security label §10), with the **adapter-program
   runtime as a fast-follow** — build it when a real CLI needs it. This is the leaner path: don't
   build a relay runtime speculatively when the descriptor tier already covers the field.

**Honest limits:**
- **In-loop agentic editing requires tool-use (MCP or the §6 relay).** Non-tool CLIs are
  **proposal-only** (§8) — useful, but one edit per turn, no read-then-verify loop.
- **Adapter-program plugins run third-party code** with user privileges (§10) — descriptor-only is
  the safe default; gate adapter programs behind an explicit enable.
- **Descriptor coverage depends on the CLI matching a shipped stream parser** (§3.4). A novel stream
  shape forces the adapter-program tier — by design (keeps "new format" out of the app's source).
- **Quality/quota** limits are per-CLI (a CLI on a small model gives weaker synthesis; subscription
  CLIs hit usage caps) — surfaced, not solved here (product-spec §10, feature-cycle-chat.md §9).

---

## 13. Integration with M11 (the chat milestone)

feature-cycle-chat.md's M11 plan is **unchanged in substance** but reframed **plugin-first**:
- The streaming/tool runner (M11 Phase A–C) targets the **active chat plugin's declared
  capabilities** via the manifest dispatcher (§7), instead of hardcoding the `claude` command line.
  Concretely: M11 step 3 ("streaming runner") reads `chat.stream.args_template` + `parse` from the
  manifest; steps 7/10 ("MCP read/write tools") wire the **plugin-independent `inv` server** that any
  descriptor-tier CLI consumes and the adapter-program tier relays to.
- **Claude Code ships as the bundled reference plugin** (§2.1), so M11's "verify with `claude login`"
  steps are unchanged — Claude Code is just the first plugin, exercised end-to-end.
- **New, small M11 additions** (fold into Phase A + Hardening): the **plugin loader + manifest
  validation + Settings plugin list** (§2–§3), and the **manifest-driven dispatcher** in
  `adapter.rs`/`chat.rs` (§7). **Deferred to a fast-follow milestone (call it M12):** the
  **adapter-program stdio runtime** (§6) — spec it now (frozen protocol), build it when needed.
- Net: M11 stays the same shippable A→B→C, with "hardcoded Claude Code" swapped for "active plugin =
  Claude Code by default." No new risk; the agentic surface still proves out on Claude Code first.

---

## 14. Summary of key decisions (for confirmation)

- **One plugin layer for both batch and chat**, discovered from
  `%APPDATA%/com.interviewlab.app/plugins/<id>/` (folder = manifest + optional adapter program +
  README), back-compatible with today's flat `adapters/*.json`. No app source changes to onboard a CLI.
- **Manifest = M6 descriptor + capability block + chat/tools/adapter-program blocks.** Capabilities
  (`batch-tasks`/`streaming`/`multi-turn`/`tool-use`) drive graceful degradation in data form.
- **Two drop-in tiers:** **descriptor-only** (pure JSON; covers every MCP-capable 2026 CLI — Claude
  Code, Gemini, Cursor, Copilot, Codex) and **adapter-program** (a plugin-shipped program speaking a
  stable stdio-JSON protocol; for the long tail).
- **Tools are portable via one `inv` MCP server** the app owns; descriptor CLIs call it directly,
  adapter programs relay to it, no-tool CLIs degrade to validated action-proposals — all through the
  same Undo/confirm safety.
- **Reuse, not invention:** MCP for tools + a thin stdio protocol modeled on LSP/DAP/ACP; no bespoke
  plugin framework, no second agent loop.
- **v1 = descriptor-only + Claude Code reference plugin + (Antigravity CLI + Qwen Code as proof) + the documented
  adapter-program extension point;** adapter-program runtime is a fast-follow (M12).

### Decisions the founder should confirm
1. **Folder location & format:** `%APPDATA%/com.interviewlab.app/plugins/<id>/manifest.json`
   (folder-per-plugin) + keep loading legacy `adapters/*.json`. Confirm the path and that
   `manifest.json` (alias `adapter.json`) is the filename.
2. **v1 tier scope:** ship **descriptor-only + Claude Code reference plugin** now, with the
   **adapter-program tier as a documented, frozen extension point** and its runtime as fast-follow
   (recommended). Or build the adapter-program runtime in v1 too?
3. **Reload behavior:** filesystem-watch auto-reload vs. a **manual "Rescan plugins" button** as the
   v1 floor (recommended floor; watch as a nicety).
4. **Proof plugins (CONFIRMED):** ship **Antigravity CLI** + **Qwen Code** descriptor plugins in v1 to
   validate "any CLI, no source change." Their exact descriptors (headless flag, stream parser,
   MCP-config flag, auth) are verified per-CLI during authoring — Qwen Code is a Gemini-CLI fork so it
   reuses the gemini-style stream parser; Antigravity CLI's interface is confirmed against its docs.
   Full round-trip is verifiable only if the CLI is installed + logged in; otherwise the descriptor
   ships and "Test CLI" reports its status.
5. **Adapter-program trust gate:** require explicit per-plugin enable + a "runs external program"
   label (recommended), and is descriptor-only the safe default?
6. **Stream-parser set:** v1 ships `claude-stream-json` + `gemini-stream-json` (covers **Qwen Code**, a
   Gemini-CLI fork) + a generic `openai-jsonl`; **Antigravity CLI**'s parser is confirmed during
   authoring (add one if its shape differs). adapter-program is the seam for any other shape.

### Source references (verified June 2026)
- MCP architecture (JSON-RPC 2.0, stdio, server tools, hosts/clients, capability negotiation) —
  https://modelcontextprotocol.io/docs/concepts/architecture
- MCP-capable agent CLIs 2026 (Claude Code, Cursor, Copilot, Codex, Gemini/Antigravity) —
  https://toolradar.com/guides/best-mcp-clients ;
  https://lushbinary.com/blog/ai-coding-agents-comparison-cursor-windsurf-claude-copilot-kiro-2026/ ;
  https://www.totalum.app/blog/best-mcp-servers-2026
- Gemini CLI headless `-p` + `--output-format json|stream-json` —
  https://geminicli.com/docs/cli/headless/ ;
  https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
- ACP / stdio-JSON bridge prior art (LSP-for-agents; Zed; JSON-RPC over stdio; 25+ agents) —
  https://github.com/agentclientprotocol/agent-client-protocol ; https://zed.dev/acp ;
  https://blog.marcnuri.com/agent-client-protocol-acp-introduction ; https://zed.dev/docs/ai/external-agents
- Claude Code flags + auth (descriptor reference plugin) — see feature-cycle-chat.md §10 source list
  and product-spec §7.2 (https://code.claude.com/docs/en/cli-reference ,
  https://code.claude.com/docs/en/headless , https://code.claude.com/docs/en/mcp)
- Superseded/extended internal docs: product-spec.md §7 (descriptor + §7.4 meta-instruction);
  feature-cycle-chat.md (Claude Code chat → now plugin-driven)
