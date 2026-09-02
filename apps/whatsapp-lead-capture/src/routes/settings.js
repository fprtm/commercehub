'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { log } = require('../utils/logger');

/**
 * FR-401 (docs/sdd/changes/2026-09-01-auto-reply-toggle.md): a single POST
 * route for the owner to flip `auto_reply_enabled`, session-authenticated
 * the same way as every other dashboard route (requireAuth). Deliberately
 * no dedicated settings page/GET route -- the change doc's Settled
 * Decisions call for the toggle to live at the top of the existing Lead
 * dashboard (SCR-001), so the current state is rendered by GET /leads
 * (see routes/leads.js) and this route only handles the write side,
 * redirecting back to /leads afterward (same POST/redirect/GET pattern as
 * POST /leads/:id/status).
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('../services/settingsRepo').createSettingsRepo>} deps.settingsRepo
 */
function createSettingsRouter({ settingsRepo }) {
  const router = express.Router();

  router.post('/settings/auto-reply', requireAuth, express.urlencoded({ extended: false }), (req, res) => {
    const enabled = settingsRepo.toggleAutoReply();
    log('auto_reply_toggled', { enabled });
    res.redirect('/leads');
  });

  return router;
}

module.exports = { createSettingsRouter };
