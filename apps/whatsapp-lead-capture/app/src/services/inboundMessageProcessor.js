'use strict';

const { decideNextAction, ACTIONS } = require('./stateMachine');
const { log } = require('../utils/logger');
const { sendWithHumanizedTiming } = require('../lib/humanizedTiming');
const { matchProduct } = require('./productMatcher');

/**
 * The shared inbound-message contract (FR-302 of
 * docs/sdd/changes/2026-09-01-baileys-dual-mode.md).
 *
 * This is the ONE place that drives the qualifying-question state machine
 * from an inbound WhatsApp message, regardless of which connector received
 * it. It was extracted verbatim (same DB calls, same reply-send loop, same
 * decision logic) from what used to be `processMessage()` inside
 * src/routes/webhook.js -- that route is now just a thin adapter that maps
 * Meta's webhook payload shape onto this function's params, and the new
 * Baileys connector (src/services/baileysConnector.js) does the same for
 * Baileys' `messages.upsert` event shape.
 *
 * The state machine (stateMachine.js), the Lead repo (leadsRepo.js) and the
 * dashboard have zero mode-specific branching -- this function and its two
 * callers are the only places that know a "mode" concept exists at all.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('./leadsRepo').createLeadsRepo>} deps.leadsRepo
 * @param {object} deps.questionsConfig - loaded config/questions.json
 * @param {(phoneNumber: string, text: string) => Promise<unknown>} deps.sendTextMessage
 *   - the outbound half of FR-302's shared contract. Both metaClient and the
 *   Baileys connector expose a function with this exact shape, so this
 *   module never needs to know which one it's talking to.
 * @param {ReturnType<typeof import('./settingsRepo').createSettingsRepo>} [deps.settingsRepo]
 *   - FR-402/NFR-401 (docs/sdd/changes/2026-09-01-auto-reply-toggle.md):
 *   queried fresh on every single inbound message to decide whether the
 *   reply-send loop below runs at all. Optional and defaults to "always
 *   enabled" so every pre-existing caller/test that constructs this
 *   processor without it (there are several) keeps working completely
 *   unmodified -- same additive-parameter pattern already used for
 *   `channel` above.
 * @param {(phoneNumber: string, messageId: string|undefined) => Promise<unknown>} [deps.markAsRead]
 *   - FR-601/FR-604 (docs/sdd/changes/2026-09-01-humanized-timing-module.md):
 *   the connector-specific "mark this inbound message as read" primitive
 *   (metaClient.markAsRead / baileysConnector.markAsRead). Optional and
 *   defaults to a no-op so every pre-existing caller/test that constructs
 *   this processor without it keeps working unmodified -- same
 *   additive-parameter pattern as `settingsRepo` above.
 * @param {(phoneNumber: string, messageId: string|undefined) => Promise<unknown>} [deps.sendTypingIndicator]
 *   - FR-601/FR-603: the connector-specific "show typing" primitive.
 *   Optional, defaults to a no-op, same reasoning as `markAsRead` above.
 * @param {(ms: number) => Promise<unknown>} [deps.sleep] - injectable delay
 *   mechanism forwarded straight into
 *   src/lib/humanizedTiming.js#sendWithHumanizedTiming (NFR-603). Left
 *   undefined in production (real setTimeout-based delay); tests pass a
 *   fast/instant fake so the suite never actually waits in real time.
 * @param {() => number} [deps.random] - injectable RNG forwarded straight
 *   into src/lib/humanizedTiming.js#sendWithHumanizedTiming (NFR-603, same
 *   reasoning as `sleep`). Left undefined in production (real
 *   `Math.random`); tests pass a fixed function so the exact typing-delay
 *   duration -- and therefore how many times FR-603's periodic
 *   typing-indicator refresh fires -- is deterministic instead of
 *   depending on which side of the ~20s refresh threshold real jitter
 *   happens to land on for a given message length.
 * @param {Array<{name: string, aliases?: string[]}>} [deps.products] -
 *   FR-502..FR-504 (docs/sdd/changes/2026-09-01-fuzzy-product-matching.md):
 *   the Product catalog (see src/services/productsLoader.js) fuzzy-matched
 *   against a Q1 answer the moment it's accepted. Deliberately left
 *   `undefined` by default (rather than defaulting to `[]`) -- same
 *   additive-parameter pattern as `settingsRepo`/`markAsRead` above -- so
 *   the many pre-existing callers/tests that construct this processor
 *   without it keep exercising the exact pre-fuzzy-matching behavior
 *   (Q2 always sent on a usable Q1 answer), completely unmodified
 *   (NFR-502). Matching only activates when this is explicitly provided
 *   (an empty array `[]` counts as "provided" and activates matching --
 *   see productMatcher.js for why an empty catalog then safely always
 *   resolves to "no match"/needs_review rather than crashing).
 * @param {ReturnType<typeof import('./productsRepo').createProductsRepo>} [deps.productsRepo] -
 *   FR-702 (docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md):
 *   when provided, the Product catalog is read fresh from the database
 *   (`productsRepo.listActive()`) on every single call, instead of using
 *   the static `products` array above -- same "no caching, always current"
 *   pattern settingsRepo already uses for the auto-reply toggle (see
 *   NFR-401 above), so a product just deactivated/edited via the dashboard
 *   (src/routes/products.js) affects the very next inbound message, not
 *   just after a server restart. `products` still takes precedence when
 *   BOTH are provided (it never is, in production -- src/server.js injects
 *   only `productsRepo` from here on) purely so every pre-existing
 *   caller/test that passes a static `products` array (there are many, all
 *   predating this change) keeps exercising fuzzy-matching exactly as
 *   before, unmodified (NFR-701). Only `productsRepo` alone activates the
 *   new DB-backed path.
 * @param {number} [deps.matchThreshold] - forwarded straight into
 *   productMatcher.js's `matchProduct` (defaults to
 *   productMatcher.js's DEFAULT_MATCH_THRESHOLD when omitted).
 * @param {string[]} [deps.intentDenylist] - forwarded straight into
 *   productMatcher.js's `matchProduct` (defaults to
 *   productMatcher.js's DEFAULT_INTENT_DENYLIST when omitted). Post-review
 *   fix (Critical finding): independent safety net that forces
 *   needs_review whenever the customer's text contains a complaint/
 *   intent-shifting word (e.g. "refund", "rusak"), regardless of the
 *   token-similarity score -- see productMatcher.js's doc comment for why
 *   this is necessary in addition to (not instead of) the scoring fix.
 */
