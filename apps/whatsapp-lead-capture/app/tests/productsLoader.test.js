'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadProductsConfig, DEFAULT_CONFIG_PATH } = require('../src/services/productsLoader');
const { DEFAULT_INTENT_DENYLIST } = require('../src/services/productMatcher');

/**
 * Captures every console.log call made during `fn()` and returns them
 * parsed as JSON (src/utils/logger.js emits single-line JSON per entry).
 * Used to assert on the duplicate-alias load-time warning below without
 * depending on real stdout.
 */
function captureLogs(fn) {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.map((line) => JSON.parse(line));
}

test('FR-501 loadProductsConfig: loads the real config/products.json shipped with the app', () => {
  const config = loadProductsConfig();
  assert.ok(fs.existsSync(DEFAULT_CONFIG_PATH));
  assert.ok(Array.isArray(config.products));
  assert.ok(config.products.length > 0);
  assert.ok(config.products[0].name.length > 0);
  assert.equal(typeof config.matchThreshold, 'number');
});

test('FR-501 loadProductsConfig: swapping in a different config file changes the catalog with no code change', () => {
  const tmpPath = path.join(os.tmpdir(), `products-test-${Date.now()}.json`);
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({
      matchThreshold: 0.7,
      products: [{ name: 'Custom Product', aliases: ['custom', 'cp'] }],
    }),
  );
  try {
    const config = loadProductsConfig(tmpPath);
    assert.equal(config.products.length, 1);
    assert.equal(config.products[0].name, 'Custom Product');
    assert.deepEqual(config.products[0].aliases, ['custom', 'cp']);
    assert.equal(config.matchThreshold, 0.7);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('NFR-502 loadProductsConfig: a missing file resolves to an empty catalog, not a crash', () => {
  const missingPath = path.join(os.tmpdir(), `products-does-not-exist-${Date.now()}.json`);
  assert.doesNotThrow(() => {
    const config = loadProductsConfig(missingPath);
    assert.deepEqual(config.products, []);
    assert.equal(config.matchThreshold, undefined);
  });
});

test('loadProductsConfig: aliases are optional per product', () => {
  const tmpPath = path.join(os.tmpdir(), `products-no-aliases-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ products: [{ name: 'No Aliases Product' }] }));
  try {
    const config = loadProductsConfig(tmpPath);
    assert.equal(config.products[0].name, 'No Aliases Product');
    assert.equal(config.products[0].aliases, undefined);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('loadProductsConfig: rejects a product missing a "name"', () => {
  const tmpPath = path.join(os.tmpdir(), `products-bad-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ products: [{ aliases: ['x'] }] }));
  try {
    assert.throws(() => loadProductsConfig(tmpPath), /needs a non-empty "name"/);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('loadProductsConfig: rejects a product whose "aliases" is not an array', () => {
  const tmpPath = path.join(os.tmpdir(), `products-bad-aliases-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ products: [{ name: 'Bad', aliases: 'not-an-array' }] }));
  try {
    assert.throws(() => loadProductsConfig(tmpPath), /must be an array/);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('loadProductsConfig: an empty "products" array in the file is valid (no products configured yet)', () => {
  const tmpPath = path.join(os.tmpdir(), `products-empty-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ products: [] }));
  try {
    const config = loadProductsConfig(tmpPath);
    assert.deepEqual(config.products, []);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

/**
 * Post-review fix (Critical finding, FR-501 extension): the intent
 * denylist is client-extensible via products.json, but the coded defaults
 * are always active as a safety floor.
 */
test('loadProductsConfig: intentDenylist always includes the coded defaults, even with no config field at all', () => {
  const tmpPath = path.join(os.tmpdir(), `products-no-denylist-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ products: [] }));
  try {
    const config = loadProductsConfig(tmpPath);
    for (const word of DEFAULT_INTENT_DENYLIST) {
      assert.ok(config.intentDenylist.includes(word), `expected default denylist word "${word}" to be present`);
    }
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('loadProductsConfig: a missing products.json file also resolves to the full default denylist (not an empty one)', () => {
  const missingPath = path.join(os.tmpdir(), `products-missing-denylist-${Date.now()}.json`);
  const config = loadProductsConfig(missingPath);
  assert.deepEqual(config.intentDenylist, DEFAULT_INTENT_DENYLIST);
});

test('loadProductsConfig: a client can extend the intent denylist via products.json, unioned with (not replacing) the coded defaults', () => {
  const tmpPath = path.join(os.tmpdir(), `products-custom-denylist-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ products: [], intentDenylist: ['bocor-halus', 'nyesel'] }));
  try {
    const config = loadProductsConfig(tmpPath);
    assert.ok(config.intentDenylist.includes('bocor-halus'));
    assert.ok(config.intentDenylist.includes('nyesel'));
    // The coded safety floor is still present -- config can only add, not remove.
    assert.ok(config.intentDenylist.includes('refund'));
    assert.ok(config.intentDenylist.includes('rusak'));
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('loadProductsConfig: rejects a non-array "intentDenylist" field', () => {
  const tmpPath = path.join(os.tmpdir(), `products-bad-denylist-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ products: [], intentDenylist: 'refund' }));
  try {
    assert.throws(() => loadProductsConfig(tmpPath), /"intentDenylist" must be an array/);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

/**
 * Post-review fix (Medium finding): a catalog where two different
 * products share a name/alias is exactly the setup that makes a short
 * customer message genuinely ambiguous (see
 * tests/productMatcher.test.js's "AMBIGUITY" tests) -- this should be
 * flagged at load time, not just discovered later against a real message.
 */
test('loadProductsConfig: logs a warning when two different products share an alias (case-insensitive)', () => {
  const tmpPath = path.join(os.tmpdir(), `products-dup-alias-${Date.now()}.json`);
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({
      products: [
        { name: 'Kaos Rimba Navy', aliases: ['Kaos'] },
        { name: 'Kaos Rimba Merah', aliases: ['kaos'] }, // same alias, different case
      ],
    }),
  );
  try {
    const logs = captureLogs(() => loadProductsConfig(tmpPath));
    const warning = logs.find((entry) => entry.event === 'products_config_duplicate_alias_warning');
    assert.ok(warning, `expected a duplicate-alias warning to be logged, got events: ${logs.map((l) => l.event).join(', ')}`);
    assert.equal(warning.candidate, 'kaos');
    assert.deepEqual(new Set(warning.products), new Set(['Kaos Rimba Navy', 'Kaos Rimba Merah']));
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('loadProductsConfig: does NOT warn when aliases are all distinct across products', () => {
  const tmpPath = path.join(os.tmpdir(), `products-no-dup-${Date.now()}.json`);
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({
      products: [
        { name: 'Kaos Rimba Navy', aliases: ['kaos navy'] },
        { name: 'Kaos Rimba Merah', aliases: ['kaos merah'] },
      ],
    }),
  );
  try {
    const logs = captureLogs(() => loadProductsConfig(tmpPath));
    const warning = logs.find((entry) => entry.event === 'products_config_duplicate_alias_warning');
    assert.equal(warning, undefined);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});
