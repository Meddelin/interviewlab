-- 0008_guide_template.sql — Templated interview guide: fixed, structured blocks.
--
-- The guide gains a STRUCTURED template (hypotheses, tasks/goals, qualifying questions,
-- main-question blocks by theme, hypothesis questions) stored as JSON alongside the
-- existing `content_md`. The structured editor binds to `template_json`; the backend
-- renders a canonical `content_md` from it on every write, so EVERYTHING downstream that
-- reads the guide as markdown (derive_goals, the chat context pack, back-compat) keeps
-- working unchanged. Legacy guides (no template) keep `template_json = '{}'` and behave
-- exactly as before — the new synthesis/diff sections simply don't appear for them.
--
-- SQLite constraint honored (same as 0002/0005): ADD COLUMN with a constant DEFAULT only.
-- No backfill is needed — an empty template ('{}') is the legacy shape, and the backend
-- prefers the existing `content_md` whenever the template is empty.

ALTER TABLE guide ADD COLUMN template_json TEXT NOT NULL DEFAULT '{}';
