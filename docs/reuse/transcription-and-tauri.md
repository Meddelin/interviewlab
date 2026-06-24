# Reuse Landscape: Local Transcription + Tauri 2 (InterviewLab)

**Date:** 2026-06-22
**Scope:** Find OSS to *reuse* or copy packaging/integration patterns from, so we don't build the
Tauri-2 + faster-whisper desktop app from scratch. Target: **Windows + Nvidia GPU (CUDA)**, CPU int8
fallback, future macOS M3 Pro. Default model **large-v3**, Russian-first. ASR shipped as a **Tauri
sidecar**, model weights downloaded on first run, CUDA/cuDNN DLLs bundled.

**Lazy-senior-dev lens applied throughout:** fewest bundled runtimes, most permissive licenses, copy a
working Tauri+whisper repo rather than inventing packaging.

---

## TL;DR recommendations

- **Scaffold to start from:** [`agmmnn/tauri-ui`](https://github.com/agmmnn/tauri-ui) (MIT, Tauri v2,
  shadcn/ui, actively maintained — v1.1.0 Apr 2026). It's a thin wrapper over the *official*
  create-tauri-app + shadcn CLIs, so it stays aligned with upstream. Backup:
  [`kitlib/tauri-app-template`](https://github.com/kitlib/tauri-app-template) (MIT, Tauri v2 + React 19
  + Vite + Tailwind v4 + shadcn, opinionated, includes i18n/dark-mode).
