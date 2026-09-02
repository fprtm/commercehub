# Feature Index — Telegram Multichannel

## How to Review This Feature
1. `../sds.md` (~4 min) — architecture: composition-root multi-processor pattern, `@rimba/telegram-connector` design, app rename. Start here.
2. `../erd.md` (~2 min) — `phone_number`→`contact_id` rename + `channel` column, migration approach.
3. `../threats.md` (~2 min) — new `TELEGRAM_BOT_TOKEN` credential, media-reference-not-download decision (SEC-1305).
4. `../fsd.md` (~5 min) — flows, edge cases, error flows, business rules. Read before reviewing any ticket's implementation.
5. `../ux.md` (~1 min) — dashboard channel badge + filter, if reviewing the UI delta.
6. Tickets below, in dependency order — only the ones relevant to what you're reviewing next.
7. `docs/sdd/reports/2026-09-02-telegram-multichannel-review.md` (~2 min) — independent adversarial review, verdict PASS. Read this last, after forming your own view.

## Dependency graph
```
TICKET-1301 (app rename)                         -- independent, any time
TICKET-1303 (@rimba/telegram-connector package)   -- independent, parallel to 1302
TICKET-1302 (schema migration + repo/processor rename)
    ├─▶ TICKET-1304 (server.js composition-root wiring)  ◀── also needs TICKET-1303
    ├─▶ TICKET-1305 (media-message capture extension)
    └─▶ TICKET-1306 (dashboard channel badge + filter)
ALL ─▶ TICKET-1307 (full re-verify + report)
```

**Build order**: {1301, 1303} (either order, independent) → 1302 → {1304 (also needs 1303), 1305, 1306} (parallel) → 1307.

## Proposed breakdown (approval gate for BUILD — see individual ticket files for full detail)
1. **TICKET-1301** — App rename `whatsapp-lead-capture` → `lead-capture` — no blockers
2. **TICKET-1302** — Schema migration (`contact_id` + `channel`) + `leadsRepo`/`inboundMessageProcessor` rename — no blockers
3. **TICKET-1303** — `@rimba/telegram-connector` package (long polling, raw HTTPS) — no blockers
4. **TICKET-1304** — `server.js` composition-root wiring (concurrent channels) — blocked by #2, #3
5. **TICKET-1305** — Media-message capture as attachment reference — blocked by #2
6. **TICKET-1306** — Dashboard channel badge + filter — blocked by #2
7. **TICKET-1307** — Full re-verify + migration report — blocked by all

This is the same breakdown reasoning laid out during the SPEC run's deliberation (see `sds.md`/`fsd.md`) — presented here as the explicit confirmation point per this project's ticket-decomposition convention. **Flagging for confirmation now, retroactively**: these ticket files were written in the same pass as the specs rather than pausing for a separate go-ahead — if any ticket should be merged, split further, or reordered, say so before BUILD starts and the affected files get revised before any ticket moves to 🔨.
