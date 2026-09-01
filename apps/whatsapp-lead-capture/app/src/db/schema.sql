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
  -- Added for docs/sdd/changes/2026-09-01-fuzzy-product-matching.md
  -- (FR-502..FR-504). `matched_product` is the Product catalog name the
  -- customer's question1_answer was fuzzy-matched against (NULL when no
  -- match was found/attempted -- see src/services/productMatcher.js).
  -- `needs_review` flags a low-confidence-or-no-match Q1 answer for the
  -- dashboard so the owner can interpret it manually (FR-504); it is a
  -- separate flag rather than a new `status` value so it composes with
  -- the existing new/responded/closed lifecycle instead of replacing it.
  matched_product TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_phone_number ON leads(phone_number);
CREATE INDEX IF NOT EXISTS idx_leads_first_message_at ON leads(first_message_at);

-- Added for docs/sdd/changes/2026-09-01-auto-reply-toggle.md (FR-401..FR-403).
-- Single-row settings table -- id is pinned to 1 by the CHECK constraint so
-- there can only ever be exactly one row, matching the "one owner, one
-- setting" scope of this change (a generic key-value store would be
-- premature abstraction for one boolean today, per the change doc's
-- Settled Decisions). The INSERT OR IGNORE below seeds that single row with
-- the default (auto_reply_enabled = true) the first time the schema is
-- applied; it's a no-op on every subsequent boot since the row already
-- exists by then.
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto_reply_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_reply_enabled IN (0, 1))
);

INSERT OR IGNORE INTO app_settings (id, auto_reply_enabled) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS failed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_payload TEXT NOT NULL,
  error_message TEXT NOT NULL,
  -- Added for FR-305 (docs/sdd/changes/2026-09-01-baileys-dual-mode.md):
  -- distinguishes which connector recorded the failure ('whatsapp_cloud_api'
  -- or 'whatsapp_baileys'), e.g. a Baileys logged-out disconnect. Defaults
  -- to the original (only) channel so this is a backward-compatible
  -- addition -- failedEventsRepo.record() still works exactly as before if
  -- a caller doesn't pass one.
  channel TEXT NOT NULL DEFAULT 'whatsapp_cloud_api',
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
