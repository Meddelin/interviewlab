# Run InterviewLab on macOS (Apple Silicon) — instructions for an AI coding agent

**You are an AI coding agent running on a Mac with Apple Silicon (M3 Pro or better).**
Your job: get InterviewLab **building and running**, set up the **local AI CLI**, and **report any errors**
clearly. A human will then drive the end‑to‑end test (upload a real interview, click through the pipeline).

> The app was built and verified on **Windows + NVIDIA CUDA**. macOS support is implemented in code
> (Metal feature, device detection, bundle config) but has **never been run on real Apple hardware** — so
> expect a few platform issues. This doc tells you how to run it and, crucially, **how to tell a
> plugin‑folder fix (you can do it) from a source‑code fix (stop and report it)**.

---

## 0. What "working" looks like (the human's e2e)

So you know what to aim for. The human will do these clicks; you make each step **reachable** and report failures:

1. Create a **Product** (markdown description) and a **Guide** (research goals) in the libraries.
2. Create a **Cycle**, link the product + guide.
3. **Upload a real interview** audio file (30+ min, any common format).
4. **Transcribe** it: pick a local Whisper model, language, `expected speakers = 2`.
5. Confirm **speaker separation** (S1 / S2 turns) and that segments read as **merged paragraphs**.
6. **Clean up** the transcript (runs through the local CLI).
7. **Assign roles** to the speakers (interviewer / respondent).
8. **Synthesis** → findings grouped by goal + by role.
9. (Optional) a second cycle → **Diff** vs the previous wave.
10. **Chat** about the cycle (streaming, grounded answers).

Everything is **local**: ASR (whisper.cpp) and diarization (sherpa‑onnx) run on‑device, no cloud, no Python.
Only the LLM steps (cleanup / synthesis / diff / chat) go through a **local AI CLI you configure** (§5) —
whatever your environment provides. **Claude is not available here**; no specific vendor is required.

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

---

## 4. Local models (ASR + diarization, all on‑device)

- **Whisper (ASR):** in the app → **Settings → ASR model** → download one. Recommend **`large-v3`** (best
  quality, fine on Metal) or **`base`** (fast). Models download into the app data dir.
- **Diarization (speaker split):** the app fetches the sherpa‑onnx ONNX models (pyannote segmentation +
  3D‑Speaker embedding) on first use / via a "download diarization models" action. CPU, ~real‑time, no Python.

App data dir on macOS: `~/Library/Application Support/com.interviewlab.app/`

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
batch tasks, `streaming` + `multi-turn` for chat, `tool-use` if applicable); a per‑task `args_template`
(how to invoke the CLI for each task, with `{prompt}` substitution); how to **extract the result** from the
CLI's output (e.g. a JSON path); and, for chat, a `chat.stream` block naming the stream parser.

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

### Known macOS source‑side risks (expect these)
- The **Metal** path is implemented but **never run on real hardware** — Metal init / performance is unverified.
- **Dylib bundling for a packaged `.app`** is a known TODO; **dev mode (`tauri dev`) is the supported path**
  for now (it loads the native libs from the build output). A packaged `.dmg` may fail to find the dylibs.
- **CoreML / Apple Neural Engine** for whisper is a future toggle, not wired up.
- `nvml` (NVIDIA‑only) is `cfg`‑gated off macOS; if you ever see an nvml symbol/link error on macOS, that's a
  **source** gating bug — report it.

See `docs/mac-build.md` for the engineering detail behind all of the above.

---

## 7. Quick reference

```bash
# run (Metal GPU)
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
