'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideNextAction,
  ACTIONS,
  buildQ1Message,
  parseNumberSelection,
  DEFAULT_Q1_LIST_INTRO,
  DEFAULT_Q1_LIST_INSTRUCTION,
  DEFAULT_RETRY_PREFIX,
} = require('../src/services/stateMachine');
const { createDb } = require('../src/db');
const { createLeadsRepo } = require('../src/services/leadsRepo');
const { createProductsRepo } = require('../src/services/productsRepo');
const { createInboundMessageProcessor } = require('../src/services/inboundMessageProcessor');

/**
 * docs/sdd/changes/2026-09-02-numbered-product-selection.md (FR-1001..FR-1006,
 * NFR-1001..NFR-1003): Q1's prompt becomes a dynamically-generated numbered
 * list of active products, and a reply that's a bare number deterministically
 * selects that exact product (no fuzzy matching involved -- NFR-1002). A
 * non-numeric reply still falls through to the existing, unmodified fuzzy
 * matcher (FR-1003).
 */

const CONFIG = {
  acknowledgment: 'This is an automated reply from Rimba Apparel...',
  questions: [
    { id: 'q1', text: 'Which product are you interested in?' },
    { id: 'q2', text: 'What size / how should we contact you?' },
  ],
  fallbackMessage: 'A team member will follow up with you shortly.',
  completionMessage: "Thanks! We've got what we need.",
};

const FOUR_PRODUCTS = [
  { id: 101, name: 'Kaos Rimba Navy', aliases: ['kaos navy'] },
  { id: 102, name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] },
  { id: 103, name: 'Celana Rimba Cargo', aliases: ['celana cargo'] },
  { id: 104, name: 'Jaket Rimba Outdoor', aliases: ['jaket outdoor'] },
];

// The snapshot decideNextAction() would have persisted (via
// shownProductIdsToPersist) after a prior turn actually sent Q1's
// numbered list built from FOUR_PRODUCTS -- see leadsRepo.js's
// updateShownProductIds()/schema.sql's shown_product_ids doc comment.
// Unit tests below that exercise the *answer* side of numbered selection
// set this explicitly on `existingLead`, mirroring what a real Lead row
// would actually contain by the time that reply arrives (HIGH-severity
// post-review fix: resolution must use this snapshot, never a fresh
// activeProducts re-query).
const FOUR_PRODUCTS_SHOWN_IDS = FOUR_PRODUCTS.map((p) => p.id);

function baseLead(overrides = {}) {
  return {
    id: 1,
    phone_number: '6281234567890',
    first_message_at: '2026-09-01T00:00:00.000Z',
    question1_answer: null,
    question2_answer: null,
    status: 'new',
    fallback_triggered: 0,
    retry_count: 0,
    shown_product_ids: null,
    ...overrides,
  };
}

// ======================================================================
// buildQ1Message() -- FR-1001/FR-1005/FR-1006
// ======================================================================

test('FR-1001/FR-1006: buildQ1Message renders a numbered list with default intro/instruction when config does not override them', () => {
  const msg = buildQ1Message(CONFIG, FOUR_PRODUCTS);
  assert.equal(
    msg,
    [
      DEFAULT_Q1_LIST_INTRO,
      '1. Kaos Rimba Navy',
      '2. Kaos Rimba Hitam',
      '3. Celana Rimba Cargo',
      '4. Jaket Rimba Outdoor',
      DEFAULT_Q1_LIST_INSTRUCTION,
    ].join('\n'),
  );
});

test('FR-1006: buildQ1Message uses config-supplied q1ListIntro/q1ListInstruction when provided', () => {
  const customConfig = { ...CONFIG, q1ListIntro: 'Pilih salah satu:', q1ListInstruction: 'Ketik nomornya.' };
  const msg = buildQ1Message(customConfig, FOUR_PRODUCTS);
  assert.equal(msg, ['Pilih salah satu:', '1. Kaos Rimba Navy', '2. Kaos Rimba Hitam', '3. Celana Rimba Cargo', '4. Jaket Rimba Outdoor', 'Ketik nomornya.'].join('\n'));
});

test('FR-1005: buildQ1Message falls back to the original static free-text prompt when activeProducts is empty', () => {
  assert.equal(buildQ1Message(CONFIG, []), CONFIG.questions[0].text);
});

