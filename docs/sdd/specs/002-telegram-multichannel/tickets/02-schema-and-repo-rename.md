# TICKET-1302 — Schema migration (`contact_id` + `channel`) + repo/processor rename

**Feature**: 002-telegram-multichannel
**Refs**: FSD (Flow 1, Edge case: contact_id/channel collision), ERD (full doc), FR-1306, FR-1307
**Tier**: T1
**Status**: ⬜ todo
**Dependencies**: none
**Files likely touched:** `apps/lead-capture/src/db/schema.sql` (or migration runner file), `apps/lead-capture/src/services/leadsRepo.js`, `apps/lead-capture/src/services/inboundMessageProcessor.js`, all test files under `apps/lead-capture/tests/` referencing `phoneNumber`/`findByPhone`
**Claimed by:** _(empty)_

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
- [ ] Given the migration runs against an existing dev DB with pre-existing rows, when it completes, then every existing row has `channel='whatsapp'` and its old `phone_number` value now under `contact_id`.
- [ ] Given a fresh WhatsApp inbound message (Baileys or Cloud API), when `processInboundMessage` runs, then behavior (state machine decisions, replies sent) is identical to before this ticket — only the identifier's name changed, never its value or the logic around it.
- [ ] Given a `contact_id` value `"12345"` exists as a `channel='whatsapp'` lead, when a `channel='telegram'` message arrives with the same `contact_id` value `"12345"`, then `findByContact` treats them as two separate leads, never merging or cross-contaminating state.

## Out of Scope
- Any UI change to reflect the rename (`leads.ejs` header/badge) — that's TICKET-1306.
- Telegram connector itself — that's TICKET-1303. This ticket only makes the data layer channel-aware; nothing calls it with `channel='telegram'` yet.
