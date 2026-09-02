# Traceability — Global Ticket ID Counter

Started with feature 002 — feature 001's tickets (numbered 1101 through 1109, predating the TICKET-NNNN per-ticket-file convention) predate this file and are not backfilled here (see `specs/001-monorepo-migration/tickets/tickets.md`, which itself predates that convention).

| Ticket | Feature | Title |
|---|---|---|
| TICKET-1301 | 002-telegram-multichannel | App rename: whatsapp-lead-capture → lead-capture |
| TICKET-1302 | 002-telegram-multichannel | Schema migration (contact_id + channel) + repo/processor rename |
| TICKET-1303 | 002-telegram-multichannel | @rimba/telegram-connector package |
| TICKET-1304 | 002-telegram-multichannel | server.js composition-root wiring |
| TICKET-1305 | 002-telegram-multichannel | Media-message capture as attachment reference |
| TICKET-1306 | 002-telegram-multichannel | Dashboard channel badge + filter |
| TICKET-1307 | 002-telegram-multichannel | Full re-verify + migration report |

## Spine coverage (FSD / SEC)

| Spine ID | Defined in | Traced to |
|---|---|---|
| FSD-002 | specs/002-telegram-multichannel/fsd.md | TICKET-1303 (Flow 1 transport), TICKET-1305 (Flow 2 media), TICKET-1306 (Flow 3 dashboard) |
| SEC-1301 | specs/002-telegram-multichannel/threats.md | TICKET-1303 (`.env`-only token, never logged) |
| SEC-1302 | specs/002-telegram-multichannel/threats.md | TICKET-1307 (confirmed existing `extract-app.js` `.env` exclusion still applies, no Telegram-specific change needed) |
| SEC-1303 | specs/002-telegram-multichannel/threats.md | TICKET-1303 (defensive `Update` normalization in the connector) |
| SEC-1304 | specs/002-telegram-multichannel/threats.md | TICKET-1304 (shared inboundMessageProcessor already treats inbound text as untrusted; accepted, no new handling) |
| SEC-1305 | specs/002-telegram-multichannel/threats.md | TICKET-1305 (stores `file_id` reference only, never downloads bytes) |
| SEC-1306 | specs/002-telegram-multichannel/threats.md | TICKET-1304 (accepted risk, same class as WA, per Decision 001) |

Next free ticket ID: **TICKET-1401**.
