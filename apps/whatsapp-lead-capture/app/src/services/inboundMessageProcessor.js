'use strict';

const { decideNextAction } = require('./stateMachine');
const { log } = require('../utils/logger');

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
 */
function createInboundMessageProcessor({ leadsRepo, questionsConfig, sendTextMessage }) {
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
     */
    async processInboundMessage({ phoneNumber, messageBody, messageType, timestamp, channel = 'whatsapp_cloud_api' }) {
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

      for (const replyText of decision.replies) {
        // eslint-disable-next-line no-await-in-loop -- messages must go out in this exact order
        await sendTextMessage(phoneNumber, replyText);
      }

      log('inbound_message_processed', {
        channel,
        leadId: lead?.id,
        messageType,
        action: decision.action,
        reason: decision.reason,
      });

      return { lead, decision };
    },
  };
}

module.exports = { createInboundMessageProcessor };
