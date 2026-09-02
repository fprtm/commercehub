# TICKET-1307 — Full re-verify + migration report

**Feature**: 002-telegram-multichannel
**Refs**: DoD (change spec + this feature's specs, FSD-002)
**Tier**: T3
**Status**: ✅ done — independent adversarial review complete, verdict **PASS** (High confidence). See `docs/sdd/reports/2026-09-02-telegram-multichannel-review.md` for full findings (moved there from `specs/002-telegram-multichannel/review.md` post-review — `review.md` isn't an allowed filename inside a spec bundle per `check-file-hygiene.mjs`; reports live in `docs/sdd/reports/`, matching the `2026-09-02-reconnect-throttle-review.md` precedent). Fixed 3 stale `apps/whatsapp-lead-capture/...` path references in `packages/whatsapp-connector/README.md` as part of this ticket's cleanup scope; also fixed the stale `"name": "whatsapp-lead-capture"` in `apps/lead-capture/package-lock.json` (flagged by the review as non-blocking cosmetic drift — confirmed harmless since `extract-app.js` never copies this file, but fixed anyway since it was cheap).
**Dependencies**: TICKET-1301, TICKET-1302, TICKET-1303, TICKET-1304, TICKET-1305, TICKET-1306
**Files likely touched:** `docs/sdd/reports/2026-09-02-telegram-multichannel-review.md` (new)
**Claimed by:** _(empty)_

## What to Build
An independent, adversarial re-verification of the whole feature (matching this project's established review discipline — every build gets a fresh-context review before being considered done) plus a written report.

## Deliverables
- `docs/sdd/reports/2026-09-02-telegram-multichannel-review.md` → same format as `docs/sdd/reports/2026-09-02-monorepo-migration-review.md`: verdict, confidence, what was independently traced/verified, human-verify items, blind spots (new)

## Acceptance Criteria (Given/When/Then)
- [x] Given the full suite runs (`npx turbo run test --force`), when compared against the pre-feature baseline, then every pre-existing test still passes and new package/ticket tests are counted, with no silently-weakened assertions. — Re-run independently, not from cache: 5/5 tasks pass, 310 total tests (10+10+44+35+211), 0 failing, 0 skipped, 0 todo.
- [x] Given the WA flow (Baileys + Cloud API) is exercised, when compared to pre-feature behavior, then it is byte-for-byte unaffected (same reasoning already required in TICKET-1304's acceptance). — Confirmed by diffing `server.js` against pre-feature commit `59b0caf`: every WA-specific line unchanged, only additive Telegram code inserted.
- [x] Given `scripts/extract-app.js` is run against `lead-capture`, when the output is inspected, then `.env`/credentials are still excluded (SEC-1302) and `TELEGRAM_BOT_TOKEN` specifically is confirmed absent from the exported tree. — Ran a real extraction; only `.env.example` (secret-free template) survived, `.env` excluded, `@rimba/telegram-connector` correctly vendored.
- [x] Given `git log --follow` is run on a renamed file, when inspected, then full pre-rename history is present (confirms TICKET-1301 didn't silently break history preservation). — `git log --follow -- apps/lead-capture/src/services/leadsRepo.js` shows the full 8-commit history back to the initial commit.

## Out of Scope
- None — this ticket's entire purpose is comprehensive verification of everything above it.
