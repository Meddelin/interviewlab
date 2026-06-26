# Feature: Per-segment diff vs the original + drop the version Select

> **Status:** implemented. Date: 2026-06-26.
> **Why now:** edits now happen entirely in the one editor window — manually in each segment's
> textarea and per-segment via AI ("Хуйня, переписывай"). The founder wants to **see exactly
> what changed vs the original transcript** for any segment they touched, and the old
> raw/cleaned/edited version **Select** no longer carries its weight: switching versions was the
> old way to "compare", and that job is now done inline per segment.
>
> **Reads / amends:** `product-spec.md` §4.5 (timing-immutable invariant — the diff relies on
> it), `feature-diarization.md` (turn grouping). Touches only the editor UI; no schema/back-end
> change.

---

## 1. What changed in the UI

- **Removed** the raw/cleaned/edited version Select from the editor sub-toolbar. The editor still
  loads the best working copy internally (`edited` if saved, else `raw`); the user no longer
  picks a version.
- **Added** a per-segment **inline diff** against the original transcript:
  - Each segment whose text diverged from the original shows an amber **"Изменено"** chip and a
    **"Вернуть"** (revert-to-original) button.
  - Clicking the chip expands a GitHub/GitLab-style **word-level diff** under the segment:
    deletions struck through in red, insertions in green, unchanged text dimmed.
  - A header toggle **"Изменения (N)"** expands every changed segment's diff at once (N = number
    of changed segments). It only appears when something actually differs.

## 2. The baseline ("original")

The diff compares the working text against the **`raw` transcript** — the pristine source as
transcribed or imported (`feature-transcript-import.md`), before any manual or AI edit. It's
loaded independently of the working version so "what changed vs the original" survives even
after the edited version is saved and reopened.

## 3. Matching working segments to the original

The editor coalesces fine-grained segments into paragraphs for display, so the working segments
and the raw segments don't share indices. Each working segment is matched to its original by
**maximum time-overlap** (`Math.min(end) - Math.max(start)`), with the original coalesced the
same way first. Timing is immutable (spec §4.5), so overlap is a stable anchor that survives
coalescing-granularity differences and any boundary shift — far more robust than matching by
exact start. When spans don't overlap at all (a heavily re-split turn), it falls back to the
nearest paragraph. No baseline (no `raw`) → no diff UI, gracefully.

## 4. The diff algorithm

`src/lib/word-diff.ts` — a dependency-free **word-level LCS diff**:
- Tokenizes into alternating word/whitespace tokens (so re-joining reproduces the text verbatim
  and punctuation stays attached to its word).
- Runs an LCS over tokens and emits coalesced `eq` / `del` / `ins` runs.
- `textChanged(a, b)` compares trimmed text so a stray edge space never reads as a change.

Segments are short (a sentence to a paragraph), so the O(n·m) table is negligible.

## 5. Surface

- `src/lib/word-diff.ts` — `wordDiff()`, `textChanged()`, `DiffPart`.
- `src/pages/transcript-editor.tsx` — baseline load (`raw`) + overlap matching, `changedCount`,
  the header **Changes** toggle (replacing the version Select), and the per-segment chip / diff /
  revert in `SegmentLine`.
</content>
