// Organisations: effective plan, billing state, invoices, contacts, banners.

import type { BillingContact, Invoice, InvoiceStatus, OrgKind, OrgService, PaymentMethod, PlanId, VaultPlanId, PortalBanner, SubscriptionLine, TournamentSummary } from '../contract';
import type { Env } from '../env';
import { chf, DAY, longDate, parseJsonArray, shortDate, timeOfDay, zurichDay } from './util';

/** The services an organisation can switch on in the portal, in display order. */
export const ORG_SERVICES: readonly OrgService[] = ['tournament', 'wishlist'];

/** Services whose outages affect organisers' running tournaments (for banners). */
export const ORGANISER_SERVICES = ['tournament'] as const;

/**
 * How long Plus keeps running normally after an invoice's due date. After it, new tournaments
 * get Gratis limits until the invoice is paid; nothing is deleted, running ones keep going.
 */
export const GRACE_DAYS = 26;

/** Subscription states in which Plus is on. */
export const ACTIVE_STATES = ['active', 'past_due', 'trialing'];

/**
 * SQL for an organisation's effective plan. Needs `o` (organisations) and `s` (LEFT JOIN
 * subscriptions) in scope. Staff override > active Plus subscription > Gratis. Passes are on
 * tournaments, not on the organisation, so they don't change it.
 */
export const PLAN_SQL = `COALESCE(o.plan_override,
  CASE WHEN s.plan = 'plus' AND s.state IN ('active', 'past_due', 'trialing') THEN 'plus' ELSE 'gratis' END)`;

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  logo_key: string | null;
  /** JSON array of OrgService. Read it with servicesOf(). */
  services: string;
  kind: OrgKind;
  /** Staff override of the Vault plan; null = follow billing. */
  vault_override: VaultPlanId | null;
  plan_override: PlanId | null;
  created_at: number;
  delete_at: number | null;
  plan: PlanId;
  sub_state: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  current_period_end: number | null;
  sub_plan: PlanId | null;
  collection_method: string | null;
  pay_by: 'card' | 'invoice' | null;
  cancel_at: number | null;
  cancel_keep: string | null;
}

export const ORG_SELECT = `SELECT o.id, o.name, o.slug, o.logo_key, o.services, o.kind, o.vault_override, o.plan_override, o.created_at, o.delete_at,
  ${PLAN_SQL} AS plan, s.state AS sub_state, s.customer_id, s.subscription_id, s.current_period_end, s.plan AS sub_plan,
  s.collection_method, s.pay_by, s.cancel_at, s.cancel_keep
  FROM organisations o LEFT JOIN subscriptions s ON s.org_id = o.id`;

/** The services an organisation uses, in a fixed order. Unknown or broken values read as Tournament.
 *  Personal accounts only pay for products, so they have none. */
export function servicesOf(org: Pick<OrgRow, 'services'> & Partial<Pick<OrgRow, 'kind'>>): OrgService[] {
  if (org.kind === 'personal') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(org.services);
  } catch {
    raw = null;
  }
  const list = Array.isArray(raw) ? ORG_SERVICES.filter((s) => raw.includes(s)) : [];
  return list.length ? list : ['tournament'];
}

export async function getOrg(env: Env, id: string, _now = Date.now()) {
  return env.DB.prepare(`${ORG_SELECT} WHERE o.id = ?`).bind(id).first<OrgRow>();
}

export function renewsAt(org: Pick<OrgRow, 'plan' | 'sub_state' | 'current_period_end'>) {
  return org.plan === 'plus' && org.sub_state && ACTIVE_STATES.includes(org.sub_state) ? org.current_period_end : null;
}

// ── Invoices ─────────────────────────────────────────

export interface InvoiceRow {
  id: string;
  org_id: string;
  number: string;
  created_at: number;
  due_at: number | null;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  description: string;
  pdf_url: string | null;
  pay_url: string | null;
  paid_at: number | null;
  reminders: number;
  /** JSON SubscriptionLine[] */
  lines: string;
  paid_with: 'card' | 'invoice' | null;
}

/** Whole days past due while open (at least 1 once the due date has passed), else 0. */
export function overdueDays(inv: Pick<InvoiceRow, 'status' | 'due_at'>, now: number) {
  if (inv.status !== 'open' || inv.due_at == null || now <= inv.due_at) return 0;
  return Math.max(1, Math.floor((now - inv.due_at) / DAY));
}

