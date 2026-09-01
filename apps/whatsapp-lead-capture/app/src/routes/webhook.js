'use strict';

const express = require('express');
const { verifySignature } = require('../utils/signature');
const { extractMessages } = require('../services/parseWebhookPayload');
const { decideNextAction, ACTIONS } = require('../services/stateMachine');
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
 * @param {ReturnType<typeof import('../services/metaClient').createMetaClient>} deps.metaClient
 * @param {object} deps.questionsConfig - loaded config/questions.json
 * @param {string} deps.verifyToken - WHATSAPP_VERIFY_TOKEN
 * @param {string|undefined} deps.appSecret - WHATSAPP_APP_SECRET. The real
 *   entrypoint (src/server.js) now refuses to boot without this set
 *   (it's in REQUIRED_ENV_VARS), so in a deployed build signature
 *   verification is never optional. It remains an injectable dependency
 *   here (rather than hardcoded) so the createApp() factory can still be
 *   used directly by tests without needing a real secret.
 */
function createWebhookRouter(deps) {
  const { leadsRepo, failedEventsRepo, metaClient, questionsConfig, verifyToken, appSecret } = deps;
  const router = express.Router();

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
    const existingLead = leadsRepo.findByPhone(message.from);
    const decision = decideNextAction({
      existingLead,
      messageText: message.text,
      config: questionsConfig,
    });

    let lead = existingLead;
    if (decision.createLead) {
      lead = leadsRepo.create({
        phoneNumber: message.from,
        firstMessageAt: toIsoTimestamp(message.timestamp),
      });
    }
    if (decision.leadPatch && lead) {
      lead = leadsRepo.saveAnswers(lead.id, decision.leadPatch);
    }

    for (const replyText of decision.replies) {
      // eslint-disable-next-line no-await-in-loop -- Meta requires messages in this exact order
      await metaClient.sendTextMessage(message.from, replyText);
    }

    log('webhook_message_processed', {
      leadId: lead?.id,
      action: decision.action,
      reason: decision.reason,
    });

    return { lead, decision };
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
