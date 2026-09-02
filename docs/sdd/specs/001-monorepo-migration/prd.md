# PRD: Turborepo Monorepo Migration (Project 1 + 3 Shared Packages)

**Status:** APPROVED (settled via full SDD Grill session — frontier + council pass; see `../../../decisions/001-monorepo-shared-packages.md` in `portfolio-projects/`)
**Size:** large (new tooling, git history surgery, 3 new package boundaries, a delivery-tooling script, full migration of an existing production-like app)
**Relates to:** `project-01-whatsapp-lead-capture` (276 tests, 7 review rounds) — the source being migrated

## Why
See the ADR for full context. Summary: Project 1 has diverged significantly from Projects 2/3 (which forked it early and never received later fixes). Rather than accept indefinite duplicate-maintenance risk, extract the genuinely reusable, schema-independent modules into shared packages inside a proper monorepo, so future fixes propagate automatically to whatever depends on them, and future client work can assemble from proven components instead of starting from scratch. Projects 2/3 are explicitly NOT touched in this round — only Project 1 migrates now.

## Scope

### FR-1101 — Monorepo skeleton
A Turborepo-managed monorepo with `apps/` and `packages/` workspaces, root `package.json` + `turbo.json` configured for at least `dev`, `test`, and `build` tasks with proper dependency-graph-aware caching (a package's tests re-run when the package changes; an app's tests re-run when the app OR any package it depends on changes).

### FR-1102 — Project 1 migrated into `apps/whatsapp-lead-capture`, history preserved
The existing `project-01-whatsapp-lead-capture` app moves into `apps/whatsapp-lead-capture/` inside the monorepo via `git subtree` (or equivalent), preserving its full 10-commit history under the new path — not a fresh history, not a squash.

### FR-1103 — `packages/humanized-timing`
The existing, already-portable `src/lib/humanizedTiming.js` module (zero WhatsApp-specific imports, per its own Decision 002) becomes a standalone package with its own `package.json`, tests, and a clean public export (`sendWithHumanizedTiming`, `calculateTypingDurationMs`). The app depends on it via the workspace protocol.

### FR-1104 — `packages/whatsapp-connector`
`baileysConnector.js` and `metaClient.js` (dual-mode WhatsApp send/receive + connection resilience) become a package exposing a uniform interface regardless of mode: `sendTextMessage`, `markAsRead`, `sendTypingIndicator`, an inbound-message subscription mechanism, `start()`, and connection-status/QR-retrieval hooks (the app's `/whatsapp/pair` route and view stay in the app — presentation layer — but consume this package's exposed status/QR hooks rather than reimplementing connector internals). *(Acceptance: the app's existing 276-test suite's WhatsApp-related tests pass against the packaged version with no behavior change.)*

### FR-1105 — `packages/product-matcher`
`productMatcher.js` becomes a package with the interface it already effectively has: `matchProduct(customerText, products: [{id, name, aliases}], options)` → match result, fully decoupled from any specific app's Product schema (no `productsRepo`/DB dependency inside the package — the app passes plain data in). Includes the intent-denylist and ambiguity-margin logic already hardened through 4 review rounds this session.

### FR-1106 — Client-delivery extraction script
`scripts/extract-app.js <app-name> <output-dir>`: copies the named app, and for each workspace package it depends on, inlines that package's source into a local vendored path within the output (rewriting the app's `package.json` to reference the local path, not the workspace protocol) — producing a standalone folder that needs nothing beyond `npm install`, no registry, no monorepo context. *(Acceptance: running the script for `whatsapp-lead-capture`, then running `npm install && npm test` inside ONLY the extracted output folder — with the monorepo root deleted or renamed out of the way for the test — passes cleanly.)*

### FR-1107 — Security guardrail on the extraction script
The extraction script must explicitly exclude any `.env`, credentials, or `data/` (local DB/session) files from both the app and any vendored packages — verified by a test that plants a fake secret file in the source and confirms it's absent from the extracted output.

## Non-Functional Requirements
- **NFR-1101 (no regression)**: the migrated app's full test suite (276 tests) passes identically after migration — same pass count, no weakened assertions.
- **NFR-1102 (history integrity)**: `git log --follow` on any file under `apps/whatsapp-lead-capture/` inside the monorepo shows its full pre-migration commit history, not just a single "initial import" commit.
- **NFR-1103 (package independence)**: each of the 3 packages' own test suites can run in isolation (`cd packages/X && npm test`) without needing the app or the other packages present.
- **NFR-1104 (Turborepo caching correctness)**: changing only `packages/humanized-timing`'s source and running the root test task re-runs tests for `humanized-timing` and `whatsapp-lead-capture` (which depends on it), but does NOT need to re-run anything unrelated (there's nothing else yet, but the dependency graph must be correctly declared for this to hold once more apps/packages exist).

## Out of Scope
**NOT NOW:** migrating Projects 2/3 into the monorepo; publishing packages to any registry; a 4th shared package for state-machine/lead-schema logic (explicitly project-specific, not shared); deleting the standalone `project-01-whatsapp-lead-capture` repo (happens only after explicit human confirmation post-verification, not part of this build).

## Definition of Done
- [ ] FR-1101–FR-1107 implemented and verified
- [ ] NFR-1101–NFR-1104 verified
- [ ] Independent review pass (matching this session's established discipline)
- [ ] A short migration report confirming: test count before/after, history-preservation proof, extraction-script demo output
