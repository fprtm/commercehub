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
      const now = new Date().toISOString();
      const info = insertStmt.run({
        name: String(name).trim(),
        aliases: JSON.stringify(normalizeAliases(aliases)),
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
      updateStmt.run({
        id,
        name: String(name).trim(),
        aliases: JSON.stringify(normalizeAliases(aliases)),
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
