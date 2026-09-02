# FSD: Connector Credentials Dashboard

**Feature:** 003-credentials-in-db
**Relates to:** `docs/sdd/changes/2026-09-03-credentials-in-db.md` (the delivery record — this FSD is the retroactive design doc for the same shipped change, written after BUILD at explicit user request rather than before it)

## Flow 1 — Owner views the credentials page for the first time (fresh install, nothing configured)

1. Owner is on any authenticated dashboard page (Leads, Products, Failed Events, Pairing) → clicks **Credentials** in the nav bar → `GET /settings/credentials`.
   - If not logged in → redirected to `/login` first (same `requireAuth` gate as every other dashboard route), then back to Credentials after a successful login is NOT auto-redirected — same behavior as every other dashboard route in this app (no post-login return-to-URL exists anywhere in this codebase; out of scope to add just for this page).
2. Page renders two cards:
   - **WhatsApp Cloud API**: Verify token, Access token, Phone Number ID, App secret — each labeled `(not set)` in red.
   - **Telegram**: Bot token — labeled `(not set)`.
3. Every input is empty (never pre-filled with a placeholder value that could be mistaken for a real one) — inputs use `type="password"` for the 4 secrets (masked while typing) and `type="text"` for Phone Number ID (not a secret, needed to cross-check against the Meta dashboard).
4. A footer note states plainly: changes take effect on the next server restart, not live.

## Flow 2 — Owner fills in WhatsApp Cloud API credentials

1. Owner types values into Verify token, Access token, Phone Number ID, App secret; leaves Telegram Bot token blank (not using Telegram yet).
2. Clicks **Save credentials** → `POST /settings/credentials`.
3. Server saves all 4 WhatsApp fields (all 4 submitted, none blank); Telegram bot token submitted blank → existing value (still `null`) is kept, i.e. no-op for that field.
4. Redirect → `GET /settings/credentials?saved=1`.
5. Page shows a green "Saved." banner. The 4 WhatsApp fields now show `(set)`; Phone Number ID's actual value is shown in the input (not a secret); Verify token/Access token/App secret inputs render **empty** (never re-populated with the saved secret, even though it's now stored) — the `(set)` badge is the only signal, by design (FR-1402).

## Flow 3 — Owner rotates one credential later, without re-entering the others

1. Owner returns to `GET /settings/credentials` weeks later (e.g. Meta forces an access-token rotation). Page shows all 5 fields as `(set)` (Phone Number ID shown in full, the rest masked/empty inputs).
2. Owner types a new value into **only** Access token; leaves every other field (including the 3 other WhatsApp secrets and the Telegram token, if that was also configured) blank.
3. `POST /settings/credentials` → only Access token changes; every other field's existing DB value is preserved untouched (FR-1403).
4. Redirect + "Saved." banner, same as Flow 2.

## Flow 4 — Server boot after credentials are (or aren't yet) configured

Not a page the owner interacts with directly, but the FSD-relevant consequence of Flows 1-3 — included because "what does saving actually cause" is part of this flow's acceptance:

1. Owner restarts the server (a deploy, a crash-restart, or a manual restart after saving — restart is required, per Flow 1's footer note).
2. `src/server.js` reads all 5 values fresh from the DB at boot (`settingsRepo.getWhatsappCloudApiCredentials()` / `getTelegramBotToken()`).
3. **WhatsApp**, mode = `cloud_api` (env-driven, unchanged by this feature):
   - All 4 fields set → `metaClient` constructed with real values; `POST /webhook` signature verification active.
   - Any of the 4 unset → server still boots (no crash); console logs a line pointing at `/settings/credentials`; `POST /webhook` rejects every request with `503` until the app secret specifically is set (FR-1406 — see threats.md SEC-1404).
4. **WhatsApp**, mode = `baileys`: this feature has zero effect — Baileys mode never reads any of the 4 WhatsApp Cloud API fields, exactly as before.
5. **Telegram**: bot token set (non-empty after trim) → Telegram channel starts, concurrently with WhatsApp, unchanged from how `TELEGRAM_BOT_TOKEN` (env var) behaved before this feature — only the data source moved.

## Edge cases

| Scenario | Behavior |
|---|---|
| Owner submits the form with every field blank (e.g. accidental double-submit, or just clicking Save without typing anything) | No-op: every field keeps its existing value. Still redirects to `?saved=1` and shows "Saved." — this is a known, accepted false-positive confirmation (nothing actually changed), not a bug; distinguishing "saved with changes" from "saved with no changes" was judged not worth the extra state for a single-owner internal tool. |
| A field submitted as only whitespace (e.g. a stray space from copy-paste) | Trimmed server-side, treated as blank → existing value kept, not overwritten with a whitespace string. |
| Owner is logged in but hits `POST /settings/credentials` directly (e.g. a saved request replayed) with a stale session that has since expired | `requireAuth` redirects to `/login`, same as any other authenticated route — no partial save occurs (the whole handler is gated, not per-field). |
| Two browser tabs open to Credentials; owner saves a change in tab A, then saves (with stale, now-blank inputs) from tab B | Tab B's blank submission is itself a no-op per the first row above — it does NOT revert tab A's change, since "blank" always means "keep whatever is currently in the DB," never "clear it" or "restore what this tab last saw." |
| Owner wants to actually clear a previously-set credential (e.g. remove a compromised token without replacing it) | **Not supported by this UI** (Out of Scope, see change doc) — requires direct DB access. Flagged here as a known gap, not silently omitted. |

## Business rules

- If a submitted field's trimmed value is empty → keep the existing DB value (never write an empty string, never null out a previously-set credential via this form).
- If a submitted field's trimmed value is non-empty → overwrite the existing DB value, whatever it was (no format/shape validation — Meta and Telegram's token formats are opaque and not worth hardcoding a pattern against, matching this app's existing "don't over-validate opaque third-party tokens" posture elsewhere).
- `WHATSAPP_MODE` (cloud_api vs baileys) is **not** part of this page or this DB row — it stays an env var, chosen once at boot (FR-301, pre-existing, unchanged).
- `POST /webhook` must reject (503), not silently skip verification, whenever the server is running in `cloud_api` mode and the app secret is unset — this is a hard rule enforced in code (`appSecretRequired`), not just a documented expectation (FR-1406).

## Performance requirements
Not applicable in any measurable sense: `GET`/`POST /settings/credentials` are single-row SQLite reads/writes on a table with exactly one row (`app_settings`, `id = 1`) — no pagination, no N+1 risk, no realistic load profile worth a stated budget for a single-owner internal dashboard. No performance requirement is stated here because none would be meaningful (matches this project's own restraint elsewhere against manufacturing NFRs that don't apply).

## Fidelity check
Re-checked against the shipped code while writing this document (not from memory of the build conversation): `credentials.ejs`'s 4 secret `<input>` elements have no `value=` attribute at all (confirmed by reading the file), so Flow 2 step 5's "never re-populated" claim is exact, not approximate. The blank-field-is-a-no-op business rule, the whitespace-trim behavior, and the `appSecretRequired`/503 behavior in Flow 4 are all traced directly to `routes/settings.js`'s `pick()` helper and `routes/webhook.js`'s early-return check, not paraphrased from an earlier summary. No drift found.
