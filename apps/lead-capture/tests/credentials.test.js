'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('./helpers/testApp');
const { createSettingsRepo } = require('../src/services/settingsRepo');

/**
 * Coverage for docs/sdd/changes/2026-09-03-credentials-in-db.md --
 * GET/POST /settings/credentials, the dashboard page that replaces the
 * WHATSAPP_VERIFY_TOKEN/WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID/
 * WHATSAPP_APP_SECRET/TELEGRAM_BOT_TOKEN env vars.
 */

async function loginAndGetCookie(ctx) {
  const res = await fetch(`${ctx.baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=owner&password=secret-password',
    redirect: 'manual',
  });
  return res.headers.get('set-cookie').split(';')[0];
}

test('GET /settings/credentials requires authentication, same as the rest of the dashboard', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/settings/credentials`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/login/);
  } finally {
    await ctx.close();
  }
});

test('POST /settings/credentials requires authentication', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/settings/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'whatsappAccessToken=should-not-be-saved',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/login/);

    const settingsRepo = createSettingsRepo(ctx.db);
    assert.equal(settingsRepo.getWhatsappCloudApiCredentials().accessToken, null, 'an unauthenticated POST must not write anything');
  } finally {
    await ctx.close();
  }
});

test('GET /settings/credentials on a fresh DB shows every field as not set, and never renders a secret value', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    const html = await (await fetch(`${ctx.baseUrl}/settings/credentials`, { headers: { Cookie: cookie } })).text();

    assert.match(html, /\(not set\)/);
    assert.doesNotMatch(html, /\(set\)/);
  } finally {
    await ctx.close();
  }
});

test('POST /settings/credentials saves all 5 fields, persisted directly in app_settings', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);

    const postRes = await fetch(`${ctx.baseUrl}/settings/credentials`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        whatsappVerifyToken: 'my-verify-token',
        whatsappAccessToken: 'EAAG-access-token',
        whatsappPhoneNumberId: '123456789',
        whatsappAppSecret: 'my-app-secret',
        telegramBotToken: '123456:ABC-bot-token',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(postRes.status, 302);
    assert.match(postRes.headers.get('location'), /\/settings\/credentials/);

    const settingsRepo = createSettingsRepo(ctx.db);
    assert.deepEqual(settingsRepo.getWhatsappCloudApiCredentials(), {
      verifyToken: 'my-verify-token',
      accessToken: 'EAAG-access-token',
      phoneNumberId: '123456789',
      appSecret: 'my-app-secret',
    });
    assert.equal(settingsRepo.getTelegramBotToken(), '123456:ABC-bot-token');

    // The Phone Number ID is the one non-secret field -- it's shown in
    // full on the re-rendered page. The 4 real secrets must never appear.
    const html = await (await fetch(`${ctx.baseUrl}/settings/credentials`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /123456789/);
    assert.doesNotMatch(html, /EAAG-access-token/);
    assert.doesNotMatch(html, /my-app-secret/);
    assert.doesNotMatch(html, /my-verify-token/);
    assert.doesNotMatch(html, /123456:ABC-bot-token/);
    assert.match(html, /\(set\)/);
  } finally {
    await ctx.close();
  }
});

test('POST /settings/credentials: leaving a field blank keeps its existing value, only the submitted fields change', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    const settingsRepo = createSettingsRepo(ctx.db);
    settingsRepo.setWhatsappCloudApiCredentials({
      verifyToken: 'original-verify-token',
      accessToken: 'original-access-token',
      phoneNumberId: '111111111',
      appSecret: 'original-app-secret',
    });
    settingsRepo.setTelegramBotToken('original-bot-token');

    // Only rotate the access token; every other field submitted blank.
    await fetch(`${ctx.baseUrl}/settings/credentials`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        whatsappVerifyToken: '',
        whatsappAccessToken: 'rotated-access-token',
        whatsappPhoneNumberId: '',
        whatsappAppSecret: '',
        telegramBotToken: '',
      }).toString(),
    });

    assert.deepEqual(settingsRepo.getWhatsappCloudApiCredentials(), {
      verifyToken: 'original-verify-token',
      accessToken: 'rotated-access-token',
      phoneNumberId: '111111111',
      appSecret: 'original-app-secret',
    });
    assert.equal(settingsRepo.getTelegramBotToken(), 'original-bot-token', 'blank telegram field must not clear the existing token');
  } finally {
    await ctx.close();
  }
});
