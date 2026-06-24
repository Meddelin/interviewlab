# Feature spec: custom roles + guide library + synthesis artifacts (Milestone 10)

User-requested features layered on the MVP, updated per feedback. Implemented **after M9** (they change the schema and touch M2/M5/M8/M9 files). Needs migration `0002`.

## 1. Custom role library — flat list, no flag
**Today:** participant role is a fixed enum (interviewer/respondent/observer/other) in the editor (M5).
**New:** a user-managed **flat list of roles** (CRUD): `Interviewer`, `Фронт`, `Дизайнер`, `Продакт`, … Reusable across all cycles.

- **Role** = `{ id, name, color, sort }`. **No `is_interviewer` flag** (per feedback). Instead the list is **seeded with a default `Interviewer` role** (the conventional researcher role). Synthesis is given the role labels and treats the interviewer role's turns as questions/context (down-weights it); the user can rename or pick a different interviewer role if they want.
- `participant.role` (enum text) → `role_id` (FK). Migration `0002` seeds the default `Interviewer` role and maps existing rows.
- **Used in:** the editor speaker→role assignment (pick from the library, "+ Add role" inline). Synthesis can **segment findings by role** (what Дизайнеры said vs Продакты).
- Managed in **Settings → Roles**.

## 2. Interview-guide ("designs") library — global & reusable  ✅ confirmed
- A **global library** of guides authored in **markdown (.md)**, edited in **Plate** (fallback: textarea + live preview). Each cycle runs against a chosen guide.
- **Guide** = `{ id, name, content_md, goals (derived, stable goal_ids), created, updated }`.
- **Cycle** references `guide_id` (Overview: pick from the library or create one).
- Goals derived **per guide** → reusing a guide across waves keeps `goal_id`s stable → clean M9 diffs.
- Schema: new `guide` table; `cycle.guide_id` FK; migrate existing inline cycle `guide` text into guide rows. Managed in a **Guides / Designs** section.

## 3. Synthesis as editable artifacts — revised per feedback
Synthesis becomes **two levels**, both **user-editable**:

- **Per-interview synthesis (new, one per interview):** a concise summary of that interview **structured by the guide's goals** — per goal: key points + supporting quotes (with segment refs), plus notable quotes / surprises. Stored per interview, viewable on the interview, **editable**.
- **Cycle synthesis = one overall editable artifact:** a **markdown report structured by the guide** (sections = the guide's goals/sections), synthesized across all the per-interview syntheses:
  - Executive summary → per goal: finding(s) + confidence + evidence quotes (with interview refs) + recommendation → optional **by-role breakdown** (Дизайнеры vs Продакты).
  - **Editable** by the user in the same `.md` editor (Plate) — the user owns the final artifact.
  - Goals/sections stay structured (stable `goal_id`s) so M9's **findings-level diff** still compares wave-over-wave by goal.
- Pipeline: the per-interview synthesis (map) becomes a **stored, first-class artifact**; the cycle artifact (reduce) assembles them following the **guide structure** ("preserve the structure I want to get"). Reuses M8's runner/map-reduce plumbing; changes storage + UI. M10 must keep M9's diff working against the new format.

## What this changes in finished milestones
- **M2 Overview:** guide picker from the library (was an inline textarea).
- **M5 editor:** role picker from the library (was a fixed enum).
- **M8 synthesis:** reworked into per-interview artifacts + an editable cycle markdown artifact (was a single cycle findings-card JSON).
- **M9 diff:** adapt to diff the new per-goal synthesis format.
- **Schema `0002`:** `role` + `guide` tables; `participant.role_id`; `cycle.guide_id`; per-interview synthesis + cycle synthesis-artifact storage. dev-mock seeds roles + a guide + both synthesis levels.

## Proposed cycle-synthesis FORMAT (for your confirm)
Editable **markdown** structured by the guide's goals: **Executive summary → per goal (finding + confidence + evidence quotes w/ interview refs + recommendation) → optional by-role breakdown**, plus a short **per-interview summary** each. Confirm or tweak before I build M10.
