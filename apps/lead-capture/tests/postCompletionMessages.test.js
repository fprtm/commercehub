'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const { createLeadsRepo } = require('../src/services/leadsRepo');
const { createInboundMessageProcessor } = require('../src/services/inboundMessageProcessor');
const { startTestServer, TEST_CONFIG } = require('./helpers/testApp');

/**
 * FR-801..FR-803 (docs/sdd/changes/2026-09-02-capture-post-completion-messages.md):
 * "Never Drop a Message, Even After the Q1/Q2 Flow Completes" -- the real
 * live-test bug this change fixes. Before this change, stateMachine.js
 * resolved every message after Q1/Q2 (or after fallback, or after the owner
 * marked the lead responded/closed) to NO_OP, and inboundMessageProcessor.js
 * did nothing with that: no reply (correct, unchanged), but also no record
 * of the message ever having arrived (the bug).
 */

const CATALOG = [
  { name: 'Kaos Rimba Navy', aliases: ['kaos navy'] },
  { name: 'Jaket Outdoor Waterproof', aliases: ['jaket outdoor'] },
];

test('FR-801/FR-802/FR-803: the real bug scenario -- a 3rd message naming a real product, after Q1/Q2 already completed with vague answers, is captured, correctly matched, and flags needs_review, with no new outbound reply', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => sent.push(body),
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628700000001';

  // Message 1: starts the flow (ack + Q1).
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text', timestamp: '2026-09-02T07:10:00.000Z' });
  // Message 2: answers Q1 with something vague/unrelated -- no confident
  // product match (mirrors the real scenario: two earlier low-content
  // messages filled Q1/Q2 before the actual product mention arrived).
  await processInboundMessage({ phoneNumber: phone, messageBody: 'boleh tanya-tanya dulu', messageType: 'text', timestamp: '2026-09-02T07:11:00.000Z' });
  // Message 3: answers Q2, completing the flow.
  await processInboundMessage({ phoneNumber: phone, messageBody: 'oke makasih infonya', messageType: 'text', timestamp: '2026-09-02T07:12:00.000Z' });

  const before = leadsRepo.findByPhone(phone);
  assert.equal(before.question1_answer, 'boleh tanya-tanya dulu');
  assert.equal(before.question2_answer, 'oke makasih infonya');
  assert.equal(before.matched_product, null, 'sanity: no confident match yet -- Q1 was too vague');
  assert.equal(before.needs_review, 1, 'sanity: FR-504 already flagged this from the unmatched Q1 answer');
  assert.equal(before.additional_notes, null, 'sanity: nothing post-completion has arrived yet');
  const sentCountBeforeThirdMessage = sent.length;

  // Message 4 (the real bug's message 3/4): arrives AFTER the flow is
  // complete, and names the actual product.
  const result = await processInboundMessage({
    phoneNumber: phone,
    messageBody: 'spill harga kaos rimba nya dong',
    messageType: 'text',
    timestamp: '2026-09-02T07:14:00.000Z',
  });

  assert.equal(result.decision.action, 'NO_OP');
  assert.equal(result.decision.reason, 'flow_already_complete');
  assert.deepEqual(result.decision.replies, [], 'NFR-802: no automated reply for a post-completion message');
  assert.equal(sent.length, sentCountBeforeThirdMessage, 'NFR-802: nothing new was actually sent, either');

  const after = leadsRepo.findByPhone(phone);

  // FR-801: message is visible somewhere on the Lead record now, with an
  // exact timestamped line -- never silently lost.
  assert.equal(after.additional_notes, '[2026-09-02T07:14:00Z] spill harga kaos rimba nya dong');

  // FR-802: the correct product is now matched, upgraded from "no match".
  assert.equal(after.matched_product, 'Kaos Rimba Navy');
  assert.ok(after.matched_product_score >= 0.65, `expected a confident score, got ${after.matched_product_score}`);

  // FR-803: needs_review is true regardless (it already was, from FR-504 --
  // but this proves the post-completion path itself also unconditionally
  // sets it, per the dedicated tests below).
  assert.equal(after.needs_review, 1);

  // Q1/Q2 answers themselves are untouched by this -- this is additive
  // capture, not a rewrite of the structured flow's own data.
  assert.equal(after.question1_answer, 'boleh tanya-tanya dulu');
  assert.equal(after.question2_answer, 'oke makasih infonya');

  db.close();
});

