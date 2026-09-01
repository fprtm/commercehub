'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { log } = require('../utils/logger');

/**
 * GET /whatsapp/pair (FR-303) -- session-authenticated (owner-only, via the
 * same requireAuth middleware the /leads dashboard uses), shows the Baileys
 * pairing QR code / connection status. NFR-303: the ban-risk disclosure is
 * rendered by the view (whatsappPair.ejs) itself whenever whatsappMode is
 * 'baileys', not buried in a comment.
 *
 * @param {object} deps
 * @param {string} deps.whatsappMode - 'cloud_api' | 'baileys'
 * @param {ReturnType<typeof import('../services/baileysConnector').createBaileysConnector>|null} deps.baileysConnector
 *   - null when whatsappMode is 'cloud_api' (FR-301: the unconfigured
 *   mode's code path is not touched -- no connector is even constructed).
 */
function createWhatsappPairRouter({ whatsappMode, baileysConnector }) {
  const router = express.Router();

  router.get('/whatsapp/pair', requireAuth, (req, res) => {
    if (whatsappMode !== 'baileys' || !baileysConnector) {
      return res.render('whatsappPair', {
        whatsappMode,
        status: 'not_active',
        qrDataUrl: null,
        disconnectReasonMessage: null,
      });
    }

    const status = baileysConnector.getStatus();
    return res.render('whatsappPair', {
      whatsappMode,
      status: status.connectionStatus,
      qrDataUrl: status.qrDataUrl,
      // FR-305 (post-review fix): non-recoverable disconnects now cover more
      // than just "logged out" (session replaced, corrupted, forbidden,
      // etc) -- this carries the specific reason so the pairing screen
      // doesn't flatten them into one generic message.
      disconnectReasonMessage: status.disconnectReasonMessage || null,
    });
  });

  // Lets the owner re-pair from the dashboard after a logout (FR-305)
  // without needing shell/SSH access to the server.
  router.post('/whatsapp/pair/reset', requireAuth, express.urlencoded({ extended: false }), async (req, res, next) => {
    if (whatsappMode !== 'baileys' || !baileysConnector) {
      return res.redirect('/whatsapp/pair');
    }
    try {
      await baileysConnector.resetAndRestart();
      log('baileys_pairing_reset', {});
      return res.redirect('/whatsapp/pair');
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createWhatsappPairRouter };
