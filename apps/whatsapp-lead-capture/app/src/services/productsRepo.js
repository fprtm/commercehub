'use strict';

/**
 * Data-access layer for the `products` table
 * (docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md,
 * FR-702). Follows the same factory-over-a-db-instance pattern as
 * leadsRepo.js/failedEventsRepo.js/settingsRepo.js, so it can be reused
 * against either the real app DB or a throwaway in-memory test DB.
 *
 * This is now the SOURCE OF TRUTH for the Product catalog. `config/products.json`
 * / `src/services/productsLoader.js` still exist, but only for two purposes
 * after this change: (a) the one-time seed of an empty `products` table (see
 * `src/services/productsSeed.js`), and (b) `matchThreshold` /
 * `intentDenylist`, which remain config-file-driven (they are matching
 * *tuning knobs*, not catalog data -- FR-702 only moved the product list
 * itself into the database). Editing `config/products.json`'s `"products"`
 * array after the first boot has zero effect from here on -- see
 * `src/services/inboundMessageProcessor.js` for where `listActive()` below
 * replaces the old static array as the live matching source.
 *
 * `aliases` is stored as a JSON-encoded TEXT column (see schema.sql's
 * comment for why) -- every read here parses it back into a real array, and
 * every write re-serializes a normalized (trimmed, non-empty) array, so
 * callers never have to think about the JSON encoding at all.
 */
const { normalizeAndStemToTokens } = require('./productMatcher');
const { log } = require('../utils/logger');

