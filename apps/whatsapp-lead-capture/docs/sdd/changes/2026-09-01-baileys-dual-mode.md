# Change: Dual-Mode WhatsApp Connector (Official Cloud API + Baileys)

**Status:** APPROVED (discussed and settled in conversation — user explicitly requested execution: "gas", priority = reliability/stability)
**Size:** small-medium (one new adapter behind an existing interface boundary, no change to state machine/DB/dashboard)
**Relates to:** `2026-09-01-whatsapp-lead-capture.md` (original approved scope) — this change extends it, does not replace it

## Why

Discussed trade-off: the official WhatsApp Cloud API requires Meta Business verification and per-message cost, which is friction a brand-new/small client may not be ready for. Baileys (unofficial, reverse-engineered protocol) has zero setup friction and no cost, at the cost of ToS-violation ban risk — lower risk specifically for Project 1's actual usage pattern (reply-only to inbound messages, not broadcast), but not zero. Decision: offer both, official as the recommended default, Baileys as an explicit lower-cost/higher-risk tier, with the risk disclosed to the client every time.

**Explicitly rejected:** WAHA (adds a separate self-hosted service + heavier runtime — disproportionate for a small client's VPS) and n8n (this app already has its own purpose-built orchestration logic; n8n would duplicate it, not simplify it).

## Scope

### FR-301 — Mode selection via configuration
The WhatsApp connector mode (`cloud_api` or `baileys`) is selected via an environment variable at startup, not switchable at runtime. *(Acceptance: the app boots into exactly the mode configured; the unconfigured mode's code path is not touched.)*

### FR-302 — Shared inbound/outbound contract
Both modes implement the same internal interface — `sendTextMessage(phoneNumber, text)` and a shared `processInboundMessage(phoneNumber, messageBody, messageType)` function that drives the existing state machine unchanged. *(Acceptance: the state machine, Lead repo, and dashboard code have zero mode-specific branching — only the two adapter modules differ.)*

### FR-303 — Baileys session pairing
A one-time QR-code pairing screen (`GET /whatsapp/pair`, session-authenticated, owner-only) lets the owner link their WhatsApp number to the app when running in Baileys mode. *(Acceptance: after a successful scan, the session persists across app restarts without re-scanning.)*

### FR-304 — Automatic reconnection with backoff
If the Baileys connection drops for any recoverable reason (network blip, WhatsApp-side restart), the app automatically reconnects with exponential backoff, without manual intervention or a process restart. *(Acceptance: a simulated disconnect event triggers a reconnect attempt; repeated failures back off rather than hammering in a tight loop.)*

### FR-305 — Non-recoverable disconnects are visible, not silent
If Baileys reports a non-recoverable disconnect (e.g., the owner logged the session out from their phone), this is logged as a `FailedEvent` (`channel=whatsapp_baileys`) and the pairing screen (FR-303) shows a clear "reconnect needed" state — never a silent, permanently-dead bot with no indication why. *(Acceptance: this specific disconnect reason does not trigger the auto-reconnect loop from FR-304, since retrying a logged-out session is pointless; it surfaces the pairing screen instead.)*

## Non-Functional Requirements

- **NFR-301 (Stability — the explicit priority for this change)**: the Baileys connection survives ordinary network interruptions without manual restart, verified by a test that simulates a mid-session disconnect and confirms automatic recovery.
- **NFR-302 (No regression)**: all 61 of Project 1's existing tests continue passing unmodified in `cloud_api` mode — this change must not touch the official API path's behavior at all.
- **NFR-303 (Honesty)**: the pairing screen and README explicitly state the ban-risk trade-off in plain language whenever Baileys mode is active — this is a client-facing disclosure, not just an internal code comment.

## Out of Scope

**NOT NOW:** live runtime mode-switching without a restart, multi-device Baileys session management beyond one paired number, WAHA/wwebjs as alternate engines (Baileys only).
**NEVER FOR THIS PROJECT:** n8n integration (rejected above, not a fit for this app's architecture).

## Definition of Done
- [ ] FR-301–FR-305 implemented and verified
- [ ] NFR-301–NFR-303 verified, including a simulated-disconnect reconnection test
- [ ] All pre-existing 61 tests still pass unmodified
- [ ] README updated with the honest Baileys risk disclosure and setup instructions for both modes
