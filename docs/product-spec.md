# InterviewLab — Product & Technical Specification (MVP)

> Desktop app for working with user-research interviews: ingest recordings, transcribe **locally**,
> clean transcripts to grammar-free readable text, assign speaker roles, and synthesize
> findings across a research cycle — with a **findings-level diff vs the previous cycle**.
>
> **Form factor:** Tauri 2 desktop app (Rust backend, React + shadcn/ui frontend).
> **AI:** runs through a locally-installed CLI (MVP: Claude Code) behind a pluggable adapter layer.
> **ASR:** local-only, Whisper-family, CUDA on Nvidia + CPU fallback.
>
> Status: design doc for AI dev agents. Date: 2026-06-22.

---

## 1. Product summary & MVP scope

### Vision
A researcher already has the hard assets: product descriptions, an interview guide (goals + the
conclusions they want to test), and a folder of interview recordings. **InterviewLab** turns that pile
into structured, editable, role-tagged transcripts and then into a defensible **synthesis** tied to the
guide's goals — and shows **what changed** since the last research wave. Everything runs on the user's
machine: transcription via a local Whisper engine, the "thinking" steps (cleanup, synthesis, diff) via a
local AI CLI the user already has installed. No data leaves the machine except whatever the user's own CLI
sends to its provider.

### In scope (MVP)
- **Cycles (waves):** group interviews into a research cycle; manage them in one place.
- **Batch file ingest:** drag-and-drop ready-made audio/video files into a cycle.
- **Local ASR:** Whisper transcription on Nvidia CUDA GPU, with CPU fallback.
- **Transcript cleanup:** ASR raw → LLM-via-CLI pass producing a clean, grammar-correct, readable transcript.
- **Transcript editor:** segment list, inline edit, **manual** speaker/role assignment.
- **Participants & roles:** define participants per interview (interviewer / respondent / others).
- **Synthesis:** cycle-level insights/conclusions mapped to guide goals.
- **Diff vs previous cycle:** *findings-level* comparison (what changed in conclusions), not a text diff.
- **CLI-adapter layer + plugin-instruction spec:** so any local CLI can be onboarded later.

### Out of scope (MVP — explicitly deferred)
- In-app audio/video **recording** (ingest pre-made files only).
- **Automatic diarization** (speaker separation) — roles are assigned manually; clean extension point left.
- **macOS / Apple Silicon** ASR path (designed-for, not shipped; see §6.6).
- **Cloud ASR** (no remote transcription service, ever — local-only is a hard constraint).
- **Multi-user / collaboration / sync** — single-user, single-machine, local SQLite.
- **AMD/Intel GPU, ROCm, Vulkan, DirectML** — the target machine is AMD CPU **+ Nvidia GPU**; the only
  GPU compute path is CUDA, and the only fallback is CPU. No cross-vendor GPU work.
- Translation, sentiment scoring, auto-tagging, dashboards, export to BI tools — not MVP.

---

## 2. Core concepts / domain model

### 2.1 Entities

| Entity | Meaning |
|---|---|
| **Cycle** (wave / волна) | A research wave. Holds the product context, the interview guide (goals + target conclusions), a set of interviews, and one synthesis. Has an optional pointer to a *previous* cycle for diffing. |
| **Interview** | One session inside a cycle. Owns a recording, participants, and a transcript. |
| **Participant** | A person in an interview, with a **role** (`interviewer`, `respondent`, `observer`, `other`). Roles are assigned manually in the editor and mapped onto transcript speaker labels. |
| **Recording** | The source media file (audio or video) on disk, plus extracted/normalized audio for ASR. |
| **Transcript** | Belongs to an interview. Has **versioned** content: a `raw` version (ASR output) and one or more `cleaned` versions (after LLM cleanup and/or manual edits). A transcript is a list of **segments**. |
| **Segment** | `{ start_ms, end_ms, speaker_label, text }`. The atomic unit shown in the editor. |
| **Synthesis** | Cycle-level output: a set of findings, each tied to a guide goal, with supporting evidence (interview + segment references). |
| **Diff** | Cycle-vs-previous-cycle comparison at the **findings** level: new / dropped / changed / unchanged findings per goal. |

### 2.2 Data model (SQLite)

Single local SQLite file at the app data dir (see §2.3). Access via `sqlx` (Rust, compile-time-checked
queries) with plain migrations. JSON blobs (segments, findings) stored as `TEXT` columns containing JSON —
no ORM, no extra tables for things that are always read/written whole.

