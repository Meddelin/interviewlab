// CLI-adapter layer (Milestone 6, spec §7).
//
// Three concerns live here:
//   1. Adapter descriptor (§7.1) + loader — the bundled Claude Code default plus any
//      user-authored descriptors in %APPDATA%/InterviewLab/adapters/*.json.
//   2. Generic task runner (§7.2) — render a prompt (instructions + required output
//      schema + input JSON), spawn the CLI per the descriptor (neutral cwd, payload on
//      stdin), parse the JSON envelope's `result` field, tolerant of prose/markdown
//      fences, one retry, timeout, typed errors. This is what M7–M9 will call.
//   3. "Test CLI" probe (§4.4) — `--version` (installed?) then a tiny round-trip
//      (logged in?) → Available / Not found / Not logged in.
//
// CRITICAL auth detail (spec §7.2, verified on this machine): the `claude` CLI uses the
// user's subscription login (`claude login`), NOT an API key. So we invoke plain `-p`
// (NOT `--bare`, which forces ANTHROPIC_API_KEY) with isolation flags
// `--setting-sources "" --strict-mcp-config` and a neutral cwd. No env var is required.
//
// Conventions mirror cycle.rs/asr.rs: typed structs, each #[tauri::command] a thin
// wrapper over a testable helper; errors stringified for the frontend.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

// --- descriptor schema (spec §7.1) --------------------------------------------

// The probe block: a cheap command + the exit code that means "installed".
#[derive(Serialize, Deserialize, Clone)]
pub struct Probe {
    pub args: Vec<String>,
    #[serde(default)]
    pub expect_exit_code: i32,
}

// Informational auth note. `type` is reserved (rust keyword) so it maps via rename.
#[derive(Serialize, Deserialize, Clone)]
pub struct Auth {
    #[serde(rename = "type")]
    pub auth_type: String, // 'session' | 'env' | ...
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub note: String,
}

// How to pull the task JSON out of the CLI's stdout envelope.
#[derive(Serialize, Deserialize, Clone)]
pub struct ResultExtract {
    pub format: String, // 'json' | 'raw'
    #[serde(default)]
    pub json_path: String, // field in the JSON envelope holding our payload string (e.g. "result")
}

fn default_timeout_sec() -> u64 {
    600
}
fn default_max_stdin_bytes() -> u64 {
    10_000_000
}

// The io block: where the payload + prompt go, how to extract the result, limits.
#[derive(Serialize, Deserialize, Clone)]
pub struct Io {
    pub payload_via: String, // 'stdin' | 'arg' | 'file'
    #[serde(default)]
    pub prompt_via: String, // where the rendered prompt text goes (we use {prompt} in args)
    pub result_extract: ResultExtract,
    #[serde(default = "default_timeout_sec")]
    pub timeout_sec: u64,
    #[serde(default = "default_max_stdin_bytes")]
    pub max_stdin_bytes: u64,
}

// One task entry: the arg template with {prompt} placeholders.
#[derive(Serialize, Deserialize, Clone)]
pub struct TaskSpec {
    pub args_template: Vec<String>,
}

// --- chat capability block (M11 Phase A; feature-cli-plugins.md §3.2) ----------
//
// The manifest is a SUPERSET of the M6 descriptor: the `chat` block declares the
// streaming/multi-turn capability the chat runner (chat.rs) drives PLUGIN-FIRST.
// Phase A reads `chat.stream` (the streaming arg template + named parser) and
// `chat.session` (resume args). The `tools` block (MCP) is Phase B/C and is left
// out of the bundled descriptor for now. ponytail: only the fields Phase A fills.

// The streaming sub-block: how to invoke the CLI for a streaming chat turn + which
// named parser reads its ndjson stream.
#[derive(Serialize, Deserialize, Clone)]
pub struct ChatStream {
    // Arg template with the placeholders chat.rs fills: {prompt}, {system_prompt_file},
    // {session_args} (+ {mcp_args}/{allowed_tools_args}, empty in Phase A).
    pub args_template: Vec<String>,
    // The named stream parser the app ships (§3.4). Phase A ships "claude-stream-json".
    #[serde(default)]
    pub parse: String,
}

// The multi-turn sub-block: how to resume a session by id.
#[derive(Serialize, Deserialize, Clone)]
pub struct ChatSession {
    // e.g. ["--resume", "{session_id}"]; chat.rs fills {session_id} on follow-up turns.
    pub resume_args: Vec<String>,
    // Where the stream's final event carries the session id (informational; the
    // claude-stream-json parser reads result.session_id directly).
    #[serde(default)]
    pub session_id_from: String,
}

// The tools sub-block (present iff the plugin declares the `tool-use` capability;
// feature-cli-plugins.md §3.2). Descriptor-tier CLIs reach the app's `inv` MCP server
// through these flags. v1 ships the descriptor-tier definition; the runner that wires
// MCP per-turn is feature-cycle-chat.md Phase B/C. // ponytail: data only — declared so
// a plugin can carry it + the UI can show the capability; no runtime consumes it yet.
#[derive(Serialize, Deserialize, Clone)]
pub struct ChatTools {
    // "mcp" | "stdio-relay" — descriptor tier uses "mcp".
    #[serde(default)]
    pub transport: String,
    // e.g. ["--mcp-config","{mcp_config_file}","--strict-mcp-config"]
    #[serde(default)]
    pub mcp_config_args: Vec<String>,
    // The flag that takes the per-view allow-list (e.g. "--allowedTools").
    #[serde(default)]
    pub allowed_tools_arg: String,
    // How this CLI namespaces our MCP tools (e.g. "mcp__inv__").
    #[serde(default)]
    pub tool_namespace: String,
}

// The chat block (present iff the plugin declares streaming chat).
#[derive(Serialize, Deserialize, Clone)]
pub struct Chat {
    // "descriptor" | "adapter-program" — Phase A only implements "descriptor".
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub stream: Option<ChatStream>,
    #[serde(default)]
    pub session: Option<ChatSession>,
    // Tool-use (MCP) descriptor block — present iff capabilities includes "tool-use".
    #[serde(default)]
    pub tools: Option<ChatTools>,
}

// The adapter-program tier block (only when chat.mode == "adapter-program";
// feature-cli-plugins.md §3.2 / §6). v1 = a DOCUMENTED EXTENSION POINT: we parse +
// surface it (so a plugin can declare it and the UI can label "runs external program"),
// but the stdio relay runtime is the deferred M12 fast-follow. // ponytail: parsed, not run.
#[derive(Serialize, Deserialize, Clone)]
pub struct AdapterProgram {
    // Relative to the plugin folder; the program the plugin ships.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub protocol_version: i32,
}

// The full plugin manifest (the file). A SUPERSET of the M6 descriptor
// (feature-cli-plugins.md §3.2): every legacy field is preserved (so today's
// claude-code.json still deserializes), plus `manifest_version`, `vendor`, the
// `capabilities` list, and the `chat`/`tools`/`adapter_program` blocks. Serde-
// (de)serializable so we read user manifests and re-serialize the bundled defaults to
// disk on first run.
//
// ORTHOGONALITY RULE (§3.2): a plugin declares only the blocks for capabilities it has.
// `io`/`tasks` are therefore Optional now (a chat-only CLI omits them); `chat` is Optional
// (a batch-only CLI omits it). The runner never invokes a block that isn't declared —
// that's graceful degradation in data form.
#[derive(Serialize, Deserialize, Clone)]
pub struct Adapter {
    // Manifest schema version (feature-cli-plugins.md §3.2). Defaults to 1 for legacy
    // descriptors that predate the field.
    #[serde(default = "default_manifest_version")]
    pub manifest_version: i32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    // Informational vendor (e.g. "Anthropic", "Alibaba", "Google"). Optional.
    #[serde(default)]
    pub vendor: String,
    pub command: String,
    // The capability list driving graceful degradation (§3.1):
    // ["batch-tasks","streaming","multi-turn","tool-use"]. Legacy descriptors with no
    // `capabilities` field default to ["batch-tasks"] (see normalize_capabilities).
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub probe: Probe,
    pub auth: Auth,
    // Batch IO block — present iff `batch-tasks`. Optional for chat-only plugins.
    #[serde(default)]
    pub io: Option<Io>,
    // task name -> spec. BTreeMap for stable ordering in the UI. Empty for chat-only plugins.
    #[serde(default)]
    pub tasks: BTreeMap<String, TaskSpec>,
    // M11: the chat/streaming capability (plugin-first). Optional so legacy batch-only
    // descriptors (no `chat` block) still deserialize — they just can't drive chat.
    #[serde(default)]
    pub chat: Option<Chat>,
    // Adapter-program tier (only when chat.mode == "adapter-program"). v1 = parsed +
    // surfaced as an extension point; runtime deferred (§12). // ponytail: parsed, not run.
    #[serde(default)]
    pub adapter_program: Option<AdapterProgram>,
}

fn default_manifest_version() -> i32 {
    1
}

// The canonical capability strings (feature-cli-plugins.md §3.1).
pub const CAP_BATCH: &str = "batch-tasks";
pub const CAP_STREAMING: &str = "streaming";
pub const CAP_MULTI_TURN: &str = "multi-turn";
pub const CAP_TOOL_USE: &str = "tool-use";

