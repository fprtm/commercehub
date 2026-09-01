'use strict';

/**
 * Qualifying-question state machine (T-005 / FR-002 / FR-007 / US-002).
 *
 * This is the core business logic of the whole project: given a lead's
 * current state (or "no lead yet" for a brand-new phone number) and an
 * inbound message, decide what happens next. It is a pure function with no
 * DB or network access, so it can be unit-tested exhaustively without any
 * infrastructure -- the webhook route (src/routes/webhook.js) is the only
 * caller, and it performs the actual DB writes / Meta API calls based on
 * the decision returned here.
 *
 * --- Judgment calls made here (not fully specified in the design docs) ---
 *
 * 1. "First-time message" (FR-001) is interpreted as: no Lead row exists
 *    yet for this phone number. A returning customer who already has a
 *    Lead (at any status) is NOT treated as starting a brand-new inquiry;
 *    their next message continues/concludes the existing flow, or is a
 *    no-op if that flow is already finished. The spec does not describe
 *    a second, unrelated inquiry from a repeat customer, and one-lead-
 *    per-phone-number is the simplest model consistent with the documented
 *    data model (no "conversation" or "thread" entity exists).
 *
 * 2. "Doesn't fit the expected qualifying-question flow" (FR-007) is
 *    interpreted structurally, not semantically: since there is no NLP/AI
 *    validation of answer relevance in scope (explicitly deferred to
 *    "MAYBE LATER" in the changes file), any non-empty text message is
 *    accepted as a valid answer to whichever question is currently
 *    pending. The fallback only fires when the inbound message has no
 *    usable text at all (e.g. an image/sticker/unsupported message type,
 *    or an empty body) -- something the code CAN determine reliably. (The
 *    changes file's FR-007 acceptance text was corrected post-review to
 *    match this structural interpretation rather than the other way
 *    around -- see docs/sdd/changes/2026-09-01-whatsapp-lead-capture.md.)
 *
 * 2a. FR-002's acceptance criterion calls for the flow to stop "after the
 *     second answer or after one follow-up attempt if unanswered" -- i.e.
 *     one retry before falling back, not an immediate fallback on the
 *     first unusable message. `existingLead.retry_count` (persisted on the
 *     Lead row -- see schema.sql) tracks whether that one retry has
 *     already been used for the *currently pending* question. The first
 *     unusable message re-sends the same pending question (with a short
 *     "didn't catch that" prefix) and sets retry_count to 1; a second
 *     unusable message in a row triggers the real FR-007 fallback.
 *     retry_count resets to 0 whenever a question is newly answered (i.e.
 *     when the *next* question becomes the pending one).
 *
 * 3. Once a lead's flow is fully resolved (both questions answered) or
 *    fallback has already fired, or the owner has manually set status to
 *    `responded`/`closed`, further inbound messages from that phone number
 *    are treated as NO_OP for the automated flow (the Lead record already
 *    exists, so FR-007's "no message is dropped without a lead record"
 *    still holds -- there's just no further automated reply, so the
 *    bot doesn't keep messaging a customer whose inquiry is already
 *    closed out).
 */

const ACTIONS = Object.freeze({
  START_FLOW: 'START_FLOW', // brand new phone number: create Lead, send ack + Q1
  ANSWER_Q1: 'ANSWER_Q1', // valid answer to Q1 received: save it, send Q2
  ANSWER_Q2: 'ANSWER_Q2', // valid answer to Q2 received: save it, send completion message
  RETRY: 'RETRY', // unusable message, first attempt: re-send the pending question once (FR-002)
  FALLBACK: 'FALLBACK', // unusable message after the one retry attempt: send fallback message (FR-007)
  NO_OP: 'NO_OP', // lead already resolved / closed out: no automated reply
});

const DEFAULT_RETRY_PREFIX = "Sorry, I didn't quite catch that. ";

function hasUsableText(messageText) {
  return typeof messageText === 'string' && messageText.trim().length > 0;
}

function retryCountOf(existingLead) {
  return Number(existingLead.retry_count) || 0;
}