- **ASR engine packaging — the key decision:** Prefer a **Rust binding over a bundled Python runtime.**
  Two viable Rust paths (no Python sidecar, no PyInstaller):
  - **Option A (closest to our stated stack):** [`ct2rs` / `ctranslate2-rs`](https://github.com/jkawamoto/ctranslate2-rs)
    — actual CTranslate2 (== faster-whisper engine) in Rust, with a `whisper` feature and `cuda`/`cudnn`
    features. Keeps faster-whisper's CTranslate2 model format and int8 CPU fallback. MIT.
  - **Option B (most battle-tested for desktop):** switch the engine to **whisper.cpp via
    [`whisper-rs`](https://codeberg.org/tazz4843/whisper-rs)** (Unlicense) — this is exactly what
    **Vibe** ships in production. Smaller binary, simpler CUDA story, but it is *not* faster-whisper
    (different model files, different int8 path).
  - **Fallback (only if a Rust binding blocks us):** **faster-whisper frozen with PyInstaller as a
    sidecar**, copying the **[Whisper4Windows](https://github.com/BaderJabri/Whisper4Windows)** recipe
    (it already bundles cuBLAS/cuDNN DLLs from NVIDIA pip wheels into the MSI). This is the "bundled
    Python runtime" path we'd rather avoid, but it is a proven working recipe.
- **App to mine for model-download UX + GPU detection + ffmpeg + sidecar packaging:** **Vibe**
  (MIT, 6.5k★, Tauri + whisper.cpp, Win/Nvidia, v3.0.19 Mar 2026). For the *Python-sidecar + CUDA-DLL*
  recipe specifically, mine **Whisper4Windows** instead.
- **Helper crates:** [`nvml-wrapper`](https://github.com/rust-nvml/nvml-wrapper) (MIT/Apache) for Nvidia
  detection, [`ffmpeg-sidecar`](https://github.com/nathanbabcock/ffmpeg-sidecar) (MIT/Apache) to
  auto-download + drive a standalone ffmpeg binary at runtime.
- **ffmpeg licensing:** ship an **LGPL** ffmpeg build, invoke it as a **separate subprocess** (which
  `ffmpeg-sidecar` does), host the ffmpeg source + attribution. Avoid `--enable-gpl` builds.

---

## 1. Whisper desktop apps & Rust bindings (reuse / reference)

| Name | Stars | Maintained | License | Win/CUDA | Verdict |
|---|---|---|---|---|---|
| [Vibe](https://github.com/thewh1teagle/vibe) (Tauri + whisper.cpp) | ~6.5k | Active (v3.0.19, Mar 2026) | **MIT** | Yes (Nvidia/AMD/Intel; Vulkan/CUDA/CoreML) | **REFERENCE (top)** |
| [whisper-rs](https://codeberg.org/tazz4843/whisper-rs) (whisper.cpp Rust binding) | popular (~115k dl/mo) | Active (0.16.0, Mar 2026) | **Unlicense** | Yes (`cuda` feature) | **REUSE** |
| [ct2rs / ctranslate2-rs](https://github.com/jkawamoto/ctranslate2-rs) (CTranslate2 Rust binding) | ~57 | Active (0.9.x, 2026) | **MIT** | Yes (`cuda`,`cudnn`; needs `CUDA_TOOLKIT_ROOT_DIR`) | **REUSE (if staying on faster-whisper engine)** |
| [Whisper4Windows](https://github.com/BaderJabri/Whisper4Windows) (Tauri + faster-whisper PyInstaller sidecar) | ~30 | Active (2026) | **MIT** | Yes — bundles cuBLAS/cuDNN DLLs in MSI | **REFERENCE (Python-sidecar recipe)** |
| [Buzz](https://github.com/chidiwilliams/buzz) (PyQt6, wraps faster-whisper) | ~19k | Active | **MIT** | Yes (faster-whisper backend) | **REFERENCE (not Tauri)** |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (engine) | very high | Active | **MIT** | Yes (CTranslate2; CUDA 12 + cuDNN 9) | **REUSE (engine)** |
| [Whisper-WebUI](https://github.com/jhj0517/Whisper-WebUI) (Gradio web) | mid | Active | Apache-ish (verify) | Yes | **SKIP (web/Gradio, not desktop)** |
| Whishper (self-hosted web stack) | mid | varies | check (AGPL risk) | server | **SKIP (web, licensing risk)** |

### Notes per candidate
- **Vibe — highest-value reference.** MIT, 6.5k★, Tauri, multi-platform incl. Windows+Nvidia. Ships
  **whisper.cpp** with prebuilt libs (downloaded once at build via a Python script) and exposes GPU
  variants (Vulkan/CUDA/CoreML). It also supports an in-app **model-download deep-link**
  (`vibe://download/?url=<model url>`) and "Customize Models via Settings" — exactly the model-download
  UX we want to copy. Recent versions introduced a component called **`sona`** (Go/CGO + whisper.cpp)
  alongside the Rust/Tauri shell; the Tauri shell, model-download UX, settings, and packaging are still
  the parts worth mining. **Mine this repo for: model-download UX, GPU detection, ffmpeg handling,
  Tauri sidecar/lib packaging.** Stack: TS 66% / Rust 19% / Python 9%.
  Source: <https://github.com/thewh1teagle/vibe>, <https://github.com/thewh1teagle/vibe/blob/main/docs/building.md>
- **whisper-rs (Unlicense).** Mature, widely used Rust binding to whisper.cpp. `cuda` feature enables
  CUDA + the runtime GPU flag. **Note: the canonical repo moved from GitHub to
  [Codeberg](https://codeberg.org/tazz4843/whisper-rs); GitHub mirror is frozen.** This is what we'd use
  if we adopt the whisper.cpp engine (the Vibe path). Unlicense == public domain, zero obligations.
  Source: <https://crates.io/crates/whisper-rs>, <https://docs.rs/crate/whisper-rs/latest>
- **ct2rs / ctranslate2-rs (MIT).** Rust bindings to **CTranslate2 — the exact engine faster-whisper
  uses** — with a dedicated `whisper` feature plus `cuda` / `cudnn` features. **Statically builds &
  links CTranslate2; the final binary needs no Python.** Lets us keep faster-whisper's CTranslate2 model
  format and CPU int8 fallback *without* shipping a Python runtime. Caveats: needs **CMake** at build
  time, `CUDA_TOOLKIT_ROOT_DIR` set, and on Windows possibly `RUSTFLAGS=-C target-feature=+crt-static`.
  Smaller community (~57★) than whisper-rs, so more build-time risk. Has a Whisper example.
  Source: <https://github.com/jkawamoto/ctranslate2-rs>, <https://docs.rs/ct2rs>
- **Whisper4Windows — the Python-sidecar reference recipe.** MIT, Tauri (Rust) + Python FastAPI/Uvicorn
  backend frozen with **PyInstaller** and wired as a Tauri **`externalBin`** sidecar
  (`binaries/whisper-backend`, named `whisper-backend-x86_64-pc-windows-msvc.exe`). **The MSI bundles all
  CUDA DLLs (cuBLAS, cuDNN, etc.) pulled from the NVIDIA pip wheels** via `build_backend.py`, so end
  users need no CUDA toolkit. Models cached at `%APPDATA%\Whisper4Windows\models\`, auto-downloaded on
  first use. This is the canonical "how to ship faster-whisper + CUDA in a Tauri app" recipe — copy it
  *only if* we go the Python route.
  Source: <https://github.com/BaderJabri/Whisper4Windows/blob/main/BUILD.md>
- **Buzz (MIT, 19k★).** Python + PyQt6, wraps Whisper / whisper.cpp / faster-whisper behind one GUI;
  PyInstaller-packaged. Not Tauri, so no UI/packaging reuse, but a good reference for faster-whisper
  backend handling and model management. **REFERENCE.**
  Source: <https://github.com/chidiwilliams/buzz>
- **Whisper-WebUI / Whishper.** Gradio / self-hosted web stacks — wrong shape (browser/server, not a
  desktop sidecar). Verify licenses before lifting any code (web stacks more likely to carry AGPL).
  **SKIP** for our desktop app.

---

## 2. Tauri 2 + React + shadcn scaffolds

| Name | Stars | Maintained | License | Win/CUDA | Verdict |
|---|---|---|---|---|---|
| [agmmnn/tauri-ui](https://github.com/agmmnn/tauri-ui) | ~2.1k | Active (v1.1.0, Apr 2026) | **MIT** | n/a (UI scaffold) | **REUSE (pick this)** |
| [kitlib/tauri-app-template](https://github.com/kitlib/tauri-app-template) | ~84 | Active (v0.2.2, Mar 2026) | **MIT** | n/a | **REUSE (strong backup)** |
| [eggfriedrice24/tauri-react-starter](https://github.com/eggfriedrice24/tauri-react-starter) | small | Active | MIT | n/a | **REFERENCE** |
| [dannysmith/tauri-template](https://github.com/dannysmith/tauri-template) | small | Active | MIT | n/a | **REFERENCE (production-ready, auto-update)** |
| [Aero25x/tauri-shadcn-vite-template](https://github.com/Aero25x/tauri-shadcn-vite-template) | small | varies | MIT | n/a | **REFERENCE (minimal)** |

### Notes
- **agmmnn/tauri-ui — recommended start.** MIT, **Tauri v2**, shadcn/ui via the official CLI, scaffolds
  Vite / Next / React Router / Astro / TanStack Start. It's a CLI wrapper over create-tauri-app +
  shadcn rather than a frozen template, so it tracks upstream and won't rot. Ships desktop-ready
  defaults (native window controls, dark/light, small bundle). Pick the **Vite + React** variant.
  Source: <https://github.com/agmmnn/tauri-ui>
- **kitlib/tauri-app-template — opinionated backup.** MIT, **Tauri v2 + React 19 + TypeScript + Vite +
  shadcn/ui + Tailwind v4**, plus dark mode, i18n (i18next), custom titlebar, CI/CD. Closest to a
  ready-made app shell. **No sidecar example included** — we add the sidecar ourselves (copy from
  Whisper4Windows / Vibe).
  Source: <https://github.com/kitlib/tauri-app-template>
- All scaffolds are MIT and UI-only; none wire up a whisper sidecar. The sidecar wiring comes from
  Whisper4Windows (Python path) or Vibe (whisper.cpp path).

---

## 3. Helper crates (GPU detection, ffmpeg)

| Name | Stars / usage | Maintained | License | Win/CUDA | Verdict |
|---|---|---|---|---|---|
| [nvml-wrapper](https://github.com/rust-nvml/nvml-wrapper) | ~2.9M dl all-time | Active (0.11.0) | **MIT OR Apache-2.0** | Yes (Nvidia NVML) | **REUSE** |
| [ffmpeg-sidecar](https://github.com/nathanbabcock/ffmpeg-sidecar) | popular | Active (v2.3.0) | **MIT OR Apache-2.0** | Yes | **REUSE** |

### Notes
- **nvml-wrapper.** Safe Rust wrapper over NVIDIA Management Library; loads `nvml.dll` at runtime via
  `libloading` (no link-time CUDA dependency). Use `Nvml::init()` + `device_by_index(0)` to **detect an
  Nvidia GPU, VRAM, and driver** so we can choose CUDA vs CPU-int8 at runtime. Dual MIT/Apache — clean.
  Source: <https://github.com/rust-nvml/nvml-wrapper>, <https://docs.rs/nvml-wrapper>
- **ffmpeg-sidecar.** Wraps a **standalone ffmpeg binary** behind an iterator API and can
  **auto-download** the correct binary per-OS at runtime (`auto_download()`), so we don't have to ship
  ffmpeg in the installer. `KEEP_ONLY_FFMPEG=1` skips ffplay/ffprobe (<100MB zipped). Because it shells
  out to a **separate ffmpeg process**, it keeps ffmpeg's license cleanly separated from our binary.
  Dual MIT/Apache. **This solves "ffmpeg-in-Rust" for us.**
  Source: <https://github.com/nathanbabcock/ffmpeg-sidecar>

---

## 4. License red flags & notes

- **Green (permissive, safe to distribute):** whisper.cpp = **MIT**, faster-whisper = **MIT**,
  CTranslate2 = **MIT**, Vibe = MIT, Whisper4Windows = MIT, Buzz = MIT, all Tauri scaffolds = MIT,
  `nvml-wrapper` & `ffmpeg-sidecar` = MIT/Apache, `ct2rs` = MIT, `whisper-rs` = **Unlicense**
  (public domain).
- **ffmpeg — the one real licensing nuance.** ffmpeg is **LGPL by default, but parts are GPL** when
  built with `--enable-gpl`/`--enable-nonfree`.
  - Ship an **LGPL build** (avoid GPL/nonfree flags).
  - **Invoke ffmpeg as a separate subprocess** (which `ffmpeg-sidecar` does) — consensus is this keeps
    components separate and avoids license contamination of our app.
  - Obligations for a distributed LGPL ffmpeg: **host the ffmpeg source** alongside the binary, add
    **attribution** ("uses FFmpeg licensed under LGPLv2.1") in About box / EULA, with source download
    links.
  - Source: <https://www.ffmpeg.org/legal.html>
- **Watch the web stacks:** Whishper / some self-hosted Whisper web UIs may carry **GPL/AGPL** parts —
  irrelevant since we won't lift their code, but do not copy snippets without checking.
- **CUDA/cuDNN DLLs are redistributable** under NVIDIA's terms when bundled with an app (the
  Whisper4Windows MSI does exactly this from the NVIDIA pip wheels) — not OSI-OSS, but redistribution
  for end-user runtime is permitted. We must bundle the matching **CUDA 12 + cuDNN 9** versions
  (CTranslate2's current requirement) so users need no toolkit.

---

## 5. The packaging decision — Rust binding vs Python sidecar

**Recommendation: go Rust-binding first; keep the PyInstaller path as a documented fallback.**

| | Rust binding (ct2rs **or** whisper-rs) | faster-whisper via PyInstaller sidecar |
|---|---|---|
| Bundled runtimes | **None** (single Rust binary) | **Whole Python interpreter + deps** |
| Installer size | Smaller | Larger (Python + libs) |
| CUDA DLL bundling | We bundle cuBLAS/cuDNN ourselves | Pulled from NVIDIA pip wheels (W4W recipe) |
| Build complexity | Higher (CMake, CUDA toolkit at *build* time; Windows crt-static) | Lower to start, but PyInstoller + DLL juggling later |
| Proven desktop precedent | **whisper-rs → Vibe** (very strong); ct2rs (thinner) | **Whisper4Windows** (strong, exact recipe) |
| Keeps faster-whisper model format | **ct2rs: yes** / whisper-rs: no (whisper.cpp ggml models) | Yes |

- If we want to **stay literally on faster-whisper/CTranslate2** (CTranslate2 model files, int8 CPU
  fallback) with **no Python**, use **`ct2rs` with `cuda,cudnn,whisper` features**. Highest upside, some
  build-setup risk given its smaller community.
- If we just want **the most proven, lowest-risk desktop path**, adopt **whisper.cpp via `whisper-rs`**
  and copy Vibe wholesale — accept that it's a different engine than "faster-whisper" (re-evaluate
  Russian large-v3 quality/speed, but whisper.cpp large-v3 + CUDA is fine in practice).
- Only if both Rust paths stall, **freeze faster-whisper with PyInstaller** and copy the
  **Whisper4Windows** `externalBin` + CUDA-DLL-from-pip-wheels recipe verbatim. This is the lazy-but-
  heavy option (ships a Python runtime), so treat it as the fallback, not the default.

---

## Sources
- Vibe: <https://github.com/thewh1teagle/vibe> · <https://github.com/thewh1teagle/vibe/blob/main/docs/building.md>
- whisper-rs: <https://codeberg.org/tazz4843/whisper-rs> · <https://crates.io/crates/whisper-rs>
- ct2rs / ctranslate2-rs: <https://github.com/jkawamoto/ctranslate2-rs> · <https://docs.rs/ct2rs>
- faster-whisper: <https://github.com/SYSTRAN/faster-whisper>
- Whisper4Windows: <https://github.com/BaderJabri/Whisper4Windows/blob/main/BUILD.md>
- Buzz: <https://github.com/chidiwilliams/buzz>
- Tauri scaffolds: <https://github.com/agmmnn/tauri-ui> · <https://github.com/kitlib/tauri-app-template>
- nvml-wrapper: <https://github.com/rust-nvml/nvml-wrapper>
- ffmpeg-sidecar: <https://github.com/nathanbabcock/ffmpeg-sidecar>
- ffmpeg legal: <https://www.ffmpeg.org/legal.html>
