# planary-org

Organisations, plans and billing, support requests, incidents and health checks, and the data behind the Planary Console. A Cloudflare Worker (Hono) with D1 and R2 at **org.planary.ch**. Why it is built this way: [docs/adr/0001](docs/adr/0001-organisations-billing-console.md), and for the plans: [docs/adr/0002](docs/adr/0002-plans-v2.md).

| Path | Who | For |
| --- | --- | --- |
| `/console/*` | Staff (a row in `staff`) | planary-admin, the Console |
| `/portal/*` | Members of an organisation | planary-portal |
| `/internal/*` | Other Planary workers (`x-internal-key`) | Tournament events, plan limits, error reports, banners |
| `/webhooks/stripe` | Stripe (signed) | Subscriptions, Turnier-Pässe, checkouts, invoices, payment methods |
| `/files/:id` | Signed link plus a signed-in member or staff member | Support images and logos |

The typed contract is `src/contract.ts`. planary-admin (`src/lib/org-contract.ts`) and planary-portal (`src/lib/org-contract.ts`) keep copies; change all three together.

Every write from the Console or the portal adds an audit entry in the same batch.

## Develop

```bash
npm install
npm run db:migrate:local
npm run dev          # http://localhost:8790
npm test             # Workers runtime with a local D1 and R2 (vitest + @cloudflare/vitest-plugin)
npm run typecheck
```

Sign-in goes through the `AUTH` service binding to planary-auth. Locally there is no planary-auth to bind to. To click through the screens, use the Console and portal fixture modes (`NEXT_PUBLIC_CONSOLE_DATA=fixtures`, `NEXT_PUBLIC_PORTAL_DATA=fixtures`). The tests replace AUTH with a fake.

## Set up (once)

1. **Resources.** `wrangler d1 create planary-org` and `wrangler r2 bucket create planary-org-files`, then `npm run db:migrate`.
2. **Variables** in `wrangler.jsonc`:
   - `OWNER_EMAIL` (set to the address planary-stats already uses as admin) claims the Console's Owner role on its first sign-in, once, while nobody holds it. Change it if another account should own the Console; empty claims nothing.
   - Check `CONSOLE_ORIGINS` and `PORTAL_ORIGINS` (allowed browser origins), `PORTAL_URL`, `CONSOLE_URL`, `MAIL_FROM` and `STAFF_INBOX`.
3. **Secrets** (`wrangler secret put NAME`). Each one is optional: without it, its integration switches off and the related screens say so.
   - `INTERNAL_KEY`: a long random string, shared with the Tournament API, planary-auth and planary-stats.
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PLUS` (Plus: CHF 149, recurring yearly) and `STRIPE_PRICE_PASS` (Turnier-Pass: CHF 29, one-off). Vault (ADR 0003): `STRIPE_PRICE_VAULT_PLUS_MONTH`, `STRIPE_PRICE_VAULT_PLUS_YEAR`, `STRIPE_PRICE_VAULT_PRO_MONTH`, `STRIPE_PRICE_VAULT_PRO_YEAR`.
   - `RESEND_API_KEY`: e-mails (invitations, support replies, staff notices). `planary.ch` must be verified in Resend.
   - `GITHUB_TOKEN`: read-only, for the deploys shown on the status page.
4. **Stripe** (start in test mode):
   - Create two products in CHF: **Plus** with a yearly price of 149.00, and **Turnier-Pass** with a one-off price of 29.00. Their price ids go into `STRIPE_PRICE_PLUS` and `STRIPE_PRICE_PASS`. For Vault, two more products: **Vault Plus** (4.00 monthly and 40.00 yearly) and **Vault Pro** (10.00 monthly and 100.00 yearly); their four price ids go into the `STRIPE_PRICE_VAULT_*` secrets. Add `customer.subscription.*` for them to the webhook's events if it lists events one by one.
   - Add a webhook to `https://org.planary.ch/webhooks/stripe` with `checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`, `customer.subscription.*`, `invoice.*`, `payment_method.attached` and `customer.updated`.
   - Turn on card payments. Plus also goes by invoice (QR-bill by e-mail, 30 days): turn on invoices and the Swiss QR-bill in the invoice settings. TWINT is left room for and not offered yet.
   - Enable the customer portal (change the payment method). Cancelling happens in the Planary portal, not at Stripe.
5. **DNS.** The `org.planary.ch` custom domain is created by the first `npm run deploy`.
6. **Service bindings.** planary-auth must have `/api/internal/stats` (account totals for the Console). planary-stats must have `/api/internal/visitors`. planary-wishlist must have `/api/internal/totals` and `/api/internal/orgs/:id/lists` (an organisation's wishlists for the portal). All use `INTERNAL_KEY`, and planary-wishlist needs the secret too.
7. **Migrations** after an update: `npm run db:migrate`. 0002 adds the services an organisation uses (existing organisations keep Tournament). 0003 moves to plans v2: `verein` becomes `plus`, `event` becomes `gratis` with the pass staying on its tournament (see ADR 0002). Back up first: `wrangler d1 export planary-org --remote --output backup.sql`.

Organisations choose their services (Tournament, Wishlist) in the portal. One plan covers all of them; `src/plans.ts` holds the limits per service.

Plans are Gratis (CHF 0) and Plus (CHF 149 a year, one invoice); the Turnier-Pass (CHF 29, once) lifts one tournament to Plus's tournament limits. They live in `src/plans.ts`.
