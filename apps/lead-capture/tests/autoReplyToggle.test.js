'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('./helpers/testApp');
const { createDb } = require('../src/db');
const { createLeadsRepo } = require('../src/services/leadsRepo');
const { createSettingsRepo } = require('../src/services/settingsRepo');
const { createInboundMessageProcessor } = require('../src/services/inboundMessageProcessor');

/**
 * Coverage for docs/sdd/changes/2026-09-01-auto-reply-toggle.md
 * (FR-401..FR-403, NFR-401..NFR-402).
 *
 * NFR-402 constraint: this file only ADDS new tests. None of the
 * pre-existing 87 tests (webhook.test.js, leads.test.js,
 * inboundMessageProcessor.test.js, baileysConnector.test.js, etc.) were
 * modified -- see the README's updated "Running the tests" count.
 */

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

async function loginAndGetCookie(ctx) {
  const res = await fetch(`${ctx.baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=owner&password=secret-password',
    redirect: 'manual',
  });
  return res.headers.get('set-cookie').split(';')[0];
}

// ---------------------------------------------------------------------------
// Unit level: the shared inboundMessageProcessor.js contract directly (the
// exact function both the webhook route and the Baileys connector call into
// -- see src/services/inboundMessageProcessor.js's header comment).
// ---------------------------------------------------------------------------

test('FR-402 (unit): auto_reply_enabled=false -- inbound message still creates a Lead, but sendTextMessage is never called', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const settingsRepo = createSettingsRepo(db);
  settingsRepo.setAutoReplyEnabled(false);

  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: require('./helpers/testApp').TEST_CONFIG,
    sendTextMessage: async (to, body) => { sent.push({ to, body }); },
    settingsRepo,
    // NFR-603 (docs/sdd/changes/2026-09-01-humanized-timing-module.md):
    // every reply now goes through @rimba/humanized-timing's humanizedTiming.js, which
    // defaults to real delays -- an instant fake `sleep` keeps this test
    // fast/deterministic.
    sleep: async () => {},
  });

  const phone = '628999900001';
  await processInboundMessage({
    contactId: phone,
    messageBody: 'halo, baju ini masih ada?',
    messageType: 'text',
    channel: 'whatsapp_cloud_api',
  });

  const lead = leadsRepo.findByContact(phone, 'whatsapp');
  assert.ok(lead, 'a Lead row must still be created while auto-reply is OFF');
  assert.equal(lead.status, 'new');
  assert.equal(lead.question1_answer, null);

  // This is the actual assertion proving "no outbound send recorded":
  // the spy array that sendTextMessage pushes into on every call stays
  // completely empty.
  assert.deepEqual(sent, [], 'no outbound send (ack, question, retry, or fallback) should be attempted while OFF');

  db.close();
});

test('FR-402 (unit): same bookkeeping (createLead + leadPatch) runs whether auto-reply is ON or OFF -- only the send loop differs', async () => {
  const configPatch = require('./helpers/testApp').TEST_CONFIG;

  async function runFlow(autoReplyEnabled) {
    const db = createDb(':memory:');
    const leadsRepo = createLeadsRepo(db);
    const settingsRepo = createSettingsRepo(db);
    settingsRepo.setAutoReplyEnabled(autoReplyEnabled);
    const sent = [];
    const { processInboundMessage } = createInboundMessageProcessor({
      leadsRepo,
      questionsConfig: configPatch,
      sendTextMessage: async (to, body) => { sent.push({ to, body }); },
      settingsRepo,
      sleep: async () => {}, // NFR-603, see comment above
    });
    const phone = autoReplyEnabled ? '628999900010' : '628999900011';
    await processInboundMessage({ contactId: phone, messageBody: 'halo', messageType: 'text' });
    const lead = leadsRepo.findByContact(phone, 'whatsapp');
    db.close();
    return { lead, sentCount: sent.length };
  }

  const on = await runFlow(true);
  const off = await runFlow(false);

  // Identical Lead bookkeeping either way (FR-402: "creates/updates a Lead
  // record exactly as it does today").
  assert.equal(on.lead.status, off.lead.status);
  assert.equal(on.lead.question1_answer, off.lead.question1_answer);
  assert.equal(on.lead.fallback_triggered, off.lead.fallback_triggered);

  // Only the outbound side differs.
  assert.equal(on.sentCount, 2, 'ON: ack + Q1 are sent, matching unmodified default behavior (FR-403)');
  assert.equal(off.sentCount, 0, 'OFF: nothing is sent');
});

// ---------------------------------------------------------------------------
// HTTP/integration level: full app wiring (webhook route + settings route +
// dashboard), same startTestServer() harness the rest of the suite uses.
// ---------------------------------------------------------------------------

test('FR-401: GET /leads shows auto-reply ON by default', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /Auto-reply is/);
    assert.match(html, />ON</);
    assert.match(html, /Turn off/);
  } finally {
    await ctx.close();
  }
});

test('FR-401: POST /settings/auto-reply requires authentication, same as the rest of the dashboard', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/settings/auto-reply`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/login/);
  } finally {
    await ctx.close();
  }
});

