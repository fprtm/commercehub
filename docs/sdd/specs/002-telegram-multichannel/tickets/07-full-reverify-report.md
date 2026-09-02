# TICKET-1307 — Full re-verify + migration report

**Feature**: 002-telegram-multichannel
**Refs**: DoD (change spec + this feature's specs)
**Tier**: T3
**Status**: ⬜ todo
**Dependencies**: TICKET-1301, TICKET-1302, TICKET-1303, TICKET-1304, TICKET-1305, TICKET-1306
**Files likely touched:** `docs/sdd/specs/002-telegram-multichannel/review.md` (new)
**Claimed by:** _(empty)_

## What to Build
An independent, adversarial re-verification of the whole feature (matching this project's established review discipline — every build gets a fresh-context review before being considered done) plus a written report.

## Deliverables
- `docs/sdd/specs/002-telegram-multichannel/review.md` → same format as `001-monorepo-migration/review.md`: verdict, confidence, what was independently traced/verified, human-verify items, blind spots (new)

## Acceptance Criteria (Given/When/Then)
- [ ] Given the full suite runs (`npx turbo run test --force`), when compared against the pre-feature baseline, then every pre-existing test still passes and new package/ticket tests are counted, with no silently-weakened assertions.
- [ ] Given the WA flow (Baileys + Cloud API) is exercised, when compared to pre-feature behavior, then it is byte-for-byte unaffected (same reasoning already required in TICKET-1304's acceptance).
- [ ] Given `scripts/extract-app.js` is run against `lead-capture`, when the output is inspected, then `.env`/credentials are still excluded (SEC-1302) and `TELEGRAM_BOT_TOKEN` specifically is confirmed absent from the exported tree.
- [ ] Given `git log --follow` is run on a renamed file, when inspected, then full pre-rename history is present (confirms TICKET-1301 didn't silently break history preservation).

## Out of Scope
- None — this ticket's entire purpose is comprehensive verification of everything above it.
