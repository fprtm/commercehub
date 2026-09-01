'use strict';

function createFailedEventsRepo(db) {
  const insert = db.prepare(`
    INSERT INTO failed_events (raw_payload, error_message, occurred_at)
    VALUES (@raw_payload, @error_message, @occurred_at)
  `);
  const listAll = db.prepare('SELECT * FROM failed_events ORDER BY id DESC');

  return {
    record({ rawPayload, errorMessage }) {
      const payloadText = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
      insert.run({
        raw_payload: payloadText,
        error_message: errorMessage,
        occurred_at: new Date().toISOString(),
      });
    },
    listAll() {
      return listAll.all();
    },
  };
}

module.exports = { createFailedEventsRepo };
