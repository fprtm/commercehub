'use strict';

const natural = require('natural');
const { Stemmer, Tokenizer } = require('sastrawijs');

/**
 * Fuzzy Product-Relevance Matching (non-LLM)
 * ===========================================
 * FR-502..FR-504 (docs/sdd/changes/2026-09-01-fuzzy-product-matching.md):
 * scores how well a customer's free-text Q1 answer (`question1_answer`)
 * matches a known, small Product catalog, using classical NLP only --
 * Indonesian stemming (`sastrawijs`) + string-similarity (`natural`).
 * Deliberately NOT LLM-based (explicitly out of scope per the change doc's
 * "NEVER FOR THIS PROJECT").
 *
 * --- Why this algorithm (documented, not an arbitrary pick) ------------
 *
 * The customer's answer is a short, free-form sentence ("kaosnya ada?",
 * "membeli kaos", "toko buka jam berapa?"), while a product is identified
 * by a short name/alias ("Kaos Rimba Navy", "kaos"). A single whole-string
 * similarity score (e.g. Jaro-Winkler over the full sentence vs. the full
 * product name) does not work here: the lengths are wildly different, so
 * even a perfect substring match scores low just because the sentence has
 * extra words around it.
 *
 * Instead, matching happens at the TOKEN level, after stemming:
 *   1. Both the customer's text and every product name/alias are
 *      lowercased, tokenized, and run through the Sastrawi Indonesian
 *      stemmer (`sastrawijs`) -- this is what makes "membeli kaos",
 *      "dibeli kaos nya" and "kaosnya" all reduce to the same root token
 *      "kaos", regardless of which prefix/suffix inflection the customer
 *      typed.
 *   2. For each candidate string (a product's name, and separately each of
 *      its aliases), every one of ITS tokens is matched against the BEST
 *      (highest-similarity) token anywhere in the customer's text, using
 *      Jaro-Winkler distance (`natural.JaroWinklerDistance`) -- chosen over
 *      plain Levenshtein because JW is already normalized to [0, 1]
 *      (directly usable as a confidence score without extra length
 *      normalization) and weights matching PREFIXES more heavily, which
 *      suits short tokens with a typo near the end (a common typing
 *      pattern on a phone, e.g. "kaus" for "kaos"). A candidate token only
 *      counts as "matched" if that best similarity clears
 *      TOKEN_MATCH_SIMILARITY_THRESHOLD (0.85) -- a high bar, so two
 *      genuinely different short words (e.g. "kaos" vs "navy", JW ~0.5)
 *      never count as the same word by accident.
 *   3. A candidate's raw score is `candidateCoverage * averageMatchedSimilarity`,
 *      where `candidateCoverage` = (matched tokens) / (candidate's total
 *      tokens). This rewards SHORT, SPECIFIC candidates (e.g. a one-word
 *      alias like "kaos") that are fully present in the customer's text
 *      with a score near 1.0, while a long multi-word product name only
 *      scores highly when most/all of its identifying words are actually
 *      present -- the FR-502 acceptance bar ("an exact or near-exact
 *      product name match scores high; unrelated text scores low").
 *   4. **(Post-review fix, adversarial finding "Critical")** That raw score
 *      alone has no defense against a product word appearing inside a
 *      long, mostly-unrelated message -- a one-token alias like "kaos"
 *      buried anywhere in an 8-word sentence used to score a full 1.0
 *      (candidateCoverage = 1/1) regardless of how much of the sentence
 *      went unaccounted for, e.g. "kaos kemarin yang saya beli robek, bisa
 *      refund?" (a refund complaint) scored identically to "kaosnya ada?"
 *      (a genuine product question). Fixed with a LENGTH PENALTY: the raw
 *      score is multiplied by `matchedCount / (matchedCount +
 *      excessUnaccountedCustomerTokens)`, where `excessUnaccountedCustomerTokens`
 *      is how many of the customer's OWN tokens were not accounted for by
 *      this match, beyond a small free allowance
 *      (FREE_UNACCOUNTED_TOKENS_PER_MATCH * matchedCount) -- more matched
 *      tokens is stronger evidence the message really is about this
 *      product, so more surrounding filler is tolerated; a single matched
 *      token surrounded by many unrelated ones is not. See "Threshold and
 *      the length penalty" below for the exact numbers this was tuned
 *      against.
 *   5. **(Post-review fix, "Medium" finding)** Even with the length
 *      penalty, a full product name mentioned inside a complaint (e.g.
 *      "kaos rimba navy saya rusak parah, refund dong") still scores 1.0
 *      by the numbers alone -- 3 matched tokens buys enough free allowance
 *      to absorb the rest of the sentence. Scoring literally cannot
 *      distinguish "I want to buy this" from "this broke" once the
 *      product is named in full; no token-similarity formula can. This is
 *      exactly why matchProduct() ALSO applies an independent, non-scoring
 *      INTENT DENYLIST (see below) as defense-in-depth, not a substitute
 *      for the scoring fix.
 *   6. A product's overall score is the MAX across its name + all its
 *      aliases (whichever candidate the customer's text matches best).
 *      Ties are broken toward whichever candidate matched more TOKENS
 *      (more specific evidence) -- e.g. if catalog has both "Kaos Rimba
 *      Navy" (alias "kaos") and "Kaos Rimba Hitam", a message that
 *      actually says "Kaos Rimba Hitam ukuran L" must resolve to the Hitam
 *      product, not tie-break arbitrarily toward whichever product happens
 *      to be listed first just because a generic "kaos" alias also scores
 *      1.0 on its own.
 *   7. **(Post-review fix, "Medium" finding)** An AMBIGUITY MARGIN check:
 *      if the top-scoring product and the runner-up are both above
 *      threshold and within AMBIGUITY_MARGIN of each other, the match is
 *      too close to call confidently -- resolved as "no match"
 *      (needs_review) rather than silently picking whichever happens to
 *      score marginally higher (which, on a tie, is really just whichever
 *      appears first in the catalog array).
 *
 * TF-IDF (also mentioned as an option in the change doc) was considered and
 * not used: it is a corpus-level technique for weighting terms by how
 * distinctive they are across many documents, which is the wrong tool for
 * a small, fully-enumerable catalog (a handful of product names) being
 * matched one free-text message at a time -- token-level Jaro-Winkler after
 * stemming is simpler and sufficient, consistent with this project's
 * established "don't overengineer" pattern (see README's other change
 * docs).
 *
 * --- Threshold and the length penalty (twice-tuned) ------------------------
 * DEFAULT_MATCH_THRESHOLD = 0.65 (0-1 scale). FREE_UNACCOUNTED_TOKENS_PER_MATCH
 * was first set to 2, then RETUNED to 5 after a second independent review
 * found 2 overcorrected: realistic longer purchase questions naturally
 * carry several filler/politeness words ("min", "kak", "dong", "nya",
 * "gak", question words) that are not about complaint intent at all, and
 * a 2-token allowance was rejecting a large share of them. Both anchor
 * sets below were re-verified together against the final value of 5 (see
 * tests/productMatcher.test.js for the exact scores) -- this is a single
 * shared constant, so it is tuned against BOTH sets at once, not one at
 * the other's expense:
 *
 * Legitimate longer purchase questions (must score >= 0.65, i.e. "matched"):
 *   - "Kaos Rimba Navy" (exact answer)                    -> 1.00
 *   - "kaosnya ada?" / "membeli kaos" / "dibeli kaos nya" -> 1.00
 *   - "saya mau beli Kaos Rimba Hitam ukuran L"           -> 1.00
 *   - "jaket outdoor nya masih ada gak min, warna apa aja" -> ~1.00
 *   - "min, kaos rimba navy nya ada warna lain gak selain navy" -> 1.00
 *   - "permisi kak mau tanya kaos rimba navy nya itu bahannya
 *      apa ya, terus available size apa aja"              -> 1.00
 *   - "celana cargo nya masih tersedia ga kak, boleh liat
 *      foto dan harganya"                                 -> 1.00
 *
 * Adversarial complaint/refund sentences (must score < 0.65 -- "no match"
 * via scoring ALONE, before the intent denylist below even applies; the
 * one exception, noted below, is caught by the denylist instead):
 *   - "kaos kemarin yang saya beli robek, bisa refund?"    -> ~0.20
 *   - "jaket yang saya beli kemarin rusak, minta ganti dong" -> ~0.17
 *   - "celana yang kemarin saya beli robek parah, komplain nih" -> ~0.17
 *   - "toko jaket buka jam berapa ya min?" (product word in passing) -> ~0.25
 *   - "kaos nya mau saya tukar ukuran, bisa gak" (exchange request) -> ~0.20
 *   - "kaos rimba navy saya rusak parah, refund dong" (full name
 *      named, THEN complains) -> still ~1.00 by score alone (naming
 *      the product in full buys back the free allowance) -- this is
 *      the one case scoring cannot catch by design; see "Independent
 *      adversarial review findings" in README.md for why the intent
 *      denylist exists as an independent second layer specifically
 *      for this case, not a redundant one.
 *
 * A higher free-allowance-per-match lets more legitimate multi-word
 * mentions survive extra filler words, at the cost of also letting a
 * *shorter* adversarial sentence with only one matched token slip through
 * scoring alone (still caught by the denylist whenever it uses
 * denylist-listed vocabulary -- see "What this is not" in README.md for
 * the honest residual risk when it doesn't). 5 is the smallest value that
 * keeps every legitimate anchor above threshold while every tested
 * adversarial sentence -- old and new -- still lands below it via scoring
 * alone (the one exception above is an intentional, documented job for the
 * denylist, not a gap in this constant).
 */

