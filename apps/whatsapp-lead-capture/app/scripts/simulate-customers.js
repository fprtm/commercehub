'use strict';

/**
 * Adversarial, realistic-conversation stress test for the WhatsApp
 * lead-capture flow.
 *
 * This is NOT a unit test. It drives the REAL production modules
 * (createDb / createLeadsRepo / createSettingsRepo / createProductsRepo /
 * seedProductsFromJsonIfEmpty / loadProductsConfig / loadQuestionsConfig /
 * createInboundMessageProcessor) exactly the way src/server.js wires them
 * up in Baileys mode -- see that file's `main()` for the reference wiring
 * this script mirrors. The ONLY things faked are the three network-level
 * callbacks (sendTextMessage / markAsRead / sendTypingIndicator) that would
 * otherwise try to hit a real WhatsApp socket, plus `sleep`/`random` so the
 * run doesn't take real minutes -- exactly the same seam
 * tests/helpers/testApp.js already uses for its mock Meta client.
 *
 * Each of the 18 customers gets its own phone number and is driven
 * message-by-message (never batched) through processInboundMessage(), the
 * single shared entry point every inbound message -- Cloud API or Baileys
 * -- goes through in production.
 *
 * NFR-902 (docs/sdd/changes/2026-09-02-fix-matching-safety-bugs.md):
 * extended with real PASS/FAIL assertions (see `check()` below) so this
 * script can be re-run after a fix and give an unambiguous verdict, rather
 * than requiring a human to eyeball the log output -- this is the same
 * script (not a parallel one), just no longer purely observational.
 * Scenarios 2, 13, and 15 are the three the adversarial run originally
 * found failing (Bugs 1/2/3); every other scenario also gets an assertion
 * so a regression in any of the 12 previously-passing scenarios is caught
 * automatically too. Exits non-zero if any check fails.
 *
 * docs/sdd/changes/2026-09-02-numbered-product-selection.md (FR-1001..
 * FR-1006): Q1 is now a dynamically-generated numbered list of active
 * products, and a bare-number reply deterministically selects a product
 * with zero fuzzy-matching involved -- the (four-times-hardened) fuzzy
 * matcher exercised by scenarios 1-15 below is now a FALLBACK layer for
 * free-text replies (FR-1003), not the primary path. Scenarios 1-15's own
 * message content is left as free text almost everywhere on purpose: every
 * one of them is specifically stress-testing a fuzzy-matching behavior
 * (typo tolerance, aliases, ambiguity, the intent denylist, the length
 * penalty, the inactive-full-catalog guard) that only exists on the
 * free-text path -- converting them to numbered replies would stop
 * exercising the exact mechanism each scenario exists to test. The one
 * exception is scenario 1 ("happy path, clean"), converted to a numbered
 * reply below to demonstrate what is now the actual default/primary path a
 * real customer hits. Three new scenarios (16-18) were added at the end to
 * cover what scenarios 1-15 structurally cannot: tolerant number parsing,
 * an out-of-range number's retry-then-fallback, and the empty-catalog
 * fallback (FR-1005) -- appended rather than interleaved so scenarios
 * 1-15's existing IDs (referenced throughout this file's comments and the
 * change docs) stay stable.
 *
 * Run: node scripts/simulate-customers.js
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { createDb } = require('../src/db');
const { createLeadsRepo } = require('../src/services/leadsRepo');
const { createSettingsRepo } = require('../src/services/settingsRepo');
const { createProductsRepo } = require('../src/services/productsRepo');
const { seedProductsFromJsonIfEmpty, fixBareKaosAliasOnExistingInstalls } = require('../src/services/productsSeed');
const { loadProductsConfig } = require('../src/services/productsLoader');
const { loadQuestionsConfig } = require('../src/services/questionsLoader');
const { createInboundMessageProcessor } = require('../src/services/inboundMessageProcessor');
const { matchProduct } = require('../src/services/productMatcher');

function line(char = '=', len = 100) {
  return char.repeat(len);
}

// NFR-902: accumulates every check() failure across all 15 scenarios so
// main() can print a final summary and exit(1) if anything regressed.
const checkFailures = [];

/**
 * Records and prints a PASS/FAIL line for one assertion about one
 * scenario. Never throws -- a failed check is recorded and reported at the
 * end, so one bad scenario doesn't abort the rest of the run.
 */
