-- Schema per docs/sdd/design/technical-design.md Phase K (Data Model).
-- Two independent tables, no foreign keys / relationships between them.

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT NOT NULL CHECK (length(phone_number) > 0),
  first_message_at TEXT NOT NULL,
  question1_answer TEXT,
  question2_answer TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'responded', 'closed')),
  fallback_triggered INTEGER NOT NULL DEFAULT 0 CHECK (fallback_triggered IN (0, 1)),
  -- Tracks whether the one-retry-before-fallback allowance (FR-002:
  -- "...or after one follow-up attempt if unanswered") has already been
  -- used for the currently-pending question. Not in Phase K's original
  -- table (which predates this behavior); added post-review to make
  -- FR-002's retry requirement actually implementable -- the state
  -- machine is a pure function driven only by this row, so "have we
  -- already retried once" has to be persisted somewhere. Resets to 0
  -- whenever a question is newly answered/pending.
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_phone_number ON leads(phone_number);
CREATE INDEX IF NOT EXISTS idx_leads_first_message_at ON leads(first_message_at);

CREATE TABLE IF NOT EXISTS failed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_payload TEXT NOT NULL,
  error_message TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
