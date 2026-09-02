'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('./helpers/testApp');
const { createLeadsRepo } = require('../src/services/leadsRepo');

async function loginAndGetCookie(ctx) {
  const res = await fetch(`${ctx.baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=owner&password=secret-password',
    redirect: 'manual',
  });
  return res.headers.get('set-cookie').split(';')[0];
}

test('T-009 GET /leads shows the empty state when there are no leads', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /No leads yet/);
  } finally {
    await ctx.close();
  }
});

test('T-009 GET /leads lists leads most-recent-first with phone, answers and status', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const older = repo.create({ phoneNumber: '6281000000001', firstMessageAt: '2026-08-01T00:00:00.000Z' });
    repo.saveAnswers(older.id, { question1Answer: 'Kaos', question2Answer: 'L', fallbackTriggered: false });
    repo.create({ phoneNumber: '6281000000002', firstMessageAt: '2026-08-15T00:00:00.000Z' });

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();

    const idxNewer = html.indexOf('6281000000002');
    const idxOlder = html.indexOf('6281000000001');
    assert.ok(idxNewer > -1 && idxOlder > -1);
    assert.ok(idxNewer < idxOlder, 'most recent first_message_at should appear first');
    assert.match(html, /Kaos/);
    assert.match(html, /No answer yet/); // second lead's unanswered Q1/Q2
  } finally {
    await ctx.close();
  }
});

test('T-010 POST /leads/:id/status updates status to responded and persists across reload', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const lead = repo.create({ phoneNumber: '6281000000003', firstMessageAt: '2026-09-01T00:00:00.000Z' });

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads/${lead.id}/status`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'status=responded',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);

    const updated = ctx.db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    assert.equal(updated.status, 'responded');
  } finally {
    await ctx.close();
  }
});

test('T-010 POST /leads/:id/status with a non-existent id returns 404 with a plain-language message', async () => {
  const ctx = await startTestServer();
  try {
    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads/999999/status`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'status=responded',
    });
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /This lead no longer exists/);
  } finally {
    await ctx.close();
  }
});

test('T-010 POST /leads/:id/status with an invalid status value returns 400', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const lead = repo.create({ phoneNumber: '6281000000004', firstMessageAt: '2026-09-01T00:00:00.000Z' });
    const cookie = await loginAndGetCookie(ctx);

    const res = await fetch(`${ctx.baseUrl}/leads/${lead.id}/status`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'status=not-a-real-status',
    });
    assert.equal(res.status, 400);

    const unchanged = ctx.db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    assert.equal(unchanged.status, 'new');
  } finally {
    await ctx.close();
  }
});

test('T-010 POST /leads/:id/status rejects setting status back to "new" (not a valid owner action)', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const lead = repo.create({ phoneNumber: '6281000000005', firstMessageAt: '2026-09-01T00:00:00.000Z' });
    const cookie = await loginAndGetCookie(ctx);

    const res = await fetch(`${ctx.baseUrl}/leads/${lead.id}/status`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'status=new',
    });
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('technical-design lifecycle: POST /leads/:id/status rejects closed->responded (closed is terminal)', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const lead = repo.create({ phoneNumber: '6281000000007', firstMessageAt: '2026-09-01T00:00:00.000Z' });
    repo.updateStatus(lead.id, 'closed');
    const cookie = await loginAndGetCookie(ctx);

    const res = await fetch(`${ctx.baseUrl}/leads/${lead.id}/status`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'status=responded',
    });
    assert.equal(res.status, 400);

    const unchanged = ctx.db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    assert.equal(unchanged.status, 'closed', 'closed lead must stay closed');
  } finally {
    await ctx.close();
  }
});

test('technical-design lifecycle: a closed lead shows no action buttons on the dashboard', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const lead = repo.create({ phoneNumber: '6281000000008', firstMessageAt: '2026-09-01T00:00:00.000Z' });
    repo.updateStatus(lead.id, 'closed');
    const cookie = await loginAndGetCookie(ctx);

    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();
    assert.match(html, /No further action/);
    assert.doesNotMatch(html, /Mark responded/);
    assert.doesNotMatch(html, /Mark closed/);
  } finally {
    await ctx.close();
  }
});

test('T-010 POST /leads/:id/status requires authentication', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const lead = repo.create({ phoneNumber: '6281000000006', firstMessageAt: '2026-09-01T00:00:00.000Z' });

    const res = await fetch(`${ctx.baseUrl}/leads/${lead.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'status=responded',
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/login/);

    const unchanged = ctx.db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    assert.equal(unchanged.status, 'new');
  } finally {
    await ctx.close();
  }
});
