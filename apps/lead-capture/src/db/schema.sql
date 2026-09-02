-- Schema per docs/sdd/design/technical-design.md Phase K (Data Model).
-- Two independent tables, no foreign keys / relationships between them.

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- TICKET-1302 (docs/sdd/specs/002-telegram-multichannel/erd.md): renamed
  -- from `phone_number` -- generalizes the Lead identity column ahead of
  -- Telegram support (TICKET-1303), which reuses this same `leads` table
  -- (Decision 001 §1: channel is an attribute, not a new entity). Holds a
  -- WhatsApp phone number OR a Telegram `chat_id`, depending on `channel`
  -- below. Existing DBs created before this column existed are migrated by
  -- `ensureLeadsColumns()` in src/db/index.js (`ALTER TABLE ... RENAME
  -- COLUMN`), not by this CREATE TABLE (a no-op against any table that
  -- already exists).
  contact_id TEXT NOT NULL CHECK (length(contact_id) > 0),
  -- TICKET-1302 (new). Values: 'whatsapp' | 'telegram'. Deliberately the
  -- coarser channel-*family* value, not the finer-grained mode
  -- ('whatsapp_cloud_api' / 'whatsapp_baileys') inboundMessageProcessor.js
  -- already threads through for logging -- see that file's
  -- normalizeDbChannel() for the mapping. DEFAULT 'whatsapp' backfills
  -- every pre-existing row automatically: every lead captured before this
  -- feature existed came in over WhatsApp, so the default is a fact about
  -- the data, not a guess (erd.md).
  channel TEXT NOT NULL DEFAULT 'whatsapp',
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
  -- match was found/attempted -- see @rimba/product-matcher's productMatcher.js).
  -- `needs_review` flags a low-confidence-or-no-match Q1 answer for the
  -- dashboard so the owner can interpret it manually (FR-504); it is a
  -- separate flag rather than a new `status` value so it composes with
  -- the existing new/responded/closed lifecycle instead of replacing it.
  matched_product TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  -- Added for docs/sdd/changes/2026-09-02-capture-post-completion-messages.md
  -- (FR-801..FR-803). `matched_product_score` persists the confidence score
  -- (0-1, from @rimba/product-matcher's productMatcher.js) behind whatever is currently
  -- recorded in `matched_product` -- whether that came from the original Q1
  -- answer or from a later post-completion message that raised it (FR-802:
  -- "never let a later, lower-confidence message downgrade an existing good
  -- match"). This has to be a persisted value, not something re-derived from
  -- question1_answer on demand: once a post-completion message has updated
  -- matched_product, the score behind it may no longer correspond to
  -- question1_answer at all. NULL whenever matched_product is NULL (no
  -- confident match recorded yet).
  matched_product_score REAL,
  -- `additional_notes` (FR-801): an append-only, timestamped running log of
  -- every inbound message that arrives after this Lead's automated flow has
  -- already resolved it to NO_OP (both questions answered, fallback already
  -- triggered, or status already responded/closed -- see
  -- src/services/inboundMessageProcessor.js for the exact NO_OP-reason scope
  -- this applies to, and why). Previously these messages were fully dropped,
  -- with no record anywhere -- this column is the fix for that. Deliberately
  -- unbounded/untrimmed (out of scope to bound, per the change doc, given
  -- this project's demo scale).
  additional_notes TEXT,
  -- Added post-review (HIGH-severity finding) for
  -- docs/sdd/changes/2026-09-02-numbered-product-selection.md (FR-1001/
  -- FR-1002/FR-1004). JSON-encoded array of `products.id` values, in the
  -- exact order they were numbered when Q1's list was last (re)sent to
  -- this Lead (src/services/stateMachine.js's buildQ1Message()) -- NULL
  -- when Q1 was never shown as a numbered list at all (FR-1005 fallback,
  -- or a pre-existing Lead from before this column existed).
  --
  -- This is a SNAPSHOT, not a cache: a numbered reply ("3") MUST be
  -- resolved against exactly what this specific customer was actually
  -- shown, never against a fresh `productsRepo.listActive()` re-query at
  -- answer-time. Re-querying fresh would let a catalog change in the
  -- window between Q1-send and the reply (e.g. the owner deactivating a
  -- DIFFERENT product than the one this customer picked) silently shift
  -- which product a given position now refers to -- a confident,
  -- needs_review=false match to the WRONG product, reopening the exact
  -- misrouting shape FR-901 already fixed once for the fuzzy matcher,
  -- through a different mechanism. See src/services/stateMachine.js's
  -- decideNextAction() for where this is written (on START_FLOW and on a
  -- Q1 RETRY, which re-shows the list and so re-snapshots it) and read
  -- back (to resolve a numbered reply, then re-verify that specific
  -- product is STILL active right now before confidently matching it).
  shown_product_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- TICKET-1302: the old `idx_leads_phone_number` index (on the
-- since-renamed `contact_id` column) is intentionally NOT declared here.
-- On a fresh DB this CREATE TABLE already defines `contact_id` directly, so
-- an index on it here would be harmless -- but on an EXISTING DB that still
-- has the old `phone_number` column at the moment this schema.sql is exec'd
-- (CREATE TABLE IF NOT EXISTS is a no-op against it), an index statement
-- referencing `contact_id` here would fail loudly ("no such column") before
-- src/db/index.js's ensureLeadsColumns() ever gets a chance to run the
-- rename. So this index is created programmatically in ensureLeadsColumns(),
-- after the rename is guaranteed to have already happened -- see that
-- function for the `idx_leads_contact_id` index.
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
  auto_reply_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_reply_enabled IN (0, 1)),
  -- Added 2026-09-03: owner-fillable connector credentials, moved out of
  -- `.env` and into the DB (dashboard-editable via GET/POST
  -- /settings/credentials, src/routes/settings.js) -- unlike PORT/
  -- DATABASE_PATH/SESSION_SECRET/OWNER_USERNAME/OWNER_PASSWORD/
  -- WHATSAPP_MODE, which stay in `.env` because they're either needed
  -- before the DB/dashboard auth even exists (bootstrap config, or the
  -- owner-login credentials themselves -- a circular dependency if stored
  -- behind the login they gate) or are a boot-time mode choice, not a
  -- per-value credential an owner fills in from a provider's dashboard.
  -- All nullable/no default: NULL means "not configured yet", same
  -- "presence-driven" meaning TELEGRAM_BOT_TOKEN already had as an env var
  -- (src/server.js's createTelegramChannel) -- moving it here doesn't
  -- change that semantic, only where the presence check reads from.
  whatsapp_verify_token TEXT,
  whatsapp_access_token TEXT,
  whatsapp_phone_number_id TEXT,
  whatsapp_app_secret TEXT,
  telegram_bot_token TEXT
);

INSERT OR IGNORE INTO app_settings (id, auto_reply_enabled) VALUES (1, 1);

-- Added for docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md
-- (FR-702): Products move from config/products.json (see
-- src/services/productsLoader.js -- now legacy/seed-only, see
-- src/services/productsSeed.js) into the database as the source of truth,
-- both for fuzzy-matching (@rimba/product-matcher's productMatcher.js, via
-- src/services/productsRepo.js's listActive()) and for full CRUD
-- management from the dashboard (src/routes/products.js).
--
-- `aliases` is a JSON-encoded text column (an array of strings), not a
-- normalized child table -- same "don't overengineer" judgment call
-- productsLoader.js's own doc comment already made about the Product shape:
-- a handful of short aliases per product doesn't justify a join for this
-- project's scope. `is_active` is the soft-delete flag (FR-702:
-- "deactivate", not delete -- always re-activatable, no separate undo).
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active);

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
