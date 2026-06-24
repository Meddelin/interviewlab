-- 0005_products.sql — Products library: extract product_desc into a reusable library.
--
-- Mirrors the M10a guide library (0002_roles_guides.sql §guide) exactly: a global,
-- reusable `product` table authored in markdown, a nullable cycle→product FK, and a
-- data-migration that lifts each cycle's inline `product_desc` text into a product row
-- and points the cycle at it. The inline `cycle.product_desc` column is KEPT for back-
-- compat (the pipeline falls back to it when no product is linked), exactly like the
-- inline `cycle.guide` column was kept in 0002.
--
-- SQLite constraints honored (same as 0002):
--   * ALTER TABLE ADD COLUMN can't add a FK with a subquery default, so we add the
--     column then backfill with UPDATEs.
--   * Product ids are random blobs (uuid-shaped hex) generated in SQL; the backend never
--     trusts these for anything but the FK link, so a SQL-side id is fine.

-- ── product: a global, reusable product-context library (markdown) ──
CREATE TABLE product (
  id         TEXT PRIMARY KEY,           -- uuid
  name       TEXT NOT NULL,
  content_md TEXT NOT NULL DEFAULT '',   -- the product description / context (markdown)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── cycle.product_id (FK → product.id, nullable) ──
ALTER TABLE cycle ADD COLUMN product_id TEXT REFERENCES product(id);

-- Data-migrate: for every cycle whose inline `product_desc` text is non-empty, create a
-- product row (name = "<cycle name> — product", content = that text) and point the cycle
-- at it. Empty-product cycles are left untouched (no product row, product_id stays NULL).
INSERT INTO product (id, name, content_md, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  c.name || ' — product',
  c.product_desc,
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000
FROM cycle c
WHERE TRIM(COALESCE(c.product_desc, '')) <> '';

-- Link each migrated cycle to its freshly-created product (matched by the synthesized name).
UPDATE cycle
   SET product_id = (
     SELECT p.id FROM product p WHERE p.name = cycle.name || ' — product'
   )
 WHERE TRIM(COALESCE(product_desc, '')) <> '' AND product_id IS NULL;