test('FR-803: needs_review flips true from a post-completion message even when Q1 already had a confident match (unconditional, not tied to match outcome)', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628700000002';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Kaos Rimba Navy', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Size L, WhatsApp aja', messageType: 'text' });

  const before = leadsRepo.findByPhone(phone);
  assert.equal(before.matched_product, 'Kaos Rimba Navy');
  assert.equal(before.needs_review, 0, 'sanity: FR-503 -- a confident Q1 match does NOT flag needs_review');

  await processInboundMessage({ phoneNumber: phone, messageBody: 'terima kasih ya', messageType: 'text' });

  const after = leadsRepo.findByPhone(phone);
  assert.equal(after.needs_review, 1, 'FR-803: any post-completion message flips needs_review true, even on an already-confident lead');

  db.close();
});

test('FR-802: a later, lower-confidence (but still-matched) post-completion message never downgrades an existing good match', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628700000003';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  // Exact product name -> score 1.0, stored as the confident match.
  await processInboundMessage({ phoneNumber: phone, messageBody: 'jaket outdoor', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Size XL, WhatsApp aja', messageType: 'text' });

  const before = leadsRepo.findByPhone(phone);
  assert.equal(before.matched_product, 'Jaket Outdoor Waterproof');
  assert.equal(before.matched_product_score, 1);

  // A typo'd post-completion mention of the SAME product still clears the
  // match threshold (matched: true) but scores strictly lower than 1.0 --
  // this must NOT overwrite the existing (better) match.
  const result = await processInboundMessage({
    phoneNumber: phone,
    messageBody: 'jakett outdor nya ada gak min warnanya apa aja ya',
    messageType: 'text',
  });
  assert.equal(result.decision.action, 'NO_OP');

  const after = leadsRepo.findByPhone(phone);
  assert.equal(after.matched_product, 'Jaket Outdoor Waterproof', 'unchanged -- a lower-scoring later match must not win');
  assert.equal(after.matched_product_score, 1, 'unchanged -- the original higher score is preserved');
  // The message itself is still captured (FR-801) even though it didn't win the match.
  assert.match(after.additional_notes, /jakett outdor nya ada gak min warnanya apa aja ya$/);

  db.close();
});

test('FR-802: an equal-confidence post-completion match for a DIFFERENT product does not replace the existing match (must be strictly higher, not just as-high)', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628700000004';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Kaos Rimba Navy', messageType: 'text' }); // score 1.0
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Size L, WhatsApp aja', messageType: 'text' });

  await processInboundMessage({ phoneNumber: phone, messageBody: 'jaket outdoor', messageType: 'text' }); // also scores 1.0, different product

  const after = leadsRepo.findByPhone(phone);
  assert.equal(after.matched_product, 'Kaos Rimba Navy', 'the first confident match wins ties -- "higher", not "as high"');
  assert.equal(after.matched_product_score, 1);

  db.close();
});

test('FR-802: a post-completion message that names an unmatched/no product still gets captured (FR-801) without touching an existing match', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628700000005';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Kaos Rimba Navy', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Size L, WhatsApp aja', messageType: 'text' });

  await processInboundMessage({ phoneNumber: phone, messageBody: 'toko buka jam berapa ya', messageType: 'text' });

  const after = leadsRepo.findByPhone(phone);
  assert.equal(after.matched_product, 'Kaos Rimba Navy', 'unrelated later message must not clear an existing good match');
  assert.match(after.additional_notes, /toko buka jam berapa ya$/, 'still captured, just did not win the match');
  assert.equal(after.needs_review, 1);

  db.close();
});