test('FR-1005: buildQ1Message falls back to the original static free-text prompt when activeProducts is omitted', () => {
  assert.equal(buildQ1Message(CONFIG, undefined), CONFIG.questions[0].text);
});

// ======================================================================
// parseNumberSelection() -- FR-1002 tolerant parsing
// ======================================================================

test('FR-1002: parseNumberSelection resolves a bare number', () => {
  assert.equal(parseNumberSelection('2'), 2);
});

test('FR-1002: parseNumberSelection tolerates a leading "no "', () => {
  assert.equal(parseNumberSelection('no 2'), 2);
});

test('FR-1002: parseNumberSelection tolerates a leading "nomor "', () => {
  assert.equal(parseNumberSelection('nomor 2'), 2);
});

test('FR-1002: parseNumberSelection tolerates a trailing "."', () => {
  assert.equal(parseNumberSelection('2.'), 2);
});

test('FR-1002: parseNumberSelection tolerates a trailing filler word ("dong")', () => {
  assert.equal(parseNumberSelection('2 dong'), 2);
});

test('FR-1002: parseNumberSelection tolerates trailing "ya"/"nya" and combinations of leading+trailing wrapping', () => {
  assert.equal(parseNumberSelection('2 ya'), 2);
  assert.equal(parseNumberSelection('2 nya'), 2);
  assert.equal(parseNumberSelection('no 2 dong.'), 2);
  assert.equal(parseNumberSelection('  Nomor 3  '), 3);
});

test('FR-1003: parseNumberSelection returns null for free text (not a number at all)', () => {
  assert.equal(parseNumberSelection('Kaos Rimba Navy'), null);
  assert.equal(parseNumberSelection('ada kaos?'), null);
  assert.equal(parseNumberSelection('no worries'), null);
  assert.equal(parseNumberSelection(''), null);
  assert.equal(parseNumberSelection(null), null);
  assert.equal(parseNumberSelection(undefined), null);
});

// ======================================================================
// decideNextAction() -- FR-1001..FR-1005 wiring through the state machine
// ======================================================================

test('FR-1001: START_FLOW sends the numbered list (built from activeProducts), not the static Q1 text, when a catalog is active', () => {
  const result = decideNextAction({ existingLead: null, messageText: 'halo', config: CONFIG, activeProducts: FOUR_PRODUCTS });
  assert.equal(result.action, ACTIONS.START_FLOW);
  assert.equal(result.replies[0], CONFIG.acknowledgment);
  assert.equal(result.replies[1], buildQ1Message(CONFIG, FOUR_PRODUCTS));
  assert.match(result.replies[1], /^Ada beberapa pilihan nih kak:\n1\. Kaos Rimba Navy/);
  // HIGH-severity post-review fix: START_FLOW must also hand back the
  // exact ordered ID snapshot of what was just shown, for the caller to
  // persist (leadsRepo.updateShownProductIds()) -- this is what a later
  // numbered reply gets resolved against, never a fresh re-query.
  assert.deepEqual(result.shownProductIdsToPersist, FOUR_PRODUCTS.map((p) => p.id));
});

test('FR-1005: START_FLOW with no active catalog returns a null snapshot (nothing was shown to persist)', () => {
  const result = decideNextAction({ existingLead: null, messageText: 'halo', config: CONFIG, activeProducts: [] });
  assert.equal(result.shownProductIdsToPersist, null);
});

test('FR-1002/NFR-1002: an in-range numbered reply to Q1 deterministically resolves to that exact product, resolved against the SNAPSHOT', () => {
  // shown_product_ids is what a real Lead row would already contain by
  // this point (persisted when Q1 was originally sent) -- decideNextAction
  // resolves "2" against THIS, not a fresh activeProducts re-query.
  const lead = baseLead({ shown_product_ids: FOUR_PRODUCTS_SHOWN_IDS });
  const result = decideNextAction({ existingLead: lead, messageText: '2', config: CONFIG, activeProducts: FOUR_PRODUCTS });
  assert.equal(result.action, ACTIONS.ANSWER_Q1);
  assert.deepEqual(result.numberedProductMatch, FOUR_PRODUCTS[1]);
  assert.equal(result.numberedProductStale, false);
  assert.equal(result.leadPatch.question1Answer, '2');
  assert.deepEqual(result.replies, [CONFIG.questions[1].text], 'Q2 is still sent, same as any other accepted Q1 answer');
});

