# SDS: Connector Credentials Dashboard

**Feature:** 003-credentials-in-db
**App:** `apps/lead-capture`

## Architecture Decision — Extend the existing `app_settings` single-row table, not a new table

**Settled** (direct user instruction, not a fork requiring a discovery session — see this feature's spec run's own opening exchange): store owner-fillable connector credentials in the DB instead of `.env`.

**Refined here (HOW)**: the 5 new fields (`whatsapp_verify_token`, `whatsapp_access_token`, `whatsapp_phone_number_id`, `whatsapp_app_secret`, `telegram_bot_token`) are added as nullable columns on the existing `app_settings` table (the same single-row table `auto_reply_enabled` already lives on — FR-401), not a new `credentials` table.

Why: this app is single-owner/single-tenant (Phase I "Authentication Strategy" — one role, no user table). A dedicated `credentials` table would imply a one-to-many relationship (multiple credential sets, e.g. per tenant) that doesn't exist here and isn't in scope (Out of Scope: multi-tenant credential scoping). `app_settings` already is this app's "one row of owner-level config" home; adding columns there reuses `settingsRepo.js`'s existing factory-over-`db` pattern and existing `ensureXColumns()` migration convention (see `db/index.js`) instead of introducing a second migration path and a second repo file for what is, structurally, the exact same kind of data.

## Data access layer (`settingsRepo.js`)

Two new method pairs, following the existing repo's plain-getter/setter style (no business logic inside the repo — "leave blank to keep existing" is resolved by the *caller*, not the repo):

```js
settingsRepo.getWhatsappCloudApiCredentials()
  → { verifyToken, accessToken, phoneNumberId, appSecret }  // each null if unset

settingsRepo.setWhatsappCloudApiCredentials({ verifyToken, accessToken, phoneNumberId, appSecret })
  → same shape, read back  // full overwrite of all 4 -- caller pre-merges "keep existing" values in

settingsRepo.getTelegramBotToken() → string | null
settingsRepo.setTelegramBotToken(token) → string | null  // read back
```

Same "no caching, every call hits SQLite directly" contract as `isAutoReplyEnabled()` (NFR-401) — multiple `settingsRepo` instances against the same `db` file always agree, which matters here specifically because `server.js` constructs its own instance at boot while `routes/settings.js` constructs another via `createApp()`'s internal wiring.

## Route layer (`routes/settings.js`)

Extends the existing router (already home to `POST /settings/auto-reply`) rather than a new router file — same `requireAuth` middleware, same file, since both are "single-owner dashboard settings," just two different settings groups.

```
GET  /settings/credentials   -- renders credentials.ejs with set/not-set flags (never the secret values)
POST /settings/credentials   -- merges submitted non-blank fields over existing DB values, saves, redirects
```

**"Leave blank to keep existing" is implemented at the route, not the repo**: `POST` handler reads current values via `getWhatsappCloudApiCredentials()`/`getTelegramBotToken()` first, then for each submitted field, `trim()`s it and substitutes the existing value if the trimmed result is empty, before calling the setter with the fully-resolved object. This keeps `settingsRepo` a dumb data-access layer (matches every other repo in this codebase) and keeps the "blank = keep" UX policy in the one place that actually renders/owns the form.

**Secrets never round-trip into HTML**: `GET`'s view-model only ever includes booleans (`whatsappAccessTokenSet`, etc.) derived from `Boolean(value)`, plus the one non-secret field (`whatsappPhoneNumberId`, shown in full — needed for the owner to cross-check against the Meta dashboard). The 4 secret values themselves never leave `settingsRepo` in the `GET` path.

## Composition root (`server.js`)

`main()` constructs a `settingsRepo` instance immediately after `createDb()` (before `productsRepo`, before the Telegram/Baileys branches) specifically so both credential reads below can use it:

```js
const settingsRepo = createSettingsRepo(db);
...
const telegramChannel = createTelegramChannel({ telegramBotToken: settingsRepo.getTelegramBotToken(), ... });
...
const waCreds = settingsRepo.getWhatsappCloudApiCredentials();
...
metaClient = createMetaClient({ accessToken: waCreds.accessToken, phoneNumberId: waCreds.phoneNumberId });
...
createApp({ ..., verifyToken: waCreds.verifyToken, appSecret: waCreds.appSecret, appSecretRequired: WHATSAPP_MODE === 'cloud_api' });
```

**No public-interface change to `createApp()`/`createWebhookRouter()`/`createTelegramChannel()` beyond the new `appSecretRequired` flag** (see Threat Model, SEC-1404) — all three still accept plain `verifyToken`/`appSecret`/`telegramBotToken` values exactly as before; only where `server.js` sources those values from changed (DB instead of `process.env`). This is what kept the blast radius on the existing test suite at zero: every pre-existing test that builds an app via `tests/helpers/testApp.js` (which still injects these as plain overrides) needed no changes.

**Boot-time hard requirement removed for the 4 WhatsApp Cloud API vars**: `assertRequiredEnv()`'s `CLOUD_API_REQUIRED_ENV_VARS` list (`WHATSAPP_VERIFY_TOKEN`/`WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/`WHATSAPP_APP_SECRET`) is deleted entirely — `BASE_REQUIRED_ENV_VARS` (`SESSION_SECRET`/`OWNER_USERNAME`/`OWNER_PASSWORD`) is untouched, since those still gate the dashboard login itself and can't move to a DB row behind that same login. `assertRequiredEnv()` also still validates `WHATSAPP_MODE` is one of the two known values — that's a boot-time infra choice, not a credential, and stays env-only.

## Migration (`db/index.js`)

`ensureAppSettingsColumns(db)` — same idempotent shape as `ensureLeadsColumns()`/`ensureFailedEventsColumns()`: read `PRAGMA table_info(app_settings)`, `ALTER TABLE ... ADD COLUMN <name> TEXT` for each of the 5 new columns not already present. Called from `createDb()` alongside the other two `ensure*Columns()` calls, in the same "always run, cheap, idempotent" spirit — not gated behind any version check.

## View (`credentials.ejs`)

New view, following the existing card-based layout style (`whatsappPair.ejs`'s `.card`/`.status-box` classes, same color palette/font stack) rather than introducing a new design language. Two `<div class="card">` blocks (WhatsApp Cloud API, Telegram) inside one `<form>` posting to the same endpoint — a single POST saves both groups together, since splitting into two separate forms/endpoints would double the route surface for no behavioral benefit (an owner configuring WhatsApp today and Telegram next week just submits the form twice; both submits are idempotent no-ops for the fields left blank each time, per the Business Rules in `fsd.md`).

## Nav (`partials/nav.ejs`)

One new link (`Credentials` → `/settings/credentials`), added to the existing shared nav partial alongside Leads/Products/Failed Events/Pairing — no new partial, matches FR-701's existing "one shared nav bar, one place to add a link" design.

## Fidelity check
Traced against this feature's settled decisions (direct conversation, `docs/sdd/changes/2026-09-03-credentials-in-db.md` "Settled Decisions"): single `app_settings` table extension (not a new table) — matches decision 2/3's framing of which env vars move vs. stay; `settingsRepo` plain getter/setter shape with route-level merge logic — matches the actual shipped `routes/settings.js` (`pick()` helper, trim-then-substitute); `appSecretRequired` flag mechanism — matches the actual shipped `webhook.js`/`app.js`/`server.js` wiring verified by `npx turbo run test --force` (225/225 passing) before this document was written. No drift found between this document and the shipped code.
