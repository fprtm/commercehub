'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const { createLeadsRepo } = require('../src/services/leadsRepo');
const { main, createTelegramChannel } = require('../src/server');
const { TEST_CONFIG } = require('./helpers/testApp');

/**
 * TICKET-1304 (docs/sdd/specs/002-telegram-multichannel/tickets/
 * 04-server-composition-root-wiring.md): integration coverage for the
 * composition-root wiring added to src/server.js -- `createTelegramChannel()`
 * is the extracted, directly-testable piece of main() that decides whether
 * the Telegram channel exists at all, and (when it does) wires a second,
 * independent inboundMessageProcessor instance to it.
 *
 * These tests never make a real network call and never boot a real Telegram
 * poll loop -- `createTelegramConnectorImpl` is injected the same way
 * whatsappPair.test.js's `fakeBaileysConnector` stands in for the real
 * Baileys connector.
 */
function fakeTelegramConnectorFactory() {
  const calls = [];
  let capturedOnMessage = null;
  let capturedBotToken = null;

  const factory = ({ botToken, onMessage }) => {
    calls.push({ botToken, onMessage });
    capturedBotToken = botToken;
    capturedOnMessage = onMessage;
    const sentMessages = [];
    const typingIndicatorCalls = [];
    return {
      sentMessages,
      typingIndicatorCalls,
      async start() {},
      async stop() {},
      async sendTextMessage(chatId, text) {
        sentMessages.push({ chatId, text });
      },
      async sendTypingIndicator(chatId) {
        typingIndicatorCalls.push(chatId);
      },
    };
  };

  return {
    factory,
    calls,
    get botToken() {
      return capturedBotToken;
    },
    get onMessage() {
      return capturedOnMessage;
    },
  };
}

test('TICKET-1304: requiring src/server.js does not auto-boot (require.main guard) and exports the composition-root pieces', () => {
  // Regression guard for the require.main === module guard added by this
  // ticket: before, `require('../src/server')` would immediately invoke
  // main() (assertRequiredEnv() -> real DB file -> app.listen() -> real
  // WhatsApp connector construction), which is exactly what made server.js
  // untestable as a module. If this test file's own `require` above didn't
  // throw/exit, the guard is working -- this assertion just makes that
  // explicit and documents why.
  assert.equal(typeof main, 'function');
  assert.equal(typeof createTelegramChannel, 'function');
});

test('TICKET-1304/FR-1302: TELEGRAM_BOT_TOKEN unset (or blank) -> createTelegramChannel returns null and constructs nothing (zero new code paths)', () => {
  const spy = fakeTelegramConnectorFactory();
  const db = createDb(':memory:');
  try {
    for (const blank of [undefined, '', '   ']) {
      const result = createTelegramChannel({
        telegramBotToken: blank,
        db,
        questionsConfig: TEST_CONFIG,
        createTelegramConnectorImpl: spy.factory,
      });
      assert.equal(result, null);
    }
    // The connector factory itself was never invoked -- proves this isn't
    // just returning null after already having constructed a processor/
    // connector, but genuinely short-circuits before any of that.
    assert.equal(spy.calls.length, 0);
  } finally {
    db.close();
  }
});

