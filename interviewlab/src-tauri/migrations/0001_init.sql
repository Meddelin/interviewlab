-- 0001_init.sql — InterviewLab schema (product-spec §2.2).
-- Single local SQLite file. JSON blobs (segments, findings, diff) stored as TEXT.

CREATE TABLE cycle (
  id            TEXT PRIMARY KEY,          -- uuid
  name          TEXT NOT NULL,
  product_desc  TEXT NOT NULL DEFAULT '',  -- detailed product description (markdown)
  guide         TEXT NOT NULL DEFAULT '',  -- interview guide: goals + target conclusions (markdown)
  prev_cycle_id TEXT REFERENCES cycle(id), -- nullable; for diff
  created_at    INTEGER NOT NULL,          -- unix ms
  updated_at    INTEGER NOT NULL
);

CREATE TABLE interview (
  id          TEXT PRIMARY KEY,
  cycle_id    TEXT NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,               -- 'new'|'transcribing'|'transcribed'|'cleaning'|'cleaned'|'edited'|'error'
  notes       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE participant (
  id            TEXT PRIMARY KEY,
  interview_id  TEXT NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL,             -- 'interviewer'|'respondent'|'observer'|'other'
  -- speaker_label links a participant to ASR speaker tags ("SPEAKER_0", or manual "S1").
  speaker_label TEXT                       -- nullable until assigned in editor
);

CREATE TABLE recording (
  id           TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
  source_path  TEXT NOT NULL,              -- original file copied into the cycle media dir
  audio_path   TEXT,                       -- normalized 16kHz mono wav for ASR (nullable until prepared)
  duration_ms  INTEGER,
  format       TEXT,                       -- 'mp3'|'wav'|'mp4'|'m4a'|...
  bytes        INTEGER
);

CREATE TABLE transcript (
  id            TEXT PRIMARY KEY,
  interview_id  TEXT NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,          -- 1..N
  kind          TEXT NOT NULL,             -- 'raw' | 'cleaned' | 'edited'
  language      TEXT,                      -- detected/forced, e.g. 'ru'
  engine        TEXT,                      -- e.g. 'whisper.cpp:large-v3@cuda'
  segments_json TEXT NOT NULL,             -- JSON: [{start_ms,end_ms,speaker_label,text}, ...]
  created_at    INTEGER NOT NULL,
  UNIQUE(interview_id, version)
);

CREATE TABLE synthesis (
  id            TEXT PRIMARY KEY,
  cycle_id      TEXT NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  findings_json TEXT NOT NULL,             -- JSON (see spec §8.2 schema)
  model_meta    TEXT,                      -- which CLI/adapter + cost/session metadata
  created_at    INTEGER NOT NULL
);

CREATE TABLE diff (
  id            TEXT PRIMARY KEY,
  cycle_id      TEXT NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,  -- the "current" cycle
  prev_cycle_id TEXT NOT NULL REFERENCES cycle(id),
  diff_json     TEXT NOT NULL,             -- JSON (see spec §8.3 schema)
  created_at    INTEGER NOT NULL
);

-- App-level key/value: which adapter is active, model default, GPU availability cache, etc.
CREATE TABLE app_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
