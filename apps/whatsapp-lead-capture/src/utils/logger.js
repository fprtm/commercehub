'use strict';

/**
 * Minimal structured console logger.
 * Per technical-design.md "Logging": structured console logging
 * (timestamp, event type, lead ID where applicable, outcome) is
 * sufficient for this project's size -- no external log aggregation.
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
