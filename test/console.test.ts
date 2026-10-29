// The Console: sign-in, the permission matrix, audit entries, customers, support, staff, overview.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvField, customersCsv } from '../src/routes/console-customers';
import { accessFor } from '../src/permissions';
import { DAY } from '../src/lib/util';
import {
  addAllStaff,
  addOrg,
  addStaff,
  addTournament,
  auditRows,
  env,
  fakeFetch,
  get,
  json,
  MANAGER,
  OWNER,
  post,
  reset,
  SUPPORT,
  VIEWER,
  type Who,
} from './helpers';

const MATTEO: Who = { id: 'u_matteo', email: 'matteo@gurten.test', name: 'Matteo Keller' };

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

describe('sign-in', () => {
  it('answers 401 without a token and 403 for accounts that are not staff', async () => {
    const none = await get('/console/me');
    expect(none.status).toBe(401);
    const body = await json(none);
    expect(body.code).toBe('unauthenticated');
    expect(body.requestId).toBe(none.headers.get('x-request-id'));
    const stranger = await get('/console/me', { who: { id: 'u_x', email: 'x@example.test' } });
    expect(stranger.status).toBe(403);
    expect((await json(stranger)).code).toBe('not_staff');
  });

  it('lets OWNER_EMAIL claim Owner once, while nobody holds it', async () => {
    const res = await get('/console/me', { who: OWNER });
    expect(res.status).toBe(200);
    const me = await json(res);
    expect(me).toMatchObject({ id: OWNER.id, role: 'owner', email: OWNER.email });
    expect(me.access.staff).toBe('edit');
    expect((await auditRows()).map((a) => a.action)).toEqual(['staff.bootstrap']);

    // A second account with the same e-mail doesn't get in.
    await env.DB.prepare("UPDATE staff SET email = 'old@planary.test'").run();
    const other = await get('/console/me', { who: { id: 'u_other', email: OWNER.email } });
    expect(other.status).toBe(403);
  });

  it('activates a staff row added by e-mail when that address signs in', async () => {
    await addStaff(OWNER, 'owner');
    expect((await post('/console/staff', { email: 'NEW@planary.test', role: 'support' }, { who: OWNER })).status).toBe(200);
    const list = await json(get('/console/staff', { who: OWNER }));
    expect(list.staff.find((s: any) => s.email === 'new@planary.test')).toMatchObject({ role: 'support', lastActive: null });
    const me = await json(get('/console/me', { who: { id: 'u_new', email: 'new@planary.test', name: 'Nora New' } }));
    expect(me).toMatchObject({ id: 'u_new', role: 'support', name: 'Nora New' });
  });

  it('stores last-active, at most once a minute', async () => {
    await addStaff(SUPPORT, 'support');
    await get('/console/me', { who: SUPPORT });
    const first = await env.DB.prepare('SELECT last_active FROM staff WHERE id = ?').bind(SUPPORT.id).first<{ last_active: number }>();
    expect(first?.last_active).toBeGreaterThan(Date.now() - 5000);
    await env.DB.prepare('UPDATE staff SET last_active = ? WHERE id = ?').bind(first!.last_active - 30_000, SUPPORT.id).run();
    await get('/console/me', { who: SUPPORT });
    const second = await env.DB.prepare('SELECT last_active FROM staff WHERE id = ?').bind(SUPPORT.id).first<{ last_active: number }>();
    expect(second?.last_active).toBe(first!.last_active - 30_000);
  });

  it('answers CORS preflights for Console origins only', async () => {
    const ok = await env.DB.prepare('SELECT 1').first(); // keep D1 warm
    expect(ok).toBeTruthy();
    const pre = await get('/console/me', { headers: { Origin: 'https://admin.planary.ch' } });
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://admin.planary.ch');
    const evil = await get('/console/me', { headers: { Origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});

const CONSOLE_POSTS = [
  '/console/incidents',
  '/console/incidents/x/updates',
  '/console/incidents/x/notify',
  '/console/customers/x/notes',
  '/console/customers/x/reminder',
  '/console/customers/x/plan',
  '/console/support/x/messages',
  '/console/support/x',
  '/console/staff',
  '/console/staff/x',
  '/console/staff/x/remove',
];

describe('permission matrix', () => {
  beforeEach(addAllStaff);

  it('matches the Console copy', () => {
    expect(accessFor('support', 'casino')).toBe('none');
    expect(accessFor('viewer', 'notes')).toBe('read');
    expect(accessFor('manager', 'staff')).toBe('none');
    expect(accessFor('owner', 'wishlist')).toBe('read');
  });

  it('lets viewers read and refuses every write', async () => {
    for (const path of ['/console/overview', '/console/status', '/console/customers', '/console/support', '/console/tournaments', '/console/organisers']) {
      expect((await get(path, { who: VIEWER })).status, path).toBe(200);
    }
    for (const path of CONSOLE_POSTS) {
      const res = await post(path, {}, { who: VIEWER });
      expect(res.status, path).toBe(403);
    }
    expect(await auditRows()).toHaveLength(0);
  });

  it('keeps support out of casino, audit and staff', async () => {
    const me = await json(get('/console/me', { who: SUPPORT }));
    expect(me.access).toMatchObject({ casino: 'none', audit: 'none', staff: 'none', support: 'edit', notes: 'edit', customers: 'read' });
    expect((await get('/console/audit', { who: SUPPORT })).status).toBe(403);
    expect((await get('/console/staff', { who: SUPPORT })).status).toBe(403);
    expect((await post('/console/customers/x/plan', { plan: 'plus', reason: 'x' }, { who: SUPPORT })).status).toBe(403);
  });

  it("doesn't let managers touch staff", async () => {
    expect((await get('/console/staff', { who: MANAGER })).status).toBe(403);
    expect((await post('/console/staff', { email: 'a@b.ch', role: 'viewer' }, { who: MANAGER })).status).toBe(403);
    expect((await post(`/console/staff/${VIEWER.id}`, { role: 'owner' }, { who: MANAGER })).status).toBe(403);
    expect((await get('/console/audit', { who: MANAGER })).status).toBe(200);
  });

  it('keeps the last owner', async () => {
    const demote = await post(`/console/staff/${OWNER.id}`, { role: 'manager' }, { who: OWNER });
    expect(demote.status).toBe(409);
    expect((await json(demote)).code).toBe('last_owner');
    expect((await post(`/console/staff/${OWNER.id}/remove`, {}, { who: OWNER })).status).toBe(409);
    expect((await post(`/console/staff/${MANAGER.id}`, { role: 'owner' }, { who: OWNER })).status).toBe(200);
    expect((await post(`/console/staff/${OWNER.id}`, { role: 'manager' }, { who: OWNER })).status).toBe(200);
  });
});

describe('audit log', () => {
  beforeEach(async () => {
    await addAllStaff();
    await addOrg('org_gurten', 'Verein Gurten LAN', [{ who: MATTEO, role: 'owner' }]);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO invoices (id, org_id, number, created_at, due_at, amount, status, description, pay_url, updated_at) VALUES ('in_1', 'org_gurten', '2026-0142', ?, ?, 22800, 'open', 'Plan Verein', 'https://pay.stripe.test/in_1', ?)",
    )
      .bind(now - 30 * DAY, now - 12 * DAY, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO requests (id, seq, code, org_id, user_id, user_name, user_email, topic, subject, status, created_at, updated_at, last_customer_at) VALUES ('req_1', 1184, 'REQ-1184', 'org_gurten', ?, ?, ?, 'tournament', 'Beamer', 'open', ?, ?, ?)",
    )
      .bind(MATTEO.id, MATTEO.name, MATTEO.email, now, now, now)
      .run();
  });

  it('writes an entry for every Console change', async () => {
    const mail = fakeFetch([['https://api.resend.com/', () => Response.json({ id: 'mail_1' })]]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(mail.fn);
    const e = { RESEND_API_KEY: 're_test' };
    const created = await json(post('/console/incidents', { title: 'Live results delayed', severity: 'major', services: ['tournament'], message: 'Looking into it.' }, { who: OWNER }));
    const steps: [string, unknown, string, string][] = [
      [`/console/incidents/${created.id}/updates`, { status: 'identified', message: 'Rolling back.', showToOrganisers: true }, 'incident.update', 'Posted an incident update'],
      [`/console/incidents/${created.id}/notify`, { message: 'Wir sind dran.' }, 'incident.notify', 'Notified organisers about an incident'],
      ['/console/customers/org_gurten/notes', { body: 'Treasurer pays on the 25th.' }, 'customer.note', 'Added a customer note'],
      ['/console/customers/org_gurten/reminder', { invoiceId: 'in_1' }, 'invoice.reminder', 'Sent a payment reminder'],
      ['/console/customers/org_gurten/plan', { plan: 'plus', reason: 'Comp for the LAN' }, 'customer.plan', 'Changed a plan'],
      ['/console/support/req_1/messages', { kind: 'staff', body: 'Hallo Matteo', setStatus: 'waiting' }, 'request.reply', 'Replied to a support request'],
      ['/console/support/req_1/messages', { kind: 'internal', body: 'Linked to INC' }, 'request.note', 'Added an internal note'],
      ['/console/support/req_1', { assigneeId: SUPPORT.id }, 'request.assign', 'Assigned a support request'],
      ['/console/support/req_1', { status: 'done' }, 'request.status', 'Changed the status of a support request'],
      ['/console/staff', { email: 'new@planary.test', role: 'viewer' }, 'staff.add', 'Added a staff member'],
      [`/console/staff/${VIEWER.id}`, { role: 'support' }, 'staff.role', 'Changed a role'],
      [`/console/staff/${VIEWER.id}/remove`, {}, 'staff.remove', 'Removed a staff member'],
    ];
    for (const [path, body, action, sentence] of steps) {
      const before = (await auditRows()).length;
      const res = await post(path, body, { who: OWNER, env: e });
      expect(res.status, `${path} ${await res.clone().text()}`).toBe(200);
      const rows = await auditRows();
      expect(rows.length, path).toBe(before + 1);
      expect(rows[rows.length - 1]).toMatchObject({ action, sentence, actor_id: OWNER.id });
    }
    const rows = await auditRows();
    expect(rows[0]).toMatchObject({ action: 'incident.open', target: 'INC-0001', area: 'incidents' });
    expect(rows.find((r) => r.action === 'customer.plan')).toMatchObject({ target: 'Verein Gurten LAN', details: 'Gratis → Plus: Comp for the LAN' });
    expect(rows.find((r) => r.action === 'invoice.reminder')).toMatchObject({ target: 'Invoice 2026-0142', details: 'Verein Gurten LAN, 1st reminder' });
    expect(rows.find((r) => r.action === 'request.reply')).toMatchObject({ target: 'REQ-1184', details: 'set to waiting' });
    expect(rows.find((r) => r.action === 'staff.role')).toMatchObject({ target: 'Tim Roth', details: 'viewer → support' });
    // The reminder carried the payment link.
    const reminder = mail.calls.find((c) => c.body.includes('2026-0142'));
    expect(reminder?.body).toContain('https://pay.stripe.test/in_1');
  });

  it('filters by area and staff and pages with before', async () => {
    const stmts = Array.from({ length: 205 }, (_, i) =>
      env.DB.prepare("INSERT INTO audit_log (at, area, actor_id, actor_name, action, sentence) VALUES (?, ?, ?, 'x', 'a', 'A')").bind(
        i,
        i % 2 ? 'customers' : 'notes',
        i % 5 ? OWNER.id : MANAGER.id,
      ),
    );
    await env.DB.batch(stmts);
    const page1 = await json(get('/console/audit', { who: OWNER }));
    expect(page1.entries).toHaveLength(100);
    expect(page1.more).toBe(true);
    const page2 = await json(get(`/console/audit?before=${page1.entries[99].id}`, { who: OWNER }));
    expect(Number(page2.entries[0].id)).toBe(Number(page1.entries[99].id) - 1);
    const page3 = await json(get(`/console/audit?before=${page2.entries[99].id}`, { who: OWNER }));
    expect(page3.entries).toHaveLength(5);
    expect(page3.more).toBe(false);
    const notes = await json(get('/console/audit?area=notes', { who: OWNER }));
    expect(notes.entries.every((e: any) => e.area === 'notes')).toBe(true);
    const both = await json(get('/console/audit?area=customers,notes&staff=' + MANAGER.id, { who: OWNER }));
    expect(both.entries).toHaveLength(41);
    expect((await get('/console/audit?area=bogus', { who: OWNER })).status).toBe(400);
  });
});

describe('customers', () => {
  beforeEach(async () => {
    await addAllStaff();
    const now = Date.now();
    await addOrg('org_gurten', 'Verein Gurten LAN', [{ who: MATTEO, role: 'owner' }]);
    await addOrg('org_uni', 'Uni Bern Gaming', []);
    await addOrg('org_free', 'TTC Ostermundigen', []);
    await env.DB.batch([
      env.DB.prepare("UPDATE subscriptions SET plan = 'plus', state = 'active', current_period_end = ? WHERE org_id IN ('org_gurten', 'org_uni')").bind(now + 100 * DAY),
      env.DB.prepare(
        "INSERT INTO invoices (id, org_id, number, created_at, due_at, amount, status, pay_url, updated_at) VALUES ('in_open', 'org_gurten', '2026-0142', ?, ?, 22800, 'open', 'https://pay.stripe.test/in_open', ?)",
      ).bind(now - 26 * DAY, now - 12 * DAY - 3_600_000, now),
      env.DB.prepare(
        "INSERT INTO invoices (id, org_id, number, created_at, due_at, amount, status, paid_at, updated_at) VALUES ('in_paid', 'org_gurten', '2026-0031', ?, ?, 4900, 'paid', ?, ?)",
      ).bind(now - 200 * DAY, now - 200 * DAY, now - 200 * DAY, now),
      env.DB.prepare(
        "INSERT INTO invoices (id, org_id, number, created_at, due_at, amount, status, paid_at, updated_at) VALUES ('in_uni', 'org_uni', '2026-0100', ?, ?, 22800, 'paid', ?, ?)",
      ).bind(now - 100 * DAY, now - 70 * DAY, now - 90 * DAY, now),
      env.DB.prepare("INSERT INTO payment_methods (org_id, kind, brand, last4, exp_month, exp_year, updated_at) VALUES ('org_uni', 'card', 'visa', '4242', ?, ?, ?)").bind(
        new Date(now - DAY).getUTCMonth() + 1,
        new Date(now - DAY).getUTCFullYear(),
        now,
      ),
    ]);
    await addTournament({ id: 't_gurten', org: 'org_gurten', state: 'live' });
  });

  it('computes overdue, card expiry, free and revenue', async () => {
    const { customers } = await json(get('/console/customers', { who: VIEWER }));
    const by = Object.fromEntries(customers.map((c: any) => [c.id, c]));
    expect(by.org_gurten).toMatchObject({ plan: 'plus', billing: 'overdue', overdueDays: 12, revenueYear: 14900, initials: 'GL', tournamentsThisYear: 1, members: 1 });
    expect(by.org_uni).toMatchObject({ billing: 'card_expires', revenueYear: 14900 });
    expect(by.org_free).toMatchObject({ plan: 'gratis', billing: 'free', revenueYear: 0 });
    const overdue = await json(get('/console/customers?overdue=1', { who: VIEWER }));
    expect(overdue.customers.map((c: any) => c.id)).toEqual(['org_gurten']);
    const q = await json(get('/console/customers?q=bern', { who: VIEWER }));
    expect(q.customers.map((c: any) => c.id)).toEqual(['org_uni']);

    const detail = await json(get('/console/customers/org_gurten', { who: VIEWER }));
    expect(detail.invoices.find((i: any) => i.id === 'in_open').overdueDays).toBe(12);
    expect(detail.memberList[0]).toMatchObject({ id: MATTEO.id, role: 'owner' });
    expect(detail.tournaments[0]).toMatchObject({ id: 't_gurten', organisationName: 'Verein Gurten LAN' });
  });

  it('exports CSV with quoting', async () => {
    await env.DB.prepare(`UPDATE organisations SET name = ? WHERE id = 'org_free'`).bind('Club "Ping, Pong"\nNacht').run();
    await env.DB.prepare(`UPDATE organisations SET name = ? WHERE id = 'org_uni'`).bind('=HYPERLINK("x")').run();
    const res = await get('/console/customers.csv', { who: VIEWER });
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const text = await res.text();
    expect(text.startsWith('﻿id,name,plan')).toBe(true);
    expect(text).toContain('"Club ""Ping, Pong""\nNacht"');
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).toMatch(/org_gurten,Verein Gurten LAN,plus,1,1,149\.00,overdue,12,\d{4}-\d{2}-\d{2}/);
    expect(csvField('plain')).toBe('plain');
    expect(csvField(null)).toBe('');
    expect(customersCsv([]).trim()).toBe('id,name,plan,members,tournaments_this_year,revenue_year_chf,billing,overdue_days,customer_since');
  });

  it('refuses a reminder without Resend instead of pretending', async () => {
    const res = await post('/console/customers/org_gurten/reminder', { invoiceId: 'in_open' }, { who: OWNER });
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe('mail_not_configured');
    expect(await auditRows()).toHaveLength(0);
  });

  it('applies a staff plan change without charging', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await post('/console/customers/org_free/plan', { plan: 'plus', reason: 'Partner club' }, { who: MANAGER })).status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const detail = await json(get('/console/customers/org_free', { who: VIEWER }));
    expect(detail.plan).toBe('plus');
    expect((await post('/console/customers/org_free/plan', { plan: 'plus' }, { who: MANAGER })).status).toBe(400);
  });
});

describe('support inbox', () => {
  beforeEach(async () => {
    await addAllStaff();
    await addOrg('org_gurten', 'Verein Gurten LAN', [{ who: MATTEO, role: 'owner' }]);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO requests (id, seq, code, org_id, user_id, user_name, user_email, topic, subject, status, urgent, created_at, updated_at, last_customer_at) VALUES ('req_a', 1, 'REQ-0001', 'org_gurten', ?, 'Matteo', ?, 'tournament', 'A', 'open', 1, ?, ?, ?)",
      ).bind(MATTEO.id, MATTEO.email, now - 1000, now - 1000, now - 1000),
      env.DB.prepare(
        "INSERT INTO requests (id, seq, code, org_id, user_id, user_name, user_email, topic, subject, status, urgent, created_at, updated_at, last_customer_at, assignee_id) VALUES ('req_b', 2, 'REQ-0002', 'org_gurten', ?, 'Matteo', ?, 'billing', 'B', 'waiting', 0, ?, ?, ?, ?)",
      ).bind(MATTEO.id, MATTEO.email, now, now, now, SUPPORT.id),
    ]);
  });

  it('counts per status, filters by who, marks unread and lists assignable staff', async () => {
    const all = await json(get('/console/support', { who: SUPPORT }));
    expect(all.counts).toEqual({ open: 1, waiting: 1, done: 0 });
    expect(all.requests.every((r: any) => r.unread)).toBe(true);
    expect(all.assignable.map((s: any) => s.id).sort()).toEqual([MANAGER.id, OWNER.id, SUPPORT.id].sort());
    const mine = await json(get('/console/support?who=mine', { who: SUPPORT }));
    expect(mine.requests.map((r: any) => r.code)).toEqual(['REQ-0002']);
    const unassigned = await json(get('/console/support?who=unassigned&status=open', { who: SUPPORT }));
    expect(unassigned.requests.map((r: any) => r.code)).toEqual(['REQ-0001']);
    const detail = await json(get('/console/support/req_a', { who: VIEWER }));
    expect(detail.unread).toBe(false);
    const again = await json(get('/console/support', { who: SUPPORT }));
    expect(again.requests.find((r: any) => r.id === 'req_a').unread).toBe(false);
  });

  it('sends staff replies to the requester and keeps internal notes in the Console', async () => {
    const mail = fakeFetch([['https://api.resend.com/', () => Response.json({ id: 'm' })]]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(mail.fn);
    const e = { RESEND_API_KEY: 're_test' };
    await post('/console/support/req_a/messages', { kind: 'internal', body: 'note only for us' }, { who: SUPPORT, env: e });
    expect(mail.calls).toHaveLength(0);
    await post('/console/support/req_a/messages', { kind: 'staff', body: 'Hallo Matteo', setStatus: 'waiting' }, { who: SUPPORT, env: e });
    expect(mail.calls).toHaveLength(1);
    expect(JSON.parse(mail.calls[0].body)).toMatchObject({ to: [MATTEO.email] });
    const detail = await json(get('/console/support/req_a', { who: SUPPORT }));
    expect(detail.status).toBe('waiting');
    expect(detail.messages.map((m: any) => m.kind)).toEqual(['internal', 'staff']);
    expect(detail.plan).toBe('gratis');
  });
});

