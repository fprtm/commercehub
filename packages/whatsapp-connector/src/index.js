'use strict';

/**
 * @rimba/whatsapp-connector
 * =========================
 * Dual-mode WhatsApp connectivity: the official Cloud API (`createMetaClient`,
 * push-webhook model -- the app's own webhook route feeds inbound events into
 * it) and Baileys (`createBaileysConnector`, persistent-socket model -- this
 * connector owns the socket and calls the app-supplied
 * `processInboundMessage` callback itself).
 *
 * --- The uniform outbound surface (FR-1104) -------------------------------
 * Both factories return an object exposing the SAME three-function outbound
 * contract, regardless of mode -- this is what lets
 * inboundMessageProcessor.js (app-side) send/mark-read/show-typing without
 * ever knowing which transport it's talking to:
 *   - sendTextMessage(phoneNumber, text) -> Promise
 *   - markAsRead(phoneNumber, messageId) -> Promise (never throws)
 *   - sendTypingIndicator(phoneNumber, messageId) -> Promise (never throws)
 *
 * --- Where the two modes deliberately differ, and why (judgment call) -----
 * Cloud API is a push-webhook model: WhatsApp POSTs to the app's own
 * /webhook route, which converts the payload and calls the app's
 * processInboundMessage directly -- there is no "inbound subscription" or
 * "connection status" concept for this package to own, because the app's
 * route already IS that boundary. Baileys is the opposite: a persistent
 * socket this package owns, so it necessarily also owns connection
 * lifecycle (start(), resetAndRestart()), inbound message dispatch (the
 * `processInboundMessage` callback supplied at construction), and
 * status/QR retrieval (getStatus()) for the app's /whatsapp/pair route to
 * render. Forcing metaClient to expose no-op start()/getStatus() stubs
 * just to look symmetrical was considered and rejected -- it would invent
 * API surface with no real behavior behind it, which is worse than an
 * honestly asymmetric export that matches the two transports' genuinely
 * different structural models (see baileysConnector.js's own header
 * comment for the fuller "persistent-connection vs push-webhook"
 * reasoning this package inherits verbatim from the source app).
 */
const { createBaileysConnector, toPhoneNumber, toJid, extractBaileysContent } = require('./baileysConnector');
const { createMetaClient, GRAPH_API_VERSION } = require('./metaClient');

module.exports = {
  createBaileysConnector,
  createMetaClient,
  toPhoneNumber,
  toJid,
  extractBaileysContent,
  GRAPH_API_VERSION,
};
