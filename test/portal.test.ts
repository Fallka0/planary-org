// The portal: membership isolation, owner-only areas, invitations, requests and internal notes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY } from '../src/lib/util';
import { addOrg, addStaff, addTournament, auditRows, call, env, fakeFetch, get, json, OWNER, PNG, post, reset, SUPPORT, type Who } from './helpers';

const MATTEO: Who = { id: 'u_matteo', email: 'matteo@gurten.test', name: 'Matteo Keller' };
const NOA: Who = { id: 'u_noa', email: 'noa@example.test', name: 'Noa Brunner' };
const SARA: Who = { id: 'u_sara', email: 'sara@fcl.test', name: 'Sara Buehler' };

beforeEach(async () => {
  await reset();
  await addOrg('org_a', 'Verein Gurten LAN', [
    { who: MATTEO, role: 'owner' },
    { who: NOA, role: 'member' },
  ]);
  await addOrg('org_b', 'FC Länggasse Esports', [{ who: SARA, role: 'owner' }]);
});
afterEach(() => vi.restoreAllMocks());

function requestForm(fields: Record<string, string>, files: { name: string; bytes: Uint8Array; type: string }[] = []) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append('files[]', new File([f.bytes], f.name, { type: f.type }));
  return form;
}

describe('membership', () => {
  it('needs a signed-in account', async () => {
    expect((await get('/portal/me')).status).toBe(401);
  });

  it('lists my organisations', async () => {
    const me = await json(get('/portal/me', { who: NOA }));
    expect(me.me).toMatchObject({ id: NOA.id, email: NOA.email });
    expect(me.orgs).toEqual([{ id: 'org_a', name: 'Verein Gurten LAN', initials: 'GL', role: 'member', plan: 'gratis' }]);
  });

  it('answers 404 for every route of an organisation I am not in', async () => {
    await addTournament({ id: 't_b', org: 'org_b' });
    const paths = ['/portal/orgs/org_b', '/portal/orgs/org_b/tournaments', '/portal/orgs/org_b/tournaments/t_b', '/portal/orgs/org_b/billing', '/portal/orgs/org_b/members', '/portal/orgs/org_b/requests'];
    for (const p of paths) expect((await get(p, { who: MATTEO })).status, p).toBe(404);
    for (const p of ['/portal/orgs/org_b', '/portal/orgs/org_b/invites', '/portal/orgs/org_b/delete', '/portal/orgs/org_b/checkout', `/portal/orgs/org_b/members/${SARA.id}/remove`]) {
      expect((await post(p, {}, { who: MATTEO })).status, p).toBe(404);
    }
    expect((await get('/portal/orgs/nope', { who: MATTEO })).status).toBe(404);
    // Also not another organisation's tournament through my own.
    expect((await get('/portal/orgs/org_a/tournaments/t_b', { who: MATTEO })).status).toBe(404);
  });

  it("keeps billing, settings and team changes to owners", async () => {
    for (const p of ['/portal/orgs/org_a/billing']) expect((await get(p, { who: NOA })).status).toBe(403);
    for (const p of ['/portal/orgs/org_a', '/portal/orgs/org_a/checkout', '/portal/orgs/org_a/billing-portal', '/portal/orgs/org_a/invites', '/portal/orgs/org_a/delete', `/portal/orgs/org_a/members/${MATTEO.id}`]) {
      const res = await post(p, { name: 'X' }, { who: NOA });
      expect(res.status, p).toBe(403);
    }
    const org = await json(get('/portal/orgs/org_a', { who: NOA }));
    expect(org.role).toBe('member');
    expect(org.contact).toEqual({ email: '', phone: '', address: [] });
    expect((await json(get('/portal/orgs/org_a', { who: MATTEO }))).contact.email).toBe('billing@org_a.test');
    const team = await json(get('/portal/orgs/org_a/members', { who: NOA }));
    expect(team.members.map((m: any) => [m.id, m.me])).toEqual([
      [MATTEO.id, false],
      [NOA.id, true],
    ]);
    expect(team.seats).toBe(1);
  });
});

