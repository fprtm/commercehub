# Review — Dual-Mode WhatsApp Connector (Baileys)

Independent, adversarial review against `../changes/2026-09-01-baileys-dual-mode.md`, with explicit priority on the user's stated top requirement: stability/reconnection.

## Issues Found and Resolution

| # | Issue | Requirement | Severity | Outcome |
|---|---|---|---|---|
| 1 | Only `loggedOut` was treated as a permanent disconnect; `badSession`, `connectionReplaced`, and `forbidden` (also genuinely permanent per the library's own enum) were retried forever with the pairing screen telling the owner "no action needed" indefinitely — a silently-dead bot with a false all-clear message. | FR-304, FR-305, NFR-301 | **Blocker** | **Fixed** — inverted to an explicit allowlist of recoverable reasons; everything else (including the three found here) now stops retrying, logs a `FailedEvent`, and shows a reason-specific "action needed" message. Verified with 4 new tests, each asserting zero reconnects scheduled + the correct status + a logged FailedEvent. |
| 2 | If `start()` itself threw during a scheduled reconnect attempt, the retry chain silently died — no further reconnect, no FailedEvent, frozen UI. | NFR-301, FR-304 | Major | **Fixed** — a `start()` failure during a reconnect attempt now schedules another backoff attempt instead of dead-ending. Verified with a test forcing `start()` to reject and asserting the backoff continues growing (not reset, not abandoned). |
| 3 | No chained end-to-end test firing a scheduled callback through to a confirmed `'open'` recovery. | NFR-301 (test depth) | Minor | Left as-is — the pieces (scheduling, and separately, success-resets-counter) are each independently tested; acceptable coverage gap, not a suspected defect. |
| 4 | Session-persistence round-trip across two real connector instances isn't integration-tested (relies on Baileys' own `useMultiFileAuthState`). | FR-303 (test depth) | Nit | Left as-is — cannot be tested without a real paired WhatsApp account in this environment. |
| 5 | Most reconnect tests call the private handler directly rather than emitting a real socket event (one test does emit a real event, proving the wiring once). | NFR-301 (test depth) | Nit | Left as-is — disclosed honestly in the code, reasonable test-design trade-off. |

## Verdict: **PASS** (after Finding 1 and 2 were fixed)

- All 61 original Project 1 tests unmodified and passing (byte-diff confirmed).
- All 20 original Baileys tests + 6 new ones from the fix pass: **87/87 total**.
- FR-301 (mode isolation), FR-302 (shared contract), NFR-302 (no regression), NFR-303 (honesty disclosure), and security (auth-gated pairing screen, gitignored session folder, no secrets logged) all independently confirmed clean on the first review pass.

**Plain-language summary of the stability goal:** the bot now correctly tells the difference between "temporary hiccup, keep trying with increasing patience" and "this connection is actually dead, stop retrying and tell the owner exactly why" — covering all the realistic permanent-failure cases (logged out, re-paired to another device, corrupted session, blocked by WhatsApp), not just one of them. A failure during the retry process itself no longer silently kills future recovery attempts either. This is the behavior that was asked for.
