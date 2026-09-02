# TICKET-1305 — Media-message capture as attachment reference

**Feature**: 002-telegram-multichannel
**Refs**: FSD Flow 2, FR-1304, threats.md SEC-1305
**Tier**: T2
**Status**: ✅ done
**Dependencies**: TICKET-1302
**Files likely touched:** `apps/lead-capture/src/services/inboundMessageProcessor.js`, `apps/lead-capture/tests/inboundMessageProcessor.test.js`
**Claimed by:** _(empty)_

## What to Build
Extend the existing "never silently drop a message" capture path to also fire for non-text messages carrying a media reference — creating the lead if needed, never analyzing the media content itself. Applies uniformly to any channel (not Telegram-only).

## Deliverables
- `inboundMessageProcessor.js` → new branch: when `messageType !== 'text'` and a `mediaRef` param is present, append `[timestamp] <media diterima: type=X, ref=Y>` to `additional_notes` (creating the lead first if this is the contact's first-ever message), flag `needs_review=true`, send no reply (modified)
- If a caption (`messageBody`) is also present alongside the media, the caption still runs through the normal product-matching flow, unaffected (modified — confirms the media note is additive, not a replacement of existing caption-handling)

## Acceptance Criteria (Given/When/Then)
- [x] Given a first-ever message from a contact is a photo with no caption, when processed, then a new Lead row is created with `contact_id`/`channel` set, `additional_notes` containing the media reference note, `needs_review=true`, and zero replies sent.
- [x] Given an existing lead mid-flow sends a photo with a caption that matches a product, when processed, then the caption drives the normal product-matching flow (Q2 sent, `matched_product` updated) AND the media reference note is also appended to `additional_notes`.
- [x] Given a WA contact (not Telegram) sends a sticker, when processed, then the same media-capture behavior applies — this is not gated on `channel`.

## Out of Scope
- Downloading/analyzing the media content — reference (`mediaRef`) only, per SEC-1305.
- Any reply acknowledging receipt of the media ("thanks for the photo") — no copy decision made for this, deliberately deferred.

## Verification (post-implementation)

Implemented the media-capture branch in `processInboundMessage`
(`apps/lead-capture/src/services/inboundMessageProcessor.js`) with a new
optional `mediaRef` param. All 3 Given/When/Then ACs above are covered by
new tests in `apps/lead-capture/tests/inboundMessageProcessor.test.js`
(photo/no-caption first contact -> Lead created, note appended,
`needs_review=1`, zero replies; photo+caption mid-flow -> normal
product-matching flow (Q2 sent, `matched_product` set) with the media note
appended additively; WA — non-Telegram — sticker -> same treatment, proving
no channel gating). Full repo suite: `npx turbo run test` -> 306 passing
(baseline was 299), 0 failures.

**"First message is media, no lead exists yet" edge case:** traced
`decideNextAction()` in `stateMachine.js` and confirmed its `!existingLead`
branch (`START_FLOW`) already returns `createLead: true` *unconditionally*
for literally any first-ever message from a contact, regardless of
`hasUsableText(messageText)` — it does not gate lead creation on text
content at all. So `inboundMessageProcessor.js`'s pre-existing
`if (decision.createLead) { lead = leadsRepo.create(...) }` block (near the
top of the function, well before this ticket's new branch) already creates
the row and assigns it to `lead` for a media-only first contact, with no
new lead-creation code needed for this ticket. The one genuine gap was that
`START_FLOW` also unconditionally queues `replies: [ack, q1Text]`, which
would have violated AC1's "zero replies sent" for a caption-less first
message. The new branch appends the media note onto the just-created (or
pre-existing) `lead`, flags `needs_review=true`, and — specifically when
`!hasUsableText(messageBody)` (no caption) — resets `replies` back to `[]`
regardless of what the normal decision already queued (START_FLOW's
ack+Q1, or a mid-flow RETRY/FALLBACK/ANSWER_Q2 prompt), so a media-only
turn never sends a scripted reply. When a caption IS present, that reset is
skipped entirely and the normal text-driven `replies` (and product-matching
side effects) pass through untouched — the media note is purely additive
in that case, per FR-1304/point 3.
