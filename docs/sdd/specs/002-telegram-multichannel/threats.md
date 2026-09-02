# Threat Model: Telegram Channel

**Feature:** 002-telegram-multichannel

## New trust boundary
Long polling (`getUpdates`) is an **outbound** connection this app initiates to `api.telegram.org` — unlike the Cloud API webhook (which requires a public inbound HTTPS endpoint that Meta pushes to), Telegram mode opens **no new inbound port/route on this app**. The only inbound surface is Telegram's own response to a request this app made. This is a strictly smaller attack surface than the existing Cloud API webhook, not a new one.

## New credential
`TELEGRAM_BOT_TOKEN` — same risk class as existing `META_ACCESS_TOKEN`/WA credentials.

| ID | Threat | Severity | Response |
|---|---|---|---|
| SEC-1301 | Token committed to git / leaked via logs | High | **Mitigate**: `.env`-only (never hardcoded), covered by the existing `.gitignore` credential patterns (already covers `.env`, `credentials.json`, `*.pem`, `*.key` — `TELEGRAM_BOT_TOKEN` needs zero new gitignore entries since it lives in `.env`, already covered). Never logged — connector must not include the token in any `log()` call (the URL path contains it: `https://api.telegram.org/bot<token>/...` — logging the request URL verbatim would leak it; log the endpoint name only, e.g. `'telegram_get_updates'`, never the constructed URL). |
| SEC-1302 | Token extracted from client-delivery export (`scripts/extract-app.js`) | High | **Already mitigated by existing design**: the extraction script's `.env`-exclusion (established in the monorepo-migration ADR/build) is credential-agnostic — it excludes `.env` wholesale, so this needs no Telegram-specific change, only confirmation the existing exclusion still applies (covered in ticket verification). |

## Input validation — inbound Update payloads
| ID | Threat | Severity | Response |
|---|---|---|---|
| SEC-1303 | Malformed/unexpected `Update` JSON shape from `getUpdates` response (Telegram API change, or a proxy/MITM tampering with the polling response) crashes the poll loop | Medium | **Mitigate**: connector normalizes defensively — missing/unexpected fields produce a skipped update + a logged warning, never an uncaught exception that kills the poll loop. One malformed update must not take down the whole channel. |
| SEC-1304 | A crafted `text` field (e.g. extremely long string, control characters) reaches the state machine / product matcher | Low | **Accept**: identical risk already exists for WA text messages today (no new surface) — `matchProduct`/`decideNextAction` already treat inbound text as untrusted, no special handling added or needed for Telegram specifically. |

## Media handling (FR-1304 — capture reference only, never download bytes)
| ID | Threat | Severity | Response |
|---|---|---|---|
| SEC-1305 | Downloading and storing arbitrary user-uploaded file bytes (malicious file content, disk exhaustion, path-traversal via a crafted filename) | Medium (if bytes were downloaded) | **Mitigate by design, not by hardening**: this spec's chosen implementation never downloads the file at all — only Telegram's own `file_id` string (an opaque reference redeemable later via Telegram's API, not a path, not attacker-controlled content) is stored in `additional_notes`. This is a stronger mitigation than input-sanitizing a downloaded file would be, because the vulnerable code path (writing arbitrary bytes to this server's disk) simply doesn't exist. Judgment call, not from the discovery fork (that fork settled "capture without analyzing," not "download vs. reference-only") — flagged here as the spec-level security decision it is. |

## Denial of service
| ID | Threat | Severity | Response |
|---|---|---|---|
| SEC-1306 | A single Telegram user spams messages, exhausting humanized-timing send capacity / flooding the leads table | Low | **Accept**: identical risk class already exists for WA (no rate-limiting was in scope for either channel per Decision 001's "NOT NOW: rate-limiting total messages/hour" and the reconnect-throttle change's own out-of-scope note). Not new, not worsened by adding Telegram. |

## Out of scope for this threat model
Telegram-side account/bot compromise (stolen bot token used outside this app) — same class as a stolen WA API token, no Telegram-specific control needed beyond SEC-1301/1302 above.