describe('overview, search and wishlist', () => {
  beforeEach(addAllStaff);

  it('builds the overview from auth and stats', async () => {
    await addOrg('org_a', 'Aare Esports Club', []);
    await env.DB.prepare("UPDATE subscriptions SET plan = 'plus', state = 'active' WHERE org_id = 'org_a'").run();
    await addOrg('org_b', 'Bümpliz Gaming', []);
    const o = await json(get('/console/overview?days=7', { who: VIEWER }));
    expect(o).toMatchObject({ days: 7, accounts: 12480, organisations: 2, paidOrganisations: 1, signupsPrev: 7, accountsNew7: 14, activeToday: 20 });
    expect(o.signups).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(o.active).toEqual([35, 35, 35, 35, 35, 35, 35]);
    expect(o.apps.find((a: any) => a.app === 'casino')).toMatchObject({ today: 20, d7: 140, d30: 600 });
    expect(o.services).toHaveLength(5);
  });

  it('falls back to zeros without the stats worker', async () => {
    const o = await json(get('/console/overview?days=30', { who: VIEWER, env: { STATS: undefined } }));
    expect(o.apps.every((a: any) => a.today === 0 && a.spark.length === 30)).toBe(true);
    expect(o.active).toHaveLength(30);
    const broken = await get('/console/overview', { who: VIEWER, env: { STATS: { fetch: async () => new Response('nope', { status: 500 }) } as unknown as Fetcher } });
    expect(broken.status).toBe(200);
  });

  it('searches what the role may see', async () => {
    await addOrg('org_gurten', 'Verein Gurten LAN', [], { slug: 'gurten-lan' });
    await addTournament({ id: 't_1', name: 'Gurten LAN', org: 'org_gurten' });
    const owner = await json(get('/console/search?q=gurten', { who: OWNER }));
    expect(owner.results.map((r: any) => [r.kind, r.href])).toEqual([
      ['organisation', '/customers/org_gurten'],
      ['tournament', '/tournament?t=t_1'],
    ]);
    const staff = await json(get('/console/search?q=lea', { who: SUPPORT }));
    expect(staff.results).toEqual([]);
    const owners = await json(get('/console/search?q=lea', { who: OWNER }));
    expect(owners.results[0]).toMatchObject({ kind: 'staff', href: '/staff' });
  });

  it('passes wishlist totals through, or says not connected', async () => {
    const off = await get('/console/wishlist', { who: VIEWER });
    expect(off.status).toBe(503);
    expect((await json(off)).code).toBe('not_connected');
    const wl = fakeFetch([['https://wishlist.test/internal/totals', (r) => (r.headers.get('x-internal-key') === 'test-internal-key' ? Response.json({ lists: 9812, items: 61204, shops: [['galaxus.ch', 22]], secret: 'x' }) : new Response('', { status: 403 }))]]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(wl.fn);
    const on = await json(get('/console/wishlist', { who: VIEWER, env: { WISHLIST_API: 'https://wishlist.test' } }));
    expect(on).toMatchObject({ lists: 9812, items: 61204, shops: [['galaxus.ch', 22]] });
    expect(on.secret).toBeUndefined();

    // Over the service binding, in the shape Wishlist answers.
    const WISHLIST = {
      fetch: async (req: Request) =>
        new URL(req.url).pathname === '/api/internal/totals' && req.headers.get('x-internal-key') === 'test-internal-key'
          ? Response.json({ lists: 10, items: 40, sharedLists: 3, reservationsThisMonth: 5, newListsPerWeek: [1, 2, 4], shopDomains: [{ domain: 'galaxus.ch', items: 3 }, { domain: 'digitec.ch', items: 1 }] })
          : new Response('', { status: 404 }),
    } as unknown as Fetcher;
    const bound = await json(get('/console/wishlist', { who: VIEWER, env: { WISHLIST } }));
    expect(bound).toEqual({ lists: 10, listsNewWeek: 4, items: 40, sharedLists: 3, reservationsMonth: 5, newPerWeek: [1, 2, 4], shops: [['galaxus.ch', 0.75], ['digitec.ch', 0.25]] });
  });
});

describe('errors', () => {
  it('answers unknown routes with 404 JSON and a request id', async () => {
    const res = await get('/nope');
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body).toMatchObject({ code: 'not_found' });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects bodies that are too large', async () => {
    await addStaff(OWNER, 'owner');
    const res = await post('/console/customers/x/notes', { body: 'x'.repeat(70_000) }, { who: OWNER });
    expect(res.status).toBe(413);
  });
});
