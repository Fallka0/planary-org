// Stripe: webhook signatures and idempotency, state from events, checkout (plans v2: Plus and the
// Turnier-Pass), cancel; and /internal/limits.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formEncode, signStripePayload, verifyStripeSignature } from '../src/lib/stripe';
import { DAY } from '../src/lib/util';
import { app } from '../src/index';
import { addOrg, addTournament, env, fakeFetch, get, json, post, reset, type Who } from './helpers';
import { safeReturnTo } from '../src/lib/billing';
import { applyDueSwitches } from '../src/cron';

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
      total: 14900,
      currency: 'chf',
      status: 'open',
      hosted_invoice_url: 'https://invoice.stripe.test/in_1',
      invoice_pdf: 'https://invoice.stripe.test/in_1.pdf',
      lines: { data: [{ description: 'Plus, 3.2.2026 bis 2.2.2027', amount: 14900, price: { recurring: { interval: 'year' } } }] },
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


const NOA: Who = { id: 'u_noa', email: 'noa@example.test', name: 'Noa Brunner' };
const SARA: Who = { id: 'u_sara', email: 'sara@example.test', name: 'Sara Meier' };
const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_PLUS: 'price_plus', STRIPE_PRICE_PASS: 'price_pass' };

/** A fake Stripe that answers the calls checkout, pay-by and cancel make. */
function fakeStripe(periodEnd = Math.floor((Date.now() + 300 * DAY) / 1000)) {
  let n = 0;
  return fakeFetch([
    ['https://api.stripe.com/v1/customers', () => Response.json({ id: 'cus_new' })],
    ['https://api.stripe.com/v1/checkout/sessions', () => Response.json({ id: `cs_${++n}`, url: `https://checkout.stripe.test/cs_${n}` })],
    ['https://api.stripe.com/v1/subscriptions/', () => Response.json({ id: 'sub_1', current_period_end: periodEnd, cancel_at: periodEnd })],
    ['https://api.stripe.com/v1/subscriptions', () => Response.json({ id: 'sub_inv', status: 'active', current_period_end: periodEnd })],
    ['https://api.stripe.com/v1/billing_portal/sessions', () => Response.json({ url: 'https://billing.stripe.test/p' })],
    ['https://api.stripe.com/v1/invoices/', () => Response.json({ hosted_invoice_url: 'https://invoice.stripe.test/fresh' })],
  ]);
}

const sessionBody = (calls: { url: string; body: string }[], i = 0) => new URLSearchParams(calls.filter((c) => c.url.endsWith('/checkout/sessions'))[i].body);

