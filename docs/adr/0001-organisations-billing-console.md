# ADR 0001 · Organisations, billing, support, incidents and the Console's data

Status: accepted (built in this repo) · 21.10.2026

## Context

Tournament becomes Planary's main, paid product. Clubs, schools and communities need an
organisation with members, a plan and invoices. Staff need one Console for every app
(admin.planary.ch), and customers need a portal (portal.planary.ch). Until now nothing bills
anyone; accounts live in planary-auth, the Casino has its own staff list, and there is no
place for organisations, support requests, incidents or health checks.

## Decision

One new service, **planary-org**: a Cloudflare Worker (Hono, TypeScript) with a D1 database
`planary-org` and an R2 bucket `planary-org-files`, at `org.planary.ch`. Same pattern as
planary-auth and the casino API.

It owns:

| Area | Tables |
|---|---|
| Organisations | `organisations`, `members` (owner / member), `invitations` |
| Billing | `subscriptions` (plan, provider IDs, state), `event_passes`, `invoices`, `payment_methods`, `billing_contacts`, `provider_events` (webhook idempotency) |
| Support | `requests`, `request_messages` (customer, staff, internal note), `attachments` (R2) |
| Incidents and status | `incidents`, `incident_updates`, `incident_services`, `checks` (health checks), `error_reports`, `deploys` |
| Console | `staff` (Console roles), `customer_notes`, `audit_log` |
| Mirror | `tournaments` (a summary per tournament, written by the Tournament API, never edited here) |

It does **not** own accounts (planary-auth), tournaments (the Tournament API), casino data (casino
API) or wishlist data (Wishlist API). It references accounts by `user_id` and copies the name
and email it last saw, for display.

### Who signs in, and how

- Every request carries the Planary access token from auth.planary.ch (`Authorization: Bearer`).
  planary-org checks it over the `AUTH` service binding (`/api/auth/me`), like the casino API.
- **Console** (`/console/*`): the account must be in `staff`. Roles stay the four the Casino
  has (owner, manager, support, viewer). What each role may do per area is the matrix in
  `src/permissions.ts` (from `CONSOLE.matrix`). The account in `OWNER_EMAIL` claims Owner on first
  sign-in while nobody holds it. Viewers get every read their role allows and no write.
- **Portal** (`/portal/*`): the account must be a member of the organisation in the path. Owners
  see and change billing; members see Übersicht, Turniere, Support and Team (read-only).
- **Services** (`/internal/*`): other Planary workers, with the `x-internal-key` header
  (`INTERNAL_KEY`, the same secret in each worker) or over a service binding.
- **Provider** (`/webhooks/stripe`): Stripe-Signature, checked with `STRIPE_WEBHOOK_SECRET`.
- No impersonation: no endpoint lets staff act as a customer.

### Plans and prices are configuration

> Superseded for plans and prices by [ADR 0002](0002-plans-v2.md): Gratis, Plus and the Turnier-Pass.

`src/plans.ts` holds the plans (Gratis, Event, Verein), their limits and display prices; the
provider price IDs come from env vars (`STRIPE_PRICE_EVENT`, `STRIPE_PRICE_VEREIN`). The prices
are the brief's placeholders (CHF 0 / 49 per tournament / 19 per month billed yearly) and every
surface marks them as placeholders until Planary sets them.

| Plan | Teams per tournament | Running tournaments | Organisers | Logo and colours | Check-in, waiting list, export | Support on match day | Invoice |
|---|---|---|---|---|---|---|---|
| Gratis | 16 | 1 | 1 | no | no | no | no |
| Event (per tournament) | 128 | 1 (that one) | 1 | yes | yes | yes | no |
| Verein (yearly) | 128 | unlimited | 5 | yes | yes | yes | yes |

A person without an organisation runs tournaments on Gratis, as today. An organisation starts on
Gratis. **Event** is a one-time payment that attaches an event pass to one tournament. **Verein** is
a yearly subscription, by card (charged automatically) or by invoice (30 days).

### Payments: Stripe

