# Task Plan — WhatsApp Lead Capture & Auto-Responder

Phase M (task breakdown) + Phase N (build order). Every task traces back to a requirement in `../changes/2026-09-01-whatsapp-lead-capture.md` or a decision in `../design/technical-design.md`.

## Tasks

**T-001 — Project foundation**
- Requirement Coverage: NFR-003
- Description: Initialize Node.js + Express app, environment config loading (`.env` + `.env.example`), base folder structure, a `/health` check route.
- Dependencies: none
- Acceptance Criteria: `npm start` runs a server that responds 200 on `GET /health`; no secrets committed to source control.
- Verification Method: manual run + `curl localhost:PORT/health`
- Expected Output: repo skeleton, `package.json`, `.env.example`, health route.

**T-002 — Core data model (Lead, FailedEvent)**
- Requirement Coverage: FR-003, Phase K data model
- Description: Implement the SQLite schema for `Lead` and `FailedEvent` exactly as specified in Phase K, with a migration script.
- Dependencies: T-001
- Acceptance Criteria: schema fields/types/constraints match Phase K exactly; migration runs cleanly against an empty DB file.
- Verification Method: run migration, inspect resulting schema via `sqlite3` CLI.
- Expected Output: migration script, schema definition.

**T-003 — Config-driven qualifying-question script**
- Requirement Coverage: NFR-005
- Description: Load the qualifying-question text/order from an external config file rather than hardcoding it.
- Dependencies: T-001
- Acceptance Criteria: editing the config file changes the questions sent, with no code change required.
- Verification Method: manual test with two different config versions.
- Expected Output: `config/questions.json` (or equivalent) + loader module.

**T-004 — Webhook verification endpoint**
- Requirement Coverage: (Meta platform requirement, precursor to FR-001)
- Description: Implement `GET /webhook` per Meta's verification handshake contract (Phase L).
- Dependencies: T-001
- Acceptance Criteria: returns `hub.challenge` on a matching verify token, `403` otherwise.
- Verification Method: unit test + manual `curl` against both matching and non-matching tokens.
- Expected Output: route + test.

**T-005 — Qualifying-question state machine**
- Requirement Coverage: FR-002, FR-007, US-002
- Description: Given a Lead's current state and an inbound message, determine the next action (send Q1 / send Q2 / trigger fallback / mark flow complete). This is the core business logic of the whole project.
- Dependencies: T-002, T-003
- Acceptance Criteria: a defined table of input-state/message → expected-action cases all pass, including the fallback case (unrecognized message).
- Verification Method: unit tests (this logic gets the most test investment per Phase P priorities).
- Expected Output: state machine module + unit test suite.

**T-006 — Inbound webhook processing**
- Requirement Coverage: FR-001, FR-002, FR-003, FR-007, FR-008, NFR-001, NFR-002
- Description: `POST /webhook` — verify Meta's signature header, create/update the Lead record, invoke the state machine (T-005), call the Meta Graph API to send the appropriate reply, always return `200` (TD-004).
- Dependencies: T-004, T-005, T-002
- Acceptance Criteria: a simulated Meta payload produces the correct Lead record and the correct reply content (mocked Meta client in tests); a simulated processing failure produces exactly one `FailedEvent` record and the endpoint still returns `200`.
- Verification Method: integration test against a test DB with a mocked Meta client; one manual round-trip test against a real Meta WhatsApp test number.
- Expected Output: webhook handler + integration tests.

**T-007 — Owner notification on new lead**
- Requirement Coverage: FR-004
- Description: Flag a newly created Lead as unseen/new so the dashboard can surface it to the owner.
- Dependencies: T-006
- Acceptance Criteria: a new Lead is visibly distinguishable from previously-seen leads on first dashboard load after creation.
- Verification Method: manual check — create a lead, confirm it's visually flagged on the dashboard.
- Expected Output: notification flag/indicator logic.

