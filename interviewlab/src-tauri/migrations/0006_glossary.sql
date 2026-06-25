-- 0006_glossary.sql — per-product Glossary: a focused term list (canonical spelling +
-- aliases) that anchors anglicisms / technical terms / local product names across the
-- pipeline.
--
-- WHY (docs/transcription-terminology.md "Recommended next step"): the product `content_md`
-- is prose; the strongest lever for ASR-error-correction of named entities is a FOCUSED
-- `term → canonical` list. A glossary row's `canonical` is the right spelling; `aliases_json`
-- holds the wrong/garbled forms the ASR tends to produce (so cleanup can map them). The list
-- is injected into (1) the whisper `initial_prompt` to bias the ASR up-front, and (2) every
-- cleanup batch + the per-segment rewrite as the entity phrase-list that also guarantees
-- cross-batch spelling consistency.
--
-- Scope = PRODUCT (mirrors how `content_md` is product-level + reused across cycles). The FK
-- cascades on product delete (foreign_keys is ON, see lib.rs init_db), so a product's terms
-- are cleaned up with it — no orphan rows.

CREATE TABLE glossary_term (
  id           TEXT PRIMARY KEY,                         -- uuid
  product_id   TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  canonical    TEXT NOT NULL,                            -- the authoritative spelling (e.g. "API", "Jira", "дедлайн")
  aliases_json TEXT NOT NULL DEFAULT '[]',               -- JSON array of variant/garbled forms (e.g. ["эй-пи-ай","апишка"])
  notes        TEXT NOT NULL DEFAULT '',                 -- optional human note (context, script preference, …)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- One lookup pattern: all terms for a product (resolve glossary for an interview → cycle → product).
CREATE INDEX idx_glossary_term_product ON glossary_term(product_id);
