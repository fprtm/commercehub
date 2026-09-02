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
    const older = repo.create({ contactId: '6281000000001', channel: 'whatsapp', firstMessageAt: '2026-08-01T00:00:00.000Z' });
    repo.saveAnswers(older.id, { question1Answer: 'Kaos', question2Answer: 'L', fallbackTriggered: false });
    repo.create({ contactId: '6281000000002', channel: 'whatsapp', firstMessageAt: '2026-08-15T00:00:00.000Z' });

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

test('TEST-1302a (FR-1306): same contact_id under two different channels resolves to two independent leads', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const sharedContactId = '12345';

    const waLead = repo.create({ contactId: sharedContactId, channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });
    const tgLead = repo.create({ contactId: sharedContactId, channel: 'telegram', firstMessageAt: '2026-09-01T00:01:00.000Z' });

    assert.notEqual(waLead.id, tgLead.id, 'each channel gets its own Lead row even with an identical contact_id');

    const foundWa = repo.findByContact(sharedContactId, 'whatsapp');
    const foundTg = repo.findByContact(sharedContactId, 'telegram');

    assert.equal(foundWa.id, waLead.id);
    assert.equal(foundTg.id, tgLead.id);
    assert.notEqual(foundWa.id, foundTg.id, 'findByContact never cross-contaminates state between channels');

    // Mutating one lead (e.g. via saveAnswers) must never be visible through
    // the other channel's lookup -- proves these are genuinely independent
    // rows, not a shared identity silently merged by contact_id alone.
    repo.saveAnswers(waLead.id, { question1Answer: 'Kaos', question2Answer: 'L', fallbackTriggered: false });
    const tgAfterWaUpdate = repo.findByContact(sharedContactId, 'telegram');
    assert.equal(tgAfterWaUpdate.question1_answer, null, 'the Telegram lead must be unaffected by the WhatsApp lead update');
  } finally {
    await ctx.close();
  }
});

test('T-010 POST /leads/:id/status updates status to responded and persists across reload', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const lead = repo.create({ contactId: '6281000000003', channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });

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
    const lead = repo.create({ contactId: '6281000000004', channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });
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
    const lead = repo.create({ contactId: '6281000000005', channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });
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
    const lead = repo.create({ contactId: '6281000000007', channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });
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
    const lead = repo.create({ contactId: '6281000000008', channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });
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

test('TICKET-1306: leadsRepo.listAllMostRecentFirst({ channel }) narrows results, no-arg call unchanged', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const wa = repo.create({ contactId: '6281111111111', channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });
    const tg = repo.create({ contactId: '222222222', channel: 'telegram', firstMessageAt: '2026-09-01T00:01:00.000Z' });

    const all = repo.listAllMostRecentFirst();
    assert.equal(all.length, 2, 'no-arg call returns every lead regardless of channel');
    assert.ok(all.some((l) => l.id === wa.id) && all.some((l) => l.id === tg.id));

    const waOnly = repo.listAllMostRecentFirst({ channel: 'whatsapp' });
    assert.equal(waOnly.length, 1);
    assert.equal(waOnly[0].id, wa.id);

    const tgOnly = repo.listAllMostRecentFirst({ channel: 'telegram' });
    assert.equal(tgOnly.length, 1);
    assert.equal(tgOnly[0].id, tg.id);

    // Explicit `{}` / falsy channel must behave identically to no-arg.
    const explicitEmpty = repo.listAllMostRecentFirst({});
    assert.equal(explicitEmpty.length, 2);
  } finally {
    await ctx.close();
  }
});

test('TICKET-1306: GET /leads?channel=telegram renders only telegram leads, with header/badges/select', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    repo.create({ contactId: '6281222222222', channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });
    repo.create({ contactId: '333333333', channel: 'telegram', firstMessageAt: '2026-09-01T00:01:00.000Z' });

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads?channel=telegram`, { headers: { Cookie: cookie } });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /<th>Contact<\/th>/);
    assert.match(html, /333333333/);
    assert.doesNotMatch(html, /6281222222222/, 'WhatsApp lead must not appear when filtered to telegram');
    assert.match(html, /class="badge badge-channel-telegram"/);
    assert.doesNotMatch(html, /class="badge badge-channel-whatsapp"/);
    // Selected option persisted in the rendered <select>.
    assert.match(html, /<option value="telegram" selected>Telegram<\/option>/);
  } finally {
    await ctx.close();
  }
});

test('TICKET-1306: GET /leads with no filter shows "All channels" selected and both channels\' badges', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    repo.create({ contactId: '6281333333333', channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });
    repo.create({ contactId: '444444444', channel: 'telegram', firstMessageAt: '2026-09-01T00:01:00.000Z' });

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads`, { headers: { Cookie: cookie } });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /<option value="" selected>All channels<\/option>/);
    assert.match(html, /6281333333333/);
    assert.match(html, /444444444/);
    assert.match(html, /class="badge badge-channel-whatsapp"/);
    assert.match(html, /class="badge badge-channel-telegram"/);
  } finally {
    await ctx.close();
  }
});

test('TICKET-1306: GET /leads?channel=telegram with zero telegram leads shows the existing empty state', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    repo.create({ contactId: '6281444444444', channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });

    const cookie = await loginAndGetCookie(ctx);
    const res = await fetch(`${ctx.baseUrl}/leads?channel=telegram`, { headers: { Cookie: cookie } });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /No leads yet/);
  } finally {
    await ctx.close();
  }
});

test('T-010 POST /leads/:id/status requires authentication', async () => {
  const ctx = await startTestServer();
  try {
    const repo = createLeadsRepo(ctx.db);
    const lead = repo.create({ contactId: '6281000000006', channel: 'whatsapp', firstMessageAt: '2026-09-01T00:00:00.000Z' });

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
