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

/**
 * FR-902 data-fix migration (docs/sdd/changes/2026-09-02-fix-matching-safety-bugs.md,
 * Bug 2): the original config/products.json shipped a bare "kaos" alias on
 * "Kaos Rimba Navy" -- a generic single-word alias that made every OTHER
 * kaos-family product's own full name unmatchable (see productMatcher.js's
 * ambiguity-margin check and this change doc's Bug 2 section). Removing it
 * from config/products.json (done as part of this same fix) only affects a
 * FRESH install's first-boot seed -- per seedProductsFromJsonIfEmpty()'s
 * own doc comment above, config/products.json's `"products"` array is read
 * exactly once (the first boot after an empty `products` table) and never
 * again, so any install that already completed that one-time seed BEFORE
 * this fix shipped is stuck with the bad alias sitting in its `products`
 * table row forever, unless something explicitly corrects it.
 *
 * Judgment call (documented per the change spec's request): rather than
 * add a new "have I migrated" flag/column -- this project deliberately
 * avoids that kind of extra state; see seedProductsFromJsonIfEmpty()'s own
 * doc comment on why it gates on table emptiness instead of a flag -- this
 * backfill is gated the same way: it looks for the literal bad state (a
 * product literally named "Kaos Rimba Navy" that still literally carries a
 * bare "kaos" alias) and removes only that one alias. That makes it: (a)
 * a no-op forever once nothing matches (including on every fresh install,
 * which never has the bad alias to begin with after the JSON fix), (b)
 * self-healing if an already-fixed install is ever restored from an old
 * backup, and (c) safe to call unconditionally on every boot, same as
 * seedProductsFromJsonIfEmpty() above. It deliberately touches ONLY that
 * one exact alias string on that one exact product -- every other alias
 * ("kaos navy", "baju kaos") and every other product are left completely
 * untouched, so it can never silently undo an unrelated customization an
 * owner made through the dashboard.
 *
 * This *was* considered unnecessary ("fresh installs only, document and
 * move on") since this is a small portfolio-scope project with no real
 * multi-tenant install base -- but this repo's own local dev DB
 * (data/leads.db, gitignored) already has a row seeded with the bad alias
 * from before this fix, which is a live, concrete instance of exactly the
 * "existing install" case the change spec asks about. Since a real,
 * findable instance of the bug exists, fixing it beats documenting around
 * it.
 *
 * @param {object} params
 * @param {ReturnType<typeof import('./productsRepo').createProductsRepo>} params.productsRepo
 * @returns {{ fixed: boolean }}
 */
function fixBareKaosAliasOnExistingInstalls({ productsRepo }) {
  const navy = productsRepo.listAll().find((product) => product.name === 'Kaos Rimba Navy');
  if (!navy) return { fixed: false };

  const hasBareKaosAlias = navy.aliases.some((alias) => alias.trim().toLowerCase() === 'kaos');
  if (!hasBareKaosAlias) return { fixed: false };

  const fixedAliases = navy.aliases.filter((alias) => alias.trim().toLowerCase() !== 'kaos');
  productsRepo.update(navy.id, { name: navy.name, aliases: fixedAliases });

  log('products_bare_kaos_alias_removed_from_existing_install', {
    productId: navy.id,
    productName: navy.name,
    remainingAliases: fixedAliases,
  });
  return { fixed: true };
}

module.exports = { seedProductsFromJsonIfEmpty, fixBareKaosAliasOnExistingInstalls };