Planary stores only what it shows: card brand, last four digits, expiry, invoice numbers,
amounts, status, due dates and links to the provider's PDF and payment page. Everything else stays
at Stripe.

- Upgrade: the portal asks `POST /portal/orgs/:id/checkout` and sends the owner to a Stripe Checkout
  Session (Event: `mode=payment`, card and TWINT; Verein: `mode=subscription`).
- Change payment method: `POST /portal/orgs/:id/billing-portal` opens Stripe's customer portal.
- State comes **only** from webhooks (`checkout.session.completed`, `customer.subscription.*`,
  `invoice.*`, `payment_method.attached`, `customer.updated`), stored idempotently by event ID.
  An invoice is *overdue* when it is open and past its due date; the portal banner and the
  Console's "Overdue n days" read that.
- Built and tested against Stripe test mode. Without `STRIPE_SECRET_KEY` the billing endpoints
  answer 503 and everything else keeps working.

### How Tournament, the Console and the portal read it

- **Tournament API** stores `organisation_id` on tournaments. Before it creates a tournament, adds
  a team or starts one, it asks `GET /internal/limits?org=…&tournament=…&user=…` and enforces the answer
  (team cap, running tournaments, features). It reports tournament lifecycle changes with
  `POST /internal/tournament-events` so the Console and the portal can list tournaments per
  organisation without reading the Tournament database (the `tournaments` mirror; it also carries the
  live viewer count the Tournament API reports while a tournament runs). If planary-org can't be reached, Tournament
  falls back to Gratis limits for new tournaments and never blocks a running one.
- **Console** reads `/console/*`. Casino pages keep reading the casino API's `/admin` routes. The
  Console's audit log shows planary-org's log and the casino's log side by side, filtered by area.
- **Portal** reads `/portal/*`.

### Support

One request system. Customers open requests in the portal ("Etwas stimmt nicht"), staff answer
in the Console. Statuses `open` / `waiting` / `done` (portal: Offen / Wartet auf dich / Erledigt).
Messages are `customer`, `staff` or `internal`; **internal notes are never returned by a portal
endpoint**. A request opened with "Das Turnier läuft gerade" is `urgent`. Attachments go to R2 (PNG
or JPG, 10 MB). E-mails both ways go through Resend when `RESEND_API_KEY` is set.

### Incidents and status

- A scheduled handler runs **every minute** (Cloudflare's minimum) and checks each service in
  `src/services.ts` (URL, expected status, timeout). Results go to `checks` (kept 31 days). A
  service is *down* after two failed checks in a row; then planary-org opens an incident for it
  if none is open.
- Error counts and groups come from `POST /internal/errors` (each worker reports its 5xx
  responses, grouped by message and route) and are kept 7 days.
- "Last deploy" comes from GitHub deployments (`GITHUB_TOKEN`, read-only) and is cached in `deploys`.
- An incident update can be marked "show to organisers"; the portal shows it as a banner to
  organisations with a live tournament on an affected service, and on that tournament's page.

### Wishlist privacy

Not here. `GET /console/wishlist` passes through totals from the Wishlist API (`WISHLIST_API`,
`/internal/totals`) and nothing else; until the Wishlist API has that route it answers 503
`not_connected` and the Console says so. There is no endpoint,
in this service or elsewhere, that returns a person's lists, items or reservations.

### Audit

Every Console action that changes something writes `audit_log` (area, staff, action, target, details)
in the same D1 batch as the change. Portal actions that change billing, members or settings are logged
with the member as actor.

## Consequences

- Four workers share `INTERNAL_KEY` (auth, stats, tournament API, org). Rotate it in all four together.
- Console roles live here; the casino API keeps its own staff list for its `/admin` routes. The
  Console's Staff page writes both, so one screen manages one role per person.
- planary-org is on the path for upgrades and limits, not for playing a tournament: a running
  tournament never depends on it.
- Alternatives considered: an "Organisation" area inside planary-auth (mixes identity with billing,
  makes auth deploys riskier) and Payrexx (better Swiss QR-bills, weaker subscriptions API). Stripe
  covers card and TWINT for one-time payments and invoices with a payment page; QR-bills can follow.
