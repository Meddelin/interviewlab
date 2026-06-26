# Feature spec: templated interview guide + guide-grounded synthesis/diff

Agent-facing design record for the **templated guide** (layered on M10's guide library,
`feature-roles-and-guides.md`). Read this before touching `guides.rs`, `synthesis.rs`,
`diff.rs`, the guide UI, or the analysis prompts. Needs migration `0008`.

## 1. What changed, in one paragraph
A guide is no longer just free markdown. It gains a **structured template** of five fixed
blocks the user fills by clicking "+ add". The template is stored as JSON
(`guide.template_json`); the backend **renders a canonical `content_md` from it** on every
write, so everything that reads the guide as markdown (`derive_goals`, the chat context pack,
back-compat) keeps working unchanged. The synthesis and diff then answer the guide **strictly,
nothing skipped**: a verdict per hypothesis, a consolidated answer per question, plus the
existing goal findings. A shared **analysis system prompt** makes every LLM stage reason the
same way. Legacy free-markdown guides (`template_json = '{}'`) behave exactly as before — the
new sections simply don't appear.

## 2. The five fixed blocks (`GuideTemplate`)
Defined in `src-tauri/src/synthesis.rs` (alongside `Goal`/`derive_goals`, since the synthesis
is the consumer). Ids are **stamped server-side, positionally** (same template → same ids
across waves, exactly like `derive_goals`), so the diff can align hypotheses/findings
wave-over-wave.

| Block (RU label in UI)              | field                  | id prefix | role |
|-------------------------------------|------------------------|-----------|------|
| Гипотезы                            | `hypotheses`           | `H1`, `H2`… | hypotheses to validate → verdicts |
| Задачи интервью                     | `tasks`                | `G1`, `G2`… | research tasks = the synthesis **goals** (the stable spine the diff aligns on) |
| Квалифицирующие вопросы             | `qualifying_questions` | `Q…`      | screening questions |
| Основная часть вопросов             | `main_blocks[].questions` | `Q…`   | core questions grouped into **themed sub-blocks** (`main_blocks[].title`) |
| Вопросы по гипотезам                | `hypothesis_questions` | `Q…`      | questions aimed at the hypotheses |

**Question ids share ONE global `Q` counter** across qualifying → each main block in order →
hypothesis questions, in document order, so every question has a unique stable `Qn`.

Key methods (Rust `GuideTemplate`): `parse(json)`, `is_empty()`, `normalized()` (re-stamp ids +
drop blanks), `goals()` (= tasks, the synthesis spine), `questions()` (flattened with section
context). `render_template_md(&t)` renders the canonical markdown — **tasks go under a
`## Goals` heading with explicit `Gn:` tags so `derive_goals(content_md)` re-reads identical
ids**. The TS mirror of all this lives in `src/lib/tauri.ts` (`normalizeTemplate`,
`renderTemplateMd`, `templateGoals`, `templateQuestions`) and is shared by the structured
editor + the browser dev-mock.

## 3. Storage & write path
- Migration `0008_guide_template.sql`: `ALTER TABLE guide ADD COLUMN template_json TEXT NOT NULL DEFAULT '{}'`. No backfill — `'{}'` is the legacy shape.
- `guides.rs::resolve_guide_write(content_md, template)`: when a template is present it is the **source of truth** (content_md rendered from it, goals from its tasks); otherwise content_md is stored verbatim and goals derived from it. So a guide is EITHER structured OR free-markdown — never half-and-half.
- `parse_guide`: goals come from `template.goals()` when a template is present, else the cached `goals_json` / `derive_goals`.

## 4. Synthesis — answer the whole guide (`synthesis.rs`)
The pipeline now threads a `GuideTemplate` (via `effective_guide_template_db(cycle_id)`, empty
for legacy guides) through extract → reduce.

- **MAP (per-interview, `assemble_interview_summary`)**: for every question a
  `question_answers` entry with status `direct | indirect | not_answered` + summary + quotes;
  for every hypothesis a `hypothesis_signals` entry with stance
  `supports | contradicts | mixed | neutral` + note + quotes. Stored + rendered into the
  editable per-interview markdown ("Hypothesis signals" / "Question answers" sections).