impl Adapter {
    // The effective capability list. A legacy descriptor with NO `capabilities` field +
    // a `tasks` block is a degenerate batch-only plugin (§2.1), so default to
    // ["batch-tasks"] when the field is absent but tasks exist. Otherwise return as-is.
    pub fn effective_capabilities(&self) -> Vec<String> {
        if !self.capabilities.is_empty() {
            return self.capabilities.clone();
        }
        if !self.tasks.is_empty() {
            vec![CAP_BATCH.to_string()]
        } else {
            Vec::new()
        }
    }

    pub fn has_capability(&self, cap: &str) -> bool {
        self.effective_capabilities().iter().any(|c| c == cap)
    }

    // The batch IO block, or a clear error for a plugin that declared no batch tier.
    fn io_or_err(&self) -> Result<&Io, String> {
        self.io
            .as_ref()
            .ok_or_else(|| format!("plugin `{}` declares no batch IO (`io`) block", self.id))
    }
}

// A light summary the Settings UI lists (avoids shipping the whole manifest to JS).
// `ok: true` is a valid plugin; `ok: false` is a malformed/skipped manifest carrying the
// validation error (feature-cli-plugins.md §2.2: invalid ones are listed with the error,
// never crash the app). The two shapes are unified so the UI gets one list.
#[derive(Serialize, Clone)]
pub struct AdapterSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub vendor: String,
    pub command: String,
    pub auth_type: String,
    pub auth_note: String,
    pub builtin: bool, // true for a bundled (compiled-in) plugin
    pub tasks: Vec<String>,
    // The effective capability list (§3.1), drives the UI capability chips + degradation.
    pub capabilities: Vec<String>,
    // True when chat.mode == "adapter-program" → the UI labels "runs external program" (§10).
    pub runs_external_program: bool,
    // Validity: true = registered plugin; false = malformed manifest (see `error`).
    pub ok: bool,
    // The validation error for a malformed manifest (None when ok).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    // Folder/file the manifest was loaded from (informational; helps the user find it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl Adapter {
    fn summary(&self, builtin: bool, source: Option<String>) -> AdapterSummary {
        let runs_external = self
            .chat
            .as_ref()
            .map(|c| c.mode == "adapter-program")
            .unwrap_or(false)
            || self.adapter_program.is_some();
        AdapterSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            version: self.version.clone(),
            vendor: self.vendor.clone(),
            command: self.command.clone(),
            auth_type: self.auth.auth_type.clone(),
            auth_note: self.auth.note.clone(),
            builtin,
            tasks: self.tasks.keys().cloned().collect(),
            capabilities: self.effective_capabilities(),
            runs_external_program: runs_external,
            ok: true,
            error: None,
            source,
        }
    }
}

// A malformed manifest summary (validation failed). The UI renders these with the error
// so the user can fix the file (§2.2 "Malformed manifests skipped with a clear status").
fn malformed_summary(id: String, source: String, error: String) -> AdapterSummary {
    AdapterSummary {
        id,
        name: "(invalid plugin)".to_string(),
        version: String::new(),
        vendor: String::new(),
        command: String::new(),
        auth_type: String::new(),
        auth_note: String::new(),
        builtin: false,
        tasks: Vec::new(),
        capabilities: Vec::new(),
        runs_external_program: false,
        ok: false,
        error: Some(error),
        source: Some(source),
    }
}

// --- bundled Claude Code default (spec §7.2) ----------------------------------
//
// Shipped as a string constant so the default always loads even before anything is
// written to disk. Matches the §7.1 schema exactly; the isolation flags keep the
// user's global hooks/settings/MCP/CLAUDE.md out of the call WITHOUT --bare (which
// would force ANTHROPIC_API_KEY and break subscription auth). The "ping" task is the
// tiny throwaway used by the probe + M6 verify to exercise the pipe (M7–M9 add the
// three real task contracts §7.3 here later).
const CLAUDE_CODE_DESCRIPTOR: &str = r#"{
  "manifest_version": 1,
  "id": "claude-code",
  "name": "Claude Code",
  "version": "1.0",
  "vendor": "Anthropic",
  "command": "claude",
  "capabilities": ["batch-tasks", "streaming", "multi-turn", "tool-use"],
  "probe": { "args": ["--version"], "expect_exit_code": 0 },
  "auth": {
    "type": "session",
    "env": [],
    "note": "Uses the user's `claude login` session (Pro/Max subscription, or ANTHROPIC_API_KEY if set). Plain -p reads keychain/OAuth. Do NOT pass --bare (it ignores OAuth and forces ANTHROPIC_API_KEY)."
  },
  "io": {
    "payload_via": "stdin",
    "prompt_via": "arg",
    "result_extract": { "format": "json", "json_path": "result" },
    "timeout_sec": 600,
    "max_stdin_bytes": 10000000
  },
  "tasks": {
    "ping":                    { "args_template": ["-p", "{prompt}", "--output-format", "json", "--setting-sources", "", "--strict-mcp-config"] },
    "transcript-cleanup":      { "args_template": ["-p", "{prompt}", "--output-format", "json", "--setting-sources", "", "--strict-mcp-config"] },
    "cycle-synthesis":         { "args_template": ["-p", "{prompt}", "--output-format", "json", "--setting-sources", "", "--strict-mcp-config"] },
    "cycle-synthesis-extract": { "args_template": ["-p", "{prompt}", "--output-format", "json", "--setting-sources", "", "--strict-mcp-config"] },
    "cycle-synthesis-reduce":  { "args_template": ["-p", "{prompt}", "--output-format", "json", "--setting-sources", "", "--strict-mcp-config"] },
    "cycle-diff":              { "args_template": ["-p", "{prompt}", "--output-format", "json", "--setting-sources", "", "--strict-mcp-config"] }
  },
  "chat": {
    "mode": "descriptor",
    "stream": {
      "args_template": [
        "-p", "{prompt}",
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--append-system-prompt-file", "{system_prompt_file}",
        "--setting-sources", "", "--strict-mcp-config",
        "--tools", "",
        "{session_args}"
      ],
      "parse": "claude-stream-json"
    },
    "session": {
      "resume_args": ["--resume", "{session_id}"],
      "session_id_from": "result.session_id"
    },
    "tools": {
      "transport": "mcp",
      "mcp_config_args": ["--mcp-config", "{mcp_config_file}", "--strict-mcp-config"],
      "allowed_tools_arg": "--allowedTools",
      "tool_namespace": "mcp__inv__"
    }
  }
}"#;

// The bundled default id, used to mark builtin adapters in the UI + as the active
// default before the user picks one.
pub const DEFAULT_ADAPTER_ID: &str = "claude-code";

// --- bundled proof plugins (feature-cli-plugins.md §12.3) ---------------------
//
// Two descriptor plugins shipped as PROOF that any CLI is a drop-in with no source
// change: Antigravity CLI + Qwen Code. They load + parse like any user plugin (the loader
// treats them identically to a folder dropped in `plugins/`); a full round-trip only
// happens if the CLI is installed + logged in, otherwise "Test CLI" reports Not found /
// Not logged in but the manifest still registers. Authored from each CLI's 2026 headless
// docs (see the README each writes alongside itself).
//
// QWEN CODE — a fork of Google Gemini CLI, so it inherits the gemini-style headless
// interface (`-p` + `--output-format json|stream-json`, the answer in the `response`
// envelope field, gemini-family stream events). Capabilities: batch-tasks + streaming +
// tool-use (MCP via `mcpServers` settings + `--allowed-tools`); `--resume` is NOT
// documented for Qwen Code → multi-turn omitted (graceful degradation). Auth is API-key
// based (OPENAI_API_KEY/-compatible, or DASHSCOPE_API_KEY) since the free OAuth tier ended.
const QWEN_CODE_DESCRIPTOR: &str = r#"{
  "manifest_version": 1,
  "id": "qwen-code",
  "name": "Qwen Code",
  "version": "1.0",
  "vendor": "Alibaba",
  "command": "qwen",
  "capabilities": ["batch-tasks", "streaming", "tool-use"],
  "probe": { "args": ["--version"], "expect_exit_code": 0 },
  "auth": {
    "type": "env",
    "env": ["OPENAI_API_KEY"],
    "note": "Qwen Code is a Gemini-CLI fork. Auth via an API key: OpenAI-compatible (OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL), DashScope (DASHSCOPE_API_KEY), or others, selected by security.auth.selectedType in ~/.qwen/settings.json. The free Qwen OAuth tier was discontinued 2026-04-15."
  },
  "io": {
    "payload_via": "stdin",
    "prompt_via": "arg",
    "result_extract": { "format": "json", "json_path": "response" },
    "timeout_sec": 600,
    "max_stdin_bytes": 10000000
  },
  "tasks": {
    "ping":                    { "args_template": ["-p", "{prompt}", "--output-format", "json"] },
    "transcript-cleanup":      { "args_template": ["-p", "{prompt}", "--output-format", "json"] },
    "cycle-synthesis":         { "args_template": ["-p", "{prompt}", "--output-format", "json"] },
    "cycle-synthesis-extract": { "args_template": ["-p", "{prompt}", "--output-format", "json"] },
    "cycle-synthesis-reduce":  { "args_template": ["-p", "{prompt}", "--output-format", "json"] },
    "cycle-diff":              { "args_template": ["-p", "{prompt}", "--output-format", "json"] }
  },
  "chat": {
    "mode": "descriptor",
    "stream": {
      "args_template": [
        "-p", "{prompt}",
        "--output-format", "stream-json", "--include-partial-messages",
        "{session_args}"
      ],
      "parse": "gemini-stream-json"
    },
    "tools": {
      "transport": "mcp",
      "mcp_config_args": [],
      "allowed_tools_arg": "--allowed-tools",
      "tool_namespace": "mcp__inv__"
    }
  }
}"#;

