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
  });

  // Shape webhook.js actually calls with (see src/routes/webhook.js's processMessage()).
  await processInboundMessage({
    phoneNumber: '628111111111',
    messageBody: 'halo, baju ini masih ada?',
    messageType: 'text',
    timestamp: new Date('2026-09-01T00:00:00.000Z').toISOString(),
    channel: 'whatsapp_cloud_api',
  });

  // Shape the Baileys connector actually calls with (see
  // src/services/baileysConnector.js's handleMessagesUpsert()) -- same
  // logical first-contact message, different channel/caller.
  await processInboundMessage({
    phoneNumber: '628222222222',
    messageBody: 'halo, baju ini masih ada?',
    messageType: 'text',
    timestamp: new Date('2026-09-01T00:00:01.000Z').toISOString(),
    channel: 'whatsapp_baileys',
  });

  const leadA = leadsRepo.findByPhone('628111111111');
  const leadB = leadsRepo.findByPhone('628222222222');

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
  });

  const phone = '628333333333';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text', channel: 'whatsapp_baileys' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Kaos Rimba Hitam', messageType: 'text', channel: 'whatsapp_baileys' });
  await processInboundMessage({ phoneNumber: phone, messageBody: 'Size L, WhatsApp aja', messageType: 'text', channel: 'whatsapp_baileys' });

  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.question1_answer, 'Kaos Rimba Hitam');
  assert.equal(lead.question2_answer, 'Size L, WhatsApp aja');
  assert.equal(lead.fallback_triggered, 0);

  db.close();
});