```sql
-- migrations/0001_init.sql

CREATE TABLE cycle (
  id            TEXT PRIMARY KEY,          -- uuid
  name          TEXT NOT NULL,
  product_desc  TEXT NOT NULL DEFAULT '',  -- detailed product description (markdown)
  guide         TEXT NOT NULL DEFAULT '',  -- interview guide: goals + target conclusions (markdown)
  prev_cycle_id TEXT REFERENCES cycle(id), -- nullable; for diff
  created_at    INTEGER NOT NULL,          -- unix ms
  updated_at    INTEGER NOT NULL
);

CREATE TABLE interview (
  id          TEXT PRIMARY KEY,
  cycle_id    TEXT NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,               -- 'new'|'transcribing'|'transcribed'|'cleaning'|'cleaned'|'edited'|'error'
  notes       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE participant (
  id           TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL,              -- 'interviewer'|'respondent'|'observer'|'other'
  -- speaker_label links a participant to ASR speaker tags ("SPEAKER_0", or manual "S1").
  speaker_label TEXT                       -- nullable until assigned in editor
);

CREATE TABLE recording (
  id            TEXT PRIMARY KEY,
  interview_id  TEXT NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
  source_path   TEXT NOT NULL,             -- original file copied into the cycle media dir
  audio_path    TEXT,                      -- normalized 16kHz mono wav for ASR (nullable until prepared)
  duration_ms   INTEGER,
  format        TEXT,                      -- 'mp3'|'wav'|'mp4'|'m4a'|...
  bytes         INTEGER
);

CREATE TABLE transcript (
  id            TEXT PRIMARY KEY,
  interview_id  TEXT NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,          -- 1..N
  kind          TEXT NOT NULL,             -- 'raw' | 'cleaned' | 'edited'
  language      TEXT,                      -- detected/forced, e.g. 'ru'
  engine        TEXT,                      -- e.g. 'whisper.cpp:large-v3@cuda'
  segments_json TEXT NOT NULL,             -- JSON: [{start_ms,end_ms,speaker_label,text}, ...]
  created_at    INTEGER NOT NULL,
  UNIQUE(interview_id, version)
);

CREATE TABLE synthesis (
  id          TEXT PRIMARY KEY,
  cycle_id    TEXT NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  findings_json TEXT NOT NULL,             -- JSON (see §8.2 schema)
  model_meta  TEXT,                        -- which CLI/adapter + cost/session metadata
  created_at  INTEGER NOT NULL
);

CREATE TABLE diff (
  id            TEXT PRIMARY KEY,
  cycle_id      TEXT NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,  -- the "current" cycle
  prev_cycle_id TEXT NOT NULL REFERENCES cycle(id),
  diff_json     TEXT NOT NULL,             -- JSON (see §8.3 schema)
  created_at    INTEGER NOT NULL
);

-- App-level key/value: which adapter is active, model default, GPU availability cache, etc.
CREATE TABLE app_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Why JSON columns for segments/findings/diff:** they are always loaded and saved as a whole unit, edited
in the UI as a single document, and never queried by inner field. A separate `segment` table would buy
nothing but joins. (Lazy-senior-dev call: store the blob.)

### 2.3 Where files live on disk

Use Tauri's resolved **app-data dir** (`$APPDATA/InterviewLab` on Windows). Layout:

```
%APPDATA%/InterviewLab/
  interviewlab.db                     # SQLite
  models/                             # ASR model weights cache (see §6.4)
    ggml-large-v3.bin
  cycles/
    <cycle_id>/
      media/
        <recording_id>.<ext>          # copied source file
        <recording_id>.16k.wav        # normalized audio for ASR
      exports/                        # optional md/json exports
  adapters/                           # CLI adapter descriptors (see §7)
    claude-code.json
  logs/
```

Model weights live **outside** the cycle dir (shared across cycles). Media is copied into the cycle so a
cycle is a self-contained, movable folder.

---

## 3. End-to-end user flows

### 3.1 Create a cycle
1. User clicks **New Cycle** → Dialog asks for name.
2. On the cycle page, user pastes **Product description** and **Interview guide** (goals + target
   conclusions) into two Textareas (markdown). Optionally selects a **previous cycle** for later diffing.
3. Saved to `cycle`.

### 3.2 Ingest recordings (batch)
1. User drags a set of audio/video files onto the cycle's **Interviews** tab (or uses a file picker).
2. For each file the app: creates an `interview` (`status=new`), copies the file into `cycles/<id>/media/`,
   creates a `recording`, and queues **audio normalization** (ffmpeg sidecar → 16 kHz mono wav).
3. A DataTable lists interviews with status badges.

### 3.3 Transcribe (local ASR)
1. User selects one/many interviews → **Transcribe**.
2. Rust spawns the **ASR sidecar** per interview (queued, configurable concurrency = 1 by default to keep
   VRAM sane). Status → `transcribing`; a Progress bar streams percent.
3. Sidecar returns segments → stored as `transcript` v1, `kind=raw`. Status → `transcribed`.

### 3.4 Clean transcript ("no grammar errors")
1. User clicks **Clean** (single) or **Clean all**.
2. Rust calls the active **CLI adapter** with the `transcript-cleanup` task (raw segments + language).
3. CLI returns cleaned segments (same count/timing, fixed text). Stored as new `transcript` version,
   `kind=cleaned`. Status → `cleaned`.

### 3.5 Edit + assign roles
1. User opens an interview → **Transcript editor** (Resizable split: media/info | segments).
2. User defines **participants** (name + role) and maps each transcript **speaker label** to a participant
   (manual diarization). A Command palette / Select picks the role per speaker.
3. User inline-edits segment text. Saving creates/updates an `edited` transcript version.

### 3.6 Synthesize the cycle
1. On the cycle page, user clicks **Synthesize**.
2. Rust gathers: product desc, guide (goals + target conclusions), and the best transcript per interview
   (latest `cleaned`/`edited`), role-labeled. Calls the adapter's `cycle-synthesis` task.
3. CLI returns findings (each tied to a goal, with evidence refs). Stored in `synthesis`. Rendered as Cards
   grouped by goal.

### 3.7 Diff vs previous cycle
1. If the cycle has `prev_cycle_id` and both have a synthesis, user clicks **Diff vs previous**.
2. Rust sends *both syntheses* (current + previous) + the shared goals to the adapter's `cycle-diff` task.
3. CLI returns a findings-level diff (new / dropped / changed / unchanged per goal, with rationale). Stored
   in `diff`. Rendered with Badges (New / Changed / Dropped / Same).

Each long step shows a Sonner toast on completion and updates status badges. Failures set `status=error`
and surface the CLI's stderr in a Sheet.

---

## 4. UI / screens mapped to shadcn components

All UI is built **exclusively** from shadcn/ui. State: **Zustand** (tiny, no boilerplate) + **TanStack
Query** for invoking/caching Tauri commands. Routing: React Router (3–4 routes). Icons: `lucide-react`
(ships with shadcn).

### 4.1 App shell
- **Sidebar** (`sidebar`): cycle list + nav (Cycles, Settings). Collapsible.
- **Breadcrumb** for Cycle → Interview navigation.
- **Sonner** (`sonner`) mounted at root for all async toasts.
- **Dialog** for "New Cycle".

### 4.2 Cycle page
- **Tabs** (`tabs`): **Overview** | **Interviews** | **Synthesis** | **Diff**.
- *Overview tab:* two **Textarea** (`textarea`) blocks (Product description, Interview guide) in **Card**s;
  a **Select** (`select`) to pick the previous cycle; **Button** Save.
- *Interviews tab:* a **Table** (`table`, used as a DataTable via TanStack Table) — columns: title, duration,
  **Badge** status, actions. Top bar: drag-drop zone (**Card** with dashed border) + **Button**s
  (Transcribe, Clean all). **Progress** (`progress`) per row during ASR. **DropdownMenu** for row actions
  (Open, Re-transcribe, Delete via **AlertDialog**).
- *Synthesis tab:* **Button** Synthesize; results as **Accordion**/**Card** grouped by goal; **Skeleton**
  while running.
- *Diff tab:* requires a previous cycle + both syntheses; **Card** per goal listing findings with **Badge**
  (New / Changed / Dropped / Same) and **HoverCard**/**Tooltip** for rationale.

### 4.3 Transcript editor (the core screen)
- **Resizable** (`resizable`) two-pane layout:
  - **Left pane:** **Card** with interview metadata; a **media element** (`<video>`/`<audio>`) for playback;
    **Participants** block — a small **Table** of participants (name + **Select** role) and **Button** "Add
    participant"; a **speaker → participant** mapping list (one **Select** per detected speaker label).
  - **Right pane:** the **segment list**. Each segment is a row:
    - a **Badge** showing the speaker label / role (click to reassign via **Popover** + **Command**),
    - a timestamp (mm:ss, click to seek media),
    - an inline-editable **Textarea** (auto-grow) for the text.
  - **Toolbar** above the list: version **Select** (raw / cleaned / edited), **Button**s (Clean, Save,
    Re-clean), a **Tabs** toggle (Edit | Read) for a reader view.
- **Command** (`command`, ⌘K) palette for: assign role to current speaker, jump to next unassigned speaker,
  save, run cleanup.
- **Sheet** (`sheet`) for showing raw CLI stdout/stderr on error and for a "diff between transcript versions"
  side view.

### 4.4 Settings
- **Tabs**: **AI CLI** | **Transcription** | **About**.
- *AI CLI tab:* list of installed **adapters** (Cards), an "active adapter" **RadioGroup**/**Select**, a
  **Button** "Test CLI" (runs a trivial probe and shows result in a **Badge**: Available / Not found /
  Auth error). A **Button** "Add adapter…" opens a Dialog explaining the plugin-instruction spec (§7).
- *Transcription tab:* GPU status **Badge** (CUDA detected vs CPU fallback), model **Select**
  (large-v3 default / large-v3-turbo / medium), a **Button** "Download model" with **Progress**, language
  **Select** (auto / ru / en…).

### 4.5 Editor UX details
- Speaker tagging: ASR returns generic labels (`S1`, `S2`…); the editor lets the user (a) rename them and
  (b) bind each to a participant+role. The binding is stored in `participant.speaker_label`; rendering joins
  segments→participant for colored role Badges. Unassigned speakers get a warning Badge.
- Inline edit autosaves into a working buffer; explicit **Save** commits a new `edited` transcript version.
- Timing is **never** changed by the user or by cleanup — only `text` and `speaker_label` are editable, so
  media sync stays correct.

---

## 5. Architecture

### 5.1 Pieces
- **Frontend:** React + Vite + TypeScript + Tailwind + **shadcn/ui**. State: Zustand + TanStack Query.
- **Backend:** Rust (Tauri 2). Exposes `#[tauri::command]` functions; owns SQLite (`sqlx`), file I/O,
  in-process ASR (`whisper-rs`), and process spawning (ffmpeg + CLI adapter). Concurrency via `tokio`.
