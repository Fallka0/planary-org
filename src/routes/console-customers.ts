// /console/customers: organisations with plan, billing state, members, tournaments and notes.

import type { Hono } from 'hono';
import type { CustomerDetail, CustomerRow, MemberRole, PlanId } from '../contract';
import type { AppEnv, Env } from '../env';
import { auditStmt } from '../lib/audit';
import { mailConfigured, sendMail } from '../lib/mail';
import {
  billingRecipients,
  billingState,
  contactOf,
  contactOut,
  getOrg,
  invoiceOut,
  invoicesOf,
  ORG_SELECT,
  overdueDays,
  paymentMethodOut,
  renewsAt,
  servicesOf,
  type InvoiceRow,
  type OrgRow,
  type PaymentMethodRow,
} from '../lib/orgs';
import { REQUEST_SELECT, requestSummary, type RequestRow } from '../lib/requests';
import { THIS_YEAR_SQL, thisYear, TOURNAMENT_ORDER, TOURNAMENT_SELECT, tournamentOut, type TournamentRow } from '../lib/tournaments';
import { ApiError, chf, clean, DAY, initials, notFound, oneOf, randomId, readJson, requireOneOf, requireText } from '../lib/util';
import { can } from '../permissions';
import { PLAN_IDS, planName, PLANS, VAULT_PLAN_IDS, VAULT_PLANS } from '../plans';
import { actorOf, need } from './guard';

async function customerRows(env: Env, now: number): Promise<CustomerRow[]> {
  const DB = env.DB;
  const [orgs, members, tournaments, invoices, methods, passes] = await Promise.all([
    DB.prepare(`${ORG_SELECT} ORDER BY o.name`).all<OrgRow>(),
    DB.prepare('SELECT org_id, COUNT(*) AS n FROM members GROUP BY org_id').all<{ org_id: string; n: number }>(),
    DB.prepare(`SELECT t.organisation_id AS org_id, COUNT(*) AS n FROM tournaments t WHERE t.organisation_id IS NOT NULL AND ${THIS_YEAR_SQL} GROUP BY t.organisation_id`)
      .bind(thisYear(now))
      .all<{ org_id: string; n: number }>(),
    DB.prepare('SELECT org_id, status, due_at, amount, paid_at, created_at FROM invoices').all<Pick<InvoiceRow, 'org_id' | 'status' | 'due_at' | 'amount' | 'paid_at' | 'created_at'>>(),
    DB.prepare('SELECT * FROM payment_methods').all<PaymentMethodRow>(),
    DB.prepare('SELECT org_id, SUM(amount) AS n FROM passes WHERE created_at >= ? GROUP BY org_id').bind(now - 365 * DAY).all<{ org_id: string; n: number }>(),
  ]);
  const count = (list: { org_id: string; n: number }[]) => new Map(list.map((r) => [r.org_id, r.n]));
  const memberCount = count(members.results);
  const tournamentCount = count(tournaments.results);
  const passRevenue = count(passes.results);
  const pms = new Map(methods.results.map((p) => [p.org_id, p]));
  const invByOrg = new Map<string, typeof invoices.results>();
  for (const inv of invoices.results) invByOrg.set(inv.org_id, [...(invByOrg.get(inv.org_id) ?? []), inv]);
  return orgs.results.map((o) => toRow(o, invByOrg.get(o.id) ?? [], pms.get(o.id) ?? null, memberCount.get(o.id) ?? 0, tournamentCount.get(o.id) ?? 0, now, passRevenue.get(o.id) ?? 0));
}

function toRow(
  o: OrgRow,
  invoices: Pick<InvoiceRow, 'status' | 'due_at' | 'amount' | 'paid_at' | 'created_at'>[],
  pm: PaymentMethodRow | null,
  members: number,
  tournaments: number,
  now: number,
  passRevenue: number,
): CustomerRow {
  const { billing, overdueDays: overdue } = billingState(o.plan, invoices, pm, now);
  // What the organisation brings in a year: Plus, plus the passes of the last twelve months.
  const revenueYear = (o.plan === 'plus' ? PLANS.plus.price : 0) + passRevenue;
  return {
    id: o.id,
    name: o.name,
    initials: initials(o.name),
    plan: o.plan,
    members,
    tournamentsThisYear: tournaments,
    services: servicesOf(o),
    revenueYear,
    billing,
    overdueDays: overdue,
    since: o.created_at,
  };
}

function filterRows(rows: CustomerRow[], q: { plan?: string; overdue?: string; q?: string }, slugs: Map<string, string>) {
  const plan = oneOf(q.plan, PLAN_IDS);
  const term = clean(q.q, 80).toLowerCase();
  return rows.filter(
    (r) =>
      (!plan || r.plan === plan) &&
      (q.overdue !== '1' || r.billing === 'overdue') &&
      (!term || r.name.toLowerCase().includes(term) || (slugs.get(r.id) ?? '').includes(term)),
  );
}

