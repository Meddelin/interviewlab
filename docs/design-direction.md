# Design direction — "Linear for user-interview research"

North star: InterviewLab should feel like **Linear**, applied to user-research interviews. A premium, fast, keyboard-first productivity tool — not a CRUD form with default shadcn styling. This doc is the concrete brief for design/polish work. shadcn is the component base; style it **up to this bar**.

## Work-area width (fluid full-width / max density)
The work area is a **fluid full-width** container — this is a data-dense work tool, so content fills **any** screen format with only sensible side padding (`px-6`/`lg:px-8`), no centered `max-w` cap that wastes horizontal space on wide monitors. Data/list/table/form views go full-width to maximize information density and stay clean and responsive at narrow widths (no overflow).

**The one exception:** long-form **markdown / prose editors** (the Guides Plate editor, and any future prose editor) keep a **comfortable max reading width** (e.g. `max-w-3xl`) — full ultra-wide prose is hard to read. So the page chrome / list around such an editor is fluid full-width, but the editing column itself is capped to a readable measure. This supersedes the older "focused max-w reading column" note for data views; the readable column applies **only** to long-form markdown editors.

## Principles
1. **Content over chrome.** Minimal toolbars, no decorative panels. Let data breathe; reveal detail progressively.
2. **Dark-first.** Dark is the product's identity (light theme is a nice-to-have, not MVP-critical).
3. **Keyboard-first.** A **Cmd/Ctrl+K command palette** is central (create cycle, jump to cycle/interview, run cleanup/synthesis, toggle theme). Common actions have visible shortcut hints. Full mouse support, but power users never need it.
4. **Calm, fast, subtle.** Motion 100–150ms, ease-out, no bounce/spring. Hover/focus states are quiet. Everything should feel instant.
5. **One accent, used sparingly.** Neutral UI; the accent marks the primary action, active nav, and focus ring — nothing else.
6. **Every state is designed** — empty, loading (skeletons, not spinners where possible), and error states are crafted, each with one clear primary action.

## Concrete tokens (tune in code, these are targets)
- **Background:** near-black neutral, faint cool tint (e.g. `#08090A`–`#0B0C0E`). Elevated surfaces only marginally lighter (`#101113`). Avoid pure `#000`.
- **Borders:** hairline 1px, low contrast (`white/6–10%`). Prefer borders + subtle elevation over drop shadows. Shadows only for true overlays (Dialog, Popover, Command).
- **Radius:** modest — 6–8px for cards/inputs, 8–10px for overlays. Not pill-shaped, not sharp.
- **Accent:** indigo/violet family (~`#5E6AD2`, Linear-ish) as the single accent. **Adjustable** — confirm exact hue with the user against real screens.
- **Typography:** Inter (or the system's closest). Sizes small and deliberate — body ~13–14px, secondary ~12px, headings via weight (500–600) more than size. **Tabular numbers** for dates/durations/counts. Generous line-height in editors, tight in lists.
- **Spacing:** 8px grid. List rows compact (single line, ~36–40px), with secondary metadata in muted color, right-aligned.
- **Status colors:** muted, semantic, consistent — a small dot + label. e.g. importing = amber, ready = green/teal, error = red, processing = accent. Low saturation.
- **Icons:** lucide, 1.5px stroke, 16px in lists/nav. Consistent, sparing.

## Per-surface notes
- **App shell / header nav:** with only Cycles / Guides / Settings, a left sidebar wastes horizontal space — the shell is a **compact top header** instead: workspace mark/title, quiet nav links (active item marked with the accent underline, not a heavy pill), the Search ⌘K affordance, the backend-status dot, and the theme toggle, all in the header. The work area renders **fluid full-width** below a hairline divider — a `w-full` container with comfortable side padding only (no centered `max-w` cap), so it fills wide monitors and stays clean when narrow (see "Work-area width" above).
- **Cycles list:** Linear "issues list" feel — dense scannable rows (name, status dot, interview count, updated date in muted tabular text), full-row hover affordance, click → detail. "New cycle" is a quiet button **and** Cmd+K / shortcut. Empty state: one short line + primary "New cycle" action, not a barren card.
- **Cycle detail:** Linear "issue view" — a focused main column with the tabs (Overview / Interviews / Synthesis / Diff), metadata (prev-cycle, dates) as quiet secondary info. Overview textareas should read like a calm document, not a web form: generous, low-chrome, autosize, subtle labels.
- **Interviews tab:** drag-drop is a calm dashed dropzone that's obvious but unobtrusive; once populated it's a tight DataTable with status dots + live progress. Row → transcript editor later.
- **Transcript editor (the differentiator, later milestone):** document-like, keyboard-friendly, two-pane (segments + media), speaker/role tags as quiet inline chips. This is where the "premium tool" feeling matters most — design it with the most care.
- **Command palette:** group by action type; fuzzy search; recent/likely actions first; shows shortcuts.

## Avoid
- Default/untouched shadcn look; big colorful gradients; heavy drop shadows; oversized rounded cards everywhere; emoji in UI; dense toolbars; spinners where a skeleton fits; more than one accent color; saturated status colors.

## Signature & subject grounding (v1)
"Linear" is the discipline; the **subject** (interview research) is where the distinctive touches come from — don't ship a generic dark slab:
- **Monospace numerals** for the data of this domain — timestamps, durations, interview counts, dates in lists — in a mono face (e.g. Geist Mono / JetBrains Mono). Transcripts are full of timecodes; leaning into mono time is honest to the subject and reads precise.
- **A status/role color system** that's reused everywhere (interview ingest status now; speaker/role tags in the transcript editor later) — one coherent semantic vocabulary, muted.
- **Research "waves"** framing for cycles (a cycle is a wave of interviews) — subtle, e.g. a quiet wave index / "vs previous wave" affordance, not a gimmick.
- The **command palette (Cmd/Ctrl+K)** is the signature interaction — fast navigation + actions, the thing the tool is remembered for.

## Concrete token plan (v1 — dark-first; tune in code)
- `--bg` `#0C0D10` · `--surface` `#141519` · `--surface-2` `#1A1B20` (avoid pure black)
- `--border` `rgba(255,255,255,0.08)` · `--border-strong` `rgba(255,255,255,0.12)`
- `--text` `#E6E7EA` · `--text-secondary` `#9A9CA3` · `--text-muted` `#6B6E76`
- `--accent` `#5E6AD2` (Linear-ish indigo; confirm hue on real screens) · accent-hover slightly lighter · focus ring = accent at ~50%
- status: ready `#3FB68B` · importing `#D9A23B` · error `#E5614C` · processing = accent — all rendered as a small dot + label, low saturation
- type: Inter (UI/body), mono face for numerals; title 18–20/600/-0.02em, section 14/600, body 13–14, meta 12 muted; tabular/mono numbers
- radius 6–8px · 8px spacing grid · list rows ~36–40px

## How we'll validate
Screens are captured by loading the **Vite frontend** (`localhost:1420`) in a browser via the Preview/Chrome MCP (the Tauri dev window isn't resolvable by computer-use). A dev-only mock of the Tauri `invoke` layer (active only when no Tauri runtime is present) seeds realistic data so screens render populated. Review against this doc, iterate, re-screenshot before/after.
