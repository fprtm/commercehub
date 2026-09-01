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
        needs_review = @needs_review,
        updated_at = @updated_at
    WHERE id = @id
  `);

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
      return findByPhone.get(phoneNumber);
    },

    findById(id) {
      return findById.get(id);
    },

    listAllMostRecentFirst() {
      return listAll.all();
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
      return findById.get(info.lastInsertRowid);
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
      return findById.get(id);
    },

    /**
     * FR-503/FR-504: records the outcome of fuzzy-matching a Lead's
     * question1_answer against the Product catalog (see
     * src/services/productMatcher.js). Called at most once per Q1 answer,
     * from inboundMessageProcessor.js, right after that answer is saved.
     *
     * @param {number} id
     * @param {{ matchedProduct: string|null, needsReview: boolean }} params
     */
    updateProductMatch(id, { matchedProduct, needsReview }) {
      updateProductMatch.run({
        id,
        matched_product: matchedProduct || null,
        needs_review: needsReview ? 1 : 0,
        updated_at: new Date().toISOString(),
      });
      return findById.get(id);
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
      return findById.get(id);
    },
  };
}

module.exports = { createLeadsRepo, VALID_STATUSES };
