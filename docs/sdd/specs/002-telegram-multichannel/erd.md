# ERD: `leads` Table — `phone_number` → `contact_id` + `channel`

**Feature:** 002-telegram-multichannel

## Entity change

`leads` (existing table, `apps/lead-capture/src/db/schema.sql` or equivalent migration file — single table, no new entities; Telegram leads are still Leads, per Decision 001 §1: channel is an attribute, not a new entity).

| Column (before) | Column (after) | Notes |
|---|---|---|
| `phone_number TEXT NOT NULL` | `contact_id TEXT NOT NULL` | **Renamed**, not dropped-and-recreated. SQLite (≥3.25, `better-sqlite3` ships a recent bundled SQLite) supports `ALTER TABLE leads RENAME COLUMN phone_number TO contact_id` directly — no data movement, no rebuild. |
| *(none)* | `channel TEXT NOT NULL DEFAULT 'whatsapp'` | **New.** Values: `'whatsapp'` \| `'telegram'`. `DEFAULT 'whatsapp'` backfills every pre-existing row automatically at migration time — every lead captured before this feature existed came in over WhatsApp, so this default is not a guess, it's a fact about the data. |

No other columns change. `question1_answer`, `question2_answer`, `status`, `matched_product`, `additional_notes`, `shown_product_ids`, etc. are channel-agnostic already (all keyed off `lead.id`, never off the identity column) — confirmed by reading `leadsRepo.js`'s full column list.

## Cardinality
Unchanged: one `leads` row per (contact, conversation lifecycle) — a `contact_id` can have multiple historical lead rows over time (existing behavior, e.g. after `status='closed'`), same as `phone_number` did. `channel` does not introduce a new relationship; it's a plain attribute on the existing row, matching Decision 001 §1's explicit choice (attribute, not a `Channel` entity/table) — there is no `channels` table, no foreign key.

## Migration approach (FR-1307)
Single migration, run once, forward-only (no down-migration needed per this project's existing migration convention — confirm against whatever `apps/lead-capture`'s current migration runner does; if it's a plain `schema.sql` applied via `CREATE TABLE IF NOT EXISTS` + ad hoc `ALTER`s rather than a numbered migration framework, this becomes one more guarded `ALTER TABLE ... RENAME COLUMN` / `ALTER TABLE ... ADD COLUMN` pair, wrapped the same way existing schema evolutions in this file already are):

```sql
ALTER TABLE leads RENAME COLUMN phone_number TO contact_id;
ALTER TABLE leads ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp';
```

Both statements are individually idempotent-safe to guard (`RENAME COLUMN` fails loudly if `contact_id` already exists / `phone_number` doesn't — acceptable, matches this project's existing "fail loudly on unexpected schema state" posture rather than silently swallowing).

## Data access pattern changes (`leadsRepo.js`)
- `findByPhone(phoneNumber)` → `findByContact(contactId, channel)` — **two params, not a same-shape rename** (revised during FSD depth pass, FR-1306): a bare `contact_id` lookup could theoretically collide between a WA phone number and a Telegram `chat_id` occupying the same numeric-string space, so the lookup is scoped by `(contact_id, channel)` together. Still single-row-or-undefined return shape.
- `create({ phoneNumber, firstMessageAt })` → `create({ contactId, channel, firstMessageAt })` — `channel` becomes a required param at the call site (no default inside the repo — the caller, `inboundMessageProcessor.js`, always knows which channel it's running as, per the SDS's one-processor-instance-per-channel design, so there's never an ambiguous "unknown channel" case to default away).
- Every other `leadsRepo.js` function (`saveAnswers`, `updateStatus`, `updateProductMatch`, `appendAdditionalNote`, `updateShownProductIds`, `listAll`) is keyed by `lead.id`, not the identity column — **zero changes** to those beyond the rename touching nothing they reference.
- `listAll` gains an optional `{ channel }` filter param for the dashboard (FR-1305, see FSD) — `listAll({ channel: 'telegram' })` vs `listAll()` (all channels, existing default behavior preserved for every pre-existing caller).

## Fidelity check
Traced against the settled fork answer ("Generalize ke contact_id + channel... rename + kolom channel terpisah, butuh migration + rename lookup function"): column renamed (not duplicated), `channel` added as a sibling column (not a new table), `findByPhone`→`findByContact` renamed exactly as the settled option named it. No drift.