test('FR-1002: tolerant wrapping variants ("no 2", "2.", "2 dong") all resolve to the same product as a clean "2"', () => {
  for (const variant of ['2', 'no 2', '2.', '2 dong']) {
    const lead = baseLead({ shown_product_ids: FOUR_PRODUCTS_SHOWN_IDS });
    const result = decideNextAction({ existingLead: lead, messageText: variant, config: CONFIG, activeProducts: FOUR_PRODUCTS });
    assert.equal(result.action, ACTIONS.ANSWER_Q1, `variant "${variant}"`);
    assert.deepEqual(result.numberedProductMatch, FOUR_PRODUCTS[1], `variant "${variant}"`);
  }
});

test('FR-1003: a non-numeric Q1 reply leaves numberedProductMatch null (falls through to the fuzzy matcher downstream)', () => {
  const lead = baseLead({ shown_product_ids: FOUR_PRODUCTS_SHOWN_IDS });
  const result = decideNextAction({ existingLead: lead, messageText: 'ada kaos rimba navy?', config: CONFIG, activeProducts: FOUR_PRODUCTS });
  assert.equal(result.action, ACTIONS.ANSWER_Q1);
  assert.equal(result.numberedProductMatch, null);
  assert.equal(result.leadPatch.question1Answer, 'ada kaos rimba navy?');
});

test('FR-1004: an out-of-range number on the first attempt RETRYs with the same numbered list (not a distinct error path), and re-snapshots it', () => {
  const lead = baseLead({ shown_product_ids: FOUR_PRODUCTS_SHOWN_IDS });
  const result = decideNextAction({ existingLead: lead, messageText: '5', config: CONFIG, activeProducts: FOUR_PRODUCTS });
  assert.equal(result.action, ACTIONS.RETRY);
  assert.equal(result.replies[0], `${DEFAULT_RETRY_PREFIX}${buildQ1Message(CONFIG, FOUR_PRODUCTS)}`);
  assert.deepEqual(result.leadPatch, {
    question1Answer: null,
    question2Answer: null,
    fallbackTriggered: false,
    retryCount: 1,
  });
  // FR-1004: the retry re-shows Q1's list, so the snapshot is refreshed
  // too (here, identical to before since activeProducts didn't change
  // between this call and the last -- but the field must still be present
  // so a caller that DID see the catalog change re-persists correctly).
  assert.deepEqual(result.shownProductIdsToPersist, FOUR_PRODUCTS_SHOWN_IDS);
});

test('FR-1004: a second out-of-range number in a row (retry already used) FALLBACKs, same as any other structurally-unusable reply', () => {
  const lead = baseLead({ shown_product_ids: FOUR_PRODUCTS_SHOWN_IDS, retry_count: 1 });
  const result = decideNextAction({ existingLead: lead, messageText: '99', config: CONFIG, activeProducts: FOUR_PRODUCTS });
  assert.equal(result.action, ACTIONS.FALLBACK);
  assert.deepEqual(result.replies, [CONFIG.fallbackMessage]);
  assert.equal(result.leadPatch.fallbackTriggered, true);
});

test('FR-1004: an out-of-range number followed by a valid number still succeeds normally (retry does not poison the flow)', () => {
  const lead = baseLead({ shown_product_ids: FOUR_PRODUCTS_SHOWN_IDS, retry_count: 1 });
  const result = decideNextAction({ existingLead: lead, messageText: '1', config: CONFIG, activeProducts: FOUR_PRODUCTS });
  assert.equal(result.action, ACTIONS.ANSWER_Q1);
  assert.deepEqual(result.numberedProductMatch, FOUR_PRODUCTS[0]);
  assert.equal(result.leadPatch.retryCount, 0);
});

test('FR-1005: with an empty active catalog, no number-parsing is attempted at all -- a numeric-looking reply is treated as ordinary free text', () => {
  const lead = baseLead(); // shown_product_ids: null (default) -- nothing was ever snapshotted
  const result = decideNextAction({ existingLead: lead, messageText: '2', config: CONFIG, activeProducts: [] });
  assert.equal(result.action, ACTIONS.ANSWER_Q1, 'a digit string with no catalog to number against is just accepted as free text');
  assert.equal(result.numberedProductMatch, null);
  assert.equal(result.leadPatch.question1Answer, '2');
});

