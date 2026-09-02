# Review: Reconnect Throttle for Baileys (commit 3118c38)

**Verdict:** PASS
**Confidence:** HIGH
**Spec:** `docs/sdd/changes/2026-09-02-reconnect-throttle.md`

## What was verified independently (fresh-context reviewer, no access to build report)
- **Ramp math (FR-1201/NFR-1202)**: `calculateReconnectThrottleMultiplier` (`packages/whatsapp-connector/src/baileysConnector.js:52-67`) is a pure function. Hand-verified: t=0→3x, t=30s→2x, t=60s→1x (boundary), t=90s→1x. Negative time clamps to max; `null`/`undefined` → 1x (first-connect exemption).
- **First-connect vs. reconnect (FR-1202)**: `hasConnectedOnce` gate at `baileysConnector.js:406-425` correctly limits throttling to the second-and-later `'open'` events. A second reconnect correctly restarts its own window (verified by hand + test at line 620). `resetAndRestart()` (re-pairing) resets both `hasConnectedOnce`/`lastReconnectAt` — a new linked-device session is treated as first-connect, not a reconnect of the old session (defensible judgment call).
- **Real wiring**: traced end-to-end `server.js:151` → `inboundMessageProcessor.js:462` → `baileysConnector.js:524-528` — the throttle delay sits on the actual reply path, not dead code.
- **Cloud API isolation (NFR-1201)**: `metaClient.js` diff against the change is empty; zero coupling.
- **Test suite**: `npx turbo run test --force` run independently — 4/4 tasks pass, whatsapp-connector 44/44, whatsapp-lead-capture 199/199, no regressions.
- **Test quality**: the 12 new tests use an injectable fake clock/sleep and assert against real state transitions (not tautological, not mocking the function under test).
- **Configurability (FR-1203)**: window/max-multiplier/base-delay are real factory options with defaults falling back to named constants, threaded through and covered by an explicit override test.
- **Code quality**: no dead code, README honestly framed ("reduces, doesn't eliminate").

## Judgment block
- **Weakest point**: none structural. The one naming overlap (`*_BASE_DELAY_MS` used for two different concepts — reconnect backoff vs. send-throttle unit) is comment-guarded, not a functional risk.
- **Hallucination-risk zones**: none — every claim was independently traced to file:line and hand-computed, not taken from the build agent's self-report.
- **Security escalation**: none.

## Human-verify items
- Real-world confirmation that this measurably reduces WA restriction incidents is inherently unverifiable in a code review — only time/usage will tell. Spec's own framing ("reduces, doesn't eliminate risk") already sets that expectation.

## Blind spots (honest disclosure)
- Production wiring (`apps/whatsapp-lead-capture/src/server.js:162`) runs entirely on default throttle constants — no env-var override wired yet. Not a spec violation (FR-1203 only requires configurability, not ops-level env wiring), just worth knowing if tuning is wanted later.
