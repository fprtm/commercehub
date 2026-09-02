# TICKET-1301 — Rename app: `whatsapp-lead-capture` → `lead-capture`

**Feature**: 002-telegram-multichannel
**Refs**: SDS §"App rename (FR-1301)"
**Tier**: T3
**Status**: ⬜ todo
**Dependencies**: none
**Files likely touched:** `apps/whatsapp-lead-capture/**` (moved to `apps/lead-capture/**`), `package.json` (root), `apps/lead-capture/package.json`, `scripts/extract-app.js`
**Claimed by:** _(empty)_

## What to Build
Rename the app directory and every reference to its old path, with git history preserved.

## Deliverables
- `git mv apps/whatsapp-lead-capture apps/lead-capture`
- `package.json` (root) → `workspaces: ["apps/lead-capture", "packages/*"]` (modified)
- `apps/lead-capture/package.json` → `"name": "lead-capture"` (modified)
- `scripts/extract-app.js` → usage-comment example updated to `apps/lead-capture` (modified)

## Acceptance Criteria (Given/When/Then)
- [ ] Given the rename is done, when `npm install && npx turbo run test` runs from repo root, then it passes identically to before the rename (same pass/fail counts).
- [ ] Given the rename is done, when `git log --follow -- apps/lead-capture/src/services/leadsRepo.js` runs, then it shows the file's full pre-rename commit history.
- [ ] Given the rename is done, when `node scripts/extract-app.js lead-capture <out-dir>` runs, then it produces a standalone extractable app identically to how it worked pre-rename for `whatsapp-lead-capture`.

## Out of Scope
- Any reference inside `docs/sdd/specs/001-monorepo-migration/*` or other historical docs — those are records of what was true when written, left unmodified (see SDS's explicit reasoning).
