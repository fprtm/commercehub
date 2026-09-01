'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('./helpers/testApp');

/**
 * FR-701 (docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md):
 * "A persistent navigation bar appears on every authenticated dashboard
 * page (Leads, Products, Failed Events, Pairing) ... each nav link is
 * reachable from every other authenticated page." This proves the shared
 * partial (src/views/partials/nav.ejs) actually renders, with links to all
 * four destinations, on every one of those four pages.
 */

const NAV_LINKS = [
  { href: '/leads', label: 'Leads' },
  { href: '/products', label: 'Products' },
  { href: '/failed-events', label: 'Failed Events' },
  { href: '/whatsapp/pair', label: 'Pairing' },
];

const AUTHENTICATED_PAGES = ['/leads', '/products', '/failed-events', '/whatsapp/pair'];

async function loginAndGetCookie(ctx) {
  const res = await fetch(`${ctx.baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=owner&password=secret-password',
    redirect: 'manual',
  });
  return res.headers.get('set-cookie').split(';')[0];
}

for (const page of AUTHENTICATED_PAGES) {
  test(`FR-701: ${page} renders a nav bar linking to all four dashboard pages`, async () => {
    const ctx = await startTestServer();
    try {
      const cookie = await loginAndGetCookie(ctx);
      const res = await fetch(`${ctx.baseUrl}${page}`, { headers: { Cookie: cookie } });
      const html = await res.text();

      assert.equal(res.status, 200);
      for (const link of NAV_LINKS) {
        assert.match(
          html,
          new RegExp(`<a href="${link.href.replace(/\//g, '\\/')}"[^>]*>${link.label}</a>`),
          `expected a nav link to ${link.href} ("${link.label}") on ${page}`,
        );
      }
    } finally {
      await ctx.close();
    }
  });
}

test('FR-701: the nav bar requires authentication -- unauthenticated requests never see it (redirected to /login first)', async () => {
  const ctx = await startTestServer();
  try {
    for (const page of AUTHENTICATED_PAGES) {
      // eslint-disable-next-line no-await-in-loop -- simple sequential check, not a hot path
      const res = await fetch(`${ctx.baseUrl}${page}`, { redirect: 'manual' });
      assert.equal(res.status, 302, `${page} must redirect when unauthenticated`);
      assert.match(res.headers.get('location'), /\/login/);
    }
  } finally {
    await ctx.close();
  }
});

test('FR-701: GET /failed-events lists recorded failures (e.g. a malformed webhook payload) with the nav bar present', async () => {
  const ctx = await startTestServer();
  try {
    // Trigger a real FailedEvent via the existing webhook error path.
    await fetch(`${ctx.baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/failed-events`, { headers: { Cookie: cookie } });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /whatsapp_cloud_api/);
    assert.doesNotMatch(html, /No failed events/);
  } finally {
    await ctx.close();
  }
});

test('FR-701: GET /failed-events shows the empty state when nothing has failed yet', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/failed-events`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /No failed events/);
  } finally {
    await ctx.close();
  }
});