const stemmer = new Stemmer();
const tokenizer = new Tokenizer();

// How similar two stemmed tokens must be (Jaro-Winkler, 0-1) to count as
// "the same word" for coverage purposes. High on purpose -- see doc above.
const TOKEN_MATCH_SIMILARITY_THRESHOLD = 0.85;

// Default confidence bar (0-1 scale) above which FR-503 applies (today's
// flow proceeds, matched product stored) and below which FR-504 applies
// (Q2 prompt suppressed, needs_review flagged). See reasoning above.
const DEFAULT_MATCH_THRESHOLD = 0.65;

// Post-review fix (Critical finding), retuned after a second independent
// review found the first value (2) overcorrected: how many of the
// customer's OWN tokens can go "unaccounted for" by a match, per matched
// candidate token, before the length penalty starts reducing the score.
// See the module doc comment's "Threshold and the length penalty" section
// for how this was tuned -- 5, not 2, is the smallest value that keeps
// realistic longer purchase questions (which naturally carry several
// filler/politeness words -- "min", "kak", "dong", "nya", "gak", question
// words -- unrelated to complaint intent) above threshold, while every
// tested adversarial complaint/refund sentence (all of which have only
// ONE matched candidate token, the bare product mention) still lands
// below it.
const FREE_UNACCOUNTED_TOKENS_PER_MATCH = 5;