describe('organisations', () => {
  it('creates one with the creator as owner on Gratis, with a unique slug', async () => {
    const res = await post('/portal/orgs', { name: 'Spielclub Thun', slug: 'spielclub-thun' }, { who: NOA });
    expect(res.status).toBe(200);
    const { id } = await json(res);
    const org = await json(get(`/portal/orgs/${id}`, { who: NOA }));
    expect(org).toMatchObject({ name: 'Spielclub Thun', initials: 'ST', role: 'owner', slug: 'spielclub-thun', onboarding: { logo: false, team: false, tournament: false } });
    expect(org.plan).toMatchObject({ id: 'gratis', placeholder: true, limits: { maxTeams: 16 } });
    expect((await post('/portal/orgs', { name: 'Other', slug: 'spielclub-thun' }, { who: SARA })).status).toBe(409);
    expect((await post('/portal/orgs', { name: 'Other', slug: 'No Spaces' }, { who: SARA })).status).toBe(400);
    expect((await post('/portal/orgs', { name: 'Other', slug: 'ab' }, { who: SARA })).status).toBe(400);
    expect((await auditRows()).find((a) => a.action === 'org.create')).toMatchObject({ area: 'portal', actor_id: NOA.id });
  });

  it('changes settings and the logo, and schedules deletion', async () => {
    expect((await post('/portal/orgs/org_a', { name: 'Gurten LAN', contact: { email: 'kasse@gurtenlan.ch', phone: '+41 31 000 00 00', address: ['Postfach 123', '3000 Bern'] } }, { who: MATTEO })).status).toBe(200);
    const org = await json(get('/portal/orgs/org_a', { who: MATTEO }));
    expect(org.name).toBe('Gurten LAN');
    expect(org.contact).toEqual({ email: 'kasse@gurtenlan.ch', phone: '+41 31 000 00 00', address: ['Postfach 123', '3000 Bern'] });

    const form = new FormData();
    form.append('file', new File([PNG], 'logo.png', { type: 'image/png' }));
    const logo = await call('POST', '/portal/orgs/org_a/logo', { who: MATTEO, form });
    expect(logo.status).toBe(200);
    const { logoUrl } = await json(logo);
    const served = await call('GET', new URL(logoUrl).pathname + new URL(logoUrl).search);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    const bad = new FormData();
    bad.append('file', new File([new TextEncoder().encode('<svg/>')], 'x.svg', { type: 'image/svg+xml' }));
    expect((await call('POST', '/portal/orgs/org_a/logo', { who: MATTEO, form: bad })).status).toBe(415);

    expect((await post('/portal/orgs/org_a/delete', { confirm: 'wrong' }, { who: MATTEO })).status).toBe(400);
    const del = await json(post('/portal/orgs/org_a/delete', { confirm: 'Gurten LAN' }, { who: MATTEO }));
    expect(del.deleteAt).toBeGreaterThan(Date.now() + 29 * DAY);
  });
});