test('TICKET-1304: TELEGRAM_BOT_TOKEN set -> a synthetic Telegram update flows through to a persisted Lead row with channel=\'telegram\', and a reply is sent via the injected connector\'s sendTextMessage', async () => {
  const db = createDb(':memory:');
  try {
    const spy = fakeTelegramConnectorFactory();

    const telegramChannel = createTelegramChannel({
      telegramBotToken: '  fake-telegram-token  ',
      db,
      questionsConfig: TEST_CONFIG,
      // Same "instant/deterministic" override testApp.js already uses for
      // every WA-side integration test, so this test doesn't incur
      // humanized-timing's real setTimeout-based delay.
      sleep: async () => {},
      random: () => 0.5,
      createTelegramConnectorImpl: spy.factory,
    });

    assert.notEqual(telegramChannel, null);
    // Token is trimmed before being handed to the connector factory.
    assert.equal(spy.botToken, 'fake-telegram-token');
    assert.equal(typeof spy.onMessage, 'function');

    const fakeConnector = await telegramChannel.connector.start().then(() => telegramChannel.connector);

    // Simulate a normalized update exactly as @rimba/telegram-connector's
    // onMessage callback shape documents it (chatId, text, messageType,
    // telegramMessageId, timestampIso) -- see packages/telegram-connector/
    // README.md.
    const result = await spy.onMessage({
      chatId: 918273645,
      text: 'Halo, mau tanya produk',
      messageType: 'text',
      telegramMessageId: 42,
      timestampIso: '2026-09-03T10:00:00.000Z',
    });

    // A Lead row was created, scoped to the 'telegram' channel family
    // (TICKET-1302's toLeadChannel() passthrough -- 'telegram' is not one
    // of the two WhatsApp-mode strings it normalizes, so it's stored as-is).
    const leadsRepo = createLeadsRepo(db);
    const lead = leadsRepo.findByContact('918273645', 'telegram');
    assert.ok(lead, 'expected a Lead row for the telegram contact');
    assert.equal(lead.channel, 'telegram');
    assert.equal(lead.contact_id, '918273645');
    assert.equal(result.lead.id, lead.id);

    // The ack + Q1 replies (START_FLOW sends both, same as the WA-side
    // happy-path test in webhook.test.js) were sent through the injected
    // connector's sendTextMessage -- never a real network call, never the
    // WA side.
    // sendTextMessage's first arg is `contactId` (String(update.chatId)) --
    // inboundMessageProcessor.js addresses replies by contactId, not the
    // connector's own raw numeric chatId.
    assert.equal(fakeConnector.sentMessages.length, 2);
    assert.equal(fakeConnector.sentMessages[0].chatId, '918273645');
    assert.equal(fakeConnector.sentMessages[0].text, TEST_CONFIG.acknowledgment);
    assert.equal(fakeConnector.sentMessages[1].chatId, '918273645');
    assert.equal(fakeConnector.sentMessages[1].text, TEST_CONFIG.questions[0].text);
  } finally {
    db.close();
  }
});

test('TICKET-1304: two Telegram contacts get independent Lead rows and never cross-talk with each other\'s connector instance', async () => {
  const db = createDb(':memory:');
  try {
    const spyA = fakeTelegramConnectorFactory();
    const channelA = createTelegramChannel({
      telegramBotToken: 'token-a',
      db,
      questionsConfig: TEST_CONFIG,
      sleep: async () => {},
      random: () => 0.5,
      createTelegramConnectorImpl: spyA.factory,
    });

    await spyA.onMessage({
      chatId: 111,
      text: 'first contact',
      messageType: 'text',
      telegramMessageId: 1,
      timestampIso: '2026-09-03T10:00:00.000Z',
    });
    await spyA.onMessage({
      chatId: 222,
      text: 'second contact',
      messageType: 'text',
      telegramMessageId: 2,
      timestampIso: '2026-09-03T10:00:01.000Z',
    });

    const leadsRepo = createLeadsRepo(db);
    const leadOne = leadsRepo.findByContact('111', 'telegram');
    const leadTwo = leadsRepo.findByContact('222', 'telegram');
    assert.ok(leadOne);
    assert.ok(leadTwo);
    assert.notEqual(leadOne.id, leadTwo.id);

    const connector = channelA.connector;
    // Every reply for both contacts went through this ONE connector
    // instance (both are on the same Telegram channel/bot) -- 2 messages
    // in (each a START_FLOW: ack + Q1), 4 sent messages out, addressed to
    // the right chatId each, in arrival order.
    assert.equal(connector.sentMessages.length, 4);
    assert.deepEqual(
      connector.sentMessages.map((m) => m.chatId),
      ['111', '111', '222', '222'],
    );
  } finally {
    db.close();
  }
});
