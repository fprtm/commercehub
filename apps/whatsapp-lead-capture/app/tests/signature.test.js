'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifySignature } = require('../src/utils/signature');

const SECRET = 'test-app-secret';

function sign(body, secret = SECRET) {
  const hash = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hash}`;
}

test('verifySignature: accepts a correctly signed payload', () => {
  const body = JSON.stringify({ hello: 'world' });
  assert.equal(verifySignature(body, sign(body), SECRET), true);
});

test('verifySignature: rejects a payload signed with the wrong secret', () => {
  const body = JSON.stringify({ hello: 'world' });
  assert.equal(verifySignature(body, sign(body, 'wrong-secret'), SECRET), false);
});

test('verifySignature: rejects a tampered body', () => {
  const body = JSON.stringify({ hello: 'world' });
  const signature = sign(body);
  const tamperedBody = JSON.stringify({ hello: 'mallory' });
  assert.equal(verifySignature(tamperedBody, signature, SECRET), false);
});

test('verifySignature: rejects a missing header', () => {
  assert.equal(verifySignature('{}', undefined, SECRET), false);
});

test('verifySignature: rejects a malformed header (no scheme prefix)', () => {
  assert.equal(verifySignature('{}', 'not-a-real-signature', SECRET), false);
});

test('verifySignature: rejects when app secret is missing/unconfigured', () => {
  assert.equal(verifySignature('{}', sign('{}'), ''), false);
});
