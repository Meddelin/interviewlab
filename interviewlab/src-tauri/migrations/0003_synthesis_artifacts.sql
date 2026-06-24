-- 0003_synthesis_artifacts.sql — M10b: synthesis as TWO user-editable levels.
--
-- M8/M10a stored ONE synthesis row per cycle (the structured cycle findings in
-- `findings_json`). M10b reworks synthesis into two first-class, editable artifacts that
-- both live in the SAME `synthesis` table, distinguished by whether `interview_id` is set:
--
--   * interview_id IS NULL  → the CYCLE synthesis (one per cycle, as before). It now ALSO
--     carries `content_md`: the human-editable markdown report (Executive summary → per
--     goal: finding + confidence + evidence + recommendation → optional by-role breakdown),
--     rendered/edited via the Plate `.md` editor. `findings_json` keeps the structured layer
--     (goals + goal_id-tagged findings) so M9's findings-level diff still works unchanged.
--
--   * interview_id IS SET   → a PER-INTERVIEW synthesis (the MAP stage, now stored + editable):
--     a concise summary structured by the guide's goals (per goal: key points + supporting
--     quotes with segment refs) + notable quotes/surprises. Stored in `findings_json` as the
--     structured layer; `content_md` may also hold an editable markdown rendering.
--
-- Minimal, additive design (ponytail: two columns on the existing table, no new tables, no
-- goals table — goals stay DERIVED from the guide as in M8):
--   * ADD COLUMN interview_id TEXT NULL REFERENCES interview(id) — NULL = cycle-level.
--   * ADD COLUMN content_md   TEXT NOT NULL DEFAULT '' — the editable markdown artifact.
-- SQLite ALTER TABLE ADD COLUMN can't add an inline FK that references another table with a
-- NULL default the way we'd like, but a nullable FK column added via ADD COLUMN IS allowed
-- (it adds the column + the reference). Existing cycle rows get interview_id NULL (cycle-
-- level) + content_md '' automatically, so M8/M10a data keeps working as cycle synthesis.
--
-- Uniqueness: a cycle has at most ONE cycle-level synthesis and at most ONE per-interview
-- synthesis per interview. We enforce that with partial unique indexes (the store helpers
-- also upsert defensively).

ALTER TABLE synthesis ADD COLUMN interview_id TEXT REFERENCES interview(id) ON DELETE CASCADE;

ALTER TABLE synthesis ADD COLUMN content_md TEXT NOT NULL DEFAULT '';

-- At most one CYCLE-level synthesis row per cycle (interview_id IS NULL).
CREATE UNIQUE INDEX idx_synthesis_cycle_level
  ON synthesis (cycle_id)
  WHERE interview_id IS NULL;

-- At most one PER-INTERVIEW synthesis row per interview.
CREATE UNIQUE INDEX idx_synthesis_per_interview
  ON synthesis (interview_id)
  WHERE interview_id IS NOT NULL;