test('FR-401: toggling persists across requests -- a GET after a POST reflects the new state', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);

    // Starts ON.
    let html = await (await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } })).text();
    assert.match(html, />ON</);

    // POST toggles it off and redirects back to /leads.
    const postRes = await fetch(`${ctx.baseUrl}/settings/auto-reply`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(postRes.status, 302);
    assert.match(postRes.headers.get('location'), /\/leads/);

    // A fresh GET (a separate request) reflects OFF -- not stale, not
    // reset (proves NFR-401's "read fresh" is also true for the dashboard
    // read path, and that the toggle actually persisted in the DB).
    html = await (await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } })).text();
    assert.match(html, />OFF</);
    assert.match(html, /Turn on/);

    // Toggle back ON and confirm the same persistence in the other direction.
    await fetch(`${ctx.baseUrl}/settings/auto-reply`, { method: 'POST', headers: { Cookie: cookie } });
    html = await (await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } })).text();
    assert.match(html, />ON</);
  } finally {
    await ctx.close();
  }
});

test('FR-402: a message received over the real webhook while OFF creates a Lead with zero outbound sends recorded', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    await fetch(`${ctx.baseUrl}/settings/auto-reply`, { method: 'POST', headers: { Cookie: cookie } }); // OFF

    const phone = '6281230000001';
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'halo, baju ini masih ada?')),
    });
    assert.equal(res.status, 200);

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(phone);
    assert.ok(lead, 'Lead must still be created while auto-reply is OFF');
    assert.equal(lead.status, 'new');

    // The mock Meta client (tests/helpers/testApp.js) records every "sent"
    // message in ctx.metaClient.sentMessages -- this is the project's
    // existing spy pattern (same array webhook.test.js already asserts on
    // for T-006). Asserting it stays empty is the direct proof that no
    // ack/question/retry/fallback was attempted.
    assert.deepEqual(ctx.metaClient.sentMessages, [], 'no outbound send should be recorded while auto-reply is OFF');
  } finally {
    await ctx.close();
  }
});

test('FR-402: toggling back ON does not retroactively message a customer whose message arrived while OFF', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    await fetch(`${ctx.baseUrl}/settings/auto-reply`, { method: 'POST', headers: { Cookie: cookie } }); // OFF

    const phone = '6281230000002';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'halo, baju ini masih ada?')),
    });
    assert.deepEqual(ctx.metaClient.sentMessages, [], 'sanity: nothing sent yet, matching the previous test');

    // Toggle back ON. No new inbound message arrives -- this simulates the
    // owner flipping the switch back on some time later.
    const toggleOnRes = await fetch(`${ctx.baseUrl}/settings/auto-reply`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(toggleOnRes.status, 302);

    const html = await (await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } })).text();
    assert.match(html, />ON</, 'sanity: toggle really did flip back to ON');

    // The core assertion: turning auto-reply back ON is a pure state flip,
    // not a "flush pending replies" action -- the customer who wrote in
    // while OFF must not be retroactively messaged just because the switch
    // was flipped later.
    assert.deepEqual(
      ctx.metaClient.sentMessages,
      [],
      'toggling back ON must not retroactively send anything for a message that arrived while OFF',
    );

    // The Lead itself is untouched/unresent too.
    const lead = ctx.db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(phone);
    assert.equal(lead.status, 'new');
  } finally {
    await ctx.close();
  }
});

test('FR-402: a second, later message from the same phone after re-enabling gets a normal reply (only the OFF-window message was silent)', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    await fetch(`${ctx.baseUrl}/settings/auto-reply`, { method: 'POST', headers: { Cookie: cookie } }); // OFF

    const phone = '6281230000003';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'halo, baju ini masih ada?', '1735689600')),
    });
    assert.equal(ctx.metaClient.sentMessages.length, 0);

    await fetch(`${ctx.baseUrl}/settings/auto-reply`, { method: 'POST', headers: { Cookie: cookie } }); // back ON

    // A genuinely new inbound message, received after re-enabling, still
    // drives a real reply -- proving OFF only suppressed the send for
    // messages received during the OFF window, not permanently for that
    // lead. Note: since question1_answer was never actually populated
    // while OFF (the ack+Q1 send was skipped, not just delayed), the state
    // machine correctly treats this next message as the ANSWER to Q1 (the
    // same behavior it would have if auto-reply had been ON the whole
    // time and the ack+Q1 send simply hadn't reached the customer yet) --
    // so the reply sent is Q2, not a re-sent Q1. This is exactly the
    // "unchanged, exactly as today" bookkeeping FR-402 requires.
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'Kaos Rimba Hitam', '1735689700')),
    });

    assert.equal(ctx.metaClient.sentMessages.length, 1, 'the answer to the pending question should now be sent normally');
    assert.equal(ctx.metaClient.sentMessages[0].body, 'What size / how should we contact you?');

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(phone);
    assert.equal(lead.question1_answer, 'Kaos Rimba Hitam');
  } finally {
    await ctx.close();
  }
});

test('FR-403 (explicit regression): with auto-reply left at its default (ON), a first-time message still gets ack + Q1 sent, unchanged from before this feature existed', async () => {
  const ctx = await startTestServer();
  try {
    // No toggle interaction at all -- exercises the exact default path a
    // pre-existing deployment would hit.
    const phone = '6281230000004';
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload(phone, 'halo, baju ini masih ada?')),
    });
    assert.equal(res.status, 200);

    const lead = ctx.db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(phone);
    assert.ok(lead);
    assert.equal(ctx.metaClient.sentMessages.length, 2);
    assert.match(ctx.metaClient.sentMessages[0].body, /automated reply from Rimba Apparel/);
    assert.equal(ctx.metaClient.sentMessages[1].body, 'Which product are you interested in?');
  } finally {
    await ctx.close();
  }
});
