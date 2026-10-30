// Plans, the pass, limits and prices (plans v2: Gratis and Plus, and the Turnier-Pass as a
// one-off on one tournament). Prices are real. Provider price ids come from env vars
// (STRIPE_PRICE_PLUS, STRIPE_PRICE_PASS), not from here. 'pro' is reserved and not built.

import type { BillingPeriod, Pass, Plan, PlanId, PlanLimits, VaultPlan, VaultPlanId, WishlistLimits } from './contract';

export const PLAN_IDS: readonly PlanId[] = ['gratis', 'plus'];

const GRATIS: PlanLimits = {
  maxTeams: 16,
  maxRunning: 1,
  maxOrganisers: 2,
  branding: false,
  checkIn: true,
  waitingList: false,
  export: false,
  matchDaySupport: false,
  invoice: false,
};

const PLUS: PlanLimits = {
  maxTeams: 128,
  maxRunning: null,
  maxOrganisers: 10,
  branding: true,
  checkIn: true,
  waitingList: true,
  export: true,
  matchDaySupport: true,
  invoice: true,
};

/** Plus's tournament limits for the one tournament, without match-day support or invoices. */
const PASS_LIMITS: PlanLimits = { ...PLUS, maxRunning: 1, matchDaySupport: false, invoice: false };

// Wishlist: the organisation's own wishlists. A pass is for one tournament, so it changes nothing here.
const WISHLIST_GRATIS: WishlistLimits = { maxLists: 3 };
const WISHLIST_PLUS: WishlistLimits = { maxLists: null };

export const PLANS: Record<PlanId, Plan> = {
  gratis: { id: 'gratis', name: 'Planary Gratis', price: 0, period: 'forever', limits: GRATIS, wishlist: WISHLIST_GRATIS },
  plus: { id: 'plus', name: 'Planary Plus', price: 14900, period: 'year', limits: PLUS, wishlist: WISHLIST_PLUS },
};

export const PASS: Pass = { id: 'tournament_pass', name: 'Turnier-Pass', nameEn: 'Tournament Pass', price: 2900, period: 'tournament', limits: PASS_LIMITS };

export const planList = (): Plan[] => PLAN_IDS.map((id) => PLANS[id]);

export const planName = (id: PlanId) => PLANS[id].name;

/** Old stored or reported plan ids (before plans v2) read as their new ones. */
export function planOf(value: unknown): PlanId {
  if (value === 'plus' || value === 'verein') return 'plus';
  return 'gratis';
}

// ── Vault (ADR 0003): per person, its own subscription next to Planary Plus ──

export const VAULT_PLAN_IDS: readonly VaultPlanId[] = ['free', 'plus', 'pro'];

export const VAULT_PLANS: Record<VaultPlanId, VaultPlan> = {
  free: { id: 'free', name: 'Vault Free', monthly: 0, yearly: 0, quotaGb: 10 },
  plus: { id: 'plus', name: 'Vault Plus', monthly: 400, yearly: 4000, quotaGb: 200 },
  pro: { id: 'pro', name: 'Vault Pro', monthly: 1000, yearly: 10000, quotaGb: 2048 },
};

export const vaultPlanList = (): VaultPlan[] => VAULT_PLAN_IDS.map((id) => VAULT_PLANS[id]);

/** Higher is more: free < plus < pro. */
export const vaultRank = (id: VaultPlanId) => VAULT_PLAN_IDS.indexOf(id);

/** What one period of a Vault plan costs, in Rappen. */
export const vaultPrice = (plan: 'plus' | 'pro', period: BillingPeriod) => (period === 'year' ? VAULT_PLANS[plan].yearly : VAULT_PLANS[plan].monthly);