// ANTIGRAVITY CLI — Google's `agy` binary (replaced Gemini CLI 2026-06-18). BEST-EFFORT
// descriptor: its `-p`/`--print` headless mode is documented, but `--output-format json`
// is NOT a stable/shipped feature (current builds reject the flag), so we parse stdout as
// RAW text (result_extract.format = "raw") and the prompt must ask for ONLY-JSON. The
// command is `agy` (NOT `antigravity`). Capabilities: batch-tasks only (no confirmed
// machine-readable stream → no streaming/tool-use declared here; see the README's "what to
// verify"). Auth = Google OAuth (`agy auth login`) or GEMINI_API_KEY / ANTIGRAVITY_API_KEY.
const ANTIGRAVITY_CLI_DESCRIPTOR: &str = r#"{
  "manifest_version": 1,
  "id": "antigravity-cli",
  "name": "Antigravity CLI",
  "version": "0.1",
  "vendor": "Google",
  "command": "agy",
  "capabilities": ["batch-tasks"],
  "probe": { "args": ["--version"], "expect_exit_code": 0 },
  "auth": {
    "type": "session",
    "env": ["GEMINI_API_KEY"],
    "note": "Google account OAuth via `agy auth login` (free/Pro/Ultra), or an API key (GEMINI_API_KEY / ANTIGRAVITY_API_KEY) for CI. BEST-EFFORT: `--output-format json` is NOT a stable flag on current `agy` builds, so this descriptor parses raw stdout and the prompt asks for ONLY-JSON. VERIFY against your installed `agy`: the JSON-output flag, the non-TTY stdout-drop bug (#76), and which API-key env var your build honors."
  },
  "io": {
    "payload_via": "stdin",
    "prompt_via": "arg",
    "result_extract": { "format": "raw" },
    "timeout_sec": 600,
    "max_stdin_bytes": 10000000
  },
  "tasks": {
    "ping":                    { "args_template": ["-p", "{prompt}"] },
    "transcript-cleanup":      { "args_template": ["-p", "{prompt}"] },
    "cycle-synthesis":         { "args_template": ["-p", "{prompt}"] },
    "cycle-synthesis-extract": { "args_template": ["-p", "{prompt}"] },
    "cycle-synthesis-reduce":  { "args_template": ["-p", "{prompt}"] },
    "cycle-diff":              { "args_template": ["-p", "{prompt}"] }
  }
}"#;

// The bundled-plugin registry: (id, manifest_json, written_filename). The loader compiles
// these in as defaults AND writes each as a folder plugin on first run so they're visible/
// editable on disk. Claude Code is the reference (and the active default); the other two
// are proof. A user plugin with the same id OVERRIDES the bundled copy.
fn bundled_descriptors() -> [(&'static str, &'static str); 3] {
    [
        (DEFAULT_ADAPTER_ID, CLAUDE_CODE_DESCRIPTOR),
        ("antigravity-cli", ANTIGRAVITY_CLI_DESCRIPTOR),
        ("qwen-code", QWEN_CODE_DESCRIPTOR),
    ]
}

// Parse the bundled Claude Code descriptor. Panics only on a programmer error (bad const
// JSON), which a unit test guards against. Test-only now: the loader compiles in ALL three
// bundled descriptors via `bundled_descriptors()` + `parse_manifest`; this single-plugin
// shortcut survives for the tests/verifies that exercise the reference plugin directly.
#[cfg(test)]
fn builtin_adapter() -> Adapter {
    serde_json::from_str(CLAUDE_CODE_DESCRIPTOR)
        .expect("bundled claude-code descriptor must be valid JSON")
}

// --- plugin discovery & loading (feature-cli-plugins.md §2) --------------------
//
// The app discovers plugins at runtime from TWO locations under the app-data dir
// (%APPDATA%/com.interviewlab.app on Windows) — ZERO source changes to add a CLI:
//   plugins/<id>/manifest.json   — the folder-per-plugin form (alias: adapter.json).
//   adapters/*.json              — the legacy flat form (still loaded, back-compat §2.1).
// The bundled plugins (Claude Code + the two proofs) are compiled in AND written to
// plugins/<id>/ on first run, so the app works out of the box and the files are visible/
// editable. A user plugin with the same id OVERRIDES a bundled one.

fn app_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))
}

// plugins/ dir (the folder-per-plugin drop-in location, §2.1).
fn plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join("plugins"))
}

// adapters/ dir (legacy flat descriptors, §2.1 back-compat).
fn adapters_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join("adapters"))
}

// One discovered plugin: either a valid Adapter (manifest parsed + validated) or a
// malformed manifest carrying the validation error. `builtin` marks a compiled-in default.
pub struct LoadedPlugin {
    pub adapter: Option<Adapter>,
    pub builtin: bool,
    pub source: String,
    pub error: Option<String>,
    // The id we know even for a malformed manifest (the folder name).
    pub id: String,
}

// Write the bundled plugins to plugins/<id>/ on first run: manifest.json + a README.md
// (the per-plugin agent notes) + the shared meta-instruction + manifest schema in the
// plugins root. Best-effort: a write failure never blocks loading (defaults are compiled
// in). Re-running is cheap — existing files are left untouched (so a user's edits survive).
fn ensure_bundled_on_disk(app: &tauri::AppHandle) {
    let Ok(root) = plugins_dir(app) else { return };
    let _ = std::fs::create_dir_all(&root);
    // The agent-facing meta-instruction + JSON schema live in the plugins root so any
    // agent dropping a plugin finds them next to the folders (§9 / §3.3).
    let readme = root.join("README.md");
    if !readme.exists() {
        let _ = std::fs::write(&readme, META_INSTRUCTIONS);
    }
    let schema = root.join("manifest.schema.json");
    if !schema.exists() {
        let _ = std::fs::write(&schema, MANIFEST_SCHEMA);
    }
    for (id, json) in bundled_descriptors() {
        let folder = root.join(id);
        let manifest = folder.join("manifest.json");
        if !manifest.exists() {
            let _ = std::fs::create_dir_all(&folder);
            let _ = std::fs::write(&manifest, json);
        }
        // A short per-plugin README pointer (only the meta-doc is the full guide).
        let preadme = folder.join("README.md");
        if !preadme.exists() {
            let _ = std::fs::write(
                &preadme,
                format!(
                    "# {id} plugin\n\nDescriptor-tier InterviewLab plugin (manifest.json). \
                     See ../README.md for the full plugin-authoring guide and the manifest \
                     schema (../manifest.schema.json).\n"
                ),
            );
        }
    }
}

// Parse + validate one manifest's text. Returns the Adapter or a clear validation error
// (feature-cli-plugins.md §3.3). The error string is what the Settings UI shows for a
// malformed/skipped manifest.
fn parse_manifest(text: &str) -> Result<Adapter, String> {
    let adapter: Adapter =
        serde_json::from_str(text).map_err(|e| format!("invalid JSON or missing required field: {e}"))?;
    validate_manifest(&adapter)?;
    Ok(adapter)
}

// Conditional-required validation (§3.3): required base fields are enforced by serde
// (no #[serde(default)] on id/name/command/probe/auth). Here we enforce the
// capability-conditional blocks: batch-tasks ⇒ io+tasks; streaming ⇒ chat.stream;
// multi-turn ⇒ chat.session; tool-use ⇒ chat.tools OR adapter_program.
fn validate_manifest(a: &Adapter) -> Result<(), String> {
    if a.id.trim().is_empty() {
        return Err("manifest `id` is empty".into());
    }
    if a.command.trim().is_empty() {
        return Err("manifest `command` is empty".into());
    }
    let caps = a.effective_capabilities();
    if caps.is_empty() {
        return Err("manifest declares no `capabilities` (and no `tasks` to imply batch-tasks)".into());
    }
    if caps.iter().any(|c| c == CAP_BATCH) && (a.io.is_none() || a.tasks.is_empty()) {
        return Err("capability `batch-tasks` requires both `io` and `tasks` blocks".into());
    }
    if caps.iter().any(|c| c == CAP_STREAMING)
        && a.chat.as_ref().and_then(|c| c.stream.as_ref()).is_none()
    {
        return Err("capability `streaming` requires a `chat.stream` block".into());
    }
    if caps.iter().any(|c| c == CAP_MULTI_TURN)
        && a.chat.as_ref().and_then(|c| c.session.as_ref()).is_none()
    {
        return Err("capability `multi-turn` requires a `chat.session` block".into());
    }
    if caps.iter().any(|c| c == CAP_TOOL_USE)
        && a.chat.as_ref().and_then(|c| c.tools.as_ref()).is_none()
        && a.adapter_program.is_none()
    {
        return Err("capability `tool-use` requires a `chat.tools` block or an `adapter_program`".into());
    }
    Ok(())
}

