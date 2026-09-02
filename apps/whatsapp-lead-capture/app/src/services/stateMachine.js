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
 *
 * 4. Numbered Q1 product selection (docs/sdd/changes/2026-09-02-numbered-
 *    product-selection.md, FR-1001..FR-1006). This module stays a pure
 *    function with no DB access (per the top of this file), so the caller
 *    (inboundMessageProcessor.js) is responsible for reading the active
 *    product catalog fresh (`productsRepo.listActive()`) and passing it in
 *    as `activeProducts` -- used to build Q1's numbered list (whenever it's
 *    sent or re-sent) and to check whether a specific product is STILL
 *    active right now (see next paragraph).
 *
 *    **Post-review fix (HIGH-severity finding): a numbered reply is NEVER
 *    resolved against a freshly re-queried `activeProducts`.** An earlier
 *    version of this feature did exactly that, and it reopened the FR-901
 *    misrouting bug shape through a new mechanism: if the catalog changes
 *    between the message that showed the list and the message that answers
 *    it (e.g. the owner deactivates a DIFFERENT product than the one this
 *    customer picked), the position numbers can silently shift to mean
 *    something else -- "3" meant the 3rd item shown, but a fresh re-query
 *    might now put a different product at position 3. Confidently matching
 *    that fresh-query product would be a silent, WRONG, needs_review=false
 *    match -- worse than the original fuzzy-matcher bugs, because it
 *    reports maximum confidence for a genuinely wrong product.
 *
 *    The fix: `existingLead.shown_product_ids` (see schema.sql) is a
 *    persisted SNAPSHOT of the exact ordered product IDs Q1's list showed
 *    THIS lead, written by the caller (via leadsRepo.updateShownProductIds())
 *    whenever `decideNextAction` returns `shownProductIdsToPersist` below
 *    (on START_FLOW, and on a RETRY that re-shows Q1's list -- FR-1004,
 *    re-snapshotting since the retry's own list may itself have changed).
 *    A numbered reply's position is resolved against THIS SNAPSHOT, never
 *    a fresh query -- "3" always means the 3rd item this specific customer
 *    was actually shown, full stop. The resolved product ID is then
 *    cross-checked against fresh `activeProducts`: if it's still active,
 *    the match proceeds exactly as before (score=1.0, needs_review=false);
 *    if it was deactivated in the interim, the reply is NOT confidently
 *    matched and NOT silently substituted with whatever now occupies that
 *    position -- `numberedProductStale: true` is returned instead (see
 *    below), which inboundMessageProcessor.js treats the same as FR-901's
 *    spirit: no confident match, needs_review=true, so the owner sees it
 *    needs a manual look rather than the bot confidently telling the
 *    customer about a product they never asked about.
 *
 *    `activeProducts` is optional and, when omitted (every pre-existing
 *    caller/test), leaves this whole feature inert: Q1 falls back to
 *    `config.questions[0].text` verbatim and no number-parsing is
 *    attempted, i.e. today's exact pre-existing behavior (NFR-1001). It is
 *    also treated as inert when `activeProducts` is present but empty
 *    (FR-1005: zero active products -- nothing to number, so the original
 *    free-text prompt is used instead of an empty list), and likewise when
 *    `existingLead.shown_product_ids` is missing/empty (nothing was ever
 *    snapshotted for this lead -- e.g. a pre-existing Lead from before this
 *    column existed, or one whose Q1 used the FR-1005 fallback).
 *
 *    When a numbered reply resolves to a still-active product, the match
 *    is deterministic (FR-1002) -- `decideNextAction` still returns
 *    ACTIONS.ANSWER_Q1 (Q2 is still sent, exactly like any other accepted
 *    Q1 answer) but also returns `numberedProductMatch: <the selected
 *    product>` so inboundMessageProcessor.js can skip the fuzzy matcher
 *    entirely for this turn. **NFR-1002's real guarantee isn't a property
 *    of the input text** (an earlier version of this doc comment reasoned
 *    from "digit-only text can't score a fuzzy match" -- true, but not the
 *    actual mechanism) -- it's structural: inboundMessageProcessor.js
 *    branches on `if (decision.numberedProductMatch) {...} else if (...) {
 *    matchProduct(...) }`, a literal mutual-exclusion `if`/`else if`, so
 *    `matchProduct()` is simply never reached in the same code path that
 *    handles a numbered match, regardless of what the input text is.
 *    An OUT-OF-RANGE number (FR-1004) is folded into the exact same
 *    "structurally unusable" bucket `hasUsableText` already gates
 *    RETRY/FALLBACK on, rather than a new parallel error path. A reply
 *    that does not parse as a number at all (FR-1003) falls through
 *    completely unchanged: an ordinary ANSWER_Q1 with no
 *    `numberedProductMatch`, exactly like today, letting
 *    inboundMessageProcessor.js's existing (four-times-hardened) fuzzy
 *    matcher run exactly as it always has.
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

// FR-1006 defaults: used whenever config/questions.json doesn't override
// them. The product lines themselves are never config-driven (FR-1006) --
// only this wrapping wording is.
const DEFAULT_Q1_LIST_INTRO = 'Ada beberapa pilihan nih kak:';
const DEFAULT_Q1_LIST_INSTRUCTION = 'Balas nomornya ya, atau ketik aja nama produknya kalau udah tau';

// FR-1002: trailing filler words tolerated after a bare number reply (e.g.
// "2 dong"). Deliberately a short, explicit list (not a general stopword
// scrub) -- see parseNumberSelection()'s doc comment for why.
const NUMBER_REPLY_TRAILING_FILLERS = ['dong', 'ya', 'nya'];

function hasUsableText(messageText) {
  return typeof messageText === 'string' && messageText.trim().length > 0;
}

function retryCountOf(existingLead) {
  return Number(existingLead.retry_count) || 0;
}

/**
 * FR-1001/FR-1005/FR-1006: builds the message actually sent for Q1.
 *
 * - When `activeProducts` is a non-empty array, returns a dynamically
 *   generated numbered list (intro line, one "N. Product Name" line per
 *   active product in the order given, then an instruction line) --
 *   exactly the format settled in the change spec:
 *
 *     Ada beberapa pilihan nih kak:
 *     1. Kaos Rimba Navy
 *     2. Kaos Rimba Hitam
 *     3. Celana Rimba Cargo
 *     4. Jaket Rimba Outdoor
 *     Balas nomornya ya, atau ketik aja nama produknya kalau udah tau
 *
 *   The intro/instruction lines are config-driven (FR-1006:
 *   `config.q1ListIntro` / `config.q1ListInstruction`, falling back to the
 *   defaults above); the numbered product lines are NOT -- they come
 *   straight from `activeProducts`, which the caller is responsible for
 *   reading fresh from `productsRepo.listActive()` (NFR-1003).
 * - When `activeProducts` is missing/empty (FR-1005 -- no catalog wired up,
 *   or a genuinely empty catalog), falls back to the original static
 *   free-text prompt, `config.questions[0].text`, unchanged.
 *
 * @param {object} config - loaded config/questions.json
 * @param {Array<{name: string}>|undefined} activeProducts
 * @returns {string}
 */
function buildQ1Message(config, activeProducts) {
  const staticFallbackText = config.questions[0].text;
  if (!Array.isArray(activeProducts) || activeProducts.length === 0) {
    return staticFallbackText;
  }
  const intro = config.q1ListIntro || DEFAULT_Q1_LIST_INTRO;
  const instruction = config.q1ListInstruction || DEFAULT_Q1_LIST_INSTRUCTION;
  const numberedLines = activeProducts.map((product, index) => `${index + 1}. ${product.name}`);
  return [intro, ...numberedLines, instruction].join('\n');
}

/**
 * FR-1002: tolerant parsing of a Q1 reply as a bare number selection.
 *
 * Strips (in this order, repeating the trailing step until nothing more
 * changes, so combinations like "no 2 dong." all resolve):
 *   - a leading "no"/"nomor" wrapper (optionally followed by "." and/or
 *     whitespace) -- e.g. "no 2" / "nomor 2"
 *   - trailing punctuation (. , ! ?) -- e.g. "2."
 *   - a trailing filler word from NUMBER_REPLY_TRAILING_FILLERS -- e.g.
 *     "2 dong"
 *
 * Returns the parsed integer only when what remains after stripping is a
 * PURE digit string (nothing else) -- so ordinary free text that merely
 * starts with "no" (e.g. "no worries", or the Indonesian "nomor whatsapp
 * saya...") is untouched: stripping "no"/"nomor" from it leaves something
 * that is not all-digits, so this correctly returns null and the reply
 * falls through to the fuzzy matcher (FR-1003), exactly like any other
 * free-text answer.
 *
 * @param {string|null|undefined} rawText
 * @returns {number|null}
 */
function parseNumberSelection(rawText) {
  if (typeof rawText !== 'string') return null;
  let text = rawText.trim().toLowerCase();
  if (text.length === 0) return null;

  text = text.replace(/^(nomor|no)\.?\s*/, '');

  let changed = true;
  while (changed) {
    changed = false;
    const withoutTrailingPunctuation = text.replace(/[.,!?]+$/, '').trim();
    if (withoutTrailingPunctuation !== text) {
      text = withoutTrailingPunctuation;
      changed = true;
      continue;
    }
    for (const filler of NUMBER_REPLY_TRAILING_FILLERS) {
      const fillerPattern = new RegExp(`\\s+${filler}$`);
      if (fillerPattern.test(text)) {
        text = text.replace(fillerPattern, '').trim();
        changed = true;
        break;
      }
    }
  }

  return /^\d+$/.test(text) ? parseInt(text, 10) : null;
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
 *   ({ acknowledgment, questions: [{id, text}, {id, text}], fallbackMessage, completionMessage,
 *   q1ListIntro?, q1ListInstruction? }).
 * @param {Array<{id: number, name: string, aliases?: string[]}>} [params.activeProducts] -
 *   FR-1001/FR-1002/FR-1005 (docs/sdd/changes/2026-09-02-numbered-product-selection.md):
 *   the active product catalog, read fresh by the caller
 *   (`productsRepo.listActive()`) immediately before calling in -- used to
 *   build Q1's numbered list and to verify a snapshot-resolved product ID
 *   is still active right now. See judgment call 4 in this file's header
 *   comment. Optional and, when omitted or empty, this whole feature is
 *   inert (Q1 stays the original free-text prompt, no number-parsing
 *   attempted).
 * @returns {{
 *   action: string,
 *   replies: string[],
 *   createLead: boolean,
 *   leadPatch: object|null,
 *   reason?: string,
 *   numberedProductMatch?: {id: number, name: string, aliases?: string[]}|null,
 *   numberedProductStale?: boolean,
 *   shownProductIdsToPersist?: number[]|null,
 * }}
 */
function decideNextAction({ existingLead, messageText, config, activeProducts }) {
  const q1Text = buildQ1Message(config, activeProducts);
  const q2Text = config.questions[1].text;
  const freshActiveList = Array.isArray(activeProducts) && activeProducts.length > 0;
  // FR-1001/NFR-1003: the exact ordered product-ID snapshot of what q1Text
  // shows THIS turn -- returned as `shownProductIdsToPersist` on every
  // return path that actually (re)sends Q1's numbered list (START_FLOW, or
  // a RETRY while Q1 is still pending), so the caller can persist it via
  // leadsRepo.updateShownProductIds(). `null` when there's no list to
  // snapshot (FR-1005 fallback).
  const shownProductIdsForQ1 = freshActiveList ? activeProducts.map((product) => product.id) : null;

  if (!existingLead) {
    return {
      action: ACTIONS.START_FLOW,
      replies: [config.acknowledgment, q1Text],
      createLead: true,
      leadPatch: null,
      shownProductIdsToPersist: shownProductIdsForQ1,
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
    // FR-1002/FR-1004/HIGH-severity post-review fix: when a numbered list
    // was actually shown for Q1 (existingLead.shown_product_ids -- the
    // SNAPSHOT of what THIS lead was shown, never a fresh activeProducts
    // re-query, see judgment call 4 above), a reply that parses as a bare
    // number is resolved right here, against that snapshot:
    //   - in-range AND the resolved product is still active right now ->
    //     a deterministic pick (no fuzzy matching involved, NFR-1002).
    //   - in-range but the resolved product was deactivated in the
    //     interim -> `numberedSelectionStale`, NOT a confident match and
    //     NOT silently substituted with a different product (see header
    //     comment) -- inboundMessageProcessor.js treats this like FR-901's
    //     spirit (no match, needs_review=true).
    //   - out-of-range -> folds into the exact same "structurally
    //     unusable" bucket as no-usable-text below (FR-1004), reusing the
    //     retry-then-fallback logic rather than a parallel error path.
    //   - not a number at all -> `numberedSelection`/`numberedSelectionStale`
    //     both stay at their defaults and this is handled exactly like
    //     today (FR-1003: ordinary ANSWER_Q1, free text fuzzy-matched
    //     downstream by inboundMessageProcessor.js).
    const shownProductIds = Array.isArray(existingLead.shown_product_ids) ? existingLead.shown_product_ids : null;
    const hasSnapshot = Array.isArray(shownProductIds) && shownProductIds.length > 0;

    let numberedSelection = null;
    let numberedSelectionStale = false;
    let outOfRangeNumber = false;
    if (hasSnapshot && hasUsableText(messageText)) {
      const parsedNumber = parseNumberSelection(messageText);
      if (parsedNumber !== null) {
        if (parsedNumber >= 1 && parsedNumber <= shownProductIds.length) {
          const targetId = shownProductIds[parsedNumber - 1];
          // Re-check RIGHT NOW, against fresh activeProducts, whether the
          // specific product the customer actually meant is still active
          // -- never assume the snapshot is still accurate, and never
          // fall back to whatever fresh activeProducts happens to have at
          // this same position (that's the exact bug this fixes).
          const stillActiveProduct = Array.isArray(activeProducts) ? activeProducts.find((product) => product.id === targetId) : undefined;
          if (stillActiveProduct) {
            numberedSelection = stillActiveProduct;
          } else {
            numberedSelectionStale = true;
          }
        } else {
          outOfRangeNumber = true;
        }
      }
    }

    if (!hasUsableText(messageText) || outOfRangeNumber) {
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
          // FR-1004: the retry re-shows Q1's numbered list -- possibly
          // changed since the original send -- so the snapshot is
          // refreshed here too, not left pointing at the old list.
          shownProductIdsToPersist: shownProductIdsForQ1,
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
      numberedProductMatch: numberedSelection,
      numberedProductStale: numberedSelectionStale,
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

module.exports = {
  decideNextAction,
  ACTIONS,
  hasUsableText,
  DEFAULT_RETRY_PREFIX,
  buildQ1Message,
  parseNumberSelection,
  DEFAULT_Q1_LIST_INTRO,
  DEFAULT_Q1_LIST_INSTRUCTION,
};
