'use strict';

/**
 * Extracts a normalized list of inbound messages from a raw Meta WhatsApp
 * Cloud API webhook payload (Phase L example payload shape).
 *
 * Meta sends the same webhook URL both for actual inbound customer
 * messages ("messages" field) AND for delivery-status receipts ("statuses"
 * field, e.g. sent/delivered/read ticks for messages *we* sent). A
 * statuses-only payload is normal traffic, not a processing failure -- it
 * simply yields an empty messages array here, and the webhook route
 * acknowledges 200 without creating a FailedEvent for it.
 *
 * Throws only when the payload's basic envelope shape is unrecognizable
 * (not valid JSON structure at all), which the webhook route treats as a
 * genuine malformed-payload failure per NFR-002.
 *
 * @param {object} payload - parsed JSON body of the webhook POST
 * @returns {Array<{ from: string, timestamp: string, type: string, text: string|null }>}
 */
function extractMessages(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entry)) {
    throw new Error('Malformed webhook payload: missing "entry" array');
  }

  const messages = [];

  for (const entry of payload.entry) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (!value || !Array.isArray(value.messages)) continue; // e.g. a "statuses" change - not an error

      for (const msg of value.messages) {
        if (!msg || typeof msg.from !== 'string' || msg.from.length === 0) {
          throw new Error('Malformed webhook payload: message missing "from"');
        }
        messages.push({
          from: msg.from,
          timestamp: msg.timestamp || null,
          type: msg.type || 'unknown',
          text: msg.type === 'text' && msg.text && typeof msg.text.body === 'string' ? msg.text.body : null,
        });
      }
    }
  }

  return messages;
}

module.exports = { extractMessages };
