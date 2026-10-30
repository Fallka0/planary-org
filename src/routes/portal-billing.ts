// /portal/orgs/:id/billing, checkout, pay-by, invoices/:iid/pay, cancel and /billing-portal
// (owners only), and /portal/checkout for a person without an organisation. Stripe over REST;
// without STRIPE_SECRET_KEY the paying routes answer 503 billing_not_configured.
// The plan itself changes from webhooks (routes/webhooks.ts), except Plus on invoice, which
// starts right away.

import type { Context, Hono } from 'hono';
import type { BillingPeriod, CheckoutResult, MemberRole, PayBy } from '../contract';
import type { AppEnv, Env, PersonCtx } from '../env';
import { auditStmt } from '../lib/audit';
import { billingOf, checkoutOut, keepOf, safeReturnTo, subscribed, type CheckoutRow } from '../lib/billing';
import { contactOf, getOrg, validSlug, type OrgRow, type PaymentMethodRow } from '../lib/orgs';
import { requireStripe, stripe } from '../lib/stripe';
import { ApiError, bad, clean, conflict, email, notFound, randomId, readJson, requireOneOf, requireText } from '../lib/util';
import { PASS, PLANS, VAULT_PLANS, vaultPrice } from '../plans';
import { isUpgrade, vaultActive, vaultPriceId, vaultSubOf, type PaidVaultPlan, type VaultSubRow } from '../lib/vault';
import { ownerOf, portalActor } from './portal-access';

type C = Context<AppEnv>;

