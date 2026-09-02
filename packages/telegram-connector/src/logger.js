'use strict';

/**
 * Minimal structured console logger -- identical pattern to
 * @rimba/whatsapp-connector's src/logger.js. Kept as a local copy rather
 * than a cross-package dependency so this package stays zero-dependency
 * and independently copyable (same rationale as @rimba/humanized-timing's
 * "copyable wholesale into any project" framing).
 *
 * SEC-1301: callers of `log()` must never pass the bot token or a
 * constructed request URL (which embeds the token in its path,
 * `https://api.telegram.org/bot<token>/...`) -- only an endpoint-name
 * string (e.g. 'telegram_get_updates') and token-free details.
 */
function log(eventType, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event: eventType,
    ...details,
  };
  // Single-line JSON per log entry keeps this greppable without a log
  // aggregation service.
  console.log(JSON.stringify(entry));
}

module.exports = { log };
