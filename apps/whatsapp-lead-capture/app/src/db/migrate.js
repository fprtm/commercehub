'use strict';

// Standalone migration runner: `npm run migrate`
// Applies schema.sql (idempotent -- uses CREATE TABLE IF NOT EXISTS) against
// the configured DATABASE_PATH, creating the file and the data/ directory
// if they don't exist yet.

require('dotenv').config();
const path = require('path');
const { createDb } = require('./index');

const dbPath = process.env.DATABASE_PATH || './data/leads.db';
const resolvedPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);

const db = createDb(resolvedPath);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((row) => row.name);

console.log(`Migration complete. Database file: ${resolvedPath}`);
console.log(`Tables: ${tables.join(', ')}`);

db.close();