/** The organisation's Stripe customer, created on first use. */
export async function ensureCustomer(env: Env, org: Pick<OrgRow, 'id' | 'name' | 'customer_id'>, person: PersonCtx): Promise<string> {
  if (org.customer_id) return org.customer_id;
  const contact = await contactOf(env, org.id);
  const customer = await stripe<{ id: string }>(
    env,
    'POST',
    '/customers',
    {
      name: org.name,
      email: contact?.email || person.email,
      preferred_locales: ['de-CH'],
      metadata: { org: org.id },
    },
    `customer-${org.id}`,
  );
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscriptions (org_id, plan, state, provider, customer_id, updated_at) VALUES (?, 'gratis', 'none', 'stripe', ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET provider = 'stripe', customer_id = excluded.customer_id, updated_at = excluded.updated_at`,
  )
    .bind(org.id, customer.id, now)
    .run();
  return customer.id;
}

const portal = (env: Env) => env.PORTAL_URL.replace(/\/+$/, '');
export const doneUrl = (env: Env, checkoutId: string) => `${portal(env)}/kasse/fertig?id=${encodeURIComponent(checkoutId)}`;
const backUrl = (env: Env, orgId: string, body: ParsedCheckout) =>
  body.kind === 'plan'
    ? `${portal(env)}/kasse?plan=plus&org=${encodeURIComponent(orgId)}`
    : body.kind === 'vault'
      ? (body.returnTo ?? `${portal(env)}/abrechnung?org=${encodeURIComponent(orgId)}`)
      : `${portal(env)}/kasse?pass=tournament&tournament=${encodeURIComponent(body.tournamentId)}&org=${encodeURIComponent(orgId)}`;

type ParsedCheckout =
  | { kind: 'plan'; payBy: PayBy; returnTo: string | null }
  | { kind: 'pass'; tournamentId: string; returnTo: string | null }
  | { kind: 'vault'; plan: PaidVaultPlan; period: BillingPeriod; payBy: PayBy; returnTo: string | null };

/** Checks the body against CheckoutBody: a plan (Plus, card or invoice) or a pass (card). */
export function parseCheckout(body: Record<string, unknown>): ParsedCheckout {
  const returnTo = safeReturnTo(body.returnTo);
  if (body.product !== undefined) {
    requireOneOf(body.product, ['vault'] as const, 'product');
    if (body.pass !== undefined) throw bad('Send either a product plan or a pass.', 'invalid_checkout');
    const plan = requireOneOf(body.plan, ['plus', 'pro'] as const, 'plan');
    const period = requireOneOf(body.period, ['month', 'year'] as const, 'period');
    const payBy = requireOneOf(body.payBy, ['card', 'invoice'] as const, 'payBy');
    if (payBy === 'invoice' && period === 'month') throw bad('Monthly plans are paid by card; pay yearly to get an invoice.', 'invalid_payBy');
    return { kind: 'vault', plan, period, payBy, returnTo };
  }
  if (body.plan !== undefined && body.pass !== undefined) throw bad('Send either plan or pass.', 'invalid_checkout');
  if (body.plan !== undefined) {
    requireOneOf(body.plan, ['plus'] as const, 'plan');
    return { kind: 'plan', payBy: requireOneOf(body.payBy, ['card', 'invoice'] as const, 'payBy'), returnTo };
  }
  if (body.pass !== undefined) {
    requireOneOf(body.pass, ['tournament'] as const, 'pass');
    if (body.payBy !== undefined && body.payBy !== 'card') throw bad('The pass is paid by card.', 'invalid_payBy');
    const tournamentId = clean(body.tournamentId, 101);
    if (!tournamentId || tournamentId.length > 100) throw bad('Pick the tournament for the pass.', 'invalid_tournamentId');
    return { kind: 'pass', tournamentId, returnTo };
  }
  throw bad('Send plan or pass.', 'invalid_checkout');
}

/** Starts a checkout for an organisation the caller owns. */
export async function startCheckout(env: Env, org: OrgRow, person: PersonCtx, body: ParsedCheckout): Promise<CheckoutResult> {
  requireStripe(env);
  const now = Date.now();
  const DB = env.DB;
  const id = randomId('co');
  const contact = await contactOf(env, org.id);
  const receipt = contact?.email || person.email;

  if (body.kind === 'vault') return startVaultCheckout(env, org, person, body, id, receipt, now);

  if (body.kind === 'plan') {
    if (!env.STRIPE_PRICE_PLUS) throw new ApiError(503, 'Billing is not set up yet.', 'billing_not_configured');
    if (subscribed(org)) throw conflict('This organisation already has Plus.', 'already_subscribed');
    const customer = await ensureCustomer(env, org, person);
    const row = (state: 'pending' | 'paid', session: string | null) =>
      DB.prepare(
        `INSERT INTO checkouts (id, org_id, kind, pay_by, state, amount, session_id, receipt_email, return_to, created_by, created_at, updated_at)
         VALUES (?, ?, 'plan', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, org.id, body.payBy, state, PLANS.plus.price, session, receipt, body.returnTo, person.id, now, now);

    if (body.payBy === 'invoice') {
      // No card: the subscription bills by invoice (QR-bill), payable within 30 days. Plus starts now.
      const sub = await stripe<{ id: string; status: string; current_period_end?: number; items?: { data?: { current_period_end?: number }[] } }>(
        env,
        'POST',
        '/subscriptions',
        {
          customer,
          items: [{ price: env.STRIPE_PRICE_PLUS, quantity: 1 }],
          collection_method: 'send_invoice',
          days_until_due: 30,
          metadata: { org: org.id, plan: 'plus', checkout: id },
        },
        `subscription-invoice-${org.id}-${Math.floor(now / 3_600_000)}`,
      );
      const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
      await DB.batch([
        row('paid', null),
        DB.prepare(
          `UPDATE subscriptions SET plan = 'plus', state = ?, subscription_id = ?, collection_method = 'send_invoice', pay_by = 'invoice',
             current_period_end = COALESCE(?, current_period_end), cancel_at = NULL, cancel_keep = NULL, updated_at = ? WHERE org_id = ?`,
        ).bind(sub.status || 'active', sub.id, periodEnd ? periodEnd * 1000 : null, now, org.id),
        auditStmt(env, { area: 'portal', actor: portalActor(person), action: 'billing.subscribe', sentence: 'Switched to Plus', target: org.name, details: 'Plus, by invoice' }),
      ]);
      return { url: doneUrl(env, id), checkoutId: id };
    }

    const session = await stripe<{ id: string; url: string }>(env, 'POST', '/checkout/sessions', {
      mode: 'subscription',
      customer,
      payment_method_types: ['card'],
      line_items: [{ price: env.STRIPE_PRICE_PLUS, quantity: 1 }],
      metadata: { org: org.id, kind: 'plan', plan: 'plus', checkout: id },
      subscription_data: { metadata: { org: org.id, plan: 'plus', checkout: id } },
      locale: 'de',
      success_url: doneUrl(env, id),
      cancel_url: backUrl(env, org.id, body),
    });
    await DB.batch([
      row('pending', session.id),
      auditStmt(env, { area: 'portal', actor: portalActor(person), action: 'billing.checkout', sentence: 'Started a checkout', target: org.name, details: 'Plus, by card' }),
    ]);
    return { url: session.url, checkoutId: id };
  }

  if (!env.STRIPE_PRICE_PASS) throw new ApiError(503, 'Billing is not set up yet.', 'billing_not_configured');
  // The tournament belongs to the organisation, or it is the buyer's own solo tournament.
  const t = await DB.prepare('SELECT id, name, state, organisation_id, owner_id FROM tournaments WHERE id = ?')
    .bind(body.tournamentId)
    .first<{ id: string; name: string; state: string; organisation_id: string | null; owner_id: string }>();
  if (!t || (t.organisation_id !== org.id && !(t.organisation_id === null && t.owner_id === person.id))) throw notFound('No tournament with that id in this organisation.');
  if (t.state === 'done') throw conflict('This tournament is finished.', 'tournament_done');
  if (await DB.prepare('SELECT 1 FROM passes WHERE tournament_id = ?').bind(t.id).first()) throw conflict('This tournament already has a pass.', 'already_paid');
  const customer = await ensureCustomer(env, org, person);
  const session = await stripe<{ id: string; url: string }>(env, 'POST', '/checkout/sessions', {
    mode: 'payment',
    customer,
    currency: 'chf',
    payment_method_types: ['card'],
    line_items: [{ price: env.STRIPE_PRICE_PASS, quantity: 1 }],
    metadata: { org: org.id, kind: 'pass', tournament: t.id, checkout: id },
    payment_intent_data: { metadata: { org: org.id, tournament: t.id, checkout: id } },
    invoice_creation: { enabled: true, invoice_data: { description: `${PASS.name}, ${t.name}`, metadata: { org: org.id, tournament: t.id } } },
    locale: 'de',
    success_url: doneUrl(env, id),
    cancel_url: backUrl(env, org.id, body),
  });
  await DB.batch([
    DB.prepare(
      `INSERT INTO checkouts (id, org_id, kind, pay_by, tournament_id, tournament_name, state, amount, session_id, receipt_email, return_to, created_by, created_at, updated_at)
       VALUES (?, ?, 'pass', 'card', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, org.id, t.id, t.name, PASS.price, session.id, receipt, body.returnTo, person.id, now, now),
    auditStmt(env, { area: 'portal', actor: portalActor(person), action: 'billing.checkout', sentence: 'Started a checkout', target: org.name, details: `${PASS.name}, ${t.name}` }),
  ]);
  return { url: session.url, checkoutId: id };
}

/** Vault Plus or Pro for an account: Stripe Checkout by card, or a subscription billed by invoice (yearly). */
async function startVaultCheckout(
  env: Env,
  org: OrgRow,
  person: PersonCtx,
  body: Extract<ParsedCheckout, { kind: 'vault' }>,
  id: string,
  receipt: string,
  now: number,
): Promise<CheckoutResult> {
  const DB = env.DB;
  const price = vaultPriceId(env, body.plan, body.period);
  if (!price) throw new ApiError(503, 'Billing is not set up yet.', 'billing_not_configured');
  if (vaultActive(await vaultSubOf(env, org.id))) throw conflict('This account already pays for Vault. Change the plan instead.', 'already_subscribed');
  const customer = await ensureCustomer(env, org, person);
  const name = VAULT_PLANS[body.plan].name;
  const what = `${name}, ${body.period === 'year' ? 'yearly' : 'monthly'}, by ${body.payBy}`;
  const metadata = { org: org.id, product: 'vault', plan: body.plan, period: body.period, checkout: id };
  const row = (state: 'pending' | 'paid', session: string | null) =>
    DB.prepare(
      `INSERT INTO checkouts (id, org_id, kind, pay_by, product, product_plan, period, state, amount, session_id, receipt_email, return_to, created_by, created_at, updated_at)
       VALUES (?, ?, 'plan', ?, 'vault', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, org.id, body.payBy, body.plan, body.period, state, vaultPrice(body.plan, body.period), session, receipt, body.returnTo, person.id, now, now);

  if (body.payBy === 'invoice') {
    // Yearly on invoice: the subscription starts now and its first invoice is due in 30 days.
    const sub = await stripe<{ id: string; status: string; current_period_end?: number; items?: { data?: { current_period_end?: number }[] } }>(
      env,
      'POST',
      '/subscriptions',
      { customer, items: [{ price, quantity: 1 }], collection_method: 'send_invoice', days_until_due: 30, metadata },
      `vault-invoice-${org.id}-${Math.floor(now / 3_600_000)}`,
    );
    const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
    await DB.batch([
      row('paid', null),
      DB.prepare(
        `INSERT INTO product_subscriptions (org_id, product, plan, period, state, subscription_id, pay_by, current_period_end, updated_at)
         VALUES (?, 'vault', ?, ?, ?, ?, 'invoice', ?, ?)
         ON CONFLICT (org_id, product) DO UPDATE SET plan = excluded.plan, period = excluded.period, state = excluded.state, subscription_id = excluded.subscription_id,
           pay_by = 'invoice', current_period_end = excluded.current_period_end, cancel_at = NULL, pending_plan = NULL, pending_period = NULL, schedule_id = NULL,
           updated_at = excluded.updated_at`,
      ).bind(org.id, body.plan, body.period, sub.status || 'active', sub.id, periodEnd ? periodEnd * 1000 : null, now),
      auditStmt(env, { area: 'portal', actor: portalActor(person), action: 'billing.subscribe', sentence: `Switched to ${name}`, target: org.name, details: what }),
    ]);
    return { url: doneUrl(env, id), checkoutId: id };
  }

  const session = await stripe<{ id: string; url: string }>(env, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    customer,
    payment_method_types: ['card'],
    line_items: [{ price, quantity: 1 }],
    metadata: { ...metadata, kind: 'plan' },
    subscription_data: { metadata },
    locale: 'de',
    success_url: doneUrl(env, id),
    cancel_url: backUrl(env, org.id, body),
  });
  await DB.batch([
    row('pending', session.id),
    auditStmt(env, { area: 'portal', actor: portalActor(person), action: 'billing.checkout', sentence: 'Started a checkout', target: org.name, details: what }),
  ]);
  return { url: session.url, checkoutId: id };
}

/** The person's personal billing account, created on first use (Vault bought without an organisation). */
async function personalAccount(env: Env, person: PersonCtx, now: number): Promise<string> {
  const found = await env.DB.prepare(
    "SELECT o.id FROM organisations o JOIN members m ON m.org_id = o.id WHERE o.kind = 'personal' AND m.user_id = ? AND m.role = 'owner' AND o.delete_at IS NULL",
  )
    .bind(person.id)
    .first<{ id: string }>();
  if (found) return found.id;
  const id = randomId('org');
  const name = person.name || person.email;
  const DB = env.DB;
  await DB.batch([
    DB.prepare("INSERT INTO organisations (id, name, slug, services, kind, created_by, created_at) VALUES (?, ?, ?, '[]', 'personal', ?, ?)").bind(
      id,
      name,
      await freeSlug(env, name),
      person.id,
      now,
    ),
    DB.prepare("INSERT INTO members (org_id, user_id, name, email, role, last_active, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)").bind(id, person.id, person.name, person.email, now, now),
    DB.prepare("INSERT INTO subscriptions (org_id, plan, state, updated_at) VALUES (?, 'gratis', 'none', ?)").bind(id, now),
    DB.prepare("INSERT INTO billing_contacts (org_id, email, phone, address, updated_at) VALUES (?, ?, '', '[]', ?)").bind(id, person.email, now),
    auditStmt(env, { area: 'portal', actor: portalActor(person), action: 'org.create', sentence: 'Created a personal billing account', target: name, details: 'at checkout' }),
  ]);
  return id;
}

/** "Spielclub Thun" → "spielclub-thun", unique among organisations. */
async function freeSlug(env: Env, name: string) {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'organisation';
  const padded = base.length < 3 ? `${base}-org` : base;
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? padded : `${padded}-${i}`;
    if (validSlug(slug) && !(await env.DB.prepare('SELECT 1 FROM organisations WHERE slug = ?').bind(slug).first())) return slug;
  }
  return `${padded.slice(0, 30)}-${randomId('', 6).slice(-6).toLowerCase()}`;
}

export function registerPortalBilling(app: Hono<AppEnv>) {
  app.get('/orgs/:id/billing', async (c) => {
    const { org } = await ownerOf(c);
    return c.json(await billingOf(c.env, org, Date.now()));
  });

  app.post('/orgs/:id/checkout', async (c) => {
    const { org, person } = await ownerOf(c);
    return c.json(await startCheckout(c.env, org, person, parseCheckout(await readJson(c))));
  });

  /** A person without an organisation: it is created first (they own it), then the checkout starts. */
  app.post('/checkout', async (c) => {
    const person = c.get('person');
    const body = await readJson(c);
    const parsed = parseCheckout(body);
    requireStripe(c.env);
    const o = body.org && typeof body.org === 'object' ? (body.org as Record<string, unknown>) : null;
    if (parsed.kind === 'vault' && !o) {
      // Vault is per person: without an organisation named, it goes on their personal account.
      const orgId = await personalAccount(c.env, person, Date.now());
      const org = await getOrg(c.env, orgId);
      if (!org) throw new ApiError(500, 'The account could not be created.', 'org_create_failed');
      return c.json({ ...(await startCheckout(c.env, org, person, parsed)), orgId });
    }
    if (!o) throw bad('Name the organisation and its billing e-mail.', 'invalid_org');
    const name = requireText(o.name, 'name', 80, { min: 2 });
    const mail = email(o.email);
    if (!mail) throw bad('Enter a valid e-mail address.', 'invalid_email');
    const owned = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND role = 'owner'").bind(person.id).first<{ n: number }>();
    if ((owned?.n ?? 0) >= 20) throw new ApiError(429, 'You already own 20 organisations.', 'too_many_orgs');
    if (parsed.kind === 'pass') {
      // Check before creating anything: only the buyer's own solo tournament can get a pass here.
      const t = await c.env.DB.prepare('SELECT organisation_id, owner_id, state FROM tournaments WHERE id = ?')
        .bind(parsed.tournamentId)
        .first<{ organisation_id: string | null; owner_id: string; state: string }>();
      if (!t || t.owner_id !== person.id || t.organisation_id !== null) throw notFound('No tournament with that id of yours.');
      if (t.state === 'done') throw conflict('This tournament is finished.', 'tournament_done');
    }
    const id = randomId('org');
    const now = Date.now();
    const DB = c.env.DB;
    const slug = await freeSlug(c.env, name);
    await DB.batch([
      DB.prepare("INSERT INTO organisations (id, name, slug, services, created_by, created_at) VALUES (?, ?, ?, '[\"tournament\"]', ?, ?)").bind(id, name, slug, person.id, now),
      DB.prepare("INSERT INTO members (org_id, user_id, name, email, role, last_active, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)").bind(id, person.id, person.name, person.email, now, now),
      DB.prepare("INSERT INTO subscriptions (org_id, plan, state, updated_at) VALUES (?, 'gratis', 'none', ?)").bind(id, now),
      DB.prepare("INSERT INTO billing_contacts (org_id, email, phone, address, updated_at) VALUES (?, ?, '', '[]', ?)").bind(id, mail, now),
      auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'org.create', sentence: 'Created an organisation', target: name, details: `${slug}, at checkout` }),
    ]);
    const org = await getOrg(c.env, id, now);
    if (!org) throw new ApiError(500, 'The organisation could not be created.', 'org_create_failed');
    const result = await startCheckout(c.env, org, person, parsed);
    return c.json({ ...result, orgId: id });
  });

  /** The done page polls this. Members of the organisation (or whoever started it) may read it. */
  app.get('/checkout/:cid', async (c) => {
    const person = c.get('person');
    const DB = c.env.DB;
    const row = await DB.prepare('SELECT * FROM checkouts WHERE id = ?').bind(c.req.param('cid')).first<CheckoutRow>();
    if (!row) throw notFound('No checkout with that id.');
    const member = await DB.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ?').bind(row.org_id, person.id).first<{ role: MemberRole }>();
    if (!member && row.created_by !== person.id) throw notFound('No checkout with that id.');
    return c.json(checkoutOut(row));
  });

  app.post('/orgs/:id/pay-by', async (c) => {
    const { org, person } = await ownerOf(c);
    const payBy = requireOneOf((await readJson(c)).payBy, ['card', 'invoice'] as const, 'payBy');
    if (!subscribed(org) || !org.subscription_id) throw conflict('Only a Plus subscription has a way to pay.', 'no_subscription');
    requireStripe(c.env);
    if (payBy === 'card') {
      const pm = await c.env.DB.prepare('SELECT * FROM payment_methods WHERE org_id = ?').bind(org.id).first<PaymentMethodRow>();
      if (!pm || pm.kind !== 'card') throw conflict('Add a card first.', 'no_card');
    }
    await stripe(
      c.env,
      'POST',
      `/subscriptions/${encodeURIComponent(org.subscription_id)}`,
      payBy === 'invoice' ? { collection_method: 'send_invoice', days_until_due: 30 } : { collection_method: 'charge_automatically' },
    );
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE subscriptions SET pay_by = ?, collection_method = ?, updated_at = ? WHERE org_id = ?').bind(
        payBy,
        payBy === 'invoice' ? 'send_invoice' : 'charge_automatically',
        now,
        org.id,
      ),
      auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'billing.pay_by', sentence: 'Changed how Plus is paid', target: org.name, details: payBy }),
    ]);
    return c.json({ ok: true });
  });

  app.post('/orgs/:id/invoices/:iid/pay', async (c) => {
    const { org } = await ownerOf(c);
    const inv = await c.env.DB.prepare('SELECT id, status, pay_url FROM invoices WHERE id = ? AND org_id = ?')
      .bind(c.req.param('iid'), org.id)
      .first<{ id: string; status: string; pay_url: string | null }>();
    if (!inv) throw notFound('No invoice with that id.');
    if (inv.status !== 'open') throw conflict('This invoice is not open.', 'invoice_not_open');
    let url = inv.pay_url;
    if (!url) {
      requireStripe(c.env);
      url = (await stripe<{ hosted_invoice_url: string | null }>(c.env, 'GET', `/invoices/${encodeURIComponent(inv.id)}`)).hosted_invoice_url;
    }
    if (!url) throw new ApiError(502, "The invoice isn't ready yet. It arrives by e-mail.", 'invoice_pending');
    return c.json({ url });
  });

  app.post('/orgs/:id/cancel', async (c) => cancel(c, true));
  app.post('/orgs/:id/cancel/undo', async (c) => cancel(c, false));

  app.post('/orgs/:id/vault/change', async (c) => {
    const { org, person } = await ownerOf(c);
    const b = await readJson(c);
    const to = { plan: requireOneOf(b.plan, ['plus', 'pro'] as const, 'plan'), period: requireOneOf(b.period, ['month', 'year'] as const, 'period') };
    const sub = await vaultSubOf(c.env, org.id);
    if (!vaultActive(sub) || !sub.subscription_id) throw conflict('There is no Vault subscription to change.', 'no_subscription');
    if (to.period === 'month' && sub.pay_by === 'invoice') throw bad('Monthly plans are paid by card.', 'invalid_period');
    requireStripe(c.env);
    const price = vaultPriceId(c.env, to.plan, to.period);
    if (!price) throw new ApiError(503, 'Billing is not set up yet.', 'billing_not_configured');
    const subPath = `/subscriptions/${encodeURIComponent(sub.subscription_id)}`;
    const DB = c.env.DB;
    const now = Date.now();
    const name = `${VAULT_PLANS[to.plan].name}, ${to.period === 'year' ? 'yearly' : 'monthly'}`;

    // Any earlier pending change or cancellation is replaced by this one.
    await releaseSchedule(c.env, sub);
    if (sub.cancel_at) await stripe(c.env, 'POST', subPath, { cancel_at_period_end: false });
    const clear = DB.prepare(
      "UPDATE product_subscriptions SET cancel_at = NULL, pending_plan = NULL, pending_period = NULL, schedule_id = NULL, updated_at = ? WHERE org_id = ? AND product = 'vault'",
    ).bind(now, org.id);

    if (to.plan === sub.plan && to.period === sub.period) {
      await DB.batch([clear, auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'billing.vault_keep', sentence: `Stayed on ${name}`, target: org.name })]);
      return c.json({ ok: true, at: null });
    }

    if (isUpgrade(sub, to)) {
      // Right away; Stripe invoices the difference for the rest of the period.
      const current = await stripe<{ items?: { data?: { id: string }[] } }>(c.env, 'GET', subPath);
      const item = current.items?.data?.[0]?.id;
      if (!item) throw new ApiError(502, "The payment provider didn't return the subscription.", 'billing_error');
      await stripe(c.env, 'POST', subPath, {
        items: [{ id: item, price }],
        proration_behavior: 'always_invoice',
        metadata: { org: org.id, product: 'vault', plan: to.plan, period: to.period },
      });
      await DB.batch([
        clear,
        DB.prepare("UPDATE product_subscriptions SET plan = ?, period = ? WHERE org_id = ? AND product = 'vault'").bind(to.plan, to.period, org.id),
        auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'billing.vault_upgrade', sentence: `Switched to ${name}`, target: org.name }),
      ]);
      return c.json({ ok: true, at: null });
    }

    // A downgrade waits for the end of the paid period: a schedule with the current phase, then the new price.
    const schedule = await stripe<{ id: string; phases?: { start_date: number; end_date: number; items?: { price: string | { id: string } }[] }[] }>(
      c.env,
      'POST',
      '/subscription_schedules',
      { from_subscription: sub.subscription_id },
    );
    const phase = schedule.phases?.[0];
    const currentPrice = phase?.items?.[0]?.price;
    if (!phase || !currentPrice) throw new ApiError(502, "The payment provider didn't return the billing period.", 'billing_error');
    await stripe(c.env, 'POST', `/subscription_schedules/${encodeURIComponent(schedule.id)}`, {
      end_behavior: 'release',
      phases: [
        { items: [{ price: typeof currentPrice === 'string' ? currentPrice : currentPrice.id, quantity: 1 }], start_date: phase.start_date, end_date: phase.end_date },
        { items: [{ price, quantity: 1 }], iterations: 1, metadata: { org: org.id, product: 'vault', plan: to.plan, period: to.period } },
      ],
    });
    const at = phase.end_date * 1000;
    await DB.batch([
      clear,
      DB.prepare("UPDATE product_subscriptions SET pending_plan = ?, pending_period = ?, schedule_id = ? WHERE org_id = ? AND product = 'vault'").bind(
        to.plan,
        to.period,
        schedule.id,
        org.id,
      ),
      auditStmt(c.env, {
        area: 'portal',
        actor: portalActor(person),
        action: 'billing.vault_downgrade',
        sentence: `Switches to ${name} at the end of the period`,
        target: org.name,
        details: `on ${new Date(at).toISOString().slice(0, 10)}`,
      }),
    ]);
    return c.json({ ok: true, at });
  });

  app.post('/orgs/:id/vault/cancel', async (c) => {
    const { org, person } = await ownerOf(c);
    const sub = await vaultSubOf(c.env, org.id);
    if (!vaultActive(sub) || !sub.subscription_id) throw conflict('There is no Vault subscription to cancel.', 'no_subscription');
    requireStripe(c.env);
    await releaseSchedule(c.env, sub);
    const res = await stripe<{ current_period_end?: number; cancel_at?: number | null; items?: { data?: { current_period_end?: number }[] } }>(
      c.env,
      'POST',
      `/subscriptions/${encodeURIComponent(sub.subscription_id)}`,
      { cancel_at_period_end: true },
    );
    const end = (res.cancel_at ?? res.current_period_end ?? res.items?.data?.[0]?.current_period_end ?? 0) * 1000 || sub.current_period_end;
    if (!end) throw new ApiError(502, "The payment provider didn't say when the period ends.", 'billing_error');
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE product_subscriptions SET cancel_at = ?, pending_plan = NULL, pending_period = NULL, schedule_id = NULL, updated_at = ? WHERE org_id = ? AND product = 'vault'",
      ).bind(end, now, org.id),
      auditStmt(c.env, {
        area: 'portal',
        actor: portalActor(person),
        action: 'billing.vault_cancel',
        sentence: 'Switches to Vault Free at the end of the period',
        target: org.name,
        details: `on ${new Date(end).toISOString().slice(0, 10)}`,
      }),
    ]);
    return c.json({ cancelAt: end });
  });

  app.post('/orgs/:id/vault/cancel/undo', async (c) => {
    const { org, person } = await ownerOf(c);
    const sub = await vaultSubOf(c.env, org.id);
    if (!vaultActive(sub) || !sub.subscription_id) throw conflict('There is no Vault subscription.', 'no_subscription');
    if (!sub.cancel_at) return c.json({ ok: true });
    requireStripe(c.env);
    await stripe(c.env, 'POST', `/subscriptions/${encodeURIComponent(sub.subscription_id)}`, { cancel_at_period_end: false });
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE product_subscriptions SET cancel_at = NULL, updated_at = ? WHERE org_id = ? AND product = 'vault'").bind(Date.now(), org.id),
      auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'billing.vault_cancel_undo', sentence: `Stayed on ${VAULT_PLANS[sub.plan].name}`, target: org.name }),
    ]);
    return c.json({ ok: true });
  });

  app.post('/orgs/:id/billing-portal', async (c) => {
    const { org, person } = await ownerOf(c);
    requireStripe(c.env);
    const customer = await ensureCustomer(c.env, org, person);
    const session = await stripe<{ url: string }>(c.env, 'POST', '/billing_portal/sessions', { customer, return_url: `${portal(c.env)}/abrechnung`, locale: 'de' });
    return c.json({ url: session.url });
  });
}

