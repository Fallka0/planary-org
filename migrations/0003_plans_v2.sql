-- Plans v2: Gratis and Plus, and the Turnier-Pass as a one-off on one tournament.
--
-- Stored values move like this:
--   verein -> plus      (organisations.plan_override, subscriptions.plan, tournaments.plan)
--   event  -> gratis    (the pass already sits on the tournament in event_passes, now `passes`)
--   an 'event' staff override becomes 'plus': staff gave the organisation more than Gratis on
--   purpose, and Plus is the only tier above it now.
--
-- SQLite can't change a CHECK constraint, and rebuilding `organisations` would fire the
-- ON DELETE CASCADE of every child table. So each constrained column gets a new column with
-- the new CHECK, the values are copied over, the old column is dropped and the new one takes
-- its name. Running this twice fails at the first ADD COLUMN, before anything changes.

-- organisations.plan_override
ALTER TABLE organisations ADD COLUMN plan_override_v2 TEXT CHECK (plan_override_v2 IN ('gratis', 'plus'));
UPDATE organisations SET plan_override_v2 = CASE plan_override WHEN 'verein' THEN 'plus' WHEN 'event' THEN 'plus' WHEN 'gratis' THEN 'gratis' END;
ALTER TABLE organisations DROP COLUMN plan_override;
ALTER TABLE organisations RENAME COLUMN plan_override_v2 TO plan_override;

-- subscriptions.plan
ALTER TABLE subscriptions ADD COLUMN plan_v2 TEXT NOT NULL DEFAULT 'gratis' CHECK (plan_v2 IN ('gratis', 'plus'));
UPDATE subscriptions SET plan_v2 = CASE plan WHEN 'verein' THEN 'plus' ELSE 'gratis' END;
ALTER TABLE subscriptions DROP COLUMN plan;
ALTER TABLE subscriptions RENAME COLUMN plan_v2 TO plan;

-- How Plus is paid, and switching to Gratis at the end of the paid year.
ALTER TABLE subscriptions ADD COLUMN pay_by TEXT CHECK (pay_by IN ('card', 'invoice'));
UPDATE subscriptions SET pay_by = CASE collection_method WHEN 'send_invoice' THEN 'invoice' WHEN 'charge_automatically' THEN 'card' END;
-- The day the organisation is on Gratis (the end of the paid year), while a switch is pending.
ALTER TABLE subscriptions ADD COLUMN cancel_at INTEGER;
-- JSON array of the user ids who keep organising on Gratis.
ALTER TABLE subscriptions ADD COLUMN cancel_keep TEXT;

-- The mirror of Tournament's tournaments.
UPDATE tournaments SET plan = CASE plan WHEN 'verein' THEN 'plus' WHEN 'plus' THEN 'plus' ELSE 'gratis' END;

-- Passes: one per tournament, any number per organisation. The old event passes are passes.
ALTER TABLE event_passes RENAME TO passes;
ALTER TABLE passes ADD COLUMN created_by TEXT;
ALTER TABLE passes ADD COLUMN invoice_id TEXT;
ALTER TABLE passes ADD COLUMN receipt_url TEXT;
DROP INDEX IF EXISTS event_passes_tournament;
DROP INDEX IF EXISTS event_passes_org;
CREATE UNIQUE INDEX passes_tournament ON passes (tournament_id);
CREATE INDEX passes_org ON passes (org_id);

-- Invoices: the lines that make up the amount, and how it was paid.
ALTER TABLE invoices ADD COLUMN lines TEXT NOT NULL DEFAULT '[]';
ALTER TABLE invoices ADD COLUMN paid_with TEXT CHECK (paid_with IN ('card', 'invoice'));

-- One row per started checkout: what was bought, how, and how it ended. The done page reads it.
CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'pass')),
  pay_by TEXT NOT NULL CHECK (pay_by IN ('card', 'invoice')),
  tournament_id TEXT,
  tournament_name TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'paid', 'failed')),
  failure TEXT,
  amount INTEGER NOT NULL,
  session_id TEXT UNIQUE,
  receipt_email TEXT NOT NULL DEFAULT '',
  receipt_url TEXT,
  return_to TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX checkouts_org ON checkouts (org_id, created_at);
