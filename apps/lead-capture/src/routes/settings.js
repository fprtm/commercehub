'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { log } = require('../utils/logger');

/**
 * FR-401 (docs/sdd/changes/2026-09-01-auto-reply-toggle.md): a single POST
 * route for the owner to flip `auto_reply_enabled`, session-authenticated
 * the same way as every other dashboard route (requireAuth). Deliberately
 * no dedicated settings page/GET route for this one -- the change doc's
 * Settled Decisions call for the toggle to live at the top of the existing
 * Lead dashboard (SCR-001), so the current state is rendered by GET /leads
 * (see routes/leads.js) and this route only handles the write side,
 * redirecting back to /leads afterward (same POST/redirect/GET pattern as
 * POST /leads/:id/status).
 *
 * Also hosts GET/POST /settings/credentials (added 2026-09-03,
 * docs/sdd/changes/2026-09-03-credentials-in-db.md) -- this one DOES have
 * its own dashboard page, since unlike the auto-reply boolean there are 5
 * fields to manage and most are secrets that must never round-trip back
 * into rendered HTML.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('../services/settingsRepo').createSettingsRepo>} deps.settingsRepo
 */
/**
 * Renders the current credential state without ever echoing a saved secret
 * value back into the HTML -- only whether each field is set. This is what
 * lets GET /settings/credentials be requireAuth-gated but still safe to
 * view-source (no secret is present in the response either way).
 */
function credentialFieldStates(settingsRepo) {
  const wa = settingsRepo.getWhatsappCloudApiCredentials();
  const telegramBotToken = settingsRepo.getTelegramBotToken();
  return {
    whatsappVerifyTokenSet: Boolean(wa.verifyToken),
    whatsappAccessTokenSet: Boolean(wa.accessToken),
    whatsappPhoneNumberIdSet: Boolean(wa.phoneNumberId),
    whatsappAppSecretSet: Boolean(wa.appSecret),
    // Not a secret (needed to configure Meta's webhook dashboard), so it's
    // the one field shown in full rather than just "set/not set".
    whatsappPhoneNumberId: wa.phoneNumberId,
    telegramBotTokenSet: Boolean(telegramBotToken),
  };
}

function createSettingsRouter({ settingsRepo }) {
  const router = express.Router();

  router.post('/settings/auto-reply', requireAuth, express.urlencoded({ extended: false }), (req, res) => {
    const enabled = settingsRepo.toggleAutoReply();
    log('auto_reply_toggled', { enabled });
    res.redirect('/leads');
  });

  // Added 2026-09-03 (docs/sdd/changes/2026-09-03-credentials-in-db.md):
  // owner-fillable connector credentials, moved out of `.env` and into the
  // DB so the owner can configure/rotate them from the dashboard instead of
  // editing a file and restarting the process by hand.
  router.get('/settings/credentials', requireAuth, (req, res) => {
    res.render('credentials', { saved: req.query.saved === '1', ...credentialFieldStates(settingsRepo) });
  });

  router.post('/settings/credentials', requireAuth, express.urlencoded({ extended: false }), (req, res) => {
    // "Leave blank to keep existing" -- an owner rotating one token
    // shouldn't have to re-type every other already-configured secret.
    // Trimmed so a field of only whitespace is treated as blank/unchanged,
    // not saved as a literal space.
    const existingWa = settingsRepo.getWhatsappCloudApiCredentials();
    const pick = (submitted, existing) => {
      const trimmed = typeof submitted === 'string' ? submitted.trim() : '';
      return trimmed === '' ? existing : trimmed;
    };
    settingsRepo.setWhatsappCloudApiCredentials({
      verifyToken: pick(req.body.whatsappVerifyToken, existingWa.verifyToken),
      accessToken: pick(req.body.whatsappAccessToken, existingWa.accessToken),
      phoneNumberId: pick(req.body.whatsappPhoneNumberId, existingWa.phoneNumberId),
      appSecret: pick(req.body.whatsappAppSecret, existingWa.appSecret),
    });
    settingsRepo.setTelegramBotToken(pick(req.body.telegramBotToken, settingsRepo.getTelegramBotToken()));

    log('credentials_updated', {
      // Never log the values themselves (SEC-1301's "never logged" rule
      // applies just as much to a dashboard save as it does to a connector
      // call) -- only which fields changed.
      whatsappVerifyTokenChanged: Boolean(req.body.whatsappVerifyToken?.trim()),
      whatsappAccessTokenChanged: Boolean(req.body.whatsappAccessToken?.trim()),
      whatsappPhoneNumberIdChanged: Boolean(req.body.whatsappPhoneNumberId?.trim()),
      whatsappAppSecretChanged: Boolean(req.body.whatsappAppSecret?.trim()),
      telegramBotTokenChanged: Boolean(req.body.telegramBotToken?.trim()),
    });
    res.redirect('/settings/credentials?saved=1');
  });

  return router;
}

module.exports = { createSettingsRouter };
