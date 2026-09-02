'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchProduct,
  normalizeAndStemToTokens,
  findIntentDenylistHits,
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_INTENT_DENYLIST,
  DENYLIST_FUZZY_MATCH_THRESHOLD,
} = require('../src/productMatcher');
const natural = require('natural');

/**
 * FR-502 (docs/sdd/changes/2026-09-01-fuzzy-product-matching.md):
 * "an exact or near-exact product name match scores high; unrelated text
 * (e.g., 'toko buka jam berapa') scores low" -- these tests prove exactly
 * that acceptance bar directly against the matcher, in isolation, with
 * realistic Bahasa Indonesia customer text.
 *
 * The demo catalog below mirrors config/products.json (Rimba Apparel's
 * real product list) but is defined locally so this file doesn't silently
 * start failing if someone edits the shipped config -- see
 * tests/productsLoader.test.js for coverage of loading the real file.
 */
const CATALOG = [
  { name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'kaos', 'baju kaos'] },
  { name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] },
  { name: 'Celana Rimba Cargo', aliases: ['celana cargo', 'celana'] },
  { name: 'Jaket Rimba Outdoor', aliases: ['jaket', 'jaket outdoor'] },
];

test('FR-502: an exact product name match scores at/above the default threshold', () => {
  const result = matchProduct('Kaos Rimba Navy', CATALOG);
  assert.equal(result.matched, true);
  assert.equal(result.product.name, 'Kaos Rimba Navy');
  assert.ok(result.score >= DEFAULT_MATCH_THRESHOLD, `expected score >= ${DEFAULT_MATCH_THRESHOLD}, got ${result.score}`);
  assert.ok(result.score >= 0.95, `expected a near-1.0 score for an exact match, got ${result.score}`);
});

test('FR-502: a stemmed/inflected variant ("kaosnya ada?") matches via Indonesian stemming + alias, scoring high', () => {
  const result = matchProduct('kaosnya ada?', CATALOG);
  assert.equal(result.matched, true, `expected a match, got score ${result.score}`);
  assert.equal(result.product.name, 'Kaos Rimba Navy');
  assert.ok(result.score >= DEFAULT_MATCH_THRESHOLD);
});

test('FR-502: other inflected forms of the same root ("membeli kaos", "dibeli kaos nya") also match, proving stemming (not luck)', () => {
  for (const text of ['membeli kaos', 'dibeli kaos nya', 'mau beli kaos']) {
    const result = matchProduct(text, CATALOG);
    assert.equal(result.matched, true, `"${text}" should match (score ${result.score})`);
    assert.equal(result.product.name, 'Kaos Rimba Navy');
  }
});

test('FR-502: a specific full-name mention resolves to the SPECIFIC product, not an ambiguous generic-alias sibling', () => {
  // Both "Kaos Rimba Navy" (alias "kaos") and "Kaos Rimba Hitam" could
  // superficially tie on the generic "kaos" token -- this proves the
  // tie-break-by-specificity logic picks the actually-named product.
  const result = matchProduct('saya mau beli Kaos Rimba Hitam ukuran L', CATALOG);
  assert.equal(result.matched, true);
  assert.equal(result.product.name, 'Kaos Rimba Hitam');
});

test('FR-502: a clearly unrelated question ("toko buka jam berapa?") scores low / no match', () => {
  const result = matchProduct('toko buka jam berapa?', CATALOG);
  assert.equal(result.matched, false);
  assert.equal(result.product, null);
  assert.ok(result.score < DEFAULT_MATCH_THRESHOLD, `expected a low score, got ${result.score}`);
});

test('FR-502: other unrelated/off-topic messages also score low / no match', () => {
  for (const text of ['apakah ada promo hari ini', 'mau tanya soal ongkir dong', 'min, ini nomor cs ya?']) {
    const result = matchProduct(text, CATALOG);
    assert.equal(result.matched, false, `"${text}" should NOT match (got score ${result.score}, product ${result.product?.name})`);
  }
});

