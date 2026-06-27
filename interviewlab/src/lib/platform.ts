// Platform detection for shortcut glyphs. The handlers already accept both
// modifiers (e.metaKey || e.ctrlKey); this only drives the DISPLAYED label so it
// reads "⌘K" on macOS and "Ctrl+K" on Windows/Linux.
// ponytail: synchronous navigator-detect, no Tauri OS plugin — a string label
// doesn't justify an async round-trip through the backend.

// navigator.userAgentData is the modern (non-deprecated) source; fall back to the
// classic navigator.platform where it's missing (e.g. Firefox/Safari).
const platformString =
  (typeof navigator !== "undefined" &&
    ((
      navigator as Navigator & { userAgentData?: { platform?: string } }
    ).userAgentData?.platform ??
      navigator.platform)) ||
  "";

export const isMac = /Mac|iPhone|iPad/i.test(platformString);

// The modifier glyph: "⌘" on macOS, "Ctrl" elsewhere.
export const modKey = isMac ? "⌘" : "Ctrl";

// Format a mod-key combo for display: mod("K") → "⌘K" on mac, "Ctrl+K" otherwise.
// macOS convention glues the glyph to the key; elsewhere we join with a "+".
export function mod(key: string): string {
  return isMac ? `${modKey}${key}` : `${modKey}+${key}`;
}
