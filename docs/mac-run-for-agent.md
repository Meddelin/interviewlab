# Run InterviewLab on macOS (Apple Silicon) — instructions for an AI coding agent

**You are an AI coding agent running on a Mac with Apple Silicon (M3 Pro or better).**
Your job: get InterviewLab **building and running**, set up the **local AI CLI**, and **report any errors**
clearly. A human will then drive the end‑to‑end test (upload a real interview, click through the pipeline).

> The app was built and verified on **Windows + NVIDIA CUDA**. macOS support is implemented in code
> (Metal feature, device detection, bundle config) but has **never been run on real Apple hardware** — so
> expect a few platform issues. This doc tells you how to run it and, crucially, **how to tell a
> plugin‑folder fix (you can do it) from a source‑code fix (stop and report it)**.

---

## Updating an existing setup? Read this FIRST (don't repeat verified init)

If this Mac **already ran InterviewLab successfully before** — the app launched, your CLI was active
and **Test CLI → Available**, and an ASR model was downloaded — then you are doing an **incremental
update** (a `git pull` brought new code), **not** a fresh initialization. The one‑time setup below
(§1, §4, §5) was **verified once and stays valid across updates**; re‑doing it wastes time and, for
the multi‑GB models, bandwidth. **Skip what was already confirmed and only do the delta.**

**Skip (already verified at init — trust it):**
- **§1 Prerequisites** — Xcode CLT, `brew node/ffmpeg`, Rust, your CLI. Assume installed; (re)install a
  tool **only if the build actually errors that it's missing**.
- **§5 CLI / plugin registration** — your manifest under `…/plugins/<id>/manifest.json` **persists**.
  Do **not** re‑register, re‑select, or overwrite it. (Re‑run **Test CLI** only if an LLM step fails.)
- **§4 Model downloads** — the whisper + diarization models in the app data dir **persist**. Do **not**
  re‑download.

**Do ONLY the update:**
1. `git pull`, then `npm install` (picks up any new JS deps); the next `npm run tauri dev` recompiles
   the Rust **incrementally** (not from scratch).
2. Verify **only what this update changed** — read the PR / changelog deltas, exercise just those paths.
3. Report only **new** source‑side failures per §6B.

> Rule of thumb: an init step is **"verified once, trusted thereafter."** Re‑verify it only if (a) this
> update's changelog touched it, or (b) something downstream actually fails and points back at it.