/** One CSV field: quoted when needed, and formula-looking values defused for spreadsheets. */
export function csvField(value: string | number | null): string {
  if (value === null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function customersCsv(rows: CustomerRow[]) {
  const header = ['id', 'name', 'plan', 'members', 'tournaments_this_year', 'revenue_year_chf', 'billing', 'overdue_days', 'customer_since'];
  const lines = rows.map((r) =>
    [
      r.id,
      r.name,
      r.plan,
      r.members,
      r.tournamentsThisYear,
      (r.revenueYear / 100).toFixed(2),
      r.billing,
      r.overdueDays,
      new Date(r.since).toISOString().slice(0, 10),
    ]
      .map(csvField)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

export function registerCustomers(app: Hono<AppEnv>) {
  const slugMap = async (env: Env) => new Map((await env.DB.prepare('SELECT id, slug FROM organisations').all<{ id: string; slug: string }>()).results.map((r) => [r.id, r.slug]));

  app.get('/customers', need('customers'), async (c) => {
    const now = Date.now();
    const rows = filterRows(await customerRows(c.env, now), c.req.query(), await slugMap(c.env));
    return c.json({ customers: rows });
  });

  app.get('/customers.csv', need('customers'), async (c) => {
    const now = Date.now();
    const rows = filterRows(await customerRows(c.env, now), c.req.query(), await slugMap(c.env));
    return c.body('﻿' + customersCsv(rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="planary-customers-${new Date(now).toISOString().slice(0, 10)}.csv"`,
    });
  });

  app.get('/customers/:id', need('customers'), async (c) => {
    const now = Date.now();
    const org = await getOrg(c.env, c.req.param('id'), now);
    if (!org) throw notFound('No organisation with that id.');
    const role = c.get('staff').role;
    const DB = c.env.DB;
    const [invoices, pm, contact, members, tournaments, notes, requests, tCount, passSum] = await Promise.all([
      invoicesOf(c.env, org.id),
      DB.prepare('SELECT * FROM payment_methods WHERE org_id = ?').bind(org.id).first<PaymentMethodRow>(),
      contactOf(c.env, org.id),
      DB.prepare("SELECT user_id, name, email, role, last_active FROM members WHERE org_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, name")
        .bind(org.id)
        .all<{ user_id: string; name: string; email: string; role: MemberRole; last_active: number | null }>(),
      DB.prepare(`${TOURNAMENT_SELECT} WHERE t.organisation_id = ? ORDER BY ${TOURNAMENT_ORDER} LIMIT 100`).bind(org.id).all<TournamentRow>(),
      can(role, 'notes', 'read')
        ? DB.prepare('SELECT id, staff_name, body, created_at FROM customer_notes WHERE org_id = ? ORDER BY created_at DESC LIMIT 100')
            .bind(org.id)
            .all<{ id: string; staff_name: string; body: string; created_at: number }>()
        : Promise.resolve({ results: [] as { id: string; staff_name: string; body: string; created_at: number }[] }),
      can(role, 'support', 'read')
        ? DB.prepare(`${REQUEST_SELECT} WHERE r.org_id = ? ORDER BY r.updated_at DESC LIMIT 50`).bind(org.id).all<RequestRow>()
        : Promise.resolve({ results: [] as RequestRow[] }),
      DB.prepare(`SELECT COUNT(*) AS n FROM tournaments t WHERE t.organisation_id = ? AND ${THIS_YEAR_SQL}`).bind(org.id, thisYear(now)).first<{ n: number }>(),
      DB.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM passes WHERE org_id = ? AND created_at >= ?').bind(org.id, now - 365 * DAY).first<{ n: number }>(),
    ]);
    const row = toRow(org, invoices, pm, members.results.length, tCount?.n ?? 0, now, passSum?.n ?? 0);
    const detail: CustomerDetail = {
      ...row,
      slug: org.slug,
      renewsAt: renewsAt(org),
      paymentMethod: paymentMethodOut(pm),
      provider: org.customer_id ? 'stripe' : null,
      contact: contact ? contactOut(contact) : null,
      invoices: invoices.map((i) => invoiceOut(i, now)),
      memberList: members.results.map((m) => ({ id: m.user_id, name: m.name, email: m.email, role: m.role, lastActive: m.last_active })),
      tournaments: tournaments.results.map(tournamentOut),
      notes: notes.results.map((n) => ({ id: n.id, by: n.staff_name, body: n.body, at: n.created_at })),
      requests: requests.results.map(requestSummary),
    };
    return c.json(detail);
  });

  app.post('/customers/:id/notes', need('notes'), async (c) => {
    const org = await getOrg(c.env, c.req.param('id'));
    if (!org) throw notFound('No organisation with that id.');
    const body = await readJson(c);
    const text = requireText(body.body, 'body', 4000, { multiline: true });
    const me = c.get('staff');
    const now = Date.now();
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM customer_notes WHERE org_id = ?').bind(org.id).first<{ n: number }>();
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO customer_notes (id, org_id, staff_id, staff_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
        randomId('note'),
        org.id,
        me.id,
        me.name,
        text,
        now,
      ),
      auditStmt(c.env, { area: 'notes', actor: actorOf(me), action: 'customer.note', sentence: 'Added a customer note', target: org.name, details: `note ${(n?.n ?? 0) + 1}` }),
    ]);
    return c.json({ ok: true });
  });

  /** E-mails the invoice's payment link to the billing contact. Needs Resend (503 without). */
  app.post('/customers/:id/reminder', need('customers'), async (c) => {
    const org = await getOrg(c.env, c.req.param('id'));
    if (!org) throw notFound('No organisation with that id.');
    const body = await readJson(c);
    const invoiceId = requireText(body.invoiceId, 'invoiceId', 100);
    const inv = await c.env.DB.prepare('SELECT * FROM invoices WHERE id = ? AND org_id = ?').bind(invoiceId, org.id).first<InvoiceRow>();
    if (!inv) throw notFound('No invoice with that id for this organisation.');
    if (inv.status !== 'open') throw new ApiError(409, 'Only open invoices can be reminded.', 'invoice_not_open');
    if (!inv.pay_url) throw new ApiError(409, 'This invoice has no payment link.', 'no_pay_url');
    if (!mailConfigured(c.env)) throw new ApiError(503, 'E-mail is not set up (RESEND_API_KEY).', 'mail_not_configured');
    const to = await billingRecipients(c.env, org.id);
    if (to.length === 0) throw new ApiError(409, 'This organisation has no billing e-mail.', 'no_billing_contact');
    const now = Date.now();
    const days = overdueDays(inv, now);
    const sent = await sendMail(c.env, {
      to,
      subject: `Erinnerung: Rechnung ${inv.number || inv.id}`,
      text:
        `Hallo\n\nDie Rechnung ${inv.number || inv.id} über ${chf(inv.amount)} für ${org.name} ist noch offen` +
        `${days > 0 ? ` und seit ${days} ${days === 1 ? 'Tag' : 'Tagen'} überfällig` : ''}.\n\n` +
        `Du kannst sie hier bezahlen: ${inv.pay_url}\n\nFalls ihr schon bezahlt habt, kannst du diese E-Mail ignorieren.\n\nPlanary`,
    });
    if (!sent) throw new ApiError(502, "The reminder couldn't be sent. Try again in a moment.", 'mail_failed');
    const me = c.get('staff');
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE invoices SET reminders = reminders + 1 WHERE id = ?').bind(inv.id),
      auditStmt(c.env, {
        area: 'customers',
        actor: actorOf(me),
        action: 'invoice.reminder',
        sentence: 'Sent a payment reminder',
        target: `Invoice ${inv.number || inv.id}`,
        details: `${org.name}, ${ordinal(inv.reminders + 1)} reminder`,
      }),
    ]);
    return c.json({ ok: true });
  });

  /** Staff set the plan (e.g. comp Plus); no charge is created at the provider. */
  app.post('/customers/:id/plan', need('customers'), async (c) => {
    const org = await getOrg(c.env, c.req.param('id'));
    if (!org) throw notFound('No organisation with that id.');
    const body = await readJson(c);
    const me = c.get('staff');
    if (body.product !== undefined) {
      requireOneOf(body.product, ['vault'] as const, 'product');
      const vaultPlan = requireOneOf(body.plan, VAULT_PLAN_IDS, 'plan');
      const why = requireText(body.reason, 'reason', 500);
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE organisations SET vault_override = ?, vault_override_reason = ? WHERE id = ?').bind(vaultPlan, why, org.id),
        auditStmt(c.env, {
          area: 'customers',
          actor: actorOf(me),
          action: 'customer.plan',
          sentence: 'Changed a plan',
          target: org.name,
          details: `${org.vault_override ? VAULT_PLANS[org.vault_override].name : 'Vault (billing)'} → ${VAULT_PLANS[vaultPlan].name}: ${why}`,
        }),
      ]);
      return c.json({ ok: true });
    }
    const plan: PlanId = requireOneOf(body.plan, PLAN_IDS, 'plan');
    const reason = requireText(body.reason, 'reason', 500);
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE organisations SET plan_override = ?, plan_override_reason = ? WHERE id = ?').bind(plan, reason, org.id),
      auditStmt(c.env, {
        area: 'customers',
        actor: actorOf(me),
        action: 'customer.plan',
        sentence: 'Changed a plan',
        target: org.name,
        details: `${planName(org.plan)} → ${planName(plan)}: ${reason}`,
      }),
    ]);
    return c.json({ ok: true });
  });
}