export function invoiceOut(r: InvoiceRow, now: number): Invoice {
  return {
    id: r.id,
    number: r.number,
    createdAt: r.created_at,
    dueAt: r.due_at,
    amount: r.amount,
    currency: 'CHF',
    status: r.status,
    description: r.description,
    lines: parseJsonArray<SubscriptionLine>(r.lines ?? '[]'),
    paidWith: r.paid_with ?? null,
    overdueDays: overdueDays(r, now),
    pdfUrl: r.pdf_url,
    payUrl: r.pay_url,
  };
}

export async function invoicesOf(env: Env, orgId: string) {
  const { results } = await env.DB.prepare('SELECT * FROM invoices WHERE org_id = ? ORDER BY created_at DESC LIMIT 100').bind(orgId).all<InvoiceRow>();
  return results;
}

// ── Payment method and contact ───────────────────────

export interface PaymentMethodRow {
  org_id: string;
  kind: PaymentMethod['kind'];
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

export const paymentMethodOut = (r: PaymentMethodRow | null): PaymentMethod | null =>
  r ? { brand: r.brand, last4: r.last4, expMonth: r.exp_month, expYear: r.exp_year, kind: r.kind } : null;

/** True when a card's last valid day is within 30 days (or already past). */
export function cardExpiresSoon(pm: Pick<PaymentMethodRow, 'kind' | 'exp_month' | 'exp_year'> | null, now: number) {
  if (!pm || pm.kind !== 'card' || !pm.exp_year || !pm.exp_month) return false;
  const end = Date.UTC(pm.exp_year, pm.exp_month, 1); // first day after the expiry month
  return end - now <= 30 * DAY;
}

/** The Console's billing column (CustomerRow.billing). */
export type CustomerBilling = 'paid' | 'overdue' | 'free' | 'card_expires';

/** The last day a card works: the first day after its expiry month. */
export const cardEnd = (pm: Pick<PaymentMethodRow, 'exp_month' | 'exp_year'>) => Date.UTC(pm.exp_year, pm.exp_month, 1);

/** True when the card stops working before the next renewal. */
export function cardExpiresBefore(pm: Pick<PaymentMethodRow, 'kind' | 'exp_month' | 'exp_year'> | null, renewal: number | null) {
  if (!pm || pm.kind !== 'card' || !pm.exp_year || !pm.exp_month || renewal == null) return false;
  return cardEnd(pm) <= renewal;
}

/** The overdue invoice furthest past its due date, if any. */
export function oldestOverdue<T extends Pick<InvoiceRow, 'status' | 'due_at'>>(invoices: T[], now: number): T | null {
  const open = invoices.filter((i) => overdueDays(i, now) > 0).sort((a, b) => (a.due_at ?? 0) - (b.due_at ?? 0));
  return open[0] ?? null;
}

/** Plus runs normally until this time after the due date of the oldest overdue invoice. */
export const graceUntil = (due: number) => due + GRACE_DAYS * DAY;

export function billingState(plan: PlanId, invoices: Pick<InvoiceRow, 'status' | 'due_at'>[], pm: PaymentMethodRow | null, now: number) {
  const overdue = Math.max(0, ...invoices.map((i) => overdueDays(i, now)));
  let billing: CustomerBilling;
  if (overdue > 0) billing = 'overdue';
  else if (cardExpiresSoon(pm, now)) billing = 'card_expires';
  else if (plan === 'gratis' && invoices.length === 0) billing = 'free';
  else billing = 'paid';
  return { billing, overdueDays: overdue };
}

export interface ContactRow {
  email: string;
  phone: string;
  address: string;
}

export const contactOut = (r: ContactRow | null): BillingContact =>
  r ? { email: r.email, phone: r.phone, address: parseJsonArray<string>(r.address).map(String) } : { email: '', phone: '', address: [] };

export async function contactOf(env: Env, orgId: string) {
  return env.DB.prepare('SELECT email, phone, address FROM billing_contacts WHERE org_id = ?').bind(orgId).first<ContactRow>();
}

/** Billing contact e-mail, else the owners' e-mails. */
export async function billingRecipients(env: Env, orgId: string) {
  const contact = await contactOf(env, orgId);
  if (contact?.email) return [contact.email];
  const { results } = await env.DB.prepare("SELECT email FROM members WHERE org_id = ? AND role = 'owner' AND email <> ''").bind(orgId).all<{ email: string }>();
  return results.map((r) => r.email);
}

// ── Banners ──────────────────────────────────────────

export function overdueBanner(inv: InvoiceRow, now: number): PortalBanner {
  const days = overdueDays(inv, now);
  const deadline = graceUntil(inv.due_at ?? now);
  const number = inv.number || inv.id;
  return {
    kind: 'overdue',
    title: `Rechnung ${number} über ${chf(inv.amount)} ist seit ${days} ${days === 1 ? 'Tag' : 'Tagen'} offen.`,
    text: `Plus läuft bis ${longDate(deadline, now)} normal weiter. Bitte bis dann bezahlen.`,
    ref: inv.id,
    tournamentIds: [],
  };
}

interface ShownUpdate {
  incident_id: string;
  started_at: number;
  message: string;
}

/** The latest "show to organisers" update of each open incident on an organiser-facing service. */
export async function shownIncidentUpdates(env: Env): Promise<ShownUpdate[]> {
  const placeholders = ORGANISER_SERVICES.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT i.id AS incident_id, i.started_at, u.message
     FROM incidents i
     JOIN incident_updates u ON u.id = (
       SELECT u2.id FROM incident_updates u2 WHERE u2.incident_id = i.id AND u2.show_to_organisers = 1 ORDER BY u2.created_at DESC, u2.rowid DESC LIMIT 1)
     WHERE i.status <> 'resolved'
       AND EXISTS (SELECT 1 FROM incident_services s WHERE s.incident_id = i.id AND s.service IN (${placeholders}))
     ORDER BY i.started_at DESC`,
  )
    .bind(...ORGANISER_SERVICES)
    .all<ShownUpdate>();
  return results;
}

/** "Live-Resultate kommen verzögert an. Eure Resultate …" → the first sentence and the rest. */
export function firstSentence(message: string): [string, string] {
  const m = message.trim().match(/^(.+?[.?:])\s+(\S[\s\S]*)$/);
  return m ? [m[1], m[2]] : [message.trim(), ''];
}

export function incidentBanner(u: ShownUpdate, tournamentIds: string[], now: number): PortalBanner {
  const since = zurichDay(u.started_at) === zurichDay(now) ? timeOfDay(u.started_at) : `${shortDate(u.started_at)}, ${timeOfDay(u.started_at)}`;
  const [lead, rest] = firstSentence(u.message);
  return { kind: 'incident', title: `Störung bei Planary: ${lead}`, text: `Seit ${since}.${rest ? ` ${rest}` : ''}`, ref: u.incident_id, tournamentIds };
}

/** Banners for an organisation. Overdue banners only for owners (members don't see billing). */
export async function orgBanners(env: Env, orgId: string, isOwner: boolean, now: number): Promise<PortalBanner[]> {
  const banners: PortalBanner[] = [];
  const [updates, live] = await Promise.all([
    shownIncidentUpdates(env),
    env.DB.prepare("SELECT id FROM tournaments WHERE organisation_id = ? AND state = 'live'").bind(orgId).all<{ id: string }>(),
  ]);
  const liveIds = live.results.map((r) => r.id);
  if (liveIds.length) for (const u of updates) banners.push(incidentBanner(u, liveIds, now));
  if (isOwner) {
    const { results } = await env.DB.prepare("SELECT * FROM invoices WHERE org_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at")
      .bind(orgId, now)
      .all<InvoiceRow>();
    for (const inv of results) banners.push(overdueBanner(inv, now));
  }
  return banners;
}

/** Incident banners for one tournament (shown on its page while it runs). */
export async function tournamentBanners(env: Env, t: Pick<TournamentSummary, 'id' | 'state'>, now: number): Promise<PortalBanner[]> {
  if (t.state !== 'live') return [];
  return (await shownIncidentUpdates(env)).map((u) => incidentBanner(u, [t.id], now));
}

// ── Validation ───────────────────────────────────────

export const SLUG = /^[a-z0-9-]{3,40}$/;

export function validSlug(slug: string) {
  return SLUG.test(slug) && !slug.startsWith('-') && !slug.endsWith('-');
}
