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

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE phone_number = ?').get('6281234567890');
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

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE phone_number = ?').get(phone);
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

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE phone_number = ?').get(phone);
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

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE phone_number = ?').get(phone);
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

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE phone_number = ?').get(phone);
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
    const lead = ctx.db.prepare('SELECT * FROM leads WHERE phone_number = ?').get('6283333333333');
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
