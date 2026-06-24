-- 0004_chat.sql — M11 Phase A: cycle chat (the grounded streaming side panel).
--
-- Per feature-cycle-chat.md §7. THREE tables, matching the existing conventions
-- (sqlx, UUID text ids, unix-ms timestamps, JSON-as-TEXT, ON DELETE CASCADE from cycle):
--
--   * chat_thread   — cycle-scoped conversation threads. `session_id` drives Claude
--                     Code's --resume for multi-turn continuity (nullable until turn 1
--                     completes). title auto-derived from the first question, renamable.
--
--   * chat_message  — role/content rows. content keeps the assistant's inline [[…]]
--                     citation tokens; citations_json is the parsed-out list (lossless
--                     re-render). status flips streaming → complete/error so a reopened
--                     panel can reconcile an interrupted stream.
--
--   * chat_tool_call — the tool-call / edits log for the agentic surface (§6.5). Created
--                     now per the spec but LEFT UNUSED in Phase A (no tools fire until
--                     Phase B/C). undo_token holds the inverse-mutation payload for the
--                     future Undo affordance. ponytail: shipped now so Phase B/C need no
--                     further migration, but no Phase-A code touches it.

CREATE TABLE chat_thread (
  id          TEXT PRIMARY KEY,                                   -- uuid
  cycle_id    TEXT NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',                           -- derived from first question; user-renamable
  session_id  TEXT,                                               -- Claude Code session id for --resume (nullable until turn 1)
  created_at  INTEGER NOT NULL,                                   -- unix ms
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_chat_thread_cycle ON chat_thread (cycle_id, updated_at DESC);

CREATE TABLE chat_message (
  id             TEXT PRIMARY KEY,                                -- uuid
  thread_id      TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,                                   -- 'user' | 'assistant'
  content        TEXT NOT NULL,                                   -- markdown (assistant) / plain (user); citation tokens left inline
  citations_json TEXT NOT NULL DEFAULT '[]',                      -- JSON: [{kind:'segment'|'finding'|'interview', interview_id?, segment_id?, finding_id?}]
  status         TEXT NOT NULL DEFAULT 'complete',                -- 'streaming' | 'complete' | 'error' (assistant rows)
  error          TEXT,                                            -- nullable error detail when status='error'
  cost_usd       REAL,                                            -- from the stream-json final result (optional, informational)
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_chat_message_thread ON chat_message (thread_id, created_at);

-- Tool-call / edits log: audit + undo for the agentic surface (§6.5). UNUSED in Phase A.
CREATE TABLE chat_tool_call (
  id          TEXT PRIMARY KEY,                                  -- uuid (maps to stream tool_use id)
  message_id  TEXT NOT NULL REFERENCES chat_message(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
  tool        TEXT NOT NULL,                                     -- 'mcp__inv__update_segment_text' …
  kind        TEXT NOT NULL,                                     -- 'read' | 'write'
  args_json   TEXT NOT NULL DEFAULT '{}',                        -- the (pre-scoped) tool input
  result_json TEXT,                                              -- concise result / diff summary
  status      TEXT NOT NULL DEFAULT 'done',                      -- 'running' | 'done' | 'error' | 'denied'
  error       TEXT,                                              -- tool error the agent saw (nullable)
  undo_token  TEXT,                                              -- JSON: inverse-mutation payload (write tools only)
  undone_at   INTEGER,                                           -- set when the user undoes this edit (nullable)
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_chat_tool_call_thread ON chat_tool_call (thread_id, created_at);
CREATE INDEX idx_chat_tool_call_message ON chat_tool_call (message_id, created_at);
