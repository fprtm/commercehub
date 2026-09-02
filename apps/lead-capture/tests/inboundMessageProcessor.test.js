'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const { createLeadsRepo } = require('../src/services/leadsRepo');
const { createInboundMessageProcessor } = require('../src/services/inboundMessageProcessor');
const { TEST_CONFIG } = require('./helpers/testApp');

/**
 * FR-302's whole point: the webhook route (Cloud API, push model) and the
 * Baileys connector (persistent-connection model) are structurally
 * different on the inbound side, but they must drive the exact same
 * state-machine/Lead-repo code underneath. This test proves that directly
 * by calling the shared processInboundMessage() the same way each of those
 * two callers does, against the same DB, and checking they produce
 * identical Lead outcomes.
 */
test('FR-302: processInboundMessage produces identical Lead outcomes whether called with a cloud_api-shaped or a baileys-shaped payload', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];

  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => {
      sent.push({ to, body });
    },
    // NFR-603: every reply now goes through @rimba/humanized-timing's
    // humanizedTiming.js, which defaults to real delays -- an instant fake
    // `sleep` keeps this test fast/deterministic (see
    // packages/humanized-timing/test/humanizedTiming.test.js for
    // dedicated coverage of the real timing formula/orchestration itself).
    sleep: async () => {},
  });

  // Shape webhook.js actually calls with (see src/routes/webhook.js's processMessage()).
  await processInboundMessage({
    contactId: '628111111111',
    messageBody: 'halo, baju ini masih ada?',
    messageType: 'text',
    timestamp: new Date('2026-09-01T00:00:00.000Z').toISOString(),
    channel: 'whatsapp_cloud_api',
  });

  // Shape the Baileys connector actually calls with (see
  // @rimba/whatsapp-connector's baileysConnector.js's handleMessagesUpsert()) -- same
  // logical first-contact message, different channel/caller.
  await processInboundMessage({
    contactId: '628222222222',
    messageBody: 'halo, baju ini masih ada?',
    messageType: 'text',
    timestamp: new Date('2026-09-01T00:00:01.000Z').toISOString(),
    channel: 'whatsapp_baileys',
  });

  const leadA = leadsRepo.findByContact('628111111111', 'whatsapp');
  const leadB = leadsRepo.findByContact('628222222222', 'whatsapp');

  assert.ok(leadA && leadB, 'both channels must create a Lead row via the same leadsRepo');
  assert.equal(leadA.status, 'new');
  assert.equal(leadB.status, 'new');
  assert.equal(leadA.question1_answer, null);
  assert.equal(leadB.question1_answer, null);

  // ack + Q1 sent for each, via the injected sendTextMessage -- proving the
  // outbound half of the FR-302 contract is channel-agnostic too.
  assert.equal(sent.length, 4);
  assert.match(sent[0].body, /automated reply from Rimba Apparel/);
  assert.equal(sent[1].body, 'Which product are you interested in?');
  assert.match(sent[2].body, /automated reply from Rimba Apparel/);
  assert.equal(sent[3].body, 'Which product are you interested in?');

  db.close();
});

test('FR-302: a full qualifying-question flow behaves identically when driven entirely through the shared processor (no webhook/Baileys route involved)', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async () => {},
    sleep: async () => {}, // NFR-603, see comment above
  });

  const phone = '628333333333';
  await processInboundMessage({ contactId: phone, messageBody: 'halo', messageType: 'text', channel: 'whatsapp_baileys' });
  await processInboundMessage({ contactId: phone, messageBody: 'Kaos Rimba Hitam', messageType: 'text', channel: 'whatsapp_baileys' });
  await processInboundMessage({ contactId: phone, messageBody: 'Size L, WhatsApp aja', messageType: 'text', channel: 'whatsapp_baileys' });

  const lead = leadsRepo.findByContact(phone, 'whatsapp');
  assert.equal(lead.question1_answer, 'Kaos Rimba Hitam');
  assert.equal(lead.question2_answer, 'Size L, WhatsApp aja');
  assert.equal(lead.fallback_triggered, 0);

  db.close();
});

test('FR-601 (post-review fix): markAsRead still fires for a new inbound message even when decision.replies is empty (e.g. the flow is already complete)', async () => {
  // Decision made on review: markAsRead is decoupled from whether a
  // scripted reply follows -- Decision 001 frames the read receipt as
  // "the customer gets an early signal their message was received",
  // which does not logically depend on there being a queued reply. This
  // covers the "flow already complete" NO_OP case specifically; the same
  // fix also covers NO_OP on an already-responded/closed lead, fallback
  // already triggered, and ANSWER_Q2 with no completionMessage configured
  // -- all of those hit the same `if (markAsRead) await markAsRead(...)`
  // call in inboundMessageProcessor.js, unconditional on decision.replies.
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];
  const readReceipts = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => { sent.push({ to, body }); },
    markAsRead: async (to, messageId) => { readReceipts.push({ to, messageId }); },
    sleep: async () => {},
  });

  const phone = '628444444444';
  // Complete the flow: start (ack+Q1), answer Q1 (Q2), answer Q2
  // (completionMessage, since TEST_CONFIG defines one) -- 4 sends, 3 read
  // receipts, all messages so far genuinely produced a reply.
  await processInboundMessage({ contactId: phone, messageBody: 'halo', messageType: 'text', messageId: 'm1' });
  await processInboundMessage({ contactId: phone, messageBody: 'Kaos Rimba Hitam', messageType: 'text', messageId: 'm2' });
  await processInboundMessage({ contactId: phone, messageBody: 'Size L, WhatsApp aja', messageType: 'text', messageId: 'm3' });
  assert.equal(readReceipts.length, 3, 'sanity: one read receipt per inbound message so far, all of which had replies');
  const sentCountBeforeFourthMessage = sent.length;

  // A 4th message after the flow is already complete -- NO_OP, zero replies.
  const result = await processInboundMessage({ contactId: phone, messageBody: 'thanks!', messageType: 'text', messageId: 'm4' });

  assert.equal(result.decision.replies.length, 0, 'sanity: this message genuinely produces zero scripted replies');
  assert.equal(sent.length, sentCountBeforeFourthMessage, 'no new outbound reply was sent for the 4th message (unchanged behavior)');
  assert.equal(readReceipts.length, 4, 'the read receipt still fired for the 4th message, even though it produced no reply');
  assert.deepEqual(readReceipts[3], { to: phone, messageId: 'm4' });

  db.close();
});

