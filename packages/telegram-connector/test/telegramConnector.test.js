'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTelegramConnector } = require('../src/telegramConnector');

const BOT_TOKEN = 'super-secret-token-123456:ABCDEF';

/**
 * Fake fetchImpl returning a queue of canned JSON responses in order --
 * one per call. No real network call is ever made. Records every call
 * (url + options) so tests can assert on the exact HTTP request shape.
 */
function fakeFetch(responses) {
  const queue = [...responses];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift() ?? { ok: true, body: { ok: true, result: [] } };
    return {
      ok: next.ok !== false,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  };
  return { fetchImpl, calls };
}

/** sleep that never resolves -- keeps the background poll loop from firing
 * a second cycle during a test, so each test's fetchImpl call count stays
 * deterministic after the single awaited `start()` cycle. */
function neverSleep() {
  return new Promise(() => {});
}

/** Captures every console.log call made during `fn()` (the logger writes
 * one JSON string per call via console.log) so tests can inspect log
 * content, e.g. to assert the bot token never appears in any of it. */
async function captureLogs(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('successful getUpdates with one text message: onMessage called once with the normalized {chatId, text, messageType: "text", ...} shape', async () => {
  const update = {
    update_id: 100,
    message: {
      message_id: 555,
      date: 1735689600,
      chat: { id: 42 },
      text: 'hello there',
    },
  };
  const { fetchImpl, calls } = fakeFetch([{ ok: true, body: { ok: true, result: [update] } }]);

  const received = [];
  const connector = createTelegramConnector({
    botToken: BOT_TOKEN,
    onMessage: async (msg) => {
      received.push(msg);
    },
    fetchImpl,
    sleep: neverSleep,
  });

  await connector.start();
  await connector.stop();

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    chatId: 42,
    text: 'hello there',
    messageType: 'text',
    mediaRef: null,
    telegramMessageId: 555,
    timestampIso: new Date(1735689600 * 1000).toISOString(),
  });

  // GET against getUpdates with offset/timeout query params, per the SDS.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.telegram\.org\/bot.+\/getUpdates\?offset=0&timeout=30$/);
  assert.equal(calls[0].options.method, 'GET');
});

test('SEC-1303: a batch with one malformed update and one valid update -- the valid one still reaches onMessage, the malformed one is skipped + logged, no uncaught exception', async () => {
  const malformedUpdate = {
    update_id: 200,
    message: {
      message_id: 1,
      // chat.id missing -- malformed, must be skipped rather than thrown.
      chat: {},
      text: 'this will never arrive',
    },
  };
  const validUpdate = {
    update_id: 201,
    message: {
      message_id: 2,
      date: 1735689700,
      chat: { id: 7 },
      text: 'still works',
    },
  };
  const { fetchImpl } = fakeFetch([{ ok: true, body: { ok: true, result: [malformedUpdate, validUpdate] } }]);

  const received = [];
  const connector = createTelegramConnector({
    botToken: BOT_TOKEN,
    onMessage: async (msg) => {
      received.push(msg);
    },
    fetchImpl,
    sleep: neverSleep,
  });

  const logs = await captureLogs(async () => {
    await assert.doesNotReject(async () => {
      await connector.start();
    });
  });
  await connector.stop();

  assert.equal(received.length, 1, 'only the valid update should reach onMessage');
  assert.equal(received[0].chatId, 7);
  assert.equal(received[0].text, 'still works');

  const malformedLog = logs.find((line) => line.includes('telegram_malformed_update'));
  assert.ok(malformedLog, 'the malformed update should be logged');
});