test('a minor typo ("kaus" for "kaos") still matches -- Jaro-Winkler tolerance, not just exact stemming', () => {
  const result = matchProduct('kaus rimba navy dong', CATALOG);
  assert.equal(result.matched, true);
  assert.equal(result.product.name, 'Kaos Rimba Navy');
});

test('NFR-502: an empty product catalog always resolves to "no match" -- never a crash', () => {
  assert.doesNotThrow(() => {
    const result = matchProduct('Kaos Rimba Navy', []);
    assert.equal(result.matched, false);
    assert.equal(result.product, null);
    assert.equal(result.score, 0);
  });
});

test('NFR-502: a missing/undefined product list is also handled safely (not just an empty array)', () => {
  assert.doesNotThrow(() => {
    const result = matchProduct('Kaos Rimba Navy', undefined);
    assert.equal(result.matched, false);
    assert.equal(result.product, null);
  });
});

test('NFR-502: empty/null/undefined customer text never crashes, always resolves to no match', () => {
  for (const text of ['', null, undefined, '   ']) {
    assert.doesNotThrow(() => {
      const result = matchProduct(text, CATALOG);
      assert.equal(result.matched, false);
    });
  }
});

test('a configurable threshold changes the match/no-match outcome for a borderline score', () => {
  // "cargo pants nya ready?" only covers 1 of "celana cargo"'s 2 tokens
  // (English "pants" isn't in the catalog) -- score 0.5, deliberately
  // below the 0.65 default, but above a looser custom threshold.
  const defaultResult = matchProduct('cargo pants nya ready?', CATALOG);
  assert.equal(defaultResult.matched, false);
  assert.ok(defaultResult.score > 0 && defaultResult.score < DEFAULT_MATCH_THRESHOLD, `expected a low but nonzero score, got ${defaultResult.score}`);
  const looseResult = matchProduct('cargo pants nya ready?', CATALOG, { threshold: 0.2 });
  assert.equal(looseResult.matched, true);
  assert.equal(looseResult.product.name, 'Celana Rimba Cargo');
});

test('normalizeAndStemToTokens: strips punctuation-only tokens and stems inflected words to a shared root', () => {
  assert.deepEqual(normalizeAndStemToTokens('kaosnya ada?'), ['kaos', 'ada']);
  assert.deepEqual(normalizeAndStemToTokens('membeli kaos'), ['beli', 'kaos']);
  assert.deepEqual(normalizeAndStemToTokens(''), []);
  assert.deepEqual(normalizeAndStemToTokens(null), []);
});

/**
 * Post-review adversarial fix (Critical finding): an independent reviewer
 * found that a product word appearing anywhere inside a long, unrelated
 * message -- especially a COMPLAINT -- used to score a confident 1.0
 * match. `"kaos kemarin yang saya beli robek, bisa refund?"` (a refund
 * complaint) scored identically to `"kaosnya ada?"` (a genuine product
 * question), and got sent the same tone-deaf "what size?" auto-reply with
 * `needs_review=false` -- zero signal to the owner. These are the
 * reviewer's own exact adversarial examples, used verbatim, now asserted
 * to correctly resolve to `needs_review` (matched: false).
 */
test('ADVERSARIAL (Critical fix): a refund complaint with the product word buried in it does NOT confidently match -- score AND denylist both catch it', () => {
  const result = matchProduct('kaos kemarin yang saya beli robek, bisa refund?', CATALOG);
  assert.equal(result.matched, false, `expected no confident match, got product=${result.product?.name} score=${result.score}`);
  assert.equal(result.product, null);
  // Both defenses fire independently here: the length-penalized score is
  // already well below threshold, AND the intent denylist catches
  // "refund"/"robek" -- proving this isn't a lucky escape via only one of
  // the two required fixes.
  assert.ok(result.score < DEFAULT_MATCH_THRESHOLD, `expected the length-penalized score alone to be below threshold, got ${result.score}`);
  assert.ok(result.flaggedTerms.length > 0, 'expected the intent denylist to also independently flag this message');
});