**T-008 — Owner login (SCR-002)**
- Requirement Coverage: NFR-003, Authentication Strategy (Phase I)
- Description: Session-based single-owner login gate in front of the dashboard.
- Dependencies: T-001
- Acceptance Criteria: correct credentials establish a session and redirect to `/leads`; incorrect credentials show an error and do not establish a session.
- Verification Method: manual test + integration test for both paths.
- Expected Output: login route + session middleware.

**T-009 — Lead dashboard (SCR-001)**
- Requirement Coverage: FR-005, US-005, NFR-004
- Description: `GET /leads` — render leads most-recent-first with phone, timestamp, Q1/Q2 answers, status; show an empty-state message when there are no leads.
- Dependencies: T-002, T-008
- Acceptance Criteria: correct sort order and field display with seeded data; correct empty-state message with no data.
- Verification Method: manual test with seeded data and with an empty DB.
- Expected Output: EJS template + route.

**T-010 — Lead status update**
- Requirement Coverage: FR-006, US-004, US-006
- Description: `POST /leads/:id/status` — update a Lead's status to `responded` or `closed`.
- Dependencies: T-009
- Acceptance Criteria: valid update persists and is reflected after reload; non-existent `id` returns `404` with a plain-language message; invalid `status` value returns `400`.
- Verification Method: manual test + integration test for all three cases.
- Expected Output: route + validation logic.

**T-011 — Failure-logging verification**
- Requirement Coverage: NFR-002
- Description: Deliberately inject a processing fault (e.g., a malformed webhook payload) and confirm the failure path from T-006 behaves as specified.
- Dependencies: T-006
- Acceptance Criteria: exactly one `FailedEvent` record is created, the webhook still acknowledges `200`, no lead data is silently lost.
- Verification Method: manual fault-injection test.
- Expected Output: test case + confirmed `FailedEvent` record as evidence.

**T-012 — Demo script rehearsal**
- Requirement Coverage: DoD checklist
- Description: Rehearse the full happy-path demo (customer message → auto-reply → Q1/Q2 → lead in dashboard → mark responded) end to end.
- Dependencies: T-001–T-011
- Acceptance Criteria: complete walkthrough finishes in under 5 minutes on a fresh environment.
- Verification Method: timed dry run.
- Expected Output: `demo-verification.md` (Phase R).

**T-013 — Deployment**
- Requirement Coverage: Deployment Strategy (Phase I)
- Description: Deploy to a low-cost PaaS with persistent storage for the SQLite file; configure the live URL as the Meta webhook target.
- Dependencies: T-001–T-011
- Acceptance Criteria: app reachable at a public URL; Meta's webhook verification succeeds against the live URL.
- Verification Method: live Meta webhook verification test.
- Expected Output: deployed instance + deployment notes.

**T-014 — Out-of-scope audit**
- Requirement Coverage: DoD checklist, negative scope in the changes file
- Description: Confirm none of the NOT NOW / NEVER items were accidentally built during implementation.
- Dependencies: T-001–T-013
- Acceptance Criteria: checklist review against the changes file's Out of Scope section comes back clean.
- Verification Method: manual review.
- Expected Output: confirmation note appended to the DoD checklist.

## Build Order (Phase N)

| Step | Maps to |
|---|---|
| 1. Project foundation | T-001 |
| 2. Core data model | T-002 |
| 3. Core business logic | T-003, T-005 |
| 4. Critical user workflow | T-004, T-006, T-007 |
| 5. Integration layer (Meta Graph API client) | embedded in T-006 |
| 6. Error handling | T-011 |
| 7. Secondary workflows (dashboard, login, status update) | T-008, T-009, T-010 |
| 8. UI polish | intentionally minimal — NFR-004 asks for plain usability, not visual polish; no dedicated polish task beyond what T-009 already requires |
| 9. Testing | embedded per-task above, confirmed complete at T-012 |
| 10. Review | `/sdd-pipeline:check`-equivalent pass → `portfolio-review.md` (Phase Q) |
| 11. Deployment preparation | T-013, T-014 |

Implementation proceeds in this order — no task past step 4 starts before the critical workflow (T-001, T-002, T-003, T-005, T-004, T-006, T-007) is working end-to-end, per Phase O's "do not spend excessive time polishing before the core workflow works" rule.
