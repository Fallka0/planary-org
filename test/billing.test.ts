// Stripe: webhook signatures and idempotency, state from events, checkout; and /internal/limits.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formEncode, signStripePayload, verifyStripeSignature } from '../src/lib/stripe';
import { DAY } from '../src/lib/util';
import { app } from '../src/index';
import { addOrg, addTournament, env, fakeFetch, get, json, post, reset, type Who } from './helpers';

const MATTEO: Who = { id: 'u_matteo', email: 'matteo@gurten.test', name: 'Matteo Keller' };
const SECRET = 'whsec_test';

beforeEach(async () => {
  await reset();
  await addOrg('org_a', 'Verein Gurten LAN', [{ who: MATTEO, role: 'owner' }]);
  await env.DB.prepare("UPDATE subscriptions SET customer_id = 'cus_a', provider = 'stripe' WHERE org_id = 'org_a'").run();
});
afterEach(() => vi.restoreAllMocks());

async function deliver(event: object, opts: { secret?: string; t?: number; header?: string } = {}) {
  const body = JSON.stringify(event);
  const header = opts.header ?? (await signStripePayload(opts.secret ?? SECRET, body, opts.t));
  return app.request('/webhooks/stripe', { method: 'POST', headers: { 'Stripe-Signature': header, 'Content-Type': 'application/json' }, body }, env);
}

const invoiceEvent = (id: string, over: Record<string, unknown> = {}, type = 'invoice.finalized') => ({
  id,
  type,
  data: {
    object: {
      id: 'in_1',
      object: 'invoice',
      customer: 'cus_a',
      number: '2026-0142',
      created: Math.floor((Date.now() - 26 * DAY) / 1000),
      due_date: Math.floor((Date.now() - 12 * DAY - 3_600_000) / 1000),
      total: 22800,
      currency: 'chf',
      status: 'open',
      hosted_invoice_url: 'https://invoice.stripe.test/in_1',
      invoice_pdf: 'https://invoice.stripe.test/in_1.pdf',
      lines: { data: [{ description: 'Plan Verein, 3.2.2026 bis 2.2.2027' }] },
      ...over,
    },
  },
});

describe('webhook signature', () => {
  it('accepts a valid signature and rejects invalid, stale or missing ones', async () => {
    const ok = await deliver(invoiceEvent('evt_1'));
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ received: true });
    expect((await deliver(invoiceEvent('evt_2'), { secret: 'whsec_wrong' })).status).toBe(400);
    expect((await deliver(invoiceEvent('evt_3'), { t: Math.floor(Date.now() / 1000) - 600 })).status).toBe(400);
    expect((await deliver(invoiceEvent('evt_4'), { header: 'nonsense' })).status).toBe(400);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM provider_events').first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('verifies with any of several v1 signatures', async () => {
    const t = Math.floor(Date.now() / 1000);
    const good = (await signStripePayload(SECRET, 'body', t)).split(',')[1];
    expect(await verifyStripeSignature(SECRET, `t=${t},v1=deadbeef,${good}`, 'body')).toBe(true);
    expect(await verifyStripeSignature(SECRET, `t=${t},v1=deadbeef`, 'body')).toBe(false);
  });

  it('is idempotent for a replayed event id', async () => {
    await deliver(invoiceEvent('evt_1'));
    await deliver(invoiceEvent('evt_paid', { status: 'paid', status_transitions: { paid_at: Math.floor(Date.now() / 1000) } }, 'invoice.paid'));
    // Replaying the older event must not turn the paid invoice back to open.
    const replay = await deliver(invoiceEvent('evt_1'));
    expect(await json(replay)).toEqual({ received: true, duplicate: true });
    const inv = await env.DB.prepare("SELECT status FROM invoices WHERE id = 'in_1'").first<{ status: string }>();
    expect(inv?.status).toBe('paid');
  });

  it('answers 503 when no webhook secret is set', async () => {
    const body = JSON.stringify(invoiceEvent('evt_x'));
    const res = await app.request('/webhooks/stripe', { method: 'POST', body, headers: { 'Stripe-Signature': await signStripePayload(SECRET, body) } }, { ...env, STRIPE_WEBHOOK_SECRET: undefined });
    expect(res.status).toBe(503);
  });
});

