'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_INTENT_DENYLIST } = require('./productMatcher');
const { log } = require('../utils/logger');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'products.json');

/**
 * FR-501: the Product catalog used for fuzzy-matching a customer's Q1
 * answer (see src/services/productMatcher.js) is configurable by the
 * business owner without a code change -- the simplest reasonable
 * mechanism for this Entry-tier project, same config-file pattern already
 * established by config/questions.json / questionsLoader.js, rather than a
 * dashboard CRUD screen (judgment call: proportional to this project's
 * "don't overengineer" pattern -- a full Product CRUD UI is what Project
 * 2/3 build for their much larger inventory-management scope, which this
 * project explicitly does not have).
 *
 * Each product is intentionally lightweight -- `{ name, aliases }` only
 * (Settled Decision #2 in
 * docs/sdd/changes/2026-09-01-fuzzy-product-matching.md): no SKU,
 * stock_quantity, low_stock_threshold, or is_active -- those track
 * *inventory*, a concept this project does not have at all.
 *
 * Loading happens on demand (not cached at module-load time), same
 * reasoning as questionsLoader.js: editing config/products.json takes
 * effect on the next server start, and tests can point at a fixture file.
 *
 * A missing file is NOT a startup crash -- it resolves to an empty catalog
 * (the same safe "always no match" state productMatcher.js already treats
 * as a no-op per NFR-502), so a fresh install with no products configured
 * yet still boots and runs; every Q1 answer just goes to the needs_review
 * path until the owner adds products.
 *
 * Post-review fix (adversarial review, "Medium" finding): also validates
 * the catalog for duplicate aliases/names shared across different
 * products (case-insensitive, trimmed) and logs a warning for each one
 * found -- that exact setup (two products both claiming e.g. `"kaos"`) is
 * what makes a bare "kaos" message genuinely ambiguous, which
 * productMatcher.js's ambiguity-margin check (see that file) then also
 * catches at match time. This is a load-time early-warning for the owner/
 * operator, not a hard error -- an ambiguous catalog is a configuration
 * smell worth flagging, not something that should crash the server.
 *
 * @param {string} [configPath]
 * @returns {{
 *   products: Array<{name: string, aliases?: string[]}>,
 *   matchThreshold: number|undefined,
 *   intentDenylist: string[],
 * }}
 *   `matchThreshold` is `undefined` when the config file omits it (or the
 *   file itself is missing) -- callers fall back to
 *   productMatcher.js's DEFAULT_MATCH_THRESHOLD in that case (see
 *   src/server.js's resolveMatchThreshold()). `intentDenylist` is always a
 *   concrete array: productMatcher.js's DEFAULT_INTENT_DENYLIST, unioned
 *   with any additional words from the config file's optional
 *   "intentDenylist" field (client-extensible, per the change doc's
 *   Critical-fix requirement) -- the coded defaults are always active as a
 *   safety floor and cannot be removed via config, only added to.
 */
function loadProductsConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    return { products: [], matchThreshold: undefined, intentDenylist: [...DEFAULT_INTENT_DENYLIST] };
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);

  const products = Array.isArray(config.products) ? config.products : [];
  for (const product of products) {
    if (!product || typeof product.name !== 'string' || product.name.trim().length === 0) {
      throw new Error('Each product in products.json needs a non-empty "name" string');
    }
    if (product.aliases !== undefined && !Array.isArray(product.aliases)) {
      throw new Error(`Product "${product.name}"'s "aliases" must be an array of strings if present`);
    }
  }

  if (config.intentDenylist !== undefined && !Array.isArray(config.intentDenylist)) {
    throw new Error('products.json\'s "intentDenylist" must be an array of strings if present');
  }

  warnOnDuplicateAliases(products);

  const intentDenylist = Array.from(new Set([...DEFAULT_INTENT_DENYLIST, ...(config.intentDenylist || [])]));

  return {
    products,
    matchThreshold: typeof config.matchThreshold === 'number' ? config.matchThreshold : undefined,
    intentDenylist,
  };
}

/**
 * Post-review fix (Medium finding): logs a warning for every candidate
 * string (a product's name, or one of its aliases) that is shared by two
 * or more DIFFERENT products, case-insensitive/trimmed. This is exactly
 * the catalog shape that makes a short customer message genuinely
 * ambiguous between products (see productMatcher.js's ambiguity-margin
 * check) -- flagging it at load time lets the owner fix the catalog
 * (usually by making one of the shared aliases more specific) before a
 * real customer message ever hits it.
 *
 * @param {Array<{name: string, aliases?: string[]}>} products
 */
function warnOnDuplicateAliases(products) {
  const owners = new Map(); // normalized candidate string -> Set of product names

  for (const product of products) {
    const candidates = [product.name, ...(product.aliases || [])];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const normalized = candidate.trim().toLowerCase();
      if (normalized.length === 0) continue;
      if (!owners.has(normalized)) owners.set(normalized, new Set());
      owners.get(normalized).add(product.name);
    }
  }

  for (const [candidate, productNames] of owners.entries()) {
    if (productNames.size > 1) {
      log('products_config_duplicate_alias_warning', {
        candidate,
        products: Array.from(productNames),
        message:
          'This name/alias is shared by more than one product -- a customer message matching only this word will be flagged ambiguous (needs_review) instead of confidently resolved. Consider making it more specific to one product.',
      });
    }
  }
}

module.exports = { loadProductsConfig, DEFAULT_CONFIG_PATH };
