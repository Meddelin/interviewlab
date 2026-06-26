# Fix: edited-segment timing corrupted on first save (coalescing)

> **Status:** fixed. Date: 2026-06-26.
> **Severity:** real data bug — wrong media-sync after saving an edited transcript.

## Symptom

After editing a transcript and saving, clicking a paragraph to play it (or the active-segment
highlight) jumped to the **wrong place** in the audio for every paragraph after the first. Re-
opening the interview showed the same wrong timing baked in.

## Root cause

The editor coalesces the fine-grained transcript segments into **paragraphs** for display
(`coalesceSegments`, `src/pages/transcript-editor.tsx`) and persists those paragraphs as the
`edited` version. So it saves **fewer** segments than the `raw` source.

`save_edited_db` (`src-tauri/src/transcript.rs`) enforced the timing-immutable invariant
(spec §4.5) by re-stamping each saved segment's timing from the source **by index**:

```rust
for (i, seg) in segments.iter_mut().enumerate() {
    if let Some((start, end)) = timing.get(i) { seg.start_ms = *start; seg.end_ms = *end; }
}
```

When the client sent `N` coalesced paragraphs and `raw` had `M > N` segments, paragraph `i`
wrongly took `raw[i]`'s span instead of its own `[first.start, last.end]`:

- paragraph 0 = raw[0..3] → should be `0..13100`, got `raw[0]` = `0..4200` (end lost)
- paragraph 1 = raw[4..6] → got `raw[1]`'s span (completely wrong)

It was masked in tests because the unit test sent 3 segments matching the 3 raw segments 1:1
(no coalescing), so index re-stamping happened to be correct.

## Fix

Enforce immutability **by value, not by index**: snap every saved boundary to the nearest
**real** boundary from the finest source version (`raw`).

```rust
let (starts, ends) = boundary_set_db(...);   // sorted, de-duped raw boundaries
seg.start_ms = snap_to_nearest(seg.start_ms, &starts);
seg.end_ms   = snap_to_nearest(seg.end_ms,   &ends);
if seg.end_ms < seg.start_ms { seg.end_ms = seg.start_ms; }
```

Why this is correct **and** keeps the security guarantee:

- The editor only ever uses real `raw` boundaries (coalescing copies `start`/`end` verbatim),
  so a legitimate merged paragraph's `[first.start, last.end]` are both real boundaries → they
  snap to themselves → **preserved exactly** (the 0..13100 case now round-trips).
- A buggy/malicious off-boundary value is still pulled back onto a real boundary, so the client
  **can never invent or shift a timestamp** — the invariant the old re-stamp was protecting.
- `boundary_set_db` prefers `raw` (the finest, superset boundary set) over `cleaned`/`edited`,
  so a **re-split after the first save** still finds the fine-grained boundary it needs, even
  though the already-saved `edited` version is coarser.

## Tests (`transcript.rs`)

- `save_edited_coalesced_preserves_merged_span` — regression: one merged paragraph keeps
  `0..13100` (was corrupted to `0..4200`).
- `re_split_after_save_snaps_to_raw_boundary` — a later split lands on the fine-grained raw
  boundary `4200`, which exists in `raw` but not in the coarse `edited`.
- `save_edited_reload_persists_and_timing_immutable` — updated: bogus client timing snaps to
  real raw boundaries (membership), not invented values.

## Knock-on benefit

The per-segment diff (`feature-segment-diff.md`) matches working segments to the original by
time-overlap. With timing now correct after a save, that matching is exact post-reload too.
</content>
