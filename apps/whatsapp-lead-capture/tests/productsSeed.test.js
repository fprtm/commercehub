'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const { createProductsRepo } = require('../src/services/productsRepo');
const { seedProductsFromJsonIfEmpty } = require('../src/services/productsSeed');

const SAMPLE_CATALOG = [
  { name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'kaos'] },
  { name: 'Celana Rimba Cargo', aliases: ['celana cargo'] },
];

/**
 * NFR-703 (docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md):
 * "the one-time JSON->database product seeding must not create duplicates
 * if run more than once." This is the direct proof of that: run the
 * exact same seed step twice against the same DB and assert the second
 * run is a complete no-op.
 */

test('NFR-703: seeds the empty products table from the JSON catalog exactly once, even if called twice', () => {
  const db = createDb(':memory:');
  const productsRepo = createProductsRepo(db);

  const first = seedProductsFromJsonIfEmpty({ productsRepo, products: SAMPLE_CATALOG });
  assert.equal(first.seeded, true);
  assert.equal(first.count, 2);
  assert.equal(productsRepo.listAll().length, 2);

  const second = seedProductsFromJsonIfEmpty({ productsRepo, products: SAMPLE_CATALOG });
  assert.equal(second.seeded, false, 're-running the seed step once the table is non-empty must be a no-op');
  assert.equal(second.count, 0);
  assert.equal(productsRepo.listAll().length, 2, 'no duplicate rows must be created by a second run');

  const names = productsRepo.listAll().map((p) => p.name).sort();
  assert.deepEqual(names, ['Celana Rimba Cargo', 'Kaos Rimba Navy']);

  db.close();
});

test('NFR-703: seeding a third/fourth time (simulating multiple restarts) still creates zero duplicates', () => {
  const db = createDb(':memory:');
  const productsRepo = createProductsRepo(db);

  seedProductsFromJsonIfEmpty({ productsRepo, products: SAMPLE_CATALOG });
  seedProductsFromJsonIfEmpty({ productsRepo, products: SAMPLE_CATALOG });
  seedProductsFromJsonIfEmpty({ productsRepo, products: SAMPLE_CATALOG });

  assert.equal(productsRepo.listAll().length, 2, 'repeated restarts must never accumulate duplicate seeded rows');

  db.close();
});

test('FR-702: seeding is a safe no-op when the JSON catalog is empty (fresh install with no products.json)', () => {
  const db = createDb(':memory:');
  const productsRepo = createProductsRepo(db);

  const result = seedProductsFromJsonIfEmpty({ productsRepo, products: [] });
  assert.equal(result.seeded, false);
  assert.equal(productsRepo.listAll().length, 0);

  db.close();
});

test('FR-702: seeding is a safe no-op when `products` is undefined (e.g. a missing config/products.json)', () => {
  const db = createDb(':memory:');
  const productsRepo = createProductsRepo(db);

  assert.doesNotThrow(() => seedProductsFromJsonIfEmpty({ productsRepo, products: undefined }));
  assert.equal(productsRepo.listAll().length, 0);

  db.close();
});

test('NFR-703: does NOT seed when the table already has rows from a source other than the JSON seed (e.g. a product created via the dashboard first)', () => {
  const db = createDb(':memory:');
  const productsRepo = createProductsRepo(db);
  productsRepo.create({ name: 'Manually Added Product', aliases: [] });

  const result = seedProductsFromJsonIfEmpty({ productsRepo, products: SAMPLE_CATALOG });
  assert.equal(result.seeded, false);
  assert.equal(productsRepo.listAll().length, 1);
  assert.equal(productsRepo.listAll()[0].name, 'Manually Added Product');

  db.close();
});

test('FR-702: seeded products carry over their aliases from the JSON catalog', () => {
  const db = createDb(':memory:');
  const productsRepo = createProductsRepo(db);

  seedProductsFromJsonIfEmpty({ productsRepo, products: SAMPLE_CATALOG });

  const navy = productsRepo.listAll().find((p) => p.name === 'Kaos Rimba Navy');
  assert.deepEqual(navy.aliases, ['kaos navy', 'kaos']);
  assert.equal(navy.is_active, true);

  db.close();
});
