-- planary-org: organisations, billing, support, incidents and the Console's data.
-- Times are epoch milliseconds, money is integer Rappen. See docs/adr/0001.

-- ── Organisations ────────────────────────────────────

CREATE TABLE organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo_key TEXT,
  -- Set by staff to comp or force a plan (Console "Change plan"). NULL = follow billing.
  plan_override TEXT CHECK (plan_override IN ('gratis', 'event', 'verein')),
  plan_override_reason TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Deletion requested by an owner: the daily cleanup removes the organisation after this time.
  delete_at INTEGER
);

CREATE TABLE members (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  -- Last name and e-mail seen from planary-auth, for display.
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  last_active INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  -- SHA-256 of the token in the e-mail link; the token itself is never stored.
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  withdrawn_at INTEGER
);
CREATE INDEX invitations_org ON invitations (org_id);

-- ── Billing ──────────────────────────────────────────

CREATE TABLE subscriptions (
  org_id TEXT PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'gratis' CHECK (plan IN ('gratis', 'event', 'verein')),
  -- Provider state: active, past_due, canceled, incomplete, ... ('none' before any subscription).
  state TEXT NOT NULL DEFAULT 'none',
  provider TEXT,
  customer_id TEXT UNIQUE,
  subscription_id TEXT UNIQUE,
  collection_method TEXT,
  current_period_end INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE event_passes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  tournament_id TEXT NOT NULL,
  checkout_session_id TEXT UNIQUE,
  amount INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX event_passes_tournament ON event_passes (tournament_id);
CREATE INDEX event_passes_org ON event_passes (org_id);

CREATE TABLE invoices (
  -- The provider's invoice id (in_...).
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  number TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  due_at INTEGER,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CHF',
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  description TEXT NOT NULL DEFAULT '',
  pdf_url TEXT,
  pay_url TEXT,
  paid_at INTEGER,
  reminders INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX invoices_org ON invoices (org_id, created_at);

CREATE TABLE payment_methods (
  org_id TEXT PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  provider_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'twint', 'invoice')),
  brand TEXT NOT NULL DEFAULT '',
  last4 TEXT NOT NULL DEFAULT '',
  exp_month INTEGER NOT NULL DEFAULT 0,
  exp_year INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE billing_contacts (
  org_id TEXT PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  -- JSON array of address lines.
  address TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- Webhook idempotency: one row per provider event id.
CREATE TABLE provider_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- ── Support ──────────────────────────────────────────

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  org_id TEXT REFERENCES organisations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  user_email TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL CHECK (topic IN ('tournament', 'billing', 'plan', 'account', 'other')),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'done')),
  urgent INTEGER NOT NULL DEFAULT 0,
  tournament_id TEXT,
  tournament_name TEXT,
  assignee_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_customer_at INTEGER,
  -- Last time any staff member opened the request in the Console.
  staff_seen_at INTEGER,
  done_at INTEGER
);
CREATE INDEX requests_org ON requests (org_id, updated_at);
CREATE INDEX requests_status ON requests (status, updated_at);

CREATE TABLE request_messages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  -- internal = staff-only note, never returned by a portal endpoint and never e-mailed.
  kind TEXT NOT NULL CHECK (kind IN ('customer', 'staff', 'internal')),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX request_messages_request ON request_messages (request_id, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES request_messages(id) ON DELETE CASCADE,
  org_id TEXT,
  r2_key TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_message ON attachments (message_id);

-- ── Incidents and status ─────────────────────────────

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('minor', 'major', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  show_to_organisers INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL
);
CREATE INDEX incidents_started ON incidents (started_at);

CREATE TABLE incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  message TEXT NOT NULL,
  show_to_organisers INTEGER NOT NULL DEFAULT 0,
  by_id TEXT NOT NULL,
  by_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX incident_updates_incident ON incident_updates (incident_id, created_at);

CREATE TABLE incident_services (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  PRIMARY KEY (incident_id, service)
);
CREATE INDEX incident_services_service ON incident_services (service);

-- One health check per service per minute (kept 31 days).
CREATE TABLE checks (
  service TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  ms INTEGER,
  PRIMARY KEY (service, at)
);

-- The health state machine per service.
CREATE TABLE service_state (
  service TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('ok', 'degraded', 'down', 'unknown')),
  down_since INTEGER,
  updated_at INTEGER NOT NULL
);

-- 5xx reports from the workers, aggregated per minute (kept 7 days).
CREATE TABLE error_reports (
  service TEXT NOT NULL,
  message TEXT NOT NULL,
  route TEXT NOT NULL,
  minute INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (service, message, route, minute)
);
CREATE INDEX error_reports_minute ON error_reports (minute);

-- GitHub deployments (or the latest commit on main), cached.
CREATE TABLE deploys (
  service TEXT NOT NULL,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  -- First line of the commit message.
  message TEXT,
  url TEXT,
  PRIMARY KEY (service, id)
);
CREATE INDEX deploys_service_at ON deploys (service, at);

-- ── Console ──────────────────────────────────────────

CREATE TABLE staff (
  -- The account id once signed in; 'pending_…' while the row is an invitation by e-mail.
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'support', 'viewer')),
  last_active INTEGER,
  created_at INTEGER NOT NULL,
  invited_by TEXT
);

CREATE TABLE customer_notes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX customer_notes_org ON customer_notes (org_id, created_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  -- A Console area, 'portal' or 'system'.
  area TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  sentence TEXT NOT NULL,
  target TEXT,
  details TEXT
);
CREATE INDEX audit_log_area ON audit_log (area, id);
CREATE INDEX audit_log_actor ON audit_log (actor_id, id);

-- ── Mirror (written by the Tournament API, never edited here) ──

CREATE TABLE tournaments (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  game TEXT NOT NULL DEFAULT '',
  starts_at INTEGER,
  ends_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('draft', 'open', 'live', 'done')),
  phase TEXT,
  teams INTEGER NOT NULL DEFAULT 0,
  max_teams INTEGER NOT NULL DEFAULT 0,
  waiting INTEGER NOT NULL DEFAULT 0,
  organisation_id TEXT,
  owner_id TEXT NOT NULL,
  -- organisationName from the Tournament API: the organisation's name, or the solo organiser's.
  -- Shown when the organisation isn't known here; a known organisation's current name wins.
  organisation_name TEXT,
  plan TEXT NOT NULL DEFAULT 'gratis',
  viewers INTEGER NOT NULL DEFAULT 0,
  -- JSON [{ id, name, role }]
  organisers TEXT NOT NULL DEFAULT '[]',
  played INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tournaments_org ON tournaments (organisation_id);
CREATE INDEX tournaments_owner ON tournaments (owner_id);
CREATE INDEX tournaments_state ON tournaments (state);

-- Small key/value store for the scheduled handler (e.g. when deploys were last fetched).
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
