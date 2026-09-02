'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Creates (or opens) a SQLite database at `dbPath` and applies the schema.
 * `dbPath` may also be ':memory:' for isolated/fast test databases.
 *
 * Kept as a factory (rather than a module-level singleton) so tests and
 * `src/server.js` can each construct their own independent instance --
 * this is what lets the webhook/dashboard integration tests run against a
 * throwaway in-memory database instead of the real leads.db file.
 */
function createDb(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    // WAL mode doesn't apply to in-memory databases (used by the test
    // suite); setting it there is a harmless no-op on some builds but has
    // been observed to interact badly with process teardown, so it's
    // scoped to real files only.
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  // docs/sdd/changes/2026-09-02-capture-post-completion-messages.md
  // (FR-801/FR-802): `CREATE TABLE IF NOT EXISTS` above is a no-op against
  // any `leads` table that already existed before this change shipped (a
  // real, pre-existing data/leads.db file, not a fresh :memory: test DB) --
  // it does NOT add the two new columns to it. Every column added to
  // `leads` before this one got away without an explicit migration step
  // because the physical DB file happened to be deleted/recreated by hand
  // each time; that stops being safe once there's real data worth keeping
  // (this project's own data/leads.db already has a row in it). This is the
  // lightest fix that doesn't require a full migration-runner framework for
  // one project's one demo table: check for each new column and add it if
  // missing, every time the DB is opened (idempotent, negligible cost, same
  // "no caching / always current" spirit as productsRepo/settingsRepo
  // elsewhere in this codebase).
  ensureLeadsColumns(db);

  return db;
}

/**
 * Adds `leads` columns introduced after the original CREATE TABLE if this
 * is an existing DB file that predates them. See the doc comment above
 * `ensureLeadsColumns(db)`'s call site for why this exists.
 */
function ensureLeadsColumns(db) {
  const existingColumns = new Set(db.prepare('PRAGMA table_info(leads)').all().map((col) => col.name));
  const newColumns = [
    ['matched_product_score', 'REAL'],
    ['additional_notes', 'TEXT'],
    // docs/sdd/changes/2026-09-02-numbered-product-selection.md, HIGH-severity
    // post-review fix -- see schema.sql's doc comment on this column.
    ['shown_product_ids', 'TEXT'],
  ];
  for (const [name, type] of newColumns) {
    if (!existingColumns.has(name)) {
      db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`);
    }
  }
}

module.exports = { createDb };