test('sendTextMessage posts to sendMessage with chat_id/text, and no log call anywhere includes the bot token substring', async () => {
  const { fetchImpl, calls } = fakeFetch([{ ok: true, body: { ok: true, result: {} } }]);

  const connector = createTelegramConnector({
    botToken: BOT_TOKEN,
    onMessage: async () => {},
    fetchImpl,
    sleep: neverSleep,
  });

  const logs = await captureLogs(async () => {
    await connector.sendTextMessage(99, 'hi there');
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { chat_id: 99, text: 'hi there' });

  for (const line of logs) {
    assert.equal(line.includes(BOT_TOKEN), false, `log line leaked the bot token: ${line}`);
  }
});

test('sendTypingIndicator posts to sendChatAction with action: "typing", and no log call anywhere includes the bot token substring', async () => {
  const { fetchImpl, calls } = fakeFetch([{ ok: true, body: { ok: true, result: {} } }]);

  const connector = createTelegramConnector({
    botToken: BOT_TOKEN,
    onMessage: async () => {},
    fetchImpl,
    sleep: neverSleep,
  });

  const logs = await captureLogs(async () => {
    await connector.sendTypingIndicator(99);
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sendChatAction$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { chat_id: 99, action: 'typing' });

  for (const line of logs) {
    assert.equal(line.includes(BOT_TOKEN), false, `log line leaked the bot token: ${line}`);
  }
});

test('SEC-1301: even a failed getUpdates call never logs the constructed URL or the token -- only an endpoint-name string', async () => {
  const { fetchImpl } = fakeFetch([{ ok: false, status: 401, body: { ok: false, description: 'Unauthorized' } }]);

  const connector = createTelegramConnector({
    botToken: BOT_TOKEN,
    onMessage: async () => {},
    fetchImpl,
    sleep: neverSleep,
  });

  const logs = await captureLogs(async () => {
    await connector.start();
  });
  await connector.stop();

  assert.ok(logs.some((line) => line.includes('telegram_get_updates_failed')));
  for (const line of logs) {
    assert.equal(line.includes(BOT_TOKEN), false, `log line leaked the bot token: ${line}`);
    assert.equal(line.includes('api.telegram.org'), false, `log line leaked the constructed URL: ${line}`);
  }
});

test('photo update with no caption: text is null, messageType is "photo", mediaRef is the largest size\'s file_id', async () => {
  const update = {
    update_id: 300,
    message: {
      message_id: 9,
      date: 1735689800,
      chat: { id: 5 },
      photo: [
        { file_id: 'small-file-id', width: 90, height: 90 },
        { file_id: 'large-file-id', width: 1280, height: 960 },
        { file_id: 'medium-file-id', width: 320, height: 240 },
      ],
    },
  };
  const { fetchImpl } = fakeFetch([{ ok: true, body: { ok: true, result: [update] } }]);

  const received = [];
  const connector = createTelegramConnector({
    botToken: BOT_TOKEN,
    onMessage: async (msg) => {
      received.push(msg);
    },
    fetchImpl,
    sleep: neverSleep,
  });

  await connector.start();
  await connector.stop();

  assert.equal(received.length, 1);
  assert.equal(received[0].text, null);
  assert.equal(received[0].messageType, 'photo');
  assert.equal(received[0].mediaRef, 'large-file-id');
});

test('sticker update normalizes to messageType "sticker" with the sticker file_id as mediaRef', async () => {
  const update = {
    update_id: 400,
    message: {
      message_id: 11,
      date: 1735689900,
      chat: { id: 6 },
      sticker: { file_id: 'sticker-file-id' },
    },
  };
  const { fetchImpl } = fakeFetch([{ ok: true, body: { ok: true, result: [update] } }]);

  const received = [];
  const connector = createTelegramConnector({
    botToken: BOT_TOKEN,
    onMessage: async (msg) => received.push(msg),
    fetchImpl,
    sleep: neverSleep,
  });

  await connector.start();
  await connector.stop();

  assert.equal(received.length, 1);
  assert.equal(received[0].messageType, 'sticker');
  assert.equal(received[0].mediaRef, 'sticker-file-id');
  assert.equal(received[0].text, null);
});

test('document update normalizes to messageType "document" with the document file_id as mediaRef', async () => {
  const update = {
    update_id: 500,
    message: {
      message_id: 12,
      date: 1735690000,
      chat: { id: 8 },
      document: { file_id: 'document-file-id' },
    },
  };
  const { fetchImpl } = fakeFetch([{ ok: true, body: { ok: true, result: [update] } }]);

  const received = [];
  const connector = createTelegramConnector({
    botToken: BOT_TOKEN,
    onMessage: async (msg) => received.push(msg),
    fetchImpl,
    sleep: neverSleep,
  });

  await connector.start();
  await connector.stop();

  assert.equal(received.length, 1);
  assert.equal(received[0].messageType, 'document');
  assert.equal(received[0].mediaRef, 'document-file-id');
});

test('offset advances past the highest update_id seen, so the next poll cycle would not re-fetch already-processed updates', async () => {
  const update1 = { update_id: 10, message: { message_id: 1, chat: { id: 1 }, text: 'a' } };
  const update2 = { update_id: 11, message: { message_id: 2, chat: { id: 1 }, text: 'b' } };
  const { fetchImpl, calls } = fakeFetch([
    { ok: true, body: { ok: true, result: [update1, update2] } },
    { ok: true, body: { ok: true, result: [] } },
  ]);

  const connector = createTelegramConnector({
    botToken: BOT_TOKEN,
    onMessage: async () => {},
    fetchImpl,
    sleep: neverSleep,
  });

  await connector.start();
  assert.match(calls[0].url, /offset=0&timeout=30$/);
  await connector.stop();
});

test('a batch with zero updates is a safe no-op (no onMessage call, no error)', async () => {
  const { fetchImpl } = fakeFetch([{ ok: true, body: { ok: true, result: [] } }]);

  const connector = createTelegramConnector({
    botToken: BOT_TOKEN,
    onMessage: async () => {
      throw new Error('should never be called');
    },
    fetchImpl,
    sleep: neverSleep,
  });

  await assert.doesNotReject(async () => {
    await connector.start();
  });
  await connector.stop();
});
