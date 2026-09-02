'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('./helpers/testApp');
const { createProductsRepo } = require('../src/services/productsRepo');

/**
 * Coverage for docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md
 * (FR-702) -- the /products dashboard CRUD routes, over real HTTP, same
 * pattern as tests/leads.test.js.
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

test('FR-702: GET /products requires authentication', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/products`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/login/);
  } finally {
    await ctx.close();
  }
});

test('FR-702: POST /products (create) requires authentication', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=Sneaky Product',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/login/);
  } finally {
    await ctx.close();
  }
});

test('FR-702: GET /products shows the empty state when there are no products yet', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/products`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /No products yet/);
  } finally {
    await ctx.close();
  }
});

test('FR-702: POST /products creates a new active product with parsed aliases, then lists it', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: 'name=Kaos+Rimba+Navy&aliases=kaos+navy%2C+kaos%2C+baju+kaos',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/products$/);

    const repo = createProductsRepo(ctx.db);
    const all = repo.listAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'Kaos Rimba Navy');
    assert.deepEqual(all[0].aliases, ['kaos navy', 'kaos', 'baju kaos']);
    assert.equal(all[0].is_active, true);

    const listRes = await fetch(`${ctx.baseUrl}/products`, { headers: { Cookie: cookie } });
    const html = await listRes.text();
    assert.match(html, /Kaos Rimba Navy/);
    assert.match(html, /kaos navy, kaos, baju kaos/);
    assert.match(html, /Active/);
  } finally {
    await ctx.close();
  }
});

test('FR-702: POST /products with a blank name does not create a product', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    await fetch(`${ctx.baseUrl}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: 'name=+&aliases=',
      redirect: 'manual',
    });

    const repo = createProductsRepo(ctx.db);
    assert.equal(repo.listAll().length, 0);
  } finally {
    await ctx.close();
  }
});

test('FR-702: POST /products/:id edits an existing product\'s name and aliases', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createProductsRepo(ctx.db);
    const product = repo.create({ name: 'Old Name', aliases: ['old'] });

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/products/${product.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: 'name=New+Name&aliases=new%2C+newer',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);

    const updated = repo.findById(product.id);
    assert.equal(updated.name, 'New Name');
    assert.deepEqual(updated.aliases, ['new', 'newer']);
  } finally {
    await ctx.close();
  }
});

test('FR-702: POST /products/:id/deactivate flips is_active off without deleting the row, and the dashboard shows "Deactivated"', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createProductsRepo(ctx.db);
    const product = repo.create({ name: 'Deactivate Me', aliases: [] });

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/products/${product.id}/deactivate`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);

    const stillThere = repo.findById(product.id);
    assert.ok(stillThere, 'deactivate must be a soft-delete, the row must still exist');
    assert.equal(stillThere.is_active, false);

    const listRes = await fetch(`${ctx.baseUrl}/products`, { headers: { Cookie: cookie } });
    const html = await listRes.text();
    assert.match(html, /Deactivated/);
    assert.match(html, /Reactivate/);
  } finally {
    await ctx.close();
  }
});

test('FR-702: POST /products/:id/activate reverses a deactivation', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createProductsRepo(ctx.db);
    const product = repo.create({ name: 'Reactivate Me', aliases: [] });
    repo.deactivate(product.id);

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/products/${product.id}/activate`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);

    const reactivated = repo.findById(product.id);
    assert.equal(reactivated.is_active, true);
  } finally {
    await ctx.close();
  }
});

test('FR-702: POST /products/:id/deactivate requires authentication', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createProductsRepo(ctx.db);
    const product = repo.create({ name: 'Auth Gate Check', aliases: [] });

    const res = await fetch(`${ctx.baseUrl}/products/${product.id}/deactivate`, {
      method: 'POST',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/login/);

    const unchanged = repo.findById(product.id);
    assert.equal(unchanged.is_active, true, 'an unauthenticated request must not deactivate anything');
  } finally {
    await ctx.close();
  }
});

test('FR-702: POST /products/:id/deactivate on a non-existent id redirects with a flash message, not a crash', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/products/999999/deactivate`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);

    const listRes = await fetch(`${ctx.baseUrl}/products`, { headers: { Cookie: cookie } });
    const html = await listRes.text();
    assert.match(html, /no longer exists/);
  } finally {
    await ctx.close();
  }
});