test('FR-1005: a numeric reply is treated as ordinary free text even with an active catalog, if this lead never actually had a snapshot (no shown_product_ids)', () => {
  // Guards against a caller regression where activeProducts is populated
  // but the Lead's own shown_product_ids was never set (e.g. a pre-existing
  // Lead from before this column existed) -- must not silently resolve a
  // number against a list this specific customer was never actually shown.
  const lead = baseLead({ shown_product_ids: null });
  const result = decideNextAction({ existingLead: lead, messageText: '2', config: CONFIG, activeProducts: FOUR_PRODUCTS });
  assert.equal(result.action, ACTIONS.ANSWER_Q1);
  assert.equal(result.numberedProductMatch, null);
  assert.equal(result.numberedProductStale, false);
  assert.equal(result.leadPatch.question1Answer, '2');
});

// ======================================================================
// HIGH-severity post-review fix: a numbered reply must resolve against the
// SNAPSHOT of what was actually shown, never a freshly re-queried active
// list -- reusing a fresh query reopens the exact FR-901 misrouting shape
// through a new mechanism (see stateMachine.js's header comment, judgment
// call 4, and schema.sql's shown_product_ids doc comment).
// ======================================================================

test('HIGH-severity fix: a product deactivated between Q1-send and the reply does NOT silently shift which product a position resolves to', () => {
  // Reproduces the reviewer's exact scenario: customer was shown 4 items
  // (1 Navy, 2 Hitam, 3 Cargo, 4 Outdoor per FOUR_PRODUCTS' own order --
  // the snapshot), then the OWNER deactivates item... in this case "Kaos
  // Rimba Hitam" (position 2) -- a DIFFERENT item than the one the
  // customer is about to pick. A fresh re-query at this point would be
  // [Navy, Cargo, Outdoor] (3 items), so position 3 in a FRESH query would
  // now be "Jaket Rimba Outdoor" -- NOT what the customer saw at position
  // 3 ("Celana Rimba Cargo") when the list was actually sent to them.
  const lead = baseLead({ shown_product_ids: FOUR_PRODUCTS_SHOWN_IDS });
  const freshActiveProductsAfterDeactivation = FOUR_PRODUCTS.filter((p) => p.name !== 'Kaos Rimba Hitam');

  const result = decideNextAction({
    existingLead: lead,
    messageText: '3', // customer means position 3 of what THEY saw: Celana Rimba Cargo
    config: CONFIG,
    activeProducts: freshActiveProductsAfterDeactivation,
  });

  assert.equal(result.action, ACTIONS.ANSWER_Q1);
  // Resolved via the snapshot to what the customer actually meant --
  // Celana Rimba Cargo -- which is STILL active (only Hitam was
  // deactivated), so this is a genuine, correct, confident match.
  assert.deepEqual(result.numberedProductMatch, FOUR_PRODUCTS[2], 'must resolve to Celana Rimba Cargo (what was actually at snapshot position 3)');
  assert.notDeepEqual(result.numberedProductMatch, FOUR_PRODUCTS[3], 'must NOT silently substitute Jaket Rimba Outdoor (what a fresh re-query would put at position 3)');
  assert.equal(result.numberedProductStale, false);
});

test('HIGH-severity fix: if the SPECIFIC product a numbered reply resolves to (via the snapshot) was itself deactivated, it is NOT a confident match and NOT silently substituted -- needs_review, not a wrong match', () => {
  const lead = baseLead({ shown_product_ids: FOUR_PRODUCTS_SHOWN_IDS });
  // This time the customer's own pick -- position 2, "Kaos Rimba Hitam" --
  // is the one that got deactivated in the interim.
  const freshActiveProductsAfterDeactivation = FOUR_PRODUCTS.filter((p) => p.name !== 'Kaos Rimba Hitam');

  const result = decideNextAction({
    existingLead: lead,
    messageText: '2', // customer means position 2 of what THEY saw: Kaos Rimba Hitam
    config: CONFIG,
    activeProducts: freshActiveProductsAfterDeactivation,
  });

  assert.equal(result.action, ACTIONS.ANSWER_Q1, 'still an ordinary accepted answer, not a retry/fallback -- FR-1004 out-of-range is a different case');
  assert.equal(result.numberedProductMatch, null, 'must NOT confidently match anything');
  assert.equal(result.numberedProductStale, true, 'flagged as stale -- the caller (inboundMessageProcessor.js) turns this into needs_review=true');
});

