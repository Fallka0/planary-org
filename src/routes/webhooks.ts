// /webhooks/stripe: the only source of billing state. Signature-checked, idempotent by event id:
// the event id is inserted in the same batch as its effects, so a replay changes nothing.

import { Hono } from 'hono';
import type { InvoiceStatus } from '../contract';
import type { AppEnv, Env } from '../env';
import { auditStmt } from '../lib/audit';
import { stripe, stripeConfigured, verifyStripeSignature } from '../lib/stripe';
import { errorBody, randomId } from '../lib/util';

export const webhooksApp = new Hono<AppEnv>();

type Obj = Record<string, any>;
interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: Obj };
}

const ms = (s: unknown) => (typeof s === 'number' && s > 0 ? s * 1000 : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
/** Expanded or not, Stripe ids come as a string or { id }. */
const idOf = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as Obj).id === 'string' ? ((v as Obj).id as string) : null);

webhooksApp.post('/stripe', async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json(errorBody(c, 'Billing is not set up yet.', 'billing_not_configured'), 503);
  const raw = await c.req.text();
  if (!(await verifyStripeSignature(secret, c.req.header('stripe-signature'), raw))) {
    return c.json(errorBody(c, 'Invalid signature.', 'invalid_signature'), 400);
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json(errorBody(c, 'Invalid payload.', 'bad_json'), 400);
  }
  if (!event?.id || !event.type || !event.data?.object) return c.json(errorBody(c, 'Invalid event.', 'invalid_event'), 400);

  if (await c.env.DB.prepare('SELECT 1 FROM provider_events WHERE id = ?').bind(event.id).first()) return c.json({ received: true, duplicate: true });

  const effects = await effectsOf(c.env, event);
  try {
    await c.env.DB.batch([c.env.DB.prepare('INSERT INTO provider_events (id, type, received_at) VALUES (?, ?, ?)').bind(event.id, event.type, Date.now()), ...effects]);
  } catch (error) {
    // A concurrent delivery of the same event won the insert: its effects are in, ours are rolled back.
    if (String(error).includes('UNIQUE') && String(error).includes('provider_events')) return c.json({ received: true, duplicate: true });
    throw error;
  }
  return c.json({ received: true });
});

/** The organisation an object belongs to: metadata.org, else the stored customer id. */
async function orgFor(env: Env, obj: Obj, customer: string | null): Promise<string | null> {
  const meta =
    str(obj.metadata?.org) ??
    str(obj.subscription_details?.metadata?.org) ??
    str(obj.parent?.subscription_details?.metadata?.org) ??
    str(obj.lines?.data?.[0]?.metadata?.org);
  if (meta) {
    const exists = await env.DB.prepare('SELECT id FROM organisations WHERE id = ?').bind(meta).first<{ id: string }>();
    if (exists) return exists.id;
  }
  if (!customer) return null;
  const row = await env.DB.prepare('SELECT org_id FROM subscriptions WHERE customer_id = ?').bind(customer).first<{ org_id: string }>();
  return row?.org_id ?? null;
}

const linkCustomer = (env: Env, orgId: string, customer: string, now: number) =>
  env.DB.prepare(
    `INSERT INTO subscriptions (org_id, plan, state, provider, customer_id, updated_at) VALUES (?, 'gratis', 'none', 'stripe', ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET provider = 'stripe', customer_id = excluded.customer_id, updated_at = excluded.updated_at`,
  ).bind(orgId, customer, now);

const ACTIVE = ['active', 'past_due', 'trialing'];
const orgName = (orgId: string) => ({ sql: 'SELECT name FROM organisations WHERE id = ?', bind: [orgId] });

