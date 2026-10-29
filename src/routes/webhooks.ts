// /webhooks/stripe: the only source of billing state. Signature-checked, idempotent by event id:
// the event id is inserted in the same batch as its effects, so a replay changes nothing.

import { Hono } from 'hono';
import type { InvoiceStatus, SubscriptionLine } from '../contract';
import { failureText } from '../lib/billing';
import { applySwitchStmts } from './portal-billing';
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

  const checkoutId = str(obj.metadata?.checkout) ?? str(obj.subscription_details?.metadata?.checkout) ?? str(obj.parent?.subscription_details?.metadata?.checkout);
  const markCheckout = (state: 'paid' | 'failed', failure: string | null = null) =>
    checkoutId ? [DB.prepare("UPDATE checkouts SET state = ?, failure = ?, updated_at = ? WHERE id = ? AND state <> 'paid'").bind(state, failure, now, checkoutId)] : [];

  if (type === 'checkout.session.completed') {
    const orgId = await orgFor(env, obj, customer);
    if (!orgId) return [];
    const out: D1PreparedStatement[] = customer ? [linkCustomer(env, orgId, customer, now)] : [];
    const tournament = str(obj.metadata?.tournament);
    const isPass = obj.metadata?.kind === 'pass' || obj.metadata?.plan === 'event';
    if (obj.mode === 'payment' && isPass && tournament) {
      if (obj.payment_status !== 'paid') return out;
      const created = checkoutId ? await DB.prepare('SELECT created_by FROM checkouts WHERE id = ?').bind(checkoutId).first<{ created_by: string }>() : null;
      out.push(
        DB.prepare('INSERT OR IGNORE INTO passes (id, org_id, tournament_id, checkout_session_id, amount, created_at, created_by, invoice_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
          randomId('pass'),
          orgId,
          tournament,
          str(obj.id),
          typeof obj.amount_total === 'number' ? obj.amount_total : 0,
          now,
          created?.created_by ?? null,
          idOf(obj.invoice),
        ),
        ...markCheckout('paid'),
        auditStmt(env, { area: 'system', actor: null, action: 'billing.pass', sentence: 'Recorded a Turnier-Pass', targetSql: orgName(orgId), details: `tournament ${tournament}`, at: now }),
      );
    }
    const sub = idOf(obj.subscription);
    if (obj.mode === 'subscription' && sub) {
      out.push(
        DB.prepare("UPDATE subscriptions SET subscription_id = ?, pay_by = 'card', collection_method = 'charge_automatically', updated_at = ? WHERE org_id = ?").bind(sub, now, orgId),
        ...markCheckout('paid'),
      );
    }
    return out;
  }

  if (type === 'checkout.session.expired') return markCheckout('failed', 'Die Zahlung wurde nicht abgeschlossen. Es wurde nichts belastet.');

  if (type === 'payment_intent.payment_failed') {
    return markCheckout('failed', failureText(obj.last_payment_error?.code, obj.last_payment_error?.decline_code));
  }

  if (type.startsWith('customer.subscription.')) {
    const orgId = await orgFor(env, obj, customer);
    if (!orgId) return [];
    const status = type === 'customer.subscription.deleted' ? 'canceled' : (str(obj.status) ?? 'incomplete');
    const plan = ACTIVE.includes(status) ? 'plus' : 'gratis';
    const periodEnd = ms(obj.current_period_end) ?? ms(obj.items?.data?.[0]?.current_period_end);
    const method = str(obj.collection_method);
    const payBy = method === 'send_invoice' ? 'invoice' : method === 'charge_automatically' ? 'card' : null;
    const out: D1PreparedStatement[] = [
      DB.prepare(
        `INSERT INTO subscriptions (org_id, plan, state, provider, customer_id, subscription_id, collection_method, pay_by, current_period_end, updated_at)
         VALUES (?1, ?2, ?3, 'stripe', ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (org_id) DO UPDATE SET plan = excluded.plan, state = excluded.state, provider = 'stripe',
           customer_id = COALESCE(excluded.customer_id, subscriptions.customer_id), subscription_id = excluded.subscription_id,
           collection_method = excluded.collection_method, pay_by = COALESCE(excluded.pay_by, subscriptions.pay_by),
           current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`,
      ).bind(orgId, plan, status, customer, str(obj.id), method, payBy, periodEnd, now),
      auditStmt(env, { area: 'system', actor: null, action: 'billing.subscription', sentence: 'Subscription changed at Stripe', targetSql: orgName(orgId), details: `${status}, plan ${plan}`, at: now }),
    ];
    if (type === 'customer.subscription.deleted') {
      // The switch to Gratis takes effect: members who weren't kept leave the organisation.
      const row = await DB.prepare('SELECT org_id AS id, cancel_keep FROM subscriptions WHERE org_id = ?').bind(orgId).first<{ id: string; cancel_keep: string | null }>();
      if (row) out.push(...applySwitchStmts(env, row, now));
    } else if (obj.cancel_at_period_end === false) {
      out.push(DB.prepare('UPDATE subscriptions SET cancel_at = NULL, cancel_keep = NULL WHERE org_id = ? AND cancel_at IS NOT NULL').bind(orgId));
    } else if (obj.cancel_at_period_end === true && periodEnd) {
      out.push(DB.prepare('UPDATE subscriptions SET cancel_at = COALESCE(cancel_at, ?) WHERE org_id = ?').bind(ms(obj.cancel_at) ?? periodEnd, orgId));
    }
    return out;
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
    const lines = invoiceLines(obj);
    const paidWith = status === 'paid' ? (str(obj.collection_method) === 'send_invoice' ? 'invoice' : 'card') : null;
    const tournament = str(obj.metadata?.tournament);
    const extra: D1PreparedStatement[] = [];
    if (tournament) {
      extra.push(
        DB.prepare('UPDATE passes SET invoice_id = ?, receipt_url = COALESCE(?, receipt_url) WHERE tournament_id = ?').bind(invoiceId, str(obj.invoice_pdf), tournament),
        DB.prepare("UPDATE checkouts SET receipt_url = COALESCE(?, receipt_url), updated_at = ? WHERE tournament_id = ? AND state = 'paid'").bind(str(obj.invoice_pdf), now, tournament),
      );
    }
    if (checkoutId && status === 'paid') extra.push(DB.prepare('UPDATE checkouts SET receipt_url = COALESCE(?, receipt_url), updated_at = ? WHERE id = ?').bind(str(obj.invoice_pdf), now, checkoutId));
    if (type === 'invoice.payment_failed') extra.push(...markCheckout('failed', failureText(obj.last_finalization_error?.code)));
    return [
      ...extra,
      DB.prepare(
        `INSERT INTO invoices (id, org_id, number, created_at, due_at, amount, currency, status, description, pdf_url, pay_url, paid_at, updated_at, lines, paid_with)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT (id) DO UPDATE SET number = excluded.number, due_at = excluded.due_at, amount = excluded.amount, currency = excluded.currency,
           status = excluded.status, description = excluded.description, pdf_url = COALESCE(excluded.pdf_url, invoices.pdf_url),
           pay_url = COALESCE(excluded.pay_url, invoices.pay_url), paid_at = COALESCE(excluded.paid_at, invoices.paid_at), updated_at = excluded.updated_at,
           lines = CASE WHEN excluded.lines = '[]' THEN invoices.lines ELSE excluded.lines END, paid_with = COALESCE(excluded.paid_with, invoices.paid_with)`,
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
        JSON.stringify(lines),
        paidWith,
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

/** Stripe invoice lines as SubscriptionLines: passes are one-off, the subscription item is the base plan. */
function invoiceLines(obj: Obj): SubscriptionLine[] {
  const data: Obj[] = Array.isArray(obj.lines?.data) ? obj.lines.data : [];
  return data.slice(0, 20).map((l) => {
    const tournament = str(l.metadata?.tournament) ?? str(obj.metadata?.tournament);
    const recurring = Boolean(l.price?.recurring) || l.type === 'subscription' || l.parent?.type === 'subscription_item_details';
    const kind: SubscriptionLine['kind'] = tournament ? 'once' : recurring ? (data.indexOf(l) === 0 ? 'base' : 'addon') : 'once';
    return {
      kind,
      name: (str(l.description) ?? '').slice(0, 200),
      period: kind === 'once' ? 'once' : 'year',
      amount: typeof l.amount === 'number' ? l.amount : 0,
      tournamentId: tournament,
    };
  });
}

function cardStmt(env: Env, orgId: string, providerId: string | null, card: Obj, now: number) {
  return env.DB.prepare(
    `INSERT INTO payment_methods (org_id, provider_id, kind, brand, last4, exp_month, exp_year, updated_at) VALUES (?, ?, 'card', ?, ?, ?, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET provider_id = excluded.provider_id, kind = 'card', brand = excluded.brand, last4 = excluded.last4,
       exp_month = excluded.exp_month, exp_year = excluded.exp_year, updated_at = excluded.updated_at`,
  ).bind(orgId, providerId, String(card.brand ?? '').slice(0, 30), String(card.last4 ?? '').slice(0, 4), Number(card.exp_month) || 0, Number(card.exp_year) || 0, now);
}