describe('billing state from events', () => {
  it('stores invoices, overdue state, subscriptions and cards', async () => {
    await deliver(invoiceEvent('evt_1'));
    const billing = await json(get('/portal/orgs/org_a/billing', { who: MATTEO }));
    expect(billing.invoices[0]).toMatchObject({
      id: 'in_1',
      number: '2026-0142',
      amount: 22800,
      status: 'open',
      overdueDays: 12,
      description: 'Plan Verein, 3.2.2026 bis 2.2.2027',
      payUrl: 'https://invoice.stripe.test/in_1',
      pdfUrl: 'https://invoice.stripe.test/in_1.pdf',
    });
    expect(billing.plans.map((p: any) => [p.id, p.price, p.placeholder])).toEqual([
      ['gratis', 0, true],
      ['event', 4900, true],
      ['verein', 1900, true],
    ]);

    const periodEnd = Math.floor((Date.now() + 300 * DAY) / 1000);
    await deliver({ id: 'evt_sub', type: 'customer.subscription.created', data: { object: { id: 'sub_1', customer: 'cus_a', status: 'active', items: { data: [{ current_period_end: periodEnd }] }, metadata: { org: 'org_a' } } } });
    let org = await json(get('/portal/orgs/org_a', { who: MATTEO }));
    expect(org.plan.id).toBe('verein');
    expect(org.renewsAt).toBe(periodEnd * 1000);

    await deliver({ id: 'evt_pm', type: 'payment_method.attached', data: { object: { id: 'pm_1', type: 'card', customer: 'cus_a', card: { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2028 } } } });
    expect((await json(get('/portal/orgs/org_a/billing', { who: MATTEO }))).paymentMethod).toEqual({ brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028, kind: 'card' });

    await deliver({ id: 'evt_past', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_a', status: 'past_due' } } });
    expect((await json(get('/portal/orgs/org_a', { who: MATTEO }))).plan.id).toBe('verein');
    await deliver({ id: 'evt_del', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_a', status: 'canceled' } } });
    org = await json(get('/portal/orgs/org_a', { who: MATTEO }));
    expect(org.plan.id).toBe('gratis');
    expect(org.renewsAt).toBeNull();
  });

  it('records an event pass from a completed checkout', async () => {
    await addTournament({ id: 't_1', org: 'org_a' });
    await deliver({ id: 'evt_cs', type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', customer: 'cus_a', amount_total: 4900, metadata: { org: 'org_a', tournament: 't_1', plan: 'event' } } } });
    const limits = await json(get('/internal/limits?org=org_a&tournament=t_1&user=u_matteo', { internal: true }));
    expect(limits).toMatchObject({ plan: 'event', source: 'event_pass', limits: { maxTeams: 128 } });
  });
});

describe('checkout', () => {
  it('answers 503 billing_not_configured without Stripe', async () => {
    for (const p of ['/portal/orgs/org_a/checkout', '/portal/orgs/org_a/billing-portal']) {
      const res = await post(p, { plan: 'verein' }, { who: MATTEO });
      expect(res.status, p).toBe(503);
      expect((await json(res)).code).toBe('billing_not_configured');
    }
    // Everything else keeps working.
    expect((await get('/portal/orgs/org_a/billing', { who: MATTEO })).status).toBe(200);
  });

  it('creates Checkout Sessions and the invoice subscription over REST', async () => {
    await env.DB.prepare("UPDATE subscriptions SET customer_id = NULL WHERE org_id = 'org_a'").run();
    await addTournament({ id: 't_1', org: 'org_a' });
    const stripe = fakeFetch([
      ['https://api.stripe.com/v1/customers', () => Response.json({ id: 'cus_new' })],
      ['https://api.stripe.com/v1/checkout/sessions', () => Response.json({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' })],
      ['https://api.stripe.com/v1/subscriptions', () => Response.json({ id: 'sub_inv', latest_invoice: { id: 'in_9', status: 'draft', hosted_invoice_url: null } })],
      ['https://api.stripe.com/v1/invoices/in_9/finalize', () => Response.json({ id: 'in_9', hosted_invoice_url: 'https://invoice.stripe.test/in_9' })],
      ['https://api.stripe.com/v1/billing_portal/sessions', () => Response.json({ url: 'https://billing.stripe.test/p' })],
    ]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(stripe.fn);
    const e = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_EVENT: 'price_event', STRIPE_PRICE_VEREIN: 'price_verein' };

    const event = await json(post('/portal/orgs/org_a/checkout', { plan: 'event', tournamentId: 't_1' }, { who: MATTEO, env: e }));
    expect(event.url).toBe('https://checkout.stripe.test/cs_1');
    const session = new URLSearchParams(stripe.calls.find((c) => c.url.endsWith('/checkout/sessions'))!.body);
    expect(session.get('mode')).toBe('payment');
    expect(session.getAll('payment_method_types[]')).toEqual(['card', 'twint']);
    expect(session.get('currency')).toBe('chf');
    expect(session.get('customer')).toBe('cus_new');
    expect(session.get('metadata[org]')).toBe('org_a');
    expect(session.get('metadata[tournament]')).toBe('t_1');
    expect(session.get('line_items[0][price]')).toBe('price_event');
    expect(stripe.calls[0].headers.get('authorization')).toBe('Bearer sk_test_x');

    const card = await json(post('/portal/orgs/org_a/checkout', { plan: 'verein' }, { who: MATTEO, env: e }));
    expect(card.url).toBe('https://checkout.stripe.test/cs_1');
    const sub = new URLSearchParams(stripe.calls.filter((c) => c.url.endsWith('/checkout/sessions'))[1].body);
    expect(sub.get('mode')).toBe('subscription');
    expect(sub.get('line_items[0][price]')).toBe('price_verein');

    const invoice = await json(post('/portal/orgs/org_a/checkout', { plan: 'verein', payBy: 'invoice' }, { who: MATTEO, env: e }));
    expect(invoice.url).toBe('https://invoice.stripe.test/in_9');
    const subBody = new URLSearchParams(stripe.calls.find((c) => c.url.endsWith('/v1/subscriptions'))!.body);
    expect(subBody.get('collection_method')).toBe('send_invoice');
    expect(subBody.get('days_until_due')).toBe('30');
    // The customer was created once and reused.
    expect(stripe.calls.filter((c) => c.url.endsWith('/v1/customers'))).toHaveLength(1);

    const portal = await json(post('/portal/orgs/org_a/billing-portal', {}, { who: MATTEO, env: e }));
    expect(portal.url).toBe('https://billing.stripe.test/p');
    // The plan doesn't change until a webhook says so.
    expect((await json(get('/portal/orgs/org_a', { who: MATTEO }))).plan.id).toBe('gratis');
  });

  it('encodes nested form data like Stripe expects', () => {
    expect(formEncode({ a: { b: 1 }, c: ['x', 'y'], d: [{ e: 'f' }], g: undefined })).toBe('a%5Bb%5D=1&c%5B%5D=x&c%5B%5D=y&d%5B0%5D%5Be%5D=f');
  });
});

describe('limits', () => {
  it('answers 404 without the internal key', async () => {
    expect((await get('/internal/limits?user=u_1')).status).toBe(404);
    expect((await get('/internal/limits?user=u_1', { headers: { 'x-internal-key': 'wrong' } })).status).toBe(404);
  });

  it('gives a person without an organisation Gratis and counts their live tournaments', async () => {
    await addTournament({ id: 't_solo', owner: 'u_solo', state: 'live' });
    await addTournament({ id: 't_solo2', owner: 'u_solo', state: 'open' });
    await addTournament({ id: 't_org', owner: 'u_solo', state: 'live', org: 'org_a' });
    const r = await json(get('/internal/limits?user=u_solo', { internal: true }));
    expect(r).toEqual({ plan: 'gratis', source: 'person', running: 1, limits: expect.objectContaining({ maxTeams: 16, maxRunning: 1, maxOrganisers: 1, branding: false }) });
  });

  it('gives a Verein organisation its limits', async () => {
    await env.DB.prepare("UPDATE subscriptions SET plan = 'verein', state = 'active' WHERE org_id = 'org_a'").run();
    await addTournament({ id: 't_1', org: 'org_a', state: 'live' });
    await addTournament({ id: 't_2', org: 'org_a', state: 'live' });
    const r = await json(get('/internal/limits?org=org_a&user=u_matteo&tournament=t_1', { internal: true }));
    expect(r).toMatchObject({ plan: 'verein', source: 'organisation', running: 2, limits: { maxRunning: null, maxOrganisers: 5, invoice: true } });
    expect((await get('/internal/limits?org=org_nope&user=u_matteo', { internal: true })).status).toBe(404);
  });

  it('gives a tournament with an event pass Event, and others Gratis', async () => {
    await env.DB.prepare("INSERT INTO event_passes (id, org_id, tournament_id, amount, created_at) VALUES ('p1', 'org_a', 't_paid', 4900, ?)").bind(Date.now()).run();
    expect(await json(get('/internal/limits?org=org_a&tournament=t_paid&user=u_matteo', { internal: true }))).toMatchObject({ plan: 'event', source: 'event_pass' });
    expect(await json(get('/internal/limits?org=org_a&tournament=t_other&user=u_matteo', { internal: true }))).toMatchObject({ plan: 'gratis', source: 'organisation' });
    // A comped Verein from staff wins over the pass.
    await env.DB.prepare("UPDATE organisations SET plan_override = 'verein' WHERE id = 'org_a'").run();
    expect(await json(get('/internal/limits?org=org_a&tournament=t_paid&user=u_matteo', { internal: true }))).toMatchObject({ plan: 'verein', source: 'organisation' });
  });

  it('answers membership for the Tournament API', async () => {
    expect(await json(get('/internal/orgs/org_a/membership?user=u_matteo', { internal: true }))).toEqual({ role: 'owner' });
    expect(await json(get('/internal/orgs/org_a/membership?user=u_x', { internal: true }))).toEqual({ role: null });
  });

  it('mirrors tournament events', async () => {
    const t = {
      kind: 'created',
      id: 't_new',
      slug: 'gurten-lan',
      name: 'Gurten LAN',
      game: 'Counter-Strike 2',
      startsAt: Date.now(),
      endsAt: null,
      state: 'live',
      phase: 'Halbfinals',
      teams: 16,
      maxTeams: 16,
      waiting: 2,
      organisationId: 'org_a',
      organisationName: 'Old name',
      ownerId: 'u_matteo',
      plan: 'verein',
      viewers: 142,
      updatedAt: Date.now(),
      organisers: [{ id: 'u_matteo', name: 'Matteo Keller', role: 'leitet' }],
      played: 29,
      matches: 31,
    };
    expect((await post('/internal/tournament-events', t, { internal: true })).status).toBe(200);
    const page = await json(get('/portal/orgs/org_a/tournaments/t_new', { who: MATTEO }));
    expect(page).toMatchObject({ name: 'Gurten LAN', phase: 'Halbfinals', viewers: 142, organisationName: 'Verein Gurten LAN', played: 29, matches: 31, organisers: [{ name: 'Matteo Keller', role: 'leitet' }] });
    // Older updates don't overwrite newer ones.
    await post('/internal/tournament-events', { ...t, kind: 'updated', viewers: 1, updatedAt: t.updatedAt - 1000 }, { internal: true });
    expect((await json(get('/portal/orgs/org_a/tournaments/t_new', { who: MATTEO }))).viewers).toBe(142);
    expect((await post('/internal/tournament-events', { ...t, state: 'bogus' }, { internal: true })).status).toBe(400);
    await post('/internal/tournament-events', { kind: 'deleted', id: 't_new' }, { internal: true });
    expect((await get('/portal/orgs/org_a/tournaments/t_new', { who: MATTEO })).status).toBe(404);
  });
});
