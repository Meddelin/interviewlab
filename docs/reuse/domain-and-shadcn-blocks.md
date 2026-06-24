# InterviewLab — Open-Source Reuse Landscape & Competitive Review

**Date:** 2026-06-22
**Author:** Reuse/competitive research pass
**Product:** "InterviewLab" — a **Tauri 2 desktop** app, UI **exclusively shadcn/ui** (React + Tailwind), single-user local MVP for user-research teams. Workflow: organize interviews into research **cycles** → transcribe locally → edit transcripts + tag speaker roles → AI **synthesis** of findings tied to interview-guide goals → **findings-level diff** vs the previous cycle.

**Goal of this doc:** Avoid building from scratch. (A) Survey qualitative-research / interview-analysis OSS to **borrow proven UX** and confirm we're not reinventing something reusable. (B) Map the **shadcn block/registry ecosystem** to our screens so we assemble UI fast.

**Lens:** lazy-senior-dev — prefer **copy-paste shadcn registries** over new npm deps; **borrow research-tool UX** rather than invent novel interaction models.

> **TL;DR headline.** There is **no maintained open-source "AI Dovetail"** you can fork in 2026 — the AI-synthesis space is all commercial; OSS is either mature *manual* CAQDAS (Python/PyQt/R, reference-only) or tiny AI-coding research repos. So **Part A = REFERENCE only**, no code reuse. **Part B = lots of reuse**: build on shadcn/ui official (MIT) and fill the three gaps it lacks — **kanban, dropzone, timeline/diff** — from **DiceUI** and **Kibo UI** (both MIT shadcn registries). The only license landmine in the whole review is **Origin UI's 2026 migration to Cal.com's AGPL-3.0** design system — check the header on anything copied from there.

---

# Part A — Domain OSS & Competitors (qualitative research / interview analysis)

*Verdicts:* **REUSE** = drop code in · **REFERENCE** = study UX/method, reimplement in our stack · **SKIP** = nothing usable.
*Stars/maintenance verified via GitHub on 2026-06-22.*

| Name | Stars (2026) | License | Stack | What to borrow | Verdict |
|---|---|---|---|---|---|
| **Taguette** | ~84 (GitHub mirror; canonical on GitLab) | **BSD-3-Clause** ✅ | Python (Tornado) + server-rendered JS | 3-pane code-and-retrieve; "Highlights" tab grouping quotes under a tag; REFI-QDA export | **REFERENCE** |
| **QualCoder** | ~632 | ⚠️ **LGPL-3.0** | Python 3.12 + PyQt6 (desktop) | Hierarchical codebook tree; memo-on-segment; **transparent/editable AI prompts**; project-memo injected into every prompt; coder-comparison + co-occurrence views | **REFERENCE** |
| **Label Studio** | ~27.7k | **Apache-2.0** ✅ (editor lib too — *verified, no Commons Clause*) | React + TypeScript + mobx-state-tree | Highlight-to-tag region model; config-driven labeling UI; **ML pre-labeling / active-learning loop** | **REFERENCE** |
| **Doccano** | ~10.7k | **MIT** ✅ | Vue/Nuxt + Django | Keyboard-driven span tagging; uncluttered text-annotation reading layout | **REFERENCE** |
| **LLMCode** | ~77 | **MIT** ✅ | Python / notebooks | **Chunk-by-chunk LLM coding** + codebook induction prompt methodology | **REFERENCE** (method, not UI) |
| **RQDA** | ~41 | NOASSERTION (unclear) | R + RGtk2 (GTK) | Classic codebook + code-and-retrieve (concept only) | **SKIP** (archived; toolchain dead since ~2020) |
| **qcoder** (`ropenscilabs/qcoder`) | (pre-release) | MIT-ish (rOpenSci) | R + Shiny | Minimal data model ("don't over-engineer the schema") | **SKIP** (never shipped; abandoned) |
| **Annotald** | ~8 | ⚠️ **GPL-3.0** | Python (Penn Treebank trees) | Keyboard-driven tree-node editing (niche) | **SKIP** (wrong domain — syntax trees; stale 2023) |
| **friedrichgeiecke/interviews** | ~72 | ⚠️ NOASSERTION ("Other") | Python | AI-led interview + transcript-analysis prompt pipeline | **SKIP** (unclear license; research code) |
| **Gamma-Software/llm_qualitative_data_analysis** | ~49 | ⚠️ **No license** | Python + Streamlit + LangChain | transcript→codes→themes pipeline shape | **SKIP** (no license = not reusable) |
| **sjdai/LLM-thematic-analysis** | ~11 | None stated | Jupyter | "LLM-in-the-loop" TA codebook method (EMNLP 2023) | **SKIP** (abandoned 2023; paper code) |

