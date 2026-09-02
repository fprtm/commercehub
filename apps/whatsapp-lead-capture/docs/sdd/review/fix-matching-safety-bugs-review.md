# Review — Fix 3 Matching Bugs (Round 4 on this module)

Independent adversarial review against `../changes/2026-09-02-fix-matching-safety-bugs.md`. Fourth review round on `productMatcher.js` this session — held to the same high bar as prior rounds, not assumed clean.

## Findings

| # | Issue | Requirement | Severity | Outcome |
|---|---|---|---|---|
| 1 | The FR-901 safety guard can be defeated by "ambiguity masking": if the full-catalog (active+inactive) re-check itself reports `ambiguous` (e.g., two inactive near-duplicate products tie, or an inactive-correct-answer ties within the 0.1 margin against the active-pool's wrong winner), `fullCatalogResult.matched` becomes `false`, the guard's `if` never fires, and the function silently falls through to the original, wrong, confident active-pool match — the exact failure mode FR-901 exists to prevent. **Not exploitable against the current 4-product catalog** (verified: its short, well-separated names always produce a 0.333 score gap, never landing inside the 0.1 ambiguity margin), but it's a real, reproduced logic hole, not a hypothetical. | FR-901 | Medium | **Documented, not fixed this round** — inert today, would need to broaden the guard (force no-match whenever any inactive product is among the full-catalog's ambiguous top-2, not only when it's the sole clear winner) before the catalog grows past today's small, well-separated set. |
| 2 | FR-903's alias-shadow warning re-fires on every product `update()`, even edits that don't touch aliases. | FR-903 | Low/cosmetic | Not fixed — log-only, no functional impact. |
| 3 | The scenario-13 residual-gap writeup slightly overstates that non-credited repeated words is *the* cause of the low score; independently recomputed that crediting all repeats would only move the score from 0.11 to 0.125 — still far below threshold. Sheer message length (42 tokens) is the dominant factor. | Documentation accuracy | Low | Not fixed — wording note only, so a future pass doesn't expect a repeat-crediting fix to close scenario 13 alone. |

## Verified Independently (not trusted from the build report)

- **FR-901 core fix**: reproduced the exact Navy-deactivation bug and confirmed the fix closes it; also confirmed the guard does NOT falsely suppress a genuinely correct, unambiguous match on an active product.
- **Race condition**: confirmed not a real concern — `better-sqlite3` is fully synchronous, the whole match-then-guard sequence runs in one unbroken call stack with zero `await` in between.
- **FR-902 backfill**: verified idempotent (safe on repeated boots), verified against a copy of the real `data/leads.db` that the bad alias is actually gone.
- **FR-903 core behavior**: verified against a live catalog — warns correctly on genuine shadow cases, stays silent on safe specific aliases.
- **FR-904 threshold**: independently recomputed every cited Jaro-Winkler score to 4 decimal places (all matched exactly), plus 4 additional self-constructed realistic typo cases, all correctly clearing 0.90.
- **Test suite**: 245/245, confirmed 229 pre-existing tests genuinely unmodified via git diff.
- **Simulation re-run**: 14/15 scenarios pass; scenario 13 fails exactly as disclosed, not hidden.

## Verdict: **CHANGES REQUESTED (soft)** — real incremental progress, one tracked residual risk

This round measurably improves safety (Bug 1 closed for the actual data in production today) and correctness (Bugs 2 and 3's immediate false positives closed), with honest, verified disclosure of what remains open rather than papering over gaps. The Medium finding is real but inert against the current catalog — a conscious, documented risk, not a silent one. Recommend closing it in a future round specifically if/when the product catalog grows to include near-duplicate or longer product names, rather than blocking on it now.

**Cumulative honesty note across all 4 rounds on this module**: every round found something real. This is itself useful signal about the underlying approach (free-text fuzzy matching against a growing product catalog) — worth weighing against the WhatsApp-native structured list/button alternative researched in parallel, as a separate architectural decision.
