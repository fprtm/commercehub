'use strict';

const VALID_STATUSES = ['new', 'responded', 'closed'];

/**
 * Data-access layer for the `leads` table. Takes a better-sqlite3 database
 * instance so it can be reused against either the real app DB or a
 * throwaway test DB.
 */
function createLeadsRepo(db) {
  const findByPhone = db.prepare('SELECT * FROM leads WHERE phone_number = ? ORDER BY id DESC LIMIT 1');
  const findById = db.prepare('SELECT * FROM leads WHERE id = ?');
  const listAll = db.prepare('SELECT * FROM leads ORDER BY datetime(first_message_at) DESC, id DESC');
  const insert = db.prepare(`
    INSERT INTO leads (phone_number, first_message_at, question1_answer, question2_answer, status, fallback_triggered, retry_count, created_at, updated_at)
    VALUES (@phone_number, @first_message_at, @question1_answer, @question2_answer, @status, @fallback_triggered, @retry_count, @created_at, @created_at)
  `);
  const updateAnswers = db.prepare(`
    UPDATE leads
    SET question1_answer = @question1_answer,
        question2_answer = @question2_answer,
        fallback_triggered = @fallback_triggered,
        retry_count = @retry_count,
        updated_at = @updated_at
    WHERE id = @id
  `);
  const updateStatus = db.prepare(`
    UPDATE leads SET status = @status, updated_at = @updated_at WHERE id = @id
  `);
  // FR-503/FR-504 (docs/sdd/changes/2026-09-01-fuzzy-product-matching.md):
  // a separate, narrowly-scoped UPDATE from updateAnswers() above --
  // deliberately does NOT touch question1_answer/question2_answer/
  // fallback_triggered/retry_count, so it can be called independently
  // (right after a Q1 answer is fuzzy-matched, in
  // inboundMessageProcessor.js) without any risk of clobbering those
  // fields or needing to know their current values first.
  const updateProductMatch = db.prepare(`
    UPDATE leads
    SET matched_product = @matched_product,
        matched_product_score = @matched_product_score,
        needs_review = @needs_review,
        updated_at = @updated_at
    WHERE id = @id
  `);
  // FR-801/FR-803 (docs/sdd/changes/2026-09-02-capture-post-completion-messages.md):
  // append-only -- the CASE keeps the column NULL-safe (SQL `NULL || x` is
  // NULL, which would silently swallow the first note) without needing a
  // read-modify-write round trip from the caller, and never truncates or
  // overwrites whatever's already there.
  //
  // Two variants of the same statement, differing only in whether
  // needs_review is forced to 1: post-review fix (Medium finding) --
  // force-flagging needs_review on a closed/responded lead (terminal --
  // leadsRepo.updateStatus() blocks any transition away from 'closed', and
  // the dashboard shows zero action buttons for one) created a permanently
  // stuck, self-contradictory dashboard state with no escape hatch. FR-803's
  // unconditional needs_review=true is therefore scoped to the two
  // NON-terminal NO_OP reasons only (flow_already_complete,
  // fallback_already_triggered); a closed/responded lead still gets the
  // note appended (FR-801: data is never lost) but needs_review is left
  // exactly as it was. See inboundMessageProcessor.js for which reason
  // selects which variant.
  const appendAdditionalNoteAndFlag = db.prepare(`
    UPDATE leads
    SET additional_notes = CASE
          WHEN additional_notes IS NULL OR additional_notes = '' THEN @note_line
          ELSE additional_notes || char(10) || @note_line
        END,
        needs_review = 1,
        updated_at = @updated_at
    WHERE id = @id
  `);
  const appendAdditionalNoteOnly = db.prepare(`
    UPDATE leads
    SET additional_notes = CASE
          WHEN additional_notes IS NULL OR additional_notes = '' THEN @note_line
          ELSE additional_notes || char(10) || @note_line
        END,
        updated_at = @updated_at
    WHERE id = @id
  `);
  // docs/sdd/changes/2026-09-02-numbered-product-selection.md, HIGH-severity
  // post-review fix: a separate, narrowly-scoped UPDATE (same pattern as
  // updateProductMatch above) so it can be called independently, right
  // after create()/saveAnswers(), without touching anything else on the row.
  const updateShownProductIdsStmt = db.prepare(`
    UPDATE leads SET shown_product_ids = @shown_product_ids, updated_at = @updated_at WHERE id = @id
  `);

  /**
   * Row (DB shape, `shown_product_ids` still JSON text or NULL) -> domain
   * object (`shown_product_ids` parsed into a real array, or `null`).
   * Mirrors productsRepo.js's own toDomain()/`aliases` handling -- same
   * "callers never have to think about the JSON encoding" reasoning.
   */
  function toDomain(row) {
    if (!row) return row;
    let shownProductIds = null;
    if (typeof row.shown_product_ids === 'string' && row.shown_product_ids.length > 0) {
      try {
        const parsed = JSON.parse(row.shown_product_ids);
        if (Array.isArray(parsed)) shownProductIds = parsed;
      } catch {
        shownProductIds = null;
      }
    }
    return { ...row, shown_product_ids: shownProductIds };
  }

  return {
    /**
     * Returns the most recent lead for a phone number, or undefined if this
     * phone number has never messaged before.
     *
     * Judgment call: one phone number can only have one "active" inquiry
     * thread at a time in this implementation -- a second, unrelated
     * inquiry from a returning customer after their first lead is fully
     * resolved (closed) is out of scope for this small demo's state
     * machine (see stateMachine.js header comment for detail).
     */
    findByPhone(phoneNumber) {
      return toDomain(findByPhone.get(phoneNumber));
    },

    findById(id) {
      return toDomain(findById.get(id));
    },

    listAllMostRecentFirst() {
      return listAll.all().map(toDomain);
    },

    create({ phoneNumber, firstMessageAt }) {
      const now = new Date().toISOString();
      const info = insert.run({
        phone_number: phoneNumber,
        first_message_at: firstMessageAt,
        question1_answer: null,
        question2_answer: null,
        status: 'new',
        fallback_triggered: 0,
        retry_count: 0,
        created_at: now,
      });
      return toDomain(findById.get(info.lastInsertRowid));
    },

    saveAnswers(id, { question1Answer, question2Answer, fallbackTriggered, retryCount }) {
      updateAnswers.run({
        id,
        question1_answer: question1Answer,
        question2_answer: question2Answer,
        fallback_triggered: fallbackTriggered ? 1 : 0,
        // Defaults to 0 (reset) whenever a caller doesn't explicitly carry
        // a retry count forward -- e.g. moving on to a newly-pending
        // question always starts that question's retry allowance fresh.
        retry_count: retryCount || 0,
        updated_at: new Date().toISOString(),
      });
      return toDomain(findById.get(id));
    },

    /**
     * docs/sdd/changes/2026-09-02-numbered-product-selection.md,
     * HIGH-severity post-review fix: persists the exact ordered list of
     * `products.id` values Q1's numbered list just showed this Lead (or
     * clears it, if `productIds` is null/not an array) -- see
     * schema.sql's doc comment on `shown_product_ids` for the full
     * reasoning. Called from inboundMessageProcessor.js right after
     * create()/saveAnswers(), whenever stateMachine.js's decideNextAction()
     * returns a `shownProductIdsToPersist` (START_FLOW, or a RETRY that
     * re-shows Q1's list).
     *
     * @param {number} id
     * @param {number[]|null} productIds
     */
    updateShownProductIds(id, productIds) {
      updateShownProductIdsStmt.run({
        id,
        shown_product_ids: Array.isArray(productIds) ? JSON.stringify(productIds) : null,
        updated_at: new Date().toISOString(),
      });
      return toDomain(findById.get(id));
    },

    /**
     * FR-503/FR-504: records the outcome of fuzzy-matching a Lead's
     * question1_answer against the Product catalog (see
     * @rimba/product-matcher's productMatcher.js). Called at most once per Q1 answer,
     * from inboundMessageProcessor.js, right after that answer is saved.
     *
     * Also reused, unmodified in shape, by the FR-802 post-completion
     * re-match path in inboundMessageProcessor.js -- see
     * `matched_product_score`'s schema.sql doc comment for why that path
     * always passes `matchedProductScore` too (and always `needsReview:
     * true`, per FR-803).
     *
     * @param {number} id
     * @param {{ matchedProduct: string|null, matchedProductScore?: number|null, needsReview: boolean }} params
     */
    updateProductMatch(id, { matchedProduct, matchedProductScore, needsReview }) {
      updateProductMatch.run({
        id,
        matched_product: matchedProduct || null,
        matched_product_score: typeof matchedProductScore === 'number' ? matchedProductScore : null,
        needs_review: needsReview ? 1 : 0,
        updated_at: new Date().toISOString(),
      });
      return toDomain(findById.get(id));
    },

    /**
     * FR-801/FR-803: appends a timestamped line to the running
     * `additional_notes` log for a message that arrived after this Lead's
     * automated flow already resolved it to NO_OP. See
     * inboundMessageProcessor.js for the exact NO_OP-reason scope this is
     * called for.
     *
     * @param {number} id
     * @param {string} noteLine - already fully formatted, e.g.
     *   "[2026-09-02T07:14:00Z] spill harga kaos rimba nya dong"
     * @param {{ needsReview?: boolean }} [options] - post-review fix
     *   (Medium finding): defaults to `true` (FR-803's original behavior --
     *   flags the Lead for a fresh manual look). Pass `false` for the
     *   lead_status_responded/lead_status_closed NO_OP reasons specifically
     *   -- those leads are terminal, so needs_review is left untouched
     *   instead of being force-set, avoiding a permanently-stuck
     *   "needs review, but no further action possible" dashboard state.
     */
    appendAdditionalNote(id, noteLine, { needsReview = true } = {}) {
      const stmt = needsReview ? appendAdditionalNoteAndFlag : appendAdditionalNoteOnly;
      stmt.run({ id, note_line: noteLine, updated_at: new Date().toISOString() });
      return toDomain(findById.get(id));
    },

    /**
     * Updates status. Throws a typed error object ({ code }) rather than a
     * bare Error so route handlers can map it to the right HTTP status
     * without string-matching messages.
     */
    updateStatus(id, status) {
      if (!VALID_STATUSES.includes(status) || status === 'new') {
        const err = new Error(`Invalid status: ${status}`);
        err.code = 'INVALID_STATUS';
        throw err;
      }
      const lead = findById.get(id);
      if (!lead) {
        const err = new Error(`Lead not found: ${id}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      // Lifecycle guard (technical-design.md Phase K lifecycle diagram):
      // `closed` is a terminal state -- new->responded->closed and
      // new->closed are the only allowed paths, nothing transitions away
      // from `closed`. Reuses the same INVALID_STATUS error code/400 path
      // as an unrecognized status value, since this is the same class of
      // "not a valid owner action" rejection.
      if (lead.status === 'closed') {
        const err = new Error(`Cannot change status of a closed lead (id ${id})`);
        err.code = 'INVALID_STATUS';
        throw err;
      }
      updateStatus.run({ id, status, updated_at: new Date().toISOString() });
      return toDomain(findById.get(id));
    },
  };
}

module.exports = { createLeadsRepo, VALID_STATUSES };
