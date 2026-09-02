'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { startTestServer, createMockMetaClient } = require('./helpers/testApp');

function messagePayload(from, body, timestamp = '1735689600') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              messages: [{ from, id: 'wamid.1', timestamp, type: 'text', text: { body } }],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

test('T-004 GET /webhook: returns hub.challenge when verify token matches', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(
      `${ctx.baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345`,
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '12345');
  } finally {
    await ctx.close();
  }
});

test('T-004 GET /webhook: returns 403 when verify token does not match', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(
      `${ctx.baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=12345`,
    );
    assert.equal(res.status, 403);
  } finally {
    await ctx.close();
  }
});

test('T-006 POST /webhook: first-time message creates a Lead and sends ack + Q1 (FR-001, FR-002, FR-008)', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload('6281234567890', 'halo, baju ini masih ada?')),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'received' });

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE contact_id = ?').get('6281234567890');
    assert.ok(lead, 'expected a Lead row to be created');
    assert.equal(lead.status, 'new');
    assert.equal(lead.question1_answer, null);

    assert.equal(ctx.metaClient.sentMessages.length, 2);
    assert.match(ctx.metaClient.sentMessages[0].body, /automated reply from Rimba Apparel/);
    assert.equal(ctx.metaClient.sentMessages[1].body, 'Which product are you interested in?');
  } finally {
    await ctx.close();
  }
});

test('FR-601/FR-604 POST /webhook: an inbound message triggers a read receipt and a typing indicator via the real webhook route, not just sendTextMessage', async () => {
  const ctx = await startTestServer();
  try {
    const phone = '6281234500001';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'halo, baju ini masih ada?')),
    });

    // Exercises the readReceipts/typingIndicators spies tests/helpers/testApp.js
    // already wires into the mock Meta client (FR-601: markAsRead fires
    // once per inbound message; FR-603: sendTypingIndicator fires at least
    // once per reply sent, more if a reply's typing duration crosses the
    // ~20s refresh threshold) -- proves webhook.js actually wires
    // metaClient.markAsRead/sendTypingIndicator through to
    // inboundMessageProcessor.js, not just metaClient.js in isolation.
    // Asserts "at least once per reply" rather than a single exact count:
    // the *exact* refresh count for a given message length is
    // @rimba/humanized-timing's humanizedTiming.js's concern and is already
    // deterministically proven, per-formula, in
    // packages/humanized-timing/test/humanizedTiming.test.js -- pinning an
    // exact number here would just make this wiring test fragile to
    // TEST_CONFIG's message lengths relative to the FR-603 threshold.
    assert.equal(ctx.metaClient.readReceipts.length, 1, 'exactly one read receipt for the one inbound message (not per-reply)');
    assert.deepEqual(ctx.metaClient.readReceipts[0], { to: phone, messageId: 'wamid.1' });

    assert.ok(
      ctx.metaClient.typingIndicators.length >= 2,
      `expected at least one typing-indicator call per reply sent (ack + Q1), got ${ctx.metaClient.typingIndicators.length}`,
    );
    for (const call of ctx.metaClient.typingIndicators) {
      assert.deepEqual(call, { to: phone, messageId: 'wamid.1' });
    }
  } finally {
    await ctx.close();
  }
});

test('T-006 POST /webhook: full happy-path conversation (ack -> Q1 -> Q2 -> complete)', async () => {
  const ctx = await startTestServer();
  try {
    const phone = '6281111111111';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'halo, baju ini masih ada?')),
    });
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'Kaos Rimba Hitam')),
    });
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'Size L, WhatsApp aja')),
    });

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(phone);
    assert.equal(lead.question1_answer, 'Kaos Rimba Hitam');
    assert.equal(lead.question2_answer, 'Size L, WhatsApp aja');
    assert.equal(lead.fallback_triggered, 0);

    // ack + Q1, then Q2, then completion message = 4 total outbound messages
    assert.equal(ctx.metaClient.sentMessages.length, 4);
    assert.equal(ctx.metaClient.sentMessages[2].body, 'What size / how should we contact you?');
  } finally {
    await ctx.close();
  }
});