- **REDUCE (cycle, `assemble_hypothesis_verdicts` / `assemble_question_answers`)**: ONE verdict
  per hypothesis (`confirmed | partially | refuted | inconclusive` + confidence + rationale +
  evidence) and ONE consolidated answer per question (`answered | partially | not_answered` +
  answer + evidence), in guide order, **never skipping one** (a missing/blank item falls back
  to `inconclusive` / `not_answered`). Plus the existing goal findings + by-role + open
  questions. All server-side validated (ids real, evidence refs clamped), rendered into the
  cycle markdown artifact ("Hypotheses" / "Questions" sections) and stored in `SynthesisDoc`.

`SynthesisDoc` / `InterviewSummaryDoc` gained `hypotheses`, `questions`,
`hypothesis_verdicts` / `hypothesis_signals`, `question_answers` — all `#[serde(default)]` so
older rows + legacy guides deserialize and render exactly as before.

## 5. Diff — hypothesis verdicts wave-over-wave (`diff.rs`)
Alongside the findings-level diff, `assemble_hypothesis_diff` aligns hypotheses by `id` and
classifies the verdict shift **deterministically** from the two syntheses' authoritative
verdicts (rank: refuted < inconclusive < partially < confirmed):
`strengthened | weakened | unchanged | new | dropped`. The diff model only supplies the per-id
`why` prose (it never sets the verdict labels). Stored in `DiffDoc.hypotheses`.

## 6. The shared analysis system prompt
`synthesis::analysis_system_prompt()` is the single source of truth for HOW the model reads an
interview against the guide:
1. **Answer the whole guide** — every hypothesis, task, and question; say "not answered" /
   "inconclusive" rather than dropping an item.
2. **Use the product description** as interpretive context (the product is filled separately,
   on the cycle/Products library).
3. **Indirect answers count** — credit a question whenever the transcript speaks to it even if
   never asked verbatim; mark direct / indirect / not answered.
4. **Hypotheses** get an evidence-grounded verdict; weigh contradicting evidence honestly.
5. **Evidence**: weight respondent over interviewer turns; quote verbatim in the original
   language; cite the `segment_id`.
6. **Be honest about gaps** — don't invent findings or overstate confidence.

It is injected as the top-level `system` field of every analysis task's input
(`cycle-synthesis-extract`, `cycle-synthesis-reduce`, `cycle-diff`) and into the chat context
pack (`chat.rs::build_context`, "Analysis principles" block), so the per-interview summary, the
cycle synthesis, the diff, and the chat all reason identically. **If you add a guide-grounded
LLM stage, inject this prompt too.**

## 7. UI
- **Guides page** (`pages/guides.tsx` + `components/guide-template-editor.tsx`): a structured
  editor with the five blocks + add buttons (and "add question block" for the main section),
  plus a **Raw markdown** tab for free-form guides. New guides start as an empty structured
  template. The "Derived goals" panel reads the template's tasks live.
- **Synthesis tab** (`synthesis-tab.tsx`): the Findings view shows hypothesis verdicts +
  per-question answers above the goal findings. The Artifact (markdown) view shows them
  inline (rendered into `content_md`).
- **Per-interview summary** (`interview-summary-panel.tsx`): the new sections appear via the
  rendered markdown — no separate structured view needed.
- **Diff tab** (`diff-tab.tsx`): a Hypotheses section with the verdict transition
  (prev → current) + shift badge + why.

## 8. Invariants to preserve when editing
- A template's rendered `content_md` MUST re-derive identical goal ids via `derive_goals`
  (tasks under `## Goals` with explicit `Gn:` tags) — the diff spine depends on it.
- The TS template helpers in `tauri.ts` must mirror the Rust ones (id stamping, render) — they
  back the editor preview + the dev-mock.
- New `SynthesisDoc` / `InterviewSummaryDoc` / `DiffDoc` fields stay `#[serde(default)]` /
  optional so older rows and legacy guides keep deserializing.
- Verdict labels are authoritative from the synthesis; the diff model only writes `why`.
