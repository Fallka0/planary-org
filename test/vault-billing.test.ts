// Vault billed through planary-org (ADR 0003): personal accounts at checkout, its own subscription
// next to Planary Plus, plan changes and cancelling, /internal/entitlements, and the Console override.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signStripePayload } from '../src/lib/stripe';
import { DAY } from '../src/lib/util';
import { app } from '../src/index';
import { addOrg, addStaff, env, fakeFetch, get, json, OWNER, post, reset, type Who } from './helpers';

const NOA: Who = { id: 'u_noa', email: 'noa@example.test', name: 'Noa Brunner' };
const MATTEO: Who = { id: 'u_matteo', email: 'matteo@gurten.test', name: 'Matteo Keller' };
const SECRET = 'whsec_test';
const PRICES = {
  STRIPE_PRICE_PLUS: 'price_plus',
  STRIPE_PRICE_VAULT_PLUS_MONTH: 'price_vplus_m',
  STRIPE_PRICE_VAULT_PLUS_YEAR: 'price_vplus_y',
  STRIPE_PRICE_VAULT_PRO_MONTH: 'price_vpro_m',
  STRIPE_PRICE_VAULT_PRO_YEAR: 'price_vpro_y',
};
const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_x', ...PRICES };
const VAULT = 'https://vault.planary.ch/settings';

beforeEach(async () => {
  await reset();
  await addOrg('org_a', 'Verein Gurten LAN', [{ who: MATTEO, role: 'owner' }]);
  await env.DB.prepare("UPDATE subscriptions SET customer_id = 'cus_a', provider = 'stripe' WHERE org_id = 'org_a'").run();
});
afterEach(() => vi.restoreAllMocks());

/** Webhooks read the Vault prices from env, so they go through the app with them set. */
async function deliver(event: object) {
  const body = JSON.stringify(event);
  const header = await signStripePayload(SECRET, body);
  return app.request('/webhooks/stripe', { method: 'POST', headers: { 'Stripe-Signature': header, 'Content-Type': 'application/json' }, body }, { ...env, ...PRICES });
}

const periodEnd = Math.floor((Date.now() + 20 * DAY) / 1000);

function fakeStripe() {
  let n = 0;
  return fakeFetch([
    ['https://api.stripe.com/v1/customers', () => Response.json({ id: 'cus_new' })],
    ['https://api.stripe.com/v1/checkout/sessions', () => Response.json({ id: `cs_${++n}`, url: `https://checkout.stripe.test/cs_${n}` })],
    ['https://api.stripe.com/v1/subscription_schedules/', () => Response.json({ id: 'sched_1' })],
    [
      'https://api.stripe.com/v1/subscription_schedules',
      () => Response.json({ id: 'sched_1', phases: [{ start_date: periodEnd - 30 * 86400, end_date: periodEnd, items: [{ price: 'price_vpro_y' }] }] }),
    ],
    ['https://api.stripe.com/v1/subscriptions/', () => Response.json({ id: 'sub_v', items: { data: [{ id: 'si_1' }] }, current_period_end: periodEnd, cancel_at: periodEnd })],
    ['https://api.stripe.com/v1/subscriptions', () => Response.json({ id: 'sub_vinv', status: 'active', current_period_end: periodEnd })],
  ]);
}

const subEvent = (id: string, over: Record<string, unknown> = {}, type = 'customer.subscription.updated') => ({
  id,
  type,
  data: {
    object: {
      id: 'sub_v',
      customer: 'cus_new',
      status: 'active',
      collection_method: 'charge_automatically',
      current_period_end: periodEnd,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_vplus_m' } }] },
      metadata: {},
      ...over,
    },
  },
});

const entitlements = async (who: Who) => (await json(get(`/internal/entitlements?user=${who.id}`, { internal: true }))).vault;

