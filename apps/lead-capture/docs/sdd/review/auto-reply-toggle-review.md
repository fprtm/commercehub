# Review — Auto-Reply ON/OFF Toggle

Independent review against `../changes/2026-09-01-auto-reply-toggle.md`.

## Findings

| # | Issue | Requirement | Severity | Outcome |
|---|---|---|---|---|
| 1 | If a customer messages twice during/around an OFF window, their next reply after re-enabling can reference a question they were never actually sent (state advances on DB bookkeeping, independent of whether the send succeeded). This is a pre-existing property shared with the Meta-send-failure path (not new), but the toggle makes it a routine occurrence instead of a rare failure case. | FR-402 (UX nuance, not a spec violation) | Minor | **Not fixed now** — doesn't violate any literal acceptance criterion; logged here as a known rough edge for a future iteration (e.g., re-send the unacknowledged question on the customer's next message instead of assuming it was seen). Owner should be told to expect this if pausing mid-conversation. |
| 2 | No test explicitly exercises OFF+RETRY / OFF+FALLBACK specifically (suppression is structurally guaranteed by one shared gate covering all reply types, verified by code reading). | NFR-401 (test depth) | Nit | Not fixed — low value given the code structure already makes this correct by construction. |
| 3 | No CSRF token on the toggle endpoint. | — | Nit | Not fixed — matches the app's existing pattern everywhere else (e.g., lead status updates); not a new or worse gap introduced by this feature. |

No blockers or major issues.

## Verdict: **PASS**

100/100 tests (87 pre-existing confirmed unmodified via git diff, 13 new). Owner can pause/resume the bot from the dashboard; every message is still logged as a Lead while paused; no automated reply of any kind (ack, question, retry, fallback) leaks through while OFF; re-enabling never triggers a backlog of unsent messages.
