# Releasing InterviewLab (CI installers)

How a tagged release produces installers on every platform, what ships, and how a user runs the
**unsigned** builds. The pipeline is `.github/workflows/release.yml` (uses
[`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action)).

> **Signing / notarization: not yet.** Builds are **unsigned** on every platform (no Apple or
> Windows signing secrets are configured). This is a deliberate v2 simplification — see
> [Unsigned: user bypass](#unsigned-installers--how-users-run-them) and
> [Future: signing](#future-signing--notarization).

---

## Cutting a release

1. Bump `version` in `interviewlab/src-tauri/tauri.conf.json` (and `package.json`) if needed.
2. Tag and push:
   ```bash
   git tag v2.0.0
   git push origin v2.0.0
   ```
3. The `release` workflow triggers on the `v*` tag, builds the matrix, and creates a **GitHub
   Release** named `InterviewLab v2.0.0` with the installers attached.

You can also run it **manually** from the Actions tab (`workflow_dispatch`) — that builds the same
matrix but attaches the artifacts to a **draft** release (no real tag is created).

---

## What gets built (matrix)

| Runner | Target | Whisper backend | Artifacts | Signed? |
|---|---|---|---|---|
| `macos-14` (Apple Silicon, arm64) — **MAIN target** | `aarch64-apple-darwin` | **Metal + CoreML/ANE** (`--features metal,coreml`) | `.dmg`, `.app` | No |
| `windows-latest` | `x86_64-pc-windows-msvc` | **CPU** (default; no CUDA feature) | `.msi`, `.exe` (NSIS) | No |

- **Mac is the priority** (`fail-fast: false` keeps the others alive if one breaks). The Apple
  Silicon build enables Metal (GPU) **and** the CoreML/ANE encoder — the fastest path. Xcode Command
  Line Tools (clang + macOS SDK; Metal is in the SDK) are preinstalled on `macos-14`. The CoreML
  `.mlmodelc` encoder artifact is **auto-fetched at first model download at runtime** (see
  `docs/mac-build.md`), so nothing extra is needed at build time.
- **Windows** ships the **CPU** build by default (GitHub-hosted runners have no Nvidia GPU). The
  native sherpa-onnx / onnxruntime libs are pulled by the cargo build-script; ffmpeg is auto-fetched
  at runtime (not bundled). CUDA is a separate self-hosted job — see below.

### Approximate sizes
The installer itself is small-to-moderate (tens of MB — app binary + the bundled onnxruntime/sherpa
DLLs/dylibs). The **whisper large-v3 weights (~3 GB)** and **ffmpeg** are **NOT** in the installer —
they download on first use (whisper model via the in-app button; ffmpeg via `ffmpeg-sidecar`). So
the download a user grabs from the Release is the small installer, not multi-GB.

---

## Unsigned installers — how users run them

The artifacts are unsigned, so the OS will warn on first launch. This is expected; here is the
one-time bypass to include in release notes.

### macOS (Gatekeeper)
The `.dmg`/`.app` is not signed or notarized, so macOS quarantines it. Either:

- **Right-click → Open** (instead of double-click) the app the first time, then confirm **Open** in
  the dialog. macOS remembers the choice.
- **Or** clear the quarantine attribute from a terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/interviewlab.app
  ```
  (Run after dragging the app from the `.dmg` to `/Applications`.)

If macOS says the app is **"damaged and can't be opened"**, that is the quarantine flag on an
unsigned build — the `xattr -dr com.apple.quarantine` command above fixes it.

### Windows (SmartScreen)
The `.msi`/`.exe` is unsigned, so Microsoft Defender SmartScreen shows
*"Windows protected your PC."* To proceed:

- Click **More info**, then **Run anyway**.

---

## Adding the CUDA (Windows + Nvidia) build later

GitHub-hosted runners have **no Nvidia GPU and no CUDA Toolkit**, so the `--features cuda` build
cannot run on them. The recipe is also environment-heavy (CUDA Toolkit **13.3**, Ninja generator,
`vcvars64` — the exact requirements are documented in `interviewlab/src-tauri/Cargo.toml` under the
`cuda` feature). Plan:

1. **Register a self-hosted runner** on the RTX box with labels `[self-hosted, windows, cuda]`
   (GitHub repo → Settings → Actions → Runners → New self-hosted runner).
2. Ensure that box has the CUDA build env from `Cargo.toml`: CUDA Toolkit 13.3, Ninja, and the MSVC
   toolchain (so `vcvars64` is available); Node + Rust.
3. **Enable the commented `build-windows-cuda` job** in `.github/workflows/release.yml` (flip
   `if: false`). It mirrors the Windows job but passes `--features cuda`.

The CUDA build is **additive** — it produces an extra Nvidia-accelerated Windows installer alongside
the default CPU one; the CPU build remains the universal fallback.

---

## Future: signing + notarization

Out of scope for v2 (no signing secrets are set in CI), tracked as a separate task:

- **macOS:** an Apple Developer ID certificate + `tauri-action`'s `APPLE_CERTIFICATE` /
  `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` secrets to sign and
  notarize (so no Gatekeeper bypass is needed).
- **Windows:** a code-signing certificate (`WINDOWS_CERTIFICATE` + password) to clear SmartScreen.

When added, these are env/secrets only — the workflow structure does not change.

---

## Notes / caveats

- The workflow itself can only be fully verified by a **real run in GitHub Actions** (the macOS Metal
  link, CoreML compile, dylib packaging, and `.dmg` creation need the actual runners — they can't be
  reproduced from a Windows dev box). Treat the first tagged run as the smoke test.
- `npm ci` requires `interviewlab/package-lock.json` (present) to stay in sync with `package.json`.
- See `docs/mac-build.md` for the Apple Silicon backend details (Metal / CoreML / device detection).