function createInboundMessageProcessor({
  leadsRepo,
  questionsConfig,
  sendTextMessage,
  settingsRepo,
  markAsRead,
  sendTypingIndicator,
  sleep,
  random,
  products,
  productsRepo,
  matchThreshold,
  intentDenylist,
}) {
  return {
    /**
     * @param {object} params
     * @param {string} params.phoneNumber - phone number in the same format
     *   leadsRepo/Lead rows already use (no leading '+', digits only --
     *   matches Meta's format; the Baileys adapter normalizes its JIDs to
     *   this same shape before calling in).
     * @param {string|null} params.messageBody - inbound text, or null for a
     *   non-text message type (image/sticker/etc).
     * @param {string} params.messageType - e.g. 'text', 'sticker', 'image'.
     *   Not consumed by the state machine (which only cares whether usable
     *   text is present -- see stateMachine.js), but threaded through and
     *   logged for observability/debugging parity with the old behavior.
     * @param {string} [params.timestamp] - ISO-8601 string for the
     *   message's original timestamp; each caller is responsible for
     *   converting its platform-specific timestamp format (Meta: unix
     *   seconds as a string; Baileys: unix seconds as a number) into ISO
     *   before calling in. Falls back to "now" if omitted.
     * @param {string} [params.channel] - 'whatsapp_cloud_api' |
     *   'whatsapp_baileys', purely for logging/FailedEvent attribution.
     * @param {string} [params.messageId] - FR-601: the inbound message's own
     *   id (Meta's WAMID, or Baileys' `msg.key.id`), threaded through to
     *   `markAsRead`/`sendTypingIndicator` below so the read receipt/typing
     *   indicator can reference the specific message that triggered this
     *   reply. Optional -- if omitted, markAsRead simply has nothing to mark.
     */
    async processInboundMessage({
      phoneNumber,
      messageBody,
      messageType,
      timestamp,
      channel = 'whatsapp_cloud_api',
      messageId,
    }) {
      const existingLead = leadsRepo.findByPhone(phoneNumber);
      const decision = decideNextAction({
        existingLead,
        messageText: messageBody,
        config: questionsConfig,
      });

      let lead = existingLead;
      if (decision.createLead) {
        lead = leadsRepo.create({
          phoneNumber,
          firstMessageAt: timestamp || new Date().toISOString(),
        });
      }
      if (decision.leadPatch && lead) {
        lead = leadsRepo.saveAnswers(lead.id, decision.leadPatch);
      }

      // FR-502..FR-504: the instant a Q1 answer is accepted, fuzzy-match it
      // against the Product catalog (see src/services/productMatcher.js).
      // Gated on `Array.isArray(products)` rather than truthiness so an
      // explicitly-empty catalog (`products: []`) still activates matching
      // -- NFR-502's "empty catalog -> always no match -> needs_review,
      // never a crash" case -- while an *omitted* `products` dependency
      // (every pre-existing caller/test) leaves this whole block inert,
      // preserving today's unmodified behavior (see the constructor's doc
      // comment above).
      //
      // This intentionally never touches the state machine's own
      // question1_answer/retry/fallback bookkeeping (already committed
      // above, unconditionally) -- Settled Decision #3 in the change doc:
      // "no fallback/retry triggered by this alone." The ONLY two things a
      // low-confidence/no match changes are (a) `matched_product`/
      // `needs_review` on the Lead row, for the dashboard, and (b)
      // suppressing this turn's would-be Q2 prompt reply -- the customer's
      // raw answer is still saved and visible, and the very next message
      // they send is handled completely normally by the (unmodified)
      // state machine.
      let replies = decision.replies;
      // FR-702: `products` (static array) wins when explicitly provided --
      // see the constructor's doc comment above for why. Otherwise, an
      // injected `productsRepo` is read fresh, right here, right before
      // matching -- never at construction time -- so a dashboard
      // deactivate/edit is reflected on the very next message.
      const catalog = Array.isArray(products) ? products : productsRepo ? productsRepo.listActive() : undefined;
      if (decision.action === ACTIONS.ANSWER_Q1 && lead && Array.isArray(catalog)) {
        const matchResult = matchProduct(messageBody, catalog, { threshold: matchThreshold, intentDenylist });
        if (matchResult.matched) {
          // FR-503: above threshold, today's flow proceeds completely
          // unchanged (`replies` is left as-is, so Q2 still gets sent) --
          // the only addition is recording the matched product name.
          lead = leadsRepo.updateProductMatch(lead.id, {
            matchedProduct: matchResult.product.name,
            needsReview: false,
          });
        } else {
          // FR-504: below threshold (including "no match found" -- score
          // 0, or the empty-catalog case above) -- suppress this turn's Q2
          // prompt and flag the lead for manual review.
          lead = leadsRepo.updateProductMatch(lead.id, { matchedProduct: null, needsReview: true });
          replies = [];
        }
      }

      // FR-402/NFR-401: read fresh on every call, no caching -- a toggle
      // flipped between two inbound messages (or by a concurrent dashboard
      // request) is picked up on the very next message, never stale.
      const autoReplyEnabled = settingsRepo ? settingsRepo.isAutoReplyEnabled() : true;

      if (autoReplyEnabled) {
        // FR-601/FR-604: every automated reply (ack, question, retry, or
        // fallback) is routed through the shared, transport-agnostic
        // humanized-timing module (src/lib/humanizedTiming.js) instead of
        // being sent immediately -- see
        // docs/sdd/changes/2026-09-01-humanized-timing-module.md and
        // Decision 001 for why this replaces the original 5s reply budget.
        //
        // Post-review fix (gap found: markAsRead was silently skipped
        // whenever decision.replies was empty -- not just in the
        // multi-reply-batch case the original comment here described, but
        // also for NO_OP on an already-responded/closed lead, fallback
        // already triggered, flow already complete, or ANSWER_Q2 with no
        // completionMessage configured. In every one of those cases a
        // customer's genuinely new inbound message got no read receipt at
        // all.) Decision made: (b) -- markAsRead now fires unconditionally
        // for any new inbound message while auto-reply is ON, regardless of
        // whether a scripted reply follows. Decision 001 frames the read
        // receipt purely as "the customer gets an early signal their
        // message was received", which does not logically depend on
        // whether a reply is queued -- so it is called here, exactly once,
        // before the reply loop (not per-reply -- there is still only one
        // inbound message to mark read, and re-marking it before every
        // reply in a multi-reply batch would just add compounding latency
        // with no real human-behavior justification). Each reply below
        // still gets its own full typing-indicator + length-proportional
        // delay -- only the already-fired markAsRead is a no-op there.
        if (markAsRead) await markAsRead(phoneNumber, messageId);

        for (const replyText of replies) {
          // eslint-disable-next-line no-await-in-loop -- messages must go out in this exact order
          await sendWithHumanizedTiming({
            messageText: replyText,
            sleep,
            random,
            markAsRead: async () => {}, // already fired once, above, for this inbound message
            sendTypingIndicator: async () => {
              if (sendTypingIndicator) await sendTypingIndicator(phoneNumber, messageId);
            },
            sendMessage: (text) => sendTextMessage(phoneNumber, text),
          });
        }
      }
      // FR-402: when OFF, the Lead bookkeeping above still ran exactly as
      // today -- only the outbound send loop is skipped. No reply is
      // "queued" or sent later either; toggling back ON does not
      // retroactively message whoever wrote in while it was OFF (there is
      // nothing pending to flush -- decision.replies for this message simply
      // never got sent).

      log('inbound_message_processed', {
        channel,
        leadId: lead?.id,
        messageType,
        action: decision.action,
        autoReplyEnabled,
        reason: decision.reason,
        needsReview: lead?.needs_review === 1,
      });

      // `replies` (rather than the state machine's original decision.replies)
      // is returned here so callers/tests observe what was actually sent --
      // identical to decision.replies for every action except a
      // below-threshold ANSWER_Q1 (FR-504), where the Q2 prompt was
      // suppressed above.
      return { lead, decision: { ...decision, replies } };
    },
  };
}

module.exports = { createInboundMessageProcessor };
