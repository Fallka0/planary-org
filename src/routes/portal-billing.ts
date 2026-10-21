// /portal/orgs/:id/billing, /checkout and /billing-portal (owners only). Stripe over REST;
// without STRIPE_SECRET_KEY checkout and the billing portal answer 503 billing_not_configured.
// The plan itself only ever changes from webhooks (routes/webhooks.ts).

import type { Hono } from 'hono';
import type { AppEnv, Env, PersonCtx } from '../env';
import { auditStmt } from '../lib/audit';
import { contactOf, contactOut, invoiceOut, invoicesOf, paymentMethodOut, renewsAt, type OrgRow, type PaymentMethodRow } from '../lib/orgs';
import { requireStripe, stripe } from '../lib/stripe';
import { ApiError, bad, conflict, notFound, readJson, requireOneOf } from '../lib/util';
import { planList } from '../plans';
import { ownerOf, portalActor } from './portal-access';

/** The organisation's Stripe customer, created on first use. */
export async function ensureCustomer(env: Env, org: OrgRow, person: PersonCtx): Promise<string> {
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

const billingUrl = (env: Env, orgId: string) => `${env.PORTAL_URL}/${orgId}/abrechnung`;

export function registerPortalBilling(app: Hono<AppEnv>) {
  app.get('/orgs/:id/billing', async (c) => {
    const { org } = await ownerOf(c);
    const now = Date.now();
    const [invoices, pm, contact] = await Promise.all([
      invoicesOf(c.env, org.id),
      c.env.DB.prepare('SELECT * FROM payment_methods WHERE org_id = ?').bind(org.id).first<PaymentMethodRow>(),
      contactOf(c.env, org.id),
    ]);
    return c.json({
      plans: planList(),
      current: org.plan,
      invoices: invoices.filter((i) => i.status !== 'draft').map((i) => invoiceOut(i, now)),
      paymentMethod: paymentMethodOut(pm),
      contact: contactOut(contact),
      renewsAt: renewsAt(org),
    });
  });

  app.post('/orgs/:id/checkout', async (c) => {
    const { org, person } = await ownerOf(c);
    requireStripe(c.env);
    const body = await readJson(c);
    const plan = requireOneOf(body.plan, ['event', 'verein'] as const, 'plan');
    const payBy = body.payBy === undefined ? 'card' : requireOneOf(body.payBy, ['card', 'invoice'] as const, 'payBy');
    const success = `${billingUrl(c.env, org.id)}?checkout=success`;
    const cancel = `${billingUrl(c.env, org.id)}?checkout=cancel`;

    if (plan === 'event') {
      if (!c.env.STRIPE_PRICE_EVENT) throw new ApiError(503, 'Billing is not set up yet.', 'billing_not_configured');
      if (typeof body.tournamentId !== 'string' || !body.tournamentId) throw bad('Pick the tournament for the event pass.', 'invalid_tournamentId');
      const t = await c.env.DB.prepare('SELECT id, name, state FROM tournaments WHERE id = ? AND organisation_id = ?')
        .bind(body.tournamentId, org.id)
        .first<{ id: string; name: string; state: string }>();
      if (!t) throw notFound('No tournament with that id in this organisation.');
      if (t.state === 'done') throw conflict('This tournament is finished.', 'tournament_done');
      if (await c.env.DB.prepare('SELECT 1 FROM event_passes WHERE tournament_id = ?').bind(t.id).first()) throw conflict('This tournament already has an event pass.', 'already_paid');
      const customer = await ensureCustomer(c.env, org, person);
      const session = await stripe<{ url: string }>(c.env, 'POST', '/checkout/sessions', {
        mode: 'payment',
        customer,
        currency: 'chf',
        payment_method_types: ['card', 'twint'],
        line_items: [{ price: c.env.STRIPE_PRICE_EVENT, quantity: 1 }],
        metadata: { org: org.id, tournament: t.id, plan: 'event' },
        payment_intent_data: { metadata: { org: org.id, tournament: t.id } },
        invoice_creation: { enabled: true, invoice_data: { description: `Plan Event, ${t.name}`, metadata: { org: org.id, tournament: t.id } } },
        locale: 'de',
        success_url: success,
        cancel_url: cancel,
      });
      await c.env.DB.batch([
        auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'billing.checkout', sentence: 'Started a checkout', target: org.name, details: `Event, ${t.name}` }),
      ]);
      return c.json({ url: session.url });
    }

    if (!c.env.STRIPE_PRICE_VEREIN) throw new ApiError(503, 'Billing is not set up yet.', 'billing_not_configured');
    if (org.sub_plan === 'verein' && org.sub_state && ['active', 'past_due', 'trialing'].includes(org.sub_state)) {
      throw conflict('This organisation already has the Verein plan.', 'already_subscribed');
    }
    const customer = await ensureCustomer(c.env, org, person);

    if (payBy === 'invoice') {
      // No Checkout: the subscription bills by invoice, payable within 30 days.
      const sub = await stripe<{ id: string; latest_invoice: { id: string; status: string; hosted_invoice_url: string | null } | null }>(
        c.env,
        'POST',
        '/subscriptions',
        {
          customer,
          items: [{ price: c.env.STRIPE_PRICE_VEREIN, quantity: 1 }],
          collection_method: 'send_invoice',
          days_until_due: 30,
          metadata: { org: org.id, plan: 'verein' },
          expand: ['latest_invoice'],
        },
        `subscription-invoice-${org.id}-${Math.floor(Date.now() / 3_600_000)}`,
      );
      let url = sub.latest_invoice?.hosted_invoice_url ?? null;
      if (!url && sub.latest_invoice?.id && sub.latest_invoice.status === 'draft') {
        const inv = await stripe<{ hosted_invoice_url: string | null }>(c.env, 'POST', `/invoices/${encodeURIComponent(sub.latest_invoice.id)}/finalize`, {});
        url = inv.hosted_invoice_url;
      }
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE subscriptions SET subscription_id = ?, collection_method = 'send_invoice', updated_at = ? WHERE org_id = ?").bind(sub.id, Date.now(), org.id),
        auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'billing.subscribe', sentence: 'Subscribed to a plan', target: org.name, details: 'Verein, by invoice' }),
      ]);
      if (!url) throw new ApiError(502, "The invoice isn't ready yet. It arrives by e-mail.", 'invoice_pending');
      return c.json({ url });
    }

    const session = await stripe<{ url: string }>(c.env, 'POST', '/checkout/sessions', {
      mode: 'subscription',
      customer,
      payment_method_types: ['card'],
      line_items: [{ price: c.env.STRIPE_PRICE_VEREIN, quantity: 1 }],
      metadata: { org: org.id, plan: 'verein' },
      subscription_data: { metadata: { org: org.id, plan: 'verein' } },
      locale: 'de',
      success_url: success,
      cancel_url: cancel,
    });
    await c.env.DB.batch([
      auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'billing.checkout', sentence: 'Started a checkout', target: org.name, details: 'Verein, by card' }),
    ]);
    return c.json({ url: session.url });
  });

  app.post('/orgs/:id/billing-portal', async (c) => {
    const { org, person } = await ownerOf(c);
    requireStripe(c.env);
    const customer = await ensureCustomer(c.env, org, person);
    const session = await stripe<{ url: string }>(c.env, 'POST', '/billing_portal/sessions', { customer, return_url: billingUrl(c.env, org.id), locale: 'de' });
    return c.json({ url: session.url });
  });
}
