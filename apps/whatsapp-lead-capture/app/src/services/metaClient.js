'use strict';

const { log } = require('../utils/logger');

const GRAPH_API_VERSION = 'v20.0';

/**
 * Real Meta WhatsApp Cloud API client. This is written against the actual
 * Graph API contract so it would work against a real WhatsApp Business
 * number -- but no live credentials were available in this environment, so
 * it has only been exercised in tests via a mock implementation (see
 * tests/webhook.test.js). A real round-trip against Meta's test number is
 * a documented manual-verification gap (see app/README.md).
 *
 * @param {object} params
 * @param {string} params.accessToken - system user access token (Bearer auth)
 * @param {string} params.phoneNumberId - the "Phone Number ID" from the Meta app dashboard
 * @param {typeof fetch} [params.fetchImpl] - injectable fetch implementation for testing
 */
function createMetaClient({ accessToken, phoneNumberId, fetchImpl = fetch }) {
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  return {
    /**
     * Sends a plain-text WhatsApp message to `to` (a phone number in
     * international format, no leading '+', per Meta's API contract).
     * Returns the parsed JSON response body on success; throws on a
     * non-2xx response or network failure so callers (the webhook route)
     * can catch it and record a FailedEvent per TD-004/NFR-002.
     */
    async sendTextMessage(to, body) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body },
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        log('meta_send_failed', { to, status: response.status, payload });
        const err = new Error(`Meta API error (${response.status}): ${JSON.stringify(payload)}`);
        err.metaResponse = payload;
        throw err;
      }

      log('meta_send_ok', { to, messageId: payload?.messages?.[0]?.id });
      return payload;
    },

    /**
     * FR-601/FR-604 (docs/sdd/changes/2026-09-01-humanized-timing-module.md):
     * the outbound half of the shared humanized-timing contract, alongside
     * sendTypingIndicator below. Meta's real Cloud API marks a specific
     * inbound message as read via `{ status: 'read', message_id }` -- it
     * needs no `to` field (the phone_number_id in the URL already scopes
     * the call), so `_phoneNumber` here is accepted only to keep this
     * function's signature identical to baileysConnector.js's markAsRead
     * (which *does* need the phone number, to build a JID) -- the shared
     * caller (inboundMessageProcessor.js) can then treat both connectors
     * uniformly without knowing which one it's talking to.
     *
     * Deliberately never throws: a failure to mark-as-read/show-typing is a
     * "nice to have" human-feel signal, not the substantive reply -- it must
     * never block or fail the actual message send that follows.
     */
    async markAsRead(_phoneNumber, messageId) {
      return sendStatusUpdate({ messageId, status: 'read' });
    },

    /**
     * FR-603: re-sending this periodically (owned by
     * src/lib/humanizedTiming.js, not this file) is what keeps the
     * indicator from visibly lapsing on long simulated typing durations,
     * since Meta auto-dismisses it after ~25s. Modeled on Meta's real
     * combined read+typing-indicator status update.
     */
    async sendTypingIndicator(_phoneNumber, messageId) {
      return sendStatusUpdate({ messageId, status: 'read', typingIndicator: true });
    },
  };

  async function sendStatusUpdate({ messageId, status, typingIndicator = false }) {
    // Without an inbound message id there is nothing to mark read / show
    // typing against (e.g. a caller that never threaded one through) --
    // silently no-op rather than sending a malformed request.
    if (!messageId) return null;

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status,
          message_id: messageId,
          ...(typingIndicator ? { typing_indicator: { type: 'text' } } : {}),
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        log('meta_status_update_failed', { messageId, status, statusCode: response.status, payload });
        return null;
      }

      return payload;
    } catch (err) {
      log('meta_status_update_error', { messageId, status, error: err.message });
      return null;
    }
  }
}

module.exports = { createMetaClient, GRAPH_API_VERSION };