function stickerPayload(phone, timestamp) {
  return {
    entry: [
      {
        changes: [
          {
            value: { messages: [{ from: phone, timestamp, type: 'sticker', sticker: { id: 'x' } }] },
          },
        ],
      },
    ],
  };
}

test('T-005/FR-002 POST /webhook: first unrecognizable message (non-text type) retries once, does not fall back yet', async () => {
  const ctx = await startTestServer();
  try {
    const phone = '6282222222220';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'hi')),
    });

    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stickerPayload(phone, '1735689601')),
    });
    assert.equal(res.status, 200);

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(phone);
    assert.equal(lead.fallback_triggered, 0, 'FR-002: one retry is allowed before fallback fires');
    assert.equal(lead.retry_count, 1);
    assert.equal(lead.status, 'new');

    const lastMessage = ctx.metaClient.sentMessages.at(-1);
    assert.match(lastMessage.body, /didn.t quite catch that/);
    assert.match(lastMessage.body, /Which product are you interested in/);
  } finally {
    await ctx.close();
  }
});

test('T-006/FR-007 POST /webhook: a second unrecognizable message in a row triggers fallback and still logs a lead', async () => {
  const ctx = await startTestServer();
  try {
    const phone = '6282222222222';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'hi')),
    });
    // first unusable message -- consumes the one retry (FR-002)
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stickerPayload(phone, '1735689601')),
    });
    // second unusable message in a row -- retry already used, falls back (FR-007)
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stickerPayload(phone, '1735689602')),
    });
    assert.equal(res.status, 200);

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(phone);
    assert.equal(lead.fallback_triggered, 1);
    assert.equal(lead.status, 'new', 'FR-007: lead status stays new on fallback');
    assert.equal(lead.question1_answer, null);

    const lastMessage = ctx.metaClient.sentMessages.at(-1);
    assert.match(lastMessage.body, /follow up/);
  } finally {
    await ctx.close();
  }
});

test('T-005/FR-002 POST /webhook: a usable answer after one retry still succeeds normally', async () => {
  const ctx = await startTestServer();
  try {
    const phone = '6282222222229';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'hi')),
    });
    // first unusable message -- consumes the one retry
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stickerPayload(phone, '1735689601')),
    });
    // now answers properly -- should succeed, not fall back
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'Kaos Rimba Hitam', '1735689602')),
    });

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(phone);
    assert.equal(lead.fallback_triggered, 0);
    assert.equal(lead.question1_answer, 'Kaos Rimba Hitam');
    assert.equal(lead.retry_count, 0, 'retry count resets once Q1 is answered and Q2 becomes pending');
  } finally {
    await ctx.close();
  }
});

test('T-006/NFR-002/T-011 POST /webhook: malformed payload is logged as exactly one FailedEvent, still returns 200', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ not: 'a recognizable payload shape' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'received' });

    const failedEvents = ctx.db.prepare('SELECT * FROM failed_events').all();
    assert.equal(failedEvents.length, 1);
    assert.match(failedEvents[0].error_message, /Malformed webhook payload/);
    assert.match(failedEvents[0].raw_payload, /a recognizable payload shape/);
  } finally {
    await ctx.close();
  }
});

test('T-006/NFR-002/T-011 POST /webhook: invalid JSON body is logged as a FailedEvent, still returns 200', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    assert.equal(res.status, 200);

    const failedEvents = ctx.db.prepare('SELECT * FROM failed_events').all();
    assert.equal(failedEvents.length, 1);
  } finally {
    await ctx.close();
  }
});

