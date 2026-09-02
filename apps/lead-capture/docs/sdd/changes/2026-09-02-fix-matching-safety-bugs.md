# Change: Fix 3 Matching Bugs Found by 15-Customer Adversarial Simulation

**Status:** APPROVED (user: "gas")
**Size:** small-medium
**Relates to:** `2026-09-01-fuzzy-product-matching.md` and its two prior review-driven fix rounds

## Why
A 15-simulated-customer realistic stress test (run against the real seeded 4-product catalog, not isolated fixtures) found 3 real defects the existing 229-test suite never exercised, because they only appear once multiple similar products (Kaos Rimba Navy / Kaos Rimba Hitam) coexist in the same catalog.

## Bug 1 (safety, must-fix) — Deactivating a product can silently misroute customers to a wrong active product
**Root cause:** matching only ever considers the active-product pool. Removing a product from that pool can let a *different* product win on a partial/generic-alias score that would have lost (or tied into ambiguity) had the deactivated product still been in the running.

- **FR-901** — Before returning a confident match, also compute the best match against the FULL catalog (active + inactive). If the full-catalog winner is an inactive product, the result is forced to no-match/`needs_review=true`, regardless of what the active-only pool would have said. *(Acceptance: reproduce the exact simulation case — deactivate Navy, send "kaos rimba navy ada?" — result must be no-match/needs_review, never a confident match to Hitam or anything else.)*

## Bug 2 (data/validation, not a scoring bug) — A generic single-word alias on one product makes a sibling product's own full name unmatchable
**Root cause:** "kaos" (bare) is an alias on Kaos Rimba Navy only, even though it's a generic word that applies to every kaos-family product. Any message naming another kaos product by its full name ties with Navy via that alias and gets suppressed as "ambiguous."

- **FR-902** — Fix the current catalog data: remove the bare `"kaos"` alias from Kaos Rimba Navy (keep more specific aliases like `"kaos navy"`, `"baju kaos"`). *(Acceptance: "mau beli kaos rimba hitam" as a Q1 answer resolves to a confident, unambiguous match on Kaos Rimba Hitam.)*
- **FR-903** — Add a lightweight, non-blocking warning (not a hard rejection) when a product's alias is created/edited via the dashboard CRUD or the seed loader: if the new alias (stemmed) exactly equals a stemmed token that also appears in another ACTIVE product's own name, log a warning (same pattern as the existing duplicate-alias warning) so a future catalog addition that recreates this trap gets flagged, not silently shipped. *(Acceptance: adding "kaos" as an alias to a product while "Kaos Rimba Hitam" is active and named produces a logged warning.)*

## Bug 3 (tuning) — Intent-denylist fuzzy match false-positive: "keluarga" (family) vs "keluhan" (complaint)
**Root cause:** the denylist's Jaro-Winkler fuzzy threshold (0.85) is too loose for some legitimate long words; "keluarga" scores 0.86 against stemmed "keluhan" and incorrectly triggers complaint-suppression.

- **FR-904** — Raise the denylist's fuzzy-match threshold (currently 0.85) to a stricter value that no longer treats "keluarga" as a match for "keluhan"/"keluh", while still catching genuine close typos of actual denylist words (e.g. "komplein" for "komplain"). *(Acceptance: the exact simulation sentence containing "keluarga" and a full, unambiguous product mention now resolves to a confident match, not needs_review; a deliberate typo of a real denylist word, e.g. "rusakk" for "rusak", still triggers correctly.)*

## Non-Functional Requirements
- **NFR-901 (no regression)**: all 229 pre-existing tests continue passing unmodified.
- **NFR-902**: re-run (a version of) the 15-customer simulation script after the fix and confirm all 3 previously-failing scenarios (2, 13, 15) now pass, without any previously-passing scenario regressing.

## Out of Scope
**NOT NOW:** the bigger architectural question (WhatsApp interactive list/button selection instead of free-text matching) — under separate research, not part of this fix.

## Definition of Done
- [ ] FR-901–FR-904 implemented and verified
- [ ] NFR-901–NFR-902 verified: full test suite passes, and the 15-customer simulation re-run shows scenarios 2, 13, 15 now passing
- [ ] README updated