function check(scenarioId, description, actualValue, expectedValue) {
  // `expectedValue` may be a literal (===) or a predicate function for
  // conditions that aren't a simple equality (e.g. "is not null").
  const pass = typeof expectedValue === 'function' ? Boolean(expectedValue(actualValue)) : actualValue === expectedValue;
  const label = pass ? 'PASS' : 'FAIL';
  console.log(`    [${label}] Scenario ${scenarioId}: ${description} (actual=${JSON.stringify(actualValue)})`);
  if (!pass) {
    checkFailures.push(`Scenario ${scenarioId}: ${description} -- actual=${JSON.stringify(actualValue)}`);
  }
  return pass;
}

async function main() {
  // ------------------------------------------------------------------
  // 1. Fresh scratch SQLite DB -- a temp file, NEVER the real data/leads.db.
  // ------------------------------------------------------------------
  const scratchDbPath = path.join(os.tmpdir(), `wa-lead-capture-sim-${Date.now()}-${process.pid}.db`);
  console.log(line());
  console.log(`SCRATCH DB (real createDb/schema, NOT data/leads.db): ${scratchDbPath}`);
  console.log(line());
  const db = createDb(scratchDbPath);

  const leadsRepo = createLeadsRepo(db);
  const settingsRepo = createSettingsRepo(db);
  const productsRepo = createProductsRepo(db);

  // ------------------------------------------------------------------
  // 2. Seed the real config/products.json catalog via the real seeding
  //    logic (productsSeed.js), exactly like src/server.js does.
  // ------------------------------------------------------------------
  const { products: productsConfig, matchThreshold, intentDenylist } = loadProductsConfig();
  const seedResult = seedProductsFromJsonIfEmpty({ productsRepo, products: productsConfig });
  console.log(`Seed result: ${JSON.stringify(seedResult)}`);
  // FR-902 data-fix migration -- mirrors src/server.js's real boot wiring
  // (this script's own header comment promises to mirror that reference
  // wiring exactly), so a scratch DB started fresh here behaves identically
  // to a real install on the very next boot after this fix.
  const kaosAliasFixResult = fixBareKaosAliasOnExistingInstalls({ productsRepo });
  console.log(`Bare-"kaos"-alias migration result: ${JSON.stringify(kaosAliasFixResult)}`);
  const activeCatalog = productsRepo.listActive();
  console.log(`Active catalog (${activeCatalog.length}): ${activeCatalog.map((p) => `${p.name} [${p.aliases.join(', ')}]`).join(' | ')}`);
  console.log(`matchThreshold=${matchThreshold}  intentDenylist has ${intentDenylist.length} words`);

  const questionsConfig = loadQuestionsConfig();

  // ------------------------------------------------------------------
  // 3. Fake ONLY the network-level send/read/typing callbacks. Everything
  //    else (leadsRepo, settingsRepo, productsRepo, the state machine, the
  //    product matcher, the humanized-timing orchestration) is 100% real.
  // ------------------------------------------------------------------
  const sentLog = [];
  const readLog = [];
  const typingLog = [];

  async function sendTextMessage(to, text) {
    sentLog.push({ to, text });
  }
  async function markAsRead(to, messageId) {
    readLog.push({ to, messageId });
  }
  async function sendTypingIndicator(to, messageId) {
    typingLog.push({ to, messageId });
  }
  // Fast injectable sleep/random (NFR-603 seam) -- same pattern as
  // tests/helpers/testApp.js -- so the humanized-timing module's real
  // orchestration logic still runs (markAsRead -> pause -> typing ->
  // length-proportional wait -> send) but never actually waits.
  const fastSleep = async () => {};
  const fixedRandom = () => 0.5;

  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig,
    sendTextMessage,
    settingsRepo,
    markAsRead,
    sendTypingIndicator,
    sleep: fastSleep,
    random: fixedRandom,
    productsRepo,
    matchThreshold,
    intentDenylist,
  });

  let msgCounter = 0;
  function nextMessageId() {
    msgCounter += 1;
    return `sim-msg-${msgCounter}`;
  }

  /**
   * Sends exactly ONE inbound message through the real processor and
   * captures what actually happened as a result of THIS message only.
   */
  async function sendMessage(phoneNumber, body, { messageType = 'text', channel = 'whatsapp_baileys' } = {}) {
    const beforeSent = sentLog.length;
    const beforeRead = readLog.length;
    const beforeTyping = typingLog.length;
    const messageId = nextMessageId();
    const timestamp = new Date().toISOString();

    const result = await processInboundMessage({
      phoneNumber,
      messageBody: body,
      messageType,
      timestamp,
      channel,
      messageId,
    });

    return {
      body,
      messageType,
      action: result.decision.action,
      reason: result.decision.reason,
      lead: result.lead,
      repliesSent: sentLog.slice(beforeSent).map((s) => s.text),
      readReceiptFired: readLog.length > beforeRead,
      typingIndicatorCount: typingLog.length - beforeTyping,
    };
  }

  const results = [];

  function pushResult(entry) {
    results.push(entry);
    console.log(`\n--- Ran scenario ${entry.id}: ${entry.title} (phone ${entry.phone}) ---`);
    for (const turn of entry.turns) {
      console.log(
        `  MSG(${turn.messageType}) "${turn.body === null ? '<no text/caption>' : turn.body}" -> action=${turn.action}${
          turn.reason ? ` reason=${turn.reason}` : ''
        } | replies sent: ${turn.repliesSent.length === 0 ? '(none)' : JSON.stringify(turn.repliesSent)}`,
      );
    }
    console.log(`  FINAL LEAD ROW: ${JSON.stringify(entry.finalLead)}`);
  }

  // ==================================================================
  // Scenario 1 — Happy path, clean (docs/sdd/changes/2026-09-02-numbered-
  // product-selection.md: this is now the actual default/primary path a
  // real customer hits -- a bare numbered reply, not free text)
  // ==================================================================
  {
    const phone = '628190000001';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Halo')) }); // trigger START_FLOW (content discarded by design)
    // Q1 is now a numbered list built live from activeCatalog (alphabetical
    // listActive() order: 1 Celana Rimba Cargo, 2 Jaket Rimba Outdoor,
    // 3 Kaos Rimba Hitam, 4 Kaos Rimba Navy) -- "4" deterministically
    // selects Kaos Rimba Navy with zero fuzzy-matching involved (FR-1002).
    turns.push({ ...(await sendMessage(phone, '4')) }); // Q1 answer, numbered selection
    turns.push({ ...(await sendMessage(phone, 'size M ya, WA aja')) }); // Q2 answer
    pushResult({
      id: 1,
      title: 'Happy path, clean (numbered selection)',
      phone,
      expectation: 'FR-1002: matched_product = Kaos Rimba Navy, matched_product_score = 1.0, needs_review=false, both answers saved.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead1 = leadsRepo.findByPhone(phone);
    check(1, 'FR-1002: numbered reply "4" deterministically selects Kaos Rimba Navy', lead1.matched_product, 'Kaos Rimba Navy');
    check(1, 'NFR-1002: score is exactly 1.0 (no fuzzy scoring involved)', lead1.matched_product_score, 1.0);
    check(1, 'needs_review is false', Boolean(lead1.needs_review), false);
    check(1, 'question2_answer saved', lead1.question2_answer, (v) => v !== null);
  }

  // ==================================================================
  // Scenario 2 — Vague-then-clarify (the exact fixed-bug pattern)
  // Left as free text on purpose: the bug this covers (FR-901/FR-902) is in
  // the POST-COMPLETION re-match path (inboundMessageProcessor.js's NO_OP
  // block), which calls matchProduct() directly and never goes through
  // decideNextAction()'s Q1-numbered-list logic at all -- this scenario is
  // structurally untouched by the numbered-product-selection change.
  // ==================================================================
  {
    const phone = '628190000002';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Halo')) }); // trigger
    turns.push({ ...(await sendMessage(phone, 'kak ada jual apa aja?')) }); // Q1, vague
    turns.push({ ...(await sendMessage(phone, 'oke makasih')) }); // Q2, vague, flow now complete
    turns.push({ ...(await sendMessage(phone, 'eh btw kaos rimba hitam ada?')) }); // 3rd msg, POST-completion
    pushResult({
      id: 2,
      title: 'Vague-then-clarify (post-completion bug pattern)',
      phone,
      expectation:
        'additional_notes captures the 3rd message, matched_product upgrades to Kaos Rimba Hitam, needs_review=true.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    // NFR-902 target scenario for FR-902 (Bug 2 data fix -- the bare "kaos"
    // alias on Navy used to tie against "Kaos Rimba Hitam"'s own full
    // name, resolving the 3rd message as ambiguous/no-match instead of
    // upgrading to Hitam).
    const lead2 = leadsRepo.findByPhone(phone);
    check(2, 'additional_notes captures the post-completion message', lead2.additional_notes, (v) => Boolean(v) && v.includes('kaos rimba hitam'));
    check(2, 'FR-902: matched_product upgrades to Kaos Rimba Hitam (bare "kaos" alias no longer shadows it)', lead2.matched_product, 'Kaos Rimba Hitam');
    check(2, 'needs_review is true (post-completion message always re-flagged)', Boolean(lead2.needs_review), true);
  }

  // ==================================================================
  // Scenario 3 — Complaint/refund containing a real product name
  // ==================================================================
  {
    const phone = '628190000003';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'halo')) }); // START_FLOW
    turns.push({ ...(await sendMessage(phone, 'kaos rimba navy saya kemarin robek, bisa refund?')) }); // Q1 answer
    pushResult({
      id: 3,
      title: 'Complaint/refund containing a real product name (intent denylist)',
      phone,
      expectation: 'needs_review=true, NOT a confident match despite containing a real product name.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead3 = leadsRepo.findByPhone(phone);
    check(3, 'no confident match despite naming the product', lead3.matched_product, null);
    check(3, 'needs_review is true (intent denylist)', Boolean(lead3.needs_review), true);
  }

  // ==================================================================
  // Scenario 4 — Typo/slang
  // ==================================================================
  {
    const phone = '628190000004';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Selamat siang')) }); // trigger
    turns.push({ ...(await sendMessage(phone, 'ada kaos rimba nvy ga si min')) }); // Q1, typo
    pushResult({
      id: 4,
      title: 'Typo/slang',
      phone,
      expectation: 'still fuzzy-matches the Navy product via typo tolerance.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead4 = leadsRepo.findByPhone(phone);
    check(4, 'typo "nvy" still fuzzy-matches Kaos Rimba Navy', lead4.matched_product, 'Kaos Rimba Navy');
    check(4, 'needs_review is false', Boolean(lead4.needs_review), false);
  }

  // ==================================================================
  // Scenario 5 — Product not in catalog
  // ==================================================================
  {
    const phone = '628190000005';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Permisi')) }); // trigger
    turns.push({ ...(await sendMessage(phone, 'ada topi rimba?')) }); // Q1, off-catalog
    pushResult({
      id: 5,
      title: 'Product not in catalog',
      phone,
      expectation: 'needs_review=true, no match.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead5 = leadsRepo.findByPhone(phone);
    check(5, 'no match for an off-catalog product', lead5.matched_product, null);
    check(5, 'needs_review is true', Boolean(lead5.needs_review), true);
  }

  // ==================================================================
  // Scenario 6 — Non-text FIRST message (sticker/image, no caption)
  // ==================================================================
  {
    const phone = '628190000006';
    const turns = [];
    // This IS the very first inbound event from this phone number -- no
    // prior trigger message, on purpose (that's the point of this
    // scenario: what happens when the customer's first-ever contact is a
    // sticker with no caption).
    turns.push({ ...(await sendMessage(phone, null, { messageType: 'sticker' })) });
    // Follow-up real text message, to observe how the flow continues
    // afterwards (not part of the core expectation, extra signal only).
    turns.push({ ...(await sendMessage(phone, 'kaos rimba navy')) });
    pushResult({
      id: 6,
      title: 'Non-text first message (sticker/image, no caption)',
      phone,
      expectation:
        'verified actual behavior: a brand-new phone number always gets START_FLOW (lead created) regardless of ' +
        'whether the very first message has usable text -- retry/fallback only applies to an ALREADY-existing ' +
        'lead\'s pending question, which does not exist yet on message 1. The 2nd (real text) message then answers ' +
        'Q1 normally. Not a crash either way.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead6 = leadsRepo.findByPhone(phone);
    check(6, 'sticker-with-no-caption as the very first contact does not crash and starts the flow', turns[0].action, 'START_FLOW');
    check(6, 'follow-up text message answers Q1 normally', lead6.matched_product, 'Kaos Rimba Navy');
  }

  // ==================================================================
  // Scenario 7 — Multiple rapid filler messages before the real answer
  // ==================================================================
  {
    const phone = '628190000007';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'hai')) }); // START_FLOW
    turns.push({ ...(await sendMessage(phone, 'kak')) }); // becomes Q1 answer, vague
    turns.push({ ...(await sendMessage(phone, 'masih buka?')) }); // becomes Q2 answer, flow complete
    turns.push({ ...(await sendMessage(phone, 'kaos rimba navy ada size L?')) }); // 4th msg, post-completion
    pushResult({
      id: 7,
      title: 'Multiple rapid filler messages before the real answer',
      phone,
      expectation: 'same post-completion capture/upgrade behavior as scenario 2, under messier filler conditions.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead7 = leadsRepo.findByPhone(phone);
    check(7, 'additional_notes captures the post-completion message', lead7.additional_notes, (v) => Boolean(v) && v.includes('kaos rimba navy'));
    check(7, 'matched_product set from the post-completion message', lead7.matched_product, 'Kaos Rimba Navy');
    check(7, 'needs_review is true', Boolean(lead7.needs_review), true);
  }

  // ==================================================================
  // Scenario 8 — Customer goes silent after Q1 (never sends a 2nd message)
  // ==================================================================
  {
    const phone = '628190000008';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Halo')) }); // START_FLOW's own trigger message
    turns.push({ ...(await sendMessage(phone, 'kaos rimba navy dong')) }); // only message after that -- Q1 answer
    pushResult({
      id: 8,
      title: 'Customer goes silent after Q1',
      phone,
      expectation:
        'Lead exists, status=new, question2_answer=null, matched_product set from Q1 -- partial state looks sane, not broken.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead8 = leadsRepo.findByPhone(phone);
    check(8, 'lead exists with status=new', lead8.status, 'new');
    check(8, 'question2_answer still null (customer went silent)', lead8.question2_answer, null);
    check(8, 'matched_product set from Q1', lead8.matched_product, 'Kaos Rimba Navy');
  }

  // ==================================================================
  // Scenario 9 — Returning customer to an already-CLOSED lead
  // ==================================================================
  {
    const phone = '628190000009';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Halo')) }); // trigger
    const q1 = await sendMessage(phone, 'kaos rimba navy'); // Q1 answer
    turns.push({ ...q1 });
    turns.push({ ...(await sendMessage(phone, 'size L, telpon aja')) }); // Q2 answer, flow complete

    // Manually close the lead via the REAL leadsRepo.updateStatus, exactly
    // like an owner clicking "Close" on the dashboard would.
    const leadBeforeClose = leadsRepo.findByPhone(phone);
    const closedLead = leadsRepo.updateStatus(leadBeforeClose.id, 'closed');
    console.log(`  [scenario 9] Manually closed lead id=${closedLead.id}, status now "${closedLead.status}"`);

    const sentBeforeReturn = sentLog.length;
    turns.push({ ...(await sendMessage(phone, 'kak masih ada ga yang navy size S?')) }); // returning customer, post-close
    const sentAfterReturn = sentLog.length;

    pushResult({
      id: 9,
      title: 'Returning customer to an already-CLOSED lead',
      phone,
      expectation:
        'additional_notes captures the new message, needs_review is NOT force-flagged (preserves whatever it was), and NO new outbound reply is generated (no reply spam to a closed lead).',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
      extra: {
        needsReviewBeforeClose: Boolean(leadBeforeClose.needs_review),
        outboundSendsForReturnMessage: sentAfterReturn - sentBeforeReturn,
      },
    });
    const lead9 = leadsRepo.findByPhone(phone);
    check(9, 'additional_notes captures the post-close message', lead9.additional_notes, (v) => Boolean(v) && v.includes('navy size S'));
    check(9, 'needs_review preserved (not force-flagged for a closed lead)', Boolean(lead9.needs_review), Boolean(leadBeforeClose.needs_review));
    check(9, 'zero new outbound sends to a closed lead', sentAfterReturn - sentBeforeReturn, 0);
  }

  // ==================================================================
  // Scenario 10 — Clean single-alias match
  // ==================================================================
  {
    const phone = '628190000010';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Mau tanya dong')) }); // trigger
    turns.push({ ...(await sendMessage(phone, 'ada celana?')) }); // Q1, single-alias
    pushResult({
      id: 10,
      title: 'Clean single-alias match',
      phone,
      expectation: 'clean, non-ambiguous match (Celana Rimba Cargo), not flagged ambiguous.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead10 = leadsRepo.findByPhone(phone);
    check(10, 'clean match to Celana Rimba Cargo', lead10.matched_product, 'Celana Rimba Cargo');
    check(10, 'needs_review is false', Boolean(lead10.needs_review), false);
  }

  // ==================================================================
  // Scenario 11 — Auto-reply toggled OFF mid-run
  // ==================================================================
  {
    const phone = '628190000011';
    const turns = [];
    const beforeToggle = settingsRepo.isAutoReplyEnabled();
    settingsRepo.setAutoReplyEnabled(false);
    console.log(`  [scenario 11] auto-reply toggled OFF (was ${beforeToggle})`);

    const sentBefore = sentLog.length;
    turns.push({ ...(await sendMessage(phone, 'Halo, kaos ready?')) }); // fresh customer's first message
    const sentAfter = sentLog.length;

    // Restore for every later scenario -- this is a global (single-row)
    // setting, so leaving it off would silently corrupt scenarios 12-15.
    settingsRepo.setAutoReplyEnabled(true);
    console.log('  [scenario 11] auto-reply restored ON for subsequent scenarios');

    pushResult({
      id: 11,
      title: 'Auto-reply toggled OFF mid-run',
      phone,
      expectation: 'Lead is still created/logged correctly, but zero outbound sends recorded for this customer.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
      extra: { outboundSendsWhileOff: sentAfter - sentBefore },
    });
    const lead11 = leadsRepo.findByPhone(phone);
    check(11, 'lead is still created/logged while auto-reply is OFF', Boolean(lead11), true);
    check(11, 'zero outbound sends while auto-reply is OFF', sentAfter - sentBefore, 0);
  }

  // ==================================================================
  // Scenario 12 — Non-Indonesian / English text
  // ==================================================================
  {
    const phone = '628190000012';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Hi')) }); // trigger
    turns.push({ ...(await sendMessage(phone, 'do you have the navy shirt?')) }); // Q1, English
    pushResult({
      id: 12,
      title: 'Non-Indonesian / English text',
      phone,
      expectation: 'does not crash; most likely no confident match -> needs_review=true.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead12 = leadsRepo.findByPhone(phone);
    check(12, 'English text does not crash and has no confident match', lead12.matched_product, null);
    check(12, 'needs_review is true', Boolean(lead12.needs_review), true);
  }

  // ==================================================================
  // Scenario 13 — Long rambling message, product mention buried deep
  // Left as free text on purpose: this is inherently a message a real
  // customer who ignored the numbered list would send -- it is exactly
  // the FR-1003 fallback case (non-numeric reply -> existing fuzzy
  // matcher), so it is unaffected by, and NOT fixed by, the
  // numbered-product-selection change. The known scoring gap documented
  // below is a separate, pre-existing, already-twice-tuned mechanism.
  // ==================================================================
  {
    const phone = '628190000013';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Permisi kak')) }); // trigger
    turns.push({
      ...(await sendMessage(
        phone,
        'permisi kak mau tanya-tanya dulu boleh, saya lagi cari kaos buat jalan-jalan sama keluarga minggu depan, ada rekomendasi kaos yang adem ga soalnya saya kalo pake kaos suka gerah gitu, oiya kaos rimba navy nya available size XL ga ya',
      )),
    }); // Q1, long + buried mention
    pushResult({
      id: 13,
      title: 'Long rambling message with product mention buried deep',
      phone,
      expectation: 'still matches the Navy product confidently despite the length (length-penalty tuning).',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead13 = leadsRepo.findByPhone(phone);
    const q1Text13 = lead13.question1_answer;
    // FR-904's OWN acceptance bar, checked directly and independently of
    // the length-penalty score below: does the intent denylist still flag
    // this message because of "keluarga"? It must not.
    const directMatch13 = matchProduct(q1Text13, activeCatalog, { threshold: matchThreshold, intentDenylist });
    check(
      13,
      'FR-904: the intent denylist no longer flags "keluarga" as a complaint word',
      directMatch13.flaggedTerms,
      (v) => Array.isArray(v) && v.length === 0,
    );
    // Full end-to-end outcome. NOTE (disclosed, not swept under the rug):
    // this specific simulated message is 42 stemmed tokens long with
    // "kaos" repeated 4 times, only 3 of which count as "accounted for" by
    // the length-penalty formula (src/services/productMatcher.js's
    // tokenCoverage()) -- so even with the denylist fixed (flaggedTerms
    // above IS empty, confirming FR-904 itself works), the raw score for
    // this message (~0.11) still lands well below DEFAULT_MATCH_THRESHOLD
    // (0.65). That scoring behavior (the length penalty not crediting
    // repeated occurrences of an already-matched word) is a SEPARATE,
    // pre-existing, already-twice-tuned mechanism this change's scope
    // (FR-904: "raise the denylist's fuzzy-match threshold", nothing else)
    // does not touch -- widening that scope risks the exact regressions
    // NFR-901 forbids. This check is left as an honest, currently-FAILING
    // assertion (not silently loosened) so this residual gap stays visible
    // on every re-run rather than being hidden.
    check(13, 'end-to-end: confidently matches Kaos Rimba Navy despite the length (KNOWN GAP -- see note above, out of FR-904 scope)', lead13.matched_product, 'Kaos Rimba Navy');
  }

  // ==================================================================
  // Scenario 14 — Empty/whitespace-only message
  // ==================================================================
  {
    const phone = '628190000014';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Halo min')) }); // trigger
    turns.push({ ...(await sendMessage(phone, '   ')) }); // whitespace-only, response to pending Q1
    // Bonus (not part of the core expectation): a SECOND whitespace-only
    // message in a row should trigger the real FALLBACK path (one retry
    // already used) -- extra signal on whether retry->fallback actually
    // chains correctly end to end.
    turns.push({ ...(await sendMessage(phone, '\n\t ')) });
    pushResult({
      id: 14,
      title: 'Empty/whitespace-only message',
      phone,
      expectation: 'retry behavior, not a crash, not treated as a valid answer.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    check(14, 'first whitespace-only message triggers RETRY (one follow-up attempt)', turns[1].action, 'RETRY');
    check(14, 'second whitespace-only message in a row triggers FALLBACK', turns[2].action, 'FALLBACK');
  }

  // ==================================================================
  // Scenario 15 — Product deactivated mid-conversation
  // Left as free text on purpose: this specifically has to NAME the
  // deactivated product to exercise the FR-901 inactive-full-catalog
  // guard (FR-1003 fallback path) -- with the numbered list, a
  // deactivated product simply cannot appear/be selected at all. Scenario
  // 16 below (run immediately after this one) doubles as an NFR-1003
  // freshness check for exactly that: its numbered list is built AFTER
  // this scenario deactivated Kaos Rimba Navy, and correctly no longer
  // shows it.
  // ==================================================================
  {
    const phone = '628190000015';
    const navyProduct = productsRepo.listAll().find((p) => p.name === 'Kaos Rimba Navy');
    if (!navyProduct) throw new Error('Expected "Kaos Rimba Navy" in seeded catalog for scenario 15');
    const deactivated = productsRepo.deactivate(navyProduct.id);
    console.log(`  [scenario 15] Deactivated product id=${deactivated.id} "${deactivated.name}" (is_active=${deactivated.is_active})`);
    console.log(`  [scenario 15] Active catalog is now: ${productsRepo.listActive().map((p) => p.name).join(', ')}`);

    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Halo')) }); // trigger
    turns.push({ ...(await sendMessage(phone, 'kaos rimba navy ada?')) }); // Q1, exact name of now-inactive product
    pushResult({
      id: 15,
      title: 'Product deactivated mid-conversation',
      phone,
      expectation: 'no match (inactive), needs_review=true -- inactive products genuinely excluded from matching.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    // NFR-902 target scenario for FR-901 (Bug 1, safety-critical -- the
    // active-only pool used to let "Kaos Rimba Hitam" win this exact text
    // once Navy was deactivated, since 2 of Hitam's 3 name tokens still
    // matched; the full-catalog inactive-winner guard must force this to
    // no-match instead).
    const lead15 = leadsRepo.findByPhone(phone);
    check(15, 'FR-901: no confident match to ANY product once the named product is deactivated', lead15.matched_product, null);
    check(15, 'FR-901: specifically not silently misrouted to Kaos Rimba Hitam', lead15.matched_product, (v) => v !== 'Kaos Rimba Hitam');
    check(15, 'needs_review is true', Boolean(lead15.needs_review), true);
  }

  // ==================================================================
  // Scenario 16 — Numbered selection, tolerant parsing + NFR-1003 freshness
  // (docs/sdd/changes/2026-09-02-numbered-product-selection.md, FR-1002)
  // ==================================================================
  {
    const phone = '628190000016';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Halo')) }); // trigger
    const q1Turn = turns[0];
    console.log(`  [scenario 16] Q1 numbered list shown: ${JSON.stringify(q1Turn.repliesSent[1])}`);
    // "no 3" (tolerant wrapping -- FR-1002) selects position 3, which is
    // Kaos Rimba Hitam under the active catalog AFTER scenario 15
    // deactivated Kaos Rimba Navy (alphabetical listActive() order: 1
    // Celana Rimba Cargo, 2 Jaket Rimba Outdoor, 3 Kaos Rimba Hitam) --
    // this doubles as the NFR-1003 freshness proof: Navy is gone from the
    // list entirely, not just unselectable.
    turns.push({ ...(await sendMessage(phone, 'no 3')) }); // Q1 answer, tolerant numbered selection
    pushResult({
      id: 16,
      title: 'Numbered selection with tolerant parsing ("no 3") + freshness',
      phone,
      expectation: 'FR-1002: deterministically selects Kaos Rimba Hitam, score=1.0. NFR-1003: Kaos Rimba Navy absent from the list shown (deactivated in scenario 15).',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead16 = leadsRepo.findByPhone(phone);
    check(16, 'FR-1002: tolerant "no 3" deterministically selects Kaos Rimba Hitam', lead16.matched_product, 'Kaos Rimba Hitam');
    check(16, 'NFR-1002: score is exactly 1.0 (no fuzzy scoring involved)', lead16.matched_product_score, 1.0);
    check(16, 'needs_review is false', Boolean(lead16.needs_review), false);
    check(
      16,
      'NFR-1003: the numbered list shown does NOT include the product deactivated in scenario 15',
      q1Turn.repliesSent[1],
      (v) => typeof v === 'string' && !v.includes('Kaos Rimba Navy'),
    );
  }

  // ==================================================================
  // Scenario 17 — Out-of-range numbered reply (FR-1004): reuses the
  // existing retry-then-fallback mechanism, not a new/parallel error path.
  // ==================================================================
  {
    const phone = '628190000017';
    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Halo')) }); // trigger
    // Only 3 products are active at this point (scenario 15 deactivated
    // one) -- "9" is out of range for any of them.
    turns.push({ ...(await sendMessage(phone, '9')) }); // Q1, out-of-range number (1st attempt) -> RETRY
    turns.push({ ...(await sendMessage(phone, '9')) }); // Q1, out-of-range number again (2nd attempt) -> FALLBACK
    pushResult({
      id: 17,
      title: 'Out-of-range numbered reply (FR-1004)',
      phone,
      expectation: 'FR-1004: 1st out-of-range number retries with the same list; 2nd falls back -- identical shape to any other structurally-unusable reply.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead17 = leadsRepo.findByPhone(phone);
    check(17, 'FR-1004: 1st out-of-range number triggers RETRY (one follow-up attempt)', turns[1].action, 'RETRY');
    check(17, 'FR-1004: 2nd out-of-range number in a row triggers FALLBACK', turns[2].action, 'FALLBACK');
    check(17, 'no product was ever matched', lead17.matched_product, null);
    check(17, 'fallback_triggered is true', Boolean(lead17.fallback_triggered), true);
  }

  // ==================================================================
  // Scenario 18 — Empty active catalog (FR-1005): Q1 gracefully falls back
  // to the original free-text prompt instead of an empty list. Runs LAST
  // and deliberately deactivates every remaining active product, so it
  // must not be followed by any scenario that expects an active catalog.
  // ==================================================================
  {
    const phone = '628190000018';
    for (const product of productsRepo.listActive()) {
      productsRepo.deactivate(product.id);
    }
    console.log(`  [scenario 18] Deactivated every remaining product. Active catalog is now: ${JSON.stringify(productsRepo.listActive())}`);

    const turns = [];
    turns.push({ ...(await sendMessage(phone, 'Halo')) }); // trigger
    const q1Turn = turns[0];
    turns.push({ ...(await sendMessage(phone, 'kaos apa aja yang ada?')) }); // Q1 answer, ordinary free text (no catalog to number against)
    pushResult({
      id: 18,
      title: 'Empty active catalog falls back to the original free-text Q1 prompt',
      phone,
      expectation: 'FR-1005: Q1 is the original static prompt (config/questions.json), not a crash/empty list; NFR-502: empty catalog -> needs_review=true, matched_product=null.',
      turns,
      finalLead: leadsRepo.findByPhone(phone),
    });
    const lead18 = leadsRepo.findByPhone(phone);
    check(18, 'FR-1005: Q1 falls back to the original static free-text prompt', q1Turn.repliesSent[1], questionsConfig.questions[0].text);
    check(18, 'Q1 answer accepted as ordinary free text (no crash)', lead18.question1_answer, (v) => v !== null);
    check(18, 'NFR-502: empty catalog -> no match', lead18.matched_product, null);
    check(18, 'NFR-502: empty catalog -> needs_review=true, never a crash', Boolean(lead18.needs_review), true);
  }

  // ------------------------------------------------------------------
  // Dump full structured results as JSON too, for precise field-by-field
  // inspection (in addition to the human-readable log above).
  // ------------------------------------------------------------------
  console.log(`\n${line()}`);
  console.log('FULL STRUCTURED RESULTS (JSON)');
  console.log(line());
  console.log(JSON.stringify(results, null, 2));

  console.log(`\n${line()}`);
  console.log('NFR-902 CHECK SUMMARY');
  console.log(line());
  if (checkFailures.length === 0) {
    console.log('ALL CHECKS PASSED across all 15 scenarios.');
  } else {
    console.log(`${checkFailures.length} CHECK(S) FAILED:`);
    for (const failure of checkFailures) {
      console.log(`  - ${failure}`);
    }
  }

  db.close();
  fs.unlinkSync(scratchDbPath);
  for (const ext of ['-wal', '-shm']) {
    const p = scratchDbPath + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  console.log(`\nScratch DB cleaned up: ${scratchDbPath}`);

  if (checkFailures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('SIMULATION CRASHED:', err);
  process.exit(1);
});