describe('billing state from events', () => {
  it('stores invoices with lines, subscriptions and cards, and reports the state', async () => {
    await deliver(invoiceEvent('evt_1'));
    let billing = await json(get('/portal/orgs/org_a/billing', { who: MATTEO }));
    expect(billing.invoices[0]).toMatchObject({
      id: 'in_1',
      number: '2026-0142',
      amount: 14900,
      status: 'open',
      overdueDays: 12,
      description: 'Plus, 3.2.2026 bis 2.2.2027',
      lines: [{ kind: 'base', name: 'Plus, 3.2.2026 bis 2.2.2027', period: 'year', amount: 14900, tournamentId: null }],
      paidWith: null,
    });
    expect(billing.plans.map((p: any) => [p.id, p.price, p.period])).toEqual([
      ['gratis', 0, 'forever'],
      ['plus', 14900, 'year'],
    ]);
    expect(billing.plans[0].placeholder).toBeUndefined();
    expect(billing.pass).toMatchObject({ id: 'tournament_pass', name: 'Turnier-Pass', nameEn: 'Tournament Pass', price: 2900, period: 'tournament', limits: { maxTeams: 128 } });
    // An open invoice past its due date: overdue, with the grace date 26 days after the due date.
    expect(billing.state).toBe('overdue');
    expect(billing.graceUntil).toBe(billing.invoices[0].dueAt + 26 * DAY);

    const periodEnd = Math.floor((Date.now() + 300 * DAY) / 1000);
    await deliver({ id: 'evt_sub', type: 'customer.subscription.created', data: { object: { id: 'sub_1', customer: 'cus_a', status: 'active', collection_method: 'charge_automatically', items: { data: [{ current_period_end: periodEnd }] }, metadata: { org: 'org_a' } } } });
    let org = await json(get('/portal/orgs/org_a', { who: MATTEO }));
    expect(org.plan.id).toBe('plus');
    expect(org.renewsAt).toBe(periodEnd * 1000);

    await deliver({ ...invoiceEvent('evt_paid', { status: 'paid', status_transitions: { paid_at: Math.floor(Date.now() / 1000) } }, 'invoice.paid') });
    // A card that expires before the renewal.
    const soon = new Date(Date.now() + 40 * DAY);
    await deliver({ id: 'evt_pm', type: 'payment_method.attached', data: { object: { id: 'pm_1', type: 'card', customer: 'cus_a', card: { brand: 'visa', last4: '4242', exp_month: soon.getUTCMonth() + 1, exp_year: soon.getUTCFullYear() } } } });
    billing = await json(get('/portal/orgs/org_a/billing', { who: MATTEO }));
    expect(billing.invoices[0]).toMatchObject({ status: 'paid', paidWith: 'card' });
    expect(billing).toMatchObject({ current: 'plus', state: 'card_expires', payBy: 'card', graceUntil: null, reminderAt: periodEnd * 1000 - 30 * DAY });
    expect(billing.lines).toEqual([{ kind: 'base', name: 'Planary Plus', period: 'year', amount: 14900, tournamentId: null }]);
    expect(billing.paymentMethod).toMatchObject({ brand: 'visa', last4: '4242' });
    expect(org.billingState).toBe('overdue');
    expect((await json(get('/portal/orgs/org_a', { who: MATTEO }))).billingState).toBe('card_expires');

    await deliver({ id: 'evt_del', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_a', status: 'canceled' } } });
    org = await json(get('/portal/orgs/org_a', { who: MATTEO }));
    expect(org.plan.id).toBe('gratis');
    expect(org.renewsAt).toBeNull();
    expect(org.billingState).toBe('free');
  });

  it('records a pass from a completed checkout and lists it', async () => {
    await addTournament({ id: 't_1', org: 'org_a', name: 'Thuner Herbst-Cup', teams: 23 });
    await env.DB.prepare(
      "INSERT INTO checkouts (id, org_id, kind, pay_by, tournament_id, tournament_name, amount, session_id, receipt_email, created_by, created_at, updated_at) VALUES ('co_1', 'org_a', 'pass', 'card', 't_1', 'Thuner Herbst-Cup', 2900, 'cs_1', 'kasse@gurten.test', 'u_matteo', 1, 1)",
    ).run();
    await deliver({ id: 'evt_cs', type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', customer: 'cus_a', amount_total: 2900, invoice: 'in_p', metadata: { org: 'org_a', kind: 'pass', tournament: 't_1', checkout: 'co_1' } } } });
    expect(await json(get('/internal/limits?org=org_a&tournament=t_1&user=u_matteo', { internal: true }))).toMatchObject({
      plan: 'gratis',
      source: 'event_pass',
      passTournamentId: 't_1',
      limits: { maxTeams: 128, waitingList: true, matchDaySupport: false, invoice: false },
    });
    const status = await json(get('/portal/checkout/co_1', { who: MATTEO }));
    expect(status).toMatchObject({ id: 'co_1', orgId: 'org_a', kind: 'pass', state: 'paid', amount: 2900, payBy: 'card', tournamentName: 'Thuner Herbst-Cup', receiptEmail: 'kasse@gurten.test' });
    // The receipt arrives with the invoice.
    await deliver({ id: 'evt_inv', type: 'invoice.paid', data: { object: { id: 'in_p', customer: 'cus_a', number: 'P-1', total: 2900, status: 'paid', invoice_pdf: 'https://invoice.stripe.test/in_p.pdf', metadata: { org: 'org_a', tournament: 't_1' }, lines: { data: [{ description: 'Turnier-Pass, Thuner Herbst-Cup', amount: 2900 }] } } } });
    const billing = await json(get('/portal/orgs/org_a/billing', { who: MATTEO }));
    expect(billing.passes).toEqual([
      expect.objectContaining({ tournamentId: 't_1', tournamentName: 'Thuner Herbst-Cup', amount: 2900, state: 'active', teams: 23, invoiceId: 'in_p', receiptUrl: 'https://invoice.stripe.test/in_p.pdf' }),
    ]);
    expect(billing.lines).toEqual([{ kind: 'once', name: 'Turnier-Pass · Thuner Herbst-Cup', period: 'once', amount: 2900, tournamentId: 't_1' }]);
    expect(billing.invoices[0].lines).toEqual([{ kind: 'once', name: 'Turnier-Pass, Thuner Herbst-Cup', period: 'once', amount: 2900, tournamentId: 't_1' }]);
    expect((await json(get('/portal/orgs/org_a', { who: MATTEO }))).activePasses).toBe(1);
    expect((await json(get('/portal/checkout/co_1', { who: MATTEO }))).receiptUrl).toBe('https://invoice.stripe.test/in_p.pdf');
  });

  it('marks a checkout failed when the card is declined', async () => {
    await env.DB.prepare(
      "INSERT INTO checkouts (id, org_id, kind, pay_by, amount, session_id, receipt_email, created_by, created_at, updated_at) VALUES ('co_2', 'org_a', 'plan', 'card', 14900, 'cs_2', '', 'u_matteo', 1, 1)",
    ).run();
    await deliver({ id: 'evt_pf', type: 'payment_intent.payment_failed', data: { object: { id: 'pi_1', customer: 'cus_a', metadata: { org: 'org_a', checkout: 'co_2' }, last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } } } });
    expect(await json(get('/portal/checkout/co_2', { who: MATTEO }))).toMatchObject({ state: 'failed', failure: 'Auf der Karte ist nicht genug Guthaben.' });
    // Someone else can't read it.
    expect((await get('/portal/checkout/co_2', { who: SARA })).status).toBe(404);
  });
});

describe('checkout', () => {
  it('answers 503 billing_not_configured without Stripe', async () => {
    const res = await post('/portal/orgs/org_a/checkout', { plan: 'plus', payBy: 'card' }, { who: MATTEO });
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe('billing_not_configured');
    expect((await post('/portal/orgs/org_a/billing-portal', {}, { who: MATTEO })).status).toBe(503);
    // Everything else keeps working.
    expect((await get('/portal/orgs/org_a/billing', { who: MATTEO })).status).toBe(200);
  });

  it('checks the body: a plan or a pass, never both, old ids refused', async () => {
    for (const body of [{ plan: 'verein', payBy: 'card' }, { plan: 'event' }, { plan: 'plus' }, { plan: 'plus', payBy: 'twint' }, { pass: 'tournament' }, { pass: 'tournament', tournamentId: 't', payBy: 'invoice' }, { plan: 'plus', pass: 'tournament', payBy: 'card' }, {}]) {
      expect((await post('/portal/orgs/org_a/checkout', body, { who: MATTEO, env: STRIPE_ENV })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('starts Plus by card at Stripe Checkout and comes back to the done page', async () => {
    await env.DB.prepare("UPDATE subscriptions SET customer_id = NULL WHERE org_id = 'org_a'").run();
    const stripe = fakeStripe();
    vi.spyOn(globalThis, 'fetch').mockImplementation(stripe.fn);
    const r = await json(post('/portal/orgs/org_a/checkout', { plan: 'plus', payBy: 'card', returnTo: 'https://tournament.planary.ch/t/winter/edit' }, { who: MATTEO, env: STRIPE_ENV }));
    expect(r.url).toBe('https://checkout.stripe.test/cs_1');
    const s = sessionBody(stripe.calls);
    expect(s.get('mode')).toBe('subscription');
    expect(s.getAll('payment_method_types[]')).toEqual(['card']);
    expect(s.get('line_items[0][price]')).toBe('price_plus');
    expect(s.get('customer')).toBe('cus_new');
    expect(s.get('metadata[checkout]')).toBe(r.checkoutId);
    expect(s.get('success_url')).toBe(`https://portal.planary.test/kasse/fertig?id=${r.checkoutId}`);
    expect(s.get('cancel_url')).toBe('https://portal.planary.test/kasse?plan=plus&org=org_a');
    expect(stripe.calls[0].headers.get('authorization')).toBe('Bearer sk_test_x');
    const status = await json(get(`/portal/checkout/${r.checkoutId}`, { who: MATTEO }));
    expect(status).toMatchObject({ kind: 'plan', state: 'pending', amount: 14900, payBy: 'card', returnTo: 'https://tournament.planary.ch/t/winter/edit' });
    // The plan only changes when Stripe says so.
    expect((await json(get('/portal/orgs/org_a', { who: MATTEO }))).plan.id).toBe('gratis');
  });

  it('starts Plus on invoice right away, with nothing charged today', async () => {
    const stripe = fakeStripe();
    vi.spyOn(globalThis, 'fetch').mockImplementation(stripe.fn);
    const r = await json(post('/portal/orgs/org_a/checkout', { plan: 'plus', payBy: 'invoice' }, { who: MATTEO, env: STRIPE_ENV }));
    expect(r.url).toBe(`https://portal.planary.test/kasse/fertig?id=${r.checkoutId}`);
    const sub = new URLSearchParams(stripe.calls.find((c) => c.url.endsWith('/v1/subscriptions'))!.body);
    expect(sub.get('collection_method')).toBe('send_invoice');
    expect(sub.get('days_until_due')).toBe('30');
    expect(sub.get('items[0][price]')).toBe('price_plus');
    expect(await json(get(`/portal/checkout/${r.checkoutId}`, { who: MATTEO }))).toMatchObject({ state: 'paid', amount: 0, payBy: 'invoice' });
    const billing = await json(get('/portal/orgs/org_a/billing', { who: MATTEO }));
    expect(billing).toMatchObject({ current: 'plus', state: 'active', payBy: 'invoice' });
    // A second Plus is refused.
    const again = await post('/portal/orgs/org_a/checkout', { plan: 'plus', payBy: 'card' }, { who: MATTEO, env: STRIPE_ENV });
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe('already_subscribed');
  });

  it('sells a pass by card for a tournament of the organisation, once', async () => {
    await addTournament({ id: 't_1', org: 'org_a', name: 'Planary Winter Cup' });
    await addTournament({ id: 't_other', org: null, owner: 'u_someone' });
    await addTournament({ id: 't_done', org: 'org_a', state: 'done' });
    const stripe = fakeStripe();
    vi.spyOn(globalThis, 'fetch').mockImplementation(stripe.fn);
    const r = await json(post('/portal/orgs/org_a/checkout', { pass: 'tournament', tournamentId: 't_1' }, { who: MATTEO, env: STRIPE_ENV }));
    expect(r.url).toBe('https://checkout.stripe.test/cs_1');
    const s = sessionBody(stripe.calls);
    expect(s.get('mode')).toBe('payment');
    expect(s.getAll('payment_method_types[]')).toEqual(['card']);
    expect(s.get('currency')).toBe('chf');
    expect(s.get('line_items[0][price]')).toBe('price_pass');
    expect(s.get('metadata[tournament]')).toBe('t_1');
    expect(s.get('metadata[kind]')).toBe('pass');
    expect(s.get('cancel_url')).toBe('https://portal.planary.test/kasse?pass=tournament&tournament=t_1&org=org_a');
    // Another person's tournament, a finished one, or a second pass: refused.
    expect((await post('/portal/orgs/org_a/checkout', { pass: 'tournament', tournamentId: 't_other' }, { who: MATTEO, env: STRIPE_ENV })).status).toBe(404);
    expect((await json(post('/portal/orgs/org_a/checkout', { pass: 'tournament', tournamentId: 't_done' }, { who: MATTEO, env: STRIPE_ENV }))).code).toBe('tournament_done');
    await env.DB.prepare("INSERT INTO passes (id, org_id, tournament_id, amount, created_at) VALUES ('p1', 'org_a', 't_1', 2900, ?)").bind(Date.now()).run();
    expect((await json(post('/portal/orgs/org_a/checkout', { pass: 'tournament', tournamentId: 't_1' }, { who: MATTEO, env: STRIPE_ENV }))).code).toBe('already_paid');
  });

  it('keeps checkout to owners', async () => {
    await env.DB.prepare("INSERT INTO members (org_id, user_id, name, email, role, created_at) VALUES ('org_a', 'u_noa', 'Noa', 'noa@example.test', 'member', 1)").run();
    for (const p of ['/portal/orgs/org_a/checkout', '/portal/orgs/org_a/cancel', '/portal/orgs/org_a/pay-by', '/portal/orgs/org_a/billing-portal']) {
      expect((await post(p, { plan: 'plus', payBy: 'card' }, { who: NOA, env: STRIPE_ENV })).status, p).toBe(403);
    }
    expect((await get('/portal/orgs/org_a/billing', { who: NOA })).status).toBe(403);
  });

  it('creates the organisation for a solo organiser buying a pass', async () => {
    await addTournament({ id: 't_solo', org: null, owner: NOA.id, name: 'Planary Winter Cup' });
    await addTournament({ id: 't_not_mine', org: null, owner: 'u_someone' });
    const stripe = fakeStripe();
    vi.spyOn(globalThis, 'fetch').mockImplementation(stripe.fn);
    expect((await post('/portal/checkout', { pass: 'tournament', tournamentId: 't_not_mine', org: { name: 'Noa Events', email: 'noa@example.test' } }, { who: NOA, env: STRIPE_ENV })).status).toBe(404);
    expect((await post('/portal/checkout', { pass: 'tournament', tournamentId: 't_solo', org: { name: 'Noa Events', email: 'nope' } }, { who: NOA, env: STRIPE_ENV })).status).toBe(400);
    // Nothing was created by the refused attempts.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM organisations').first<{ n: number }>())?.n).toBe(1);

    const r = await json(post('/portal/checkout', { pass: 'tournament', tournamentId: 't_solo', org: { name: 'Noa Events', email: 'Kasse@Noa.test' }, returnTo: 'https://evil.example/x' }, { who: NOA, env: STRIPE_ENV }));
    expect(r.url).toBe('https://checkout.stripe.test/cs_1');
    const me = await json(get('/portal/me', { who: NOA }));
    expect(me.orgs).toEqual([expect.objectContaining({ id: r.orgId, name: 'Noa Events', role: 'owner', plan: 'gratis' })]);
    const org = await json(get(`/portal/orgs/${r.orgId}`, { who: NOA }));
    expect(org).toMatchObject({ slug: 'noa-events', contact: { email: 'kasse@noa.test' } });
    expect(sessionBody(stripe.calls).get('metadata[tournament]')).toBe('t_solo');
    // A returnTo outside planary.ch is dropped.
    expect((await json(get(`/portal/checkout/${r.checkoutId}`, { who: NOA }))).returnTo).toBeNull();
  });

  it('only accepts returnTo on planary.ch over https', () => {
    expect(safeReturnTo('https://tournament.planary.ch/t/x?step=3')).toBe('https://tournament.planary.ch/t/x?step=3');
    expect(safeReturnTo('https://planary.ch/preise')).toBe('https://planary.ch/preise');
    for (const bad of ['http://planary.ch/', 'https://planary.ch.evil.example/', 'https://evilplanary.ch/', 'javascript:alert(1)', 'https://user@planary.ch/', 'https://planary.ch:8443/', '', 42, null]) {
      expect(safeReturnTo(bad), String(bad)).toBeNull();
    }
  });

  it('pays an open invoice at Stripe and switches between card and invoice', async () => {
    await deliver(invoiceEvent('evt_1', { hosted_invoice_url: null }));
    const stripe = fakeStripe();
    vi.spyOn(globalThis, 'fetch').mockImplementation(stripe.fn);
    expect(await json(post('/portal/orgs/org_a/invoices/in_1/pay', {}, { who: MATTEO, env: STRIPE_ENV }))).toEqual({ url: 'https://invoice.stripe.test/fresh' });
    expect((await post('/portal/orgs/org_a/invoices/in_nope/pay', {}, { who: MATTEO, env: STRIPE_ENV })).status).toBe(404);

    expect((await json(post('/portal/orgs/org_a/pay-by', { payBy: 'invoice' }, { who: MATTEO, env: STRIPE_ENV }))).code).toBe('no_subscription');
    await env.DB.prepare("UPDATE subscriptions SET plan = 'plus', state = 'active', subscription_id = 'sub_1', pay_by = 'card' WHERE org_id = 'org_a'").run();
    expect((await post('/portal/orgs/org_a/pay-by', { payBy: 'invoice' }, { who: MATTEO, env: STRIPE_ENV })).status).toBe(200);
    expect(new URLSearchParams(stripe.calls.at(-1)!.body).get('collection_method')).toBe('send_invoice');
    expect((await json(get('/portal/orgs/org_a/billing', { who: MATTEO }))).payBy).toBe('invoice');
    // Back to card needs a card on file.
    expect((await json(post('/portal/orgs/org_a/pay-by', { payBy: 'card' }, { who: MATTEO, env: STRIPE_ENV }))).code).toBe('no_card');
  });
});

describe('switch to Gratis', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE subscriptions SET plan = 'plus', state = 'active', subscription_id = 'sub_1', current_period_end = ? WHERE org_id = 'org_a'").bind(Date.now() + 100 * DAY),
      ...[NOA, SARA].map((w) => env.DB.prepare("INSERT INTO members (org_id, user_id, name, email, role, created_at) VALUES ('org_a', ?, ?, ?, 'member', 1)").bind(w.id, w.name, w.email)),
    ]);
  });

  it('asks who keeps organising, takes effect at the end of the year, and can be undone', async () => {
    const periodEnd = Math.floor((Date.now() + 100 * DAY) / 1000);
    const stripe = fakeStripe(periodEnd);
    vi.spyOn(globalThis, 'fetch').mockImplementation(stripe.fn);
    // Three people, two Gratis seats: pick 1 or 2, at least one owner, all members.
    for (const keep of [[], [MATTEO.id, NOA.id, SARA.id], [NOA.id], [MATTEO.id, 'u_stranger']]) {
      expect((await post('/portal/orgs/org_a/cancel', { keep }, { who: MATTEO, env: STRIPE_ENV })).status, keep.join()).toBe(400);
    }
    const r = await json(post('/portal/orgs/org_a/cancel', { keep: [MATTEO.id, NOA.id] }, { who: MATTEO, env: STRIPE_ENV }));
    expect(r.cancelAt).toBe(periodEnd * 1000);
    expect(new URLSearchParams(stripe.calls.at(-1)!.body).get('cancel_at_period_end')).toBe('true');
    expect(await json(get('/portal/orgs/org_a/billing', { who: MATTEO }))).toMatchObject({ state: 'canceling', cancelAt: periodEnd * 1000, current: 'plus' });

    expect((await post('/portal/orgs/org_a/cancel/undo', {}, { who: MATTEO, env: STRIPE_ENV })).status).toBe(200);
    expect(new URLSearchParams(stripe.calls.at(-1)!.body).get('cancel_at_period_end')).toBe('false');
    expect(await json(get('/portal/orgs/org_a/billing', { who: MATTEO }))).toMatchObject({ state: 'active', cancelAt: null });

    await post('/portal/orgs/org_a/cancel', { keep: [MATTEO.id, NOA.id] }, { who: MATTEO, env: STRIPE_ENV });
    // The year ends: Stripe deletes the subscription; Sara leaves the organisation, her account stays.
    await deliver({ id: 'evt_end', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_a', status: 'canceled', metadata: { org: 'org_a' } } } });
    const members = await env.DB.prepare("SELECT user_id FROM members WHERE org_id = 'org_a' ORDER BY user_id").all<{ user_id: string }>();
    expect(members.results.map((m) => m.user_id)).toEqual([MATTEO.id, NOA.id]);
    expect(await json(get('/portal/orgs/org_a/billing', { who: MATTEO }))).toMatchObject({ current: 'gratis', state: 'free', cancelAt: null });
  });

  it('applies a due switch the daily run finds, if the webhook got lost', async () => {
    await env.DB.prepare(`UPDATE subscriptions SET plan = 'gratis', state = 'canceled', cancel_at = ?, cancel_keep = '["u_matteo"]' WHERE org_id = 'org_a'`).bind(Date.now() - 3 * DAY).run();
    await applyDueSwitches(env);
    const members = await env.DB.prepare("SELECT user_id FROM members WHERE org_id = 'org_a'").all<{ user_id: string }>();
    expect(members.results.map((m) => m.user_id)).toEqual([MATTEO.id]);
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
    expect(r).toEqual({
      plan: 'gratis',
      passTournamentId: null,
      source: 'person',
      running: 1,
      limits: expect.objectContaining({ maxTeams: 16, maxRunning: 1, maxOrganisers: 2, branding: false, checkIn: true, waitingList: false }),
    });
  });

  it('gives a Plus organisation its limits', async () => {
    await env.DB.prepare("UPDATE subscriptions SET plan = 'plus', state = 'active' WHERE org_id = 'org_a'").run();
    await addTournament({ id: 't_1', org: 'org_a', state: 'live' });
    await addTournament({ id: 't_2', org: 'org_a', state: 'live' });
    const r = await json(get('/internal/limits?org=org_a&user=u_matteo&tournament=t_1', { internal: true }));
    expect(r).toMatchObject({ plan: 'plus', source: 'organisation', running: 2, limits: { maxTeams: 128, maxRunning: null, maxOrganisers: 10, invoice: true, matchDaySupport: true } });
    expect((await get('/internal/limits?org=org_nope&user=u_matteo', { internal: true })).status).toBe(404);
  });

  it('gives a tournament with a pass Plus limits, others Gratis, and a staff Plus wins', async () => {
    await env.DB.prepare("INSERT INTO passes (id, org_id, tournament_id, amount, created_at) VALUES ('p1', 'org_a', 't_paid', 2900, ?)").bind(Date.now()).run();
    expect(await json(get('/internal/limits?org=org_a&tournament=t_paid&user=u_matteo', { internal: true }))).toMatchObject({ plan: 'gratis', source: 'event_pass', passTournamentId: 't_paid', limits: { maxTeams: 128 } });
    expect(await json(get('/internal/limits?org=org_a&tournament=t_other&user=u_matteo', { internal: true }))).toMatchObject({ plan: 'gratis', source: 'organisation', limits: { maxTeams: 16 } });
    // A solo organiser's tournament with a pass (bought through a new organisation) also gets it.
    expect(await json(get('/internal/limits?tournament=t_paid&user=u_matteo', { internal: true }))).toMatchObject({ source: 'event_pass' });
    await env.DB.prepare("UPDATE organisations SET plan_override = 'plus' WHERE id = 'org_a'").run();
    expect(await json(get('/internal/limits?org=org_a&tournament=t_paid&user=u_matteo', { internal: true }))).toMatchObject({ plan: 'plus', source: 'organisation' });
  });

  it('pauses Plus for new tournaments only, after the grace date of an overdue invoice', async () => {
    await env.DB.prepare("UPDATE subscriptions SET plan = 'plus', state = 'past_due' WHERE org_id = 'org_a'").run();
    const now = Date.now();
    const insertInvoice = (due: number) =>
      env.DB.prepare("INSERT OR REPLACE INTO invoices (id, org_id, number, created_at, due_at, amount, status, updated_at) VALUES ('in_o', 'org_a', '2026-0213', ?, ?, 14900, 'open', ?)").bind(due - 30 * DAY, due, now).run();
    // 12 days overdue: still within the 26 days.
    await insertInvoice(now - 12 * DAY);
    expect(await json(get('/internal/limits?org=org_a&user=u_matteo', { internal: true }))).toMatchObject({ plan: 'plus' });
    // 30 days overdue: new tournaments get Gratis limits; one created before the grace date keeps Plus.
    await insertInvoice(now - 30 * DAY);
    await env.DB.prepare("INSERT INTO tournaments (id, name, state, owner_id, organisation_id, created_at, updated_at) VALUES ('t_old', 'Old', 'open', 'u_matteo', 'org_a', ?, ?)").bind(now - 20 * DAY, now).run();
    await env.DB.prepare("INSERT INTO tournaments (id, name, state, owner_id, organisation_id, created_at, updated_at) VALUES ('t_new', 'New', 'draft', 'u_matteo', 'org_a', ?, ?)").bind(now - DAY, now).run();
    expect(await json(get('/internal/limits?org=org_a&user=u_matteo', { internal: true }))).toMatchObject({ plan: 'gratis', limits: { maxTeams: 16 } });
    expect(await json(get('/internal/limits?org=org_a&user=u_matteo&tournament=t_new', { internal: true }))).toMatchObject({ plan: 'gratis' });
    expect(await json(get('/internal/limits?org=org_a&user=u_matteo&tournament=t_old', { internal: true }))).toMatchObject({ plan: 'plus' });
    // Paying ends the pause.
    await env.DB.prepare("UPDATE invoices SET status = 'paid' WHERE id = 'in_o'").run();
    expect(await json(get('/internal/limits?org=org_a&user=u_matteo', { internal: true }))).toMatchObject({ plan: 'plus' });
  });

  it('answers membership for the Tournament API', async () => {
    expect(await json(get('/internal/orgs/org_a/membership?user=u_matteo', { internal: true }))).toEqual({ role: 'owner' });
    expect(await json(get('/internal/orgs/org_a/membership?user=u_x', { internal: true }))).toEqual({ role: null });
  });

  it('mirrors tournament events, reading old plan ids as the new ones', async () => {
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
    expect(page).toMatchObject({ name: 'Gurten LAN', plan: 'plus', phase: 'Halbfinals', viewers: 142, organisationName: 'Verein Gurten LAN', played: 29, matches: 31, organisers: [{ name: 'Matteo Keller', role: 'leitet' }] });
    await post('/internal/tournament-events', { ...t, kind: 'updated', plan: 'event', updatedAt: t.updatedAt + 1 }, { internal: true });
    expect((await json(get('/portal/orgs/org_a/tournaments/t_new', { who: MATTEO }))).plan).toBe('gratis');
    // Older updates don't overwrite newer ones.
    await post('/internal/tournament-events', { ...t, kind: 'updated', viewers: 1, updatedAt: t.updatedAt - 1000 }, { internal: true });
    expect((await json(get('/portal/orgs/org_a/tournaments/t_new', { who: MATTEO }))).viewers).toBe(142);
    expect((await post('/internal/tournament-events', { ...t, state: 'bogus' }, { internal: true })).status).toBe(400);
    await post('/internal/tournament-events', { kind: 'deleted', id: 't_new' }, { internal: true });
    expect((await get('/portal/orgs/org_a/tournaments/t_new', { who: MATTEO })).status).toBe(404);
  });
});

describe('encoding', () => {
  it('encodes nested form data like Stripe expects', () => {
    expect(formEncode({ a: { b: 1 }, c: ['x', 'y'], d: [{ e: 'f' }], g: undefined })).toBe('a%5Bb%5D=1&c%5B%5D=x&c%5B%5D=y&d%5B0%5D%5Be%5D=f');
  });
});
