# Change: Fuzzy Product-Relevance Matching (Non-LLM)

**Status:** APPROVED (settled via discover — Why/Constraints/What/Data/Technical seats, all key decisions confirmed by user)
**Size:** medium (new entity, new dependency, new dashboard behavior)
**Relates to:** original approved scope; decisions in `../decisions/001-*.md` and `../decisions/002-*.md` are for the separate humanized-timing change, not this one

## Why
Currently, `question1_answer` (the product-interest response) is stored as raw free text with zero validation — the system can't tell if a customer is asking about a real product the business sells, or something unrelated. Explicitly NOT solving this with an LLM (deferred to the Secondary Niche/AI upsell per earlier decision) — instead using classical NLP techniques, which are well-suited here specifically because the matching target (the product catalog) is small and known, not open-ended language understanding.

## Settled Decisions
1. **Confidence-scored, non-blocking**: fuzzy-match the customer's answer against a product list. High confidence → today's auto-reply flow proceeds unchanged. Low confidence → auto-reply for that step is suppressed and the lead is flagged "needs manual review" on the dashboard instead — never send a potentially-wrong auto-generated response to the customer.
2. **Product data model**: a lightweight `Product` entity is introduced **locally in Project 1** (not a cross-project dependency on Project 3 — Project 1 predates Project 3 in the business's timeline, so it can't depend on it). Scoped to just what matching needs: `name`, `aliases` (optional list of alternate terms/synonyms), not Project 3's full inventory fields (SKU, stock_quantity, low_stock_threshold, is_active) — those track *inventory*, which is out of scope for Project 1 entirely.
3. **No-match handling**: stored and flagged "needs manual review," same non-blocking treatment as low confidence — no fallback/retry triggered by this alone.
4. **Dashboard**: existing Q1/Q2 display is sufficient; no full conversation transcript added (owner can check WhatsApp directly for full history if needed).
5. **Libraries**: `natural` (npm) for string-distance/similarity algorithms (Jaro-Winkler, Levenshtein, TF-IDF), `sastrawijs` (npm) for Indonesian stemming/normalization before matching (confirmed to exist; noted risk: low maintenance activity on the underlying Sastrawi algorithm, acceptable since stemming rules for a language don't need frequent updates).

## Functional Requirements

- **FR-501** — A `Product` catalog (name + optional aliases) is configurable by the business owner. *(Acceptance: at least a config-file-based or simple CRUD-based way to list products exists — exact mechanism decided in technical design.)*
- **FR-502** — When a customer's Q1 answer is captured, it is fuzzy-matched (after Indonesian stemming/normalization) against the Product catalog, producing a best match + confidence score. *(Acceptance: an exact or near-exact product name match scores high; unrelated text (e.g., "toko buka jam berapa") scores low.)*
- **FR-503** — Above a configured confidence threshold: today's flow is unchanged (auto-reply proceeds to Q2 as normal), and the matched product name is stored alongside the Lead for dashboard display. *(Acceptance: no behavior change visible to the customer.)*
- **FR-504** — Below the threshold (including "no match found"): the auto-reply for that step is suppressed (no Q2 prompt sent), and the Lead is flagged `needs_review` on the dashboard with the raw text visible for the owner to interpret manually. *(Acceptance: customer receives no further automated message for that turn; owner sees a clear "needs review" indicator.)*

## Non-Functional Requirements
- **NFR-501**: matching runs locally (no external API calls), consistent with the Entry Service's zero-marginal-cost positioning.
- **NFR-502 (no regression)**: existing tests (100 as of the last change) continue passing unmodified when matching is effectively a no-op (e.g., empty product catalog → always "no match" → today's behavior preserved via the safe `needs_review` path, not a crash).

## Out of Scope
**NOT NOW:** importing Project 3's full inventory system, auto-suggesting alternative products to the customer, multi-language support beyond Bahasa Indonesia + generic Latin-script matching.
**NEVER FOR THIS PROJECT:** LLM-based matching (explicitly deferred to the Secondary Niche).

## Definition of Done
- [ ] FR-501–FR-504 implemented and verified
- [ ] NFR-501–NFR-502 verified, all pre-existing tests still passing
- [ ] README updated with product-catalog setup instructions and an honest note on matching accuracy limits (not LLM-level understanding)
