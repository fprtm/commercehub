---
description: Move owner-fillable connector credentials (WhatsApp Cloud API tokens, Telegram bot token) out of .env and into the DB, editable from a new dashboard page
status: done
updated: 2026-09-03
---

# Change: Connector Credentials Moved from `.env` to the Database

**Status:** APPROVED (explicit user instruction, following up on a same-day discussion of whether tokens should live in the DB instead of `.env`)
**Size:** small
**Relates to:** `apps/lead-capture` (schema, `settingsRepo.js`, `server.js`, dashboard routes/views); `002-telegram-multichannel` (the Telegram token this supersedes the env-var form of)

## Why
The owner has to fill in 5 values themselves from a provider's dashboard (Meta App dashboard's 4 WhatsApp Cloud API fields, Telegram's BotFather-issued bot token) — previously only settable by editing `.env` on the server filesystem and restarting, which doesn't fit a dashboard-managed app aimed at a non-technical business owner. Everything else in `.env` (`PORT`, `DATABASE_PATH`, `SESSION_SECRET`, `OWNER_USERNAME`/`OWNER_PASSWORD`, `WHATSAPP_MODE`, `BAILEYS_AUTH_DIR`) is either bootstrap/infra config needed before the DB or the dashboard login even exist, or a boot-time mode choice — none of those moved.

## Functional Requirements

- **FR-1401** — `app_settings` gains 5 nullable columns (`whatsapp_verify_token`, `whatsapp_access_token`, `whatsapp_phone_number_id`, `whatsapp_app_secret`, `telegram_bot_token`); a pre-existing on-disk DB that predates them gets them backfilled as NULL via `ensureAppSettingsColumns()` (same idempotent pattern as `ensureLeadsColumns()`/`ensureFailedEventsColumns()`), not a crash.
- **FR-1402** — `GET /settings/credentials` (owner-authenticated) shows each field's set/not-set status; the 4 secrets are never echoed back into rendered HTML once saved (only "(set)"/"(not set)"), the Phone Number ID (not a secret) is shown in full.
- **FR-1403** — `POST /settings/credentials` saves submitted fields; a field left blank keeps its existing value rather than being cleared, so rotating one credential doesn't require re-entering every other one.
- **FR-1404** — `src/server.js` reads all 5 values from `settingsRepo` at boot instead of `process.env`; boot no longer hard-requires the 4 WhatsApp Cloud API vars (previously `CLOUD_API_REQUIRED_ENV_VARS`, `process.exit(1)` if missing) — cloud_api mode can now boot unconfigured, logging a console line pointing at `/settings/credentials` instead of refusing to start.
- **FR-1405** — Telegram's existing presence-driven gate (`TELEGRAM_BOT_TOKEN` unset → channel not started, zero new code paths) is preserved unchanged, only its data source moves from `process.env.TELEGRAM_BOT_TOKEN` to `settingsRepo.getTelegramBotToken()`.
- **FR-1406** (post-review security fix) — `POST /webhook` gains an `appSecretRequired` flag (default `false`, only ever `true` in `src/server.js`'s real cloud_api boot). When `true` and `appSecret` is unset, every request is rejected with 503 before any processing, instead of silently skipping signature verification. Restores, at request time, the guarantee boot-time env validation used to provide.

## Non-Functional Requirements
- **NFR-1401 (no regression)**: `createApp()`/`createWebhookRouter()`/`createTelegramChannel()`'s public signatures are unchanged (still accept `verifyToken`/`appSecret`/`telegramBotToken` as plain injected values) — only `server.js`'s `main()` changes where those values are sourced from, so every pre-existing test (`webhook.test.js`, `telegramChannel.test.js`, `tests/helpers/testApp.js`) needed zero changes.
- **NFR-1402 (secrets never logged or rendered)**: `credentials_updated` log event records which fields changed, never their values (same rule SEC-1301 already established for connector-level logging); GET /settings/credentials never round-trips a saved secret into the page.

## Settled Decisions
1. **No hot-reload.** A credential saved via the dashboard takes effect on the next server restart, not live — connectors are already a "wired once at boot" composition root (same as `WHATSAPP_MODE`, which already required a restart to change). Building live credential swap for `metaClient`/the Telegram connector was out of scope for what was asked and would have meant changing `@rimba/whatsapp-connector`'s and `@rimba/telegram-connector`'s public constructor shape. The credentials page says so explicitly.
2. **`WHATSAPP_APP_SECRET` unset no longer crashes boot — but `POST /webhook` still refuses to process unverified events.** Boot previously hard-required this var (`process.exit(1)` if missing) specifically so a deployed cloud_api build could never silently skip webhook signature verification. Moving it to the DB breaks that guarantee unless something replaces it: an unconfigured cloud_api deployment is a real, reachable HTTP endpoint the moment it boots — an attacker doesn't need Meta to be configured to find and POST to `/webhook`, so "nobody's told Meta about this server yet" is not a mitigation (this was the first-draft reasoning here, corrected after an automated security review flagged it as HIGH). The actual fix (FR-1406): a new `appSecretRequired` flag, set to `true` only by `src/server.js`'s real cloud_api boot (never by tests, never by `WHATSAPP_MODE=baileys`, which has no Meta integration to verify against at all) — `POST /webhook` now returns 503 outright whenever this flag is true and no secret is configured, instead of quietly accepting anything. This is the same invariant the old boot-time crash provided, just enforced at request time so the app can still boot and let the owner fix it via `/settings/credentials` instead of refusing to start at all.
3. **`SESSION_SECRET`/`OWNER_USERNAME`/`OWNER_PASSWORD` stay in `.env`, not moved.** They gate the dashboard login itself; storing them behind that same login is circular.

## Out of Scope
**NOT NOW:** encryption at rest for the DB-stored secrets (SQLite file is plaintext, same trust boundary as the rest of `data/leads.db` today); live credential hot-reload; a "clear this field" UI control (blank always means "keep existing" — clearing requires editing the DB directly for now); multi-tenant credential scoping (this app is still single-owner/single-tenant).

## Definition of Done
- [x] FR-1401–FR-1406 implemented and verified
- [x] Full suite: `npx turbo run test --force` → 225/225 passing (was 213; +9 credentials-in-db tests + 3 `appSecretRequired` tests), 5/5 turbo tasks
- [x] `.env.example` updated to remove the 5 moved vars, pointing at the new dashboard page instead
- [x] Post-review fix: automated security review flagged the initial "accepted risk" framing of FR-1404 as an actual authentication-bypass gap (HIGH) -- FR-1406 added same-day to close it before this change was considered done