/**
 * TICKET-1305 (docs/sdd/specs/002-telegram-multichannel/tickets/05-media-message-capture.md,
 * FR-1304, FSD Flow 2, threats.md SEC-1305): a non-text message
 * (photo/sticker/etc) carrying a `mediaRef` (an opaque reference string --
 * e.g. Telegram's `file_id` -- never the actual file bytes, per SEC-1305)
 * must never be silently dropped, even with no caption and even on a
 * contact's very first-ever message.
 */
test('TICKET-1305: a first-ever message that is a photo with no caption still creates the Lead and captures the media reference, with zero replies sent', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => { sent.push({ to, body }); },
    sleep: async () => {},
  });

  const contactId = '628700000001';
  const result = await processInboundMessage({
    contactId,
    messageBody: null,
    messageType: 'photo',
    mediaRef: 'file_abc123',
    timestamp: new Date('2026-09-03T00:00:00.000Z').toISOString(),
    channel: 'whatsapp_cloud_api',
  });

  // FR-1304: no scripted reply for the media itself -- and, since there's
  // no caption, START_FLOW's usual ack+Q1 (which decideNextAction() would
  // otherwise unconditionally queue for ANY first-ever message, media or
  // not) is suppressed too.
  assert.equal(result.decision.replies.length, 0, 'zero replies for a media-only first contact');
  assert.equal(sent.length, 0, 'nothing was actually sent via sendTextMessage either');

  const lead = leadsRepo.findByContact(contactId, 'whatsapp');
  assert.ok(lead, 'a new Lead row must exist even though the first message had no usable text');
  assert.equal(lead.contact_id, contactId);
  assert.equal(lead.channel, 'whatsapp');
  assert.equal(lead.question1_answer, null, 'no Q1/Q2 answers yet -- only the media note was captured');
  assert.equal(lead.needs_review, 1);
  assert.match(lead.additional_notes, /<media diterima: type=photo, ref=file_abc123>/);
  assert.match(lead.additional_notes, /^\[2026-09-03T00:00:00Z\]/);

  db.close();
});

test('TICKET-1305: an existing lead mid-flow sending a photo WITH a caption that matches a product runs the normal product-matching flow AND additively appends the media note', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const CATALOG = [
    { name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'kaos', 'baju kaos'] },
    { name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] },
  ];
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => { sent.push(body); },
    sleep: async () => {},
    products: CATALOG,
  });

  const contactId = '628700000002';
  await processInboundMessage({ contactId, messageBody: 'halo', messageType: 'text' });

  const result = await processInboundMessage({
    contactId,
    messageBody: 'Kaos Rimba Navy',
    messageType: 'photo',
    mediaRef: 'file_xyz789',
  });

  // The caption drives the normal ANSWER_Q1/product-matching flow,
  // completely unaffected by the media attachment riding alongside it.
  assert.equal(result.decision.action, 'ANSWER_Q1');
  assert.equal(result.decision.replies.length, 1, 'Q2 must still be sent -- caption handling is unaffected');
  assert.equal(result.decision.replies[0], TEST_CONFIG.questions[1].text);
  assert.match(sent.at(-1), /size \/ how should we contact you/i);

  const lead = leadsRepo.findByContact(contactId, 'whatsapp');
  assert.equal(lead.question1_answer, 'Kaos Rimba Navy');
  assert.equal(lead.matched_product, 'Kaos Rimba Navy', 'caption still drives fuzzy product matching');
  // FR-1304: the media note is ADDITIVE, appended alongside the normal
  // caption-driven flow above, not a replacement of it.
  assert.match(lead.additional_notes, /<media diterima: type=photo, ref=file_xyz789>/);

  db.close();
});

test('TICKET-1305: media capture is not gated on channel -- a WA (non-Telegram) contact sending a sticker gets the same treatment', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => { sent.push({ to, body }); },
    sleep: async () => {},
  });

  const contactId = '628700000003';
  const result = await processInboundMessage({
    contactId,
    messageBody: null,
    messageType: 'sticker',
    mediaRef: 'sticker_ref_1',
    channel: 'whatsapp_baileys', // explicitly WA, not Telegram
  });

  assert.equal(result.decision.replies.length, 0);
  assert.equal(sent.length, 0);

  const lead = leadsRepo.findByContact(contactId, 'whatsapp');
  assert.ok(lead);
  assert.equal(lead.channel, 'whatsapp');
  assert.equal(lead.needs_review, 1);
  assert.match(lead.additional_notes, /<media diterima: type=sticker, ref=sticker_ref_1>/);

  db.close();
});
