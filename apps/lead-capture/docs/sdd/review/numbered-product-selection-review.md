# Review — Numbered Product List as Primary Q1 Selection

Two review rounds against `../changes/2026-09-02-numbered-product-selection.md`.

## Round 1 Finding

| # | Issue | Severity | Outcome |
|---|---|---|---|
| 1 | The numbered-selection path resolved a customer's reply against a freshly re-queried product list at answer-time, not the list actually shown at send-time. If the catalog changed in between (any product deactivated), position numbers silently shifted meaning — reproduced live: customer picks "3" meaning Kaos Rimba Hitam, an unrelated deactivation shifts the list, reply resolves to Kaos Rimba Navy instead, reported as `score=1.0, needs_review=false` (confident and wrong). This reopened FR-901's exact failure shape (silent misrouting) through a new mechanism, bypassing the existing inactive-product guard entirely. | **High** | **Fixed** — the shown list is now snapshotted onto the Lead record (`shown_product_ids`) at send time; replies resolve against that snapshot, not a fresh query. The resolved product's current active status is re-checked; if it went inactive in the interim, the result safely degrades to `needs_review=true` rather than confidently substituting a different product. |

## Round 2 — Independent Re-Verification

A separate reviewer independently reproduced both the "different product deactivated" and "customer's own pick deactivated" scenarios against the real production code (not the shipped tests), confirmed the RETRY path correctly re-snapshots with no ambiguity window, confirmed a NULL snapshot (pre-migration rows, or empty-catalog-fallback leads) degrades safely to the fuzzy-matcher fallback without crashing, and confirmed the schema migration is safe against a real copy of the production-like database.

**One documentation-accuracy correction**: the fix's own report claimed "5 pre-existing tests needed snapshot fixture updates" — verified false. The actual, better outcome: **zero pre-existing test files were touched**; the entire feature is additive/opt-in (inert unless a catalog is explicitly passed in), so all prior tests remain byte-identical. Corrected here for the record.

## Verdict: **PASS**

276/276 tests, 245 of which are the untouched original suite. The architectural goal is achieved: the common product-selection case is now fully deterministic (numbered reply → exact index lookup, zero fuzzy-matching computation), the four-times-hardened fuzzy matcher remains available as a fallback for free-text replies, and the one new failure mode this change could have introduced (index drift from a fresh re-query) was found and closed with independent verification on both sides of the fix.
