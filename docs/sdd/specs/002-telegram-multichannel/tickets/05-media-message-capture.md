# TICKET-1305 — Media-message capture as attachment reference

**Feature**: 002-telegram-multichannel
**Refs**: FSD Flow 2, FR-1304, threats.md SEC-1305
**Tier**: T2
**Status**: ⬜ todo
**Dependencies**: TICKET-1302
**Files likely touched:** `apps/lead-capture/src/services/inboundMessageProcessor.js`, `apps/lead-capture/tests/inboundMessageProcessor.test.js`
**Claimed by:** _(empty)_

## What to Build
Extend the existing "never silently drop a message" capture path to also fire for non-text messages carrying a media reference — creating the lead if needed, never analyzing the media content itself. Applies uniformly to any channel (not Telegram-only).

## Deliverables
- `inboundMessageProcessor.js` → new branch: when `messageType !== 'text'` and a `mediaRef` param is present, append `[timestamp] <media diterima: type=X, ref=Y>` to `additional_notes` (creating the lead first if this is the contact's first-ever message), flag `needs_review=true`, send no reply (modified)
- If a caption (`messageBody`) is also present alongside the media, the caption still runs through the normal product-matching flow, unaffected (modified — confirms the media note is additive, not a replacement of existing caption-handling)

## Acceptance Criteria (Given/When/Then)
- [ ] Given a first-ever message from a contact is a photo with no caption, when processed, then a new Lead row is created with `contact_id`/`channel` set, `additional_notes` containing the media reference note, `needs_review=true`, and zero replies sent.
- [ ] Given an existing lead mid-flow sends a photo with a caption that matches a product, when processed, then the caption drives the normal product-matching flow (Q2 sent, `matched_product` updated) AND the media reference note is also appended to `additional_notes`.
- [ ] Given a WA contact (not Telegram) sends a sticker, when processed, then the same media-capture behavior applies — this is not gated on `channel`.

## Out of Scope
- Downloading/analyzing the media content — reference (`mediaRef`) only, per SEC-1305.
- Any reply acknowledging receipt of the media ("thanks for the photo") — no copy decision made for this, deliberately deferred.