**Delta for THIS update (v3.0 — product overhaul; previous delta's ASR items are baseline now):**
- **Button rename:** the per‑segment rewrite in the transcript editor is now labeled
  **«Переписать сегмент»** ("Rewrite segment"). Same mechanics — one segment, plain text in/out.
- **Two new OPTIONAL batch tasks** through the same contract — nothing to install:
  **`guide-coverage`** (did the interview cover the guide? — «Покрытие гайда» in the interview
  summary panel) falls back to `cycle-synthesis-extract` when absent from your manifest;
  **`guide-generate`** (draft a guide from a product — Guides page → «Сгенерировать из продукта»)
  falls back to `cycle-synthesis`. Add them to `tasks`/`models.tasks` only for per‑task model control.
- **Chat can now DO things (invlab-action):** the assistant may emit a fenced action block that the app
  parses from its final text — adds glossary terms / updates a finding, rendered as chips with undo.
  **No CLI support required** beyond normal text output; the `tool-use` capability flag is NOT needed.
- **Cumulative synthesis** (REDUCE sees the previous wave), **HTML report export** (Synthesis tab),
  **global task center** (header badge, Ctrl+Shift+B), tabs in URL, breadcrumbs.
- **Glossary:** the starter seed grew to ~295 RU‑tuned terms (product editor → Glossary → «Базовый
  набор»); re‑import now **merges** aliases into existing terms instead of duplicating.
- **Destructive re‑runs confirm first:** delete / re‑transcribe / re‑clean / re‑diarize now open a
  confirm dialog warning that manual edits are erased — expect the dialog, not silent data loss.
- **Plugins folder docs self‑refresh:** `plugins/README.md` + `manifest.schema.json` are rewritten when
  the app updates (your own `plugins/<id>/manifest.json` files are never touched).

---

## 0. What "working" looks like (the human's e2e)

So you know what to aim for. The human will do these clicks; you make each step **reachable** and report failures:

1. Create a **Product** (markdown description) and a **Guide** (research goals) in the libraries —
   or **generate a guide draft from the product** (Guides page → «Сгенерировать из продукта»; uses the
   `guide-generate` task or its fallback). The product editor also has a **Glossary** panel (see the
   note below) — import the **«Базовый набор»** starter set (~295 RU terms) or add a few terms
   (e.g. `API`, `Figma`, `дедлайн`) before transcribing.
2. Create a **Cycle**, link the product + guide.
3. **Upload a real interview** audio file (30+ min, any common format).
4. **Transcribe** it: pick a local Whisper model, language, `expected speakers = 2`. On Apple
   Silicon CPU a long file can be slow — while it runs you can **open the interview to watch the
   transcript stream in live**, percent and all, then a distinct **"Diarizing…"** phase (see §4.1).
5. Confirm **speaker separation** (S1 / S2 turns) and that segments read as **merged paragraphs**.
6. **Fix garbled segments** with the **per‑segment rewrite**: in the transcript editor each segment row
   has a **«Переписать сегмент»** button — clicking it re‑cleans **just that one segment** through the
   local CLI and swaps in the result. For the **whole transcript** there's a **"Clean"** action on the
   Interviews tab (batch cleanup through the CLI; re‑running it opens a confirm dialog because it
   overwrites manual edits — see the note below). Save writes the `edited` version.
7. **Re‑do a bad chunk (optional):** if a span came out wrong (mis‑segmented, wrong speaker, garbled
   audio), **select those segment rows** and click **"Перетранскрибировать"** — whisper re‑runs on just
   that time span and the whole file re‑diarizes so speakers stay consistent (see §4.1). Confirms first
   (it erases manual edits on that span).
8. **Build the glossary** (optional but recommended): on the **Interviews** tab each transcribed row has
   a **"Glossary"** button → suggest terms **From the transcript** or **From my edits**, review the
   candidates, and accept them into the product glossary (see the note below).
9. **Check guide coverage** (v3): open the interview → right‑panel **«Саммари»** → collapsible
   **«Покрытие гайда»** → **«Проверить покрытие»** — per‑goal/question covered/partial/missed statuses
   with evidence quotes, a 0‑100 score, and suggested follow‑up questions (uses the `guide-coverage`
   task or its fallback).
10. **Assign roles** to the speakers (interviewer / respondent).
11. **Synthesis** → findings grouped by goal + by role. Long runs show in the **task center** (header
    badge) and survive navigating away.
12. **Export the wave report** (Synthesis tab → **«Экспорт отчёта (HTML)»**) — a standalone HTML file
    with the summary, findings, diff, and coverage scores.
13. (Optional) a second cycle → **Diff** vs the previous wave (REDUCE also builds on the prior wave).
14. **Chat** about the cycle (streaming, grounded answers). Ask it to add glossary terms — the reply
    renders an **action chip** with undo (invlab-action; works with any CLI, see §5).

Everything is **local**: ASR (whisper.cpp) and diarization (sherpa‑onnx) run on‑device, no cloud, no Python.
Only the LLM steps (cleanup / synthesis / diff / chat / guide coverage / guide generation / glossary
mining) go through a **local AI CLI you configure** (§5) — whatever your environment provides.
**Claude is not available here**; no specific vendor is required.

> **Transcript cleanup comes in two forms.** The **per‑segment rewrite** — the editor's per‑row
> **«Переписать сегмент»** button — sends **just that segment's text** and accepts a plain‑text reply
> (the `rewrite_segment` command → `run_cli_task_text`). It reuses the **`transcript-cleanup`** task's
> `args_template` from your manifest, but **never** injects `--json-schema` and **never** expects
> `structured_output` — it just reads the envelope's `result` text. So any manifest whose
> `transcript-cleanup` task emits the normal `--output-format json` envelope works with **no changes**
> (a `json_schema_arg: false` plugin like Nessy works too — the rewrite ignores schema regardless).
> The **whole‑transcript batch cleanup** (Interviews tab → **"Clean" / «Очистить»**) drives the same
> task with the full batched `{id, text}` JSON‑echo contract — guarded by a per‑batch retry + a hard
> id‑alignment check, and re‑running it confirms first (it overwrites manual edits). If batch cleanup
> repeatedly trips the alignment guard on a weaker model, the transcript stays intact — fall back to
> per‑segment rewrites and report it per §6B.

> **Glossary (anglicisms / technical terms / local product names).** Russian product/tech interviews are
> full of English terms the ASR mangles (renders phonetically in Cyrillic, inconsistently). The fix is a
> per‑**product** **Glossary**: each entry is a `canonical` spelling + the garbled `aliases` the ASR
> produces. It feeds two places: the **whisper `initial_prompt`** (the canonical terms lead the prompt, so
> the ASR is biased to get them right up‑front) and **every cleanup / per‑segment‑rewrite prompt** (the
> glossary is the authority for term spellings). Manage terms in the **product editor's Glossary panel**;
> auto‑fill them from the **Interviews tab → "Glossary"** button, which mines candidates either **from the
> transcript** or **from your own raw→edited corrections** (so the glossary learns from manual fixes) and
> lets you review before accepting. For your CLI this means **one extra batch task, `glossary-extract`** —
> see §5. A plugin that doesn't declare it still works (the app falls back to `cycle-synthesis-extract`),
> and the glossary itself is fully optional — an empty glossary just means the prompts carry no term list,
> exactly as before.

---

## 1. Prerequisites (install what's missing)

```bash
# Xcode Command Line Tools (provides the Metal toolchain + clang)
xcode-select --install

# Homebrew packages
brew install node ffmpeg            # Node 20+, and ffmpeg (the app shells out to decode audio → 16kHz mono wav)

# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustc --version                     # confirm

# A local AI CLI for the LLM steps (cleanup / synthesis / diff / chat).
# ⚠️ Claude / Anthropic is NOT available inside this environment. Use whatever local or
#    internal AI CLI your perimeter provides. Install it and put its binary on PATH, then
#    wire it up as a plugin in §5 — no source change, no specific vendor required.
<your-cli> --version                # confirm YOUR CLI is installed and reachable
```

Notes:
- **No CUDA, no Python** on macOS. GPU acceleration is **Metal**, built into the SDK.
- `ffmpeg` is required — the Rust backend invokes it to normalize audio to 16 kHz mono PCM.
- **Do not install or rely on Claude Code here** — the app ships `claude-code` only as a *reference*
  manifest; in this environment you must point the app at your own available CLI (§5).

---

## 2. Get the code & install JS deps

```bash
git clone <THIS_REPO_URL> interviewlab-app
cd interviewlab-app/interviewlab
npm install
```

---

## 3. Build & run (Metal)

```bash
# From interviewlab-app/interviewlab
npm run tauri dev -- --features metal      # Apple Silicon GPU (whisper.cpp Metal backend)
# CPU-only fallback (slower, always works):
# npm run tauri dev
```

- The **first build compiles whisper.cpp + sherpa‑onnx** and downloads their prebuilt dylibs — this can take
  several minutes. Subsequent builds are incremental.
- A native window opens. The frontend is served by Vite (hot‑reload); the Rust backend runs the commands.

If the build or launch fails, see **§6** to classify the error before doing anything.

### 3.1 Transcription speed/quality on Apple Silicon (no model change)

These tune the **same** model (large‑v3) — same weights, accuracy unchanged:

- **Already on by default in code** (you get these just by building with `metal`): **flash attention**
  (a faster GPU attention — measured ~21% faster on CUDA; output is near‑identical, not bit‑identical, with no
  meaningful accuracy change) and a **backend‑aware** CPU **thread count** for the log‑mel/sampling front‑end
  (clamp [4,8] on a GPU build, all‑but‑one core on a CPU build).
- **Core ML / Apple Neural Engine (the big win) — opt‑in build flag, now turnkey:**
  ```bash
  npm run tauri dev -- --features metal,coreml
  ```
  This runs whisper's heavy **encoder on the ANE** on top of Metal. It needs a CoreML encoder bundle next to
  the ggml model (`…/com.interviewlab.app/models/ggml-large-v3-encoder.mlmodelc`) — and the app **now fetches
  it for you**: on the `coreml` build, downloading an ASR model also best‑effort downloads + unzips the matching
  `.mlmodelc` from HF `ggerganov/whisper.cpp` next to the `.bin`. **No manual placement.** (If the model was
  already downloaded before you switched to `coreml`, re‑run the model download once — it's idempotent and that
  re‑run triggers the encoder fetch.) If the fetch **fails or is absent**, whisper logs a notice and falls back
  to the Metal encoder, so the build still runs — it just doesn't get the ANE speedup. **The FIRST run with
  CoreML is slow** (the ANE compiles + caches the model, ~1–2 min); subsequent runs are fast. Building `coreml`
  needs Xcode (the CoreML framework).
- **If transcription is still slow:** confirm Metal actually engaged — after a transcription, the transcript's
  engine string should read `@metal`, not `@cpu`. `@cpu` means the `metal` feature/init didn't kick in (a
  **source** issue per §6B — report it). Diarization is separate (multi‑threaded; it requests the **CoreML**
  execution provider on macOS, falling back to CPU per‑op) and on a long interview can take a while; that's
  expected. Even when a run is slow you don't have to wait blind: you can
  **open the interview and watch it stream live**, and a failed/killed run is **resumable from a checkpoint**
  (no re‑doing the whole file) — see **§4.1**.
