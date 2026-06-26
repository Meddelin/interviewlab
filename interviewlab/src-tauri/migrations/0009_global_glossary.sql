-- 0009_global_glossary.sql — raise the Glossary one level: a GLOBAL (app-wide) term list
-- shared across ALL products, in addition to the existing per-product lists.
--
-- WHY: anglicisms / acronyms / tooling names (API, Jira, Figma, дедлайн, …) recur across
-- every product, so re-entering them per product is busywork. A global glossary is curated
-- once and merged into the pipeline for EVERY interview (asr.rs initial_prompt + cleanup.rs
-- entity phrase-list) through the single resolution path glossary_for_interview_db — product
-- terms still layer on top and win on a canonical-key collision.
--
-- Storage = the SAME `glossary_term` table with `product_id = NULL` marking a global term.
-- That keeps one schema, one CRUD path, one prompt renderer. SQLite can't drop a column's
-- NOT NULL in place, so we rebuild the table to make `product_id` nullable (the product FK +
-- ON DELETE CASCADE are preserved; a NULL product_id simply skips the FK check, so global
-- terms are never touched by a product delete).

CREATE TABLE glossary_term_new (
  id           TEXT PRIMARY KEY,                         -- uuid
  product_id   TEXT REFERENCES product(id) ON DELETE CASCADE,  -- NULL = GLOBAL (app-wide), else per-product
  canonical    TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  notes        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT INTO glossary_term_new (id, product_id, canonical, aliases_json, notes, created_at, updated_at)
SELECT id, product_id, canonical, aliases_json, notes, created_at, updated_at FROM glossary_term;

DROP TABLE glossary_term;
ALTER TABLE glossary_term_new RENAME TO glossary_term;

-- Same lookup as before (per-product). Global terms (product_id IS NULL) are queried separately.
CREATE INDEX idx_glossary_term_product ON glossary_term(product_id);
