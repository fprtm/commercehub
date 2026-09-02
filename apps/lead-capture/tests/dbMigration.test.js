'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createDb } = require('../src/db');

/**
 * Regression coverage for db/index.js's ensure*Columns() migrations.
 *
 * These must run against a real on-disk file, not ':memory:' -- an
 * in-memory database can't simulate "reopening a pre-existing DB file that
 * predates a column", since each ':memory:' instance starts empty. Every
 * other test in this suite uses createDb(':memory:'), which is exactly why
 * this class of bug (a migration missing for one table while present for
 * another) shipped without a failing test.
 */

function withTempDbPath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-capture-db-migration-'));
  const dbPath = path.join(dir, 'leads.db');
  try {
    return fn(dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('createDb(): reopening a pre-existing on-disk DB that predates failed_events.channel backfills the column', () => {
  withTempDbPath((dbPath) => {
    // Simulate a DB file created before FR-305 (2026-09-01-baileys-dual-mode)
    // added `channel` to failed_events.
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE failed_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_payload TEXT NOT NULL,
        error_message TEXT NOT NULL,
        occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    legacyDb.prepare('INSERT INTO failed_events (raw_payload, error_message) VALUES (?, ?)').run('{}', 'pre-existing failure');
    legacyDb.close();

    const db = createDb(dbPath);
    const columns = db.prepare('PRAGMA table_info(failed_events)').all().map((col) => col.name);
    assert.ok(columns.includes('channel'), 'channel column must be backfilled onto the existing failed_events table');

    // The column addition alone isn't enough -- confirm a real INSERT
    // through the same statement shape failedEventsRepo.record() uses
    // actually succeeds against the migrated table.
    assert.doesNotThrow(() => {
      db.prepare('INSERT INTO failed_events (raw_payload, error_message, channel) VALUES (?, ?, ?)').run('{}', 'post-migration failure', 'whatsapp_baileys');
    });

    const rows = db.prepare('SELECT * FROM failed_events ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].channel, 'whatsapp_cloud_api', 'pre-existing row backfills the documented default');
    assert.equal(rows[1].channel, 'whatsapp_baileys');
    db.close();
  });
});

test('createDb(): reopening a pre-existing on-disk DB that predates leads.contact_id renames phone_number and adds channel', () => {
  withTempDbPath((dbPath) => {
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT NOT NULL CHECK (length(phone_number) > 0),
        first_message_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    legacyDb.prepare('INSERT INTO leads (phone_number, first_message_at) VALUES (?, ?)').run('6281234567890', new Date().toISOString());
    legacyDb.close();

    const db = createDb(dbPath);
    const columns = db.prepare('PRAGMA table_info(leads)').all().map((col) => col.name);
    assert.ok(columns.includes('contact_id'), 'phone_number must be renamed to contact_id');
    assert.ok(!columns.includes('phone_number'));
    assert.ok(columns.includes('channel'));

    const row = db.prepare('SELECT contact_id, channel FROM leads WHERE id = 1').get();
    assert.equal(row.contact_id, '6281234567890');
    assert.equal(row.channel, 'whatsapp', 'pre-existing row backfills the documented default');
    db.close();
  });
});
