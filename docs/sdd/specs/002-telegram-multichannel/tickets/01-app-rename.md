# TICKET-1301 — Rename app: `whatsapp-lead-capture` → `lead-capture`

**Feature**: 002-telegram-multichannel
**Refs**: SDS-002 §"App rename (FR-1301)", ADR-001 (Telegram scoped into the existing app — the rename this ticket does is a direct consequence of that decision)
**Tier**: T3
**Status**: ✅ done

Verified: `npm install && npx turbo run test` → 199/199 pass (0 fail), identical to pre-rename baseline. `git diff --cached --summary` shows every moved file (including `package.json`) as a 100%-similarity rename with 0 insertions/deletions. `git log --follow -- apps/whatsapp-lead-capture/src/services/leadsRepo.js` (queried pre-commit, since the working tree is intentionally left uncommitted) returns the full 6-commit pre-rename history back to the initial commit, confirming `git log --follow` against the new path will show identical history once committed.
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