/** Switch to Gratis at the end of the paid year (`on`), or stay on Plus (`!on`). */
async function cancel(c: C, on: boolean) {
  const { org, person } = await ownerOf(c);
  if (!subscribed(org) || !org.subscription_id) throw conflict('Only a Plus subscription can be cancelled here.', 'no_subscription');
  const DB = c.env.DB;
  const now = Date.now();
  if (!on) {
    if (!org.cancel_at) return c.json({ ok: true });
    requireStripe(c.env);
    await stripe(c.env, 'POST', `/subscriptions/${encodeURIComponent(org.subscription_id)}`, { cancel_at_period_end: false });
    await DB.batch([
      DB.prepare('UPDATE subscriptions SET cancel_at = NULL, cancel_keep = NULL, updated_at = ? WHERE org_id = ?').bind(now, org.id),
      auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'billing.cancel_undo', sentence: 'Stayed on Plus', target: org.name }),
    ]);
    return c.json({ ok: true });
  }
  const body = await readJson(c);
  if (!Array.isArray(body.keep) || body.keep.some((k) => typeof k !== 'string')) throw bad('keep is a list of member ids.', 'invalid_keep');
  const { results: members } = await DB.prepare('SELECT user_id, role FROM members WHERE org_id = ?').bind(org.id).all<{ user_id: string; role: MemberRole }>();
  const seats = PLANS.gratis.limits.maxOrganisers;
  let keep = [...new Set(body.keep as string[])];
  if (members.length <= seats) keep = members.map((m) => m.user_id);
  else {
    if (keep.length < 1 || keep.length > seats) throw bad(`Pick 1 to ${seats} people who keep organising.`, 'invalid_keep');
    if (keep.some((k) => !members.find((m) => m.user_id === k))) throw bad('Everyone you keep must be a member.', 'invalid_keep');
    if (!keep.some((k) => members.find((m) => m.user_id === k)?.role === 'owner')) throw bad('Keep at least one owner.', 'keep_owner');
  }
  requireStripe(c.env);
  const sub = await stripe<{ current_period_end?: number; cancel_at?: number | null; items?: { data?: { current_period_end?: number }[] } }>(
    c.env,
    'POST',
    `/subscriptions/${encodeURIComponent(org.subscription_id)}`,
    { cancel_at_period_end: true },
  );
  const end = (sub.cancel_at ?? sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? 0) * 1000 || org.current_period_end;
  if (!end) throw new ApiError(502, "The payment provider didn't say when the year ends.", 'billing_error');
  await DB.batch([
    DB.prepare('UPDATE subscriptions SET cancel_at = ?, cancel_keep = ?, updated_at = ? WHERE org_id = ?').bind(end, JSON.stringify(keep), now, org.id),
    auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'billing.cancel', sentence: 'Switched to Gratis at the end of the year', target: org.name, details: `on ${new Date(end).toISOString().slice(0, 10)}, keeps ${keep.length}` }),
  ]);
  return c.json({ cancelAt: end });
}

/**
 * After a switch to Gratis takes effect: the members who weren't kept leave the organisation.
 * Their Planary accounts stay. Idempotent; runs from the subscription.deleted webhook and daily.
 */
export function applySwitchStmts(env: Env, org: Pick<OrgRow, 'id' | 'cancel_keep'>, now: number): D1PreparedStatement[] {
  const keep = keepOf(org);
  const out: D1PreparedStatement[] = [];
  if (keep.length) {
    out.push(env.DB.prepare(`DELETE FROM members WHERE org_id = ? AND user_id NOT IN (${keep.map(() => '?').join(', ')})`).bind(org.id, ...keep));
  }
  out.push(env.DB.prepare('UPDATE subscriptions SET cancel_at = NULL, cancel_keep = NULL, updated_at = ? WHERE org_id = ?').bind(now, org.id));
  return out;
}


/** Drops a pending downgrade at the provider: the subscription goes on as it is. */
async function releaseSchedule(env: Env, sub: Pick<VaultSubRow, 'schedule_id'>) {
  if (!sub.schedule_id) return;
  await stripe(env, 'POST', `/subscription_schedules/${encodeURIComponent(sub.schedule_id)}/release`, {});
}
