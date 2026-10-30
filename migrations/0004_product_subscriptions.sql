-- Product subscriptions (ADR 0003): Vault is billed through planary-org, as its own subscription
-- next to the organisation's Planary Plus. `subscriptions` stays the Planary Plus subscription
-- (and the Stripe customer); `product_subscriptions` holds one row per product an account pays for.

-- Personal billing accounts: an organisation of one, created when a person buys Vault on their own.
ALTER TABLE organisations ADD COLUMN kind TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'personal'));
-- Staff override for Vault (Console "Change plan" with product vault). NULL = follow billing.
ALTER TABLE organisations ADD COLUMN vault_override TEXT CHECK (vault_override IN ('free', 'plus', 'pro'));
ALTER TABLE organisations ADD COLUMN vault_override_reason TEXT;

CREATE TABLE product_subscriptions (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  product TEXT NOT NULL CHECK (product IN ('vault')),
  plan TEXT NOT NULL CHECK (plan IN ('plus', 'pro')),
  period TEXT NOT NULL CHECK (period IN ('month', 'year')),
  -- Provider state: active, past_due, canceled, incomplete, ...
  state TEXT NOT NULL DEFAULT 'incomplete',
  subscription_id TEXT UNIQUE,
  pay_by TEXT CHECK (pay_by IN ('card', 'invoice')),
  current_period_end INTEGER,
  -- Cancelling: the day it ends.
  cancel_at INTEGER,
  -- A downgrade waiting for the end of the period (a Stripe subscription schedule).
  pending_plan TEXT CHECK (pending_plan IN ('plus', 'pro')),
  pending_period TEXT CHECK (pending_period IN ('month', 'year')),
  schedule_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, product)
);

-- What a checkout bought, when it is a product plan rather than Planary Plus or a pass.
ALTER TABLE checkouts ADD COLUMN product TEXT CHECK (product IN ('vault'));
ALTER TABLE checkouts ADD COLUMN product_plan TEXT CHECK (product_plan IN ('plus', 'pro'));
ALTER TABLE checkouts ADD COLUMN period TEXT CHECK (period IN ('month', 'year'));
