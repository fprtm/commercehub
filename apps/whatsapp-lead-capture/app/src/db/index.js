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

  return db;
}

module.exports = { createDb };