- **Quality:** accuracy is set by the model + decoder, not the platform — Metal/CoreML give near‑identical text
  to CPU (GPU float ordering differs, so not byte‑for‑byte, but word accuracy is the same). The one real
  accuracy knob is beam search (slower); the speed the GPU/ANE buys back makes it affordable if you ever want it
  (it's a code change, not a flag — flag it per §6B if the human asks for higher accuracy).

---

## 4. Local models (ASR + diarization, all on‑device)

- **Whisper (ASR):** in the app → **Settings → ASR model** → download one. Recommend **`large-v3`** (best
  quality, fine on Metal) or **`base`** (fast). Models download into the app data dir.
- **Diarization (speaker split):** the app fetches the sherpa‑onnx ONNX models (pyannote segmentation +
  3D‑Speaker embedding) on first use / via a "download diarization models" action. ~real‑time, no Python;
  multi‑threaded, and on macOS it requests the **CoreML** execution provider (ANE/GPU) with automatic CPU
  fallback per‑op.

App data dir on macOS: `~/Library/Application Support/com.interviewlab.app/`

### 4.1 Watching a slow run, re‑doing a chunk, resuming after a crash

Because Apple‑Silicon **CPU** transcription (no Metal, or `@cpu` fallback) of a long interview can take a
while, the run is **observable and recoverable** — you don't have to stare at a frozen row or start over:

- **Watch it live.** Open the interview **while it's transcribing** (click the row / "Open editor" — it's
  reachable now, not only after it finishes). The editor shows a progress header with whisper's real
  percent and the transcript **streaming in segment by segment**, then a separate **"Diarizing…"** phase
  (speaker separation runs after ASR). A **Stop** button is right there. The transcript text streams from
  whisper's new‑segment callback; speakers are placeholder **S1** until the diarization phase relabels them.
