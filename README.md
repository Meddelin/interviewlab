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

## Run it

**macOS (Apple Silicon)** — start here: **[docs/mac-run-for-agent.md](docs/mac-run-for-agent.md)** (a step‑by‑step
guide written for an AI coding agent to set up + run, including how to tell a plugin‑folder fix from a
source‑code fix).

**Windows + NVIDIA (CUDA)** — needs CUDA Toolkit 13.3 + the build env; see
[docs/goal-progress.md](docs/goal-progress.md) and `_e2e/gpu_dev.cmd` for the exact launcher.

Generic dev (CPU):
```bash
cd interviewlab
npm install
npm run tauri dev          # add `-- --features cuda` (NVIDIA) or `-- --features metal` (Apple Silicon)
```

## Layout
- `interviewlab/` — the Tauri app (`src/` React UI, `src-tauri/` Rust backend, `migrations/` SQLite schema).
- `docs/` — design + build docs (`mac-run-for-agent.md`, `mac-build.md`, `feature-*.md`, `product-spec.md`, …).
- `_e2e/` — the CDP driver (`cdp.mjs`) + Windows GPU launcher (`gpu_dev.cmd`) used to drive the real app over WebView2.

## Pluggable AI CLIs
The active CLI is a plugin. Add one by dropping a manifest at
`<app-data>/plugins/<id>/manifest.json` and clicking **Rescan** in Settings → AI CLI — no recompile.
Bundled references: Claude Code, Qwen Code, Antigravity. See [docs/feature-cli-plugins.md](docs/feature-cli-plugins.md).
