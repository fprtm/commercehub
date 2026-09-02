'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const { createLeadsRepo } = require('../src/services/leadsRepo');
const { createProductsRepo } = require('../src/services/productsRepo');
const { createInboundMessageProcessor } = require('../src/services/inboundMessageProcessor');
const { TEST_CONFIG } = require('./helpers/testApp');

/**
 * FR-901 (docs/sdd/changes/2026-09-02-fix-matching-safety-bugs.md, Bug 1,
 * safety-critical): a 15-customer adversarial simulation found that
 * deactivating a product can silently misroute a customer to a DIFFERENT
 * active product -- matching only ever scored the active-only pool, so
 * removing "Kaos Rimba Navy" from that pool let "Kaos Rimba Hitam" win a
 * confident match against text that actually names Navy (2 of Hitam's 3
 * name tokens -- "kaos", "rimba" -- still matched, clearing the default
 * threshold once Navy itself was no longer in the running to outscore it).
 *
 * The fix: whenever the active-only pool produces a confident match,
 * inboundMessageProcessor.js also scores the same text against the FULL
 * catalog (active + inactive). If the full catalog's own winner is
 * inactive, the result is forced to no-match/needs_review, regardless of
 * what the active-only pool said.
 *
 * These tests drive the REAL productsRepo (not a fixture array) and the
 * REAL processInboundMessage(), reproducing the exact bug scenario from
 * the change spec: deactivate "Kaos Rimba Navy" via productsRepo, then
 * send "kaos rimba navy ada?" through the processor.
 */

function buildProcessor({ leadsRepo, productsRepo }) {
  const sent = [];
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig: TEST_CONFIG,
    sendTextMessage: async (to, body) => {
      sent.push({ to, body });
    },
    sleep: async () => {},
    productsRepo,
  });
  return { processInboundMessage, sent };
}

test('FR-901: deactivating "Kaos Rimba Navy" then sending its exact name must NOT silently misroute to another active product', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);

  productsRepo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'baju kaos'] });
  productsRepo.create({ name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] });

  const navy = productsRepo.listAll().find((p) => p.name === 'Kaos Rimba Navy');
  productsRepo.deactivate(navy.id);

  // Sanity check: reproducing the exact bug mechanics. Against the
  // ACTIVE-ONLY pool alone (Hitam only), "kaos rimba navy ada?" scores
  // above threshold on Hitam's own name (2 of its 3 tokens -- "kaos",
  // "rimba" -- match) -- this is the raw defect the guard must override.
  const { matchProduct, DEFAULT_MATCH_THRESHOLD } = require('@rimba/product-matcher');
  const activeOnlyResult = matchProduct('kaos rimba navy ada?', productsRepo.listActive());
  assert.ok(
    activeOnlyResult.matched && activeOnlyResult.product.name === 'Kaos Rimba Hitam',
    `sanity check failed -- expected the active-only pool to (wrongly) match Hitam, got ${JSON.stringify(activeOnlyResult)}`,
  );
  assert.ok(activeOnlyResult.score >= DEFAULT_MATCH_THRESHOLD);

  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo });

  const phone = '628190000901';
  await processInboundMessage({ contactId: phone, messageBody: 'Halo', messageType: 'text', channel: 'whatsapp_baileys' });
  await processInboundMessage({
    contactId: phone,
    messageBody: 'kaos rimba navy ada?',
    messageType: 'text',
    channel: 'whatsapp_baileys',
  });

  const lead = leadsRepo.findByContact(phone, 'whatsapp');
  assert.equal(lead.matched_product, null, `must NOT confidently match anything, got ${lead.matched_product}`);
  assert.notEqual(lead.matched_product, 'Kaos Rimba Hitam', 'must specifically not be silently misrouted to Hitam');
  assert.equal(lead.needs_review, 1, 'needs_review must be true');

  db.close();
});

test('FR-901: the SAME text still matches confidently while the product is active (guard does not fire on healthy catalogs)', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);

  productsRepo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'baju kaos'] });
  productsRepo.create({ name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] });

  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo });

  const phone = '628190000902';
  await processInboundMessage({ contactId: phone, messageBody: 'Halo', messageType: 'text', channel: 'whatsapp_baileys' });
  await processInboundMessage({
    contactId: phone,
    messageBody: 'kaos rimba navy ada?',
    messageType: 'text',
    channel: 'whatsapp_baileys',
  });

  const lead = leadsRepo.findByContact(phone, 'whatsapp');
  assert.equal(lead.matched_product, 'Kaos Rimba Navy');
  assert.equal(lead.needs_review, 0);

  db.close();
});

test('FR-901: reactivating the product afterwards restores normal matching on the very next message', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);

  productsRepo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'baju kaos'] });
  productsRepo.create({ name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] });
  const navy = productsRepo.listAll().find((p) => p.name === 'Kaos Rimba Navy');
  productsRepo.deactivate(navy.id);
  productsRepo.activate(navy.id);

  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo });

  const phone = '628190000903';
  await processInboundMessage({ contactId: phone, messageBody: 'Halo', messageType: 'text', channel: 'whatsapp_baileys' });
  await processInboundMessage({
    contactId: phone,
    messageBody: 'kaos rimba navy ada?',
    messageType: 'text',
    channel: 'whatsapp_baileys',
  });

  const lead = leadsRepo.findByContact(phone, 'whatsapp');
  assert.equal(lead.matched_product, 'Kaos Rimba Navy');
  assert.equal(lead.needs_review, 0);

  db.close();
});

test('FR-901: the guard also applies to the post-completion (FR-802) re-match path, not just the Q1 path', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);

  productsRepo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'baju kaos'] });
  productsRepo.create({ name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] });

  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo });

  const phone = '628190000904';
  await processInboundMessage({ contactId: phone, messageBody: 'Halo', messageType: 'text', channel: 'whatsapp_baileys' });
  await processInboundMessage({ contactId: phone, messageBody: 'ada apa aja', messageType: 'text', channel: 'whatsapp_baileys' }); // vague Q1
  await processInboundMessage({ contactId: phone, messageBody: 'oke makasih', messageType: 'text', channel: 'whatsapp_baileys' }); // vague Q2, flow complete

  // Now deactivate Navy AFTER the flow is complete, then send a post-completion
  // message naming it -- the FR-802 re-match path must apply the same guard.
  const navy = productsRepo.listAll().find((p) => p.name === 'Kaos Rimba Navy');
  productsRepo.deactivate(navy.id);

  await processInboundMessage({
    contactId: phone,
    messageBody: 'eh btw kaos rimba navy ada?',
    messageType: 'text',
    channel: 'whatsapp_baileys',
  });

  const lead = leadsRepo.findByContact(phone, 'whatsapp');
  assert.notEqual(lead.matched_product, 'Kaos Rimba Hitam', 'post-completion re-match must also refuse to misroute to Hitam');

  db.close();
});
