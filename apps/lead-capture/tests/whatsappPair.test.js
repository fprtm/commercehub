'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('./helpers/testApp');

async function loginAndGetCookie(ctx) {
  const res = await fetch(`${ctx.baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=owner&password=secret-password',
    redirect: 'manual',
  });
  return res.headers.get('set-cookie').split(';')[0];
}

function fakeBaileysConnector(status) {
  const resetCalls = [];
  return {
    getStatus: () => status,
    async resetAndRestart() {
      resetCalls.push(true);
    },
    resetCalls,
  };
}

test('FR-303: GET /whatsapp/pair requires authentication, same as the leads dashboard', async () => {
  const ctx = await startTestServer({ whatsappMode: 'baileys', baileysConnector: fakeBaileysConnector({ connectionStatus: 'open', qrDataUrl: null }) });
  try {
    const res = await fetch(`${ctx.baseUrl}/whatsapp/pair`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/login/);
  } finally {
    await ctx.close();
  }
});

test('cloud_api mode (the default): the pairing screen says Baileys is not active, and does not show the ban-risk notice', async () => {
  const ctx = await startTestServer(); // whatsappMode defaults to 'cloud_api', no baileysConnector
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/whatsapp/pair`, { headers: { Cookie: cookie } });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /Baileys mode is not active/);
    assert.doesNotMatch(html, /Ban-risk trade-off/);
  } finally {
    await ctx.close();
  }
});

test('NFR-303: baileys mode always renders the ban-risk disclosure, regardless of connection status', async () => {
  const ctx = await startTestServer({
    whatsappMode: 'baileys',
    baileysConnector: fakeBaileysConnector({ connectionStatus: 'open', qrDataUrl: null }),
  });
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/whatsapp/pair`, { headers: { Cookie: cookie } });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /Ban-risk trade-off/);
    assert.match(html, /risk of being banned/i);
    assert.match(html, /Connected\./);
  } finally {
    await ctx.close();
  }
});

test('FR-303: qr_pending status renders the QR code as an image data URI', async () => {
  const ctx = await startTestServer({
    whatsappMode: 'baileys',
    baileysConnector: fakeBaileysConnector({ connectionStatus: 'qr_pending', qrDataUrl: 'data:image/png;base64,ABC123' }),
  });
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/whatsapp/pair`, { headers: { Cookie: cookie } });
    const html = await res.text();

    assert.match(html, /<img class="qr" src="data:image\/png;base64,ABC123"/);
    assert.match(html, /Scan to connect/);
  } finally {
    await ctx.close();
  }
});

test('FR-305: action_needed status (e.g. logged out) shows "reconnect needed" (never a silent dead bot) and offers a way to re-pair', async () => {
  const ctx = await startTestServer({
    whatsappMode: 'baileys',
    baileysConnector: fakeBaileysConnector({
      connectionStatus: 'action_needed',
      qrDataUrl: null,
      disconnectReasonMessage: 'The WhatsApp session was logged out from the phone (e.g. removed from Linked Devices there).',
    }),
  });
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/whatsapp/pair`, { headers: { Cookie: cookie } });
    const html = await res.text();

    assert.match(html, /Reconnect needed/);
    assert.match(html, /logged out from the phone/);
    assert.match(html, /will <strong>not<\/strong> keep retrying/);
    assert.match(html, /action="\/whatsapp\/pair\/reset"/);
  } finally {
    await ctx.close();
  }
});

test('FR-305 (post-review fix): action_needed for a non-loggedOut reason (e.g. connection replaced) shows that reason\'s specific message, not a generic one', async () => {
  const ctx = await startTestServer({
    whatsappMode: 'baileys',
    baileysConnector: fakeBaileysConnector({
      connectionStatus: 'action_needed',
      qrDataUrl: null,
      disconnectReasonMessage: 'This WhatsApp number is now linked to a different device/session, which replaced this one.',
    }),
  });
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/whatsapp/pair`, { headers: { Cookie: cookie } });
    const html = await res.text();

    assert.match(html, /Reconnect needed/);
    assert.match(html, /linked to a different device\/session/);
    assert.doesNotMatch(html, /logged out from the phone/, 'should not show the loggedOut-specific wording for a different reason');
  } finally {
    await ctx.close();
  }
});

test('FR-305: POST /whatsapp/pair/reset calls resetAndRestart() on the connector and redirects back to the pairing screen', async () => {
  const connector = fakeBaileysConnector({ connectionStatus: 'action_needed', qrDataUrl: null });
  const ctx = await startTestServer({ whatsappMode: 'baileys', baileysConnector: connector });
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/whatsapp/pair/reset`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    // Drain the response body before the `finally` block closes the
    // server -- an unread body on a `redirect: 'manual'` response was
    // observed to keep the underlying keep-alive socket open, which made
    // ctx.close() (server.close()) block for several seconds waiting for
    // it to end naturally.
    await res.text();

    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/whatsapp\/pair/);
    assert.equal(connector.resetCalls.length, 1);
  } finally {
    await ctx.close();
  }
});

test('reconnecting status shows an in-progress message, not an error', async () => {
  const ctx = await startTestServer({
    whatsappMode: 'baileys',
    baileysConnector: fakeBaileysConnector({ connectionStatus: 'reconnecting', qrDataUrl: null }),
  });
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/whatsapp/pair`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /Reconnecting…/);
  } finally {
    await ctx.close();
  }
});