- **ASR engine:** whisper.cpp linked **in-process** via `whisper-rs` (no sidecar binary); runs on a `tokio`
  blocking task and streams progress via Tauri events. See §6.
- **ffmpeg sidecar:** the one external binary — the `ffmpeg-sidecar` crate auto-downloads an LGPL build for
  audio normalization + media probing.
- **CLI adapter layer:** Rust module that reads an **adapter descriptor** (JSON) and shells out to a local
  CLI (MVP: Claude Code) for the three AI tasks. See §7.

### 5.2 Data/command flow (text diagram)

```
 React (shadcn UI)
   │   invoke('transcribe_interview', {id})         invoke('run_task', {task:'cycle-synthesis', cycle_id})
   ▼                                                ▼
 ┌──────────────────────────── Tauri Rust core ───────────────────────────────┐
 │  commands.rs ──► db (sqlx/SQLite)                                           │
 │       │                                                                     │
 │       ├─ asr::transcribe(audio_path)                                        │
 │       │     └─ whisper-rs::transcribe(x.wav, large-v3) [in-process]         │
 │       │            ◄── stdout: {"type":"progress",...}/{"type":"result",..} │
 │       │                                                                     │
 │       └─ adapter::run(task, payload)                                        │
 │             ├─ load adapters/claude-code.json (descriptor)                  │
 │             ├─ render prompt from task contract (§7.3)                      │
 │             └─ spawn: claude -p <prompt> --output-format json (isolated)   │
 │                    stdin ◄── { payload JSON }                               │
 │                    stdout ──► { "result": "...json..." }  → parse → DB      │
 └─────────────────────────────────────────────────────────────────────────────┘
        │                                  │
   ffmpeg sidecar                   local CLI (Claude Code)
   (normalize audio)                (cleanup / synthesis / diff)
```

### 5.3 Library choices (minimal set)
| Concern | Choice | Why |
|---|---|---|
| Desktop shell | Tauri 2 | hard constraint; small binaries, Rust core |
| DB access | `sqlx` + SQLite | compile-time-checked SQL, no ORM weight |
| Async/process | `tokio`, Tauri sidecar API | spawn + stream ASR/CLI |
| IDs/time | `uuid`, `time` | stdlib-ish |
| Frontend state | Zustand + TanStack Query | smallest viable; Query handles invoke caching |
| UI | shadcn/ui + Tailwind + lucide | hard constraint |
| Tables | TanStack Table behind shadcn Table | the standard shadcn DataTable pattern |
| ASR | whisper.cpp via whisper-rs (in-process) | see §6 |
| Media | ffmpeg (sidecar) | normalize/probe |

