# Review — Never Drop a Message, Even After the Q1/Q2 Flow Completes

Independent review against `../changes/2026-09-02-capture-post-completion-messages.md`. This fix addresses a real bug found via live WhatsApp testing (a customer's product mention arriving as a 3rd/4th message was silently dropped).

## Findings

| # | Issue | Requirement | Severity | Outcome |
|---|---|---|---|---|
| 1 | Post-completion messages on `closed`/`responded` (terminal) leads unconditionally set `needs_review=true`, but the dashboard offers zero action buttons for a closed lead and no way to ever clear the flag — a new, permanently-stuck, self-contradictory dashboard state not reachable before this change. | FR-803 (scope of applicability) | Medium | **Fixed** — `additional_notes` still captured for every NO_OP reason (data never lost), but `needs_review` is only force-set for still-open reasons (`flow_already_complete`, `fallback_already_triggered`); terminal-status leads preserve whatever `needs_review` already was. |

No other issues found — the migration safety, append-only note behavior, strictly-higher-score match comparison, XSS-safe rendering, and no-reply-spam guarantee were all independently verified, including empirically against a copy of the real production-like database file.

## Verified Empirically (not just read)

- **Migration safety**: copied the real `data/leads.db`, ran the actual `createDb()` migration against the copy twice — pre-existing row fully intact, new columns added as NULL, idempotent on re-run, real file never touched.
- **Bug reproduction**: the exact real-world scenario (vague Q1/Q2 answers, then a later message naming "kaos rimba") — confirmed the message is captured, `matched_product` correctly upgrades, and (after the fix) `needs_review` behaves correctly for both open and terminal leads.
- **No reply spam**: a send-tracking spy stayed empty across every NO_OP-with-capture scenario, including the case where a confident product match is found on the post-completion message itself.
- **XSS safety**: injected `<script>` and HTML entities into a live render — correctly escaped.

## Verdict: **PASS**

229/229 tests. This fix closes the real bug the user hit: a product name arriving as a later message in a real conversation is no longer silently lost, `matched_product` correctly updates to reflect it, and the fix doesn't introduce a new dead-end state on closed leads.
