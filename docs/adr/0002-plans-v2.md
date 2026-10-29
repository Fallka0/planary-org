# ADR 0002 · Plans v2: Gratis, Plus and the Turnier-Pass

Status: accepted. Replaces the plans and prices part of ADR 0001.

## Decision

- **One subscription per organisation**, base plan plus add-on lines. The base plan is the tier:
  `PlanId = 'gratis' | 'plus'`. It sets the limits every Planary app reads. `pro` is reserved for a
  bigger tier above Plus and isn't built.
- **The Turnier-Pass is not a tier.** It is a one-off entitlement on one tournament (CHF 29, card),
  stored in `passes` (one per tournament, any number per organisation). `/internal/limits` answers
  `source: 'event_pass'` with `passTournamentId` and the pass's limits (Plus's tournament limits
  without match-day support or invoices). A finished tournament keeps everything it had.
- **Plus** is CHF 149 a year, one invoice, renewing automatically with a reminder 30 days ahead. It is
  paid by card (Stripe Checkout, `mode=subscription`) or by invoice (subscription with
  `collection_method=send_invoice`, 30 days, QR-bill); on invoice Plus starts right away.
- **Checkout** is split: `{ plan: 'plus', payBy }` or `{ pass: 'tournament', tournamentId }`. A person
  without an organisation uses `POST /portal/checkout`, which creates the organisation first (they
  own it). Each checkout has a row in `checkouts`; the portal's done page reads it.
- **Overdue** is calm: Plus runs normally until 26 days after the due date of the oldest open
  invoice. After that, new tournaments get Gratis limits until it is paid. Nothing is deleted;
  tournaments created before that date keep Plus.
- **Switching to Gratis** happens at the end of the paid year (`cancel_at_period_end` at Stripe). The
  owner picks who keeps organising (Gratis has 2 seats); the others leave the organisation when the
  subscription ends and keep their Planary accounts.
- **Lines:** the billing response and every invoice carry `SubscriptionLine`s (`base`, `addon`,
  `once`), so add-ons fit without reopening the screens.

| | Gratis | Turnier-Pass | Plus |
|---|---|---|---|
| Price | CHF 0 | CHF 29, once, one tournament | CHF 149 a year |
| Teams per tournament | 16 | 128 | 128 |
| Tournaments at once | 1 | the one it was bought for | unlimited |
| Organisers | 2 | 10 | 10 |
| Check-in | yes | yes | yes |
| Waiting list, logo and colours, export | no | yes | yes |
| Match-day support, pay by invoice | no | no | yes |
| Wishlist lists | 3 | 3 | unlimited |

## Migration (0003)

- `verein` becomes `plus` (organisations' staff overrides, subscriptions, the tournaments mirror).
- `event` becomes `gratis`; the passes it paid for stay on their tournaments (`event_passes` is renamed
  `passes`). A staff override of `event` becomes `plus`: staff gave more than Gratis on purpose.
- CHECK constraints are swapped column by column (add, copy, drop, rename) rather than rebuilding
  `organisations`, which would fire the cascades of its child tables.
- Tournament reports `verein` and `event` until it is updated; both are read as the new ids.

## Open

- TWINT: left room for in the payment choice, not offered (Stripe's recurring TWINT is unclear).
- A solo tournament with a pass stays solo in Tournament; moving it into the new organisation needs
  a Tournament endpoint.
- Pro: a plan page, checkout and id once it is defined.
