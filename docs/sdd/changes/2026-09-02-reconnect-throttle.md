---
description: Ramp send delay back up gradually after a Baileys reconnect, to reduce WhatsApp ban/restriction risk from reconnect-churn
status: done
updated: 2026-09-02
---

# Change: Reconnect Throttle for Baileys (Anti-Detection Mitigation)

**Status:** APPROVED (real-world trigger: a test WhatsApp number was temporarily restricted by WhatsApp's spam detection after repeated rapid connect/disconnect cycles during dev-server testing; research confirmed frequent reconnects are a documented, independent ban-risk factor, separate from message volume)
**Size:** small
**Relates to:** `packages/whatsapp-connector` (Baileys-specific; Cloud API has no persistent-connection concept to hook into this)

## Why
Research (cited in conversation, see sources: WhiskeySockets/Baileys issues #2110/#1869, multiple 2026 anti-ban writeups) confirms: (1) frequent reconnects/re-pairs are an independent, documented ban-risk trigger, separate from message content/volume; (2) a documented mitigation exists — after reconnecting, gradually ramp send rate back up over roughly 60 seconds instead of resuming at full speed immediately, mimicking human resumption behavior. We do not currently do this: our connector resumes normal-speed sending immediately after any reconnect.

## Functional Requirements

- **FR-1201** — After the Baileys connection re-establishes following a disconnect (a genuine reconnect, not the first connection of a fresh session), outbound message sends during a cooldown window (default 60s from reconnect) get additional delay on top of the existing humanized-timing delay, easing back to normal speed as the window elapses (a simple linear ramp is sufficient — e.g., 3x extra delay immediately after reconnect, linearly decreasing to 1x/normal at the 60s mark). *(Acceptance: a message sent 1 second after a reconnect is delayed noticeably longer than the same message sent 90 seconds after a reconnect.)*
- **FR-1202** — The very first connection of a session (never previously disconnected) does NOT get this extra throttle — only genuine reconnections after a disconnect. *(Acceptance: first-ever connect sends at normal humanized-timing speed, no extra delay.)*
- **FR-1203** — Cooldown window duration and ramp behavior are configurable (constants with sane defaults), not hardcoded magic numbers scattered in logic.

## Non-Functional Requirements
- **NFR-1201 (no regression)**: all existing tests continue passing unmodified; Cloud API mode is entirely unaffected (no connection-lifecycle concept to throttle).
- **NFR-1202 (testability)**: the ramp calculation must be a pure, directly-testable function (given time-since-reconnect, return the delay multiplier) — not buried inside async timing logic that's hard to assert against.

## Out of Scope
**NOT NOW:** rate-limiting total messages/hour (a different, message-volume-based risk factor, not what triggered this specific incident); applying this to Cloud API (no connection concept there); the `baileys-antiban` community middleware found during research (not vetted, not adopted here — this change implements only the specific, well-evidenced technique found).

## Definition of Done
- [ ] FR-1201–FR-1203 implemented and verified
- [ ] NFR-1201–NFR-1202 verified
- [ ] README updated explaining the mitigation and citing the research reasoning (honest framing: reduces risk, doesn't eliminate it — consistent with every other risk disclosure in this project)
