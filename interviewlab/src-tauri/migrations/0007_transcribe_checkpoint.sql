-- 0007_transcribe_checkpoint.sql — crash-safe transcription progress + resume.
--
-- A long on-device transcription (notably macOS CPU) can fail or be killed mid-run. Before
-- this, a failure lost ALL decoded text and the only option was to re-run the whole file.
-- This table checkpoints the partial result as whisper streams segments, so:
--   * the editor can show "interrupted at M:SS — resume", and
--   * resume re-transcribes ONLY the remaining tail [processed_ms, total_ms] and splices it
--     onto the saved prefix (then a whole-audio diarization re-unifies speakers).
--
-- One row per interview (the checkpoint for its CURRENT/last run). Cleared on successful
-- completion; LEFT in place on error/crash so it's available to resume. Cascades with the
-- interview. JSON-as-TEXT + unix-ms timestamps, matching the existing conventions.
CREATE TABLE transcribe_checkpoint (
  interview_id  TEXT PRIMARY KEY REFERENCES interview(id) ON DELETE CASCADE,
  processed_ms  INTEGER NOT NULL,            -- how far transcription reached (last segment end, ms)
  total_ms      INTEGER,                     -- audio duration (ms) — the resume target end
  model_id      TEXT NOT NULL,               -- model the run used (resume reuses it)
  language      TEXT,                        -- forced/detected language ('auto' stored as NULL)
  segments_json TEXT NOT NULL,               -- partial segments so far: [{start_ms,end_ms,speaker_label,text}, ...]
  updated_at    INTEGER NOT NULL
);