### Per-tool notes

**Taguette — REFERENCE (cleanest UX analog).** Free/OSS QDA: import docs, highlight spans, tag with codes. **Actively maintained** (last push 2026-02-05). **BSD-3-Clause** — the only zero-copyleft tool in the active set. Python/Tornado, server-rendered — **not React**, nothing to lift as code. Borrow: (1) the **three-pane code-and-retrieve** layout (Project Info / Documents / Highlights); (2) the **"Highlights" tab that groups every quote under a clicked tag** — this *is* your "evidence quotes tied to a finding" pattern; (3) standards-based **REFI-QDA (.qdc/.qdpx)** export. Repo: https://github.com/remram44/taguette · https://gitlab.com/remram44/taguette · https://www.taguette.org

**QualCoder — REFERENCE (richest features + AI blueprint).** Most feature-complete CAQDAS here; **very actively maintained** (pushed 2026-06-22). ⚠️ **LGPL-3.0** (the brief guessed GPL — it's the *Lesser* variant; still copyleft) and **PyQt6**, so **no clean reuse path** in a permissive Tauri app. Borrow heavily for the **synthesis side**: (1) **hierarchical code tree** (codes nest into categories → your codebook hierarchy); (2) **memo-on-segment**; (3) **transparent, user-editable AI prompts** — users see/modify the prompt, choose models, BYO key (a strong "AI synthesis you can trust" pattern); (4) **project memo (topic/questions/objectives) auto-injected into every AI prompt** — maps directly to your *interview-guide-goal-grounded synthesis*; (5) **code co-occurrence / matrix views** (real affinity-mapping). Repo: https://github.com/ccbogel/QualCoder · AI wiki: https://github.com/ccbogel/QualCoder/wiki/4.2.-AI-Assisted-Coding

**Label Studio — REFERENCE (annotation gold standard; license verified clean).** Multi-type data-labeling tool, config-driven UI. **~27.7k stars, very active** (pushed 2026-06-22). **License check (the brief's concern): the labeling editor at `web/libs/editor` has its own LICENSE file, but it is plain unmodified Apache-2.0 — no Commons Clause, no commercial restriction.** Verified: https://raw.githubusercontent.com/HumanSignal/label-studio/develop/web/libs/editor/LICENSE — the Community/Enterprise split is feature-gating of a *separate proprietary SaaS*, not a license on the OSS repo (https://labelstud.io/guide/label_studio_compare). **Stack: React + TS + mobx-state-tree.** Borrow: highlight-to-tag region/results model, config-driven labeling, and especially the **ML-assisted pre-labeling / active-learning ("ML backend") loop** — the single most relevant pattern for your AI-synthesis step. **Reuse caveat:** components are deeply coupled to `mobx-state-tree`, which fights a lean shadcn build — reference, don't lift. Repo: https://github.com/HumanSignal/label-studio

**Doccano — REFERENCE (fast tagging UX, cleanest license).** OSS text-annotation tool (NER, classification, seq2seq). **~10.7k stars, active** (pushed 2026-04-14). **MIT** — ideal license, but **Vue/Nuxt + Django**, so no React component lift. Borrow: **keyboard-driven span tagging** and the deliberately uncluttered reading layout — directly relevant to "edit transcripts + tag speaker roles / highlight-to-tag." Repo: https://github.com/doccano/doccano

**LLMCode — REFERENCE (method, not UI).** Academic toolkit for AI-assisted qualitative coding that processes data **chunk-by-chunk** to generate codes/codebooks. **~77 stars, MIT, lightly maintained** (pushed 2025-01). Borrow the **prompting methodology** — chunked passes + codebook induction — to structure InterviewLab's "synthesis tied to interview-guide goals" rather than one-shotting a transcript. Repo: https://github.com/PerttuHamalainen/LLMCode

**SKIPs.** **RQDA** — archived on GitHub, removed from CRAN ~2020, GUI dep (RGtk2) orphaned; dead toolchain (https://github.com/Ronggui/RQDA). **qcoder** — rOpenSci experimental, self-described "not ready for release," stalled (https://github.com/ropenscilabs/qcoder). **Annotald** — linguistic *syntax-tree* annotator (Penn Treebank), wrong domain, GPL-3.0, stale since 2023 (https://github.com/annotald/annotald). **friedrichgeiecke/interviews** — NOASSERTION license, research code; mine analysis prompts only (https://github.com/friedrichgeiecke/interviews). **Gamma-Software/llm_qualitative_data_analysis** — **no LICENSE file**, legally not reusable (https://github.com/Gamma-Software/llm_qualitative_data_analysis). **sjdai/LLM-thematic-analysis** — abandoned 2023 paper code (https://github.com/sjdai/LLM-thematic-analysis).

### UX patterns worth stealing (cross-cutting)

- **Coding / tagging.** Highlight-to-tag span model with **keyboard-driven** tagging (Doccano, Label Studio). Margin **coding stripes** next to coded text (QualCoder). A **hierarchical codebook tree** — codes nest into categories — so speaker-role + theme tags stay organized (QualCoder, Taguette).
- **Evidence linking.** A dedicated **"Highlights / evidence" view that groups every verbatim quote under its tag/finding** (Taguette's Highlights tab) — this is exactly the "findings tied to evidence quotes" requirement; clicking a finding should retrieve its supporting quotes.
- **Theme synthesis.** **Codebook → coded segment → cross-segment theme** is the universal QDA mental model (QualCoder) and maps 1:1 to your AI synthesis. Make the **AI prompt transparent and editable**, and **inject the interview-guide goals (project memo) into every synthesis prompt** (QualCoder). Drive the LLM **chunk-by-chunk with codebook induction** (LLMCode), not one giant prompt. Use **ML pre-labeling / active-learning** framing so AI proposes, human confirms (Label Studio).
- **Cross-cycle comparison (your novel bit).** No OSS does cycle-over-cycle findings diff — closest analogs are **code co-occurrence / matrix views** (QualCoder) for "what themes appear together." The diff itself you build (see Part B timeline/diff). Borrowing the **codebook as the stable spine** across cycles is the key idea: diff *findings keyed to the same guide goals/codes*, not raw text.
- **Interop (low-effort win).** **REFI-QDA (.qdc/.qdpx)** is the de-facto interchange standard both active tools support (Taguette, QualCoder). Supporting import/export gives interop with NVivo/ATLAS.ti/MAXQDA for little effort.

**Bottom line, Part A:** Treat the whole domain landscape as **REFERENCE**. There is **zero front-end code to reuse** (all Python/PyQt/R, or React-but-mobx-coupled). Your local-first, cycle-diffing, guide-tied-synthesis combination has **no maintained OSS competitor** — good for differentiation, no shortcut available.

---

# Part B — shadcn Ecosystem (blocks/registries to assemble our UI fast)

*Type:* **registry** = copy-paste via `npx shadcn add …` (CLI writes the code into your repo) · **dep** = npm package · *Several "deps" below are **pre-blessed** because shadcn's own components officially wrap them.*
*All items MIT unless flagged. Verified 2026-06-22.*

| Source | License | Type | Best for which screen | Verdict |
|---|---|---|---|---|
| **shadcn/ui official blocks** | **MIT** | registry (copy-paste) | Sidebar/app-shell, dashboard, login, DataTable recipe, command palette, resizable, charts | **REUSE** (foundation) |
| **DiceUI** (sadmann7) | **MIT** | shadcn registry (`shadcn add @diceui/…`) | **DataTable (advanced)**, **kanban (cycle view)**, **file-upload** — one vendor, three screens | **REUSE** (best single bet) |
| **Kibo UI** (Hayden Bleasel) | **MIT** | shadcn registry (`kibo-ui add …`) | **kanban**, **dropzone**, Gantt (timeline), table, code-block | **REUSE** (selective) |
| **TanStack Table** | **MIT** | npm dep (shadcn officially wraps) | DataTable (interview list) — engine | **REUSE** (sanctioned) |
| **shadcn data-table recipe** | **MIT** | copy-paste recipe | DataTable (interview list) | **REUSE** (canonical path) |
| **sadmann7/shadcn-table (tablecn)** | **MIT** | reference app | DataTable patterns | **REFERENCE** (heavy demo; don't import its DB/multiplayer stack) |
| **react-dropzone** | **MIT** | npm dep | file-upload primitive | **REUSE** (transitive, via Kibo/DiceUI) |
| **cmdk** (pacocoursey) | **MIT** | npm dep (shadcn `Command` wraps) | command palette | **REUSE** (sanctioned) |
| **react-resizable-panels** (bvaughn) | **MIT** | npm dep (shadcn `Resizable` wraps) | transcript editor layout | **REUSE** (sanctioned) |
| **Tremor "Raw"** (Vercel-owned) | **MIT** | copy-paste, plain Tailwind | dashboard / charts | **REUSE** (or just use shadcn Charts) |
| **Tremor legacy `@tremor/react`** | Apache-2.0 | npm dep, custom tokens | dashboard / charts | **SKIP** (frozen mid-2025; custom color tokens) |
| **dnd-kit** (`@dnd-kit/core` v6) | **MIT** | npm dep (wrapped by kanbans) | kanban engine | **REUSE** transitively (v6 stable; avoid experimental `@dnd-kit/react` 0.x) |
| **Origin UI timeline** | **MIT** | registry/copy-paste | findings timeline | **REUSE** (no runtime dep) — *but see AGPL flag below* |
| **@git-diff-view/react** | **MIT** | npm dep | cross-cycle findings diff | **REUSE** (most maintained; note 0.x) |
| **react-diff-viewer-continued** | **MIT** | npm dep | findings diff | **REFERENCE** (conservative fallback; 1 maintainer) |
| **shadcn-extension** | **MIT** | copy-paste (own CLI) | file upload, tree, carousel, multi-select | **REFERENCE** (stale since Jan 2025; cherry-pick) |
| **Origin UI** (form inputs/dropzone) | ⚠️ **Mixed: legacy MIT / new coss AGPL-3.0** | manual copy (registry endpoint dead) | dropzone, rich form inputs, date pickers | **REFERENCE** (cherry-pick MIT files only) |
| **Aceternity UI** | Free MIT / **Pro paid proprietary** ⚠️ | registry + copy-paste | marketing/onboarding hero only | **SKIP** for app (REFERENCE for splash) |
| **Magic UI** | Free MIT / **Pro paid commercial** ⚠️ | registry + copy-paste | marketing/onboarding splash only | **SKIP** for app (REFERENCE for splash) |
| **Vercel AI Elements** | **MIT** | shadcn registry | AI chat/input UI (synthesis assistant) | **REUSE** (if you add chat UI) |

### Screen → "pull these" shortlist

| InterviewLab screen | Pull this | How |
|---|---|---|
| **Interview list (DataTable)** | shadcn data-table recipe + **TanStack Table**; advanced filtering from **DiceUI data-table** | `npx shadcn add table` + `npm add @tanstack/react-table`; `npx shadcn add @diceui/data-table` |
| **File upload / dropzone** (import audio/transcripts) | **Kibo UI dropzone** (or **DiceUI file-upload**) | `npx kibo-ui add dropzone` — wraps react-dropzone; official shadcn has none |
| **Command palette** | shadcn **Command** + **CommandDialog** (wraps cmdk) | `npx shadcn add command` |
| **Resizable panels** (transcript editor: sidebar + editor + detail) | shadcn **Resizable** (wraps react-resizable-panels) | `npx shadcn add resizable` |
| **Kanban / board (cycle view)** | **DiceUI kanban** (or **Kibo UI kanban**) — both wrap dnd-kit | `npx shadcn add @diceui/kanban` / `npx kibo-ui add kanban` |
| **Timeline** (cycle history) | **Origin UI timeline** (MIT file) or Kibo **Gantt** | copy-paste |
| **Diff view** (cross-cycle findings diff) | **@git-diff-view/react** (theme to shadcn tokens) | `npm add @git-diff-view/react` |
| **Dashboard / charts** | shadcn **Charts** (Recharts) and dashboard blocks; Tremor Raw optional | `npx shadcn add chart` / `dashboard-01` |
| **Sidebar / app shell** | shadcn **Sidebar** blocks (`sidebar-01…16`) | `npx shadcn add sidebar-07` (etc.) |
| **AI synthesis assistant UI** | **Vercel AI Elements** | `npx shadcn add` from ai-sdk.dev/elements registry |

### Per-source notes

**shadcn/ui official blocks — REUSE (the foundation).** Canonical MIT copy-paste registry, ~117k stars, very active (CLI `shadcn@4.x` June 2026; Base UI variants added Feb 2026). Provides DataTable recipe, command palette, resizable, sidebar (16 variants), dashboard, login, charts. **Does NOT have** file-upload/dropzone, kanban, or timeline/diff — source those below. https://ui.shadcn.com/blocks · https://github.com/shadcn-ui/ui *(Note: third-party "blocks" sites like shadcnblocks.com / blocks.so are separate and some charge — the official site is free MIT.)*

**DiceUI — REUSE (best single bet).** MIT shadcn-CLI registry by sadmann7. **~2.0k stars, actively developed** (latest release Nov 2025). One vendor covers **three of our screens**: advanced **data-table** (filtering/sorting), **kanban** (wraps dnd-kit), and **file-upload** — consolidate here to minimize sources. https://www.diceui.com · https://github.com/sadmann7/diceui

**Kibo UI — REUSE (selective).** MIT shadcn registry, ~3.8k stars, active (commits through May 2026). Direct fits: **kanban** (`npx kibo-ui add kanban`, dnd-kit-powered), **dropzone** (`kibo-ui add dropzone`, "Powered by react-dropzone"), **Gantt** (timeline). Lands in `components/kibo-ui/`; registry JSON auto-installs deps. Note: Kibo's old **AI components migrated out** to Vercel **AI Elements** (https://ai-sdk.dev/elements) — use that for AI chat UI. https://www.kibo-ui.com · https://github.com/haydenbleasel/kibo

**Pre-blessed npm deps (shadcn wraps them — use without hesitation).** **TanStack Table** (MIT, ~28k stars; the official data-table recipe says "built using TanStack Table", https://ui.shadcn.com/docs/components/data-table). **cmdk** (MIT, ~12.7k stars; shadcn `<Command/>` wraps it, https://ui.shadcn.com/docs/components/command). **react-resizable-panels** (MIT, 5.3k stars, v4.9.0 Apr 2026 by ex-React-core bvaughn; shadcn `Resizable` wraps it, https://ui.shadcn.com/docs/components/resizable). **react-dropzone** (MIT, ~11k stars, v15 Feb 2026 — *active*, a Snyk "discontinued" snapshot is stale). **dnd-kit** `@dnd-kit/core` v6 (MIT, 17.3k stars; v6 is frozen-but-ubiquitous at 18M+ dl/wk — **avoid the experimental `@dnd-kit/react` 0.x rewrite**).

**Charts/dashboard — REUSE shadcn Charts; Tremor optional.** Big "verify current state" finding: **Vercel acquired Tremor (Jan 2025)**, freeing the 300+ Blocks under MIT (https://vercel.com/blog/vercel-acquires-tremor). Two Tremors now exist — use **new "Tremor Raw"** (copy-paste, plain Tailwind, MIT, active) and **avoid legacy `@tremor/react`** (Apache-2.0 npm dep with custom color tokens, frozen mid-2025). For our needs, shadcn's own **Charts** (Recharts, copy-paste) likely suffices — don't duplicate. https://tremor.so · https://github.com/tremorlabs/tremor

**Timeline / diff — REUSE.** No official shadcn timeline. **Origin UI timeline** (MIT, no runtime dep) is the pick (but mind the Origin UI AGPL flag below). Fallback timDeHof/shadcn-timeline (MIT, pulls Framer Motion). For the **findings diff**, **@git-diff-view/react** (MIT, ~714 stars, v0.1.5 May 2026 — most maintained, GitHub-style, multi-framework; 0.x = possible breaking changes) over **react-diff-viewer-continued** (MIT, single maintainer). Both need manual theming to shadcn tokens. https://github.com/MrWangJustToDo/git-diff-view

**REFERENCE / cherry-pick.** **shadcn-extension** (MIT, ~1.3k stars, **stale** — last release Jan 2025; ships its own `@shadx` CLI; copy components by hand, expect minor fixups). https://github.com/BelkacemYerfa/shadcn-extension

### ⚠️ License red flags

- **Origin UI → AGPL-3.0 (the one real landmine).** In 2026 Origin UI was acquired into **Cal.com's design system**; `originui.com` now 301-redirects to **coss.com/ui**, and the repo `origin-space/originui` → **cosscom/coss**. **Legacy Origin UI components (`apps/origin/`) remain MIT** (safe), but the **new coss "Particles" line is AGPL-3.0** (strong copyleft + network clause — do **not** copy into a proprietary/SaaS app). The old `/r/*.json` registry endpoints are **dead** (manual copy only). **Action: verify the LICENSE header on any file you copy from Origin UI / coss; prefer Kibo/DiceUI to sidestep this entirely.**
- **Aceternity UI Pro / Magic UI Pro — paid proprietary tiers.** Free components are MIT, but **Pro** bundles (~$169–199 lifetime) are **proprietary with redistribution/resell prohibited**. Both are landing-page animation libraries with **no data/app components** (no DataTable, kanban, command palette, etc.). **SKIP for the app**; keep only as reference for a marketing/onboarding splash. https://ui.aceternity.com · https://magicui.design
- **Tremor legacy `@tremor/react`** is Apache-2.0 (permissive, fine) but **frozen** with **custom color tokens** that clash with shadcn theming — a maintenance flag, not a legal one. Use Tremor Raw instead.
- Everything else recommended is **MIT** — no GPL/AGPL/commercial blockers on any *recommended* item.

**Bottom line, Part B:** Stand the app on **shadcn/ui official (MIT)** and fill its three gaps — **kanban, dropzone, timeline/diff** — from **DiceUI** + **Kibo UI** (MIT registries, copy-paste, no lock-in beyond the deps each component already needs). The npm deps you do take (TanStack Table, cmdk, react-resizable-panels, react-dropzone, dnd-kit) are all **MIT and already wrapped by shadcn**. Only watch the **Origin UI AGPL migration**.

---

## Honesty caveats

- Star counts and a few weekly-download figures are point-in-time approximations (npmjs.com and originui.com returned 403s to automated fetches); **all licenses, versions, release dates, archived/active status, and the load-bearing facts were verified directly against GitHub repos and shadcn docs on 2026-06-22.**
- Brief said "QualCoder GPL" — it's actually **LGPL-3.0** (still copyleft, still no reuse). Brief flagged a Label Studio license trap — **verified false alarm**: the editor lib is plain Apache-2.0.