test('ADVERSARIAL (Critical fix): a "rusak" (damaged) complaint about a jacket does not confidently match', () => {
  const result = matchProduct('jaket yang saya beli kemarin rusak, minta ganti dong', CATALOG);
  assert.equal(result.matched, false, `expected no confident match, got product=${result.product?.name} score=${result.score}`);
  assert.ok(result.score < DEFAULT_MATCH_THRESHOLD);
  assert.ok(result.flaggedTerms.includes('rusak'));
});

test('ADVERSARIAL (Critical fix): a "komplain"/"robek" complaint about pants does not confidently match', () => {
  const result = matchProduct('celana yang kemarin saya beli robek parah, komplain nih', CATALOG);
  assert.equal(result.matched, false, `expected no confident match, got product=${result.product?.name} score=${result.score}`);
  assert.ok(result.score < DEFAULT_MATCH_THRESHOLD);
  assert.ok(result.flaggedTerms.includes('komplain'));
});

test('ADVERSARIAL (Critical fix): the intent denylist is the LAST line of defense even when the customer names the full product then complains', () => {
  // This is the case that proves the denylist is not redundant with the
  // scoring fix: naming the product IN FULL still gives enough matched
  // tokens to buy back the length penalty's free allowance, so the raw
  // score alone is still ~1.0 here. Only the independent denylist check
  // catches it.
  const result = matchProduct('kaos rimba navy saya rusak parah, refund dong', CATALOG);
  assert.ok(result.score >= DEFAULT_MATCH_THRESHOLD, `sanity: expected the raw score to still clear threshold (proving scoring alone is insufficient), got ${result.score}`);
  assert.equal(result.matched, false, 'the denylist must override a high score');
  assert.equal(result.product, null);
  assert.ok(result.flaggedTerms.length > 0);
});

test('the intent denylist does not fire on ordinary product questions with no complaint vocabulary', () => {
  for (const text of ['Kaos Rimba Navy', 'kaosnya ada?', 'saya mau beli Kaos Rimba Hitam ukuran L']) {
    const result = matchProduct(text, CATALOG);
    assert.deepEqual(result.flaggedTerms, [], `"${text}" should not trip the denylist`);
    assert.equal(result.matched, true);
  }
});

test('findIntentDenylistHits: a stemmed inflection of a denylist word (e.g. "dirusak") is still caught', () => {
  const tokens = normalizeAndStemToTokens('barangnya dirusak waktu pengiriman');
  const hits = findIntentDenylistHits(tokens, DEFAULT_INTENT_DENYLIST);
  assert.ok(hits.length > 0, `expected "dirusak" (stems to "rusak") to trip the denylist, tokens were ${JSON.stringify(tokens)}`);
});

/**
 * Post-review fix (Medium finding): an ambiguity margin check. Two
 * products that share a generic alias (a realistic catalog misconfig --
 * see also tests/productsLoader.test.js's duplicate-alias warning
 * coverage) must NOT silently resolve to whichever is listed first.
 */
test('AMBIGUITY (Medium fix): a bare alias shared by two products resolves to needs_review, not a silent first-in-array pick', () => {
  const AMBIGUOUS_CATALOG = [
    { name: 'Kaos Rimba Navy', aliases: ['kaos'] },
    { name: 'Kaos Rimba Merah', aliases: ['kaos'] },
  ];
  const result = matchProduct('kaos dong', AMBIGUOUS_CATALOG);
  assert.equal(result.matched, false, 'an ambiguous tie must not resolve to a confident match');
  assert.equal(result.product, null);
  assert.equal(result.ambiguous, true);
});

test('AMBIGUITY (Medium fix): a clear score gap between top and runner-up is NOT flagged ambiguous', () => {
  // "Kaos Rimba Navy" clearly outscores "Kaos Rimba Hitam" here (1.0 vs
  // ~0.67) -- well outside the default 0.1 margin.
  const result = matchProduct('Kaos Rimba Navy', CATALOG);
  assert.equal(result.ambiguous, false);
  assert.equal(result.matched, true);
});