- **Re‑transcribe just a chunk.** In the editor, select the bad segment rows → **"Перетранскрибировать"**.
  Whisper re‑runs on **only** that `[start, end]` span, splices the fresh segments over the old ones, then
  re‑diarizes the **whole** audio (so S1/S2 stay globally consistent — a slice diarized alone would get
  inconsistent labels). The run streams live like a normal transcription.
- **Resume after a failure/crash.** During every run the partial transcript is **checkpointed to SQLite
  every few seconds**. If transcription errors out, or the app is killed mid‑run, the interview shows a
  **"Транскрипция прервалась на M:SS — продолжить"** banner: clicking it re‑transcribes **only the
  remaining tail** `[checkpoint, end]` and appends it to the saved prefix (then diarizes the whole file) —
  it does **not** re‑do the part that already succeeded. On a clean success the checkpoint is cleared.

For an agent, the practical upshot: a slow or flaky transcription is **not** a dead end — surface the live
view, and if a run dies tell the human it's **resumable** (the banner). These are all **first‑class
features in the current build**, not workarounds. If any of them misbehaves (live view never updates, the
resume banner never appears after a kill, a chunk re‑transcribe corrupts timing), that's a **source‑side**
issue — report per §6B (subsystem: `src-tauri/src/asr.rs` + the live‑progress UI in `src/`).

