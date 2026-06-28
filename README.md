# InterviewLab

A desktop app for **user‑research interviews**: run interviews in cycles, transcribe locally (no cloud),
auto‑split speakers, clean up the transcript, synthesize findings against a research guide, diff findings
wave‑over‑wave, and chat about a cycle — all driven by a **locally‑installed AI CLI** behind a pluggable
adapter, so any CLI can be added as a drop‑in plugin **without touching app source**.

Built with **Tauri 2** (Rust backend + React/shadcn frontend). Everything heavy is on‑device:
- **ASR:** whisper.cpp via `whisper-rs` (CUDA on Windows/NVIDIA, Metal on Apple Silicon, CPU fallback).
- **Diarization:** sherpa‑onnx (pyannote segmentation + 3D‑Speaker embedding), CPU, **no Python**.
- **LLM steps** (cleanup / synthesis / diff / chat): a **local AI CLI you configure** — pluggable, any vendor
  (Claude Code is the bundled reference; not required — bring whatever CLI your environment provides).

## Status
- ✅ Verified end‑to‑end on **Windows + NVIDIA CUDA** (RTX 5080): ingest → ASR → diarize → cleanup → roles →
  synthesis → per‑interview summary → diff → chat, across 3 pluggable CLIs.
- 🟡 **macOS (Apple Silicon)** support is implemented in code (Metal feature, device detection, bundle config)
  but not yet run on real hardware.

## Install from source (one command, all dependencies, GPU‑accelerated)

There are no prebuilt downloads — you build from source. A setup script installs **every**
dependency (toolchain, native build tools, and the GPU toolkit) and then builds (or runs) the app.
It auto‑detects your GPU: **CUDA** on Windows + Nvidia, **Metal** on Apple Silicon. Re‑running is safe.

**Windows + Nvidia (GPU/CUDA)** — in PowerShell, from the repo root:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1        # install deps + build
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Run   # install deps + run the app
```
Installs (via `winget`): VS 2022 Build Tools (C++), Rust, Node, LLVM/libclang, CMake, Ninja, and the
CUDA Toolkit. Then builds the CUDA backend (`--features cuda`). First build compiles whisper.cpp's
CUDA kernels and takes a while.

**macOS (Apple Silicon, GPU/Metal)** — in Terminal/iTerm, from the repo root:
```bash
bash scripts/setup-macos.sh         # install deps + build
bash scripts/setup-macos.sh --run   # install deps + run the app
```
Installs Xcode Command Line Tools, Homebrew, Node, Rust, CMake, Ninja, then builds the Metal backend
(`--features metal`; add `--coreml` for the ANE encoder, which needs full Xcode).

After the build the script prints where the installer / `.app` landed. Then **download the ASR model**
with the in‑app button and **connect your AI CLI** — see the onboarding wizard on first launch.

> Manual dev build (no setup script): `cd interviewlab && npm install && npm run tauri dev -- --features cuda`
> (Nvidia) or `--features metal` (Apple Silicon). You must already have the toolchain above.

## Layout
- `scripts/` — one‑shot from‑source setup: `setup-windows.ps1` (CUDA) and `setup-macos.sh` (Metal).
- `interviewlab/` — the Tauri app (`src/` React UI, `src-tauri/` Rust backend, `migrations/` SQLite schema).
- `docs/` — design + build docs (`mac-run-for-agent.md`, `mac-build.md`, `feature-*.md`, `product-spec.md`, …).
- `_e2e/` — the CDP driver (`cdp.mjs`) + Windows GPU launcher (`gpu_dev.cmd`) used to drive the real app over WebView2.

## Pluggable AI CLIs
The active CLI is a plugin. Add one by dropping a manifest at
`<app-data>/plugins/<id>/manifest.json` and clicking **Rescan** in Settings → AI CLI — no recompile.
Bundled references: Claude Code, Qwen Code, Antigravity. See [docs/feature-cli-plugins.md](docs/feature-cli-plugins.md).