/**
 * @param {object} params
 * @param {object|null|undefined} params.existingLead - the most recent Lead
 *   row for this phone number (as returned by leadsRepo.findByPhone), or
 *   null/undefined if this phone number has never messaged before.
 * @param {string|null} params.messageText - the inbound message's text
 *   body, already extracted from the raw Meta payload; null/empty for
 *   non-text message types.
 * @param {object} params.config - the loaded questions.json config
 *   ({ acknowledgment, questions: [{id, text}, {id, text}], fallbackMessage, completionMessage }).
 * @returns {{
 *   action: string,
 *   replies: string[],
 *   createLead: boolean,
 *   leadPatch: object|null,
 *   reason?: string
 * }}
 */
function decideNextAction({ existingLead, messageText, config }) {
  const q1Text = config.questions[0].text;
  const q2Text = config.questions[1].text;

  if (!existingLead) {
    return {
      action: ACTIONS.START_FLOW,
      replies: [config.acknowledgment, q1Text],
      createLead: true,
      leadPatch: null,
    };
  }

  if (existingLead.status === 'responded' || existingLead.status === 'closed') {
    return {
      action: ACTIONS.NO_OP,
      replies: [],
      createLead: false,
      leadPatch: null,
      reason: `lead_status_${existingLead.status}`,
    };
  }

  if (existingLead.fallback_triggered) {
    return {
      action: ACTIONS.NO_OP,
      replies: [],
      createLead: false,
      leadPatch: null,
      reason: 'fallback_already_triggered',
    };
  }

  const q1Answered = existingLead.question1_answer !== null && existingLead.question1_answer !== undefined;
  const q2Answered = existingLead.question2_answer !== null && existingLead.question2_answer !== undefined;

  if (!q1Answered) {
    if (!hasUsableText(messageText)) {
      if (retryCountOf(existingLead) === 0) {
        const retryPrefix = config.retryPrefix || DEFAULT_RETRY_PREFIX;
        return {
          action: ACTIONS.RETRY,
          replies: [`${retryPrefix}${q1Text}`],
          createLead: false,
          leadPatch: {
            question1Answer: null,
            question2Answer: null,
            fallbackTriggered: false,
            retryCount: 1,
          },
        };
      }
      return {
        action: ACTIONS.FALLBACK,
        replies: [config.fallbackMessage],
        createLead: false,
        leadPatch: {
          question1Answer: null,
          question2Answer: null,
          fallbackTriggered: true,
          retryCount: retryCountOf(existingLead),
        },
      };
    }
    return {
      action: ACTIONS.ANSWER_Q1,
      replies: [q2Text],
      createLead: false,
      leadPatch: {
        question1Answer: messageText,
        question2Answer: null,
        fallbackTriggered: false,
        retryCount: 0, // reset: Q2 is now the pending question, with its own fresh retry allowance
      },
    };
  }

  if (!q2Answered) {
    if (!hasUsableText(messageText)) {
      if (retryCountOf(existingLead) === 0) {
        const retryPrefix = config.retryPrefix || DEFAULT_RETRY_PREFIX;
        return {
          action: ACTIONS.RETRY,
          replies: [`${retryPrefix}${q2Text}`],
          createLead: false,
          leadPatch: {
            question1Answer: existingLead.question1_answer,
            question2Answer: null,
            fallbackTriggered: false,
            retryCount: 1,
          },
        };
      }
      return {
        action: ACTIONS.FALLBACK,
        replies: [config.fallbackMessage],
        createLead: false,
        leadPatch: {
          question1Answer: existingLead.question1_answer,
          question2Answer: null,
          fallbackTriggered: true,
          retryCount: retryCountOf(existingLead),
        },
      };
    }
    return {
      action: ACTIONS.ANSWER_Q2,
      replies: config.completionMessage ? [config.completionMessage] : [],
      createLead: false,
      leadPatch: {
        question1Answer: existingLead.question1_answer,
        question2Answer: messageText,
        fallbackTriggered: false,
        retryCount: 0,
      },
    };
  }

  // Both questions already answered -- flow is complete, nothing more to do.
  return {
    action: ACTIONS.NO_OP,
    replies: [],
    createLead: false,
    leadPatch: null,
    reason: 'flow_already_complete',
  };
}

module.exports = { decideNextAction, ACTIONS, hasUsableText, DEFAULT_RETRY_PREFIX };
