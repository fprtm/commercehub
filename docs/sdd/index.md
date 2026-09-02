# SDD Docs Index — commercehub

## Features (`specs/{NNN}-{slug}/`)
- **001-monorepo-migration** — Turborepo migration of Project 1 into `apps/whatsapp-lead-capture` (now renamed, see 002) + 3 shared packages. See `specs/001-monorepo-migration/`.
- **002-telegram-multichannel** — Telegram added as a second concurrent channel; app renamed to `apps/lead-capture`. Built, reviewed (PASS), `reports/2026-09-02-telegram-multichannel-review.md`. Start at `specs/002-telegram-multichannel/tickets/00-index.md`.
- **003-credentials-in-db** — WhatsApp Cloud API + Telegram credentials moved from `.env` to the DB, `/settings/credentials` dashboard page. Written retroactively (code shipped first, spec'd after at explicit user request) — see `changes/2026-09-03-credentials-in-db.md` for the delivery record. Read order: `specs/003-credentials-in-db/fsd.md` (~3 min, start here) → `sds.md` (~2 min) → `erd.md` (~1 min) → `threats.md` (~2 min, read this one regardless — it documents a real HIGH-severity finding an automated review caught and this feature fixed).

## Changes (`changes/`, small-scope, no dedicated spec folder)
- `2026-09-02-reconnect-throttle.md` — Baileys reconnect-throttle mitigation (done, reviewed, `reports/2026-09-02-reconnect-throttle-review.md`).
- `2026-09-03-credentials-in-db.md` — WhatsApp Cloud API + Telegram credentials moved from `.env` to the DB, editable at `/settings/credentials` (done).

## Decisions (`decisions/`)
- `001-telegram-multichannel.md` — Telegram scoped into the existing app, raw HTTPS + long polling, DB stays per-app.

## Reports (`reports/`)
- `2026-09-02-reconnect-throttle-review.md` — independent review, PASS.
- `2026-09-02-telegram-multichannel-review.md` — independent review of 002-telegram-multichannel, PASS.
- `2026-09-03-baileys-contactid-and-failed-events-migration-fix.md` — post-review fix: Baileys `contactId` contract drift (silent channel breakage) + `failed_events.channel` migration gap, both found by independent adversarial review. PASS, HIGH confidence.

## Other
- `glossary.md` — domain terms (Channel, Connector).
- `traceability.md` — global TICKET-xxx ID registry + FSD/SEC spine coverage.

## Recent Activity
- [2026-09-03] Task: baileys-contactid-and-failed-events-migration-fix — 2 bugs fixed, 14 traceability problems resolved → [report](reports/2026-09-03-baileys-contactid-and-failed-events-migration-fix.md)
- [2026-09-03] Task: credentials-in-db — WhatsApp/Telegram credentials moved from `.env` to DB, new `/settings/credentials` dashboard page → [change](changes/2026-09-03-credentials-in-db.md)