test('AMBIGUITY (Medium fix): the margin is configurable via options.ambiguityMargin', () => {
  const AMBIGUOUS_CATALOG = [
    { name: 'Kaos Rimba Navy', aliases: ['kaos'] },
    { name: 'Kaos Rimba Merah', aliases: ['kaos'] },
  ];
  // A margin of 0 never treats any score gap (however small) as ambiguous.
  const result = matchProduct('kaos dong', AMBIGUOUS_CATALOG, { ambiguityMargin: 0 });
  assert.equal(result.ambiguous, false);
  assert.equal(result.matched, true);
});

/**
 * Post-review RETUNING (second independent review): the first
 * length-penalty tuning (FREE_UNACCOUNTED_TOKENS_PER_MATCH = 2) fixed the
 * Critical false-positive bug, but overcorrected -- 4 of 8 realistic,
 * zero-complaint-intent, zero-ambiguity longer purchase questions the
 * reviewer tested incorrectly scored below threshold and got routed to
 * needs_review. These are the reviewer's own exact examples, now asserted
 * to correctly match (this is the safe direction to fail in, but it was
 * still defeating a lot of the feature's value).
 */
test('RETUNED (overcorrection fix): realistic longer purchase questions with filler/politeness words correctly match', () => {
  const cases = [
    ['jaket outdoor nya masih ada gak min, warna apa aja', 'Jaket Rimba Outdoor'],
    ['min, kaos rimba navy nya ada warna lain gak selain navy', 'Kaos Rimba Navy'],
    ['permisi kak mau tanya kaos rimba navy nya itu bahannya apa ya, terus available size apa aja', 'Kaos Rimba Navy'],
    ['celana cargo nya masih tersedia ga kak, boleh liat foto dan harganya', 'Celana Rimba Cargo'],
  ];
  for (const [text, expectedProduct] of cases) {
    const result = matchProduct(text, CATALOG);
    assert.equal(result.matched, true, `"${text}" should match (got score ${result.score})`);
    assert.equal(result.product.name, expectedProduct);
    assert.ok(result.score >= DEFAULT_MATCH_THRESHOLD);
  }
});

test('RETUNED (overcorrection fix, regression guard): the original adversarial complaint/refund examples STILL correctly reject after retuning', () => {
  for (const text of [
    'kaos kemarin yang saya beli robek, bisa refund?',
    'jaket yang saya beli kemarin rusak, minta ganti dong',
    'celana yang kemarin saya beli robek parah, komplain nih',
  ]) {
    const result = matchProduct(text, CATALOG);
    assert.equal(result.matched, false, `"${text}" must still NOT match after retuning (got score ${result.score})`);
  }
});

test('RETUNED (overcorrection fix): three NEW adversarial examples (from the second review) also correctly reject', () => {
  // A store-hours question that mentions "jaket" only in passing.
  const storeHours = matchProduct('toko jaket buka jam berapa ya min?', CATALOG);
  assert.equal(storeHours.matched, false, `expected no match, got score ${storeHours.score}`);

  // An order-status complaint using words NOT in the intent denylist
  // ("lama"/"belum nyampe") -- must be caught by the length penalty alone,
  // since there's nothing for the denylist to catch here. It also has zero
  // matched product tokens at all, so it's a trivial (score 0) case, but
  // still worth asserting explicitly since it's one of the reviewer's
  // exact examples.
  const orderStatus = matchProduct('pesanan saya kok lama banget, belum nyampe juga sampai sekarang', CATALOG);
  assert.equal(orderStatus.matched, false);
  assert.equal(orderStatus.score, 0);

  // A size-exchange request mentioning "kaos" -- not a complaint about a
  // defect, just wanting a different size; must not confidently match
  // (there's no Q2-worthy product-interest signal here, and it should not
  // trip the denylist either since it names no defect/refund word).
  const exchange = matchProduct('kaos nya mau saya tukar ukuran, bisa gak', CATALOG);
  assert.equal(exchange.matched, false, `expected no match, got score ${exchange.score}`);
  assert.deepEqual(exchange.flaggedTerms, [], 'this message should not trip the denylist either -- "tukar" is not complaint vocabulary');
});

