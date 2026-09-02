# Threat Model: Connector Credentials Dashboard

**Feature:** 003-credentials-in-db

## Context

This feature moves 5 credentials from `.env` (filesystem, never network-reachable) into `app_settings` (SQLite, read/written via 2 new authenticated HTTP routes). Two things changed the attack surface: (1) a new authenticated write path for secrets that didn't exist before, and (2) the removal of a boot-time hard requirement that previously guaranteed `WHATSAPP_APP_SECRET` was always set in any running `cloud_api`-mode deployment.

## Access control on the new routes

| ID | Threat | Severity | Response |
|---|---|---|---|
| SEC-1401 | Unauthenticated request reads or writes credentials via `GET`/`POST /settings/credentials` | High | **Mitigate**: both routes gated by the same `requireAuth` session middleware every other dashboard route uses (`middleware/requireAuth.js`) — no new auth mechanism introduced, no gap between this route and e.g. `/products` or `/leads`. Verified by test (`credentials.test.js`: both GET and POST redirect to `/login` when unauthenticated; the POST test additionally confirms the DB is untouched by the rejected request, not just that the HTTP response redirects). |
| SEC-1402 | A previously-saved secret is echoed back into rendered HTML (e.g. via a `value="<%= savedSecret %>"` attribute), exposing it to anyone who can view-source the authenticated page, or to a browser extension/proxy that logs page content | High | **Mitigate by design, not by escaping**: the `GET` view-model (`routes/settings.js`'s `credentialFieldStates()`) only ever derives `Boolean(value)` for the 4 secret fields — the actual string values never leave `settingsRepo` on the read path. The one field shown in full, Phone Number ID, is not a secret (it's the identifier the owner needs to cross-check against the Meta dashboard, no more sensitive than a public API endpoint path). Verified by test (`credentials.test.js`: after saving real-looking token values, asserts the rendered HTML does NOT contain any of the 4 secret strings, and DOES contain the Phone Number ID). |

## Data at rest

| ID | Threat | Severity | Response |
|---|---|---|---|
| SEC-1403 | Credentials are stored as plaintext `TEXT` columns in `data/leads.db`, not encrypted at rest — anyone with filesystem read access to that one file (or a copy/backup of it) can read all 5 secrets directly | Medium | **Accept**: this is not a new trust boundary for this app — `OWNER_PASSWORD` itself (the credential that gates every other route in this app, including these new ones) is already a plaintext string comparison (`routes/auth.js`: `password === ownerPassword`), sourced from `.env`, which lives on the exact same filesystem `data/leads.db` does. Encrypting these 5 columns while the login password and every other operational secret in this app remain plaintext-on-disk would raise the bar for one data class without raising the actual trust boundary (filesystem access to this server), which is already the boundary every other secret in this app depends on. Worth revisiting only if this app's trust model changes (e.g. multi-tenant, or DB backups leaving this server's control) — flagged as an explicit Out of Scope item in the change doc, not silently omitted. |

## Availability of signature verification (the post-review finding)

| ID | Threat | Severity | Response |
|---|---|---|---|
| SEC-1404 | Removing the boot-time hard requirement for `WHATSAPP_APP_SECRET` (previously `process.exit(1)` if unset) means a real `cloud_api`-mode deployment can now run indefinitely with no app secret configured. `POST /webhook`'s pre-existing `if (appSecret) { verify } else { skip }` logic would, unmodified, silently accept and process **any** unsigned payload during that window — an attacker doesn't need Meta to be configured to find and POST to a predictable `/webhook` path, so "nobody's pointed a real Meta integration here yet" is not a mitigation (this was this feature's first-draft reasoning; an automated security review flagged it HIGH and it was corrected same-day, before this feature was considered done) | **High** | **Mitigate**: new `appSecretRequired` flag (`routes/webhook.js`), set to `true` only by `src/server.js`'s real `cloud_api`-mode boot (never by tests, never by `WHATSAPP_MODE=baileys`, which has no Meta integration to verify against at all — see `sds.md`). When `true` and `appSecret` is unset, `POST /webhook` returns `503` before any processing — the endpoint refuses to accept events at all while unconfigured, rather than accepting them unverified. This restores, at request time, the exact guarantee the deleted boot-time check gave at process-start time. Verified by test (`webhook.test.js`: rejects with 503 + zero leads + zero FailedEvents when required-and-unset; still verifies signatures normally once configured; explicit regression test proving every pre-existing test — which never sets this flag — is unaffected). |

## Logging

| ID | Threat | Severity | Response |
|---|---|---|---|
| SEC-1405 | The `credentials_updated` log event (emitted on every `POST /settings/credentials`) leaks a saved secret value into application logs | Low | **Mitigate**: the event only records `*Changed: boolean` per field (derived from `Boolean(req.body.field?.trim())`), never the submitted value itself — same "never logged" rule this codebase already applies to connector-level token handling (Telegram's SEC-1301 in `specs/002-telegram-multichannel/threats.md`), extended here to the dashboard save path. |

## Out of scope for this threat model
Encryption at rest (SEC-1403, accepted as consistent with this app's existing trust model); a "clear this field" control and its own threat surface (not built — Out of Scope in the change doc); multi-tenant credential isolation (this app has one owner, one credential set, per the SDS's Architecture Decision).

## Fidelity check
Every "Verified by test" line above was checked against the actual test file/assertions while writing this document, not asserted from memory: `credentials.test.js`'s 5 tests and `webhook.test.js`'s 3 new `appSecretRequired` tests were re-read line-by-line to confirm each cited assertion (redirect status, DB-untouched check, HTML doesNotMatch/match pairs, 503 + zero-leads + zero-FailedEvents, the explicit regression test) actually exists as described, matching `npx turbo run test --force`'s 225/225 passing result. SEC-1403's claim about `routes/auth.js`'s plaintext password comparison was confirmed by reading that file directly. No drift found.
