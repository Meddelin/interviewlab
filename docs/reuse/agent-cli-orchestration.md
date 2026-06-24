# Reuse Landscape: Driving a Local AI CLI in an Agent Loop

**Scope:** OSS we can REUSE (as a dependency), REFERENCE (borrow design), or SKIP for the
"drive a locally installed AI CLI in an agent loop" problem in **InterviewLab** — a Tauri 2
desktop app (Rust core, React/shadcn UI). MVP target = **Claude Code headless**, auth via the
user's `claude login` **subscription** session (not an API key).

**Verified:** 2026-06-22. Star counts are approximate (live GitHub at time of writing, ±a few k);
license / maintenance / version facts verified directly against each repo/registry.

---

## TL;DR / Recommended approach

**Shell out to `claude -p` from Rust via `tauri-plugin-shell`.** It is the simplest, smallest, and
*only fully ToS-compliant* way to drive a **subscription** Claude session headlessly, and it drops
straight into a Tauri app with no Node/Python runtime to bundle. The official Claude Agent SDK is a
strong product but is **Node-only** and **API-key-first** — it would force you to bundle a Node
sidecar and the subscription path is the second-class one. Reach for the SDK only if/when you need
its richer features (in-process tool callbacks, MCP client, session resumption with permission
hooks). No third-party agent framework gives you a license-clean, subscription-capable, Rust-native
library — they are all **reference**, not **reuse**.

> Lazy-senior-dev verdict: **shelling out wins.** A CLI subprocess + JSON parse is ~50 lines of Rust
> you fully control. The SDK is genuinely capable but is not "strictly better" for *this* app: it
> adds a Node runtime and points you at API-key auth, which is precisely the constraint we're
> avoiding. Keep the shell-out; keep the pluggable adapter descriptor as your extensibility story.

---

## The decisive constraint: subscription auth, headless

Two 2026 policy facts drive every verdict:

1. **Third-party harnesses can no longer use a Claude Pro/Max subscription.** Starting ~April 2026
   (the "OpenClaw" enforcement), Anthropic blocks third-party tools from driving a subscription
   session; that capability is reserved for **Anthropic's own Claude Code** (and the official Agent
   SDK *when it routes through a local Claude Code session*). Using OpenCode/Aider/Cline/etc. against
   a subscription is now a ToS violation and is being actively cut off.
   ([VentureBeat](https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and),
   [TNW](https://thenextweb.com/news/anthropic-openclaw-claude-subscription-ban-cost))

2. **The Agent SDK itself is API-key-first.** As of Feb 2026 the Agent SDK "cannot use OAuth tokens
   from Free/Pro/Max accounts" *directly*. **BUT** it can authenticate **through an existing local
   Claude Code session** when you use the bundled local Claude Code binary — i.e. if the user has run
   `claude login`, the SDK rides that session. For local desktop use "nothing changes"; the API-key
   requirement bites for "business or always-on deployments."
   ([Agent SDK auth](https://code.claude.com/docs/en/agent-sdk/overview),
   [OAuth vs API key](https://lalatenduswain.medium.com/claude-api-authentication-in-2026-oauth-tokens-vs-api-keys-explained-12e8298bed3d),
   [June 15 credit change](https://proveai.com/blog/anthropics-agent-sdk-credit-june-15))

**Conclusion:** the *only* clean subscription-headless paths are (a) shell out to the official
`claude` CLI, or (b) drive the Agent SDK *configured to use the local Claude Code session*. Both go
through the user's `claude login`. Every other tool is API-key-only or non-compliant for subscription.

---

## Comparison table

| Name | Stars | Maintained | License | Runtime | Drives **subscription** CLI headless? | Verdict |
|---|---|---|---|---|---|---|
| **Claude Agent SDK** (TS) | ~1.6k | Yes — v0.3.185 (Jun 20 2026) | Anthropic Commercial ToS / MIT-ish SDK | **Node 18+** (bundles `claude` binary) | **Yes, via local Claude Code session**; API-key otherwise | **REUSE (conditional)** |
| **Claude Agent SDK** (Python) | — | Yes | same | **Python** (bundles `claude` binary) | Same as TS | REUSE (conditional) |
| `claude -p` **CLI** (shell out) | — (anthropics/claude-code) | Yes | proprietary, user-installed | none (subprocess) | **Yes** — native subscription path | **REUSE (the MVP)** |
| **OpenCode** (sst) | ~177k | Yes — v1.17.x (daily) | MIT | TS/Node (Bun) | Login exists but **prohibited**; API-key in practice | REFERENCE |
| **Aider** | ~46.6k | Yes (commits May 2026) | Apache-2.0 | Python | No (API-key) | REFERENCE |
| **Cline** | ~63.7k | Yes — CLI v3.0.x | Apache-2.0 | TS/Node | No (API-key); real headless **SDK** | REFERENCE (≈REUSE) |
| **Roo Code** | ~24.3k | **No — archived May 2026** | Apache-2.0 | TS | N/A (dead) | SKIP |
| **Goose** (Block) | ~50k | Yes — v1.38.0 | Apache-2.0 | **Rust** core | Via **ACP** delegation only; API-key direct | REFERENCE |
| **Continue** | ~34.3k | **No — read-only/frozen (v2.0)** | Apache-2.0 | TS | No | SKIP (live), REFERENCE (schema) |
| **Plandex** | ~15.5k | Slowing (last tag Jul 2025) | MIT | **Go** | Claims sub-login, now **non-compliant** | REFERENCE / SKIP |
| **Crush** (Charm) | ~25.6k | Yes — v0.79.x | **FSL-1.1-MIT** (non-compete) | **Go** | No (API-key) | REFERENCE (license-cautious) |
| **Sketch** (Bold) | ~700 | **No — superseded by Shelley** | Apache-2.0 | Go | No (API-key) | SKIP |
| **OpenHands** | ~78k | Yes — v1.8.0 | **MIT** (core; `enterprise/` separate) | Python/TS | No (BYO-key / ACP) | REFERENCE |
| **Kilo Code** | ~24k | Yes — v7.3.x | MIT | TS | No (BYO-key) | REFERENCE |

---

## 1. Frameworks/SDKs that programmatically drive Claude Code

### Claude Agent SDK — `@anthropic-ai/claude-agent-sdk` (TS) / `claude-agent-sdk` (Python)

- **What:** The exact agent loop that powers Claude Code, exposed as a library. Renamed Sep 2025 from
  "Claude Code SDK." ([npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
  [repo](https://github.com/anthropics/claude-agent-sdk-typescript),
  [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript))
- **State:** v0.3.185 (Jun 20 2026), ~1.6k stars, actively maintained (146 releases). **Requires
  Node 18+** (or Python). The TS package **bundles a native Claude Code binary** as an optional dep —
  `npm install` is enough.
- **Gives you:** file-edit/bash/web tools, a tool-use loop with **human-in-the-loop checkpoints**,
  **subagents**, **persistent sessions**, **first-class MCP client**, streaming messages, and a
  programmatic permission system. Structured output and JSON streaming are first-class.
- **Subscription headless?** **Yes — but only via the local Claude Code session** (rides `claude
  login`). Direct OAuth tokens are *not* accepted by the SDK; the default/blessed path is
  `ANTHROPIC_API_KEY`. ([overview](https://code.claude.com/docs/en/agent-sdk/overview))
- **Runtime cost for us:** dragging in a **Node sidecar** (the SDK is JS/Python; there is no Rust
  crate). For a Tauri app that otherwise has zero Node at runtime, this is a real bundle-size and
  packaging tax.
- **Verdict: REUSE (conditional).** Embed it via a Node sidecar **only if** you outgrow plain
  shell-out and need in-process tool callbacks / permission hooks / session resume. For the MVP it's
  more machinery than the problem needs.

### `@anthropic-ai/claude-code` (the CLI itself)

- The CLI we shell out to. Headless contract is stable and documented:
  `claude -p "<prompt>" --output-format json` returns a JSON envelope with the answer in the
  **`result`** field plus metadata (cost, session id). Add **`--json-schema '<schema>'`** to get
  validated data in a top-level **`structured_output`** field. Parse with `jq '.result'` /
  `jq '.structured_output'`. ([headless docs](https://code.claude.com/docs/en/headless),
  [structured output issue #9058](https://github.com/anthropics/claude-code/issues/9058))
- Pipe the payload on **stdin** (keeps prompts off the process arg list / out of `ps`), use
  `--setting-sources "" --strict-mcp-config` to isolate from the user's global config. This matches
  the InterviewLab MVP plan exactly. **Verdict: REUSE — this is the MVP.**

---

## 2. Open agentic CLI ecosystems

None can legally drive a **subscription** Claude session as a library, and none ship a license-clean,
Rust-native, embeddable runtime. They are design references. Highlights:

- **Goose (Block)** — Apache-2.0, **Rust** core, MCP-native, and crucially delegates to an external
  official agent via **ACP (Agent Client Protocol)**. This is the *closest architectural analogue to
  our shell-out model* and the best single reference for a Rust app.
  [github.com/block/goose](https://github.com/block/goose). **REFERENCE.**
- **Cline** — Apache-2.0; ships a genuine **`@cline/sdk`** with an explicit fully-headless mode. The
  cleanest embeddable, permissively-licensed headless agent runtime here — but Node + API-key.
  [docs.cline.bot/sdk/overview](https://docs.cline.bot/sdk/overview). **REFERENCE (≈REUSE).**
- **OpenCode (sst)** — MIT, 177k stars, clean client/server headless protocol + SDK; best study for
  a JSON-streaming CLI contract. Login path is prohibited by Anthropic.
  [github.com/sst/opencode](https://github.com/sst/opencode). **REFERENCE.**
- **OpenHands** — MIT core (avoid the separately-licensed `enterprise/` dir); richest sandbox +
  agent-server REST reference, but a heavy Python service.
  [github.com/All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands). **REFERENCE.**
- **Aider** — Apache-2.0; gold-standard repo-map / diff-application design.
  [github.com/Aider-AI/aider](https://github.com/Aider-AI/aider). **REFERENCE.**
- **Crush (Charm)** — Go, **FSL-1.1-MIT** (source-available, 2-yr non-compete; converts to MIT after
  2 years; **not OSI-approved**). Safe to read, **do not vendor into a competing product.** Mods
  (its predecessor) is archived/MIT. [github.com/charmbracelet/crush](https://github.com/charmbracelet/crush).
  **REFERENCE (license-cautious).**
- **SKIP:** **Roo Code** (archived May 2026), **Continue** (read-only/frozen, acquired by Cursor),
  **Sketch** (superseded by "Shelley", ~700 stars, Docker-only, no native Windows — and our MVP
  target is Windows), **Plandex** (MIT/Go and license-safe but momentum stalled, cloud sunset, no
  embeddable library). **Kilo Code** (MIT, active, but VS-Code-centric TS) — REFERENCE only.

### License red flags in this cluster
- **No GPL/AGPL** among the agent frameworks above — good for a distributed desktop app.
- **Crush = FSL** (non-compete) — read, don't vendor.
- **OpenHands** has a separately-licensed `enterprise/` subdir — stay in the MIT core.

---

## 3. Process/stream plumbing for Tauri/Rust spawning a CLI

This is solved and well-trodden. Two layers:

### (a) `tauri-plugin-shell` sidecar — the recommended path
Bundle the binary (or just call the user-installed `claude` via the shell `Command`), spawn it, and
stream stdout line-by-line. ([Tauri sidecar docs](https://v2.tauri.app/develop/sidecar/),
[Shell plugin](https://v2.tauri.app/plugin/shell/),
[stream stdout discussion #8641](https://github.com/tauri-apps/tauri/discussions/8641))

```rust
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

let cmd = app.shell().command("claude")
    .args(["-p", "--output-format", "json", "--setting-sources", "", "--strict-mcp-config"]);
let (mut rx, mut child) = cmd.spawn()?;           // child handle = cancel via child.kill()
// write the payload to child.write(stdin_bytes)?;
tauri::async_runtime::spawn(async move {
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => { /* emit to UI via app.emit("claude://chunk", ..) */ }
            CommandEvent::Terminated(payload) => { /* done; parse final JSON .result */ }
            _ => {}
        }
    }
});
```

- **Progress/cancel:** the `child` handle gives you `child.kill()` for a cancel button; `rx` gives
  you a stream you forward to the React UI with `app.emit(...)`.
- **Permissions:** capability config needs `shell:allow-spawn` (or `shell:allow-execute`), scoped to
  the `claude` command/sidecar. ([Shell plugin perms](https://v2.tauri.app/plugin/shell/))
- For a bundled sidecar, add to `tauri.conf.json` `bundle.externalBin` with the `-$TARGET_TRIPLE`
  suffix; for the user-installed `claude`, scope the command name in capabilities instead.

### (b) Raw `tokio::process` — the lower-level escape hatch
If you want to bypass the plugin's command-scoping for full control, `tokio::process::Command` with
`Stdio::piped()` + `BufReader::new(stdout).lines()` and `AsyncBufReadExt::next_line()` streams JSON
lines; use `tokio::select!` between `child.wait()` and a cancel token, and `kill_on_drop(true)` for
cleanup. ([tokio::process docs](https://docs.rs/tokio/latest/tokio/process/index.html),
[Child](https://docs.rs/tokio/latest/tokio/process/struct.Child.html),
[practical guide](https://danielmschmidt.de/posts/2023-03-23-managing-processes-in-rust/))

**Verdict:** Use **tauri-plugin-shell** (it already wraps tokio process, gives you the
`CommandEvent` stream + capability scoping for free). Drop to raw `tokio::process` only if the
plugin's scoping gets in the way. No third-party crate needed — this is stdlib-adjacent.

---

## 4. Prior art for a CLI-adapter / descriptor pattern

**Key finding: no existing OSS ships a declarative "spawn this AI CLI, pass the prompt via
stdin/arg, parse the result at a JSON path" descriptor.** Every mature LLM tool (Continue, aichat,
`llm`, Open Interpreter, mods) models *providers* as **HTTP/OpenAI-compatible endpoints**. The
"spawn a binary" half is solved separately and best by **MCP's `mcpServers` descriptor**. So you
**compose** proven pieces rather than copy one schema.

### Building blocks to borrow
- **CLI-spawn skeleton → MCP `mcpServers`** (Anthropic open spec, MIT SDKs): the most battle-tested
  declarative "launch a local stdio binary + inject auth via `env`" schema — `{ command, args[],
  env{}, type: "stdio" }`. JSON, trivially serde-able in Rust. It *lacks* a prompt-passing mode and
  output extraction (MCP uses JSON-RPC framing, so it never needed them).
  ([MCP local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers))
- **Output extraction → OpenAI CLI `--transform`** uses a jq-like path selector over command JSON
  output — exact precedent for an `outputPath` field. (`jq`/JSONPath, MIT, is the path language.)
  VS Code `tasks.json` `problemMatcher` is the regex/text analogue.
  ([OpenAI CLI](https://developers.openai.com/api/docs/libraries/openai-cli))
- **HTTP-provider descriptor (for the OpenAI-compatible case) → aichat's discriminated union**
  (`sigoden/aichat`, **MIT OR Apache-2.0, Rust** — you could lift the serde structs). `clients[]`
  keyed by `type` with an `openai-compatible` escape hatch + per-model capability flags.
  Zed's `language_models.openai_compatible` is an equally clean *design* reference (but Zed core is
  **GPL-3.0** — design only) and pioneers the good **"keys out of the config file"** pattern
  (env var / OS keychain). ([aichat](https://github.com/sigoden/aichat),
  [Zed AI](https://zed.dev/docs/ai/use-api-access))
- **Spawn-for-credential auth → mods `api-key-cmd`** (charmbracelet/mods, MIT, archived) proves the
  "run a command to mint/fetch the credential" idiom — useful since our auth is a `claude login`
  session, not a static key. ([mods](https://github.com/charmbracelet/mods))

### License flags in this cluster
- **Open Interpreter (classic Python) = AGPL-3.0** — RED FLAG, do not lift code (its Rust rewrite is
  Apache-2.0 and fine). **tgpt = GPL-3.0** — copyleft, shell-out only. **Zed = GPL-3.0** (server
  parts AGPL) — design only. Config *schemas/field names* themselves aren't practically
  copyrightable, so you can reimplement any of these designs freely; the license matters only if you
  vendor/fork actual source.

### Borrowed adapter-descriptor schema (recommended)
MCP skeleton + GitHub-Actions-style `{prompt}` placeholder + jq `outputPath` + explicit auth block:

```jsonc
{
  "id": "claude-code",
  "command": "claude",
  "args": ["-p", "--output-format", "json", "--setting-sources", "", "--strict-mcp-config"],
  "env": {},
  "promptInput": "stdin",               // "stdin" | "arg" (validated by cursor-api-proxy)
  "outputPath": ".result",              // jq/JSONPath (validated by OpenAI CLI --transform)
  "structuredOutput": {                  // optional: maps to --json-schema + .structured_output
    "schemaArg": "--json-schema",
    "resultPath": ".structured_output"
  },
  "auth": { "type": "session", "loginCmd": "claude login" }  // mods api-key-cmd shows the spawn-for-cred variant
}
```

This descriptor cleanly covers the MVP (`claude -p`) and onboards any future CLI by editing config —
no code change, which is exactly the "agent authors a descriptor" goal.

---

## Sources
- Claude Agent SDK: [npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) ·
  [repo](https://github.com/anthropics/claude-agent-sdk-typescript) ·
  [overview/auth](https://code.claude.com/docs/en/agent-sdk/overview) ·
  [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- Claude Code headless: [docs](https://code.claude.com/docs/en/headless) ·
  [structured output #9058](https://github.com/anthropics/claude-code/issues/9058)
- Subscription policy: [VentureBeat](https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and) ·
  [OAuth vs API key](https://lalatenduswain.medium.com/claude-api-authentication-in-2026-oauth-tokens-vs-api-keys-explained-12e8298bed3d) ·
  [June 15 credit](https://proveai.com/blog/anthropics-agent-sdk-credit-june-15)
- Tauri: [sidecar](https://v2.tauri.app/develop/sidecar/) · [shell plugin](https://v2.tauri.app/plugin/shell/) ·
  [stream stdout](https://github.com/tauri-apps/tauri/discussions/8641)
- tokio::process: [docs.rs](https://docs.rs/tokio/latest/tokio/process/index.html)
- Agent frameworks: [Goose](https://github.com/block/goose) · [Cline SDK](https://docs.cline.bot/sdk/overview) ·
  [OpenCode](https://github.com/sst/opencode) · [OpenHands](https://github.com/All-Hands-AI/OpenHands) ·
  [Aider](https://github.com/Aider-AI/aider) · [Crush](https://github.com/charmbracelet/crush)
- Descriptor prior art: [MCP](https://modelcontextprotocol.io/docs/develop/connect-local-servers) ·
  [aichat](https://github.com/sigoden/aichat) · [Zed AI](https://zed.dev/docs/ai/use-api-access) ·
  [mods](https://github.com/charmbracelet/mods) · [OpenAI CLI](https://developers.openai.com/api/docs/libraries/openai-cli)