// Discover every plugin: the compiled-in bundled defaults first, then disk plugins from
// BOTH plugins/<id>/manifest.json and legacy adapters/*.json. A disk plugin with the same
// id OVERRIDES the bundled copy (and keeps the builtin flag for the reference ids).
// Malformed manifests become LoadedPlugin entries with an `error` (never dropped silently).
fn discover_plugins(app: &tauri::AppHandle) -> Vec<LoadedPlugin> {
    ensure_bundled_on_disk(app);

    let mut out: Vec<LoadedPlugin> = Vec::new();
    // 1) Compiled-in bundled defaults (always present even before disk writes succeed).
    for (id, json) in bundled_descriptors() {
        match parse_manifest(json) {
            Ok(adapter) => out.push(LoadedPlugin {
                id: adapter.id.clone(),
                adapter: Some(adapter),
                builtin: true,
                source: format!("<bundled>/{id}"),
                error: None,
            }),
            // A bundled descriptor failing to parse is a programmer error (unit-tested),
            // but never crash: surface it as a malformed entry.
            Err(e) => out.push(LoadedPlugin {
                id: id.to_string(),
                adapter: None,
                builtin: true,
                source: format!("<bundled>/{id}"),
                error: Some(e),
            }),
        }
    }

    let bundled_ids: Vec<String> = bundled_descriptors().iter().map(|(id, _)| id.to_string()).collect();

    // Upsert a disk-loaded plugin into `out`: override a same-id entry, else append.
    let mut upsert = |id: String, parsed: Result<Adapter, String>, source: String| {
        let builtin = bundled_ids.iter().any(|b| b == &id);
        let entry = match parsed {
            Ok(adapter) => LoadedPlugin { id: id.clone(), adapter: Some(adapter), builtin, source, error: None },
            Err(e) => LoadedPlugin { id: id.clone(), adapter: None, builtin, source, error: Some(e) },
        };
        if let Some(slot) = out.iter_mut().find(|p| p.id == id) {
            *slot = entry;
        } else {
            out.push(entry);
        }
    };

    // Precedence (lowest → highest): bundled (step 1) < legacy flat `adapters/*.json`
    // (step 2) < folder `plugins/<id>/manifest.json` (step 3). The folder manifest is the
    // canonical, richest form, so it loads LAST and `upsert` lets it win — a stale legacy
    // flat descriptor must never shadow the full folder manifest for the same id.

    // 2) Legacy flat descriptors: adapters/*.json (degenerate batch-only plugins, §2.1).
    if let Ok(dir) = adapters_dir(app) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let source = path.to_string_lossy().to_string();
                match std::fs::read_to_string(&path) {
                    Ok(text) => match parse_manifest(&text) {
                        Ok(a) => {
                            let id = a.id.clone();
                            upsert(id, Ok(a), source);
                        }
                        Err(e) => {
                            // Use the filename stem as the id for the error row.
                            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("?").to_string();
                            upsert(id, Err(e), source);
                        }
                    },
                    Err(e) => {
                        let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("?").to_string();
                        upsert(id, Err(format!("could not read file: {e}")), source);
                    }
                }
            }
        }
    }

    // 3) Folder plugins: plugins/<id>/manifest.json (alias adapter.json). The folder name
    //    is the canonical id. Loaded LAST so it wins over a same-id bundled OR legacy entry.
    if let Ok(root) = plugins_dir(app) {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let folder_id = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                if folder_id.is_empty() {
                    continue;
                }
                let manifest_path = if path.join("manifest.json").exists() {
                    path.join("manifest.json")
                } else if path.join("adapter.json").exists() {
                    path.join("adapter.json")
                } else {
                    continue; // a folder without a manifest is not a plugin
                };
                let source = manifest_path.to_string_lossy().to_string();
                match std::fs::read_to_string(&manifest_path) {
                    Ok(text) => {
                        let parsed = parse_manifest(&text).and_then(|a| {
                            if a.id != folder_id {
                                Err(format!("manifest `id` (\"{}\") must match the folder name (\"{}\")", a.id, folder_id))
                            } else {
                                Ok(a)
                            }
                        });
                        upsert(folder_id, parsed, source);
                    }
                    Err(e) => upsert(folder_id, Err(format!("could not read manifest: {e}")), source),
                }
            }
        }
    }

    out
}

// Only the valid plugins, as (Adapter, builtin) — for resolution + the active selector.
fn load_adapters(app: &tauri::AppHandle) -> Result<Vec<(Adapter, bool)>, String> {
    Ok(discover_plugins(app)
        .into_iter()
        .filter_map(|p| p.adapter.map(|a| (a, p.builtin)))
        .collect())
}

// Resolve one adapter by id (or the default when id is None/unknown).
fn resolve_adapter(app: &tauri::AppHandle, id: Option<&str>) -> Result<Adapter, String> {
    let adapters = load_adapters(app)?;
    let want = id.unwrap_or(DEFAULT_ADAPTER_ID);
    adapters
        .into_iter()
        .find(|(a, _)| a.id == want)
        .map(|(a, _)| a)
        .ok_or_else(|| format!("plugin not found: {want}"))
}

// Public resolver for sibling modules (M7 cleanup): resolve an adapter by id (or the
// active/default when None). Thin re-export of the private `resolve_adapter`.
pub fn resolve_adapter_pub(app: &tauri::AppHandle, id: Option<&str>) -> Result<Adapter, String> {
    resolve_adapter(app, id)
}

// Read the active adapter id straight from a pool (M7 cleanup calls this off an
// AppHandle-less code path; the `get_active_adapter` command wraps the same query for
// the frontend). Default = claude-code when unset.
pub async fn active_adapter_id(pool: &sqlx::SqlitePool) -> Result<String, String> {
    let id: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_setting WHERE key = 'active_adapter'")
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(id.unwrap_or_else(|| DEFAULT_ADAPTER_ID.to_string()))
}

// The compiled-in default adapter, for tests/verifies that have no AppHandle (M7 live
// cleanup verify). Same descriptor the loader marks builtin.
#[cfg(test)]
pub fn builtin_adapter_pub() -> Adapter {
    builtin_adapter()
}

// --- prompt rendering (spec §7.1: instructions + output schema + input) -------

// Build the rendered prompt for a task: a clear instruction to return ONLY JSON, the
// optional output JSON schema, and the input JSON. The payload also goes on stdin per
// the descriptor; embedding it in the prompt too is harmless and keeps single-arg CLIs
// working — but to avoid duplication for stdin adapters we keep the prompt instruction
// focused and let stdin carry the bulk. M7–M9 pass richer per-task instructions; M6's
// generic renderer is deliberately minimal.
fn render_prompt(task_name: &str, input_json: &Value, output_schema: Option<&Value>) -> String {
    // `ping` is the throwaway pipe-check task: a fixed, deterministic prompt so the
    // runner verify (and the probe) get a predictable {"ok":true} back. M7–M9 add the
    // real per-task instructions for cleanup/synthesis/diff.
    if task_name == "ping" {
        return "Return ONLY this JSON object and nothing else, no prose, no markdown fences: {\"ok\":true}".to_string();
    }

    let mut p = String::new();
    p.push_str(&format!(
        "You are running the InterviewLab `{task_name}` task. The input JSON is provided on stdin. "
    ));
    p.push_str("Respond with ONLY a single JSON object that satisfies the contract — no prose, no explanation, no markdown code fences.\n");
    if let Some(schema) = output_schema {
        p.push_str("\nThe output MUST conform to this JSON schema:\n");
        p.push_str(&serde_json::to_string_pretty(schema).unwrap_or_default());
        p.push('\n');
    }
    // Include the input inline as well so adapters that only accept a prompt arg still
    // see it; stdin remains the primary channel for large payloads.
    p.push_str("\nInput:\n");
    p.push_str(&serde_json::to_string(input_json).unwrap_or_else(|_| "{}".into()));
    p
}

// --- runner (spec §7.2) -------------------------------------------------------

// Typed task errors (spec: "treats non-zero exit / parse failure as a clear typed
// error"). Serializable so the frontend can branch on `kind`.
#[derive(Serialize, Debug)]
pub struct TaskError {
    pub kind: String, // 'spawn' | 'timeout' | 'exit' | 'parse' | 'config'
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
}

impl TaskError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        TaskError { kind: kind.into(), message: message.into(), stderr: None }
    }
    fn with_stderr(kind: &str, message: impl Into<String>, stderr: String) -> Self {
        TaskError { kind: kind.into(), message: message.into(), stderr: Some(stderr) }
    }
}
impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.kind, self.message)
    }
}
impl std::error::Error for TaskError {}

// Whether this task's args ask for schema-conformant output (`--json-schema` present),
// in which case the CLI fills `structured_output` and we prefer it.
fn args_have_json_schema(args: &[String]) -> bool {
    args.iter().any(|a| a == "--json-schema")
}

// Substitute {prompt} in the arg template; inject `--json-schema <schema>` right after
// {prompt} when a schema is supplied and the descriptor doesn't already template it; and
// inject `--model <alias>` when a per-task model is requested (PERF: cleanup→haiku,
// synthesis/diff→sonnet, instead of the CLI's heavy default). The Claude Code CLI accepts
// `--model haiku|sonnet|opus` aliases (verified via `claude --help`); model is just a
// per-task arg, so the CLI-adapter/plugin design stays intact.
fn build_args(
    spec: &TaskSpec,
    prompt: &str,
    output_schema: Option<&Value>,
    model: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::with_capacity(spec.args_template.len() + 4);
    for a in &spec.args_template {
        if a == "{prompt}" {
            args.push(prompt.to_string());
        } else {
            args.push(a.clone());
        }
    }
    // Harden synthesis/diff parsing (spec §7.2): pass the schema so the CLI returns
    // structured_output. Only add it if the template didn't already include it.
    if let Some(schema) = output_schema {
        if !args_have_json_schema(&args) {
            args.push("--json-schema".to_string());
            args.push(schema.to_string());
        }
    }
    // PERF: a fast per-task model. Only add it if the template didn't already pin a model
    // (so a user descriptor that hardcodes --model still wins).
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        if !args.iter().any(|a| a == "--model") {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
    }
    args
}

