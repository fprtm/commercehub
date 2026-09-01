# Change: Auto-Reply ON/OFF Toggle

**Status:** APPROVED (settled via lightweight discover pass — Why/Constraints/What/Data/Technical seats, all recommendations confirmed by user)
**Size:** small
**Relates to:** original approved scope (`2026-09-01-whatsapp-lead-capture.md`)

## Why
Owner currently has no way to pause the automated WhatsApp flow without editing an env var and restarting the server. Not owner-friendly, and was missing from the original FR list entirely.

## Settled Decisions
1. **When OFF**, inbound messages are still logged as a Lead (data is never lost), but no auto-reply/qualifying-question flow is sent — the bot goes quiet, not the data pipeline.
2. **Scope v1**: manual ON/OFF only. No scheduling/quiet-hours (deferred, MAYBE LATER).
3. **UI location**: a toggle at the top of the existing Lead dashboard (SCR-001) — no new settings page.
4. **Data storage**: a new single-row `app_settings` table (`auto_reply_enabled` boolean, default `true`) — not a generic key-value store (would be premature abstraction for one setting today).

## Functional Requirements

- **FR-401** — The Lead dashboard shows the current auto-reply state (ON/OFF) and a control to toggle it. *(Acceptance: toggling persists immediately and is reflected on next page load.)*
- **FR-402** — When `auto_reply_enabled=false`, an inbound WhatsApp message (via either connector mode) still creates/updates a Lead record exactly as today, but no outbound reply (acknowledgment, question, retry, or fallback message) is sent. *(Acceptance: a message received while OFF produces a Lead row with no corresponding outbound send recorded; toggling back ON does not retroactively message that customer.)*
- **FR-403** — When `auto_reply_enabled=true` (default), behavior is unchanged from the current implementation. *(Acceptance: all existing FR-001–FR-008/FR-301–FR-305 tests still pass unmodified.)*

## Non-Functional Requirements
- **NFR-401**: the setting is read fresh on each inbound message (no caching that could serve a stale value for more than one request cycle).
- **NFR-402 (no regression)**: all existing tests (87 as of the last change) continue passing unmodified in the default ON state.

## Out of Scope
**NOT NOW:** scheduled/quiet-hours auto-off, per-customer override, a dedicated settings page.

## Definition of Done
- [x] FR-401–FR-403 implemented and verified
- [x] NFR-401–NFR-402 verified, all pre-existing tests still passing
- [x] README updated