// Post-review fix (Secondary finding): Jaro-Winkler similarity is
// unreliable on very short strings (e.g. "pas" vs "palsu" scores ~0.89,
// above TOKEN_MATCH_SIMILARITY_THRESHOLD, purely because both are short --
// not because they mean anything similar). findIntentDenylistHits() below
// requires an EXACT stemmed match (no fuzzy tolerance) whenever the
// shorter of the two words being compared is under this length, and only
// falls back to Jaro-Winkler fuzzy matching (for typo tolerance, e.g.
// "rusakk") when both words are at least this long.
const DENYLIST_SHORT_WORD_EXACT_MATCH_LENGTH = 5;

// Post-review fix (Medium finding): if the top-scoring product and the
// runner-up are both >= threshold and within this margin of each other,
// treat the match as ambiguous (no confident single answer) rather than
// silently picking one.
const DEFAULT_AMBIGUITY_MARGIN = 0.1;

// Post-review fix (Critical finding): independent, non-scoring safety net.
// If any of these (stemmed) words appear in the customer's text, the
// answer is ALWAYS routed to needs_review regardless of how high the
// token-similarity score is -- this is what catches "kaos rimba navy saya
// rusak parah, refund dong" (full product name + complaint), which the
// scoring formula alone cannot distinguish from a genuine purchase
// inquiry (see module doc point 5 above). Deliberately independent of
// `natural`/stemming fuzziness (exact/near-exact stemmed-token match only)
// so this list's behavior is simple to reason about and extend.
// Configurable/extensible via config/products.json's optional
// "intentDenylist" field (see src/services/productsLoader.js) -- a real
// client can add their own complaint vocabulary without a code change;
// this coded list is the always-on floor, not a ceiling.
const DEFAULT_INTENT_DENYLIST = [
  'refund',
  'rusak',
  'komplain',
  'retur',
  'garansi',
  'cacat',
  'kecewa',
  'robek',
  'sobek',
  'tipu',
  'penipuan',
  'palsu',
  'keluhan',
  'protes',
  'kapok',
  'gagal',
  'error',
  'hilang',
  'hangus',
  'batal',
  'nipu',
  'bocor',
  'patah',
  'pecah',
];