---

## 5. Local CLI setup — the **pluggable adapter** (read this carefully)

The app never hard‑codes an AI vendor. It drives a **locally‑installed CLI** through a **plugin layer**, so in
this environment you point it at **your own available CLI**. **Adding or fixing a CLI is a config‑only
operation — NO source change, no recompile.**

> ⚠️ The app's bundled **default** active plugin is `claude-code`, which **will NOT work here** (no Claude
> access). Your first task is to register your environment's CLI as a plugin and **make it the active one**.

**Register your CLI (the whole setup):**
1. Drop a manifest at
   ```
   ~/Library/Application Support/com.interviewlab.app/plugins/<id>/manifest.json
   ```
   The folder name must equal the manifest `id`.
2. App → **Settings → AI CLI → Rescan**, then **select your plugin as active**.
3. **Test CLI** → expect **Available**. (`Not logged in` / `command not found` → fix the CLI's auth or PATH,
   or the manifest `command`/args, then Test again.)

A manifest declares: the CLI `command`; its `capabilities` (`batch-tasks` for the cleanup/synthesis/diff
batch tasks, `streaming` + `multi-turn` for chat; `tool-use` is parsed but currently has **no runtime
effect** — chat "actions" don't need it, see below); a per‑task `args_template` (how to invoke the CLI for
each task, with `{prompt}` substitution); how to **extract the result** from the CLI's output (e.g. a JSON
path); and, for chat, a `chat.stream` block naming the stream parser.

> **v3 task names & fallbacks:** `guide-coverage` and `guide-generate` are **optional** — omit them and
> the app falls back to your `cycle-synthesis-extract` / `cycle-synthesis` task config respectively.
> **Chat actions (invlab-action) need NO manifest support**: the app parses the fenced block from the
> assistant's final text, whatever CLI produced it. The always‑current full guide (minimal manifest,
> required vs optional tasks, limits, `[E-CLI-*]` remedies) is written to
> `…/com.interviewlab.app/plugins/README.md` and **refreshes on app updates** — read it on‑disk, or via
> Settings → AI CLI → "For agent".

> **Batch output shape:** `result_extract: { format: "json", json_path: "result" }` accepts a single JSON
> object, a **JSONL / stream-json** stream (one object per line), OR a **JSON array** of stream events — the
> app picks the element/line carrying `result`. So a CLI whose `--output-format json` emits a stream or an
> array works as-is. Prefer that over `format: "raw"` + prompt-engineering "return only JSON" (brittle). A
> markdown-fenced `result` string is unwrapped automatically.

### 5.1 Recipe: a stream-json CLI with NO `--json-schema` support (e.g. **Nessy CLI**)

Some CLIs can't do schema-constrained output. The app, by default, **auto-injects `--json-schema`** into the
cleanup / synthesis / diff tasks (to get clean structured output from Claude/Qwen). A CLI that rejects that
flag (Nessy **exits 52**: "model produced plain text instead of calling the structured_output tool") would
fail every one of those tasks — and **no `args_template` can stop the injection**.

The fix is a manifest flag — **`io.json_schema_arg: false`** — which tells the runner to skip `--json-schema`
for this plugin. The schema still goes into the **prompt** (so the model knows the contract), and the result
is tolerant-parsed (JSONL/array + markdown-fence stripping). This is config-only, no source change.

