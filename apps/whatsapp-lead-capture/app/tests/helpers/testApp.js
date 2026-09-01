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
 *
 * readReceipts/typingIndicators (FR-601/FR-604,
 * docs/sdd/changes/2026-09-01-humanized-timing-module.md) record the new
 * markAsRead/sendTypingIndicator calls the humanized-timing wiring now
 * makes before every send -- pre-existing tests that only assert on
 * `sentMessages` are unaffected (final message content/order is unchanged),
 * but these are here for any test that wants to assert on them directly.
 */
function createMockMetaClient({ failOn } = {}) {
  const sentMessages = [];
  const readReceipts = [];
  const typingIndicators = [];
  return {
    sentMessages,
    readReceipts,
    typingIndicators,
    async sendTextMessage(to, body) {
      if (failOn && failOn(to, body)) {
        throw new Error('Simulated Meta API failure');
      }
      sentMessages.push({ to, body });
      return { messages: [{ id: `mock-${sentMessages.length}` }] };
    },
    async markAsRead(to, messageId) {
      readReceipts.push({ to, messageId });
    },
    async sendTypingIndicator(to, messageId) {
      typingIndicators.push({ to, messageId });
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
    // NFR-603 (docs/sdd/changes/2026-09-01-humanized-timing-module.md):
    // every outbound reply is now routed through
    // src/lib/humanizedTiming.js, which by default waits real
    // (setTimeout-based) delays -- a 1-3s read pause plus a
    // length-proportional typing delay, per message. Without this
    // override, every webhook/reply test in the suite would incur those
    // real delays. An instant no-op sleep keeps the whole suite fast and
    // deterministic while the real formula/orchestration logic is still
    // proven separately, against real delay values, by
    // tests/humanizedTiming.test.js.
    sleep: overrides.sleep || (async () => {}),
    // Post-review fix: `random` must also be fixed, not just `sleep`.
    // With real Math.random() jitter, a reply whose *base* typing duration
    // sits close to FR-603's ~20s refresh threshold (e.g. TEST_CONFIG's
    // acknowledgment text, ~21.3s base) could jitter to either side of
    // 20s from one test run to the next, making the number of
    // sendTypingIndicator calls -- and therefore any test asserting an
    // exact count -- flaky. `() => 0.5` neutralizes jitter entirely (see
    // src/lib/humanizedTiming.js's doc comment), so the same fixed
    // duration is computed every run.
    random: overrides.random || (() => 0.5),
    // FR-501..FR-504 (docs/sdd/changes/2026-09-01-fuzzy-product-matching.md):
    // left `undefined` unless a test explicitly opts in via
    // `overrides.productsConfig` -- every pre-existing test that doesn't
    // pass it keeps exercising fuzzy-matching as a complete no-op
    // (NFR-502), same reasoning as `whatsappMode`/`baileysConnector` above.
    productsConfig: overrides.productsConfig,
    matchThreshold: overrides.matchThreshold,
    intentDenylist: overrides.intentDenylist,
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
