'use strict';

const { createApp } = require('../../src/app');
const { createDb } = require('../../src/db');

const TEST_CONFIG = {
  acknowledgment: 'This is an automated reply from Rimba Apparel. Thanks for messaging us!',
  questions: [
    { id: 'q1', text: 'Which product are you interested in?' },
    { id: 'q2', text: 'What size / how should we contact you?' },
  ],
  fallbackMessage: 'A team member will follow up with you shortly.',
  completionMessage: "Thanks! We've got what we need.",
};

/**
 * A mock Meta client that records every "sent" message in memory instead of
 * making a real network call. This is what T-006's integration tests
 * assert against -- there is no live Meta account/credentials available in
 * this environment (see app/README.md).
 */
function createMockMetaClient({ failOn } = {}) {
  const sentMessages = [];
  return {
    sentMessages,
    async sendTextMessage(to, body) {
      if (failOn && failOn(to, body)) {
        throw new Error('Simulated Meta API failure');
      }
      sentMessages.push({ to, body });
      return { messages: [{ id: `mock-${sentMessages.length}` }] };
    },
  };
}

/**
 * Starts a real HTTP server (ephemeral port) wrapping the app, backed by an
 * in-memory SQLite DB and a mock Meta client, for integration tests that
 * exercise the app over real HTTP (fetch) rather than calling route
 * handlers directly.
 */
async function startTestServer(overrides = {}) {
  const db = createDb(':memory:');
  const metaClient = overrides.metaClient || createMockMetaClient(overrides.mockMetaOptions);

  const app = createApp({
    db,
    metaClient,
    questionsConfig: overrides.questionsConfig || TEST_CONFIG,
    verifyToken: overrides.verifyToken || 'test-verify-token',
    appSecret: overrides.appSecret, // undefined by default -> signature check skipped
    sessionSecret: 'test-session-secret',
    ownerUsername: overrides.ownerUsername || 'owner',
    ownerPassword: overrides.ownerPassword || 'secret-password',
    // Dual-mode (FR-301..FR-305) overrides -- undefined by default, so
    // every pre-existing caller of startTestServer() keeps exercising the
    // original cloud_api-only behavior unmodified (NFR-302).
    whatsappMode: overrides.whatsappMode,
    baileysConnector: overrides.baileysConnector,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    db,
    metaClient,
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

module.exports = { startTestServer, createMockMetaClient, TEST_CONFIG };
