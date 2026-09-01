# Review — Humanized Response Timing Module

Independent review against `../changes/2026-09-01-humanized-timing-module.md` and decisions 001/002.

## Findings

| # | Issue | Requirement | Severity | Outcome |
|---|---|---|---|---|
| 1 | `metaClient.js`'s (default/recommended Cloud API mode) `markAsRead`/`sendTypingIndicator` had zero test coverage despite spy plumbing already existing for it — a regression here would pass the whole suite undetected. | FR-604, NFR-603 | Medium | **Fixed** — 9 new unit tests + 1 webhook.js integration test exercising the real wiring. |
| 2 | `markAsRead` was silently skipped whenever a message produced zero replies (already-closed lead, fallback-already-triggered, etc.) — undocumented edge case cutting against Decision 001's reassurance rationale. | FR-601 | Low-Medium | **Fixed (decision b)** — `markAsRead` now fires unconditionally per inbound message while auto-reply is ON, regardless of reply count. |
| 3 | (Bonus, self-found during the fix) `sendWithHumanizedTiming`'s jitter used real `Math.random()` with no injectable override, causing one integration test to intermittently emit a different typing-indicator-refresh count run-to-run. | Test determinism | Minor | **Fixed** — `random` threaded through the same injectable path as `sleep`; confirmed deterministic across 3 consecutive full-suite runs. |

## Verdict: **PASS**

128/128 tests. Both Cloud API and Baileys connector paths now have equivalent test depth for the timing feature. The read-receipt reassurance mechanism (Decision 001's mitigation for retiring the 5-second reply budget) now fires consistently on every genuinely new inbound message, not just ones that happen to produce a scripted reply.
