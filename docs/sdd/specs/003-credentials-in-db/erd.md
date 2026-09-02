# ERD: `app_settings` — 5 New Nullable Credential Columns

**Feature:** 003-credentials-in-db

## Entity change

`app_settings` (existing single-row table, `apps/lead-capture/src/db/schema.sql` — no new entity/table; per this feature's SDS "Architecture Decision," credentials are owner-level config, the exact same kind of data `auto_reply_enabled` already is, not a new relation).

| Column (before) | Column (after) | Notes |
|---|---|---|
| *(none)* | `whatsapp_verify_token TEXT` | **New, nullable, no default.** `NULL` = not configured yet (presence-driven, same semantic `TELEGRAM_BOT_TOKEN` already had as an env var). |
| *(none)* | `whatsapp_access_token TEXT` | **New, nullable, no default.** |
| *(none)* | `whatsapp_phone_number_id TEXT` | **New, nullable, no default.** The one non-secret field of the 5 — shown in full on the credentials page (`fsd.md` Flow 2). |
| *(none)* | `whatsapp_app_secret TEXT` | **New, nullable, no default.** Read by `POST /webhook`'s signature verification; its unset state now drives `appSecretRequired`'s reject-vs-skip branch (see `threats.md` SEC-1404) instead of a boot-time crash. |
| *(none)* | `telegram_bot_token TEXT` | **New, nullable, no default.** Same presence-driven gate `createTelegramChannel()` already implemented against the env var — only the data source moved. |

`id`, `auto_reply_enabled` unchanged. No column is renamed, no column is dropped, no existing column's type/constraint/default changes.

## Cardinality
Unchanged: exactly one row (`id = 1`, enforced by the existing `CHECK (id = 1)` constraint). The 5 new columns are plain attributes on that one row — no new table, no foreign key, no one-to-many relationship introduced. This is the direct consequence of this feature's single-owner/single-tenant scope (SDS "Architecture Decision," Out of Scope: multi-tenant credential scoping) — a multi-tenant version of this feature would need a real `credentials` table keyed by tenant, which is explicitly not what was built or asked for here.

## Migration approach

Idempotent, guarded `ALTER TABLE ... ADD COLUMN`, matching this project's established migration convention (no numbered migration framework — see `ensureLeadsColumns()`/`ensureFailedEventsColumns()` for the precedent this follows exactly):

```sql
-- one ALTER per column, each skipped if the column already exists
ALTER TABLE app_settings ADD COLUMN whatsapp_verify_token TEXT;
ALTER TABLE app_settings ADD COLUMN whatsapp_access_token TEXT;
ALTER TABLE app_settings ADD COLUMN whatsapp_phone_number_id TEXT;
ALTER TABLE app_settings ADD COLUMN whatsapp_app_secret TEXT;
ALTER TABLE app_settings ADD COLUMN telegram_bot_token TEXT;
```

Unlike `ensureLeadsColumns()`'s `channel` column (which needed a `DEFAULT` to backfill pre-existing rows with a real fact about the data — "every lead before this feature was WhatsApp") these 5 columns have **no default**, because `NULL` *is* the correct backfilled value for every pre-existing install: a DB created before this feature has, by definition, never had any of these 5 credentials configured through this mechanism (they lived in `.env` instead, which this migration has no way to read and, per this feature's design, shouldn't try to auto-import — see Settled Decisions in the change doc: no silent env-to-DB migration was built, the owner re-enters them once via the new page).

## Data access pattern changes (`settingsRepo.js`)

- `getWhatsappCloudApiCredentials()` / `setWhatsappCloudApiCredentials({...})` — new, 4-field group, full-overwrite setter (see `sds.md` for why "leave blank = keep existing" is a route-level, not repo-level, concern).
- `getTelegramBotToken()` / `setTelegramBotToken(token)` — new, single-field pair.
- `isAutoReplyEnabled()` / `setAutoReplyEnabled()` / `toggleAutoReply()` — **zero changes**, unrelated columns on the same row, already existing.

## Fidelity check
Traced against the actual shipped `schema.sql`/`db/index.js`/`settingsRepo.js` (read directly, not from memory, while writing this document): column names, nullability, absence of defaults, and the `ensureAppSettingsColumns()` function shape all match exactly what was built and covered by `tests/settingsRepo.test.js`'s on-disk migration test (`db migration: reopening a pre-existing on-disk DB that predates the credential columns backfills them as NULL, not a crash`). No drift.
