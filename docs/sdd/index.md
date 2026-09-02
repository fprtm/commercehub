# SDD Docs Index — commercehub

## Features (`specs/{NNN}-{slug}/`)
- **001-monorepo-migration** — Turborepo migration of Project 1 into `apps/whatsapp-lead-capture` (now renamed, see 002) + 3 shared packages. See `specs/001-monorepo-migration/`.
- **002-telegram-multichannel** — Telegram added as a second concurrent channel; app renamed to `apps/lead-capture`. Start at `specs/002-telegram-multichannel/tickets/00-index.md`.

## Changes (`changes/`, small-scope, no dedicated spec folder)
- `2026-09-02-reconnect-throttle.md` — Baileys reconnect-throttle mitigation (done, reviewed, `reports/2026-09-02-reconnect-throttle-review.md`).

## Decisions (`decisions/`)
- `001-telegram-multichannel.md` — Telegram scoped into the existing app, raw HTTPS + long polling, DB stays per-app.

## Reports (`reports/`)
- `2026-09-02-reconnect-throttle-review.md` — independent review, PASS.

## Other
- `glossary.md` — domain terms (Channel, Connector).
- `traceability.md` — global TICKET-xxx ID registry.
