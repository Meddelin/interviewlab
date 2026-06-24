# Reuse Landscape: Editors, Transcript UI & Waveform Players

**For:** InterviewLab — Tauri 2 desktop app, UI exclusively from shadcn/ui (React + Tailwind), local faster-whisper (CUDA) transcription, AI text via local Claude Code CLI. Russian-first content.

**Date:** 2026-06-22. All stars / versions / dates verified on GitHub at time of writing.

**License lens (this is a *distributed desktop app*):** MIT / Apache-2.0 / BSD / MPL-2.0 = green. **LGPL = caution** (dynamic-link / replaceability obligations are awkward to honor inside a bundled Tauri binary). **GPL / AGPL = red** (copyleft would infect our app — avoid as a dependency; reference only).

**Lazy-senior-dev bias:** maximize "80% out of the box, permissive license, least integration risk." We do NOT want to build an editor framework; we want to glue together copy-paste-able components.

---

## 1. Rich-text / Markdown editor (for AI synthesis/diff docs — needs polished Notion/Obsidian feel)

| Name | Stars | Maintained | License | Stack fit | Verdict |
|---|---|---|---|---|---|
| **Plate** (udecode/plate) | 16.4k | Active (v53.2.2, Jun 2026) | **MIT** | Excellent — built *on* shadcn/ui, ships a shadcn CLI registry | **REUSE** |
| **shadcn-editor** (htmujahid) | 1.3k | Active (May 2026) | MIT | Excellent — Lexical + shadcn, `npx shadcn add @shadcn-editor/editor-x` | **REUSE (runner-up)** |
| **BlockNote** (TypeCellOS) | 9.9k | Active (v0.51.4, Jun 2026) | **MPL-2.0** core / **GPL-3.0 "XL" pkgs** | Good (own UI, not shadcn) | REFERENCE / SKIP-XL |
| **Tiptap** (ueberdosis) | 37.3k | Very active (v3.27, Jun 2026) | MIT | Good (headless; you build all UI) | REFERENCE |
| **Lexical** (facebook) | 23.6k | Active (v0.45, May 2026) | MIT | Good (headless framework) | REFERENCE (via shadcn-editor) |
| **Milkdown + Crepe** | 11.6k | Active (v7.21, Jun 2026) | MIT | Mediocre — Crepe not designed for React re-render lifecycle | REFERENCE |
| **MDXEditor** (mdx-editor/editor) | 3.5k | Active (v4.0.4, Jun 2026) | MIT | OK — best *out-of-the-box* MD WYSIWYG, own UI (not shadcn) | REFERENCE / fallback |
| **Novel** (steven-tey) | 16.3k | **Stale** (last release v1.0.2, Feb 2025) | Apache-2.0 | OK (Tiptap+shadcn Notion clone) but aging | REFERENCE |
| **CodeMirror 6** | ~7.8k (GH archived, dev moved to self-host) | Active elsewhere (`@codemirror/view` v6.43, Jun 2026) | MIT | Good for *raw-markdown source* mode | REUSE (secondary) |
| **ProseMirror** | — | Active | MIT | Low-level toolkit (Tiptap/Milkdown/BlockNote all sit on it) | SKIP (too low-level) |
| **react-markdown / MDX** | — | Active | MIT | Render-only viewer, not an editor | REUSE (for read-only diff render) |

### Recommended pick — Editor: **Plate** (udecode/plate)
- **Why:** It is literally "rich-text editor with AI **and shadcn/ui**." It distributes via the **shadcn CLI registry**, so components are copied into our repo as shadcn-styled code we own — perfect for our "UI exclusively from shadcn/ui" constraint. MIT, 16.4k stars, releasing constantly (v53 in Jun 2026). Has markdown serialization plugins and AI/diff-friendly building blocks. Gets us the Notion-grade feel with the least bespoke UI work.
- **Runner-up:** **shadcn-editor** (htmujahid, Lexical-based, MIT, 1.3k★) — lighter, also a shadcn registry install. Pick this if Plate feels too large; it's a thinner Lexical+shadcn wrapper.
- **Out-of-the-box fallback:** **MDXEditor** (MIT) if we want a drop-in MD WYSIWYG with zero assembly and accept its own (non-shadcn) chrome.
- **For raw-markdown source view / code blocks inside the editor:** **CodeMirror 6** (MIT) — note its GitHub mirror is archived (moved to a self-hosted Forgejo), but the npm packages (`@codemirror/*`) are MIT and shipping monthly; this is normal, not abandonment.

