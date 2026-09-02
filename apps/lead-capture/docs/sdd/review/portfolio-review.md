# Portfolio Review — Project 1: WhatsApp Lead Capture & Auto-Responder

Independent review conducted by an agent with no access to the implementation report — findings compared spec docs directly against code. First pass verdict: **CHANGES REQUIRED**. All 4 substantive issues were fixed; this file reflects the final, re-verified state.

**Test suite (final):** `node --test` → **61 passed, 0 failed** (up from 53 at first pass — 8 tests added covering the retry path and the closed-lead lifecycle guard).

## Issues Found and Resolution

| # | Issue | Requirement | Severity | Outcome |
|---|---|---|---|---|
| 1 | Webhook signature verification failed open — `WHATSAPP_APP_SECRET` wasn't required at boot, so a misconfigured deploy would silently accept unsigned payloads | NFR-003 | Major | **Fixed** — `WHATSAPP_APP_SECRET` added to `REQUIRED_ENV_VARS`; server now refuses to boot without it |
| 2 | FR-007's spec text named "an unrelated question" as a fallback trigger; the code (correctly) only checks structural fit, not semantic relevance, since that needs NLP/LLM which is out of scope | FR-007 | Major | **Fixed** — spec amended (not the code) to state structural-fit-only, with an explicit cross-reference to the existing "MAYBE LATER: AI-powered dynamic qualifying questions" scope item, so spec and code now agree |
| 3 | FR-002 promised a retry ("one follow-up attempt") before falling back; code went straight to fallback on the first unusable message | FR-002 | Minor–Major | **Fixed** — implemented a real retry: first unusable message re-sends the pending question once with a configurable prefix, second failure triggers fallback; covered by 10 new tests |
| 4 | Lifecycle diagram says `closed` is terminal; UI/backend both allowed `closed → responded` | FR-006, Phase K | Minor | **Fixed** — backend rejects any status change once a lead is `closed` (400, same path as an invalid status), UI shows no action buttons on a closed lead |
| 5 | FR-004/T-007 notification reuses `status='new'` as the "unseen" flag rather than a dedicated field | FR-004, T-007 | Nit | **No change needed** — practically equivalent at this scope; noted in the case study rather than changed |
| 6 | No timeout on the outbound Meta API call — a hung call could block past NFR-001's 5-second budget | NFR-001 | Minor | **Skipped for now** — acknowledged, deliberately deferred; flagged below as a known gap, not silently dropped |
| 7 | `better-sqlite3`'s native install script needs `allow-scripts` approval — could break a "fresh environment, under 5 minutes" demo on a stricter machine | DoD/T-012 | Nit | **Skipped for now** — documented as an environment prerequisite in the app README instead of a code change |

## Dimension-by-Dimension Verdict (post-fix)

1. **Original client problem** — solves it directly: instant ack, two qualifying questions, centralized lead log, no scope drift toward CRM/broadcast/payments. ✅
2. **User stories US-001–US-006** — all six genuinely satisfiable by the shipped code (verified by the independent reviewer reading the actual route/service code, not just file names). ✅
3. **Functional requirements FR-001–FR-008** — all eight now match their literal acceptance criteria, including the two that failed the first pass (FR-002, FR-007). ✅
4. **Negative scope** — clean; grep-verified no broadcast/payment/CRM/i18n/SSO/multi-tenant code exists anywhere in `app/`. ✅
5. **Technical decisions TD-001–TD-004** — all four confirmed followed in code, including an adversarial trace of TD-004's "always 200" behavior through the invalid-JSON body-parser edge case. ✅
6. **Business workflow vs. Phase H diagrams** — happy path, fallback path (now with retry), and error path all match the Mermaid sequence diagrams; Workflow 2 (dashboard) matches including the 404 stale-ID case. ✅
7. **Security/correctness spot-check** — HMAC signature verification is now unconditionally enforced at boot, constant-time comparison confirmed, all secrets read from env vars only, all SQL uses parameterized `better-sqlite3` prepared statements — no string-concatenated SQL anywhere. ✅

## Overall Verdict: **PASS**

Justification against the DoD checklist in `../changes/2026-09-01-whatsapp-lead-capture.md`:
- [x] FR-001–FR-008 implemented and verified against their literal acceptance criteria (61 passing automated tests + the independent reviewer's manual code trace)
- [x] NFR-001–NFR-005 verified, including a deliberate fault-injection test for NFR-002 and a now-mandatory signature check for NFR-003
- [x] Demo script rehearsed under 5 minutes (`../verification/demo-verification.md`) — honestly labeled as a scripted `curl` rehearsal, not a live human/WhatsApp walkthrough (live Meta round-trip remains untested — no real credentials in this environment, called out explicitly rather than implied)
- [x] Out-of-scope audit clean, independently re-confirmed
- [x] Two known, deliberately-deferred minor gaps (Meta call timeout, native-build-script environment note) are documented, not hidden

Two honest limitations carried forward into the case study rather than papered over: (1) no live round-trip against a real WhatsApp Business number was possible in this environment, and (2) the outbound Meta API call has no request timeout, which is a real (if minor) risk to the 5-second reply budget under a slow/hung upstream call.