// A neutral cwd so no stray CLAUDE.md / project config is auto-discovered (spec §7.2).
// Use the system temp dir — always present, never a project root.
fn neutral_cwd() -> PathBuf {
    std::env::temp_dir()
}

// Tolerant extraction of a JSON object/array from a string that may be wrapped in prose
// or ```json fences (spec §7.2 / risk §10.4). Returns the parsed Value.
fn extract_json_value(s: &str) -> Result<Value, String> {
    let trimmed = s.trim();
    // Fast path: already clean JSON.
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Ok(v);
    }
    // Strip a ```json ... ``` (or plain ```) fence if present.
    let unfenced = strip_code_fence(trimmed);
    if let Ok(v) = serde_json::from_str::<Value>(unfenced.trim()) {
        return Ok(v);
    }
    // Last resort: grab the substring from the first { or [ to its matching last } or ].
    if let Some(slice) = first_json_span(unfenced) {
        if let Ok(v) = serde_json::from_str::<Value>(slice) {
            return Ok(v);
        }
    }
    Err("could not parse JSON from CLI output".into())
}

// Remove a leading/trailing markdown code fence (```json ... ``` or ``` ... ```).
fn strip_code_fence(s: &str) -> &str {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        // Drop an optional language tag on the first line.
        let rest = match rest.find('\n') {
            Some(nl) => &rest[nl + 1..],
            None => rest,
        };
        return rest.trim_end().strip_suffix("```").unwrap_or(rest).trim();
    }
    t
}

// Find the substring spanning the outermost JSON object/array, by first opener to last
// matching closer. Cheap heuristic; the serde parse above is the real validator.
fn first_json_span(s: &str) -> Option<&str> {
    let start = s.find(['{', '['])?;
    let open = s.as_bytes()[start];
    let close = if open == b'{' { b'}' } else { b']' };
    let end = s.rfind(close as char)?;
    if end > start {
        Some(&s[start..=end])
    } else {
        None
    }
}

// Pull the task JSON out of the CLI's stdout per the descriptor's result_extract.
//   format == "json": parse the envelope; prefer `structured_output` when a schema was
//     requested, else take the `json_path` field (e.g. "result") and tolerant-parse it.
//   format == "raw":  tolerant-parse stdout directly.
fn extract_result(
    adapter: &Adapter,
    stdout: &str,
    used_schema: bool,
) -> Result<Value, String> {
    let rx = &adapter.io_or_err()?.result_extract;
    if rx.format == "raw" {
        return extract_json_value(stdout);
    }
    // JSON envelope.
    let envelope: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("CLI stdout was not a JSON envelope: {e}"))?;

    // Prefer structured_output when we asked for a schema (clean, already parsed).
    if used_schema {
        if let Some(so) = envelope.get("structured_output") {
            if !so.is_null() {
                return Ok(so.clone());
            }
        }
    }

    let field = if rx.json_path.is_empty() { "result" } else { &rx.json_path };
    let raw = envelope
        .get(field)
        .ok_or_else(|| format!("envelope has no `{field}` field"))?;

    match raw {
        // `result` is normally a JSON-encoded string; tolerant-parse it.
        Value::String(s) => extract_json_value(s),
        // Some CLIs may already nest an object there.
        other => Ok(other.clone()),
    }
}

// One spawn attempt: run the command, pipe stdin, capture stdout/stderr, enforce
// timeout. Returns raw (stdout, stderr) on a zero exit; typed error otherwise.
async fn spawn_once(
    adapter: &Adapter,
    args: &[String],
    payload: &[u8],
) -> Result<(String, String), TaskError> {
    let io = adapter
        .io_or_err()
        .map_err(|e| TaskError::new("config", e))?;
    // Enforce the descriptor's stdin cap (spec §7.2: Claude Code's 10 MB).
    if io.payload_via == "stdin" && payload.len() as u64 > io.max_stdin_bytes {
        return Err(TaskError::new(
            "config",
            format!(
                "payload {} bytes exceeds max_stdin_bytes {}",
                payload.len(),
                io.max_stdin_bytes
            ),
        ));
    }

    let mut cmd = Command::new(&adapter.command);
    cmd.args(args)
        .current_dir(neutral_cwd()) // neutral cwd: no stray CLAUDE.md (spec §7.2)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Don't pop a console window on Windows for the headless CLI call.
    // tokio::process::Command exposes creation_flags inherently on Windows.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| TaskError::new("spawn", format!("could not start `{}`: {e}", adapter.command)))?;

    // Write the payload to stdin (when the descriptor pipes it there), then close it.
    if io.payload_via == "stdin" {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(payload)
                .await
                .map_err(|e| TaskError::new("spawn", format!("write stdin: {e}")))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| TaskError::new("spawn", format!("close stdin: {e}")))?;
        }
    } else {
        // Not stdin → drop the handle so the child sees EOF immediately.
        drop(child.stdin.take());
    }

    let timeout = Duration::from_secs(io.timeout_sec.max(1));
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(TaskError::new("spawn", format!("wait: {e}"))),
        Err(_) => {
            return Err(TaskError::new(
                "timeout",
                format!("CLI did not finish within {}s", io.timeout_sec),
            ))
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        return Err(TaskError::with_stderr(
            "exit",
            format!("CLI exited with status {}", output.status),
            if stderr.trim().is_empty() { stdout.clone() } else { stderr },
        ));
    }
    Ok((stdout, stderr))
}

// The generic task runner (spec §7.2). Renders the prompt, spawns the CLI per the
// descriptor, extracts the result JSON. One retry on parse failure (LLMs occasionally
// wrap JSON in prose). M7–M9 call this with the real §7.3 contracts.
//
// Back-compat wrapper: callers that don't pin a model use the CLI's default. New perf-
// conscious callers use `run_cli_task_model` to request a fast per-task model.
pub async fn run_cli_task(
    adapter: &Adapter,
    task_name: &str,
    input_json: &Value,
    output_schema: Option<&Value>,
) -> Result<Value, TaskError> {
    run_cli_task_model(adapter, task_name, input_json, output_schema, None).await
}

// Same as `run_cli_task` but with an optional per-task model alias (e.g. "haiku",
// "sonnet") injected as `--model <alias>` (PERF). None → the CLI's default model.
pub async fn run_cli_task_model(
    adapter: &Adapter,
    task_name: &str,
    input_json: &Value,
    output_schema: Option<&Value>,
    model: Option<&str>,
) -> Result<Value, TaskError> {
    let spec = adapter
        .tasks
        .get(task_name)
        .ok_or_else(|| TaskError::new("config", format!("adapter `{}` has no task `{task_name}`", adapter.id)))?;

    let prompt = render_prompt(task_name, input_json, output_schema);
    let args = build_args(spec, &prompt, output_schema, model);
    let used_schema = args_have_json_schema(&args);
    let payload = serde_json::to_vec(input_json)
        .map_err(|e| TaskError::new("config", format!("serialize input: {e}")))?;

    // Up to two attempts: a clean exit with unparseable output gets one retry; a hard
    // failure (spawn/exit/timeout) is returned immediately (no point retrying those).
    let mut last_parse_err: Option<String> = None;
    for attempt in 0..2 {
        let (stdout, stderr) = spawn_once(adapter, &args, &payload).await?;
        match extract_result(adapter, &stdout, used_schema) {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_parse_err = Some(e);
                if attempt == 0 {
                    continue; // retry once
                }
                return Err(TaskError::with_stderr(
                    "parse",
                    last_parse_err.unwrap_or_else(|| "parse failed".into()),
                    if stderr.trim().is_empty() { stdout } else { stderr },
                ));
            }
        }
    }
    // Unreachable (loop always returns), but satisfy the type checker.
    Err(TaskError::new("parse", last_parse_err.unwrap_or_else(|| "parse failed".into())))
}

// --- "Test CLI" probe (spec §4.4 / §7.2) --------------------------------------

// Probe result statuses surfaced as a Settings Badge.
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum ProbeStatus {
    Available,    // installed AND a round-trip returned parsed JSON (logged in)
    NotFound,     // command not on PATH / can't spawn
    NotLoggedIn,  // installed (--version ok) but the -p round-trip failed auth
    Error,        // installed but the round-trip failed for another reason
}

