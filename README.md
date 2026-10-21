# planary-org

Organisations, plans and billing, support requests, incidents and health checks, and the data behind the Planary Console. A Cloudflare Worker (Hono) with D1 and R2 at **org.planary.ch**. Why it is built this way: [docs/adr/0001](docs/adr/0001-organisations-billing-console.md).

| Path | Who | For |
| --- | --- | --- |
| `/console/*` | Staff (a row in `staff`) | planary-admin, the Console |
| `/portal/*` | Members of an organisation | planary-portal |
| `/internal/*` | Other Planary workers (`x-internal-key`) | Tournament events, plan limits, error reports, banners |
| `/webhooks/stripe` | Stripe (signed) | Subscriptions, event passes, invoices, payment methods |
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
   - Set `OWNER_EMAIL` to your own Planary account's e-mail. That account claims the Console's Owner role on its first sign-in, once, while nobody holds it. It is empty on purpose; empty claims nothing.
   - Check `CONSOLE_ORIGINS` and `PORTAL_ORIGINS` (allowed browser origins), `PORTAL_URL`, `CONSOLE_URL`, `MAIL_FROM` and `STAFF_INBOX`.
3. **Secrets** (`wrangler secret put NAME`). Each one is optional: without it, its integration switches off and the related screens say so.
   - `INTERNAL_KEY`: a long random string, shared with the Tournament API, planary-auth and planary-stats.
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_EVENT` (one-time, CHF), `STRIPE_PRICE_VEREIN` (monthly, billed yearly).
   - `RESEND_API_KEY`: e-mails (invitations, support replies, staff notices). `planary.ch` must be verified in Resend.
   - `GITHUB_TOKEN`: read-only, for the deploys shown on the status page.
4. **Stripe** (start in test mode):
   - Add a webhook to `https://org.planary.ch/webhooks/stripe` with `checkout.session.completed`, `customer.subscription.*`, `invoice.*`, `payment_method.attached` and `customer.updated`.
   - Turn on TWINT and card payments. Event passes take card or TWINT. Verein takes a card subscription or an invoice by e-mail; TWINT can't pay subscriptions.
   - Enable the customer portal (payment method, cancel).
5. **DNS.** The `org.planary.ch` custom domain is created by the first `npm run deploy`.
6. **Service bindings.** planary-auth must have `/api/internal/stats` (account totals for the Console). planary-stats must have `/api/internal/visitors`. Both use `INTERNAL_KEY`.

Prices in `src/plans.ts` are the brief's placeholders, `placeholder: true`. Every surface shows them as placeholders until Planary sets them.