> Red-flag note: **BlockNote's "XL" packages are GPL-3.0.** The MPL-2.0 core is fine, but do **not** pull any `@blocknote/xl-*` package into a distributed binary. Easiest to just avoid BlockNote to sidestep the footgun.

---

## 2. Transcript editor (segment list + audio sync) — the highest-value reuse, and the biggest gap

| Name | Stars | Maintained | License | Stack fit | Verdict |
|---|---|---|---|---|---|
| **BBC react-transcript-editor** | 619 | **Stale** (last release Jun 2021, "work in progress") | **MIT** | React, but old React/Draft.js era; not shadcn | **REFERENCE** |
| **hyperaudio-lite** (hyperaudio) | 168 | **Active** (v2.4.2, May 2026) | **MIT** | Vanilla JS, zero-dep player+transcript; not React | **REFERENCE (best UX model)** |
| **NYPL transcript-editor** (nypublicradio) | ~4 | Stale | MIT | Ruby on Rails + Ember + Postgres — whole-app, not a component | REFERENCE |
| **oTranscribe** (MuckRock) | 1.2k | Semi-stale (no releases, MIT) | MIT | Vanilla JS manual-transcription tool | REFERENCE |
| **Subtitle Edit** | (large) | Very active (v4.0.15, 2026) | **GPL-3.0** | C#/.NET WinForms desktop app | REFERENCE only (copyleft + not embeddable) |
| **Aegisub** | (large) | Effectively dead (no real updates since ~2014) | BSD-style files / GPL binaries | C++/wxWidgets desktop | SKIP |
| Reduct/Descript-style OSS | — | — | — | No credible maintained OSS equivalent found | SKIP |

### Recommended pick — Transcript editor: **build it ourselves, modeling UX on hyperaudio-lite**
- **Reality:** There is **no maintained, modern React, permissively-licensed, drop-in transcript-editor component** in 2026. The purpose-built ones are either stale (BBC, 2021), whole-apps in other stacks (NYPL = Rails/Ember), or not React (hyperaudio-lite = vanilla).
- **Best reference:** **hyperaudio-lite** (MIT, actively maintained May 2026, ~10KB, zero deps). Its interaction model — click a word/segment to seek, highlight the active segment as audio plays — is exactly what we need. Borrow the *logic* (timecode→DOM mapping, active-segment tracking), reimplement the view as a shadcn list. Do **not** vendor its vanilla-JS DOM code into React.
- **Secondary reference:** **BBC react-transcript-editor** (MIT) for the React data-model shape (`transcriptData` segments + `mediaUrl`) and the inline-edit + speaker-label UX. It's Draft.js-era and stale, so harvest patterns, don't depend.
- **Verdict:** This is the component we own. It's also our differentiator (segment list synced to playback + inline edit + manual speaker→role tagging is a thin, well-scoped build on top of a waveform player + a virtualized shadcn list).

---

## 3. Audio player with waveform + time-sync

| Name | Stars | Maintained | License | Stack fit | Verdict |
|---|---|---|---|---|---|
| **wavesurfer.js** (katspaugh) | 10.3k | Very active (v7.12.8, Jun 2026) | **BSD-3-Clause** | Excellent — TS-native, official **`@wavesurfer/react`** wrapper + Regions/Timeline plugins | **REUSE** |
| **peaks.js** (bbc) | 3.4k | Slowing (v3.4.2, Aug 2024; dev moved to Codeberg) | **LGPL-3.0** | OK but copyleft + heavier (needs pre-computed waveform data) | **SKIP (license)** |
| HTML5 `<audio>` + custom canvas | — | n/a | n/a | Always available fallback | reference |

