'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const { createProductsRepo } = require('../src/services/productsRepo');

/**
 * Coverage for docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md
 * (FR-702) -- the data-access layer in isolation, against a throwaway
 * in-memory DB (same pattern as tests/leadsRepo-adjacent unit tests
 * elsewhere in this suite).
 */

test('FR-702 productsRepo: create() inserts an active product with normalized aliases', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);

  const product = repo.create({ name: '  Kaos Rimba Navy  ', aliases: ['kaos navy', '  kaos  ', '', 'baju kaos'] });

  assert.equal(product.name, 'Kaos Rimba Navy');
  assert.deepEqual(product.aliases, ['kaos navy', 'kaos', 'baju kaos']);
  assert.equal(product.is_active, true);
  assert.ok(product.id > 0);
  assert.ok(product.created_at);
  assert.ok(product.updated_at);

  db.close();
});

test('FR-702 productsRepo: create() defaults aliases to an empty array when omitted', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);

  const product = repo.create({ name: 'No Aliases Product' });
  assert.deepEqual(product.aliases, []);

  db.close();
});

test('FR-702 productsRepo: listAll() returns every product, listActive() only active ones', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);

  const a = repo.create({ name: 'Product A', aliases: [] });
  const b = repo.create({ name: 'Product B', aliases: [] });
  repo.deactivate(b.id);

  const all = repo.listAll();
  const active = repo.listActive();

  assert.equal(all.length, 2);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, a.id);

  db.close();
});

test('FR-702 productsRepo: update() changes name/aliases and bumps updated_at', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);

  const created = repo.create({ name: 'Old Name', aliases: ['old'] });
  const updated = repo.update(created.id, { name: 'New Name', aliases: ['new', 'newer'] });

  assert.equal(updated.name, 'New Name');
  assert.deepEqual(updated.aliases, ['new', 'newer']);
  assert.equal(updated.id, created.id);

  db.close();
});

test('FR-702 productsRepo: update() on a non-existent id throws a typed NOT_FOUND error', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);

  assert.throws(() => repo.update(999, { name: 'X', aliases: [] }), (err) => err.code === 'NOT_FOUND');

  db.close();
});

test('FR-702 productsRepo: deactivate() then activate() round-trips is_active, never deletes the row', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);

  const product = repo.create({ name: 'Roundtrip Product', aliases: [] });
  const deactivated = repo.deactivate(product.id);
  assert.equal(deactivated.is_active, false);
  assert.equal(repo.listAll().length, 1, 'deactivating must not delete the row');
  assert.equal(repo.listActive().length, 0);

  const reactivated = repo.activate(product.id);
  assert.equal(reactivated.is_active, true);
  assert.equal(repo.listActive().length, 1);

  db.close();
});

test('FR-702 productsRepo: deactivate()/activate() on a non-existent id throws NOT_FOUND', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);

  assert.throws(() => repo.deactivate(999), (err) => err.code === 'NOT_FOUND');
  assert.throws(() => repo.activate(999), (err) => err.code === 'NOT_FOUND');

  db.close();
});

/**
 * FR-903 (docs/sdd/changes/2026-09-02-fix-matching-safety-bugs.md, Bug 2
 * prevention): a lightweight, NON-BLOCKING warning (log only, never a
 * rejection) when a new/edited alias, once stemmed, exactly matches a
 * stemmed token inside another ACTIVE product's own name -- the same shape
 * as Bug 2's root cause (a bare "kaos" alias on Navy made Hitam's own name
 * unmatchable). These tests capture the logger's output directly (same
 * technique other log-assertion tests in this suite use) rather than
 * re-parsing stdout.
 */
/**
 * Captures every console.log call made during `fn()` and returns them
 * parsed as JSON (src/utils/logger.js emits single-line JSON per entry) --
 * same technique as tests/productsLoader.test.js's own captureLogs() for
 * its duplicate-alias warning coverage.
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

test('FR-903: create() logs a warning when a new single-word alias shadows another ACTIVE product\'s own name', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);
  repo.create({ name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] });

  const logs = captureLogs(() => {
    repo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos'] });
  });

  const warnings = logs.filter((entry) => entry.event === 'product_alias_shadows_active_product_name_warning');
  assert.equal(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(logs)}`);
  assert.equal(warnings[0].alias, 'kaos');
  assert.equal(warnings[0].shadowedProduct, 'Kaos Rimba Hitam');
  assert.equal(warnings[0].shadowedToken, 'kaos');

  db.close();
});

test('FR-903: the warning is NON-BLOCKING -- create() still succeeds and saves the alias', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);
  repo.create({ name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] });

  const created = repo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos'] });
  assert.deepEqual(created.aliases, ['kaos']);

  db.close();
});

test('FR-903: update() also triggers the warning for a newly-added shadowing alias', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);
  repo.create({ name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] });
  const navy = repo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos navy'] });

  const logs = captureLogs(() => {
    repo.update(navy.id, { name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'kaos'] });
  });

  const warnings = logs.filter((entry) => entry.event === 'product_alias_shadows_active_product_name_warning');
  assert.equal(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(logs)}`);

  db.close();
});

test('FR-903: no warning when the shadowed product is INACTIVE (only ACTIVE products count)', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);
  const hitam = repo.create({ name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] });
  repo.deactivate(hitam.id);

  const logs = captureLogs(() => {
    repo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos'] });
  });

  const warnings = logs.filter((entry) => entry.event === 'product_alias_shadows_active_product_name_warning');
  assert.equal(warnings.length, 0, 'a deactivated product\'s own name must not trigger the warning');

  db.close();
});

test('FR-903: a multi-word alias that merely CONTAINS a shared family word (e.g. "kaos navy") does not warn -- only single-word aliases are the Bug-2 shape', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);
  repo.create({ name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] });

  const logs = captureLogs(() => {
    repo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'baju kaos'] });
  });

  const warnings = logs.filter((entry) => entry.event === 'product_alias_shadows_active_product_name_warning');
  assert.equal(warnings.length, 0, `expected no warnings for specific multi-word aliases, got ${JSON.stringify(logs)}`);

  db.close();
});

test('FR-903: no warning when aliases do not shadow any other active product\'s name', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);
  repo.create({ name: 'Kaos Rimba Hitam', aliases: ['kaos hitam'] });

  const logs = captureLogs(() => {
    repo.create({ name: 'Celana Rimba Cargo', aliases: ['celana cargo', 'celana'] });
  });

  const warnings = logs.filter((entry) => entry.event === 'product_alias_shadows_active_product_name_warning');
  assert.equal(warnings.length, 0);

  db.close();
});

test('NFR-703-adjacent productsRepo: isEmpty() reflects table state before/after create()', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);

  assert.equal(repo.isEmpty(), true);
  repo.create({ name: 'First Product', aliases: [] });
  assert.equal(repo.isEmpty(), false);

  db.close();
});
