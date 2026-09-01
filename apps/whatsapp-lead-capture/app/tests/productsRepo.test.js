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

test('NFR-703-adjacent productsRepo: isEmpty() reflects table state before/after create()', () => {
  const db = createDb(':memory:');
  const repo = createProductsRepo(db);

  assert.equal(repo.isEmpty(), true);
  repo.create({ name: 'First Product', aliases: [] });
  assert.equal(repo.isEmpty(), false);

  db.close();
});
