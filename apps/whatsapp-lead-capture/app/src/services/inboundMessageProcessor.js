'use strict';

const { decideNextAction } = require('./stateMachine');
const { log } = require('../utils/logger');
const { sendWithHumanizedTiming } = require('../lib/humanizedTiming');

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

        for (const replyText of decision.replies) {
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
      });

      return { lead, decision };
    },
  };
}

module.exports = { createInboundMessageProcessor };