test('T-006/NFR-002/T-011 POST /webhook: a Meta API send failure is logged as exactly one FailedEvent, still returns 200', async () => {
  const failingClient = createMockMetaClient({ failOn: () => true });
  const ctx = await startTestServer({ metaClient: failingClient });
  try {
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload('6283333333333', 'hi there')),
    });
    assert.equal(res.status, 200);

    const failedEvents = ctx.db.prepare('SELECT * FROM failed_events').all();
    assert.equal(failedEvents.length, 1);
    assert.match(failedEvents[0].error_message, /Simulated Meta API failure/);

    // TD-004/NFR-002: the Lead record itself is not lost even though the
    // outbound reply failed -- only the reply-send step failed.
    const lead = ctx.db.prepare('SELECT * FROM leads WHERE contact_id = ?').get('6283333333333');
    assert.ok(lead, 'lead should still exist even though the Meta send failed');
  } finally {
    await ctx.close();
  }
});

test('T-006 POST /webhook: a statuses-only (delivery receipt) payload is acknowledged with no FailedEvent and no Lead created', async () => {
  const ctx = await startTestServer();
  try {
    const statusPayload = {
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.abc', status: 'delivered' }] } }] }],
    };
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(statusPayload),
    });
    assert.equal(res.status, 200);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM failed_events').get().c, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM leads').get().c, 0);
  } finally {
    await ctx.close();
  }
});

test('T-006 POST /webhook: an invalid X-Hub-Signature-256 is rejected and logged as a FailedEvent when an app secret is configured', async () => {
  const ctx = await startTestServer({ appSecret: 'real-secret' });
  try {
    const body = JSON.stringify(messagePayload('6284444444444', 'hi'));
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM leads').get().c, 0, 'no lead should be created on signature failure');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM failed_events').get().c, 1);
  } finally {
    await ctx.close();
  }
});

test('T-006 POST /webhook: a valid X-Hub-Signature-256 is accepted when an app secret is configured', async () => {
  const secret = 'real-secret';
  const ctx = await startTestServer({ appSecret: secret });
  try {
    const body = JSON.stringify(messagePayload('6285555555555', 'hi'));
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM leads').get().c, 1);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// docs/sdd/changes/2026-09-03-credentials-in-db.md, post-review security fix:
// a real cloud_api deployment (src/server.js, appSecretRequired: true) must
// never process an unverified webhook just because the owner hasn't
// finished configuring credentials yet. These tests exercise that flag
// directly since none of the pre-existing tests above opt into it.
// ---------------------------------------------------------------------------

test('appSecretRequired + no app secret configured: POST /webhook is rejected (503), no lead created, nothing sent', async () => {
  const ctx = await startTestServer({ appSecretRequired: true }); // appSecret left unset
  try {
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload('6286666666666', 'hi')),
    });
    assert.equal(res.status, 503);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM leads').get().c, 0, 'must not process an unverifiable event');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM failed_events').get().c, 0, 'this is a config-not-ready rejection, not a processing failure to log');
    assert.deepEqual(ctx.metaClient.sentMessages, []);
  } finally {
    await ctx.close();
  }
});

test('appSecretRequired + a real app secret IS configured: normal signature verification applies, valid signature still works', async () => {
  const secret = 'real-secret';
  const ctx = await startTestServer({ appSecretRequired: true, appSecret: secret });
  try {
    const body = JSON.stringify(messagePayload('6287777777777', 'hi'));
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM leads').get().c, 1);
  } finally {
    await ctx.close();
  }
});

test('appSecretRequired defaults to false/off: every pre-existing test above (unset appSecret, no flag) is unaffected -- explicit regression guard', async () => {
  const ctx = await startTestServer(); // no appSecretRequired override at all
  try {
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload('6288888888888', 'hi')),
    });
    assert.equal(res.status, 200, 'unset appSecretRequired must keep the original skip-verification-when-unset behavior');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) as c FROM leads').get().c, 1);
  } finally {
    await ctx.close();
  }
});
