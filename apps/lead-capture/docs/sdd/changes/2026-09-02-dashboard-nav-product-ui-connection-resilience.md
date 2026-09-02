# Change: Dashboard Navigation, Product Management UI, Baileys Connection Resilience

**Status:** APPROVED (discussed in conversation; product-UI scope confirmed via AskUserQuestion: full CRUD)
**Size:** medium
**Relates to:** original scope, `2026-09-01-fuzzy-product-matching.md` (Product concept), `2026-09-01-humanized-timing-module.md`, `2026-09-01-dual-mode Baileys` change

## Why
Three real gaps surfaced from actually using the app: (1) no way to navigate between dashboard pages without typing URLs; (2) products can only be managed by hand-editing `config/products.json`, which is impractical for a non-technical owner; (3) a real live test showed the Baileys connection getting logged out shortly after connecting, and tracing the code found the socket is created with zero identity/fingerprint configuration beyond bare defaults.

## Functional Requirements

- **FR-701** — A persistent navigation bar appears on every authenticated dashboard page (Leads, Products, Failed Events, Pairing), so no page requires typing a URL manually. *(Acceptance: each nav link is reachable from every other authenticated page.)*
- **FR-702** — A Products page lets the owner create, edit, and deactivate (soft-delete) products directly in the dashboard — full CRUD, no JSON file editing required going forward. Products move from `config/products.json` into the database as the source of truth; existing JSON-configured products are seeded into the database once (on first run after this change, if the products table is empty) so no existing catalog data is lost. *(Acceptance: after this change, editing `config/products.json` has no effect — the database is authoritative; a fresh install with no JSON file still works, starting with an empty catalog manageable entirely from the UI.)*
- **FR-703** — The Baileys socket is created with an explicit, realistic client identity (a `browser` tuple) instead of library defaults, plus a review of other commonly-recommended connection-stability options (e.g. `markOnlineOnConnect`, `syncFullHistory`) applied where they don't conflict with existing behavior. *(Acceptance: documented in code why each option was set the way it was; this is explicitly a mitigation, not a guaranteed fix — must be stated plainly in the README, not oversold.)*

## Non-Functional Requirements
- **NFR-701 (no regression)**: all 182 pre-existing tests continue passing unmodified.
- **NFR-702 (honesty)**: FR-703's README documentation must not claim this eliminates disconnect/ban risk — only that it follows commonly-recommended practice to reduce (not eliminate) it, consistent with every other risk disclosure already in this project.
- **NFR-703 (migration safety)**: the one-time JSON→database product seeding must not create duplicates if run more than once (e.g. re-seeding must be idempotent or gated on "table is empty").

## Out of Scope
**NOT NOW:** product images/categories, bulk import/export, undo for a deactivated product beyond re-activating it.

## Definition of Done
- [ ] FR-701–FR-703 implemented and verified
- [ ] NFR-701–NFR-703 verified, all pre-existing tests still passing
- [ ] README updated (product management workflow, honest framing of FR-703's connection-resilience changes)
