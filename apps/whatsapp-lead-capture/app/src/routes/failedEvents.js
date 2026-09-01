'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');

/**
 * GET /failed-events -- session-authenticated, read-only view of
 * `failedEventsRepo.listAll()` (webhook/Baileys processing failures
 * already recorded by src/routes/webhook.js and
 * src/services/baileysConnector.js). Added alongside the FR-701 nav bar so
 * "Failed Events" is an actual reachable page, not a dead link -- this repo
 * and table already existed; there was simply no dashboard route for it
 * yet.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('../services/failedEventsRepo').createFailedEventsRepo>} deps.failedEventsRepo
 */
function createFailedEventsRouter({ failedEventsRepo }) {
  const router = express.Router();

  router.get('/failed-events', requireAuth, (req, res) => {
    const events = failedEventsRepo.listAll();
    res.render('failedEvents', { events });
  });

  return router;
}

module.exports = { createFailedEventsRouter };