test('FR-801: multiple post-completion messages append as a running log, never overwriting/truncating earlier notes', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
  });

  const phone = '628700000006';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Kaos', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'L', messageType: 'text' });

  await processInboundMessage({ phoneNumber: phone, messageBody: 'satu lagi nih', messageType: 'text', timestamp: '2026-09-02T08:00:00.000Z' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'jadi beli dua ya', messageType: 'text', timestamp: '2026-09-02T08:05:00.000Z' });

  const lead = leadsRepo.findByPhone(phone);
  assert.equal(
    lead.additional_notes,
    '[2026-09-02T08:00:00Z] satu lagi nih\n[2026-09-02T08:05:00Z] jadi beli dua ya',
    'both messages preserved, in order, older note not truncated by the newer one',
  );

  db.close();
});

test('FR-801/FR-803 (judgment call): also applies to the fallback_already_triggered NO_OP reason, not just flow_already_complete', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => sent.push(body),
    sleep: async () => {},
  });

  const phone = '628700000007';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  // Two unusable (non-text) messages in a row: RETRY, then FALLBACK.
  await processInboundMessage({ phoneNumber: phone, messageBody: null, messageType: 'sticker' });
  await processInboundMessage({ phoneNumber: phone, messageBody: null, messageType: 'sticker' });

  const afterFallback = leadsRepo.findByPhone(phone);
  assert.equal(afterFallback.fallback_triggered, 1, 'sanity: fallback has genuinely fired');
  const sentCountAfterFallback = sent.length;

  const result = await processInboundMessage({
    phoneNumber: phone,
    messageBody: 'eh masih ada orangnya gak',
    messageType: 'text',
    timestamp: '2026-09-02T09:00:00.000Z',
  });

  assert.equal(result.decision.action, 'NO_OP');
  assert.equal(result.decision.reason, 'fallback_already_triggered');
  assert.deepEqual(result.decision.replies, [], 'NFR-802: still no automated reply');
  assert.equal(sent.length, sentCountAfterFallback, 'NFR-802: nothing new actually sent');

  const after = leadsRepo.findByPhone(phone);
  assert.equal(after.additional_notes, '[2026-09-02T09:00:00Z] eh masih ada orangnya gak');
  assert.equal(after.needs_review, 1);

  db.close();
});

test('FR-801/FR-803 (judgment call, post-review scoped): the lead_status_responded/closed NO_OP reasons still get the message captured into additional_notes, but do NOT get needs_review force-flagged (closed is terminal -- no escape hatch exists to ever clear it)', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => sent.push(body),
    sleep: async () => {},
  });

  const phone = '628700000008';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.needs_review, 0, 'sanity: not flagged before any of this');
  // Owner action from the dashboard, bypassing the automated flow entirely.
  leadsRepo.updateStatus(lead.id, 'responded');
  leadsRepo.updateStatus(lead.id, 'closed');
  const sentCountAfterClose = sent.length;

  const result = await processInboundMessage({
    phoneNumber: phone,
    messageBody: 'masih buka gak nih',
    messageType: 'text',
    timestamp: '2026-09-02T10:00:00.000Z',
  });

  assert.equal(result.decision.action, 'NO_OP');
  assert.equal(result.decision.reason, 'lead_status_closed');
  assert.deepEqual(result.decision.replies, [], 'NFR-802: closed leads still get no automated reply');
  assert.equal(sent.length, sentCountAfterClose);

  const after = leadsRepo.findByPhone(phone);
  // FR-801 still holds: the message is captured, never silently dropped.
  assert.equal(after.additional_notes, '[2026-09-02T10:00:00Z] masih buka gak nih');
  // Post-review fix: needs_review is NOT force-flagged for a terminal
  // (closed/responded) lead -- it stays exactly what it was (0 here),
  // since there would be no way for the owner to ever clear it otherwise.
  assert.equal(after.needs_review, 0, 'closed lead: needs_review must NOT be force-flagged (no escape hatch exists)');
  assert.equal(after.status, 'closed', 'this capture does not itself reopen/change lifecycle status');

  db.close();
});