// ======================================================================
// End-to-end through createInboundMessageProcessor() + a real productsRepo
// ======================================================================

function buildProcessor({ leadsRepo, productsRepo, questionsConfig = CONFIG, sent }) {
  return createInboundMessageProcessor({
    leadsRepo,
    questionsConfig,
    sendTextMessage: async (to, body) => { sent.push(body); },
    sleep: async () => {},
    productsRepo,
  });
}

test('FR-1002/NFR-1002 end-to-end: replying "2" selects exactly the 2nd active product, score is exactly 1.0, needs_review is false', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);
  for (const p of FOUR_PRODUCTS) productsRepo.create(p);
  const sent = [];
  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo, sent });

  // productsRepo.listActive() orders alphabetically (COLLATE NOCASE), NOT
  // insertion order -- see productsRepo.js's listActiveStmt -- so position
  // 1 is "Celana Rimba Cargo" and position 2 is "Jaket Rimba Outdoor".
  const phone = '628501000001';
  const q1Result = await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  assert.match(q1Result.decision.replies[1], /^Ada beberapa pilihan nih kak:\n1\. Celana Rimba Cargo\n2\. Jaket Rimba Outdoor/);

  const answerResult = await processInboundMessage({ phoneNumber: phone, messageBody: '2', messageType: 'text' });
  assert.equal(answerResult.decision.action, 'ANSWER_Q1');
  assert.equal(answerResult.decision.replies.length, 1, 'Q2 must still be sent');

  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.matched_product, 'Jaket Rimba Outdoor');
  // NFR-1002: exactly 1.0, never a scored value. The real guarantee that
  // the fuzzy matcher never ran for this turn isn't a property of the
  // input text (a digit string happening to be unscoreable) -- it's
  // structural: inboundMessageProcessor.js's `if (decision.numberedProductMatch)
  // {...} else if (...) { matchProduct(...) }` is a literal mutual-exclusion
  // branch, so matchProduct() is simply never reached in the same code path
  // that just handled a numbered match, regardless of what the text was.
  assert.equal(lead.matched_product_score, 1.0);
  assert.equal(lead.needs_review, 0);

  db.close();
});

test('FR-1002 end-to-end: tolerant variants "no 2", "2.", "2 dong" all resolve to the same product as a clean "2"', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);
  for (const p of FOUR_PRODUCTS) productsRepo.create(p);
  const sent = [];
  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo, sent });

  let phoneCounter = 0;
  for (const variant of ['2', 'no 2', '2.', '2 dong']) {
    phoneCounter += 1;
    const phone = `62850200000${phoneCounter}`;
    await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
    await processInboundMessage({ phoneNumber: phone, messageBody: variant, messageType: 'text' });
    const lead = leadsRepo.findByPhone(phone);
    // Position 2 (alphabetical listActive() order) is "Jaket Rimba Outdoor" -- see the comment above.
    assert.equal(lead.matched_product, 'Jaket Rimba Outdoor', `variant "${variant}"`);
    assert.equal(lead.matched_product_score, 1.0, `variant "${variant}"`);
    assert.equal(lead.needs_review, 0, `variant "${variant}"`);
  }

  db.close();
});

test('FR-1004 end-to-end: an out-of-range number retries once then falls back, reusing the existing retry-then-fallback mechanism', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);
  for (const p of FOUR_PRODUCTS) productsRepo.create(p);
  const sent = [];
  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo, sent });

  const phone = '628503000001';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  const firstBad = await processInboundMessage({ phoneNumber: phone, messageBody: '5', messageType: 'text' });
  assert.equal(firstBad.decision.action, 'RETRY');
  let lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.retry_count, 1);
  assert.equal(lead.fallback_triggered, 0);

  const secondBad = await processInboundMessage({ phoneNumber: phone, messageBody: '99', messageType: 'text' });
  assert.equal(secondBad.decision.action, 'FALLBACK');
  lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.fallback_triggered, 1);
  assert.equal(lead.matched_product, null);

  db.close();
});