No Redux, no GraphQL, no microservices, no message bus. Everything is a Tauri command or a sidecar process.

---

## 6. Local transcription subsystem

### 6.1 Engine choice: **whisper.cpp via `whisper-rs`** — in-process, no Python

**Decision: ship whisper.cpp through the `whisper-rs` Rust bindings, linked into the Tauri core.** This drops
the entire Python runtime from the bundle and runs ASR **in-process** (a `tokio` blocking task) — no separate
ASR binary to freeze/spawn. It is exactly the stack the maintained **Vibe** app (MIT, Tauri + whisper.cpp,
Windows/Nvidia) ships, so GPU/model/packaging UX is copy-able rather than invented. Rationale vs alternatives:

- **whisper.cpp / `whisper-rs`** (whisper.cpp = MIT, whisper-rs = Unlicense) — ggml inference engine,
  CPU-native by default with a **CUDA (cuBLAS) backend** for Nvidia. Same Whisper models/accuracy. One library
  covers **GPU + CPU fallback** and, rebuilt with the `metal` feature, the **future Mac path** — so §6.6 is a
  build flag, not a second engine. Statically links into our binary.
  ([whisper.cpp](https://github.com/ggml-org/whisper.cpp),
  [whisper-rs](https://github.com/tazz4843/whisper-rs), [Vibe](https://github.com/thewh1teagle/vibe))
- **faster-whisper / CTranslate2** — marginally faster batch throughput and a clean `device="cuda"→"cpu"`
  switch, but it's **Python**: shipping it means freezing a whole Python+CUDA runtime (PyInstaller — large,
  brittle) or the small (~57★) `ct2rs` binding. Rejected for MVP to avoid the Python bundle; **`ct2rs` stays
  the documented upgrade path** if measured throughput/accuracy ever demands CTranslate2.
  ([SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper))
- **WhisperX** — adds forced alignment + **pyannote diarization**; diarization is **out of scope** for MVP;
  the natural upgrade when we add auto-diarization later.
  ([m-bain/whisperX](https://github.com/m-bain/whisperX))

### 6.2 Runtime requirements (Windows + Nvidia)
- **GPU path:** whisper.cpp built with the **CUDA backend** (cuBLAS). The required NVIDIA runtime DLLs
  (cuBLAS/cuBLASLt + CUDA runtime) are **bundled alongside the app** so the user needs **no system CUDA
  Toolkit** — exactly how Vibe / Whisper4Windows ship it (DLLs taken from NVIDIA redistributables / pip wheels).
  ([Vibe](https://github.com/thewh1teagle/vibe), [Whisper4Windows](https://github.com/aarnphm/whisper4windows))
- **CPU fallback:** ggml runs on CPU natively. If GPU init fails (no Nvidia GPU / driver / missing DLL) we load
  the context with `use_gpu = false`. Slower (multiple× realtime for large-v3) but always works — the
  no-usable-GPU case.
- **VRAM:** ggml large-v3 ≈ **3–4 GB** VRAM; large-v3-turbo less; quantized (`q5`/`q8`) variants lower still.
  An 8 GB+ Nvidia card runs the default comfortably at concurrency 1.
  ([Spheron VRAM page](https://www.spheron.network/tools/gpu-recommender/openai/whisper-large-v3/))

### 6.3 GPU detection + fallback logic
The core probes the GPU once (cached after) and degrades gracefully:
```
detect Nvidia GPU (nvml-wrapper) + CUDA-capable whisper.cpp build?
  yes → init whisper context with use_gpu = true
  no / init error → init with use_gpu = false (CPU)
report chosen device → cached in app_setting → Settings Badge ("CUDA" / "CPU fallback")
```
Rust caches the detected capability in `app_setting` and shows it in the Transcription settings tab.

### 6.4 Model strategy (Russian-first) — ggml format
Interviews are likely **Russian**, which rules out the obvious "fast" pick. Models are **ggml** `.bin` files
(from `ggerganov/whisper.cpp` on Hugging Face), not CTranslate2 directories:

- **Default: `ggml-large-v3` (multilingual).** Best accuracy for Russian; ~3 GB on disk, ~3–4 GB VRAM. Russian
  is among Whisper's better-supported languages.
  ([whisper.cpp models](https://huggingface.co/ggerganov/whisper.cpp),
  [antony66/whisper-large-v3-russian](https://huggingface.co/antony66/whisper-large-v3-russian))
- **Faster option: `ggml-large-v3-turbo`.** Pruned decoder, much faster, *minor* multilingual quality loss;
  multilingual retained — a good speed/quality knob when the GPU is small.
  ([openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo),
  [gigagpu turbo trade-off](https://gigagpu.com/whisper-large-v3-turbo-speed-accuracy/))
- **Do NOT default to distil-whisper:** the official distil checkpoints are **English-only** — useful only for
  English-language cycles, never the Russian default.
  ([huggingface/distil-whisper](https://github.com/huggingface/distil-whisper))
- **Lighter fallback (low VRAM / CPU):** `ggml-medium` multilingual, or a quantized `ggml-large-v3-q5_0` to cut
  VRAM. Exposed in Settings; not default.

**Packaging:** do **not** bundle weights in the installer (keeps it small). On first transcription (or via
Settings "Download model"), download the ggml model into `%APPDATA%/InterviewLab/models/` (mine Vibe's
resumable download + progress UX). large-v3 ≈ 3 GB.
([whisper.cpp models on HF](https://huggingface.co/ggerganov/whisper.cpp))

### 6.5 Packaging (Tauri)
- **ASR is in-process** via `whisper-rs` linked into the Rust core — **no ASR sidecar binary**. Long
  transcriptions run on a `tokio` blocking task and stream progress to the UI via Tauri events; cancel = drop
  the task / stop the whisper state-callback.
- Build whisper.cpp with the CUDA backend; **bundle the NVIDIA runtime DLLs** beside the executable (Tauri
  `bundle.resources`). Copy the exact DLL set + MSI recipe from **Whisper4Windows / Vibe**.
  ([Tauri resources](https://v2.tauri.app/develop/resources/),
  [Whisper4Windows](https://github.com/aarnphm/whisper4windows))
- **ffmpeg** stays a **sidecar** via the `ffmpeg-sidecar` crate (auto-downloads an LGPL build, invokes it as a
  subprocess) for `media → 16 kHz mono wav` + duration probe — this also keeps ffmpeg's LGPL process-separated.
  ([ffmpeg-sidecar](https://github.com/nathanbabcock/ffmpeg-sidecar))

### 6.6 Future Mac (M3 Pro) path — same engine, `metal` feature
Because we already use whisper.cpp, the Mac path is just **rebuilding `whisper-rs` with the `metal` feature** —
same library, same ggml models, same segment shape behind the `Asr` trait. No second engine, no UI/DB change.
This is **future, not MVP** — designed-for, not built. ([whisper.cpp](https://github.com/ggml-org/whisper.cpp))

### 6.7 The "no grammar errors" pipeline
Whisper output is verbatim and disfluent (filler words, run-ons, wrong punctuation). "Clean, readable, no
grammar errors" is achieved by a **second pass through the AI CLI**, not by ASR:

```
recording ─ffmpeg→ 16kHz wav ─whisper.cpp→ raw segments (verbatim)
          ─CLI 'transcript-cleanup'→ cleaned segments (grammar-corrected, punctuated, readable)
```
The cleanup pass **must preserve segment count and timestamps** and **only rewrite `text`** (it may fix
grammar/punctuation/casing and remove pure filler, but must not paraphrase meaning, merge/split segments, or
touch timing). The exact prompt contract is in §7.3.1.

---

## 7. CLI-adapter + plugin-instruction spec

> **Superseded/extended by `feature-cli-plugins.md`.** This section (the M6 batch-adapter descriptor +
> §7.4 agent-facing meta-instruction + the three task contracts) remains accurate for **batch tasks**
> and is the foundation the plugin layer builds on. The **authoritative, generalized design** — a
> single pluggable layer covering BOTH batch and the agentic chat, the capability-declaring
> **manifest** (a superset of §7.1), the **two integration tiers** (descriptor-only + adapter-program),
> the portable **MCP tool layer**, graceful degradation, and the expanded agent-facing onboarding doc —
> lives in **`feature-cli-plugins.md`**, which wins where they differ. §7.3 task contracts are
> unchanged and referenced verbatim by the new doc.

Three things ship: **(a)** an adapter descriptor schema, **(b)** an agent-facing meta-instruction document to
author a new adapter, **(c)** the three task contracts the app requires from any CLI.

### 7.1 Adapter descriptor schema (the file)

An adapter is a JSON file in `%APPDATA%/InterviewLab/adapters/<id>.json`. It tells Rust how to invoke a local
CLI for each task. The app renders the prompt, writes the **payload JSON to stdin**, runs the command, then
extracts the task's result JSON from stdout.

```jsonc
// adapter descriptor schema (conceptual)
{
  "id": "claude-code",                 // unique slug
  "name": "Claude Code",
  "version": "1.0",
  "command": "claude",                 // executable on PATH (or absolute path)
  "probe": {                           // "Test CLI" in Settings
    "args": ["--version"],
    "expect_exit_code": 0
  },
  "auth": {                            // informational; how the CLI gets credentials
    "type": "session",                 // CLI keeps its own login; no env var
    "env": [],
    "note": "Uses the user's `claude login` session (Pro/Max subscription, or ANTHROPIC_API_KEY if set). Plain -p reads keychain/OAuth. Do NOT pass --bare (it ignores OAuth and forces ANTHROPIC_API_KEY)."
  },
  "io": {
    "payload_via": "stdin",            // 'stdin' | 'arg' | 'file'
    "prompt_via": "arg",               // where the rendered prompt text goes
    "result_extract": {                // how to get the task JSON out of stdout
      "format": "json",                // 'json' | 'raw'
      "json_path": "result"            // field in the CLI's JSON envelope holding our payload string
    },
    "timeout_sec": 600,
    "max_stdin_bytes": 10000000        // mirror Claude Code's 10MB stdin cap
  },
  "tasks": {
    // isolation flags keep the user's global hooks/settings/MCP out of the call (no --bare → keeps subscription auth)
    "transcript-cleanup": { "args_template": ["-p","{prompt}","--output-format","json","--setting-sources","","--strict-mcp-config"] },
    "cycle-synthesis":     { "args_template": ["-p","{prompt}","--output-format","json","--setting-sources","","--strict-mcp-config"] },
    "cycle-diff":          { "args_template": ["-p","{prompt}","--output-format","json","--setting-sources","","--strict-mcp-config"] }
  }
}
```

Placeholders: `{prompt}` (rendered prompt incl. task instructions + the requested output JSON schema),
`{payload_file}` if `payload_via:"file"`. Rust pipes the task's **input JSON** (§7.3) on stdin, runs
`command + args`, reads stdout, and—when `result_extract.format=="json"`—JSON-parses stdout and pulls
`json_path` (e.g. Claude Code's top-level `result` string), then JSON-parses *that* into the task's output
schema. The instruction to "return ONLY JSON conforming to schema X" lives in the rendered prompt, so any
compliant CLI works.

### 7.2 Claude Code adapter — concrete & verified

Claude Code's headless ("print") mode is the basis for the MVP adapter
([Run Claude Code programmatically](https://code.claude.com/docs/en/headless)):

- **`-p` / `--print`** → one-shot: run the prompt, print result to stdout, exit.
- **Auth = the user's existing Claude Code login (subscription).** Plain `-p` reads the keychain/OAuth session
  from `claude login` (Pro/Max plan, or `ANTHROPIC_API_KEY` if set). **We deliberately do NOT use `--bare`** —
  bare mode ignores keychain/OAuth and *requires* `ANTHROPIC_API_KEY`, which would break subscription users.
- **Isolation without `--bare`:** lock the call with `--setting-sources ""` (load no user/project/local settings
  → the user's global hooks like ponytail, permissions, and auto-memory don't fire) and `--strict-mcp-config`
  (no MCP servers). Run with `cwd` = a neutral empty dir so no stray `CLAUDE.md` is auto-discovered. (Optional:
  `--disallowedTools "*"` — the three tasks are pure text-in/text-out and never call tools.)
- **stdin piping** → non-interactive mode reads stdin; we pipe the payload JSON in. **Cap: 10 MB** (exceeding
  it exits non-zero) — for very large cycles, write to a temp file and reference its path in the prompt.
- **`--output-format json`** → stdout is a single JSON envelope with the text answer in **`result`**, plus
  `session_id`, usage, and `total_cost_usd`. We parse `result`. (`--json-schema '<schema>'` makes Claude conform
  output to a schema and places it in `structured_output` — we use this to harden synthesis/diff parsing.
  `--model <alias>` optionally pins opus/sonnet per task; default = the CLI's configured model.)
- **Exit codes:** non-zero on error (e.g. stdin over cap, auth failure) — Rust treats non-zero as task failure
  and surfaces stderr in the editor Sheet.

**Concrete invocation Rust runs:**
```bash
# payload JSON on stdin; prompt carries instructions + required output schema.
# cwd = neutral temp dir; no env var needed (uses the `claude login` session).
printf '%s' "$PAYLOAD_JSON" | \
  claude -p "$RENDERED_PROMPT" --output-format json \
         --setting-sources "" --strict-mcp-config
# stdout -> parse -> .result -> parse -> task output JSON
```
Auth check: "Test CLI" runs `claude --version` (installed?) then a tiny `claude -p` round-trip (logged in?) and
reports Available / Not found / Not logged in. The user logs in once with `claude login`.

### 7.3 The three task contracts (CLI-agnostic I/O)

Every CLI must satisfy these contracts. Rust builds the input JSON, renders a prompt that embeds the input and
the **required output schema**, and validates the returned JSON.

#### 7.3.1 `transcript-cleanup`
**Goal:** verbatim ASR → clean, grammar-correct, readable — *without changing timing, count, or meaning.*

Input:
```json
{
  "task": "transcript-cleanup",
  "language": "ru",
  "guidelines": "Fix grammar, punctuation, capitalization. Remove pure filler (эм, ну вот) only when it adds nothing. Do NOT paraphrase, translate, merge, split, or reorder. Keep the speaker's meaning and terminology.",
  "segments": [
    { "id": 0, "start_ms": 0,    "end_ms": 4200, "speaker_label": "S1", "text": "ну вот эээ я обычно захожу и сразу значит смотрю заказы" }
  ]
}
```
Output (must echo `id`, `start_ms`, `end_ms`, `speaker_label`; rewrite only `text`):
```json
{
  "segments": [
    { "id": 0, "start_ms": 0, "end_ms": 4200, "speaker_label": "S1", "text": "Я обычно захожу и сразу смотрю заказы." }
  ]
}
```
Rust validates: same `id` set, unchanged timing/labels; on mismatch → reject and mark error.

#### 7.3.2 `cycle-synthesis`
Input:
```json
{
  "task": "cycle-synthesis",
  "cycle": { "name": "Onboarding wave 3", "product_desc": "…", "guide": "Goals: G1 …\nG2 …\nTarget conclusions: …" },
  "goals": [ { "id": "G1", "text": "Understand why users drop off at step 2" }, { "id": "G2", "text": "…" } ],
  "interviews": [
    { "id": "iv1", "title": "Respondent A",
      "transcript": [ { "id": 12, "speaker_role": "respondent", "text": "…" } ] }
  ]
}
```
Output:
```json
{
  "findings": [
    {
      "id": "F1",
      "goal_id": "G1",
      "statement": "Users drop at step 2 because the form asks for tax data they don't have on hand.",
      "confidence": "high",
      "support_count": 4,
      "evidence": [ { "interview_id": "iv1", "segment_id": 12 } ],
      "recommendation": "Defer tax fields to a later optional step."
    }
  ],
  "open_questions": [ "Did mobile users behave differently?" ]
}
```

#### 7.3.3 `cycle-diff`
Input = current synthesis findings + previous synthesis findings + the shared goals (see §8.3). Output:
```json
{
  "by_goal": [
    {
      "goal_id": "G1",
      "changes": [
        { "status": "new",       "finding_id": "F7", "statement": "…", "why": "Not present in previous cycle." },
        { "status": "changed",   "prev_finding_id": "pF3", "finding_id": "F2", "statement": "…", "why": "Confidence rose from low→high; root cause refined." },
        { "status": "dropped",   "prev_finding_id": "pF5", "statement": "…", "why": "No supporting evidence this cycle." },
        { "status": "unchanged", "prev_finding_id": "pF1", "finding_id": "F1", "statement": "…" }
      ]
    }
  ],
  "summary": "Net: 2 new findings on onboarding friction; the pricing objection from last wave disappeared."
}
```

### 7.4 Meta-instruction document (agent-facing) — "Onboard a new CLI adapter"

> **This standalone doc ships in-app (Settings → Add adapter…). It is written so any AI agent can author a new
> adapter unaided.**

**You are authoring an adapter descriptor so InterviewLab can drive a local AI CLI for three tasks:
`transcript-cleanup`, `cycle-synthesis`, `cycle-diff`. Produce a single JSON file conforming to §7.1.**

1. **Identify the CLI's non-interactive mode.** Find the flag(s) that make it (a) read a prompt, (b) run once,
   (c) print the answer to stdout, (d) exit. (For Claude Code: `-p`/`--print`.) Avoid anything that opens an
   interactive UI. Also find any flags that *isolate* the call from the user's global config (hooks, MCP,
   project files) without disabling auth (Claude Code: `--setting-sources "" --strict-mcp-config`).
2. **Find how it returns machine-readable output.** Prefer a JSON mode and note which field holds the model's
   text answer (Claude Code: `--output-format json`, field `result`). If only raw text is available, set
   `result_extract.format:"raw"` and ensure the prompt says "output ONLY the JSON, no prose/markdown fences".
3. **Find how it ingests large input.** Prefer stdin piping (note any size cap; Claude Code = 10 MB). If none,
   use `payload_via:"file"` and have the prompt reference the file path.
4. **Find how it authenticates** and what env vars it needs; record under `auth`. Prefer the CLI's own login
   session over env keys (Claude Code: `claude login`, no env var — and avoid `--bare`, which forces an API key).
   Note if a one-time interactive login is required (then the user logs in once outside the app).
5. **Fill `tasks.*.args_template`** for all three tasks (often identical). Use `{prompt}` where the rendered
   prompt goes and assume the payload arrives per `io.payload_via`.
6. **Write a `probe`** (a cheap command + expected exit code) so "Test CLI" can verify availability.
7. **Verify the contracts:** for each task, the CLI, when given the §7.3 input and a "return ONLY JSON matching
   this schema" instruction, must return valid JSON of the right shape. Test with one tiny fixture per task.
8. **Constraints to enforce in the descriptor/prompt:** cleanup must preserve segment ids/timing/labels and
   change only `text`; synthesis findings must carry `goal_id` + evidence; diff must be findings-level.
9. **Output:** the finished `<id>.json`. Drop it in `adapters/` and select it in Settings.

Hand this doc + §7.1 + §7.3 to an agent and it can produce a working adapter for an arbitrary local CLI.

---

## 8. Synthesis & diff design

### 8.1 How the guide drives synthesis
The cycle's **guide** is parsed into discrete **goals** (and optional target conclusions). The synthesis prompt
is constructed as: *product description (context) + the explicit goals + every interview's best transcript
(role-labeled segments).* The model is instructed to produce findings **each bound to a `goal_id`**, with
`confidence`, a `support_count`, and **evidence references** (`interview_id` + `segment_id`) so every finding is
traceable back to the transcript. Target conclusions from the guide are passed as hypotheses to confirm/refute.
This keeps the output anchored to what the researcher set out to learn rather than free-floating "insights".

### 8.2 Synthesis data flow
- **Consumes:** `cycle.product_desc`, parsed `goals`, and per interview the latest `cleaned`/`edited`
  transcript with segments rewritten to carry `speaker_role` (joined from `participant`). Role context matters —
  the model must weight *respondent* statements over *interviewer* prompts.
- **Produces:** `synthesis.findings_json` (schema in §7.3.2) + `model_meta` (adapter id, session id, cost).

### 8.3 Findings-level diff (not a text diff)
The diff is **not** a line/word diff of two documents — it compares **conclusions**. Mechanism:
- **Consumes:** the **current** cycle's `synthesis.findings_json`, the **previous** cycle's
  `synthesis.findings_json`, and the **shared goals** (matched by `goal_id`; goals are stable across waves when
  the guide is reused — if goal text changed, pass both texts so the model can align them).
- The `cycle-diff` task asks the model to align findings **by meaning within each goal** and classify each as
  `new` / `changed` / `dropped` / `unchanged`, with a `why`. "Changed" captures shifts in confidence, root
  cause, or recommendation even when the topic is the same.
- **Produces:** `diff.diff_json` (schema in §7.3.3), rendered per goal with status Badges + a one-line summary.

This gives the researcher "**what changed in our findings between waves**" — the actual business question —
instead of meaningless prose deltas.

---

## 9. MVP build plan / milestones

Ordered for AI-agent execution; each milestone ends with a concrete verification.

1. **Scaffold.** Tauri 2 + React + Vite + Tailwind + shadcn init; Sidebar shell; SQLite via `sqlx` + migration
   `0001_init`. *Verify:* app boots, creates DB, lists 0 cycles.
2. **Cycle CRUD.** New Cycle dialog; Overview tab (product/guide Textareas, prev-cycle Select, Save).
   *Verify:* create/edit/reload a cycle; rows persist.
3. **File ingest + media prep.** Drag-drop into Interviews tab; copy file → `media/`; ffmpeg sidecar →
   `16k.wav` + duration; DataTable with status Badges. *Verify:* dropping 3 files creates 3 interviews with
   `audio_path` set and correct durations.
4. **ASR engine.** `whisper-rs` (CUDA build) linked in-process; ggml model download UX (mine Vibe); GPU-then-CPU
   detection; Rust `asr::transcribe` on a blocking task with progress events; store `transcript` v1 raw.
   *Verify:* a real Russian clip transcribes on CUDA, and (forcing CPU) the fallback also produces segments;
   Settings shows the right device Badge.
5. **Transcript editor.** Resizable layout, media player, segment list, inline edit, participants + speaker→role
   mapping, version Select, Save → `edited` version. *Verify:* edit text + assign roles + reload shows persisted
   changes; timing untouched.
6. **CLI adapter layer.** Descriptor loader; Claude Code adapter (`-p --output-format json --setting-sources ""
   --strict-mcp-config`, stdin payload, parse `result`); Settings "Test CLI" probe. *Verify:* with the user
   logged in via `claude login`, the probe reports Available and a trivial round-trip returns parsed JSON;
   logged-out shows "Not logged in".
7. **Cleanup pass.** `transcript-cleanup` task end-to-end; validate id/timing/label invariants; store `cleaned`
   version. *Verify:* a noisy Russian transcript comes back grammar-clean with identical segment count/timing.
8. **Synthesis.** Gather role-labeled transcripts + goals; `cycle-synthesis`; render findings Cards by goal.
   *Verify:* findings reference real goals + evidence segments; persisted in `synthesis`.
9. **Diff.** Wire `prev_cycle_id`; `cycle-diff` over two syntheses; Diff tab with status Badges + summary.
   *Verify:* with two real cycles, diff lists new/changed/dropped/unchanged per goal sensibly.
10. **Hardening.** Error Sheets (CLI stderr), Sonner toasts, model download UI + `HF_HOME`, concurrency cap,
    installer packaging (sidecars + `-$TARGET_TRIPLE`). *Verify:* fresh-machine install transcribes, cleans,
    synthesizes, and diffs without a system CUDA toolkit present.

---

## 10. Risks & open questions (ranked)

With Nvidia-only MVP, GPU portability risk is **low**. The real risks:

1. **Russian ASR accuracy on real interview audio (HIGH).** Overlapping speech, accents, jargon, far-field mics
   degrade WER; large-v3 is good for Russian but not perfect, and turbo trades some quality.
   *Mitigation:* default to **large-v3** (not turbo, not distil/English); enable VAD; the **cleanup pass** fixes
   grammar/punctuation downstream; expose a fine-tuned Russian checkpoint (e.g. antony66/whisper-large-v3-russian)
   as a selectable model later; always let the user edit. Validate on a real Russian sample in milestone 4.
2. **CUDA DLL packaging size & correctness (HIGH).** Bundling the CUDA/cuBLAS runtime DLLs + a 3 GB model makes
   a large install, and a wrong/mismatched DLL set breaks the GPU path. *Mitigation:* pin the CUDA version and
   copy the exact DLL set from a known-good build (Vibe / Whisper4Windows); ship weights as a **first-run
   download** (small installer); the `use_gpu = false` CPU path guarantees function if GPU init fails.
   ([Whisper4Windows DLL recipe](https://github.com/aarnphm/whisper4windows))
3. **CLI availability & auth (HIGH).** The whole AI half assumes Claude Code is installed and the user is logged
   in via `claude login` (subscription/OAuth). If not installed or the session is expired, cleanup/synthesis/diff
   all fail. *Mitigation:* Settings "Test CLI" probe with clear states (Not found / Not logged in / Available);
   block AI actions with an explanatory toast linking the `claude login` step; the adapter layer lets users
   point at any already-authenticated CLI. Note: subscription headless usage is subject to the plan's usage
   limits — a long cycle may hit them mid-run, so surface partial progress and allow resume.
   ([headless docs](https://code.claude.com/docs/en/headless))
4. **CLI output not valid JSON (MEDIUM).** LLM CLIs can wrap JSON in prose/markdown fences.
   *Mitigation:* prompt "return ONLY JSON"; prefer Claude Code `--json-schema` for schema-conformant
   `structured_output`; Rust does tolerant extraction + schema validation + one retry before erroring.
5. **stdin 10 MB cap on large cycles (MEDIUM).** Many long transcripts can exceed Claude Code's 10 MB stdin cap.
   *Mitigation:* adapter `max_stdin_bytes`; when exceeded, switch to `payload_via:"file"` (temp file + path in
   prompt); consider per-interview cleanup (already chunked) and map-reduce synthesis if a cycle is huge.
6. **CPU fallback too slow (MEDIUM).** large-v3 on CPU can be many× realtime.
   *Mitigation:* on CPU auto-suggest `large-v3-turbo`/`medium`; set expectations in the UI; keep concurrency 1.
7. **Manual diarization friction (LOW–MEDIUM).** Without auto-diarization, the user maps speakers by hand.
   *Mitigation:* good editor UX (per-speaker role Select, "jump to next unassigned"); WhisperX/pyannote is the
   clean future drop-in behind the same `Asr` trait + segment schema.
8. **Versioned-transcript UX complexity (LOW).** raw/cleaned/edited versions can confuse.
   *Mitigation:* always operate on "latest best", expose a simple version Select, keep timing immutable.

### Open questions
- Is the guide always parseable into discrete goals, or do we need a "define goals" UI step before synthesis?
- Do users want **per-interview** mini-summaries in addition to the cycle synthesis? (Out of MVP unless asked.)
- Should goals carry stable IDs across cycles (recommended) — i.e. do we let a new cycle *inherit* the previous
  cycle's guide/goals to make diffs clean?
- **Resolved:** auth uses the user's **subscription login** (`claude login`) via non-bare `-p`, isolated with
  `--setting-sources "" --strict-mcp-config`. No `ANTHROPIC_API_KEY` required. (Trade-off accepted: subject to
  the subscription's usage limits; API-key mode stays available to anyone who sets the env var.)

---

### Source references
- Claude Code headless / print mode, `--bare`, `--output-format json`, `--json-schema`, stdin 10 MB cap, auth — https://code.claude.com/docs/en/headless
- whisper.cpp + whisper-rs (ggml, CUDA/cuBLAS backend, in-process, `metal` for Mac) — https://github.com/ggml-org/whisper.cpp ; https://github.com/tazz4843/whisper-rs
- Vibe (Tauri + whisper.cpp reference: model download, GPU detect, packaging), Whisper4Windows (CUDA DLL bundling), ffmpeg-sidecar — https://github.com/thewh1teagle/vibe ; https://github.com/aarnphm/whisper4windows ; https://github.com/nathanbabcock/ffmpeg-sidecar
- ct2rs (CTranslate2 Rust binding — documented upgrade path) — https://github.com/jkawamoto/ctranslate2-rs
- faster-whisper / CTranslate2 (rejected for MVP: Python bundle) — https://github.com/SYSTRAN/faster-whisper
- Whisper variant comparison (faster-whisper vs whisper.cpp vs WhisperX) — https://modal.com/blog/choosing-whisper-variants ; https://builderai.tools/blog/whisper-cpp-vs-faster-whisper-speed-and-accuracy ; https://github.com/m-bain/whisperX
- distil-whisper is English-only — https://github.com/huggingface/distil-whisper ; https://huggingface.co/distil-whisper/distil-large-v3/discussions/1
- large-v3 / large-v3-turbo multilingual + Russian — https://huggingface.co/openai/whisper-large-v3 ; https://huggingface.co/openai/whisper-large-v3-turbo ; https://gigagpu.com/whisper-large-v3-turbo-speed-accuracy/ ; https://huggingface.co/antony66/whisper-large-v3-russian
- VRAM / model size — https://www.spheron.network/tools/gpu-recommender/openai/whisper-large-v3/ ; https://huggingface.co/Systran/faster-whisper-large-v3
- Tauri sidecar packaging — https://v2.tauri.app/develop/sidecar/ ; https://github.com/dieharders/example-tauri-v2-python-server-sidecar
- whisper.cpp (future Mac Metal/Core ML) — https://github.com/ggml-org/whisper.cpp