#[derive(Serialize, Clone)]
pub struct ProbeResult {
    pub status: ProbeStatus,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

// Run the descriptor's `probe` command (`claude --version`) → is it installed?
async fn probe_version(adapter: &Adapter) -> Result<String, TaskError> {
    let mut cmd = Command::new(&adapter.command);
    cmd.args(&adapter.probe.args)
        .current_dir(neutral_cwd())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(Duration::from_secs(20), cmd.output())
        .await
        .map_err(|_| TaskError::new("timeout", "version probe timed out"))?
        .map_err(|e| TaskError::new("spawn", format!("could not start `{}`: {e}", adapter.command)))?;

    if output.status.code() != Some(adapter.probe.expect_exit_code) {
        return Err(TaskError::with_stderr(
            "exit",
            format!("version probe exit {:?}", output.status.code()),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// The two-step probe (spec §7.2): `--version` (installed?) then a tiny `-p` round-trip
// through the runner's "ping" task (logged in?). Returns the status enum.
pub async fn probe_cli(adapter: &Adapter) -> ProbeResult {
    // Step 1: installed?
    let version = match probe_version(adapter).await {
        Ok(v) => v,
        Err(e) if e.kind == "spawn" => {
            return ProbeResult {
                status: ProbeStatus::NotFound,
                detail: format!("`{}` is not installed or not on PATH.", adapter.command),
                version: None,
            };
        }
        Err(e) => {
            return ProbeResult {
                status: ProbeStatus::Error,
                detail: format!("Version probe failed: {e}"),
                version: None,
            };
        }
    };

    // Step 2: logged in? A minimal round-trip through the runner's `ping` task: pipe
    // {} on stdin + a trivial prompt; the round-trip both proves auth and exercises the
    // exact pipe the real tasks use.
    let prompt = "Return ONLY this JSON object and nothing else: {\"ok\":true}";
    // Use the ping task spec but override the prompt to the trivial probe prompt.
    if let Some(spec) = adapter.tasks.get("ping") {
        let args = build_args(spec, prompt, None, None);
        match spawn_once(adapter, &args, b"{}").await {
            Ok((stdout, _)) => match extract_result(adapter, &stdout, false) {
                Ok(v) if v.get("ok").and_then(Value::as_bool) == Some(true) => ProbeResult {
                    status: ProbeStatus::Available,
                    detail: "CLI is installed and logged in.".into(),
                    version: Some(version),
                },
                Ok(_) => ProbeResult {
                    status: ProbeStatus::Available,
                    detail: "CLI responded (unexpected payload, but reachable).".into(),
                    version: Some(version),
                },
                Err(_) => ProbeResult {
                    status: ProbeStatus::Error,
                    detail: "CLI ran but its output couldn't be parsed.".into(),
                    version: Some(version),
                },
            },
            Err(e) => classify_roundtrip_error(&e, version),
        }
    } else {
        // No ping task in a user descriptor → installed is the most we can assert.
        ProbeResult {
            status: ProbeStatus::Error,
            detail: "Adapter has no `ping` task to verify the round-trip.".into(),
            version: Some(version),
        }
    }
}

// Map a failed round-trip to a status. A non-zero exit whose stderr mentions
// auth/login is "Not logged in"; everything else is a generic Error (installed,
// version ok, but the call failed). This is the logged-out branch the spec asks us to
// reason about/unit-test without actually logging out.
fn classify_roundtrip_error(e: &TaskError, version: String) -> ProbeResult {
    let blob = format!("{} {}", e.message, e.stderr.clone().unwrap_or_default()).to_lowercase();
    let looks_auth = blob.contains("login")
        || blob.contains("log in")
        || blob.contains("logged in")
        || blob.contains("authenticat")
        || blob.contains("unauthorized")
        || blob.contains("not authenticated")
        || blob.contains("invalid api key")
        || blob.contains("oauth")
        || blob.contains("credential")
        || blob.contains("session expired");
    if looks_auth {
        ProbeResult {
            status: ProbeStatus::NotLoggedIn,
            detail: "Installed, but not logged in. Run `claude login` once, then retry.".into(),
            version: Some(version),
        }
    } else {
        ProbeResult {
            status: ProbeStatus::Error,
            detail: format!("Round-trip failed: {e}"),
            version: Some(version),
        }
    }
}

// --- Tauri commands -----------------------------------------------------------

// List all discovered plugins for the Settings AI CLI tab (summaries only): valid
// plugins AND malformed manifests (the latter carry `ok: false` + the validation error,
// §2.2). The frontend renders valid ones as cards and surfaces the invalid ones inline.
#[tauri::command]
pub async fn list_adapters(app: tauri::AppHandle) -> Result<Vec<AdapterSummary>, String> {
    let plugins = discover_plugins(&app);
    Ok(plugins
        .into_iter()
        .map(|p| match p.adapter {
            Some(a) => a.summary(p.builtin, Some(p.source)),
            None => malformed_summary(p.id, p.source, p.error.unwrap_or_else(|| "invalid manifest".into())),
        })
        .collect())
}

// "Rescan plugins" (§1 / §2.2): re-enumerate the plugins/ + adapters/ folders and return
// the fresh list. The loader is stateless (reads disk each call), so this is just
// list_adapters under a name the UI can bind a button to + clearer intent.
#[tauri::command]
pub async fn rescan_plugins(app: tauri::AppHandle) -> Result<Vec<AdapterSummary>, String> {
    list_adapters(app).await
}

// Read the active adapter id from app_setting (default = claude-code).
#[tauri::command]
pub async fn get_active_adapter(db: tauri::State<'_, crate::Db>) -> Result<String, String> {
    let id: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_setting WHERE key = 'active_adapter'")
            .fetch_optional(&db.pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(id.unwrap_or_else(|| DEFAULT_ADAPTER_ID.to_string()))
}

// Persist the active adapter id (spec §4.4: "persist the choice").
#[tauri::command]
pub async fn set_active_adapter(
    db: tauri::State<'_, crate::Db>,
    id: String,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO app_setting (key, value) VALUES ('active_adapter', ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(&id)
    .execute(&db.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// "Test CLI" probe for a given adapter id (or the active one when None).
#[tauri::command]
pub async fn test_cli(app: tauri::AppHandle, adapter_id: Option<String>) -> Result<ProbeResult, String> {
    let adapter = resolve_adapter(&app, adapter_id.as_deref())?;
    Ok(probe_cli(&adapter).await)
}

// Run a task through the runner. M6 exposes this so the verify can exercise the pipe
// (e.g. the "ping" task); M7–M9 call run_cli_task directly from their own commands.
// Returns the parsed task JSON or a stringified typed error.
#[tauri::command]
pub async fn run_task(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::Db>,
    task: String,
    input: Value,
    adapter_id: Option<String>,
) -> Result<Value, String> {
    // Resolve: explicit id → that adapter; else the active one from settings.
    let id = match adapter_id {
        Some(id) => id,
        None => get_active_adapter(db).await?,
    };
    let adapter = resolve_adapter(&app, Some(&id))?;
    run_cli_task(&adapter, &task, &input, None)
        .await
        .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))
}

// The agent-facing meta-instruction doc (feature-cli-plugins.md §9), shipped in-app for
// the "Add adapter…" dialog AND written to the plugins/ README. Returned as a string so
// the frontend renders it verbatim.
#[tauri::command]
pub fn adapter_meta_instructions() -> String {
    META_INSTRUCTIONS.to_string()
}

// The manifest JSON Schema (feature-cli-plugins.md §3.3), shipped in-app + written to
// plugins/manifest.schema.json so an authoring agent can self-validate.
#[tauri::command]
pub fn plugin_manifest_schema() -> String {
    MANIFEST_SCHEMA.to_string()
}

// feature-cli-plugins.md §9 — "Onboard a new CLI as a plugin". The standalone, in-app
// agent-facing doc: any local AI agent can author a plugin unaided, no source code,
// minimal effort — by dropping a folder into %APPDATA%/com.interviewlab.app/plugins/<id>/.
const META_INSTRUCTIONS: &str = r#"# Onboard a new CLI as an InterviewLab plugin

You are authoring a self-contained InterviewLab **plugin** so the app can drive a local AI
CLI for batch tasks and/or agentic chat — by dropping a folder into
`%APPDATA%/com.interviewlab.app/plugins/<id>/`. You will NOT edit the app's source.

## Plugin layout
```
plugins/<id>/
  manifest.json    # REQUIRED — the plugin descriptor (alias: adapter.json)
  README.md        # notes: which CLI, how to install/login, caveats
  adapter[.exe|.js]# OPTIONAL — adapter program (Tier 2; see §6 of feature-cli-plugins.md)
```
The folder name IS the canonical `id` and must equal `manifest.id`. Legacy flat
`adapters/<id>.json` files are still loaded (degenerate batch-only plugins).

## 1. Decide the tier (one decision)
Run the CLI's `--help`. A **Tier 1 (descriptor-only, pure JSON, zero code)** plugin works if
the CLI has:
1. a one-shot prompt + machine-readable JSON mode (e.g. `-p … --output-format json`) → `batch-tasks`,
2. a streaming ndjson mode matching a shipped parser (`claude-stream-json`, `gemini-stream-json`, `openai-jsonl`) → `streaming`,
3. session/resume → `multi-turn`,
4. MCP (loads an MCP config, calls `mcp__…` tools) → `tool-use`.
If any needed piece doesn't map (bespoke output, no MCP, weird sessions) → **Tier 2: ship a
small adapter program** that speaks the stdio chat protocol (feature-cli-plugins.md §6) and
normalizes the CLI. Set `chat.mode: "adapter-program"` + an `adapter_program` block.

## 2. Write the manifest (validate against manifest.schema.json)
- `id` = folder name; `command` = the executable; `capabilities` = the subset you verified.
- Fill the blocks for ONLY those capabilities (orthogonality rule):
  - `io` + `tasks` for **batch-tasks**. The prompt must say "return ONLY JSON matching this
    schema". Preserve segment ids/timing/labels in cleanup (change only `text`); synthesis
    findings carry `goal_id` + evidence; diff is findings-level.
  - `chat.stream` (+ `parse`) for **streaming**; `chat.session` for **multi-turn**;
    `chat.tools` (MCP) for **tool-use**.
  - Use the placeholders the app fills: `{prompt}`, `{system_prompt_file}`,
    `{mcp_config_file}`, `{session_id}`, and the app-managed `{session_args}` /
    `{mcp_args}` / `{allowed_tools_args}` groups.
- Write a `probe` (a cheap command + expected exit code) and an `auth` note (prefer the
  CLI's own login over env keys; record any one-time interactive login the user does once).

## 3. If Tier 2, write the adapter program (feature-cli-plugins.md §6)
Read one JSON `turn` line from stdin; invoke your CLI with `text` as the prompt and `system`
as the system prompt; stream `token` lines to stdout as output arrives; emit `done` with a
`session_id`. For tools, emit a `tool_call` and wait for the host's `tool_result` line. Honor
`cancel`. Keep it tiny — a 50-line script is a fine adapter. (v1 ships the descriptor tier;
the adapter-program RUNTIME is a documented, frozen extension point — `protocol_version: 1`.)

## 4. Self-test (no app source; you do this)
1. Validate `manifest.json` against `manifest.schema.json`. Fix until clean.
2. Run the `probe` command; confirm the expected exit code (and that the CLI is logged in).
3. For each batch task, pipe an example input through `command + tasks[t].args_template`;
   confirm valid output JSON of the right shape (cleanup preserves ids/timing; synthesis
   findings have `goal_id`+evidence; diff is findings-level).
4. Chat smoke (descriptor): run the `chat.stream` command on a trivial prompt; confirm the
   named parser yields ≥1 token event and a final event carrying a `session_id`.
5. Install: drop the folder in `plugins/<id>/`, open Settings → **Rescan plugins**, select
   the plugin, click **Test CLI** → Available. Run one real Clean and (if chat) one question.

## Worked example — Claude Code (the reference plugin, all four capabilities)
`-p --output-format json` (batch), `stream-json --verbose --include-partial-messages` (token
stream), `--resume` (multi-turn), `--mcp-config … --strict-mcp-config` + `--allowedTools` +
`--tools ""` + `--permission-mode dontAsk` (scoped MCP tools, no built-ins), `--setting-sources ""`
+ neutral cwd + NO `--bare` (isolation + subscription auth). No adapter program, no code.
Clone its `manifest.json` for the next descriptor-tier CLI: swap `command`, set the right
`parse`, adjust the MCP-config flag names. (Gemini-CLI forks like Qwen Code reuse
`parse: "gemini-stream-json"`.)"#;

// feature-cli-plugins.md §3.3 — the manifest JSON Schema, shipped in-app + on disk so an
// authoring agent self-validates. Kept as a single source-of-truth string.
const MANIFEST_SCHEMA: &str = r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "InterviewLab plugin manifest",
  "type": "object",
  "required": ["id", "name", "command", "capabilities", "probe", "auth"],
  "properties": {
    "manifest_version": { "type": "integer", "default": 1 },
    "id": { "type": "string", "description": "Canonical id; must equal the plugin folder name." },
    "name": { "type": "string" },
    "version": { "type": "string" },
    "vendor": { "type": "string" },
    "command": { "type": "string", "description": "Executable on PATH or an absolute path." },
    "capabilities": {
      "type": "array",
      "items": { "enum": ["batch-tasks", "streaming", "multi-turn", "tool-use"] }
    },
    "probe": {
      "type": "object",
      "required": ["args"],
      "properties": {
        "args": { "type": "array", "items": { "type": "string" } },
        "expect_exit_code": { "type": "integer", "default": 0 }
      }
    },
    "auth": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": { "type": "string", "description": "'session' | 'env' | ..." },
        "env": { "type": "array", "items": { "type": "string" } },
        "note": { "type": "string" }
      }
    },
    "io": {
      "type": "object",
      "description": "Required iff capabilities includes 'batch-tasks'.",
      "required": ["payload_via", "result_extract"],
      "properties": {
        "payload_via": { "enum": ["stdin", "arg", "file"] },
        "prompt_via": { "type": "string" },
        "result_extract": {
          "type": "object",
          "required": ["format"],
          "properties": {
            "format": { "enum": ["json", "raw"] },
            "json_path": { "type": "string" }
          }
        },
        "timeout_sec": { "type": "integer", "default": 600 },
        "max_stdin_bytes": { "type": "integer", "default": 10000000 }
      }
    },
    "tasks": {
      "type": "object",
      "description": "Required (non-empty) iff capabilities includes 'batch-tasks'.",
      "additionalProperties": {
        "type": "object",
        "required": ["args_template"],
        "properties": {
          "args_template": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "chat": {
      "type": "object",
      "properties": {
        "mode": { "enum": ["descriptor", "adapter-program"] },
        "stream": {
          "type": "object",
          "description": "Required iff capabilities includes 'streaming'.",
          "required": ["args_template"],
          "properties": {
            "args_template": { "type": "array", "items": { "type": "string" } },
            "parse": { "enum": ["claude-stream-json", "gemini-stream-json", "openai-jsonl"] }
          }
        },
        "session": {
          "type": "object",
          "description": "Required iff capabilities includes 'multi-turn'.",
          "required": ["resume_args"],
          "properties": {
            "resume_args": { "type": "array", "items": { "type": "string" } },
            "session_id_from": { "type": "string" }
          }
        },
        "tools": {
          "type": "object",
          "description": "Required (or an adapter_program) iff capabilities includes 'tool-use'.",
          "properties": {
            "transport": { "enum": ["mcp", "stdio-relay"] },
            "mcp_config_args": { "type": "array", "items": { "type": "string" } },
            "allowed_tools_arg": { "type": "string" },
            "tool_namespace": { "type": "string" }
          }
        }
      }
    },
    "adapter_program": {
      "type": "object",
      "description": "Tier 2. Required (or chat.tools) iff capabilities includes 'tool-use' and mode is 'adapter-program'.",
      "required": ["command"],
      "properties": {
        "command": { "type": "string" },
        "args": { "type": "array", "items": { "type": "string" } },
        "protocol_version": { "type": "integer", "default": 1 }
      }
    }
  }
}"#;

// --- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bundled_descriptor_parses_and_matches_spec() {
        let a = builtin_adapter();
        assert_eq!(a.id, "claude-code");
        assert_eq!(a.command, "claude");
        // No --bare anywhere; subscription auth requirement (spec §7.2).
        for spec in a.tasks.values() {
            assert!(!spec.args_template.iter().any(|x| x == "--bare"), "must not use --bare");
            // Isolation flags present.
            assert!(spec.args_template.iter().any(|x| x == "--setting-sources"));
            assert!(spec.args_template.iter().any(|x| x == "--strict-mcp-config"));
            assert!(spec.args_template.iter().any(|x| x == "--output-format"));
        }
        // No env var required (subscription/session auth).
        assert_eq!(a.auth.auth_type, "session");
        assert!(a.auth.env.is_empty());
        // stdin payload, parse `result` (io is now Optional — the reference plugin has it).
        let io = a.io.as_ref().expect("claude-code has an io block");
        assert_eq!(io.payload_via, "stdin");
        assert_eq!(io.result_extract.json_path, "result");
        assert_eq!(io.max_stdin_bytes, 10_000_000);
        // The ping task exists for the probe + verify.
        assert!(a.tasks.contains_key("ping"));
        assert!(a.tasks.contains_key("transcript-cleanup"));
        assert!(a.tasks.contains_key("cycle-synthesis"));
        assert!(a.tasks.contains_key("cycle-diff"));
        // The reference plugin declares all four capabilities (feature-cli-plugins.md §9.5).
        assert!(a.has_capability(CAP_BATCH));
        assert!(a.has_capability(CAP_STREAMING));
        assert!(a.has_capability(CAP_MULTI_TURN));
        assert!(a.has_capability(CAP_TOOL_USE));
        // tool-use ⇒ chat.tools present (MCP descriptor block).
        assert!(a.chat.as_ref().and_then(|c| c.tools.as_ref()).is_some());
    }

    // The two PROOF plugins parse + validate and expose the right capabilities/shape
    // (feature-cli-plugins.md §12.3 — proves "any CLI, no source change").
    #[test]
    fn bundled_proof_plugins_parse_and_validate() {
        // Qwen Code: a Gemini-CLI fork → gemini-stream-json; batch + streaming + tool-use,
        // NO multi-turn (no documented --resume); answer field is `response`.
        let qwen = parse_manifest(QWEN_CODE_DESCRIPTOR).expect("qwen-code manifest valid");
        assert_eq!(qwen.id, "qwen-code");
        assert_eq!(qwen.command, "qwen");
        assert!(qwen.has_capability(CAP_BATCH));
        assert!(qwen.has_capability(CAP_STREAMING));
        assert!(qwen.has_capability(CAP_TOOL_USE));
        assert!(!qwen.has_capability(CAP_MULTI_TURN), "qwen has no documented resume");
        assert_eq!(qwen.io.as_ref().unwrap().result_extract.json_path, "response");
        assert_eq!(
            qwen.chat.as_ref().and_then(|c| c.stream.as_ref()).unwrap().parse,
            "gemini-stream-json"
        );

        // Antigravity CLI: best-effort, batch-only, RAW output (no stable JSON), command `agy`.
        let agy = parse_manifest(ANTIGRAVITY_CLI_DESCRIPTOR).expect("antigravity manifest valid");
        assert_eq!(agy.id, "antigravity-cli");
        assert_eq!(agy.command, "agy");
        assert!(agy.has_capability(CAP_BATCH));
        assert!(!agy.has_capability(CAP_STREAMING));
        assert_eq!(agy.io.as_ref().unwrap().result_extract.format, "raw");

        // All three bundled descriptors parse (the registry the loader compiles in).
        for (id, json) in bundled_descriptors() {
            assert!(parse_manifest(json).is_ok(), "bundled `{id}` must validate");
        }
    }

    // Legacy back-compat: a flat descriptor with NO `capabilities` + a `tasks` block is a
    // degenerate batch-only plugin (§2.1). Effective capabilities default to ["batch-tasks"].
    #[test]
    fn legacy_descriptor_defaults_to_batch_only() {
        let legacy = r#"{
          "id": "legacy-cli", "name": "Legacy", "command": "legacy",
          "probe": { "args": ["--version"] },
          "auth": { "type": "session" },
          "io": { "payload_via": "stdin", "result_extract": { "format": "json", "json_path": "result" } },
          "tasks": { "transcript-cleanup": { "args_template": ["-p", "{prompt}"] } }
        }"#;
        let a = parse_manifest(legacy).expect("legacy descriptor still loads");
        assert_eq!(a.effective_capabilities(), vec![CAP_BATCH.to_string()]);
        assert!(a.has_capability(CAP_BATCH));
        assert!(!a.has_capability(CAP_STREAMING));
    }

    // Manifest validation rejects capability/block mismatches with a clear error (§3.3) so
    // malformed manifests are surfaced (not silently broken at runtime).
    #[test]
    fn validate_manifest_enforces_capability_blocks() {
        // Helper: the error message (Adapter isn't Debug, so don't use unwrap_err()).
        fn err_of(json: &str) -> String {
            match parse_manifest(json) {
                Ok(_) => panic!("expected a validation error, got Ok"),
                Err(e) => e,
            }
        }

        // streaming declared but no chat.stream → rejected.
        let err = err_of(r#"{
          "id": "x", "name": "X", "command": "x", "capabilities": ["streaming"],
          "probe": { "args": ["--version"] }, "auth": { "type": "session" }
        }"#);
        assert!(err.contains("streaming"), "got: {err}");

        // batch-tasks declared but no io/tasks → rejected.
        assert!(err_of(r#"{
          "id": "x", "name": "X", "command": "x", "capabilities": ["batch-tasks"],
          "probe": { "args": ["--version"] }, "auth": { "type": "session" }
        }"#).contains("batch-tasks"));

        // tool-use with neither chat.tools nor adapter_program → rejected.
        assert!(err_of(r#"{
          "id": "x", "name": "X", "command": "x",
          "capabilities": ["streaming", "tool-use"],
          "probe": { "args": ["--version"] }, "auth": { "type": "session" },
          "chat": { "mode": "descriptor", "stream": { "args_template": ["-p", "{prompt}"], "parse": "claude-stream-json" } }
        }"#).contains("tool-use"));

        // Missing required `command` → serde/validation error (not a panic).
        let bad4 = r#"{ "id": "x", "name": "X", "probe": { "args": [] }, "auth": { "type": "session" }, "tasks": {} }"#;
        assert!(parse_manifest(bad4).is_err());
    }

    // The manifest schema itself is valid JSON (it ships to disk + the Add-plugin dialog).
    #[test]
    fn manifest_schema_is_valid_json() {
        let v: Value = serde_json::from_str(MANIFEST_SCHEMA).expect("schema is valid JSON");
        assert_eq!(v["title"], "InterviewLab plugin manifest");
    }

    #[test]
    fn extract_result_from_claude_envelope() {
        let a = builtin_adapter();
        // Exactly the shape the real claude CLI returns (verified on this machine):
        // top-level `result` is a JSON-encoded string.
        let stdout = r#"{"type":"result","subtype":"success","is_error":false,"result":"{\"ok\":true}","session_id":"x","total_cost_usd":0.04}"#;
        let v = extract_result(&a, stdout, false).unwrap();
        assert_eq!(v, json!({ "ok": true }));
    }

    #[test]
    fn extract_result_prefers_structured_output_when_schema_used() {
        let a = builtin_adapter();
        // With --json-schema, `result` may be fence-wrapped but structured_output is clean.
        let stdout = r#"{"result":"```json\n{\"ok\": true}\n```","structured_output":{"ok":true}}"#;
        let v = extract_result(&a, stdout, true).unwrap();
        assert_eq!(v, json!({ "ok": true }));
    }

    #[test]
    fn extract_json_value_tolerates_fences_and_prose() {
        // Plain.
        assert_eq!(extract_json_value(r#"{"ok":true}"#).unwrap(), json!({"ok":true}));
        // ```json fence.
        assert_eq!(
            extract_json_value("```json\n{\"ok\":true}\n```").unwrap(),
            json!({"ok":true})
        );
        // Bare ``` fence.
        assert_eq!(
            extract_json_value("```\n{\"ok\":true}\n```").unwrap(),
            json!({"ok":true})
        );
        // Prose around it.
        assert_eq!(
            extract_json_value("Sure! Here you go:\n{\"ok\":true}\nHope that helps.").unwrap(),
            json!({"ok":true})
        );
        // Array.
        assert_eq!(extract_json_value("[1,2,3]").unwrap(), json!([1, 2, 3]));
    }

    #[test]
    fn build_args_substitutes_prompt_and_appends_schema() {
        let a = builtin_adapter();
        let spec = a.tasks.get("ping").unwrap();
        // No schema: {prompt} substituted, no --json-schema.
        let args = build_args(spec, "HELLO", None, None);
        assert!(args.contains(&"HELLO".to_string()));
        assert!(!args.iter().any(|x| x == "--json-schema"));
        // With schema: --json-schema <schema> appended.
        let schema = json!({ "type": "object" });
        let args = build_args(spec, "HELLO", Some(&schema), None);
        let i = args.iter().position(|x| x == "--json-schema").unwrap();
        assert_eq!(args[i + 1], schema.to_string());
    }

    // PERF: a per-task model is injected as `--model <alias>` (stubbed, no real CLI call).
    #[test]
    fn build_args_injects_model_when_requested() {
        let a = builtin_adapter();
        let spec = a.tasks.get("transcript-cleanup").unwrap();
        // No model → no --model flag (CLI default).
        let args = build_args(spec, "P", None, None);
        assert!(!args.iter().any(|x| x == "--model"));
        // haiku model → `--model haiku` appended exactly once.
        let args = build_args(spec, "P", None, Some("haiku"));
        let i = args.iter().position(|x| x == "--model").expect("--model present");
        assert_eq!(args[i + 1], "haiku");
        assert_eq!(args.iter().filter(|x| *x == "--model").count(), 1);
        // Empty model string is treated as "no model".
        let args = build_args(spec, "P", None, Some(""));
        assert!(!args.iter().any(|x| x == "--model"));
        // With a schema AND a model, both are present.
        let schema = json!({ "type": "object" });
        let args = build_args(spec, "P", Some(&schema), Some("sonnet"));
        assert!(args.iter().any(|x| x == "--json-schema"));
        let i = args.iter().position(|x| x == "--model").unwrap();
        assert_eq!(args[i + 1], "sonnet");
    }

    #[test]
    fn classify_logged_out_branch() {
        // Simulate the logged-out CLI: a non-zero exit whose stderr mentions login.
        let err = TaskError::with_stderr(
            "exit",
            "CLI exited with status exit code: 1",
            "Error: Invalid API key · Please run `claude login`".into(),
        );
        let r = classify_roundtrip_error(&err, "2.1.x".into());
        assert_eq!(r.status, ProbeStatus::NotLoggedIn);

        // A non-auth failure stays a generic Error.
        let err2 = TaskError::with_stderr("exit", "boom", "segfault".into());
        let r2 = classify_roundtrip_error(&err2, "2.1.x".into());
        assert_eq!(r2.status, ProbeStatus::Error);
    }

    #[test]
    fn meta_instructions_nonempty() {
        // The full plugin-authoring doc (§9): mentions the plugin folder, capabilities,
        // the manifest schema, the no-`--bare` Claude Code rule, and the batch constraints.
        let m = adapter_meta_instructions();
        assert!(m.contains("plugins/<id>/"));
        assert!(m.contains("capabilities"));
        assert!(m.contains("manifest.schema.json"));
        assert!(m.contains("--bare"));
        assert!(m.contains("cleanup")); // the cleanup-preserves-ids constraint
    }

    // Real round-trip against the installed, logged-in `claude` CLI. Ignored by default
    // (consumes a tiny bit of subscription usage + needs the CLI on PATH); run with
    //   cargo test -- --ignored real_round_trip
    // to verify M6's pipe end-to-end through the actual runner.
    #[tokio::test]
    #[ignore]
    async fn real_round_trip_ping() {
        let a = builtin_adapter();
        let out = run_cli_task(&a, "ping", &json!({}), None).await.unwrap();
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true), "got {out:?}");

        let probe = probe_cli(&a).await;
        assert_eq!(probe.status, ProbeStatus::Available, "{}", probe.detail);
    }
}
