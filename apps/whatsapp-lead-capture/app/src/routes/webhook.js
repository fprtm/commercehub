'use strict';

const express = require('express');
const { verifySignature } = require('../utils/signature');
const { extractMessages } = require('../services/parseWebhookPayload');
const { ACTIONS } = require('../services/stateMachine');
const { createInboundMessageProcessor } = require('../services/inboundMessageProcessor');
const { log } = require('../utils/logger');

function captureRawBody(req, res, buf) {
  req.rawBody = buf;
}

/**
 * Converts a Meta message "timestamp" (unix seconds, as a string) into an
 * ISO-8601 string for storage. Falls back to "now" if missing/unparseable
 * (e.g. a hand-crafted test/demo payload) rather than failing the whole
 * request over a non-essential field.
 */
function toIsoTimestamp(unixSecondsString) {
  const seconds = Number(unixSecondsString);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db - unused directly, kept for symmetry/future use
 * @param {ReturnType<typeof import('../services/leadsRepo').createLeadsRepo>} deps.leadsRepo
 * @param {ReturnType<typeof import('../services/failedEventsRepo').createFailedEventsRepo>} deps.failedEventsRepo
 * @param {ReturnType<typeof import('@rimba/whatsapp-connector').createMetaClient>} deps.metaClient
 * @param {object} deps.questionsConfig - loaded config/questions.json
 * @param {ReturnType<typeof import('../services/settingsRepo').createSettingsRepo>} [deps.settingsRepo]
 *   - FR-402 (docs/sdd/changes/2026-09-01-auto-reply-toggle.md), forwarded
 *   straight into the shared inboundMessageProcessor.js.
 * @param {string} deps.verifyToken - WHATSAPP_VERIFY_TOKEN
 * @param {string|undefined} deps.appSecret - WHATSAPP_APP_SECRET. The real
 *   entrypoint (src/server.js) now refuses to boot without this set
 *   (it's in REQUIRED_ENV_VARS), so in a deployed build signature
 *   verification is never optional. It remains an injectable dependency
 *   here (rather than hardcoded) so the createApp() factory can still be
 *   used directly by tests without needing a real secret.
 * @param {(ms: number) => Promise<unknown>} [deps.sleep] - FR-601/NFR-603
 *   (docs/sdd/changes/2026-09-01-humanized-timing-module.md): forwarded
 *   straight into inboundMessageProcessor.js's humanized-timing wiring.
 *   Left undefined in production (real delay); tests inject a fast fake --
 *   see tests/helpers/testApp.js.
 * @param {() => number} [deps.random] - FR-601/NFR-603: forwarded straight
 *   into inboundMessageProcessor.js's humanized-timing wiring, same
 *   reasoning as `sleep` -- undefined in production (real `Math.random`),
 *   fixed in tests so the FR-603 refresh-count is deterministic.
 * @param {Array<{name: string, aliases?: string[]}>} [deps.products] -
 *   FR-502..FR-504, forwarded straight into
 *   inboundMessageProcessor.js's fuzzy-matching wiring. See that file's
 *   doc comment for why this is left undefined by default rather than
 *   defaulting to `[]`.
 * @param {ReturnType<typeof import('../services/productsRepo').createProductsRepo>} [deps.productsRepo] -
 *   FR-702, forwarded straight into inboundMessageProcessor.js -- see that
 *   file's doc comment for the precedence between this and `products`.
 * @param {number} [deps.matchThreshold] - forwarded straight into
 *   inboundMessageProcessor.js (FR-502..FR-504).
 * @param {string[]} [deps.intentDenylist] - forwarded straight into
 *   inboundMessageProcessor.js (FR-502..FR-504, post-review Critical fix).
 */
function createWebhookRouter(deps) {
  const {
    leadsRepo,
    failedEventsRepo,
    metaClient,
    questionsConfig,
    verifyToken,
    appSecret,
    settingsRepo,
    sleep,
    random,
    products,
    productsRepo,
    matchThreshold,
    intentDenylist,
  } = deps;
  const router = express.Router();

  // FR-302: the actual state-machine-driving logic lives in the shared
  // processor (src/services/inboundMessageProcessor.js) so the Baileys
  // connector can call the exact same code path -- this route is now just
  // an adapter that maps Meta's webhook payload shape onto that shared
  // contract.
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig,
    sendTextMessage: metaClient.sendTextMessage,
    settingsRepo,
    // FR-604: routes the Cloud API send path through the shared
    // humanized-timing module via metaClient's markAsRead/sendTypingIndicator
    // primitives.
    markAsRead: metaClient.markAsRead,
    sendTypingIndicator: metaClient.sendTypingIndicator,
    sleep,
    random,
    products,
    productsRepo,
    matchThreshold,
    intentDenylist,
  });

  // GET /webhook -- Meta's verification handshake (Phase L).
  router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken) {
      log('webhook_verified', {});
      res.status(200).type('text/plain').send(challenge);
    } else {
      log('webhook_verification_failed', { mode });
      res.sendStatus(403);
    }
  });

  async function processMessage(message) {
    return processInboundMessage({
      phoneNumber: message.from,
      messageBody: message.text,
      messageType: message.type,
      timestamp: toIsoTimestamp(message.timestamp),
      channel: 'whatsapp_cloud_api',
      // FR-601: the WAMID (see parseWebhookPayload.js), so markAsRead/
      // sendTypingIndicator above can reference this specific message.
      messageId: message.id,
    });
  }

  // POST /webhook -- inbound message event (Phase L, TD-004: always 200).
  router.post(
    '/webhook',
    express.json({ verify: captureRawBody, limit: '1mb' }),
    async (req, res, next) => {
      try {
        if (appSecret) {
          const signatureHeader = req.headers['x-hub-signature-256'];
          const valid = verifySignature(req.rawBody, signatureHeader, appSecret);
          if (!valid) {
            throw new Error('Invalid X-Hub-Signature-256 signature');
          }
        }

        const messages = extractMessages(req.body);
        for (const message of messages) {
          // eslint-disable-next-line no-await-in-loop -- process sequentially, not a hot path
          await processMessage(message);
        }

        res.status(200).json({ status: 'received' });
      } catch (err) {
        next(err);
      }
    },
    // Route-scoped error handler (TD-004): any failure while processing this
    // request -- bad signature, malformed payload, DB error, Meta API error
    // -- is recorded as a FailedEvent and Meta still gets a 200, so it does
    // not retry-and-duplicate the same event.
    // eslint-disable-next-line no-unused-vars
    (err, req, res, next) => {
      log('webhook_processing_failed', { error: err.message });
      try {
        failedEventsRepo.record({
          rawPayload: req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}),
          errorMessage: err.message,
          channel: 'whatsapp_cloud_api',
        });
      } catch (recordErr) {
        // If even logging the failure fails, we still must not throw back
        // to Meta -- log to console as a last resort and move on.
        log('failed_event_record_error', { error: recordErr.message });
      }
      res.status(200).json({ status: 'received' });
    },
  );

  return router;
}

module.exports = { createWebhookRouter, toIsoTimestamp, ACTIONS };