test('FR-1003 end-to-end: a non-numeric Q1 reply still falls through to the existing fuzzy matcher, unchanged', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);
  for (const p of FOUR_PRODUCTS) productsRepo.create(p);
  const sent = [];
  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo, sent });

  const phone = '628504000001';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  // Same clean-product-name scenario tests/productMatching.test.js already
  // covers for FR-503 -- proving the fuzzy fallback layer still behaves
  // identically when entered through this new numbered-list-aware path.
  const result = await processInboundMessage({ phoneNumber: phone, messageBody: 'Kaos Rimba Navy', messageType: 'text' });
  assert.equal(result.decision.action, 'ANSWER_Q1');
  assert.equal(result.decision.replies.length, 1, 'Q2 still sent on a confident fuzzy match');

  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.matched_product, 'Kaos Rimba Navy');
  assert.equal(lead.needs_review, 0);

  db.close();
});

test('FR-1005 end-to-end: zero active products falls back to the original free-text Q1 prompt and does not crash', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db); // never seeded -- zero products, active or otherwise
  const sent = [];
  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo, sent });

  const phone = '628505000001';
  const result = await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  assert.equal(result.decision.replies[1], CONFIG.questions[0].text);

  // FR-1005: with nothing to number against, a numeric-looking reply is
  // just an ordinary (unmatched, since the catalog is empty) free-text Q1
  // answer -- not treated as a numbered selection, and not a crash.
  const answer = await processInboundMessage({ phoneNumber: phone, messageBody: '2', messageType: 'text' });
  assert.equal(answer.decision.action, 'ANSWER_Q1');
  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.question1_answer, '2');
  assert.equal(lead.matched_product, null);
  assert.equal(lead.needs_review, 1, 'NFR-502: empty catalog always resolves to needs_review, never a crash');

  db.close();
});

test('NFR-1003 end-to-end (catalog freshness): deactivating a product between two customers removes it from the next customer\'s numbered list', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);
  for (const p of FOUR_PRODUCTS) productsRepo.create(p);
  const sent = [];
  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo, sent });

  // Customer A sees all 4 products (alphabetical listActive() order),
  // including Kaos Rimba Navy at position 4.
  const phoneA = '628506000001';
  const resultA = await processInboundMessage({ phoneNumber: phoneA, messageBody: 'halo', messageType: 'text' });
  assert.match(resultA.decision.replies[1], /4\. Kaos Rimba Navy/);
  assert.equal(resultA.decision.replies[1].split('\n').filter((line) => /^\d+\./.test(line)).length, 4);

  // Owner deactivates Kaos Rimba Navy via the dashboard (productsRepo.deactivate),
  // between customer A's and customer B's very first message.
  const navy = productsRepo.listAll().find((p) => p.name === 'Kaos Rimba Navy');
  productsRepo.deactivate(navy.id);

  // Customer B's numbered list must reflect the new, smaller active catalog --
  // 3 products, Navy no longer among them, positions renumbered.
  const phoneB = '628506000002';
  const resultB = await processInboundMessage({ phoneNumber: phoneB, messageBody: 'halo', messageType: 'text' });
  const q1LinesB = resultB.decision.replies[1].split('\n').filter((line) => /^\d+\./.test(line));
  assert.equal(q1LinesB.length, 3);
  assert.ok(!q1LinesB.some((line) => line.includes('Kaos Rimba Navy')), 'deactivated product must not appear in the list at all');
  assert.deepEqual(q1LinesB, ['1. Celana Rimba Cargo', '2. Jaket Rimba Outdoor', '3. Kaos Rimba Hitam']);

  // And a numbered reply for customer B resolves against THIS (post-deactivation) list.
  const answerB = await processInboundMessage({ phoneNumber: phoneB, messageBody: '1', messageType: 'text' });
  assert.equal(answerB.decision.action, 'ANSWER_Q1');
  const leadB = leadsRepo.findByPhone(phoneB);
  assert.equal(leadB.matched_product, 'Celana Rimba Cargo');

  db.close();
});

// ======================================================================
// HIGH-severity post-review fix, end-to-end reproduction: the reviewer's
// exact scenario -- a 4-item list is shown (1 Celana Rimba Cargo, 2 Jaket
// Rimba Outdoor, 3 Kaos Rimba Hitam, 4 Kaos Rimba Navy -- real
// productsRepo.listActive() alphabetical order), the OWNER deactivates
// item 2 (Jaket Rimba Outdoor) via the dashboard BETWEEN the list being
// sent and the customer's reply, and the customer replies "3" meaning
// what they actually saw at position 3 (Kaos Rimba Hitam). Before this
// fix, decideNextAction() re-queried productsRepo.listActive() fresh at
// answer-time -- with Jaket gone, that fresh list is [Cargo, Hitam, Navy],
// so position 3 in THAT list is Kaos Rimba Navy, not Hitam. The result was
// a confident, silent, WRONG match (matched_product="Kaos Rimba Navy",
// score=1.0, needs_review=false) -- worse than the original fuzzy-matcher
// bugs because it reported maximum confidence for a genuinely wrong
// product, and never touched guardAgainstInactiveFullCatalogWinner (the
// FR-901 fix) at all, since that path is skipped entirely for numbered
// selections.
// ======================================================================

