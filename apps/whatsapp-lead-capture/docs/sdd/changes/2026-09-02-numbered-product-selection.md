# Change: Numbered Product List as Primary Q1 Selection (Text-Based, Not Native UI)

**Status:** APPROVED (settled in conversation — deliberately NOT native WhatsApp list/button UI, which was researched and rejected: feels too obviously automated, undercuts the humanized-timing work, and creates a Cloud-API-vs-Baileys UX asymmetry since Baileys officially dropped native button/list support in 2024)
**Size:** medium
**Relates to:** `2026-09-01-fuzzy-product-matching.md` and its 3 subsequent fix rounds (the hardened matcher becomes a fallback layer, not the primary path)

## Why
Four review rounds on free-text fuzzy product matching kept finding real bugs (safety-critical misrouting on deactivation, an unmatchable sibling product, a denylist false positive, and a structural ambiguity-masking gap that's currently inert but would activate as the catalog grows). Rather than a 5th patch, the root fix is removing the *need* to guess for the common case: present the real catalog as a numbered text list, so choosing is deterministic ("reply with the number"), while keeping the interaction as plain conversational text — no native WhatsApp UI, no mode asymmetry, still fits the humanized/conversational feel.

## Functional Requirements

- **FR-1001** — Q1's prompt becomes a dynamically-generated numbered list of currently-active products (from `productsRepo`, not a static config), sent after the acknowledgment. *(Acceptance: the list reflects whatever products are active in the database at the moment the message is sent, not a cached/stale version.)*
- **FR-1002** — A reply that is a number (tolerant of common wrapping — "1", "1.", "no 1", "nomor 2", "3 dong") resolving to a valid position in the list deterministically selects that exact product: `matched_product` set to its name, `matched_product_score = 1.0`, `needs_review = false`. The fuzzy matcher is not invoked for this path. *(Acceptance: replying "2" when the list showed 4 products always selects exactly the 2nd one, with no scoring/ambiguity logic involved.)*
- **FR-1003** — A reply that is not a valid in-range number falls through to the existing (four-times-hardened) fuzzy product matcher against the free text, exactly as today's behavior. *(Acceptance: a customer who ignores the numbered format and types a product name/description directly still gets matched the same way this already works today.)*
- **FR-1004** — An out-of-range number (e.g., "5" shown only 4 products) is treated as a structurally-unusable response and triggers the existing retry-then-fallback mechanism (FR-002's established pattern), not a new distinct error path. *(Acceptance: an out-of-range number on the first attempt triggers one retry of the same list; a second unusable reply triggers the existing fallback message.)*
- **FR-1005** — If there are zero active products in the catalog, Q1 gracefully falls back to today's original free-text prompt ("Which product are you interested in?") instead of showing an empty list. *(Acceptance: a fresh install with no catalog configured yet does not crash and produces a sensible Q1.)*
- **FR-1006** — The list's intro/instruction wording is configurable via `config/questions.json` (a new field, e.g. `q1ListIntro`), consistent with the existing "no code change needed" pattern (NFR-005 from the original scope); only the wording is config-driven, the product names/order come live from the database.

## Non-Functional Requirements
- **NFR-1001 (no regression)**: all business-logic tests unrelated to Q1's literal prompt wording continue passing unmodified. Tests that specifically assert the old free-text Q1 prompt content are expected to need genuine updates (this is an intentional behavior change, not a regression) — but no test's *underlying assertion intent* should be weakened just to make it pass.
- **NFR-1002 (determinism)**: the numbered-selection path performs zero fuzzy-matching computation — it's a direct index lookup, not a scored comparison.
- **NFR-1003 (freshness)**: catalog changes (a product added/removed/reactivated) are reflected in the very next customer's list, matching the existing "always read fresh" pattern used elsewhere in this app (settings, product matching).

## Out of Scope
**NOT NOW:** pagination/sectioning if the catalog grows past a comfortable list length (revisit if real usage ever needs more than ~10 products shown at once); native WhatsApp interactive UI (explicitly rejected, see Why); remembering a returning customer's prior selection across separate conversations.

## Definition of Done
- [ ] FR-1001–FR-1006 implemented and verified
- [ ] NFR-1001–NFR-1003 verified
- [ ] The 15-customer simulation script updated/re-run to reflect the new Q1 flow, confirming the previously-buggy multi-product scenarios (2, 15, and ideally 13) now resolve cleanly via numbered selection where applicable
- [ ] README updated
