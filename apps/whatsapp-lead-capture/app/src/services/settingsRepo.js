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
  };
}

module.exports = { createSettingsRepo };
