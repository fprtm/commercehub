'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const { createLeadsRepo } = require('../src/services/leadsRepo');
const { createInboundMessageProcessor } = require('../src/services/inboundMessageProcessor');
const { startTestServer, TEST_CONFIG } = require('./helpers/testApp');

const CATALOG = [
  { name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'kaos', 'baju kaos'] },
  { name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] },
];

/**
 * FR-503/FR-504 (docs/sdd/changes/2026-09-01-fuzzy-product-matching.md):
 * the end-to-end behavior of fuzzy product matching once it's actually
 * wired into inboundMessageProcessor.js -- both at the shared-processor
 * level and, separately, over the real HTTP webhook + dashboard routes.
 */

test('FR-503: a high-confidence Q1 match proceeds through Q2 completely unchanged, and stores the matched product on the Lead', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => { sent.push(body); },
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628500000001';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  const result = await processInboundMessage({ phoneNumber: phone, messageBody: 'Kaos Rimba Navy', messageType: 'text' });

  assert.equal(result.decision.action, 'ANSWER_Q1');
  assert.equal(result.decision.replies.length, 1, 'Q2 must still be sent (FR-503: unchanged flow)');
  assert.equal(result.decision.replies[0], TEST_CONFIG.questions[1].text);
  assert.match(sent.at(-1), /size \/ how should we contact you/i);

  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.question1_answer, 'Kaos Rimba Navy');
  assert.equal(lead.matched_product, 'Kaos Rimba Navy');
  assert.equal(lead.needs_review, 0);

  db.close();
});

test('FR-504: a low-confidence/unrelated Q1 answer suppresses the Q2 prompt and flags needs_review, without touching fallback/retry', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => { sent.push(body); },
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628500000002';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  const sentCountAfterFirstContact = sent.length;
  const result = await processInboundMessage({ phoneNumber: phone, messageBody: 'toko buka jam berapa?', messageType: 'text' });

  // FR-504: no Q2 prompt sent for this turn.
  assert.equal(result.decision.action, 'ANSWER_Q1', 'the state machine still treats this as a structurally-usable Q1 answer');
  assert.equal(result.decision.replies.length, 0, 'the Q2 prompt must be suppressed');
  assert.equal(sent.length, sentCountAfterFirstContact, 'no new outbound message was sent for this turn');

  // Raw text still visible on the Lead for the owner (FR-504), and flagged.
  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.question1_answer, 'toko buka jam berapa?', 'raw text must still be stored for manual review');
  assert.equal(lead.needs_review, 1);
  assert.equal(lead.matched_product, null);

  // Settled Decision #3: "no fallback/retry triggered by this alone".
  assert.equal(lead.fallback_triggered, 0);
  assert.equal(lead.retry_count, 0);

  db.close();
});

test('NFR-502: an explicitly empty product catalog always resolves to needs_review (safe default), never a crash, over the real processor', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
    products: [], // explicitly empty, not omitted -- activates matching (see inboundMessageProcessor.js doc)
  });

  const phone = '628500000003';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  await assert.doesNotReject(async () => {
    const result = await processInboundMessage({ phoneNumber: phone, messageBody: 'Kaos Rimba Navy', messageType: 'text' });
    assert.equal(result.decision.replies.length, 0);
  });

  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.needs_review, 1);
  assert.equal(lead.matched_product, null);

  db.close();
});

test('NFR-502: omitting `products` entirely (every pre-existing caller) leaves fuzzy-matching a complete no-op -- Q2 still sent, no needs_review flag', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
    // no `products` key at all
  });

  const phone = '628500000004';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  const result = await processInboundMessage({ phoneNumber: phone, messageBody: 'toko buka jam berapa?', messageType: 'text' });

  assert.equal(result.decision.replies.length, 1, 'Q2 must still be sent -- matching never activated');
  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.needs_review, 0);
  assert.equal(lead.matched_product, null);

  db.close();
});

test('read receipt still fires for a suppressed-Q2 turn -- only the scripted reply is affected, per the humanized-timing contract', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const readReceipts = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    markAsRead: async (to, messageId) => { readReceipts.push({ to, messageId }); },
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628500000005';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text', messageId: 'm1' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'toko buka jam berapa?', messageType: 'text', messageId: 'm2' });

  assert.equal(readReceipts.length, 2, 'markAsRead fires unconditionally, regardless of whether the scripted reply was suppressed');
  assert.deepEqual(readReceipts[1], { to: phone, messageId: 'm2' });

  db.close();
});

/**
 * Post-review adversarial fix (Critical finding): a product word appearing
 * inside an unrelated complaint used to score a confident 1.0 match and
 * get a tone-deaf auto-reply with needs_review=false -- zero signal to the
 * owner that anything was wrong. This proves the fix end-to-end through
 * the actual processor (not just productMatcher.js in isolation): the Q2
 * "what size?" prompt must NOT be sent for a refund complaint, and the
 * Lead must be flagged needs_review with the raw complaint text intact.
 */