describe('invitations', () => {
  it('invites by e-mail, accepts only for that address, and respects seats', async () => {
    const mail = fakeFetch([['https://api.resend.com/', () => Response.json({ id: 'm' })]]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(mail.fn);
    const e = { RESEND_API_KEY: 're_test' };
    // Gratis has one organiser seat (Matteo + Noa already exceed it): invitations are refused.
    expect((await json(post('/portal/orgs/org_a/invites', { email: 'luca@example.test', role: 'member' }, { who: MATTEO, env: e }))).code).toBe('seats_full');
    await env.DB.prepare("UPDATE subscriptions SET plan = 'verein', state = 'active' WHERE org_id = 'org_a'").run();
    expect((await post('/portal/orgs/org_a/invites', { email: 'Luca@Example.test', role: 'member' }, { who: MATTEO, env: e })).status).toBe(200);
    const sent = JSON.parse(mail.calls[0].body);
    const link: string = sent.text.match(/https:\/\/portal\.planary\.test\/einladung\/(\S+)/)[0];
    const tok = link.split('/').pop()!;
    // Only a hash is stored.
    const row = await env.DB.prepare('SELECT token_hash FROM invitations').first<{ token_hash: string }>();
    expect(row?.token_hash).not.toContain(tok);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const team = await json(get('/portal/orgs/org_a/members', { who: MATTEO }));
    expect(team.invites).toMatchObject([{ email: 'luca@example.test', role: 'member' }]);
    expect(team.seats).toBe(5);

    const wrong = await post(`/portal/invites/${tok}/accept`, {}, { who: SARA });
    expect(wrong.status).toBe(403);
    expect((await json(wrong)).code).toBe('email_mismatch');
    const luca: Who = { id: 'u_luca', email: 'luca@example.test', name: 'Luca Steiner' };
    const ok = await json(post(`/portal/invites/${tok}/accept`, {}, { who: luca }));
    expect(ok.orgId).toBe('org_a');
    expect((await json(get('/portal/me', { who: luca }))).orgs[0]).toMatchObject({ id: 'org_a', role: 'member' });
  });

  it('expires after 14 days and can be resent or withdrawn', async () => {
    await env.DB.prepare("UPDATE subscriptions SET plan = 'verein', state = 'active' WHERE org_id = 'org_a'").run();
    const mail = fakeFetch([['https://api.resend.com/', () => Response.json({ id: 'm' })]]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(mail.fn);
    const e = { RESEND_API_KEY: 're_test' };
    await post('/portal/orgs/org_a/invites', { email: 'luca@example.test', role: 'member' }, { who: MATTEO, env: e });
    const tok1 = JSON.parse(mail.calls[0].body).text.match(/einladung\/(\S+)/)[1];
    await env.DB.prepare('UPDATE invitations SET expires_at = ?').bind(Date.now() - 1).run();
    const luca: Who = { id: 'u_luca', email: 'luca@example.test' };
    expect((await post(`/portal/invites/${tok1}/accept`, {}, { who: luca })).status).toBe(410);
    const inv = await env.DB.prepare('SELECT id FROM invitations').first<{ id: string }>();
    expect((await post(`/portal/orgs/org_a/invites/${inv!.id}/resend`, {}, { who: MATTEO, env: e })).status).toBe(200);
    const tok2 = JSON.parse(mail.calls[1].body).text.match(/einladung\/(\S+)/)[1];
    expect((await post(`/portal/invites/${tok1}/accept`, {}, { who: luca })).status).toBe(404);
    expect((await post(`/portal/orgs/org_a/invites/${inv!.id}/withdraw`, {}, { who: MATTEO })).status).toBe(200);
    expect((await post(`/portal/invites/${tok2}/accept`, {}, { who: luca })).status).toBe(404);
  });

  it("doesn't let the last owner go", async () => {
    expect((await post(`/portal/orgs/org_a/members/${MATTEO.id}`, { role: 'member' }, { who: MATTEO })).status).toBe(409);
    expect((await post(`/portal/orgs/org_a/members/${MATTEO.id}/remove`, {}, { who: MATTEO })).status).toBe(409);
    expect((await post(`/portal/orgs/org_a/members/${NOA.id}`, { role: 'owner' }, { who: MATTEO })).status).toBe(200);
    expect((await post(`/portal/orgs/org_a/members/${MATTEO.id}/remove`, {}, { who: NOA })).status).toBe(200);
  });
});

describe('support requests', () => {
  async function openRequest(who = NOA, extra: Record<string, string> = {}, files: { name: string; bytes: Uint8Array; type: string }[] = []) {
    const res = await call('POST', '/portal/orgs/org_a/requests', {
      who,
      form: requestForm({ topic: 'tournament', subject: 'Beamer-Ansicht zeigt alte Resultate', body: 'Seit 19:55 zeigt der Beamer alte Resultate.', ...extra }, files),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await json(res)).id as string;
  }

  it('opens requests with sequential codes, attachments and a mail to staff', async () => {
    const mail = fakeFetch([['https://api.resend.com/', () => Response.json({ id: 'm' })]]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(mail.fn);
    await env.DB.prepare("INSERT INTO requests (id, seq, code, user_id, topic, subject, created_at, updated_at) VALUES ('old', 1184, 'REQ-1184', 'x', 'other', 'old', 0, 0)").run();
    await addTournament({ id: 't_live', name: 'Gurten LAN', org: 'org_a', state: 'live' });
    const res = await call('POST', '/portal/orgs/org_a/requests', {
      who: NOA,
      env: { RESEND_API_KEY: 're_test' },
      form: requestForm({ topic: 'tournament', subject: 'Beamer', body: 'Alte Resultate', tournamentId: 't_live', urgent: '1' }, [{ name: 'beamer-foto.png', bytes: PNG, type: 'image/png' }]),
    });
    const { id } = await json(res);
    const detail = await json(get(`/portal/orgs/org_a/requests/${id}`, { who: MATTEO }));
    expect(detail).toMatchObject({ code: 'REQ-1185', urgent: true, status: 'open', tournament: { id: 't_live', name: 'Gurten LAN' }, lastEvent: expect.stringMatching(/^Gesendet um \d\d:\d\d$/) });
    expect(detail.messages[0].attachments[0]).toMatchObject({ name: 'beamer-foto.png', type: 'image/png', size: PNG.length });
    expect(JSON.parse(mail.calls[0].body)).toMatchObject({ to: ['staff@planary.test'], subject: '[Urgent] New support request REQ-1185: Beamer' });

    // The signed link works for members and staff with the token, not without it or for others.
    const url = new URL(detail.messages[0].attachments[0].url);
    const path = url.pathname + url.search;
    expect((await get(path, { who: MATTEO })).status).toBe(200);
    expect((await get(path)).status).toBe(401);
    expect((await get(path, { who: SARA })).status).toBe(404);
    await addStaff(SUPPORT, 'support');
    expect((await get(path, { who: SUPPORT })).status).toBe(200);
    expect((await get(url.pathname + '?exp=1&sig=00', { who: MATTEO })).status).toBe(403);

    // Rejected uploads
    const svg = await call('POST', '/portal/orgs/org_a/requests', { who: NOA, form: requestForm({ topic: 'other', body: 'x' }, [{ name: 'a.png', bytes: new TextEncoder().encode('<svg/>'), type: 'image/png' }]) });
    expect(svg.status).toBe(415);
    const four = await call('POST', '/portal/orgs/org_a/requests', { who: NOA, form: requestForm({ topic: 'other', body: 'x' }, Array(4).fill({ name: 'a.png', bytes: PNG, type: 'image/png' })) });
    expect(four.status).toBe(400);
    expect((await call('POST', '/portal/orgs/org_a/requests', { who: NOA, form: requestForm({ topic: 'nope', body: 'x' }) })).status).toBe(400);
  });

  it('never returns internal notes or their files to the portal', async () => {
    await addStaff(OWNER, 'owner');
    const id = await openRequest();
    const SECRET = 'INTERNAL-ONLY-7f3a';
    await post(`/console/support/${id}/messages`, { kind: 'internal', body: `${SECRET} Lea rolls back` }, { who: OWNER });
    await env.DB.prepare(
      "INSERT INTO attachments (id, request_id, message_id, org_id, r2_key, name, size, type, created_at) SELECT 'att_secret', request_id, id, 'org_a', 'k', ?, 1, 'image/png', 0 FROM request_messages WHERE kind = 'internal'",
    )
      .bind(`${SECRET}.png`)
      .run();
    await post(`/console/support/${id}/messages`, { kind: 'staff', body: 'Hallo Noa, wir sind dran.' }, { who: OWNER });
    await addTournament({ id: 't_a', org: 'org_a', state: 'live' });

    const portalGets = [
      '/portal/me',
      '/portal/orgs/org_a',
      '/portal/orgs/org_a/requests',
      `/portal/orgs/org_a/requests/${id}`,
      '/portal/orgs/org_a/tournaments',
      '/portal/orgs/org_a/tournaments/t_a',
      '/portal/orgs/org_a/members',
      '/portal/orgs/org_a/billing',
    ];
    for (const who of [MATTEO, NOA]) {
      for (const p of portalGets) {
        const text = await (await get(p, { who })).text();
        expect(text, p).not.toContain(SECRET);
        expect(text, p).not.toContain('internal');
      }
    }
    const detail = await json(get(`/portal/orgs/org_a/requests/${id}`, { who: NOA }));
    expect(detail.messages.map((m: any) => m.kind)).toEqual(['customer', 'staff']);
    expect(detail.messages[1].author).toEqual({ id: 'planary', name: 'Mykyta von Planary' });
    expect(detail.lastEvent).toMatch(/^Planary hat um \d\d:\d\d geantwortet$/);
    // The Console sees everything.
    const consoleDetail = await (await get(`/console/support/${id}`, { who: OWNER })).text();
    expect(consoleDetail).toContain(SECRET);
  });

  it('reopens on a customer reply and lets members mark it done', async () => {
    await addStaff(OWNER, 'owner');
    const id = await openRequest();
    await post(`/console/support/${id}/messages`, { kind: 'staff', body: 'Welche Runde?', setStatus: 'waiting' }, { who: OWNER });
    let list = await json(get('/portal/orgs/org_a/requests', { who: NOA }));
    expect(list.requests[0]).toMatchObject({ status: 'waiting', lastEvent: 'Wir brauchen noch eine Angabe von dir' });
    expect(list.requests[0].assignee).toBeUndefined();
    expect(list.requests[0].unread).toBeUndefined();
    await post(`/portal/orgs/org_a/requests/${id}/messages`, { body: 'Halbfinal 2' }, { who: NOA });
    const consoleList = await json(get('/console/support', { who: OWNER }));
    expect(consoleList.requests[0]).toMatchObject({ status: 'open', unread: true });
    await post(`/portal/orgs/org_a/requests/${id}/done`, {}, { who: NOA });
    list = await json(get('/portal/orgs/org_a/requests', { who: NOA }));
    expect(list.requests[0].status).toBe('done');
    expect(list.requests[0].lastEvent).toMatch(/^Erledigt am \d\d\.\d\d\.$/);
    expect((await get(`/portal/orgs/org_b/requests/${id}`, { who: SARA })).status).toBe(404);
  });
});

describe('banners', () => {
  it('shows overdue invoices to owners and incident updates to organisations with a live tournament', async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO invoices (id, org_id, number, created_at, due_at, amount, status, updated_at) VALUES ('in_1', 'org_a', '2026-0142', ?, ?, 22800, 'open', ?)",
    )
      .bind(now - 26 * DAY, now - 12 * DAY - 3_600_000, now)
      .run();
    const owner = await json(get('/portal/orgs/org_a', { who: MATTEO }));
    expect(owner.banners).toHaveLength(1);
    expect(owner.banners[0]).toMatchObject({ kind: 'overdue', ref: 'in_1' });
    expect(owner.banners[0].text).toMatch(/^Rechnung 2026-0142 über CHF 228\.00 ist seit 12 Tagen überfällig\. Bitte bis \d+\. \S+( \d{4})? bezahlen, sonst wechselt euer Plan zu Gratis\.$/);
    expect(owner.counts.overdueInvoices).toBe(1);
    const member = await json(get('/portal/orgs/org_a', { who: NOA }));
    expect(member.banners).toEqual([]);

    await addStaff(OWNER, 'owner');
    await addTournament({ id: 't_live', org: 'org_a', state: 'live' });
    await addTournament({ id: 't_b', org: 'org_b', state: 'open' });
    const inc = await json(post('/console/incidents', { title: 'Live-API', severity: 'major', services: ['tournament'], message: 'x' }, { who: OWNER }));
    await post(`/console/incidents/${inc.id}/updates`, { status: 'identified', message: 'Live-Resultate kommen verzögert an.', showToOrganisers: true }, { who: OWNER });
    const a = await json(get('/portal/orgs/org_a', { who: NOA }));
    expect(a.banners).toEqual([{ kind: 'incident', text: expect.stringMatching(/^Störung bei Planary seit \d\d:\d\d\. Live-Resultate kommen verzögert an\.$/), ref: inc.id, tournamentIds: ['t_live'] }]);
    const b = await json(get('/portal/orgs/org_b', { who: SARA }));
    expect(b.banners).toEqual([]);
    const page = await json(get('/portal/orgs/org_a/tournaments/t_live', { who: NOA }));
    expect(page.banners).toHaveLength(1);
    const internal = await json(get('/internal/banners?tournament=t_live', { internal: true }));
    expect(internal.banners[0].tournamentIds).toEqual(['t_live']);
    await post(`/console/incidents/${inc.id}/updates`, { status: 'resolved', message: 'Behoben.', showToOrganisers: false }, { who: OWNER });
    expect((await json(get('/portal/orgs/org_a', { who: NOA }))).banners).toEqual([]);
  });
});
