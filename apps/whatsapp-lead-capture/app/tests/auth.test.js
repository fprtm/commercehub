'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('./helpers/testApp');

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  return setCookie.split(';')[0];
}

test('T-008 GET /leads redirects to /login when not authenticated', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/leads`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/login/);
  } finally {
    await ctx.close();
  }
});

test('T-008 POST /login with correct credentials establishes a session and redirects to /leads', async () => {
  const ctx = await startTestServer({ ownerUsername: 'owner', ownerPassword: 'super-secret' });
  try {
    const res = await fetch(`${ctx.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=super-secret',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/leads/);

    const cookie = extractCookie(res);
    assert.ok(cookie, 'expected a session cookie to be set');

    const leadsRes = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    assert.equal(leadsRes.status, 200);
  } finally {
    await ctx.close();
  }
});

test('T-008 POST /login with incorrect credentials returns 401 and does not establish a session', async () => {
  const ctx = await startTestServer({ ownerUsername: 'owner', ownerPassword: 'super-secret' });
  try {
    const res = await fetch(`${ctx.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=wrong-password',
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.match(body, /Incorrect username or password/);
  } finally {
    await ctx.close();
  }
});

test('T-008 already-authenticated GET /login redirects straight to /leads', async () => {
  const ctx = await startTestServer({ ownerUsername: 'owner', ownerPassword: 'super-secret' });
  try {
    const loginRes = await fetch(`${ctx.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=super-secret',
      redirect: 'manual',
    });
    const cookie = extractCookie(loginRes);

    const res = await fetch(`${ctx.baseUrl}/login`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/leads/);
  } finally {
    await ctx.close();
  }
});
