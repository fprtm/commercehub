'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractMessages } = require('../src/services/parseWebhookPayload');

function textMessagePayload(body, from = '6281234567890') {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from, timestamp: '1735689600', type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

test('extractMessages: extracts a single text message', () => {
  const messages = extractMessages(textMessagePayload('halo, baju ini masih ada?'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, '6281234567890');
  assert.equal(messages[0].text, 'halo, baju ini masih ada?');
  assert.equal(messages[0].type, 'text');
});

test('extractMessages: a statuses-only payload (delivery receipt) yields zero messages, not an error', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [{ id: 'wamid.abc', status: 'delivered' }],
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(extractMessages(payload), []);
});

test('extractMessages: a non-text message type (e.g. sticker) has null text', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from: '628111', timestamp: '1', type: 'sticker', sticker: { id: 'x' } }],
            },
          },
        ],
      },
    ],
  };
  const messages = extractMessages(payload);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, null);
  assert.equal(messages[0].type, 'sticker');
});

test('extractMessages: throws on a payload with no "entry" array (malformed)', () => {
  assert.throws(() => extractMessages({ foo: 'bar' }), /Malformed webhook payload/);
});

test('extractMessages: throws on a payload that is not an object at all', () => {
  assert.throws(() => extractMessages(null), /Malformed webhook payload/);
  assert.throws(() => extractMessages('a string'), /Malformed webhook payload/);
});

test('extractMessages: throws when a message is missing "from"', () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [{ timestamp: '1', type: 'text', text: { body: 'hi' } }] } }] }],
  };
  assert.throws(() => extractMessages(payload), /missing "from"/);
});

test('extractMessages: handles multiple entries/changes/messages in one payload', () => {
  const payload = {
    entry: [
      { changes: [{ value: { messages: [{ from: 'A', timestamp: '1', type: 'text', text: { body: 'a' } }] } }] },
      { changes: [{ value: { messages: [{ from: 'B', timestamp: '2', type: 'text', text: { body: 'b' } }] } }] },
    ],
  };
  const messages = extractMessages(payload);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((m) => m.from), ['A', 'B']);
});
