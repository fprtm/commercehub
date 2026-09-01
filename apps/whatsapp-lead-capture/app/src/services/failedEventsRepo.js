'use strict';

function createFailedEventsRepo(db) {
  const insert = db.prepare(`
    INSERT INTO failed_events (raw_payload, error_message, channel, occurred_at)
    VALUES (@raw_payload, @error_message, @channel, @occurred_at)
  `);
  const listAll = db.prepare('SELECT * FROM failed_events ORDER BY id DESC');

  return {
    // `channel` defaults to the Cloud API for backward compatibility --
    // this repo predates dual-mode (FR-305) and its original caller
    // (src/routes/webhook.js) is Cloud-API-only.
    record({ rawPayload, errorMessage, channel = 'whatsapp_cloud_api' }) {
      const payloadText = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
      insert.run({
        raw_payload: payloadText,
        error_message: errorMessage,
        channel,
        occurred_at: new Date().toISOString(),
      });
    },
    listAll() {
      return listAll.all();
    },
  };
}

module.exports = { createFailedEventsRepo };