test('RETUNED (overcorrection fix): naming the full product then complaining is STILL caught -- by the denylist, exactly as designed', () => {
  // This is the one case the length penalty is not expected to catch by
  // itself (see the module doc comment) -- confirms retuning did not
  // accidentally weaken the denylist's role as the second, independent layer.
  const result = matchProduct('kaos rimba navy saya rusak parah, refund dong', CATALOG);
  assert.ok(result.score >= DEFAULT_MATCH_THRESHOLD, `sanity: raw score should still clear threshold, got ${result.score}`);
  assert.equal(result.matched, false, 'the denylist must still override a high score');
  assert.ok(result.flaggedTerms.length > 0);
});

/**
 * Post-review fix (Secondary finding): Jaro-Winkler similarity is
 * unreliable on very short strings -- "pas" ("just"/"fits", a completely
 * benign, common word) used to fuzzy-match "palsu" ("counterfeit") at
 * ~0.89 similarity, above the fuzzy bar, purely because both are short.
 * It never flipped a real outcome (the score was already low in every
 * case tested), but it's a real risk of a misleading "why was this
 * flagged" reason shown to the owner on a genuinely ordinary message.
 */
test('DENYLIST SHORT-WORD FIX (Secondary finding): "pas" no longer spuriously matches "palsu"', () => {
  const hits = findIntentDenylistHits(normalizeAndStemToTokens('pas'), DEFAULT_INTENT_DENYLIST);
  assert.deepEqual(hits, []);
});

test('DENYLIST SHORT-WORD FIX: other common short words do not spuriously trip the denylist either', () => {
  for (const word of ['gak', 'dan', 'apa', 'ada', 'aja', 'kak', 'min', 'ya']) {
    const hits = findIntentDenylistHits(normalizeAndStemToTokens(word), DEFAULT_INTENT_DENYLIST);
    assert.deepEqual(hits, [], `"${word}" should not trip the denylist`);
  }
});

test('DENYLIST SHORT-WORD FIX: a realistic sentence using "pas" is not flagged, and correctly matches', () => {
  const result = matchProduct('kaos rimba navy nya, yang size M pas gak ya buat badan kurus', CATALOG);
  assert.deepEqual(result.flaggedTerms, [], '"pas" must not trigger a spurious denylist flag in context either');
});

test('DENYLIST SHORT-WORD FIX: typo tolerance is preserved for longer denylist words (only short-word fuzzy matching was tightened)', () => {
  const hits = findIntentDenylistHits(normalizeAndStemToTokens('barangnya rusakk parah sekali'), DEFAULT_INTENT_DENYLIST);
  assert.ok(hits.includes('rusak'), `expected the "rusakk" typo to still fuzzy-match "rusak", got ${JSON.stringify(hits)}`);
});

/**
 * FR-904 (docs/sdd/changes/2026-09-02-fix-matching-safety-bugs.md, Bug 3
 * tuning): a 15-customer adversarial simulation found "keluarga" (family,
 * completely benign) stemming to itself and fuzzy-matching stemmed
 * "keluhan"/"keluh" (complaint) at Jaro-Winkler 0.86 -- just above the old
 * shared TOKEN_MATCH_SIMILARITY_THRESHOLD (0.85) that findIntentDenylistHits()
 * used to reuse for its own fuzzy tolerance -- incorrectly suppressing a
 * genuine purchase inquiry as a complaint. The fix raises the denylist's
 * OWN fuzzy threshold (DENYLIST_FUZZY_MATCH_THRESHOLD) to 0.90, measured
 * against both the false positive and real denylist-word typos below.
 */
test('FR-904: DENYLIST_FUZZY_MATCH_THRESHOLD is 0.90 -- the lowest of the values tried (0.90, 0.92) that fixes the false positive without losing typo tolerance', () => {
  assert.equal(DENYLIST_FUZZY_MATCH_THRESHOLD, 0.9);
});

