-- 0009_hot_fk_indexes.sql — indexes on hot foreign-key columns.
--
-- These FKs are filtered/joined on constantly (list interviews by cycle, fetch the latest
-- transcript version for an interview, load a recording/participants for an interview, find a
-- cycle's synthesis) but SQLite does NOT auto-index FK columns, so each was a table scan.
-- All additive, IF NOT EXISTS, idempotent. Names/columns match 0001_init.sql.

-- interview.cycle_id: list/count interviews in a cycle.
CREATE INDEX IF NOT EXISTS idx_interview_cycle_id ON interview (cycle_id);

-- transcript(interview_id, kind, version): "latest version of kind X for interview Y" lookups.
-- Composite ordered to serve the common (interview_id [, kind]) prefix filters too.
CREATE INDEX IF NOT EXISTS idx_transcript_interview_kind_version
  ON transcript (interview_id, kind, version);

-- recording.interview_id: load the recording for an interview.
CREATE INDEX IF NOT EXISTS idx_recording_interview_id ON recording (interview_id);

-- participant.interview_id: load participants for an interview.
CREATE INDEX IF NOT EXISTS idx_participant_interview_id ON participant (interview_id);

-- synthesis.cycle_id: fetch a cycle's synthesis rows. (The partial unique indexes from
-- 0003 only cover specific interview_id predicates; this plain index serves cycle_id scans.)
CREATE INDEX IF NOT EXISTS idx_synthesis_cycle_id ON synthesis (cycle_id);
