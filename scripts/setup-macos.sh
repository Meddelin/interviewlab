#!/usr/bin/env bash
#
# InterviewLab — one-shot setup from source for macOS (Apple Silicon, with Metal GPU).
#
# DETECTS your configuration (arch + which build dependencies are present), INSTALLS only the
# missing ones (Xcode CLT, Homebrew, Node, Rust, CMake, Ninja), then builds (or runs) the app
# from source with the Metal GPU backend.
#
# Usage (from the repo root, in Terminal/iTerm):
#   bash scripts/setup-macos.sh            # detect + install missing + build
#   bash scripts/setup-macos.sh --check    # detect ONLY: report config + what's missing
#   bash scripts/setup-macos.sh --run      # ... + run the app (tauri dev)
#   bash scripts/setup-macos.sh --coreml   # also build the CoreML/ANE encoder (needs full Xcode)
#
# Re-running is safe: anything already installed is skipped.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$REPO/interviewlab"

RUN=0; COREML=0; CHECK=0
for a in "$@"; do
  case "$a" in
    --run) RUN=1 ;;
    --coreml) COREML=1 ;;
    --check) CHECK=1 ;;
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done

info(){ printf '\033[36m==> %s\033[0m\n' "$1"; }
ok(){ printf '\033[32m  [ok]      %s\033[0m\n' "$1"; }
miss(){ printf '\033[33m  [missing] %s\033[0m\n' "$1"; }

case "$(uname -s)" in Darwin) ;; *) echo "This script is for macOS." >&2; exit 1 ;; esac

# --- detect configuration ---------------------------------------------------------------
info "InterviewLab setup — detecting configuration (repo: $REPO)"
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  echo "  Arch: Apple Silicon ($ARCH) → Metal GPU build"
else
  echo "  Arch: $ARCH → Intel Mac: no Metal GPU, will build CPU-only (Metal needs Apple Silicon)"
fi

# probe deps (name|test-command). xcode-select + brew handled specially.
present_xcode(){ xcode-select -p >/dev/null 2>&1; }
present_brew(){ command -v brew >/dev/null 2>&1; }
declare -a MISSING=()
report(){ # $1 name, $2 result(0/1)
  if [ "$2" -eq 0 ]; then ok "$1"; else miss "$1"; MISSING+=("$1"); fi
}
info "dependency status:"
present_xcode; report "Xcode Command Line Tools" $?
present_brew; report "Homebrew" $?
command -v node  >/dev/null 2>&1; report "Node.js" $?
command -v rustc >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/rustc" ]; report "Rust" $?
command -v cmake >/dev/null 2>&1; report "CMake" $?
command -v ninja >/dev/null 2>&1; report "Ninja" $?

if [ "$CHECK" = "1" ]; then
  echo
  if [ "${#MISSING[@]}" -eq 0 ]; then info "all deps present — re-run without --check to build."; else info "missing: ${MISSING[*]} — re-run without --check to install + build."; fi
  exit 0
fi

# --- install only the missing deps ------------------------------------------------------
if ! present_xcode; then
  info "installing Xcode Command Line Tools (a GUI dialog will appear — accept it) ..."
  xcode-select --install || true
  echo "    waiting for Command Line Tools to finish..."
  until present_xcode; do sleep 5; done
fi
ok "Xcode CLT: $(xcode-select -p)"

if ! present_brew; then
  info "installing Homebrew ..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
ok "Homebrew: $(command -v brew)"

brew_ensure(){ if command -v "$2" >/dev/null 2>&1; then ok "$1"; else info "brew install $1 ..."; brew install "$1"; fi; }
brew_ensure node node
brew_ensure cmake cmake
brew_ensure ninja ninja

if command -v rustc >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/rustc" ]; then
  ok "Rust present"
else
  info "installing Rust (rustup) ..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env" || true

# --- build (or run) ---------------------------------------------------------------------
# Metal is in the macOS SDK → no extra dependency on Apple Silicon. CoreML/ANE encoder is an
# optional speedup that needs full Xcode (not just CLT); off by default to keep install simple.
if [ "$ARCH" = "arm64" ]; then
  FEATURES="metal"
  [ "$COREML" = "1" ] && FEATURES="metal,coreml"
else
  FEATURES=""   # Intel Mac: no Metal → CPU build
fi

cd "$APP"
info "npm install ..."
npm install

FEATURE_ARGS=()
[ -n "$FEATURES" ] && FEATURE_ARGS=(-- --features "$FEATURES")

if [ "$RUN" = "1" ]; then
  info "launching app from source (${FEATURES:-CPU}): tauri dev ${FEATURES:+--features $FEATURES}"
  npm run tauri dev "${FEATURE_ARGS[@]}"
else
  info "building from source (${FEATURES:-CPU}) — compiles whisper.cpp, can take a while..."
  npm run tauri build "${FEATURE_ARGS[@]}"
  echo
  ok "build done. App / installer here:"
  find "$APP/src-tauri/target/release/bundle" \( -name '*.dmg' -o -name '*.app' \) -maxdepth 3 2>/dev/null | sed 's/^/    /'
  echo
  ok "Done. Open the .dmg/.app above, or re-run with --run to launch directly."
fi
