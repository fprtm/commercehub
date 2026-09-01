'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { log } = require('../utils/logger');

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../services/leadsRepo').createLeadsRepo>} deps.leadsRepo
 */
function createLeadsRouter({ leadsRepo }) {
  const router = express.Router();

  router.get('/leads', requireAuth, (req, res) => {
    const leads = leadsRepo.listAllMostRecentFirst();
    res.render('leads', { leads, flash: req.session.flash || null });
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
      const leads = leadsRepo.listAllMostRecentFirst();
      if (err.code === 'NOT_FOUND') {
        return res.status(404).render('leads', { leads, flash: 'This lead no longer exists.' });
      }
      if (err.code === 'INVALID_STATUS') {
        return res.status(400).render('leads', { leads, flash: `"${status}" is not a valid status.` });
      }
      throw err;
    }
  });

  return router;
}

module.exports = { createLeadsRouter };
