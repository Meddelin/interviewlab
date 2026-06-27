#!/usr/bin/env bash
#
# InterviewLab — one-shot setup from source for macOS (Apple Silicon, with Metal GPU).
#
# Installs every build dependency (Xcode CLT, Homebrew, Node, Rust, CMake, Ninja), then
# builds (or runs) the app from source with the Metal GPU backend.
#
# Usage (from the repo root, in Terminal/iTerm):
#   bash scripts/setup-macos.sh            # install deps + build the .app/.dmg
#   bash scripts/setup-macos.sh --run      # install deps + run the app (tauri dev)
#   bash scripts/setup-macos.sh --coreml   # also build the CoreML/ANE encoder (needs full Xcode)
#
# Re-running is safe: anything already installed is skipped.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$REPO/interviewlab"

RUN=0; COREML=0
for a in "$@"; do
  case "$a" in
    --run) RUN=1 ;;
    --coreml) COREML=1 ;;
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done

info(){ printf '\033[36m==> %s\033[0m\n' "$1"; }
ok(){ printf '\033[32m  ok: %s\033[0m\n' "$1"; }
warn(){ printf '\033[33m  ! %s\033[0m\n' "$1"; }

case "$(uname -s)" in Darwin) ;; *) echo "This script is for macOS." >&2; exit 1 ;; esac

info "InterviewLab setup — repo: $REPO"

# --- Xcode Command Line Tools (clang + macOS SDK; Metal lives in the SDK) ----------------
if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode Command Line Tools present"
else
  info "installing Xcode Command Line Tools (a GUI dialog will appear — accept it) ..."
  xcode-select --install || true
  echo "    Waiting for the Command Line Tools install to finish..."
  until xcode-select -p >/dev/null 2>&1; do sleep 5; done
  ok "Xcode Command Line Tools installed"
fi

# --- Homebrew ---------------------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  info "installing Homebrew ..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # add brew to PATH for this session (Apple Silicon prefix)
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi
ok "Homebrew: $(command -v brew)"

# --- build deps via Homebrew ------------------------------------------------------------
brew_ensure(){ # $1 = formula, $2 = probe command
  if command -v "$2" >/dev/null 2>&1; then ok "$1 present"; else info "brew install $1 ..."; brew install "$1"; fi
}
brew_ensure node node
brew_ensure cmake cmake
brew_ensure ninja ninja

# Rust via rustup (Tauri wants the rustup-managed toolchain + targets)
if command -v rustc >/dev/null 2>&1; then
  ok "rust present"
else
  info "installing Rust (rustup) ..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi
command -v rustc >/dev/null 2>&1 || source "$HOME/.cargo/env"
ok "rust: $(rustc --version 2>/dev/null || echo 'in ~/.cargo/bin')"

# --- build (or run) ---------------------------------------------------------------------
# Metal is in the macOS SDK → no extra dependency. CoreML/ANE encoder is an optional speedup
# that needs full Xcode (not just CLT); off by default to keep the install simple.
FEATURES="metal"
if [ "$COREML" = "1" ]; then FEATURES="metal,coreml"; fi

cd "$APP"
info "npm install ..."
npm install

if [ "$RUN" = "1" ]; then
  info "launching app from source (GPU/Metal): tauri dev --features $FEATURES"
  npm run tauri dev -- --features "$FEATURES"
else
  info "building from source (GPU/Metal, features: $FEATURES) — compiles whisper.cpp, can take a while..."
  npm run tauri build -- --features "$FEATURES"
  echo
  ok "build done. App / installer here:"
  find "$APP/src-tauri/target/release/bundle" \( -name '*.dmg' -o -name '*.app' \) -maxdepth 3 2>/dev/null | sed 's/^/    /'
  echo
  ok "Done. Open the .dmg/.app above, or re-run with --run to launch directly."
fi