test('HIGH-severity fix end-to-end: deactivating an UNRELATED item between Q1-send and the reply does not misroute the reply to a different product', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);
  for (const p of FOUR_PRODUCTS) productsRepo.create(p);
  const sent = [];
  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo, sent });

  const phone = '628507000001';
  const q1Result = await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });
  assert.deepEqual(
    q1Result.decision.replies[1].split('\n').filter((line) => /^\d+\./.test(line)),
    ['1. Celana Rimba Cargo', '2. Jaket Rimba Outdoor', '3. Kaos Rimba Hitam', '4. Kaos Rimba Navy'],
  );

  // Owner deactivates item 2 (Jaket Rimba Outdoor) -- NOT what the
  // customer is about to pick -- in the window between Q1-send and reply.
  const jaket = productsRepo.listAll().find((p) => p.name === 'Jaket Rimba Outdoor');
  productsRepo.deactivate(jaket.id);
  // Sanity: a FRESH re-query at this exact moment would put "Kaos Rimba
  // Navy" at position 3, not "Kaos Rimba Hitam" -- this is the trap a
  // fresh-query resolution used to fall into.
  assert.deepEqual(productsRepo.listActive().map((p) => p.name), ['Celana Rimba Cargo', 'Kaos Rimba Hitam', 'Kaos Rimba Navy']);

  const answerResult = await processInboundMessage({ phoneNumber: phone, messageBody: '3', messageType: 'text' });
  assert.equal(answerResult.decision.action, 'ANSWER_Q1');

  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.matched_product, 'Kaos Rimba Hitam', 'must resolve to what the customer actually saw at position 3, via the snapshot');
  assert.notEqual(lead.matched_product, 'Kaos Rimba Navy', 'must NOT silently substitute whatever a fresh re-query would put at position 3');
  assert.equal(lead.matched_product_score, 1.0, 'Kaos Rimba Hitam is still active, so this is a genuine confident match, not a downgrade');
  assert.equal(lead.needs_review, 0);

  db.close();
});

test('HIGH-severity fix end-to-end: deactivating the item the customer actually picked between Q1-send and the reply flags needs_review, never a confident wrong match', async () => {
  const db = createDb(':memory:');
  const leadsRepo = createLeadsRepo(db);
  const productsRepo = createProductsRepo(db);
  for (const p of FOUR_PRODUCTS) productsRepo.create(p);
  const sent = [];
  const { processInboundMessage } = buildProcessor({ leadsRepo, productsRepo, sent });

  const phone = '628507000002';
  await processInboundMessage({ phoneNumber: phone, messageBody: 'halo', messageType: 'text' });

  // This time the customer's OWN pick -- position 3, Kaos Rimba Hitam --
  // is the one that gets deactivated in the interim.
  const hitam = productsRepo.listAll().find((p) => p.name === 'Kaos Rimba Hitam');
  productsRepo.deactivate(hitam.id);

  const answerResult = await processInboundMessage({ phoneNumber: phone, messageBody: '3', messageType: 'text' });
  assert.equal(answerResult.decision.action, 'ANSWER_Q1', 'still an ordinary accepted answer, not a retry/fallback');
  assert.equal(answerResult.decision.replies.length, 0, 'Q2 must be suppressed, same as any other unmatched Q1 answer');

  const lead = leadsRepo.findByPhone(phone);
  assert.equal(lead.matched_product, null, 'must NOT confidently match ANY product');
  assert.notEqual(lead.matched_product, 'Kaos Rimba Navy', 'must NOT silently substitute whatever a fresh re-query would put at that position');
  assert.equal(lead.matched_product_score, null);
  assert.equal(lead.needs_review, 1, 'flagged for manual review instead of a silent wrong match');

  db.close();
});