### Recommended pick — Waveform: **wavesurfer.js** (+ `@wavesurfer/react`)
- **Why:** BSD-3-Clause (fully green for a distributed app), 10.3k★, shipping monthly (v7.12.8 Jun 2026), TypeScript-native. There's an **official React wrapper `@wavesurfer/react`** (hook + component, wavesurfer options become props) — minimal glue. The **Regions** and **Timeline** plugins give us per-segment highlight regions and a clickable timeline, which is exactly the audio-sync primitive the transcript editor needs. Decodes audio client-side, no server step.
  - One gotcha to remember: memoize the `plugins` array (`useMemo`) — wavesurfer mutates plugin instances on init.
- **Runner-up:** **peaks.js** (BBC) — purpose-built for *long-form* speech with pre-computed waveform data (scales to multi-hour files better). **But LGPL-3.0** is a real constraint for a bundled binary, and primary dev has moved off GitHub. Only revisit if multi-hour-file waveform performance becomes a problem; otherwise wavesurfer wins on license + React fit.

---

## What to build ourselves anyway (gaps no OSS covers cleanly)

1. **The transcript editor component itself** — see §2. No maintained React drop-in exists. We own: segment list (virtualized shadcn list), active-segment-follows-playback, click-to-seek, inline text edit, **manual speaker→role tagging** (none of the OSS tools do role tagging the way we want). Wire it to wavesurfer for the audio half.
2. **faster-whisper segment → UI binding** — the segment/word-timestamp JSON from faster-whisper (CUDA) is our own shape; the import/normalize layer feeding both the transcript list and the wavesurfer Regions is bespoke (small).
3. **AI synthesis/diff document UX** — Plate gives us the editor surface, but the *diff visualization* of AI-generated synthesis vs. source (and applying/accepting edits from the Claude Code CLI) is product-specific glue we build.
4. **Russian-first polish** — Cyrillic word-boundary handling for word-level seek, and RU UI strings. None of the OSS assumes this; verify any tokenization assumptions.
5. **Tauri integration** — local file ingest, audio decode for large files, and IPC to the faster-whisper / Claude Code CLI processes are ours regardless of UI library.

---

## TL;DR picks
- **Editor:** **Plate** (MIT, shadcn registry) — runner-up **shadcn-editor**; **MDXEditor** as zero-assembly fallback.
- **Transcript editor:** **Build it** — model UX on **hyperaudio-lite** (MIT), borrow data-model from **BBC react-transcript-editor** (MIT). No maintained drop-in exists.
- **Waveform:** **wavesurfer.js + @wavesurfer/react** (BSD-3) — avoid **peaks.js** (LGPL-3.0).
- **License red flags:** BlockNote `xl-*` packages = **GPL-3.0**; peaks.js = **LGPL-3.0**; Subtitle Edit = **GPL-3.0** (reference only anyway).

### Sources
- Plate: https://github.com/udecode/plate · shadcn-editor: https://github.com/htmujahid/shadcn-editor
- BlockNote: https://github.com/TypeCellOS/BlockNote · Tiptap: https://github.com/ueberdosis/tiptap · Lexical: https://github.com/facebook/lexical
- Milkdown/Crepe: https://github.com/Milkdown/milkdown · MDXEditor: https://github.com/mdx-editor/editor · Novel: https://github.com/steven-tey/novel · CodeMirror: https://github.com/codemirror
- BBC react-transcript-editor: https://github.com/bbc/react-transcript-editor · hyperaudio-lite: https://github.com/hyperaudio/hyperaudio-lite · NYPL: https://github.com/nypublicradio/transcript-editor · oTranscribe: https://github.com/oTranscribe/oTranscribe
- wavesurfer.js: https://github.com/katspaugh/wavesurfer.js · @wavesurfer/react: https://www.npmjs.com/package/@wavesurfer/react · peaks.js: https://github.com/bbc/peaks.js
- Subtitle Edit: https://github.com/SubtitleEdit/subtitleedit · Aegisub: https://github.com/TypesettingTools/Aegisub
