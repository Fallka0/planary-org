// Billing for plans v2: the organisation's state (free, active, overdue, card_expires,
// canceling), its subscription lines, its passes, usage, and the checkouts it starts.

import type { Billing, BillingState, CheckoutStatus, PassEntitlement, SubscriptionLine } from '../contract';
import type { Env } from '../env';
import { PASS, PLANS, planList, VAULT_PLANS, vaultPrice } from '../plans';
import { vaultActive, vaultBillingOut, vaultSubOf, type VaultSubRow } from './vault';
import {
  ACTIVE_STATES,
  cardExpiresBefore,
  contactOf,
  contactOut,
  graceUntil,
  invoiceOut,
  invoicesOf,
  oldestOverdue,
  paymentMethodOut,
  renewsAt,
  type InvoiceRow,
  type OrgRow,
  type PaymentMethodRow,
} from './orgs';
import { DAY, parseJsonArray, shortDate } from './util';

const YEAR = 365 * DAY;

export interface PassRow {
  id: string;
  org_id: string;
  tournament_id: string;
  amount: number;
  created_at: number;
  invoice_id: string | null;
  receipt_url: string | null;
  t_name: string | null;
  t_state: string | null;
  t_teams: number | null;
}

export async function passesOf(env: Env, orgId: string) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.org_id, p.tournament_id, p.amount, p.created_at, p.invoice_id, p.receipt_url, t.name AS t_name, t.state AS t_state, t.teams AS t_teams
     FROM passes p LEFT JOIN tournaments t ON t.id = p.tournament_id WHERE p.org_id = ? ORDER BY p.created_at DESC LIMIT 200`,
  )
    .bind(orgId)
    .all<PassRow>();
  return results;
}

export const passOut = (p: PassRow): PassEntitlement => ({
  id: p.id,
  tournamentId: p.tournament_id,
  tournamentName: p.t_name ?? 'Turnier',
  boughtAt: p.created_at,
  amount: p.amount,
  state: p.t_state === 'done' ? 'done' : 'active',
  teams: p.t_teams ?? 0,
  invoiceId: p.invoice_id,
  receiptUrl: p.receipt_url,
});

/** True while Plus is on through a subscription (not a staff override). */
export const subscribed = (org: Pick<OrgRow, 'sub_plan' | 'sub_state'>) => org.sub_plan === 'plus' && Boolean(org.sub_state && ACTIVE_STATES.includes(org.sub_state));

/** The organisation's billing state, most urgent first: overdue, canceling, card expiring, Plus, Gratis. */
export function stateOf(org: OrgRow, invoices: Pick<InvoiceRow, 'status' | 'due_at'>[], pm: PaymentMethodRow | null, now: number): BillingState {
  if (oldestOverdue(invoices, now)) return 'overdue';
  if (org.plan === 'plus' && org.cancel_at && org.cancel_at > now) return 'canceling';
  if (org.plan === 'plus' && org.pay_by !== 'invoice' && cardExpiresBefore(pm, renewsAt(org))) return 'card_expires';
  return org.plan === 'plus' ? 'active' : 'free';
}

/** Plus as the base line, Vault as an add-on, and the passes of the last year as one-off lines. */
export function linesOf(org: OrgRow, passes: PassRow[], now: number, vault: VaultSubRow | null = null): SubscriptionLine[] {
  const lines: SubscriptionLine[] = [];
  if (org.plan === 'plus') lines.push({ kind: 'base', name: PLANS.plus.name, period: 'year', amount: PLANS.plus.price, tournamentId: null });
  if (vaultActive(vault)) {
    lines.push({ kind: 'addon', name: VAULT_PLANS[vault.plan].name, period: vault.period, amount: vaultPrice(vault.plan, vault.period), tournamentId: null });
  }
  for (const p of passes) {
    if (p.created_at < now - YEAR) continue;
    lines.push({ kind: 'once', name: `${PASS.name} · ${p.t_name ?? 'Turnier'}`, period: 'once', amount: p.amount, tournamentId: p.tournament_id });
  }
  return lines;
}

/** Wishlists the organisation owns, from Wishlist; 0 when it can't be asked. */
export async function wishlistCount(env: Env, orgId: string) {
  if (!env.WISHLIST || !env.INTERNAL_KEY) return 0;
  try {
    const res = await env.WISHLIST.fetch(new Request(`https://wishlist.internal/api/internal/orgs/${encodeURIComponent(orgId)}/lists`, { headers: { 'x-internal-key': env.INTERNAL_KEY } }));
    if (!res.ok) return 0;
    const d = (await res.json()) as { lists?: unknown };
    return Array.isArray(d.lists) ? d.lists.length : 0;
  } catch {
    return 0;
  }
}