async function effectsOf(env: Env, event: StripeEvent): Promise<D1PreparedStatement[]> {
  const obj = event.data.object;
  const now = Date.now();
  const DB = env.DB;
  const customer = idOf(obj.customer);
  const type = event.type;

  if (type === 'checkout.session.completed') {
    const orgId = await orgFor(env, obj, customer);
    if (!orgId) return [];
    const out: D1PreparedStatement[] = customer ? [linkCustomer(env, orgId, customer, now)] : [];
    const tournament = str(obj.metadata?.tournament);
    if (obj.mode === 'payment' && obj.metadata?.plan === 'event' && tournament && obj.payment_status === 'paid') {
      out.push(
        DB.prepare('INSERT OR IGNORE INTO event_passes (id, org_id, tournament_id, checkout_session_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
          randomId('pass'),
          orgId,
          tournament,
          str(obj.id),
          typeof obj.amount_total === 'number' ? obj.amount_total : 0,
          now,
        ),
        auditStmt(env, { area: 'system', actor: null, action: 'billing.event_pass', sentence: 'Recorded an event pass', targetSql: orgName(orgId), details: `tournament ${tournament}`, at: now }),
      );
    }
    const sub = idOf(obj.subscription);
    if (obj.mode === 'subscription' && sub) {
      out.push(DB.prepare('UPDATE subscriptions SET subscription_id = ?, updated_at = ? WHERE org_id = ?').bind(sub, now, orgId));
    }
    return out;
  }

  if (type.startsWith('customer.subscription.')) {
    const orgId = await orgFor(env, obj, customer);
    if (!orgId) return [];
    const status = type === 'customer.subscription.deleted' ? 'canceled' : (str(obj.status) ?? 'incomplete');
    const plan = ACTIVE.includes(status) ? 'verein' : 'gratis';
    const periodEnd = ms(obj.current_period_end) ?? ms(obj.items?.data?.[0]?.current_period_end);
    return [
      DB.prepare(
        `INSERT INTO subscriptions (org_id, plan, state, provider, customer_id, subscription_id, collection_method, current_period_end, updated_at)
         VALUES (?1, ?2, ?3, 'stripe', ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (org_id) DO UPDATE SET plan = excluded.plan, state = excluded.state, provider = 'stripe',
           customer_id = COALESCE(excluded.customer_id, subscriptions.customer_id), subscription_id = excluded.subscription_id,
           collection_method = excluded.collection_method, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`,
      ).bind(orgId, plan, status, customer, str(obj.id), str(obj.collection_method), periodEnd, now),
      auditStmt(env, { area: 'system', actor: null, action: 'billing.subscription', sentence: 'Subscription changed at Stripe', targetSql: orgName(orgId), details: `${status}, plan ${plan}`, at: now }),
    ];
  }

  if (type.startsWith('invoice.')) {
    if (!['invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.updated', 'invoice.payment_succeeded'].includes(type)) return [];
    const orgId = await orgFor(env, obj, customer);
    const invoiceId = str(obj.id);
    if (!orgId || !invoiceId) return [];
    const forced: Partial<Record<string, InvoiceStatus>> = { 'invoice.paid': 'paid', 'invoice.voided': 'void', 'invoice.marked_uncollectible': 'uncollectible' };
    const raw = forced[type] ?? str(obj.status);
    const status: InvoiceStatus = raw && ['draft', 'open', 'paid', 'void', 'uncollectible'].includes(raw) ? (raw as InvoiceStatus) : 'open';
    const description = str(obj.lines?.data?.[0]?.description) ?? str(obj.description) ?? '';
    const amount = typeof obj.total === 'number' ? obj.total : typeof obj.amount_due === 'number' ? obj.amount_due : 0;
    return [
      DB.prepare(
        `INSERT INTO invoices (id, org_id, number, created_at, due_at, amount, currency, status, description, pdf_url, pay_url, paid_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (id) DO UPDATE SET number = excluded.number, due_at = excluded.due_at, amount = excluded.amount, currency = excluded.currency,
           status = excluded.status, description = excluded.description, pdf_url = COALESCE(excluded.pdf_url, invoices.pdf_url),
           pay_url = COALESCE(excluded.pay_url, invoices.pay_url), paid_at = COALESCE(excluded.paid_at, invoices.paid_at), updated_at = excluded.updated_at`,
      ).bind(
        invoiceId,
        orgId,
        str(obj.number) ?? '',
        ms(obj.created) ?? now,
        ms(obj.due_date),
        amount,
        (str(obj.currency) ?? 'chf').toUpperCase(),
        status,
        description.slice(0, 300),
        str(obj.invoice_pdf),
        str(obj.hosted_invoice_url),
        status === 'paid' ? (ms(obj.status_transitions?.paid_at) ?? now) : null,
        now,
      ),
      ...(customer ? [linkCustomer(env, orgId, customer, now)] : []),
    ];
  }

  if (type === 'payment_method.attached') {
    const orgId = await orgFor(env, obj, customer);
    if (!orgId || obj.type !== 'card' || !obj.card) return [];
    return [cardStmt(env, orgId, str(obj.id), obj.card, now)];
  }

  if (type === 'customer.updated') {
    const orgId = await orgFor(env, obj, str(obj.id));
    const pmId = idOf(obj.invoice_settings?.default_payment_method);
    if (!orgId || !pmId) return [];
    const expanded = obj.invoice_settings?.default_payment_method;
    let pm: Obj | null = expanded && typeof expanded === 'object' ? expanded : null;
    if (!pm && stripeConfigured(env)) pm = await stripe<Obj>(env, 'GET', `/payment_methods/${encodeURIComponent(pmId)}`).catch(() => null);
    if (!pm || pm.type !== 'card' || !pm.card) return [];
    return [cardStmt(env, orgId, pmId, pm.card, now)];
  }

  return [];
}

function cardStmt(env: Env, orgId: string, providerId: string | null, card: Obj, now: number) {
  return env.DB.prepare(
    `INSERT INTO payment_methods (org_id, provider_id, kind, brand, last4, exp_month, exp_year, updated_at) VALUES (?, ?, 'card', ?, ?, ?, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET provider_id = excluded.provider_id, kind = 'card', brand = excluded.brand, last4 = excluded.last4,
       exp_month = excluded.exp_month, exp_year = excluded.exp_year, updated_at = excluded.updated_at`,
  ).bind(orgId, providerId, String(card.brand ?? '').slice(0, 30), String(card.last4 ?? '').slice(0, 4), Number(card.exp_month) || 0, Number(card.exp_year) || 0, now);
}
