-- 0010_coverage.sql — v3 B1: guide-coverage analysis ("did we ask everything?").
--
-- One coverage document per interview: the LLM maps each guide goal/question to a
-- coverage status (covered | partial | missed) with evidence quotes, an overall 0-100
-- score, and suggested follow-up questions. Stored as ONE JSON blob (`coverage_json`,
-- the validated Rust CoverageDoc) mirroring how synthesis keeps findings_json — the
-- structured layer is versioned by re-runs (upsert on the PK), never edited in place.
--
-- interview_id is the PRIMARY KEY: at most one coverage doc per interview; a re-run
-- overwrites. ON DELETE CASCADE so deleting an interview cleans its coverage up.

CREATE TABLE coverage (
  interview_id TEXT PRIMARY KEY REFERENCES interview(id) ON DELETE CASCADE,
  coverage_json TEXT NOT NULL,
  model_meta TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
