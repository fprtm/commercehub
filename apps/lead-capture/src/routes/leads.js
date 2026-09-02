'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { log } = require('../utils/logger');

// TICKET-1306 (FR-1305): only these two values are meaningful filters --
// anything else in `req.query.channel` (missing, empty string, or garbage)
// is treated as "All channels", the existing unfiltered default.
const VALID_CHANNELS = ['whatsapp', 'telegram'];

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../services/leadsRepo').createLeadsRepo>} deps.leadsRepo
 * @param {ReturnType<typeof import('../services/settingsRepo').createSettingsRepo>} [deps.settingsRepo]
 *   - FR-401 (docs/sdd/changes/2026-09-01-auto-reply-toggle.md): read fresh
 *   on every GET so the toggle's current state is always accurate on page
 *   load. Optional (defaults to "always enabled") purely so this router's
 *   pre-existing tests, which construct it without a settingsRepo, keep
 *   passing unmodified -- same pattern as inboundMessageProcessor.js.
 */
function createLeadsRouter({ leadsRepo, settingsRepo }) {
  const router = express.Router();

  router.get('/leads', requireAuth, (req, res) => {
    const selectedChannel = VALID_CHANNELS.includes(req.query.channel) ? req.query.channel : '';
    const leads = leadsRepo.listAllMostRecentFirst({ channel: selectedChannel || undefined });
    const autoReplyEnabled = settingsRepo ? settingsRepo.isAutoReplyEnabled() : true;
    res.render('leads', { leads, flash: req.session.flash || null, autoReplyEnabled, selectedChannel });
    req.session.flash = null;
  });

  router.post('/leads/:id/status', requireAuth, express.urlencoded({ extended: false }), (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    const numericId = Number(id);

    try {
      if (!Number.isInteger(numericId)) {
        const err = new Error(`Invalid lead id: ${id}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      leadsRepo.updateStatus(numericId, status);
      log('lead_status_updated', { leadId: id, status });
      // 200-on-reload semantics via the standard POST/redirect/GET pattern
      // (Phase L: "redirect to /leads with updated state visible").
      return res.redirect('/leads');
    } catch (err) {
      // Phase L specifies literal 404 / 400 status codes for these error
      // cases while also saying "list reloads correctly" -- an HTTP
      // redirect can't carry a non-3xx status, so both requirements are
      // met by rendering the current leads list directly (with the
      // plain-language flash message) at the 404/400 status code,
      // instead of issuing a redirect for the error path.
      // Not filtered -- this error path re-renders after a POST that has no
      // `channel` query param of its own, so it reverts to "All channels"
      // (same posture as before this ticket: the error render never had a
      // filter concept).
      const leads = leadsRepo.listAllMostRecentFirst();
      const autoReplyEnabled = settingsRepo ? settingsRepo.isAutoReplyEnabled() : true;
      if (err.code === 'NOT_FOUND') {
        return res.status(404).render('leads', { leads, flash: 'This lead no longer exists.', autoReplyEnabled, selectedChannel: '' });
      }
      if (err.code === 'INVALID_STATUS') {
        return res.status(400).render('leads', { leads, flash: `"${status}" is not a valid status.`, autoReplyEnabled, selectedChannel: '' });
      }
      throw err;
    }
  });

  return router;
}

module.exports = { createLeadsRouter };
