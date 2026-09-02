# TICKET-1302 — Schema migration (`contact_id` + `channel`) + repo/processor rename

**Feature**: 002-telegram-multichannel
**Refs**: FSD-002 (Flow 1, Edge case: contact_id/channel collision), ERD-002 (full doc), FR-1306, FR-1307
**Tier**: T1
**Status**: ✅ done
**Dependencies**: none
**Files likely touched:** `apps/lead-capture/src/db/schema.sql` (or migration runner file), `apps/lead-capture/src/services/leadsRepo.js`, `apps/lead-capture/src/services/inboundMessageProcessor.js`, all test files under `apps/lead-capture/tests/` referencing `phoneNumber`/`findByPhone`
**Claimed by:** _(empty)_

**Verified:**
- Full suite: `npx turbo run test` → 5/5 tasks pass, 0 failures. `lead-capture` app: 200 tests (199 baseline + TEST-1302a), `@rimba/humanized-timing`: 10, `@rimba/whatsapp-connector`: 44, `@rimba/product-matcher`: 35, `@rimba/telegram-connector`: 10. Total 299 (baseline 298 + 1 new), no existing assertion weakened.
- Migration correctness (AC1) manually verified beyond the test suite's `:memory:` DBs: built a real on-disk SQLite file with the OLD `phone_number`-only schema and a pre-existing row, then opened it with the app's real `createDb()` — confirmed the row now has `contact_id` = the old phone value and `channel = 'whatsapp'`, `phone_number` no longer present, and a second boot against the same already-migrated file is a no-op (idempotent, no error).
- FR-1306 scoping (AC3) verified both as a unit test (TEST-1302a in `tests/leads.test.js`: same `contact_id` under `channel='whatsapp'` vs `channel='telegram'` resolves to two independent Lead rows via `findByContact`, and mutating one is invisible through the other's lookup) and via the pre-existing `FR-302` cross-mode test in `tests/inboundMessageProcessor.test.js`, which now additionally proves `whatsapp_cloud_api` and `whatsapp_baileys` both resolve through `findByContact(id, 'whatsapp')`.
- Channel-mapping judgment call: added `toLeadChannel(channel)` in `inboundMessageProcessor.js`, mapping the mode-specific `channel` param (`'whatsapp_cloud_api'` | `'whatsapp_baileys'`) to the DB's channel-family value `'whatsapp'`; any other value (e.g. future `'telegram'`) passes through unchanged. Documented inline since this distinction (mode vs. family) isn't spelled out verbatim in the ERD.
- AC2 (existing WA flows behaviorally unchanged): confirmed by running the pre-existing, previously-hardened test suite unmodified in substance (only identifier names changed in assertions/fixtures) — all pass, including the FR-302 cross-mode-parity test and the full numbered-selection/product-matching/post-completion-message suites.

## What to Build
Rename the Lead identity column and add the channel attribute, end to end: schema, data-access layer, and the shared inbound-message processor — with zero behavior change for existing WhatsApp flows beyond the identifier rename.

## Deliverables
- Schema migration → `ALTER TABLE leads RENAME COLUMN phone_number TO contact_id; ALTER TABLE leads ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp';` (new)
- `leadsRepo.js` → `findByPhone(phoneNumber)` replaced by `findByContact(contactId, channel)` (modified — two-param, scoped lookup per FR-1306)
- `leadsRepo.js` → `create({phoneNumber, firstMessageAt})` replaced by `create({contactId, channel, firstMessageAt})` (modified)
- `inboundMessageProcessor.js` → `phoneNumber` renamed to `contactId` throughout (params, JSDoc, all `sendTextMessage`/`markAsRead`/`sendTypingIndicator` call sites); `channel` now threaded into `leadsRepo.create()` (modified)
- Existing test suite updated to the renamed identifiers (modified, no new test files expected — this ticket is a rename, not new behavior)
- New test: TEST-1302a — same `contact_id` value on two different `channel`s resolves to two independent leads (new)

## Acceptance Criteria (Given/When/Then)
- [x] Given the migration runs against an existing dev DB with pre-existing rows, when it completes, then every existing row has `channel='whatsapp'` and its old `phone_number` value now under `contact_id`.
- [x] Given a fresh WhatsApp inbound message (Baileys or Cloud API), when `processInboundMessage` runs, then behavior (state machine decisions, replies sent) is identical to before this ticket — only the identifier's name changed, never its value or the logic around it.
- [x] Given a `contact_id` value `"12345"` exists as a `channel='whatsapp'` lead, when a `channel='telegram'` message arrives with the same `contact_id` value `"12345"`, then `findByContact` treats them as two separate leads, never merging or cross-contaminating state.

## Out of Scope
- Any UI change to reflect the rename (`leads.ejs` header/badge) — that's TICKET-1306.
- Telegram connector itself — that's TICKET-1303. This ticket only makes the data layer channel-aware; nothing calls it with `channel='telegram'` yet.