test('FR-904: "keluarga" (family) no longer fuzzy-matches stemmed "keluhan"/"keluh" (JW measured at 0.86, below the new 0.90 bar)', () => {
  const stemmedKeluarga = normalizeAndStemToTokens('keluarga')[0];
  const stemmedKeluhan = normalizeAndStemToTokens('keluhan')[0];
  assert.equal(stemmedKeluarga, 'keluarga');
  assert.equal(stemmedKeluhan, 'keluh');

  const measuredScore = natural.JaroWinklerDistance(stemmedKeluarga, stemmedKeluhan, { ignoreCase: true });
  assert.ok(
    Math.abs(measuredScore - 0.86) < 0.01,
    `expected the measured JW score to be ~0.86 (the false positive this fix targets), got ${measuredScore}`,
  );
  assert.ok(measuredScore < DENYLIST_FUZZY_MATCH_THRESHOLD, `0.86 must now be below the 0.90 bar, got ${measuredScore}`);

  const hits = findIntentDenylistHits(normalizeAndStemToTokens('keluarga'), DEFAULT_INTENT_DENYLIST);
  assert.deepEqual(hits, [], `"keluarga" must no longer trip the denylist, got ${JSON.stringify(hits)}`);
});

test('FR-904: a genuine typo of a real denylist word ("komplein" for "komplain", JW 0.95) still correctly triggers', () => {
  const measuredScore = natural.JaroWinklerDistance('komplein', 'komplain', { ignoreCase: true });
  assert.ok(
    Math.abs(measuredScore - 0.95) < 0.01,
    `expected the measured JW score to be ~0.95, got ${measuredScore}`,
  );
  assert.ok(measuredScore >= DENYLIST_FUZZY_MATCH_THRESHOLD, `0.95 must still clear the 0.90 bar, got ${measuredScore}`);

  const hits = findIntentDenylistHits(normalizeAndStemToTokens('barangnya komplein terus'), DEFAULT_INTENT_DENYLIST);
  assert.ok(hits.includes('komplain'), `expected "komplein" to still trip the denylist as a typo of "komplain", got ${JSON.stringify(hits)}`);
});

test('FR-904: a genuine typo of a real denylist word ("rusakk" for "rusak", JW ~0.967) still correctly triggers', () => {
  const measuredScore = natural.JaroWinklerDistance('rusakk', 'rusak', { ignoreCase: true });
  assert.ok(
    measuredScore > 0.96 && measuredScore < 0.97,
    `expected the measured JW score to be ~0.967, got ${measuredScore}`,
  );
  assert.ok(measuredScore >= DENYLIST_FUZZY_MATCH_THRESHOLD, `must still clear the 0.90 bar, got ${measuredScore}`);

  const hits = findIntentDenylistHits(normalizeAndStemToTokens('barangnya rusakk parah'), DEFAULT_INTENT_DENYLIST);
  assert.ok(hits.includes('rusak'), `expected "rusakk" to still trip the denylist as a typo of "rusak", got ${JSON.stringify(hits)}`);
});

test('FR-904 (end-to-end, the exact adversarial case): a long message naming a full product AND containing "keluarga" now resolves without the denylist forcing needs_review', () => {
  const CATALOG_904 = [
    { name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'baju kaos'] },
    { name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] },
  ];
  const result = matchProduct('mau tanya kaos rimba navy nya ada, buat jalan-jalan sama keluarga', CATALOG_904);
  assert.deepEqual(result.flaggedTerms, [], `"keluarga" must not appear in flaggedTerms, got ${JSON.stringify(result.flaggedTerms)}`);
});

test('FR-904 (regression guard): the intent denylist still catches "keluhan" itself (an actual complaint word, not the "keluarga" false positive)', () => {
  const hits = findIntentDenylistHits(normalizeAndStemToTokens('saya ada keluhan soal barang ini'), DEFAULT_INTENT_DENYLIST);
  assert.ok(hits.includes('keluhan'), `an exact stemmed match for "keluhan" itself must still trip the denylist, got ${JSON.stringify(hits)}`);
});
