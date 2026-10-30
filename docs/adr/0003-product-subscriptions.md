# ADR 0003 · Product subscriptions: Vault billed through planary-org

Status: proposed. Extends ADR 0002; nothing in it changes for Tournament or Wishlist.

## Context

Vault (vault.planary.ch) has its own plans, per person: Vault Free (10 GB), Vault Plus (CHF 4 a month
or 40 a year) and Vault Pro (CHF 10 a month or 100 a year). They live in Vault's own database
(`vaults.plan`) and nothing can change them: there is no checkout, no invoice and no place to cancel.
At the same time planary-org sells "Plus" to organisations (CHF 149 a year, Tournament and Wishlist).
Two systems, two meanings of "Plus", and a pricing page that needs an FAQ entry to explain it.

Companies with several products (Proton, Atlassian, Dropbox, Google) settle this the same way: one
billing account and one place to pay, plans sold per product and named after it, personal plans
separate from team plans, and products asking billing what someone is entitled to instead of keeping
the plan themselves.

## Decision

- **planary-org is the only billing system.** Vault stops owning its plan; `vaults.plan` becomes a
  cache of what planary-org reports, the same pattern as Tournament's `rememberPlan`.
- **One billing account, one subscription per product.** An organisation can hold Planary Plus and a
  Vault subscription side by side, as separate Stripe subscriptions on the same Stripe customer (Stripe
  can't mix monthly and yearly prices in one subscription). `subscriptions` stays the Planary Plus
  subscription and the customer; Vault lives in `product_subscriptions` (one row per account and
  product). Keeping them apart means none of Tournament's billing paths change. Webhooks tell them apart
  by `metadata.product`, the price, or the stored subscription id.
- **Personal billing accounts.** A person buying Vault without an organisation gets one created at
  checkout, as ADR 0002 already does for Tournament, with `kind = 'personal'`. The portal shows it as
  "Personal" (Billing and Support only, no Team or Turniere). A person has at most one personal account.
- **Plans are named after their product** on every surface: Vault Free, Vault Plus, Vault Pro. Ids
  stay short inside the product (`free | plus | pro`); the pair `(product, plan)` is the identity.
- **Prices** (Rappen, provider ids from env): Vault Plus 400 a month (`STRIPE_PRICE_VAULT_PLUS_MONTH`)
  or 4000 a year (`STRIPE_PRICE_VAULT_PLUS_YEAR`); Vault Pro 1000 a month (`STRIPE_PRICE_VAULT_PRO_MONTH`)
  or 10000 a year (`STRIPE_PRICE_VAULT_PRO_YEAR`). Monthly by card; yearly by card or by invoice
  (`collection_method=send_invoice`, 30 days), like Plus.
- **Checkout** gains a third shape: `{ product: 'vault', plan: 'plus' | 'pro', period: 'month' | 'year',
  payBy, returnTo }`, through `POST /portal/checkout` (personal) or `POST /portal/orgs/:id/checkout`.
  `returnTo` must be a Vault URL; Vault re-reads its plan when it comes back.
- **Changing plans:** upgrades (Plus → Pro, monthly → yearly) apply right away, prorated by Stripe.
  Downgrades and cancelling apply at the end of the period (`cancel_at_period_end` / a scheduled
  price change).
- **Entitlements endpoint:** `GET /internal/entitlements?user=` answers what one person may use in each
  product: `{ vault: { plan, source, until } }`, `source` being `subscription | override | overdue |
  default`. Personal account first, then organisations the person owns. `/internal/limits` stays as it
  is for Tournament.
- **Overdue** follows ADR 0002: the plan runs 26 days past the due date, then `source: 'overdue'` and
  Vault Free limits.
- **Over the limit** (after a downgrade, cancel or overdue): Vault keeps every file readable,
  downloadable and shareable and refuses new uploads until usage is under the quota. Nothing is
  deleted for being over quota. Version history shrinks to the new plan's window 30 days after the
  change; Vault says so in Settings → Storage before it happens.
- **The portal** shows each product's subscription as its own card under Billing, with one list of
  invoices and one payment method. The Console's plan override becomes per product
  (`POST /console/customers/:id/plan` gains `product`).
- **The organisation plan is shown as "Planary Plus"** (and "Planary Gratis"): it covers Tournament and
  Wishlist, and the name leaves room for more. Ids stay `gratis | plus`.
- **A bundle comes later.** It will be another `product` (`'bundle'`) whose entitlement includes the
  others; `/internal/entitlements` already answers per product, so apps won't change for it.

## Vault's side

- Reads `/internal/entitlements` (service binding or `x-internal-key`) when the vault opens and after
  checkout, caches it in `vaults.plan` with the time it was read, and falls back to the cache when
  planary-org is unreachable.
- Shows plans in the app (`/plans`: cards, monthly/yearly, current plan marked) and starts checkout
  from there; invoices, payment method and cancelling link to portal.planary.ch.
- planary.ch/vault/pricing stays the page for visitors; its buttons go through sign-in to checkout.
- "Shared vault for 6 people" is removed from Vault Pro until it exists.

## Open

- Vault on an organisation (Pro "for families and small teams"): the entitlements endpoint already
  looks at owned organisations; seats come with the shared vault.