test('ADVERSARIAL end-to-end (Critical fix): a refund complaint about the product does NOT get the tone-deaf Q2 auto-reply, and IS flagged needs_review', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => { sent.push(body); },
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628500000006';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  const sentCountAfterFirstContact = sent.length;
  const result = await processInboundMessage({
    phoneNumber: phone,
    messageBody: 'kaos kemarin yang saya beli robek, bisa refund?',
    messageType: 'text',
  });

  assert.equal(result.decision.replies.length, 0, 'the "what size?" Q2 prompt must be suppressed for a complaint, not sent');
  assert.equal(sent.length, sentCountAfterFirstContact, 'no tone-deaf auto-reply was sent');

  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.question1_answer, 'kaos kemarin yang saya beli robek, bisa refund?', 'raw complaint text preserved for the owner');
  assert.equal(lead.needs_review, 1, 'this must NOT look like a normal successful match on the dashboard');
  assert.equal(lead.matched_product, null);

  db.close();
});

test('ADVERSARIAL end-to-end (Critical fix): naming the full product then complaining is still caught by the denylist, not just the scoring fix', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628500000007';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  const result = await processInboundMessage({
    phoneNumber: phone,
    messageBody: 'kaos rimba navy saya rusak parah, refund dong',
    messageType: 'text',
  });

  assert.equal(result.decision.replies.length, 0);
  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.needs_review, 1);
  assert.equal(lead.matched_product, null);

  db.close();
});

test('AMBIGUITY end-to-end (Medium fix): two products sharing a generic alias resolve to needs_review over the real processor, not a silent pick', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const AMBIGUOUS_CATALOG = [
    { name: 'Kaos Rimba Navy', aliases: ['kaos'] },
    { name: 'Kaos Rimba Merah', aliases: ['kaos'] },
  ];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
    products: AMBIGUOUS_CATALOG,
  });

  const phone = '628500000008';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  const result = await processInboundMessage({ phoneNumber: phone, messageBody: 'kaos dong', messageType: 'text' });

  assert.equal(result.decision.replies.length, 0);
  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.needs_review, 1);
  assert.equal(lead.matched_product, null);

  db.close();
});

test('ADVERSARIAL end-to-end over real HTTP: a refund complaint shows needs_review on the dashboard, not a false "Matched product"', async () => {
  const ctx = await startTestServer({ productsConfig: CATALOG });
  try {
    const phone = '6281900000003';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'halo, ada info produk?')),
    });
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'kaos kemarin yang saya beli robek, bisa refund?')),
    });

    // Only ack + Q1 from the first contact -- no Q2 "what size?" reply to a complaint.
    assert.equal(ctx.metaClient.sentMessages.length, 2);

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /robek, bisa refund\?/, 'raw complaint text must be visible for manual interpretation');
    assert.match(html, /Needs review — unmatched product/);
    assert.doesNotMatch(html, /Matched product:/, 'must NOT look like a normal successful match');
  } finally {
    await ctx.close();
  }
});

test('FR-503/end-to-end over real HTTP: a matched Q1 answer sends Q2 via POST /webhook and the dashboard shows the matched product', async () => {
  const ctx = await startTestServer({ productsConfig: CATALOG });
  try {
    const phone = '6281900000001';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'halo, ada info produk?')),
    });
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'Kaos Rimba Navy')),
    });

    assert.equal(ctx.metaClient.sentMessages.length, 3, 'ack + Q1, then Q2 -- unchanged flow');
    assert.equal(ctx.metaClient.sentMessages[2].body, TEST_CONFIG.questions[1].text);

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /Matched product: Kaos Rimba Navy/);
    assert.doesNotMatch(html, /Needs review — unmatched product/);
  } finally {
    await ctx.close();
  }
});

test('FR-504/end-to-end over real HTTP: an unmatched Q1 answer suppresses Q2 via POST /webhook and the dashboard flags needs_review with the raw text', async () => {
  const ctx = await startTestServer({ productsConfig: CATALOG });
  try {
    const phone = '6281900000002';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'halo, ada info produk?')),
    });
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'toko buka jam berapa?')),
    });

    // Only ack + Q1 from the first contact -- no Q2 prompt for the second message.
    assert.equal(ctx.metaClient.sentMessages.length, 2);

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /toko buka jam berapa\?/, 'raw Q1 text must be visible for manual interpretation');
    assert.match(html, /Needs review — unmatched product/);
  } finally {
    await ctx.close();
  }
});

/**
 * Post-review RETUNING (second independent review): proves the
 * overcorrection fix end-to-end through the real processor, not just
 * productMatcher.js in isolation -- a realistic longer purchase question
 * (with filler/politeness words: "min", "nya", "gak", "selain") must
 * proceed through Q2 normally, exactly like the short/exact-match cases
 * already covered above.
 */
test('RETUNED end-to-end: a realistic longer purchase question (with filler words) still gets Q2 and a matched product, not needs_review', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => { sent.push(body); },
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628500000009';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  const result = await processInboundMessage({
    phoneNumber: phone,
    messageBody: 'min, kaos rimba navy nya ada warna lain gak selain navy',
    messageType: 'text',
  });

  assert.equal(result.decision.replies.length, 1, 'Q2 must be sent -- this is an ordinary purchase question, not a complaint');
  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.matched_product, 'Kaos Rimba Navy');
  assert.equal(lead.needs_review, 0);

  db.close();
});

function webhookPayload(from, body, timestamp = '1735689600') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              messages: [{ from, id: `wamid.${Date.now()}.${Math.random()}`, timestamp, type: 'text', text: { body } }],
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