/**
 * Lowercases, tokenizes, and stems `text` into an array of root-form
 * tokens. Non-alphabetic tokens (pure punctuation/digits, e.g. "?" or a
 * lone "628...") are dropped -- they carry no product-identifying signal
 * and would never usefully match anyway.
 *
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
function normalizeAndStemToTokens(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  const lower = text.toLowerCase();
  const rawTokens = tokenizer.tokenize(lower).filter((token) => /[a-z]/.test(token));
  return rawTokens.map((token) => stemmer.stem(token)).filter((token) => token.length > 0);
}

/**
 * Post-review fix (Critical finding): does `customerTokens` contain any
 * word from `denylist` (already-stemmed, e.g. DEFAULT_INTENT_DENYLIST)?
 *
 * Uses Jaro-Winkler fuzzy tolerance (a typo like "rusakk" should still
 * trip it) at the same strict TOKEN_MATCH_SIMILARITY_THRESHOLD bar used
 * everywhere else in this module -- BUT (second post-review fix,
 * "Secondary" finding) only when BOTH words being compared are at least
 * DENYLIST_SHORT_WORD_EXACT_MATCH_LENGTH characters long. Jaro-Winkler is
 * unreliable on short strings purely as a function of their length (e.g.
 * "pas" vs "palsu" scores ~0.89 -- above the fuzzy bar -- with no
 * meaningful relationship between the two words); requiring an exact
 * stemmed match whenever either word is short avoids exactly that kind of
 * spurious hit, at the cost of not fuzzy-catching a typo of a short
 * denylist word (e.g. "tipu") -- an acceptable trade-off since a
 * mistaken/misleading denylist flag is worse than occasionally missing a
 * typo'd short word (the length-penalty and, ultimately, the owner's own
 * read of the raw text are the remaining backstops for that).
 *
 * @param {string[]} customerTokens - already stemmed (normalizeAndStemToTokens output)
 * @param {string[]} denylist - raw (not-yet-stemmed) words
 * @returns {string[]} the denylist word(s) that matched, or [] if none did
 */
function findIntentDenylistHits(customerTokens, denylist) {
  if (!Array.isArray(denylist) || denylist.length === 0 || customerTokens.length === 0) return [];
  const stemmedDenylist = denylist.map((word) => ({ original: word, stemmed: normalizeAndStemToTokens(word)[0] || word.toLowerCase() }));
  const hits = new Set();
  for (const customerToken of customerTokens) {
    for (const { original, stemmed } of stemmedDenylist) {
      const shorterLength = Math.min(customerToken.length, stemmed.length);
      const matches =
        shorterLength < DENYLIST_SHORT_WORD_EXACT_MATCH_LENGTH
          ? customerToken === stemmed
          : natural.JaroWinklerDistance(customerToken, stemmed, { ignoreCase: true }) >= TOKEN_MATCH_SIMILARITY_THRESHOLD;
      if (matches) {
        hits.add(original);
      }
    }
  }
  return Array.from(hits);
}

/**
 * Scores how well `candidateTokens` (a product name or alias, already
 * stemmed) is covered by `targetTokens` (the customer's stemmed text), with
 * the length penalty described in the module-level doc comment.
 *
 * @returns {{ score: number, matchedCount: number }}
 */
function tokenCoverage(candidateTokens, targetTokens) {
  if (candidateTokens.length === 0 || targetTokens.length === 0) {
    return { score: 0, matchedCount: 0 };
  }

  let matchedCount = 0;
  let similaritySum = 0;
  const matchedTargetIndices = new Set();
  for (const candidateToken of candidateTokens) {
    let bestSimilarity = 0;
    let bestIndex = -1;
    targetTokens.forEach((targetToken, index) => {
      const similarity = natural.JaroWinklerDistance(candidateToken, targetToken, { ignoreCase: true });
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIndex = index;
      }
    });
    if (bestSimilarity >= TOKEN_MATCH_SIMILARITY_THRESHOLD) {
      matchedCount += 1;
      similaritySum += bestSimilarity;
      if (bestIndex >= 0) matchedTargetIndices.add(bestIndex);
    }
  }

  if (matchedCount === 0) return { score: 0, matchedCount: 0 };

  const candidateCoverage = matchedCount / candidateTokens.length;
  const averageSimilarity = similaritySum / matchedCount;

  // Post-review fix (Critical finding): penalize by how many of the
  // CUSTOMER's tokens this match leaves unaccounted for -- see module doc
  // point 4 above for the full reasoning.
  const unaccountedCustomerTokens = targetTokens.length - matchedTargetIndices.size;
  const freeAllowance = FREE_UNACCOUNTED_TOKENS_PER_MATCH * matchedCount;
  const excessUnaccounted = Math.max(0, unaccountedCustomerTokens - freeAllowance);
  const lengthPenalty = matchedCount / (matchedCount + excessUnaccounted);

  return { score: candidateCoverage * averageSimilarity * lengthPenalty, matchedCount };
}

/**
 * Best score for one product: the max over its name and all its aliases.
 *
 * @param {{ name: string, aliases?: string[] }} product
 * @param {string[]} customerTokens
 * @returns {{ score: number, matchedCount: number }}
 */
