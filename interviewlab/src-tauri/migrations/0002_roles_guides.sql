-- 0002_roles_guides.sql — M10a: custom role library + reusable interview-guide library.
--
-- Adds two new tables (role, guide), links participant→role and cycle→guide, and
-- data-migrates the existing fixed-enum participant roles + inline cycle guide text into
-- the new library rows so existing data maps cleanly and back-compat is preserved.
--
-- SQLite constraints honored:
--   * ALTER TABLE ADD COLUMN can't add a FK with a subquery default, so we add the
--     columns then backfill with UPDATEs.
--   * We keep the old `participant.role` text column and the inline `cycle.guide` column
--     (back-compat — M8's goal-sourcing falls back to them; nothing reads-then-drops).
--   * Seeded role ids are STABLE, deterministic strings (not uuids) so the participant
--     backfill can map the old enum text → the matching seeded role by id.

-- ── role: a flat, user-managed library (no is_interviewer flag — per feedback) ──
CREATE TABLE role (
  id         TEXT PRIMARY KEY,           -- uuid for user-created; stable slug for seeds
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '',   -- hex/token used for the chip color
  sort       INTEGER NOT NULL DEFAULT 0, -- display order
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Seed the four existing enum values as starting roles. The seed ids are the OLD enum
-- text (interviewer/respondent/observer/other) so participant.role_id can be backfilled
-- by joining on participant.role = role.id. `Interviewer` is the conventional default the
-- user starts from. Colors mirror the --role-* design tokens (index.css).
INSERT INTO role (id, name, color, sort, created_at, updated_at) VALUES
  ('interviewer', 'Interviewer', '#7c86e3', 0, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('respondent',  'Respondent',  '#3fb68b', 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('observer',    'Observer',    '#d9a23b', 2, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('other',       'Other',       '#9a9ca3', 3, strftime('%s','now') * 1000, strftime('%s','now') * 1000);

-- ── guide: a global, reusable interview-guide library (markdown + derived goals) ──
CREATE TABLE guide (
  id         TEXT PRIMARY KEY,           -- uuid
  name       TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',   -- the guide body (markdown)
  goals_json TEXT NOT NULL DEFAULT '[]', -- derived goals (stable ids) cached as JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── participant.role_id (FK → role.id), backfilled from the old enum text ──
ALTER TABLE participant ADD COLUMN role_id TEXT REFERENCES role(id);

-- Backfill: the seeded role ids equal the old enum text, so a direct match maps cleanly.
-- Any unrecognized legacy value falls back to 'other' so no row is left dangling.
UPDATE participant
   SET role_id = (
     SELECT r.id FROM role r WHERE r.id = participant.role
   )
 WHERE role_id IS NULL;
UPDATE participant SET role_id = 'other' WHERE role_id IS NULL;

-- ── cycle.guide_id (FK → guide.id, nullable) ──
ALTER TABLE cycle ADD COLUMN guide_id TEXT REFERENCES guide(id);

-- Data-migrate: for every cycle whose inline `guide` text is non-empty, create a guide
-- row (name = "<cycle name> — guide", content = that text) and point the cycle at it.
-- goals_json is left '[]' here; the backend re-derives + persists goals on first guide
-- read/update (derive_goals is the single source of truth, kept out of SQL).
INSERT INTO guide (id, name, content_md, goals_json, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  c.name || ' — guide',
  c.guide,
  '[]',
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000
FROM cycle c
WHERE TRIM(COALESCE(c.guide, '')) <> '';

-- Link each migrated cycle to its freshly-created guide (matched by the synthesized name).
UPDATE cycle
   SET guide_id = (
     SELECT g.id FROM guide g WHERE g.name = cycle.name || ' — guide'
   )
 WHERE TRIM(COALESCE(guide, '')) <> '' AND guide_id IS NULL;