**Working Nessy manifest** — `~/Library/Application Support/com.interviewlab.app/plugins/nessy/manifest.json`:
```json
{
  "manifest_version": 1,
  "id": "nessy",
  "name": "Nessy CLI",
  "command": "nessy",
  "capabilities": ["batch-tasks"],
  "probe": { "args": ["--version"], "expect_exit_code": 0 },
  "auth": { "type": "session" },
  "io": {
    "payload_via": "stdin",
    "prompt_via": "arg",
    "result_extract": { "format": "json", "json_path": "result" },
    "json_schema_arg": false
  },
  "tasks": {
    "ping":                    { "args_template": ["-p","{prompt}","--output-format","json"] },
    "transcript-cleanup":      { "args_template": ["-p","{prompt}","--output-format","json"] },
    "cycle-synthesis":         { "args_template": ["-p","{prompt}","--output-format","json"] },
    "cycle-synthesis-extract": { "args_template": ["-p","{prompt}","--output-format","json"] },
    "cycle-synthesis-reduce":  { "args_template": ["-p","{prompt}","--output-format","json"] },
    "glossary-extract":        { "args_template": ["-p","{prompt}","--output-format","json"] },
    "cycle-diff":              { "args_template": ["-p","{prompt}","--output-format","json"] }
  },
  "models": { "flag": "--model", "available": [
    {"id":"tgpt/qwen35-397b-a17b-fp8","label":"Qwen 35 (smart)"},
    {"id":"tgpt/qwen36-35b-a3b-fp8","label":"Qwen 36 (fast)"}],
    "tasks": {"transcript-cleanup":"tgpt/qwen36-35b-a3b-fp8","cycle-synthesis-extract":"tgpt/qwen35-397b-a17b-fp8","cycle-synthesis-reduce":"tgpt/qwen35-397b-a17b-fp8","glossary-extract":"tgpt/qwen35-397b-a17b-fp8","cycle-diff":"tgpt/qwen35-397b-a17b-fp8"} }
}
```
> **`glossary-extract`** powers the glossary auto‑suggest (§0 note). It's a plain batch task like
> the synthesis ones — same `--output-format json` shape, same `json_schema_arg: false` handling — so the
> line above is all it needs. It's **optional**: omit it and the app falls back to `cycle-synthesis-extract`
> for suggestions; the term list itself is optional too. Shares the Synthesis "Task models" bucket (so the
> `models.tasks` entry above is what sets its model).
>
> **`guide-coverage` / `guide-generate`** (v3, optional) work exactly the same way — plain batch tasks with
> the same `args_template` shape. Add them for per‑task model control, or omit them: coverage falls back to
> `cycle-synthesis-extract`, guide generation to `cycle-synthesis`. Both share the Synthesis model bucket.
The optional **`models`** block is what lets you pick Nessy's models per task: `flag` is the CLI's
model flag (`--model`), `available` populates the **Settings → AI CLI → "Task models"** picker (Cleanup /
Synthesis / Diff), and `tasks` sets each task's default model. **If you OMIT `models` entirely, the app injects
NO `--model`** and Nessy uses its own default model — which also fixes the old breakage where the app forced
`--model haiku` (a Claude-only alias Nessy doesn't have). Use `models` only when Nessy actually accepts a
`--model <id>` flag; set `flag` to `""` if it has none.

Then: Settings → AI CLI → **Rescan** → select **Nessy** active → **Test CLI**. Notes:
- **`--output-format json` is confirmed** against a real Nessy reply (v0.12.4): it emits a **JSON array** of
  events (`system/init` → `assistant/thinking` → `assistant/text` → `result`); the app takes the terminal
  `{"type":"result", …}` element and reads its `result` field — a JSON **string** (markdown-fenced OK), which
  is unwrapped + parsed into the task's `{"segments":[…]}`. `--output-format stream-json` (JSONL) also works;
  the default `text` does not (no envelope). There's a regression test in `adapter.rs`
  (`extract_result_handles_real_nessy_cleanup_array`) pinned to this exact shape.
- **Do NOT pass `--json-schema`** — that's the exit-52 trap; the `json_schema_arg: false` flag is what avoids
  it. (Nessy's reply has no `structured_output`, so the app reads `result` instead.)
- **Chat (optional):** Nessy's stream events in the integration notes look Claude-shaped
  (`{"type":"assistant","message":{"content":[{"text":…}]}}` then `{"type":"result","result":…}`). If Nessy's
  real stream matches that, add a `chat.stream` block with **`"parse": "claude-stream-json"`** plus
  `capabilities` `streaming` + `multi-turn` — **no new parser needed**. If the stream shape differs, a new
  named parser is a **source change** (§6B) — report the actual stream format rather than guessing.
- **Residual risk — cleanup id-alignment:** this applies to the **whole-transcript** batch cleanup
  (Interviews tab → "Clean" / «Очистить»). Without `--json-schema`, the model holds the "echo EVERY segment id
  exactly once" contract by prompt only. It's guarded by a per-batch retry + a hard alignment check, but a
  weaker model may trip it more often (you'll see a cleanup error; the transcript stays intact and
  re-runnable). If it fails repeatedly, that's a prompt tweak (generic, not Nessy-specific) — report it, don't
  hand-parse the output (parsing speaker-labelled prose back to segments by order silently corrupts the
  transcript). **The per-segment rewrite («Переписать сегмент») sidesteps this entirely** — one segment, plain
  text in/out, no ids to align.

**Reference templates** are written to the plugins folder on first run — `claude-code`, `qwen-code`,
`antigravity`. **Copy whichever is closest to your CLI's I/O shape and adapt it** (command, args, auth,
result‑extraction, stream parser). The bundled ones are only references; you are not required to use any of them.

> Rule of thumb: if a fix is "which CLI, which command, which flags, which capabilities, which result path,
> which stream parser" → it's a **manifest** change in the plugins folder. You can do it yourself, no source
> edit. If your CLI's chat output can't be parsed by an existing named stream parser, that parser is **source**
> (§6B) — report it.

---

## 6. ★ Errors: plugin‑folder fix (do it) vs source‑code fix (stop & report)

This is the most important section. When something fails, **classify it first**.

### A. Plugin‑folder territory — you CAN fix this yourself (edit a manifest, no recompile)
Symptoms / examples:
- "the active plugin `X` does not support streaming chat" / a capability is missing.
- "command not found for task Z" or the CLI is called with the wrong subcommand/flags.
- Auth flags wrong, wrong result‑extraction path, wrong model flag.
- You want to register a different CLI, or switch the active one.

→ Fix in `~/Library/Application Support/com.interviewlab.app/plugins/<id>/manifest.json`, then **Rescan**.
No source code, no rebuild.

### B. Source‑code territory — do NOT hack around it; **STOP and report** (general terms)
These require editing the Rust/TS source and a rebuild — they are for the maintainer, not the plugins folder:
- **Build / compile failures** — the `metal` Cargo feature, `cfg` gating for `aarch64-apple-darwin`, dylib
  linking, anything that stops `cargo`/`tauri` from compiling. (Source: `src-tauri/Cargo.toml`, `src-tauri/src/*`.)
- **GPU / device detection** — wrong device reported, Metal not selected, a CPU/Metal branch issue.
  (Source: `src-tauri/src/asr.rs`.)
- **Live progress / checkpoint / resume / chunk re‑transcribe** — the live transcript stream never updates,
  the "Diarizing…" phase never shows, the **resume** banner never appears after a kill, or a chunk
  **re‑transcribe** mis‑splices timing. (Source: `src-tauri/src/asr.rs` — commands `transcribe_interview`,
  `resume_transcription`, `retranscribe_range`, `get_transcribe_checkpoint`; the `transcribe_checkpoint`
  table in `migrations/0007_*`; and the live‑progress UI under `src/` — `live-asr-store.ts`,
  `use-live-asr.ts`, `live-transcript-view.tsx`, `pages/transcript-editor.tsx`.)
- **Native library loading at runtime** — sherpa‑onnx / onnxruntime **dylib not found** when transcribing or
  diarizing, especially in a packaged `.app` (dev mode loads them from the build dir; bundling them into the
  `.app` is a known TODO). (Source: `src-tauri/tauri.conf.json` + `src-tauri`.)
- **Audio decode** — ffmpeg not found / wrong invocation / produces no usable wav. (Source: `src-tauri/src`.)
- **Anything in the UI or pipeline logic** — transcript editor, speaker/turn merging, cleanup/synthesis/diff/
  chat behavior, DB migrations. (Source: `src/**` and `src-tauri/src/**`.)

**How to report a source‑side error** (keep it general but specific enough to act on):
1. **Which step** failed: build / launch / model download / transcribe / diarize / cleanup / roles /
   synthesis / diff / chat.
2. **Platform symptom** in plain words — e.g. "Metal context init failed → fell back to CPU",
   "onnxruntime dylib not found at runtime", "nvml symbol referenced on macOS", "cargo can't find the metal
   feature", "ffmpeg: command not found".
3. **Suspected file / subsystem** (from the list above).
4. **The exact error text** (paste it).
Then stop on that item — do **not** invent a plugins‑folder workaround for a source bug.

### Build picks up Windows paths (cmake-not-found, bindgen MSVC target)?
If `cargo`/`cmake` errors point at a `C:\…` path (e.g. a Windows `cmake.exe`, or bindgen targeting
`x86_64-pc-windows-msvc`), you have a stale **`interviewlab/src-tauri/.cargo/config.toml`** — it used to be
committed with Windows-only `[env]` (LIBCLANG_PATH / BINDGEN_EXTRA_CLANG_ARGS / CMAKE), and cargo `[env]` has
no per-OS conditioning so it leaks onto macOS. It's now **gitignored**; `git pull` removes it. If it lingers
(local edits), just **delete it**: `rm interviewlab/src-tauri/.cargo/config.toml`. macOS needs **no** cargo
env file — system clang + brew/Xcode cmake are found automatically. (The committed `config.toml.example` is a
Windows-only template; ignore it on macOS.) This is config, not a source bug — you can fix it yourself.

### Known macOS source‑side risks (expect these)
- The **Metal** path is implemented but **never run on real hardware** — Metal init / performance is unverified.
- **Dylib bundling for a packaged `.app`** is a known TODO; **dev mode (`tauri dev`) is the supported path**
  for now (it loads the native libs from the build output). A packaged `.dmg` may fail to find the dylibs.
- **CoreML / Apple Neural Engine** for whisper is wired as the opt-in `coreml` feature (§3.1); its
  `.mlmodelc` artifact is **auto-fetched** at model-download time. If the fetch fails (network/HF), it falls
  back to the Metal encoder — that's a graceful degrade, not a blocker; only report it if the ANE never
  engages despite the bundle being present.
- **CoreML execution provider for diarization** (macOS) is best-effort; if sherpa session-create fails on it,
  diarization degrades to single-speaker (transcription still succeeds). A persistent diarization failure that
  traces to the `provider = "coreml"` setting is a **source** issue (flip to `"cpu"` in `diarize.rs`) — report it.
- `nvml` (NVIDIA‑only) is `cfg`‑gated off macOS; if you ever see an nvml symbol/link error on macOS, that's a
  **source** gating bug — report it.

See `docs/mac-build.md` for the engineering detail behind all of the above.

---

## 7. Quick reference

```bash
# run (fastest: Metal GPU + ANE encoder; .mlmodelc auto-fetched on model download)
cd interviewlab && npm run tauri dev -- --features metal,coreml
# run (Metal GPU only, no ANE)
cd interviewlab && npm run tauri dev -- --features metal
# run (CPU fallback)
cd interviewlab && npm run tauri dev

# local AI CLI — YOUR environment's CLI (NOT Claude). Confirm it's installed + on PATH:
<your-cli> --version
# then: Settings → AI CLI → Rescan → select your plugin as active → Test CLI

# app data (models, plugins, db) on macOS
~/Library/Application\ Support/com.interviewlab.app/
#   ├── plugins/<id>/manifest.json   ← register/fix YOUR CLI here (no source change)
#   ├── models/                      ← downloaded whisper + diarization models
#   └── *.db                         ← local SQLite
```

**Hand back to the human once:** the app launches, **your** CLI is active and Settings → AI CLI → Test CLI
shows **Available**, and an ASR model is downloaded. They will upload the real interview and run the pipeline.
Report any **source‑side** failures per §6B.
