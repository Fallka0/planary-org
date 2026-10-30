// Vault billing (ADR 0003): its Stripe prices, the account's Vault subscription row, and what the
// portal's billing page shows for it. Entitlements are answered in routes/internal.ts.

import type { BillingPeriod, VaultBilling, VaultPlanId } from '../contract';
import type { Env } from '../env';
import { vaultPlanList } from '../plans';
import { ACTIVE_STATES } from './orgs';

export type PaidVaultPlan = Exclude<VaultPlanId, 'free'>;

export interface VaultSubRow {
  org_id: string;
  plan: PaidVaultPlan;
  period: BillingPeriod;
  state: string;
  subscription_id: string | null;
  pay_by: 'card' | 'invoice' | null;
  current_period_end: number | null;
  cancel_at: number | null;
  pending_plan: PaidVaultPlan | null;
  pending_period: BillingPeriod | null;
  schedule_id: string | null;
}

const PRICE_VARS = {
  plus: { month: 'STRIPE_PRICE_VAULT_PLUS_MONTH', year: 'STRIPE_PRICE_VAULT_PLUS_YEAR' },
  pro: { month: 'STRIPE_PRICE_VAULT_PRO_MONTH', year: 'STRIPE_PRICE_VAULT_PRO_YEAR' },
} as const;

/** The Stripe price of a Vault plan and period, if it is set up. */
export const vaultPriceId = (env: Env, plan: PaidVaultPlan, period: BillingPeriod): string | undefined => env[PRICE_VARS[plan][period]];

/** Which Vault plan and period a Stripe price is, or null when it isn't a Vault price. */
export function vaultPlanOfPrice(env: Env, priceId: string | null | undefined): { plan: PaidVaultPlan; period: BillingPeriod } | null {
  if (!priceId) return null;
  for (const plan of ['plus', 'pro'] as const) {
    for (const period of ['month', 'year'] as const) if (vaultPriceId(env, plan, period) === priceId) return { plan, period };
  }
  return null;
}

export const vaultSubOf = (env: Env, orgId: string) =>
  env.DB.prepare("SELECT * FROM product_subscriptions WHERE org_id = ? AND product = 'vault'").bind(orgId).first<VaultSubRow>();

/** True while a Vault subscription is on (paid, or past due within the provider's retries). */
export const vaultActive = (row: Pick<VaultSubRow, 'state'> | null): row is VaultSubRow => Boolean(row && ACTIVE_STATES.includes(row.state));

/** Plus < Pro; within a plan, a month < a year. A change to something higher applies right away. */
export const isUpgrade = (from: { plan: PaidVaultPlan; period: BillingPeriod }, to: { plan: PaidVaultPlan; period: BillingPeriod }) =>
  to.plan !== from.plan ? to.plan === 'pro' : to.period === 'year' && from.period === 'month';

export function vaultBillingOut(sub: VaultSubRow | null, override: VaultPlanId | null, now: number): VaultBilling {
  const active = vaultActive(sub) ? sub : null;
  const cancelAt = active?.cancel_at && active.cancel_at > now ? active.cancel_at : null;
  return {
    plans: vaultPlanList(),
    current: override ?? active?.plan ?? 'free',
    period: active?.period ?? null,
    payBy: active?.pay_by ?? null,
    renewsAt: active && !cancelAt ? active.current_period_end : null,
    cancelAt,
    pending: active?.pending_plan && active.pending_period ? { plan: active.pending_plan, period: active.pending_period } : null,
  };
}
