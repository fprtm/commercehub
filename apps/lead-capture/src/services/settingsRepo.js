'use strict';

/**
 * Data-access layer for the single-row `app_settings` table
 * (docs/sdd/changes/2026-09-01-auto-reply-toggle.md). Follows the same
 * factory-over-a-db-instance pattern as leadsRepo.js/failedEventsRepo.js so
 * it can be reused against either the real app DB or a throwaway
 * in-memory test DB.
 *
 * NFR-401: every read here goes straight to SQLite (a `SELECT` on every
 * call) -- there is no in-process caching layer that could serve a stale
 * value, so `isAutoReplyEnabled()` always reflects the most recently
 * committed toggle, including one flipped by a different request/process
 * in between calls.
 */
function createSettingsRepo(db) {
  const getRow = db.prepare('SELECT auto_reply_enabled FROM app_settings WHERE id = 1');
  const setRow = db.prepare('UPDATE app_settings SET auto_reply_enabled = ? WHERE id = 1');

  // Added 2026-09-03 (docs/sdd/changes/2026-09-03-credentials-in-db.md):
  // owner-fillable connector credentials, moved out of `.env` -- see
  // schema.sql's doc comment on `app_settings` for which vars moved and
  // why. All nullable; NULL/empty means "not configured yet".
  const getWaCredsRow = db.prepare(
    'SELECT whatsapp_verify_token, whatsapp_access_token, whatsapp_phone_number_id, whatsapp_app_secret FROM app_settings WHERE id = 1',
  );
  const setWaCredsRow = db.prepare(
    'UPDATE app_settings SET whatsapp_verify_token = ?, whatsapp_access_token = ?, whatsapp_phone_number_id = ?, whatsapp_app_secret = ? WHERE id = 1',
  );
  const getTelegramRow = db.prepare('SELECT telegram_bot_token FROM app_settings WHERE id = 1');
  const setTelegramRow = db.prepare('UPDATE app_settings SET telegram_bot_token = ? WHERE id = 1');

  return {
    /** @returns {boolean} */
    isAutoReplyEnabled() {
      const row = getRow.get();
      // Defaults to enabled if the seed row is somehow missing (schema.sql
      // always inserts it) -- fails open into "unchanged from today's
      // behavior" (FR-403) rather than silently going quiet.
      return row ? row.auto_reply_enabled === 1 : true;
    },

    /**
     * @param {boolean} enabled
     * @returns {boolean} the new state, read back from the DB
     */
    setAutoReplyEnabled(enabled) {
      setRow.run(enabled ? 1 : 0);
      return this.isAutoReplyEnabled();
    },

    /** @returns {boolean} the new state after flipping */
    toggleAutoReply() {
      return this.setAutoReplyEnabled(!this.isAutoReplyEnabled());
    },

    /**
     * @returns {{verifyToken: string|null, accessToken: string|null, phoneNumberId: string|null, appSecret: string|null}}
     */
    getWhatsappCloudApiCredentials() {
      const row = getWaCredsRow.get();
      return {
        verifyToken: row?.whatsapp_verify_token ?? null,
        accessToken: row?.whatsapp_access_token ?? null,
        phoneNumberId: row?.whatsapp_phone_number_id ?? null,
        appSecret: row?.whatsapp_app_secret ?? null,
      };
    },

    /**
     * Full overwrite of all 4 fields -- callers wanting "leave blank to
     * keep existing" (the dashboard form's UX) resolve that themselves by
     * merging with getWhatsappCloudApiCredentials() first (see
     * routes/settings.js), same as every other repo here staying a plain,
     * unopinionated data-access layer.
     * @param {{verifyToken: string|null, accessToken: string|null, phoneNumberId: string|null, appSecret: string|null}} creds
     */
    setWhatsappCloudApiCredentials({ verifyToken, accessToken, phoneNumberId, appSecret }) {
      setWaCredsRow.run(verifyToken || null, accessToken || null, phoneNumberId || null, appSecret || null);
      return this.getWhatsappCloudApiCredentials();
    },

    /** @returns {string|null} */
    getTelegramBotToken() {
      return getTelegramRow.get()?.telegram_bot_token ?? null;
    },

    /**
     * @param {string|null} token
     * @returns {string|null} the new value, read back from the DB
     */
    setTelegramBotToken(token) {
      setTelegramRow.run(token || null);
      return this.getTelegramBotToken();
    },
  };
}

module.exports = { createSettingsRepo };
