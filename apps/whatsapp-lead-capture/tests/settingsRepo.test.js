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
