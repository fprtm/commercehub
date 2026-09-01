'use strict';

const { log } = require('../utils/logger');

/**
 * FR-702's one-time JSON -> database migration (NFR-703: must be
 * idempotent -- re-running it must never create duplicates).
 *
 * Gated purely on "is the `products` table currently empty?" -- not a
 * separate "have I already seeded once" flag/column. This is deliberately
 * the simplest thing that satisfies NFR-703: the very first boot after this
 * change (empty table) seeds once from whatever `config/products.json`
 * currently contains; every boot after that (table non-empty, whether from
 * that seed or from products created/edited via the dashboard since) is a
 * no-op, forever, with zero extra state to track or get out of sync. It's
 * also self-healing in an edge case that doesn't need a name: an operator
 * who wipes the table back to empty gets exactly one more seed on the next
 * boot, same as a genuinely fresh install would.
 *
 * Deliberately takes an already-loaded `products` array (see
 * src/services/productsLoader.js's loadProductsConfig()) rather than a file
 * path -- the caller (src/server.js) already loads config/products.json
 * once for matchThreshold/intentDenylist, so this reuses that same parsed
 * result instead of re-reading/re-validating the file a second time (which
 * would also double up productsLoader.js's duplicate-alias warning logs).
 *
 * After this runs (or is skipped because the table already has rows),
 * config/products.json's `"products"` array is never read again anywhere
 * in production wiring -- see src/services/inboundMessageProcessor.js,
 * which sources live matching data from productsRepo.listActive() instead.
 *
 * @param {object} params
 * @param {ReturnType<typeof import('./productsRepo').createProductsRepo>} params.productsRepo
 * @param {Array<{name: string, aliases?: string[]}>} params.products - the
 *   already-loaded config/products.json catalog (loadProductsConfig()'s
 *   `products` field). An empty/missing array is a safe no-op, same as a
 *   missing config/products.json file already is elsewhere in this app.
 * @returns {{ seeded: boolean, count: number }}
 */
function seedProductsFromJsonIfEmpty({ productsRepo, products }) {
  if (!productsRepo.isEmpty()) {
    return { seeded: false, count: 0 };
  }
  if (!Array.isArray(products) || products.length === 0) {
    return { seeded: false, count: 0 };
  }

  for (const product of products) {
    productsRepo.create({ name: product.name, aliases: product.aliases || [] });
  }

  log('products_seeded_from_json', { count: products.length });
  return { seeded: true, count: products.length };
}

module.exports = { seedProductsFromJsonIfEmpty };
