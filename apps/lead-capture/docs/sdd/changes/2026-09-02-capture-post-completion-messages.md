# Change: Never Drop a Message, Even After the Q1/Q2 Flow Completes

**Status:** APPROVED (root-caused live via a real WhatsApp test; direction confirmed by user)
**Size:** small-medium
**Relates to:** original scope (US-003's core promise: "no lead depends on me seeing a chat notification in time"), fuzzy product matching change

## Why
A real live test surfaced a genuine violation of the project's core promise: once both qualifying questions are answered, `stateMachine.js` treats every subsequent message as `NO_OP` — completely dropped, not stored anywhere, no reply, not even logged. In the real test, the customer's actual product mention ("kaos rimba") arrived as a 3rd/4th message (after two earlier, low-content messages had already filled Q1/Q2), and was silently lost. Real conversations are messier than a clean 2-message exchange; the rigid "2 answers = done, ignore everything else" design breaks against that reality.

## Root Cause (confirmed by code trace, not guessed)
`stateMachine.js`: once `question1_answer` and `question2_answer` are both non-null, any further message resolves to `{ action: NO_OP, reason: 'flow_already_complete' }` — no Lead update, no reply, no record of the message ever having arrived.

## Functional Requirements

- **FR-801** — Once Q1 and Q2 are both answered, additional inbound messages from the same lead are appended to a new `additional_notes` field (a timestamped, running log) instead of being dropped. *(Acceptance: a message arriving after flow completion is never silently lost — it's visible somewhere in the Lead record.)*
- **FR-802** — Each additional post-completion message is also re-run through the existing fuzzy product matcher (from the earlier fuzzy-matching change). If it produces a higher-confidence match than the Lead's currently stored `matched_product`, the stored match is updated. A later message never downgrades an existing good match to a worse/no match. *(Acceptance: in the real scenario that surfaced this bug, "spill harga kaos rimba nya dong" arriving as message 3 would update `matched_product` to the correct product, not leave it at whatever the vague message 1 produced.)*
- **FR-803** — Any post-completion message sets `needs_review = true` regardless of match confidence — an ongoing conversation after the scripted flow ended always deserves a fresh look from the owner, not just a silent database update. *(Acceptance: verified by a test sending a 3rd message after Q1/Q2 completion and confirming `needs_review` flips true even if the message itself matches a product confidently.)*

## Non-Functional Requirements
- **NFR-801 (no regression)**: all 217 pre-existing tests continue passing unmodified.
- **NFR-802 (no reply spam)**: this change does NOT make the bot send a new automated reply to post-completion messages — the scripted Q&A flow is genuinely finished; this change only fixes *data capture*, not conversation continuation (sending further automated replies here is explicitly out of scope, to avoid re-opening the "how far does the script go" question this project deliberately keeps narrow).

## Out of Scope
**NOT NOW:** any automated reply to post-completion messages; a bounded/trimmed length for `additional_notes` (unbounded is acceptable for this project's scale); broader lead-schema changes (explicitly deferred to a separate, upcoming conversation about what else should be captured on a Lead).

## Definition of Done
- [ ] FR-801–FR-803 implemented and verified
- [ ] NFR-801–NFR-802 verified, all pre-existing tests still passing
- [ ] Dashboard (`leads.ejs`) displays `additional_notes` when present, so the owner can actually see it, not just have it exist in the database
- [ ] README updated
