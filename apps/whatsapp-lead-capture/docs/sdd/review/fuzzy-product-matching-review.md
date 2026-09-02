# Review — Fuzzy Product-Relevance Matching

Two independent review rounds against `../changes/2026-09-01-fuzzy-product-matching.md`.

## Round 1 Findings

| # | Issue | Severity | Outcome |
|---|---|---|---|
| 1 | **Critical**: a product word appearing anywhere in a message with unrelated/negative intent (e.g. a refund/complaint) scored 1.0 confidence and triggered an unmodified auto-reply, with `needs_review=false` — zero signal to the owner. Directly undermined the feature's core safety purpose. | Critical | **Fixed** — length-penalty on the coverage score + an independent intent-denylist, both required as defense-in-depth (verified: one specific example only gets caught by the denylist, since score alone was insufficient for it). |
| 2 | No ambiguity/margin check — a genuinely ambiguous short term (aliased to two products) silently resolved to whichever appeared first in the catalog at full reported confidence. | Medium | **Fixed** — margin check between top-2 scores, forces `needs_review` when close; duplicate-alias catalog validation added as a load-time warning. |
| 3 | README's honesty note only disclosed false-negative risk, not false-positive risk. | Low | **Fixed** — both directions now disclosed honestly, including that the mitigations reduce but don't eliminate the risk. |

## Round 2 — Independent Re-Verification

A separate reviewer re-tested the Round 1 fix adversarially with **new, self-constructed inputs** (not copied from the fix report) — confirmed the critical bug was genuinely closed, but found the fix had overcorrected:

| # | Issue | Severity | Outcome |
|---|---|---|---|
| 4 | Length-penalty was too aggressive: 4 of 8 realistic, ordinary, zero-complaint-intent purchase questions (asking about color/material/availability/price/photos) incorrectly scored below threshold and got needlessly flagged `needs_review`. Safe-direction (never a wrong auto-reply) but defeated much of the feature's usefulness. | Medium | **Fixed** — length-penalty allowance retuned (derivation documented in code), re-verified against all 4 failing legitimate examples (now match) AND all 6 adversarial complaint examples from both rounds (still correctly reject). |
| 5 | Intent-denylist's fuzzy matching caused the common benign word "pas" to false-trigger against "palsu" (counterfeit) due to Jaro-Winkler being unreliable on short strings. | Low | **Fixed** — short tokens (<5 chars) now require exact stem match instead of fuzzy match; typo tolerance preserved for longer words. |

## Verdict: **PASS** (after two review rounds)

182/182 tests, zero changes to any previously-passing test's assertions across both fix rounds (only additive tests). Verified end-to-end:
- Genuine product mentions (short and realistically-phrased-longer) match correctly.
- Complaint/refund/unrelated messages containing a product word are correctly rejected via two independent mechanisms (score normalization + intent denylist), confirmed necessary independently of each other.
- Ambiguous short terms are flagged for manual review, not silently resolved.
- No LLM used anywhere — classical NLP (Sastrawi stemming + Jaro-Winkler similarity) only, per the explicit scope constraint.

This is the most heavily adversarially-tested feature across all changes made to Project 1 so far — appropriate given it's the one most directly capable of sending a wrong, potentially embarrassing message to a real customer if it failed silently.
