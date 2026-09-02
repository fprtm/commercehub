# Change: Humanized Response Timing (Reusable Module)

**Status:** APPROVED (settled via discover; see `../decisions/001-realistic-timing-over-speed-budget.md` and `../decisions/002-reusable-humanized-timing-module.md`)
**Size:** medium (new reusable module, touches both connector modes, retires an existing NFR)
**Relates to:** retires NFR-001 in its original form (see Decision 001)

## Why
Instant, uniform-timing auto-replies are a visible "this is a bot" signal — both a UX rough edge (doesn't feel human) and, for Baileys mode specifically, a contributing factor to spam/ban-detection risk. A generic, reusable timing module makes replies feel human-paced: a short "read" delay (with a read receipt sent immediately, giving the customer early confirmation their message was seen), then a typing-indicator period scaled to the realistic time a human would take to type the outgoing message, then the message itself.

## Settled Decisions
1. **Fully realistic delay**, not capped/sped-up — accepted trade-off per Decision 001, mitigated by an early read-receipt.
2. **Built as a standalone, transport-agnostic module** — per Decision 002 — reusable by future projects/modules, not baked into WhatsApp-specific code.
3. Applied **uniformly to both connector modes** (Cloud API and Baileys) for one consistent behavior, even though only Baileys carries ban-risk motivation.
4. **Typing-indicator refresh**: Meta's Cloud API auto-dismisses the typing indicator after 25 seconds; for longer simulated typing durations, the indicator must be re-sent periodically (~every 20s) so it doesn't visibly disappear mid-delay.

## Functional Requirements

- **FR-601** — Before sending any automated reply (ack, question, retry, or fallback), the system sends a "read" receipt, waits a short randomized delay (e.g., 1–3s), then sends a typing indicator, waits a duration proportional to the outgoing message's length at a realistic human typing pace, then sends the message. *(Acceptance: message send is measurably delayed relative to message receipt, proportional to reply length; a read receipt is observably sent before the delay begins.)*
- **FR-602** — The timing module is transport-agnostic: it accepts callback functions for `markAsRead`, `sendTypingIndicator`, and `sendMessage`, and contains no WhatsApp-specific or mode-specific code itself. *(Acceptance: the module's own test suite runs with mock callbacks and no dependency on `metaClient.js`/`baileysConnector.js`.)*
- **FR-603** — For a simulated typing duration exceeding ~20 seconds, the typing indicator is re-sent periodically so it never visibly lapses before the message is sent. *(Acceptance: a test simulating a long reply confirms multiple typing-indicator calls at the expected interval, not just one.)*
- **FR-604** — Both `metaClient.js`'s send path and `baileysConnector.js`'s send path are adapted to route through the shared module rather than sending immediately. *(Acceptance: both connector modes exhibit the same delay behavior; existing mocked tests are updated to account for the new timing without changing what they assert about final message content.)*

## Non-Functional Requirements
- **NFR-601 (retires NFR-001)**: see Decision 001 — no fixed maximum reply-time budget; delay is realistic and length-proportional by design.
- **NFR-602 (reusability)**: the module has zero import-time dependency on any WhatsApp-specific module (verified by the module living in a path/package with no such imports).
- **NFR-603 (no regression)**: all pre-existing tests continue passing — since timing changes are real delays, tests must control/mock the delay mechanism (not literally sleep in the test suite) to stay fast and deterministic.

## Out of Scope
**NOT NOW:** per-client-configurable typing speed/personality, delay behavior differing by message type beyond length-proportionality.

## Definition of Done
- [ ] FR-601–FR-604 implemented and verified
- [ ] NFR-601–NFR-603 verified, all pre-existing tests still passing (with delay mechanism mocked/controlled in tests, not literally slept through)
- [ ] README updated explaining the timing behavior and the NFR-001 retirement, honestly, as a deliberate trade-off