/** Noa buys Vault Plus monthly on her own; the webhooks confirm it. Returns her personal account id. */
async function noaOnPlus() {
  const stripe = fakeStripe();
  vi.spyOn(globalThis, 'fetch').mockImplementation(stripe.fn);
  const r = await json(post('/portal/checkout', { product: 'vault', plan: 'plus', period: 'month', payBy: 'card', returnTo: VAULT }, { who: NOA, env: STRIPE_ENV }));
  await deliver({
    id: 'evt_cs',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', mode: 'subscription', customer: 'cus_new', subscription: 'sub_v', metadata: { org: r.orgId, product: 'vault', plan: 'plus', period: 'month', checkout: r.checkoutId } } },
  });
  await deliver(subEvent('evt_created', { metadata: { org: r.orgId, product: 'vault' } }, 'customer.subscription.created'));
  return { orgId: r.orgId as string, checkoutId: r.checkoutId as string, stripe };
}

describe('checkout', () => {
  it('creates a personal account for a person buying Vault on their own, once', async () => {
    const stripe = fakeStripe();
    vi.spyOn(globalThis, 'fetch').mockImplementation(stripe.fn);
    const r = await json(post('/portal/checkout', { product: 'vault', plan: 'plus', period: 'month', payBy: 'card', returnTo: VAULT }, { who: NOA, env: STRIPE_ENV }));
    expect(r.url).toBe('https://checkout.stripe.test/cs_1');
    const s = new URLSearchParams(stripe.calls.find((c) => c.url.endsWith('/checkout/sessions'))!.body);
    expect(s.get('mode')).toBe('subscription');
    expect(s.get('line_items[0][price]')).toBe('price_vplus_m');
    expect(s.get('metadata[product]')).toBe('vault');
    expect(s.get('subscription_data[metadata][plan]')).toBe('plus');
    expect(s.get('subscription_data[metadata][period]')).toBe('month');
    // Cancelling at Stripe goes back to Vault, which says nothing was charged.
    expect(s.get('cancel_url')).toBe(`${VAULT}?checkout=cancelled`);

    const me = await json(get('/portal/me', { who: NOA }));
    expect(me.orgs).toEqual([expect.objectContaining({ id: r.orgId, name: 'Noa Brunner', role: 'owner', kind: 'personal', services: [] })]);
    expect(await json(get(`/portal/checkout/${r.checkoutId}`, { who: NOA }))).toMatchObject({
      kind: 'plan',
      product: 'vault',
      productPlan: 'plus',
      period: 'month',
      state: 'pending',
      amount: 400,
      returnTo: VAULT,
    });

    // A second checkout uses the same personal account.
    const again = await json(post('/portal/checkout', { product: 'vault', plan: 'pro', period: 'year', payBy: 'card' }, { who: NOA, env: STRIPE_ENV }));
    expect(again.orgId).toBe(r.orgId);
    // Nothing is on until Stripe says so.
    expect(await entitlements(NOA)).toEqual({ plan: 'free', source: 'default', until: null, orgId: null });
  });

  it('checks the body: monthly is by card, plans and periods are known', async () => {
    for (const body of [
      { product: 'vault', plan: 'plus', period: 'month', payBy: 'invoice' },
      { product: 'vault', plan: 'free', period: 'month', payBy: 'card' },
      { product: 'vault', plan: 'plus', period: 'week', payBy: 'card' },
      { product: 'drive', plan: 'plus', period: 'month', payBy: 'card' },
      { product: 'vault', pass: 'tournament', plan: 'plus', period: 'month', payBy: 'card' },
    ]) {
      expect((await post('/portal/orgs/org_a/checkout', body, { who: MATTEO, env: STRIPE_ENV })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('answers 503 when the Vault prices are not set up', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeStripe().fn);
    const res = await post('/portal/orgs/org_a/checkout', { product: 'vault', plan: 'plus', period: 'month', payBy: 'card' }, { who: MATTEO, env: { STRIPE_SECRET_KEY: 'sk_test_x' } });
    expect(res.status).toBe(503);
  });

  it('starts yearly on invoice right away, next to Planary Plus', async () => {
    const stripe = fakeStripe();
    vi.spyOn(globalThis, 'fetch').mockImplementation(stripe.fn);
    const r = await json(post('/portal/orgs/org_a/checkout', { product: 'vault', plan: 'pro', period: 'year', payBy: 'invoice' }, { who: MATTEO, env: STRIPE_ENV }));
    const sub = new URLSearchParams(stripe.calls.find((c) => c.url.endsWith('/v1/subscriptions'))!.body);
    expect(sub.get('collection_method')).toBe('send_invoice');
    expect(sub.get('items[0][price]')).toBe('price_vpro_y');
    expect(await json(get(`/portal/checkout/${r.checkoutId}`, { who: MATTEO }))).toMatchObject({ state: 'paid', amount: 0, payBy: 'invoice', product: 'vault' });
    const billing = await json(get('/portal/orgs/org_a/billing', { who: MATTEO }));
    expect(billing.current).toBe('gratis');
    expect(billing.vault).toMatchObject({ current: 'pro', period: 'year', payBy: 'invoice', renewsAt: periodEnd * 1000, cancelAt: null, pending: null });
    expect(billing.lines).toEqual([{ kind: 'addon', name: 'Vault Pro', period: 'year', amount: 10000, tournamentId: null }]);
    expect(await entitlements(MATTEO)).toMatchObject({ plan: 'pro', source: 'subscription', orgId: 'org_a' });
    // A second Vault subscription is refused.
    const again = await post('/portal/orgs/org_a/checkout', { product: 'vault', plan: 'plus', period: 'month', payBy: 'card' }, { who: MATTEO, env: STRIPE_ENV });
    expect(again.status).toBe(409);
  });
});

describe('webhooks', () => {
  it('turn Vault on from the checkout and subscription events, without touching Planary Plus', async () => {
    const { orgId, checkoutId } = await noaOnPlus();
    expect(await json(get(`/portal/checkout/${checkoutId}`, { who: NOA }))).toMatchObject({ state: 'paid' });
    expect(await entitlements(NOA)).toEqual({ plan: 'plus', source: 'subscription', until: null, orgId });
    const plus = await env.DB.prepare('SELECT plan, state, subscription_id FROM subscriptions WHERE org_id = ?').bind(orgId).first();
    expect(plus).toMatchObject({ plan: 'gratis', state: 'none', subscription_id: null });

    // A Planary Plus event for the same customer leaves Vault alone.
    await deliver(subEvent('evt_plus', { id: 'sub_plus', items: { data: [{ price: { id: 'price_plus' } }] }, metadata: { org: orgId } }));
    expect((await env.DB.prepare('SELECT plan FROM subscriptions WHERE org_id = ?').bind(orgId).first<{ plan: string }>())?.plan).toBe('plus');
    expect(await entitlements(NOA)).toMatchObject({ plan: 'plus', source: 'subscription' });
  });

  it('take Vault away when the subscription ends, but not for an older one ending later', async () => {
    const { orgId } = await noaOnPlus();
    await deliver(subEvent('evt_del', { status: 'canceled' }, 'customer.subscription.deleted'));
    expect(await entitlements(NOA)).toEqual({ plan: 'free', source: 'default', until: null, orgId: null });

    // A new subscription starts, then the old one's deletion arrives late.
    await deliver(subEvent('evt_new', { id: 'sub_new', items: { data: [{ price: { id: 'price_vpro_m' } }] }, metadata: { org: orgId, product: 'vault' } }, 'customer.subscription.created'));
    await deliver(subEvent('evt_old', { status: 'canceled' }, 'customer.subscription.deleted'));
    expect(await entitlements(NOA)).toMatchObject({ plan: 'pro', source: 'subscription' });
  });

  it('marks Vault invoice lines as monthly or yearly add-ons', async () => {
    const { orgId } = await noaOnPlus();
    await deliver({
      id: 'evt_inv',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_v',
          customer: 'cus_new',
          number: '2026-0200',
          status: 'paid',
          total: 400,
          currency: 'chf',
          collection_method: 'charge_automatically',
          metadata: { org: orgId },
          lines: { data: [{ description: 'Vault Plus', amount: 400, price: { id: 'price_vplus_m', recurring: { interval: 'month' } } }] },
        },
      },
    });
    const billing = await json(get(`/portal/orgs/${orgId}/billing`, { who: NOA }));
    expect(billing.invoices[0].lines).toEqual([{ kind: 'addon', name: 'Vault Plus', period: 'month', amount: 400, tournamentId: null }]);
  });
});

describe('changing and cancelling', () => {
  it('upgrades right away and downgrades at the end of the period', async () => {
    const { orgId, stripe } = await noaOnPlus();
    stripe.calls.length = 0;

    // Plus monthly → Pro yearly: now, prorated.
    expect(await json(post(`/portal/orgs/${orgId}/vault/change`, { plan: 'pro', period: 'year' }, { who: NOA, env: STRIPE_ENV }))).toEqual({ ok: true, at: null });
    const update = stripe.calls.find((c) => c.method === 'POST' && c.url.endsWith('/subscriptions/sub_v'))!;
    const u = new URLSearchParams(update.body);
    expect(u.get('items[0][id]')).toBe('si_1');
    expect(u.get('items[0][price]')).toBe('price_vpro_y');
    expect(u.get('proration_behavior')).toBe('always_invoice');
    expect((await json(get(`/portal/orgs/${orgId}/billing`, { who: NOA }))).vault).toMatchObject({ current: 'pro', period: 'year' });

    // Pro yearly → Plus yearly: waits for the end of the period.
    stripe.calls.length = 0;
    const down = await json(post(`/portal/orgs/${orgId}/vault/change`, { plan: 'plus', period: 'year' }, { who: NOA, env: STRIPE_ENV }));
    expect(down).toEqual({ ok: true, at: periodEnd * 1000 });
    const phases = new URLSearchParams(stripe.calls.find((c) => c.url.endsWith('/subscription_schedules/sched_1'))!.body);
    expect(phases.get('phases[0][items][0][price]')).toBe('price_vpro_y');
    expect(phases.get('phases[1][items][0][price]')).toBe('price_vplus_y');
    let vault = (await json(get(`/portal/orgs/${orgId}/billing`, { who: NOA }))).vault;
    expect(vault).toMatchObject({ current: 'pro', pending: { plan: 'plus', period: 'year' } });

    // Picking the current plan again keeps it: the schedule is released.
    stripe.calls.length = 0;
    await post(`/portal/orgs/${orgId}/vault/change`, { plan: 'pro', period: 'year' }, { who: NOA, env: STRIPE_ENV });
    expect(stripe.calls.some((c) => c.url.endsWith('/subscription_schedules/sched_1/release'))).toBe(true);
    vault = (await json(get(`/portal/orgs/${orgId}/billing`, { who: NOA }))).vault;
    expect(vault.pending).toBeNull();

    // When a scheduled downgrade happens, Stripe's price change clears it.
    await post(`/portal/orgs/${orgId}/vault/change`, { plan: 'plus', period: 'year' }, { who: NOA, env: STRIPE_ENV });
    await deliver(subEvent('evt_phase', { items: { data: [{ price: { id: 'price_vplus_y' } }] } }));
    vault = (await json(get(`/portal/orgs/${orgId}/billing`, { who: NOA }))).vault;
    expect(vault).toMatchObject({ current: 'plus', period: 'year', pending: null });
  });

  it('cancels at the end of the period and can be undone', async () => {
    const { orgId } = await noaOnPlus();
    const r = await json(post(`/portal/orgs/${orgId}/vault/cancel`, {}, { who: NOA, env: STRIPE_ENV }));
    expect(r.cancelAt).toBe(periodEnd * 1000);
    expect(await entitlements(NOA)).toMatchObject({ plan: 'plus', until: periodEnd * 1000 });
    expect((await json(get(`/portal/orgs/${orgId}/billing`, { who: NOA }))).vault).toMatchObject({ cancelAt: periodEnd * 1000, renewsAt: null });
    await post(`/portal/orgs/${orgId}/vault/cancel/undo`, {}, { who: NOA, env: STRIPE_ENV });
    expect(await entitlements(NOA)).toMatchObject({ plan: 'plus', until: null });
  });

  it('keeps changes to owners and to accounts that pay for Vault', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeStripe().fn);
    expect((await post('/portal/orgs/org_a/vault/change', { plan: 'pro', period: 'month' }, { who: MATTEO, env: STRIPE_ENV })).status).toBe(409);
    expect((await post('/portal/orgs/org_a/vault/cancel', {}, { who: MATTEO, env: STRIPE_ENV })).status).toBe(409);
    expect((await post('/portal/orgs/org_a/vault/cancel', {}, { who: NOA, env: STRIPE_ENV })).status).toBeGreaterThanOrEqual(403);
  });
});