function bestScoreForProduct(product, customerTokens) {
  const candidates = [product.name, ...(product.aliases || [])];
  let best = { score: 0, matchedCount: 0 };
  for (const candidate of candidates) {
    const candidateTokens = normalizeAndStemToTokens(candidate);
    const result = tokenCoverage(candidateTokens, customerTokens);
    // Prefer a strictly higher score; on a tie, prefer the candidate that
    // matched more tokens (more specific evidence) -- see module doc.
    if (result.score > best.score || (result.score === best.score && result.matchedCount > best.matchedCount)) {
      best = result;
    }
  }
  return best;
}

/**
 * FR-502: fuzzy-matches `text` (the customer's Q1 answer) against
 * `products`, returning the best match and a confidence score.
 *
 * Safe by construction for every "nothing to match" case (NFR-502): an
 * empty/missing product catalog, empty/missing text, or a catalog with no
 * candidate that clears the token-similarity bar all resolve to
 * `{ product: null, score: 0, matched: false }` -- never a thrown error.
 *
 * Also resolves to `matched: false` (independent of score) in two
 * defense-in-depth safety cases (both post-review fixes):
 *   - `flaggedTerms.length > 0` -- the customer's text contains a word
 *     from the intent denylist (e.g. "refund", "rusak", "komplain"),
 *     regardless of how high the token-similarity score is.
 *   - `ambiguous: true` -- the top-scoring product and the runner-up are
 *     both >= threshold and within `ambiguityMargin` of each other.
 *
 * @param {string|null|undefined} text - the customer's raw Q1 answer.
 * @param {Array<{ name: string, aliases?: string[] }>} products - the
 *   Product catalog (see src/services/productsLoader.js / FR-501).
 * @param {object} [options]
 * @param {number} [options.threshold] - defaults to DEFAULT_MATCH_THRESHOLD.
 * @param {number} [options.ambiguityMargin] - defaults to DEFAULT_AMBIGUITY_MARGIN.
 * @param {string[]} [options.intentDenylist] - defaults to DEFAULT_INTENT_DENYLIST.
 * @returns {{
 *   product: {name: string, aliases?: string[]}|null,
 *   score: number,
 *   matched: boolean,
 *   flaggedTerms: string[],
 *   ambiguous: boolean,
 * }}
 */
function matchProduct(text, products, options = {}) {
  const threshold = typeof options.threshold === 'number' ? options.threshold : DEFAULT_MATCH_THRESHOLD;
  const ambiguityMargin = typeof options.ambiguityMargin === 'number' ? options.ambiguityMargin : DEFAULT_AMBIGUITY_MARGIN;
  const intentDenylist = Array.isArray(options.intentDenylist) ? options.intentDenylist : DEFAULT_INTENT_DENYLIST;

  const customerTokens = normalizeAndStemToTokens(text);

  if (!Array.isArray(products) || products.length === 0 || customerTokens.length === 0) {
    return { product: null, score: 0, matched: false, flaggedTerms: [], ambiguous: false };
  }

  // Post-review fix (Critical finding): independent safety net, checked
  // regardless of the scoring outcome below.
  const flaggedTerms = findIntentDenylistHits(customerTokens, intentDenylist);

  const scored = products.map((product) => ({ product, ...bestScoreForProduct(product, customerTokens) }));
  scored.sort((a, b) => b.score - a.score || b.matchedCount - a.matchedCount);

  const top = scored[0];
  const runnerUp = scored[1];

  // Post-review fix (Medium finding): both candidates confidently in
  // contention, too close to call.
  const ambiguous = Boolean(
    top && runnerUp && top.score >= threshold && runnerUp.score >= threshold && top.score - runnerUp.score < ambiguityMargin,
  );

  const scoreClearsThreshold = Boolean(top && top.score >= threshold);
  const matched = scoreClearsThreshold && flaggedTerms.length === 0 && !ambiguous;

  return {
    product: matched ? top.product : null,
    score: top ? top.score : 0,
    matched,
    flaggedTerms,
    ambiguous,
  };
}

module.exports = {
  matchProduct,
  normalizeAndStemToTokens,
  findIntentDenylistHits,
  DEFAULT_MATCH_THRESHOLD,
  TOKEN_MATCH_SIMILARITY_THRESHOLD,
  FREE_UNACCOUNTED_TOKENS_PER_MATCH,
  DEFAULT_AMBIGUITY_MARGIN,
  DEFAULT_INTENT_DENYLIST,
  DENYLIST_SHORT_WORD_EXACT_MATCH_LENGTH,
};
