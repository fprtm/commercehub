'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMetaClient } = require('../src/metaClient');

/**
 * FR-601/FR-604 (docs/sdd/changes/2026-09-01-humanized-timing-module.md):
 * unit coverage for metaClient.js's markAsRead/sendTypingIndicator against a
 * fake fetchImpl -- request shape, the "no messageId => no-op" guard, and
 * the "never throws" contract -- mirroring the equivalent 7 tests already
 * added to tests/baileysConnector.test.js for its markAsRead/
 * sendTypingIndicator. Closes a real coverage gap: without this file, the
 * `readReceipts`/`typingIndicators` spy arrays already wired into
 * tests/helpers/testApp.js's mock Meta client were never actually asserted
 * against anywhere, so a regression here (wrong Graph API body shape,
 * swapped wiring in webhook.js, a broken never-throws contract) would pass
 * the whole suite undetected -- even though Cloud API is the recommended
 * default mode.
 */

function fakeFetch({ ok = true, status = 200, body = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok,
      status,
      json: async () => body,
    };
  };
  return { fetchImpl, calls };
}

test('FR-601: markAsRead posts a Graph API status=read update for the given message id, with no typing_indicator field', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const client = createMetaClient({ accessToken: 'token-abc', phoneNumberId: '1234567890', fetchImpl });

  await client.markAsRead('628111111111', 'wamid.123');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v20.0/1234567890/messages');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-abc');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: 'wamid.123',
  });
});

test('FR-603: sendTypingIndicator posts a status=read update WITH a typing_indicator field, for the same message id', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const client = createMetaClient({ accessToken: 'token-abc', phoneNumberId: '1234567890', fetchImpl });

  await client.sendTypingIndicator('628111111111', 'wamid.456');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: 'wamid.456',
    typing_indicator: { type: 'text' },
  });
});

test('markAsRead is a safe no-op (no request sent at all) when no messageId is given', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const client = createMetaClient({ accessToken: 't', phoneNumberId: '1', fetchImpl });

  const result = await client.markAsRead('628111111111', undefined);

  assert.equal(calls.length, 0, 'nothing to mark read against without an inbound message id -- must not call fetchImpl at all');
  assert.equal(result, null);
});

test('sendTypingIndicator is a safe no-op (no request sent at all) when no messageId is given', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const client = createMetaClient({ accessToken: 't', phoneNumberId: '1', fetchImpl });

  const result = await client.sendTypingIndicator('628111111111', null);

  assert.equal(calls.length, 0);
  assert.equal(result, null);
});

test('markAsRead never throws when the Graph API responds with a non-2xx status -- resolves null instead (a failed read receipt must not break the reply pipeline)', async () => {
  const { fetchImpl } = fakeFetch({ ok: false, status: 400, body: { error: { message: 'bad request' } } });
  const client = createMetaClient({ accessToken: 't', phoneNumberId: '1', fetchImpl });

  let result;
  await assert.doesNotReject(async () => {
    result = await client.markAsRead('628111111111', 'wamid.1');
  });
  assert.equal(result, null);
});

test('sendTypingIndicator never throws when the Graph API responds with a non-2xx status -- resolves null instead', async () => {
  const { fetchImpl } = fakeFetch({ ok: false, status: 500, body: {} });
  const client = createMetaClient({ accessToken: 't', phoneNumberId: '1', fetchImpl });

  let result;
  await assert.doesNotReject(async () => {
    result = await client.sendTypingIndicator('628111111111', 'wamid.1');
  });
  assert.equal(result, null);
});

test('markAsRead never throws when fetchImpl itself rejects (network failure) -- resolves null instead', async () => {
  const fetchImpl = async () => {
    throw new Error('simulated network failure');
  };
  const client = createMetaClient({ accessToken: 't', phoneNumberId: '1', fetchImpl });

  let result;
  await assert.doesNotReject(async () => {
    result = await client.markAsRead('628111111111', 'wamid.1');
  });
  assert.equal(result, null);
});

test('sendTypingIndicator never throws when fetchImpl itself rejects (network failure) -- resolves null instead', async () => {
  const fetchImpl = async () => {
    throw new Error('simulated network failure');
  };
  const client = createMetaClient({ accessToken: 't', phoneNumberId: '1', fetchImpl });

  let result;
  await assert.doesNotReject(async () => {
    result = await client.sendTypingIndicator('628111111111', 'wamid.1');
  });
  assert.equal(result, null);
});

test('markAsRead resolves with the parsed Graph API response payload on success', async () => {
  const { fetchImpl } = fakeFetch({ ok: true, body: { success: true } });
  const client = createMetaClient({ accessToken: 't', phoneNumberId: '1', fetchImpl });

  const result = await client.markAsRead('628111111111', 'wamid.1');
  assert.deepEqual(result, { success: true });
});