export async function billingOf(env: Env, org: OrgRow, now: number): Promise<Billing> {
  const DB = env.DB;
  const [invoices, pm, contact, passes, usage, running, organisers, wishlists, vault] = await Promise.all([
    invoicesOf(env, org.id),
    DB.prepare('SELECT * FROM payment_methods WHERE org_id = ?').bind(org.id).first<PaymentMethodRow>(),
    contactOf(env, org.id),
    passesOf(env, org.id),
    DB.prepare('SELECT COALESCE(MAX(teams), 0) AS largest FROM tournaments WHERE organisation_id = ? AND COALESCE(starts_at, updated_at) >= ?')
      .bind(org.id, now - YEAR)
      .first<{ largest: number }>(),
    DB.prepare("SELECT COUNT(*) AS n FROM tournaments WHERE organisation_id = ? AND state = 'live'").bind(org.id).first<{ n: number }>(),
    DB.prepare('SELECT COUNT(*) AS n FROM members WHERE org_id = ?').bind(org.id).first<{ n: number }>(),
    wishlistCount(env, org.id),
    vaultSubOf(env, org.id),
  ]);
  const visible = invoices.filter((i) => i.status !== 'draft');
  const overdue = oldestOverdue(visible, now);
  const renews = renewsAt(org);
  return {
    plans: planList(),
    pass: PASS,
    current: org.plan,
    state: stateOf(org, visible, pm, now),
    lines: linesOf(org, passes, now, vault),
    passes: passes.map(passOut),
    invoices: visible.map((i) => invoiceOut(i, now)),
    paymentMethod: paymentMethodOut(pm),
    payBy: org.plan === 'plus' ? (org.pay_by ?? (org.collection_method === 'send_invoice' ? 'invoice' : 'card')) : null,
    contact: contactOut(contact),
    renewsAt: renews,
    reminderAt: renews ? renews - 30 * DAY : null,
    graceUntil: overdue?.due_at ? graceUntil(overdue.due_at) : null,
    cancelAt: org.plan === 'plus' && org.cancel_at && org.cancel_at > now ? org.cancel_at : null,
    usage: { largestTournament: usage?.largest ?? 0, running: running?.n ?? 0, organisers: organisers?.n ?? 0, wishlists },
    vault: vaultBillingOut(vault, org.vault_override, now),
  };
}

/** Past the grace date of an overdue invoice: new tournaments get Gratis limits. */
export async function pastGrace(env: Env, orgId: string, now: number) {
  const row = await env.DB.prepare("SELECT MIN(due_at) AS due FROM invoices WHERE org_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ?")
    .bind(orgId, now)
    .first<{ due: number | null }>();
  return row?.due != null && graceUntil(row.due) <= now;
}

// ── Checkouts ────────────────────────────────────────

/** Where to go back to after paying: https on planary.ch or a subdomain, nothing else. */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (host !== 'planary.ch' && !host.endsWith('.planary.ch')) return null;
  return url.toString();
}

export interface CheckoutRow {
  id: string;
  org_id: string;
  kind: 'plan' | 'pass';
  pay_by: 'card' | 'invoice';
  product: 'vault' | null;
  product_plan: 'plus' | 'pro' | null;
  period: 'month' | 'year' | null;
  tournament_id: string | null;
  tournament_name: string | null;
  state: 'pending' | 'paid' | 'failed';
  failure: string | null;
  amount: number;
  session_id: string | null;
  receipt_email: string;
  receipt_url: string | null;
  return_to: string | null;
  created_by: string;
  created_at: number;
}

export const checkoutOut = (r: CheckoutRow): CheckoutStatus => ({
  id: r.id,
  orgId: r.org_id,
  kind: r.kind,
  product: r.product ?? null,
  productPlan: r.product_plan ?? null,
  period: r.period ?? null,
  state: r.state,
  failure: r.failure,
  amount: r.pay_by === 'invoice' ? 0 : r.amount,
  payBy: r.pay_by,
  tournamentId: r.tournament_id,
  tournamentName: r.tournament_name,
  receiptEmail: r.receipt_email,
  receiptUrl: r.receipt_url,
  returnTo: r.return_to,
});

/** Stripe decline codes in German, for the checkout's error. */
const DECLINES: Record<string, string> = {
  card_declined: 'Deine Bank hat die Karte abgelehnt.',
  insufficient_funds: 'Auf der Karte ist nicht genug Guthaben.',
  expired_card: 'Die Karte ist abgelaufen.',
  incorrect_cvc: 'Der Prüfcode der Karte stimmt nicht.',
  processing_error: 'Bei der Bank ist ein Fehler aufgetreten. Versuch es noch einmal.',
  authentication_required: 'Die Bank wollte die Zahlung bestätigen lassen, das hat nicht geklappt.',
};

export function failureText(code: unknown, declineCode?: unknown) {
  const key = typeof declineCode === 'string' && DECLINES[declineCode] ? declineCode : typeof code === 'string' ? code : '';
  return DECLINES[key] ?? 'Die Zahlung ist nicht durchgegangen. Es wurde nichts belastet.';
}

/** "Plus, 3.2.2026 bis 2.2.2027" */
export const periodText = (from: number, to: number) => `${shortDate(from)} bis ${shortDate(to - DAY)}`;

/** The members who keep organising after a switch to Gratis (empty = everyone, when they fit). */
export const keepOf = (org: Pick<OrgRow, 'cancel_keep'>) => parseJsonArray<string>(org.cancel_keep ?? '[]').map(String);
