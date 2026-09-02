'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('./helpers/testApp');

/**
 * FR-702 (docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md):
 * proves fuzzy-matching (@rimba/product-matcher's productMatcher.js, wired via
 * src/services/inboundMessageProcessor.js) now reads its Product catalog
 * from the DATABASE (via productsRepo.listActive()), not from
 * config/products.json -- and that it's read FRESH per message, so a
 * product deactivated through the /products dashboard route stops
 * matching on the very next inbound message, with zero changes to
 * config/products.json.
 *
 * Uses `enableDbProducts: true` (tests/helpers/testApp.js) to wire a real
 * productsRepo into the running app instance, exactly like src/server.js
 * does in production.
 */

function webhookPayload(from, body, timestamp = '1735689600') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              messages: [{ from, id: `wamid.${Date.now()}.${Math.random()}`, timestamp, type: 'text', text: { body } }],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

async function loginAndGetCookie(ctx) {
  const res = await fetch(`${ctx.baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=owner&password=secret-password',
    redirect: 'manual',
  });
  return res.headers.get('set-cookie').split(';')[0];
}

test('FR-702: a product created via the dashboard (no config/products.json involved) is matched by an inbound message', async () => {
  const ctx = await startTestServer({ enableDbProducts: true });
  try {
    ctx.productsRepo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'kaos'] });

    const phone = '6281911100001';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'halo, ada info produk?')),
    });
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'Kaos Rimba Navy')),
    });

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /Matched product: Kaos Rimba Navy/);
  } finally {
    await ctx.close();
  }
});

test('FR-702: deactivating a product via POST /products/:id/deactivate makes it stop matching on the very next message, without touching config/products.json', async () => {
  const ctx = await startTestServer({ enableDbProducts: true });
  try {
    const product = ctx.productsRepo.create({ name: 'Kaos Rimba Navy', aliases: ['kaos navy', 'kaos'] });

    const phone = '6281911100002';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'halo, ada info produk?')),
    });
    // First message: product is active -> matches.
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'Kaos Rimba Navy')),
    });

    const cookie = await loginAndGetCookie(ctx);
    const beforeHtml = await (await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } })).text();
    assert.match(beforeHtml, /Matched product: Kaos Rimba Navy/, 'sanity check: matched while active');

    // Deactivate through the real CRUD route (not by touching the repo
    // directly) -- this is the exact owner-facing action FR-702 exposes.
    const deactivateRes = await fetch(`${ctx.baseUrl}/products/${product.id}/deactivate`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(deactivateRes.status, 302);

    // A second, independent customer's inbound message naming the same
    // product should now be flagged needs_review -- the catalog is
    // re-read fresh from the DB for every message.
    const secondPhone = '6281911100003';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(secondPhone, 'halo, ada info produk?')),
    });
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(secondPhone, 'Kaos Rimba Navy')),
    });

    const afterHtml = await (await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } })).text();
    assert.match(afterHtml, /Needs review — unmatched product/, 'the deactivated product must no longer match');

    // Also prove the previously-matched lead's own record is untouched --
    // deactivation only affects future matching, it does not retroactively
    // rewrite history.
    assert.match(afterHtml, /Matched product: Kaos Rimba Navy/, 'the earlier, already-matched lead must be unaffected');
  } finally {
    await ctx.close();
  }
});

test('FR-702: reactivating a product via POST /products/:id/activate makes it match again', async () => {
  const ctx = await startTestServer({ enableDbProducts: true });
  try {
    const product = ctx.productsRepo.create({ name: 'Celana Rimba Cargo', aliases: ['celana cargo', 'celana'] });
    ctx.productsRepo.deactivate(product.id);

    const cookie = await loginAndGetCookie(ctx);
    const activateRes = await fetch(`${ctx.baseUrl}/products/${product.id}/activate`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(activateRes.status, 302);

    const phone = '6281911100004';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'halo, ada info produk?')),
    });
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'Celana Rimba Cargo')),
    });

    const html = await (await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /Matched product: Celana Rimba Cargo/);
  } finally {
    await ctx.close();
  }
});

test('FR-702: with enableDbProducts and an empty catalog (fresh install, no products added yet), every Q1 answer is flagged needs_review', async () => {
  const ctx = await startTestServer({ enableDbProducts: true });
  try {
    const phone = '6281911100005';
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'halo, ada info produk?')),
    });
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(phone, 'Kaos Rimba Navy')),
    });

    const cookie = await loginAndGetCookie(ctx);
    const html = await (await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /Needs review — unmatched product/);
  } finally {
    await ctx.close();
  }
});