function createProductsRepo(db) {
  const insertStmt = db.prepare(`
    INSERT INTO products (name, aliases, is_active, created_at, updated_at)
    VALUES (@name, @aliases, @is_active, @created_at, @updated_at)
  `);
  const updateStmt = db.prepare(`
    UPDATE products SET name = @name, aliases = @aliases, updated_at = @updated_at WHERE id = @id
  `);
  const setActiveStmt = db.prepare(`
    UPDATE products SET is_active = @is_active, updated_at = @updated_at WHERE id = @id
  `);
  const findByIdStmt = db.prepare('SELECT * FROM products WHERE id = ?');
  const listAllStmt = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE');
  const listActiveStmt = db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY name COLLATE NOCASE');
  const countAllStmt = db.prepare('SELECT COUNT(*) AS count FROM products');

  /** Row (DB shape, aliases still JSON text) -> domain object (aliases parsed, is_active a real boolean). */
  function toDomain(row) {
    if (!row) return row;
    let aliases;
    try {
      aliases = JSON.parse(row.aliases);
      if (!Array.isArray(aliases)) aliases = [];
    } catch {
      aliases = [];
    }
    return { ...row, aliases, is_active: row.is_active === 1 };
  }

  /** Trims every alias and drops empty ones -- same light normalization productsLoader.js's caller expects. */
  function normalizeAliases(aliases) {
    if (!Array.isArray(aliases)) return [];
    return aliases.map((alias) => String(alias).trim()).filter((alias) => alias.length > 0);
  }

  function requireExisting(id) {
    const existing = findByIdStmt.get(id);
    if (!existing) {
      const err = new Error(`Product not found: ${id}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    return existing;
  }

  /**
   * FR-903 (docs/sdd/changes/2026-09-02-fix-matching-safety-bugs.md, Bug 2
   * prevention): a lightweight, NON-BLOCKING warning -- logged only, never
   * thrown -- for every alias being saved (via create() or update() below)
   * whose stemmed tokens overlap with a stemmed token inside another
   * ACTIVE product's own NAME. This is exactly the shape of Bug 2's root
   * cause (a bare "kaos" alias on Kaos Rimba Navy made Kaos Rimba Hitam's
   * own full name unmatchable): flagging it here, at write time, catches a
   * future catalog edit that recreates the same trap, without blocking the
   * save (an owner may have a legitimate reason, and this project's
   * existing duplicate-alias warning in productsLoader.js's
   * warnOnDuplicateAliases() follows the same "log, don't reject" pattern
   * this mirrors).
   *
   * Runs for BOTH the dashboard CRUD routes (src/routes/products.js, which
   * calls create()/update() directly) and the one-time JSON seed loader
   * (src/services/productsSeed.js, which also calls create() directly and
   * has no alias-processing path of its own) -- putting the check here,
   * not in either caller, covers both for free.
   *
   * Deliberately scoped to SINGLE-TOKEN aliases only (after stemming) --
   * "the new alias ... exactly matches a stemmed token", per FR-903's own
   * wording. A multi-word alias like "kaos navy" also happens to contain
   * the shared family word "kaos", but it is NOT the bug shape being
   * guarded against: its extra token ("navy") makes it specific enough
   * that it does not, by itself, let a generic word alone tie against a
   * sibling product's full name (see productMatcher.js's candidateCoverage
   * scoring -- a 2-token candidate only scores 1.0 when BOTH tokens are
   * present in the customer's text). Checking every token of every
   * multi-word alias against every other active product's name would
   * warn on nearly any alias sharing a common family word (e.g. "kaos" is
   * legitimately in every kaos-family product's own aliases), drowning out
   * the one genuinely dangerous case -- a bare, single generic word acting
   * as an alias all by itself -- in noise.
   *
   * `ownProductId` excludes the product being edited from the "other
   * products" comparison set (irrelevant for create(), since the new row
   * doesn't exist in the table yet at the time this runs).
   *
   * @param {string[]} aliases - already-normalized (trimmed, non-empty).
   * @param {number|undefined} ownProductId
   * @param {string} ownProductName
   */
  function warnOnAliasesShadowingActiveProductNames(aliases, ownProductId, ownProductName) {
    if (!Array.isArray(aliases) || aliases.length === 0) return;

    const otherActiveProducts = listActiveStmt
      .all()
      .map(toDomain)
      .filter((product) => product.id !== ownProductId);
    if (otherActiveProducts.length === 0) return;

    for (const alias of aliases) {
      const aliasTokens = normalizeAndStemToTokens(alias);
      if (aliasTokens.length !== 1) continue; // only single-word aliases are the Bug-2 shape -- see doc comment above
      const [aliasToken] = aliasTokens;

      for (const otherProduct of otherActiveProducts) {
        const nameTokens = normalizeAndStemToTokens(otherProduct.name);
        if (nameTokens.includes(aliasToken)) {
          log('product_alias_shadows_active_product_name_warning', {
            alias,
            ownProduct: ownProductName,
            shadowedProduct: otherProduct.name,
            shadowedToken: aliasToken,
            message:
              'This alias, once stemmed, exactly matches a word inside another ACTIVE product\'s own name -- a customer message naming that other product by name risks tying/losing to this alias (the same shape as the "kaos" bare-alias bug -- FR-902). Consider making this alias more specific.',
          });
        }
      }
    }
  }

  return {
    /** Used by the one-time seed step (productsSeed.js) to decide whether to run at all (NFR-703). */
    isEmpty() {
      return countAllStmt.get().count === 0;
    },

    findById(id) {
      return toDomain(findByIdStmt.get(id));
    },

    /** Every product, active or deactivated -- what the dashboard's /products page lists. */
    listAll() {
      return listAllStmt.all().map(toDomain);
    },

    /** Only active products -- what fuzzy-matching (productMatcher.js) is scored against. */
    listActive() {
      return listActiveStmt.all().map(toDomain);
    },

    /**
     * @param {{ name: string, aliases?: string[] }} params
     */
    create({ name, aliases }) {
      const trimmedName = String(name).trim();
      const normalizedAliases = normalizeAliases(aliases);
      warnOnAliasesShadowingActiveProductNames(normalizedAliases, undefined, trimmedName);
      const now = new Date().toISOString();
      const info = insertStmt.run({
        name: trimmedName,
        aliases: JSON.stringify(normalizedAliases),
        is_active: 1,
        created_at: now,
        updated_at: now,
      });
      return toDomain(findByIdStmt.get(info.lastInsertRowid));
    },

    /**
     * @param {number} id
     * @param {{ name: string, aliases?: string[] }} params
     */
    update(id, { name, aliases }) {
      requireExisting(id);
      const trimmedName = String(name).trim();
      const normalizedAliases = normalizeAliases(aliases);
      warnOnAliasesShadowingActiveProductNames(normalizedAliases, id, trimmedName);
      updateStmt.run({
        id,
        name: trimmedName,
        aliases: JSON.stringify(normalizedAliases),
        updated_at: new Date().toISOString(),
      });
      return toDomain(findByIdStmt.get(id));
    },

    /** Soft-delete (FR-702) -- never removes the row, only flips is_active off. */
    deactivate(id) {
      requireExisting(id);
      setActiveStmt.run({ id, is_active: 0, updated_at: new Date().toISOString() });
      return toDomain(findByIdStmt.get(id));
    },

    /** Reverses deactivate() -- the only "undo" FR-702 scopes in (no history/versioning beyond this). */
    activate(id) {
      requireExisting(id);
      setActiveStmt.run({ id, is_active: 1, updated_at: new Date().toISOString() });
      return toDomain(findByIdStmt.get(id));
    },
  };
}

module.exports = { createProductsRepo };
