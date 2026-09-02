'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../src/db');
const { createSettingsRepo } = require('../src/services/settingsRepo');

/**
 * Unit coverage for the new `app_settings` single-row table and its repo
 * (docs/sdd/changes/2026-09-01-auto-reply-toggle.md, "Settled Decisions" #4).
 */

test('app_settings: schema seeds exactly one row with auto_reply_enabled defaulted to true', () => {
  const db = createDb(':memory:');
  const rows = db.prepare('SELECT * FROM app_settings').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].auto_reply_enabled, 1);
  db.close();
});

test('settingsRepo.isAutoReplyEnabled(): true by default on a freshly-created DB (FR-403 default)', () => {
  const db = createDb(':memory:');
  const settingsRepo = createSettingsRepo(db);
  assert.equal(settingsRepo.isAutoReplyEnabled(), true);
  db.close();
});

test('settingsRepo.setAutoReplyEnabled()/toggleAutoReply(): round-trips and flips correctly', () => {
  const db = createDb(':memory:');
  const settingsRepo = createSettingsRepo(db);

  assert.equal(settingsRepo.setAutoReplyEnabled(false), false);
  assert.equal(settingsRepo.isAutoReplyEnabled(), false);

  assert.equal(settingsRepo.toggleAutoReply(), true);
  assert.equal(settingsRepo.isAutoReplyEnabled(), true);

  assert.equal(settingsRepo.toggleAutoReply(), false);
  assert.equal(settingsRepo.isAutoReplyEnabled(), false);

  db.close();
});

test('NFR-401: settingsRepo reads are fresh, not cached -- a second repo instance on the same DB sees a write immediately', () => {
  const db = createDb(':memory:');
  const writerRepo = createSettingsRepo(db);
  const readerRepo = createSettingsRepo(db);

  assert.equal(readerRepo.isAutoReplyEnabled(), true);
  writerRepo.setAutoReplyEnabled(false);
  // No caching layer between the two repo instances (both hit SQLite
  // directly on every call) -- the reader must see the writer's change on
  // its very next call, not after some TTL/refresh.
  assert.equal(readerRepo.isAutoReplyEnabled(), false);

  writerRepo.setAutoReplyEnabled(true);
  assert.equal(readerRepo.isAutoReplyEnabled(), true);

  db.close();
});

/**
 * Unit coverage for the owner-fillable connector credentials
 * (docs/sdd/changes/2026-09-03-credentials-in-db.md) -- moved out of `.env`
 * and into this same `app_settings` row.
 */

test('settingsRepo.getWhatsappCloudApiCredentials()/getTelegramBotToken(): all null on a freshly-created DB (nothing configured yet)', () => {
  const db = createDb(':memory:');
  const settingsRepo = createSettingsRepo(db);

  assert.deepEqual(settingsRepo.getWhatsappCloudApiCredentials(), {
    verifyToken: null,
    accessToken: null,
    phoneNumberId: null,
    appSecret: null,
  });
  assert.equal(settingsRepo.getTelegramBotToken(), null);

  db.close();
});

test('settingsRepo.setWhatsappCloudApiCredentials(): round-trips all 4 fields and persists across a second repo instance (NFR-401)', () => {
  const db = createDb(':memory:');
  const writerRepo = createSettingsRepo(db);
  const readerRepo = createSettingsRepo(db);

  const saved = writerRepo.setWhatsappCloudApiCredentials({
    verifyToken: 'my-verify-token',
    accessToken: 'EAAG...',
    phoneNumberId: '123456789',
    appSecret: 'app-secret-value',
  });
  assert.deepEqual(saved, {
    verifyToken: 'my-verify-token',
    accessToken: 'EAAG...',
    phoneNumberId: '123456789',
    appSecret: 'app-secret-value',
  });
  assert.deepEqual(readerRepo.getWhatsappCloudApiCredentials(), saved);

  db.close();
});

test('settingsRepo.setTelegramBotToken(): round-trips and null clears it back to "not configured"', () => {
  const db = createDb(':memory:');
  const settingsRepo = createSettingsRepo(db);

  assert.equal(settingsRepo.setTelegramBotToken('123456:ABC-token'), '123456:ABC-token');
  assert.equal(settingsRepo.getTelegramBotToken(), '123456:ABC-token');

  assert.equal(settingsRepo.setTelegramBotToken(null), null);
  assert.equal(settingsRepo.getTelegramBotToken(), null);

  db.close();
});

test('db migration: reopening a pre-existing on-disk DB that predates the credential columns backfills them as NULL, not a crash', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Database = require('better-sqlite3');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-capture-settings-migration-'));
  const dbPath = path.join(dir, 'leads.db');
  try {
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        auto_reply_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_reply_enabled IN (0, 1))
      );
    `);
    legacyDb.prepare('INSERT INTO app_settings (id, auto_reply_enabled) VALUES (1, 1)').run();
    legacyDb.close();

    const db = createDb(dbPath);
    const settingsRepo = createSettingsRepo(db);
    assert.equal(settingsRepo.isAutoReplyEnabled(), true, 'pre-existing column/value must survive the migration untouched');
    assert.deepEqual(settingsRepo.getWhatsappCloudApiCredentials(), {
      verifyToken: null,
      accessToken: null,
      phoneNumberId: null,
      appSecret: null,
    });
    assert.equal(settingsRepo.getTelegramBotToken(), null);
    // Prove the columns are actually writable post-migration, not just
    // present-but-broken.
    assert.equal(settingsRepo.setTelegramBotToken('a-token'), 'a-token');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