describe('entitlements', () => {
  it("answers 404 without the internal key, and takes Vault's own key", async () => {
    expect((await get('/internal/entitlements?user=u_noa')).status).toBe(404);
    const own = { headers: { 'x-internal-key': 'vault-only-key' }, env: { INTERNAL_KEY_VAULT: 'vault-only-key' } };
    expect((await get('/internal/entitlements?user=u_noa', own)).status).toBe(200);
    expect((await get('/internal/entitlements?user=u_noa', { headers: { 'x-internal-key': 'vault-only-key' } })).status).toBe(404);
  });

  it('takes the best plan of the accounts a person owns, and a staff override', async () => {
    await noaOnPlus();
    await addOrg('org_b', 'Familie Brunner', [{ who: NOA, role: 'owner' }]);
    await env.DB.prepare("UPDATE organisations SET vault_override = 'pro' WHERE id = 'org_b'").run();
    expect(await entitlements(NOA)).toEqual({ plan: 'pro', source: 'override', until: null, orgId: 'org_b' });
    // Being a member (not owner) of a Pro organisation gives nothing.
    await addOrg('org_c', 'Club', [{ who: MATTEO, role: 'owner' }, { who: { ...NOA, id: 'u_other' }, role: 'member' }]);
    await env.DB.prepare("UPDATE organisations SET vault_override = 'pro' WHERE id = 'org_c'").run();
    expect(await entitlements({ ...NOA, id: 'u_other' })).toMatchObject({ plan: 'free', source: 'default' });
  });

  it('falls back to Vault Free past the grace date of an overdue invoice', async () => {
    const { orgId } = await noaOnPlus();
    const due = Date.now() - 40 * DAY;
    await env.DB.prepare(
      "INSERT INTO invoices (id, org_id, number, created_at, due_at, amount, currency, status, description, updated_at) VALUES ('in_late', ?, '1', ?, ?, 400, 'CHF', 'open', 'Vault Plus', ?)",
    )
      .bind(orgId, due, due, Date.now())
      .run();
    expect(await entitlements(NOA)).toEqual({ plan: 'free', source: 'overdue', until: null, orgId });
  });
});

describe('console', () => {
  it('lets staff set the Vault plan without touching Planary Plus', async () => {
    await addStaff(OWNER, 'owner');
    const res = await post('/console/customers/org_a/plan', { product: 'vault', plan: 'pro', reason: 'Beta tester' }, { who: OWNER });
    expect(res.status).toBe(200);
    expect(await entitlements(MATTEO)).toEqual({ plan: 'pro', source: 'override', until: null, orgId: 'org_a' });
    expect((await json(get('/portal/orgs/org_a/billing', { who: MATTEO }))).current).toBe('gratis');
    expect((await post('/console/customers/org_a/plan', { product: 'vault', plan: 'gold', reason: 'x' }, { who: OWNER })).status).toBe(400);
  });
});