test('FR-803 scoping (post-review fix): needs_review is PRESERVED, not force-cleared either, when a closed/responded lead already had it set to true from before', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
    products: CATALOG,
  });

  const phone = '628700000011';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  // Vague Q1 answer -> FR-504 already flags needs_review=1 before the lead is ever closed.
  await processInboundMessage({ phoneNumber: phone, messageBody: 'boleh tanya-tanya dulu', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'oke', messageType: 'text' });

  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.needs_review, 1, 'sanity: already flagged, from the unmatched Q1 answer');
  leadsRepo.updateStatus(lead.id, 'responded');
  leadsRepo.updateStatus(lead.id, 'closed');

  await processInboundMessage({
    phoneNumber: phone,
    messageBody: 'jaket outdoor',
    messageType: 'text',
    timestamp: '2026-09-02T11:00:00.000Z',
  });

  const after = leadsRepo.findByPhone(phone);
  assert.equal(after.needs_review, 1, 'left exactly as it was -- not force-cleared just because this is a terminal-status NO_OP');
  assert.equal(after.matched_product, 'Jaket Outdoor Waterproof', 'FR-802 matching still applies for terminal-status leads');
  assert.match(after.additional_notes, /jaket outdoor$/);

  db.close();
});

test('FR-803 scoping (post-review fix): the dashboard never shows a closed lead with the "needs review" badge and "no further action" at the same time, for a post-completion message', async () => {
  const ctx = await startTestServer();
  try {
    const loginRes = await fetch(`${ctx.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=secret-password',
      redirect: 'manual',
    });
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    const leadsRepo = createLeadsRepo(ctx.db);
    const lead = leadsRepo.create({ phoneNumber: '628700000012', firstMessageAt: '2026-09-02T00:00:00.000Z' });
    leadsRepo.saveAnswers(lead.id, { question1Answer: 'Kaos', question2Answer: 'L', fallbackTriggered: false });
    leadsRepo.updateStatus(lead.id, 'responded');
    leadsRepo.updateStatus(lead.id, 'closed');
    // Exactly what inboundMessageProcessor.js now does for this NO_OP reason.
    leadsRepo.appendAdditionalNote(lead.id, '[2026-09-02T12:00:00Z] masih ada gak', { needsReview: false });

    const stored = leadsRepo.findById(lead.id);
    assert.equal(stored.needs_review, 0);
    assert.equal(stored.status, 'closed');

    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();
    const rowStart = html.indexOf('628700000012');
    const rowHtml = html.slice(rowStart, rowStart + 1500);

    assert.match(rowHtml, /No further action/);
    assert.doesNotMatch(rowHtml, /Needs review/, 'a closed lead must never show the needs-review badge (no way to ever clear it)');
  } finally {
    await ctx.close();
  }
});

test('FR-801: a non-text post-completion message (e.g. a sticker) is left as a true no-op -- nothing to append, nothing captured', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {},
  });

  const phone = '628700000009';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Kaos', messageType: 'text' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'L', messageType: 'text' });

  const before = leadsRepo.findByPhone(phone);
  await processInboundMessage({ phoneNumber: phone, messageBody: null, messageType: 'sticker' });
  const after = leadsRepo.findByPhone(phone);

  assert.equal(after.additional_notes, null);
  assert.equal(after.needs_review, before.needs_review, 'a contentless message does not flip needs_review either');

  db.close();
});

test('FR-801: the dashboard (GET /leads) displays additional_notes when present, in a visually distinct block', async () => {
  const ctx = await startTestServer({ productsConfig: CATALOG });
  try {
    const loginRes = await fetch(`${ctx.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=secret-password',
      redirect: 'manual',
    });
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    const leadsRepo = createLeadsRepo(ctx.db);
    const lead = leadsRepo.create({ phoneNumber: '628700000010', firstMessageAt: '2026-09-02T00:00:00.000Z' });
    leadsRepo.saveAnswers(lead.id, { question1Answer: 'Kaos', question2Answer: 'L', fallbackTriggered: false });
    leadsRepo.appendAdditionalNote(lead.id, '[2026-09-02T07:14:00Z] spill harga kaos rimba nya dong');

    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();

    assert.match(html, /additional-notes/, 'the distinct CSS class for additional notes is present');
    assert.match(html, /spill harga kaos rimba nya dong/);
  } finally {
    await ctx.close();
  }
});
