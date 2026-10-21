/*
 * The planary-org API contract: request and response shapes for the Console (/console),
 * the customer portal (/portal) and other Planary services (/internal).
 *
 * This file has no runtime code. The Console (planary-admin) and the portal (planary-portal)
 * keep a copy in src/lib/org-contract.ts; change it here first, then copy it over.
 *
 * Conventions: times are epoch milliseconds, money is integer Rappen (CHF cents), ids are
 * strings. Errors are { error: string, code?: string, requestId: string } with a 4xx/5xx status.
 */

// ── shared ───────────────────────────────────────────

export type PlanId = 'gratis' | 'event' | 'verein';
export type StaffRole = 'owner' | 'manager' | 'support' | 'viewer';
export type MemberRole = 'owner' | 'member';
export type Access = 'edit' | 'read' | 'none';
/** The rows of the Console's permission matrix. */
export type Area =
  | 'overview'
  | 'incidents'
  | 'customers'
  | 'notes'
  | 'support'
  | 'tournament'
  | 'casino'
  | 'casino_moderation'
  | 'wishlist'
  | 'audit'
  | 'staff';
export type ServiceId = 'auth' | 'tournament' | 'casino' | 'wishlist' | 'web';
export type ServiceState = 'ok' | 'degraded' | 'down' | 'unknown';
export type RequestStatus = 'open' | 'waiting' | 'done';
export type RequestTopic = 'tournament' | 'billing' | 'plan' | 'account' | 'other';
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type Severity = 'minor' | 'major' | 'critical';
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
export type TournamentState = 'draft' | 'open' | 'live' | 'done';

export interface ApiError { error: string; code?: string; requestId: string }

export interface Person { id: string; name: string; email: string }

export interface PlanLimits {
  maxTeams: number;
  /** null = unlimited */
  maxRunning: number | null;
  maxOrganisers: number;
  branding: boolean;
  checkIn: boolean;
  waitingList: boolean;
  export: boolean;
  matchDaySupport: boolean;
  invoice: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Rappen. Event: per tournament. Verein: per month, billed yearly. */
  price: number;
  period: 'forever' | 'tournament' | 'month_yearly';
  /** True until Planary sets real prices: every surface shows a "Platzhalter" chip. */
  placeholder: boolean;
  limits: PlanLimits;
}

export interface Invoice {
  id: string;
  number: string;
  createdAt: number;
  dueAt: number | null;
  /** Rappen */
  amount: number;
  currency: 'CHF';
  status: InvoiceStatus;
  /** What it covers, e.g. "Plan Verein, 3.2.2026 bis 2.2.2027". */
  description: string;
  /** Whole days past due while open, else 0. */
  overdueDays: number;
  pdfUrl: string | null;
  payUrl: string | null;
}

export interface PaymentMethod { brand: string; last4: string; expMonth: number; expYear: number; kind: 'card' | 'twint' | 'invoice' }

export interface BillingContact { email: string; phone: string; address: string[] }

export interface TournamentSummary {
  id: string;
  slug: string;
  name: string;
  game: string;
  startsAt: number | null;
  endsAt: number | null;
  state: TournamentState;
  /** e.g. "Halbfinals" while live */
  phase: string | null;
  teams: number;
  maxTeams: number;
  waiting: number;
  organisationId: string | null;
  /** For display: the organisation's name, or the solo organiser's name. */
  organisationName: string | null;
  ownerId: string;
  plan: PlanId;
  viewers: number;
  updatedAt: number;
}

// ── console ──────────────────────────────────────────

export interface ConsoleMe extends Person {
  role: StaffRole;
  access: Record<Area, Access>;
}

export interface ServiceStatus {
  id: ServiceId;
  name: string;
  host: string;
  state: ServiceState;
  /** First failed check of the current outage. */
  downSince: number | null;
  /** Median response time over the last hour, ms. */
  medianMs: number | null;
  /** Last hour, one value per minute (ms, null for a failed check). */
  spark: (number | null)[];
  /** Share of successful checks in 30 days, 0..1 */
  uptime30: number | null;
  errors24h: number;
  deploy: { at: number; commit: string; author: string; message: string | null; url: string | null } | null;
}

export interface IncidentSummary {
  id: string;
  /** INC-0042 */
  code: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  services: ServiceId[];
  startedAt: number;
  resolvedAt: number | null;
  showToOrganisers: boolean;
}

export interface IncidentUpdate {
  id: string;
  status: IncidentStatus;
  message: string;
  showToOrganisers: boolean;
  by: string;
  at: number;
}

export interface ErrorGroup { message: string; route: string; count: number; lastAt: number }

export interface IncidentDetail extends IncidentSummary {
  updates: IncidentUpdate[];
  /** Live tournaments on the affected services. */
  liveEvents: TournamentSummary[];
  /** Errors per minute on the affected services since 30 minutes before the start. */
  errorsPerMinute: { at: number; n: number }[];
  deploys: { service: ServiceId; at: number; commit: string; author: string; message: string | null; running: boolean; suspect: boolean }[];
}

export interface StatusResponse {
  services: ServiceStatus[];
  open: IncidentSummary[];
  recent: IncidentSummary[];
  /** Per down service, the error groups of the last hour. */
  errorGroups: Partial<Record<ServiceId, ErrorGroup[]>>;
}

export interface RequestSummary {
  id: string;
  /** REQ-1184 */
  code: string;
  subject: string;
  topic: RequestTopic;
  status: RequestStatus;
  urgent: boolean;
  organisation: { id: string; name: string } | null;
  from: Person;
  tournament: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  createdAt: number;
  updatedAt: number;
  /** Console: the customer wrote last and staff haven't opened it since. */
  unread: boolean;
}

export interface Attachment { id: string; name: string; size: number; type: string; url: string }

export interface RequestMessage {
  id: string;
  kind: 'customer' | 'staff' | 'internal';
  author: { id: string; name: string };
  body: string;
  attachments: Attachment[];
  at: number;
}

export interface RequestDetail extends RequestSummary { plan: PlanId | null; messages: RequestMessage[] }

export interface OverviewResponse {
  days: 7 | 30 | 90;
  accounts: number;
  accountsNew7: number;
  activeToday: number;
  organisations: number;
  paidOrganisations: number;
  openRequests: number;
  unassignedRequests: number;
  /** One value per day, oldest first. */
  signups: number[];
  active: number[];
  /** Sign-ups in the period before this one, for the comparison line. */
  signupsPrev: number;
  requests: RequestSummary[];
  apps: { app: 'tournament' | 'casino' | 'wishlist'; today: number; d7: number; d30: number; spark: number[]; state: ServiceState }[];
  services: Pick<ServiceStatus, 'id' | 'name' | 'state' | 'medianMs' | 'uptime30'>[];
}

export interface CustomerRow {
  id: string;
  name: string;
  initials: string;
  plan: PlanId;
  members: number;
  tournamentsThisYear: number;
  /** Rappen per year */
  revenueYear: number;
  billing: 'paid' | 'overdue' | 'free' | 'card_expires';
  overdueDays: number;
  since: number;
}

export interface CustomerDetail extends CustomerRow {
  slug: string;
  renewsAt: number | null;
  paymentMethod: PaymentMethod | null;
  provider: 'stripe' | null;
  contact: BillingContact | null;
  invoices: Invoice[];
  memberList: (Person & { role: MemberRole; lastActive: number | null })[];
  tournaments: TournamentSummary[];
  notes: { id: string; by: string; body: string; at: number }[];
  requests: RequestSummary[];
}

export interface OrganiserRow {
  /** Organisation id, or the account id of a solo organiser. */
  id: string;
  kind: 'organisation' | 'person';
  name: string;
  initials: string;
  plan: PlanId;
  organisers: number;
  tournaments: number;
  latest: { name: string; at: number | null; state: TournamentState } | null;
  status: 'active' | 'overdue' | 'free';
}

export interface AuditEntry {
  id: string;
  at: number;
  area: Area | 'portal' | 'system';
  actor: { id: string; name: string } | null;
  /** Machine name, e.g. incident.update */
  action: string;
  /** Human sentence, e.g. "Posted an incident update" */
  sentence: string;
  target: string | null;
  details: string | null;
}

export interface StaffRow extends Person { role: StaffRole; lastActive: number | null; since: number }

export interface WishlistTotals {
  lists: number;
  listsNewWeek: number;
  items: number;
  sharedLists: number;
  reservationsMonth: number;
  /** New lists per week, oldest first, 12 weeks. */
  newPerWeek: number[];
  shops: [domain: string, share: number][];
}

/** /console endpoints. `Q` query, `B` body, `R` response. */
export interface ConsoleApi {
  'GET /console/me': { R: ConsoleMe };
  'GET /console/overview': { Q: { days: '7' | '30' | '90' }; R: OverviewResponse };
  'GET /console/status': { R: StatusResponse };
  'GET /console/incidents/:id': { R: IncidentDetail };
  'POST /console/incidents': { B: { title: string; severity: Severity; services: ServiceId[]; message: string }; R: { id: string } };
  'POST /console/incidents/:id/updates': { B: { status: IncidentStatus; message: string; showToOrganisers: boolean }; R: { ok: true } };
  'POST /console/incidents/:id/notify': { B: { message: string }; R: { organisations: number } };
  'GET /console/customers': { Q: { plan?: PlanId; overdue?: '1'; q?: string }; R: { customers: CustomerRow[] } };
  'GET /console/customers.csv': { R: string };
  'GET /console/customers/:id': { R: CustomerDetail };
  'POST /console/customers/:id/notes': { B: { body: string }; R: { ok: true } };
  'POST /console/customers/:id/reminder': { B: { invoiceId: string }; R: { ok: true } };
  'POST /console/customers/:id/plan': { B: { plan: PlanId; reason: string }; R: { ok: true } };
  'GET /console/support': { Q: { status?: RequestStatus; who?: 'all' | 'mine' | 'unassigned' }; R: { requests: RequestSummary[]; counts: Record<RequestStatus, number>; /** Staff who can be assigned (support edit). */ assignable: { id: string; name: string }[] } };
  /** Also marks the request as seen by staff (clears `unread`). */
  'GET /console/support/:id': { R: RequestDetail };
  'POST /console/support/:id/messages': { B: { kind: 'staff' | 'internal'; body: string; setStatus?: RequestStatus }; R: { ok: true } };
  'POST /console/support/:id': { B: { status?: RequestStatus; assigneeId?: string | null }; R: { ok: true } };
  'GET /console/tournaments': { Q: { state?: TournamentState; plan?: PlanId }; R: { tournaments: TournamentSummary[] } };
  'GET /console/organisers': { R: { organisers: OrganiserRow[] } };
  'GET /console/wishlist': { R: WishlistTotals };
  'GET /console/audit': { Q: { area?: string; staff?: string; before?: string }; R: { entries: AuditEntry[]; more: boolean } };
  'GET /console/staff': { R: { staff: StaffRow[] } };
  'POST /console/staff': { B: { email: string; role: StaffRole }; R: { ok: true } };
  'POST /console/staff/:id': { B: { role: StaffRole }; R: { ok: true } };
  'POST /console/staff/:id/remove': { B: Record<string, never>; R: { ok: true } };
  'GET /console/search': { Q: { q: string }; R: { results: { kind: 'organisation' | 'tournament' | 'request' | 'staff'; id: string; label: string; sub: string; href: string }[] } };
}

// ── portal ───────────────────────────────────────────

export interface PortalOrgSummary { id: string; name: string; initials: string; role: MemberRole; plan: PlanId }

export interface PortalBanner {
  kind: 'incident' | 'overdue';
  /** German, ready to show. */
  text: string;
  /** Incident id or invoice id. */
  ref: string;
  tournamentIds: string[];
}

export interface PortalOrg {
  id: string;
  name: string;
  initials: string;
  slug: string;
  logoUrl: string | null;
  role: MemberRole;
  plan: Plan;
  /** Verein: next renewal. */
  renewsAt: number | null;
  createdAt: number;
  contact: BillingContact;
  usage: { tournamentsThisYear: number; largestTournament: number; organisers: number };
  onboarding: { logo: boolean; team: boolean; tournament: boolean };
  banners: PortalBanner[];
  counts: { openRequests: number; overdueInvoices: number };
}

export interface PortalMember extends Person { role: MemberRole; lastActive: number | null; me: boolean }

export interface PortalInvite { id: string; email: string; role: MemberRole; sentAt: number }

export interface PortalRequestMessage extends Omit<RequestMessage, 'kind'> { kind: 'customer' | 'staff' }

export interface PortalRequest extends Omit<RequestSummary, 'unread' | 'assignee'> {
  /** German line, e.g. "Planary hat um 20:06 geantwortet" */
  lastEvent: string;
}

export interface PortalRequestDetail extends PortalRequest { messages: PortalRequestMessage[] }

export interface PortalApi {
  'GET /portal/me': { R: { me: Person; orgs: PortalOrgSummary[] } };
  'POST /portal/orgs': { B: { name: string; slug: string }; R: { id: string } };
  'GET /portal/orgs/:id': { R: PortalOrg };
  'POST /portal/orgs/:id': { B: { name?: string; slug?: string; contact?: BillingContact }; R: { ok: true } };
  'POST /portal/orgs/:id/logo': { B: FormData; R: { logoUrl: string } };
  'POST /portal/orgs/:id/delete': { B: { confirm: string }; R: { deleteAt: number } };
  'GET /portal/orgs/:id/tournaments': { R: { tournaments: TournamentSummary[] } };
  'GET /portal/orgs/:id/tournaments/:tid': { R: TournamentSummary & { organisers: { id: string; name: string; role: string }[]; played: number; matches: number; banners: PortalBanner[] } };
  'GET /portal/orgs/:id/billing': { R: { plans: Plan[]; current: PlanId; invoices: Invoice[]; paymentMethod: PaymentMethod | null; contact: BillingContact; renewsAt: number | null } };
  'POST /portal/orgs/:id/checkout': { B: { plan: 'event' | 'verein'; tournamentId?: string; payBy?: 'card' | 'invoice' }; R: { url: string } };
  'POST /portal/orgs/:id/billing-portal': { R: { url: string } };
  'GET /portal/orgs/:id/members': { R: { members: PortalMember[]; invites: PortalInvite[]; seats: number } };
  'POST /portal/orgs/:id/invites': { B: { email: string; role: MemberRole }; R: { ok: true } };
  'POST /portal/orgs/:id/invites/:iid/resend': { R: { ok: true } };
  'POST /portal/orgs/:id/invites/:iid/withdraw': { R: { ok: true } };
  'POST /portal/invites/:token/accept': { R: { orgId: string } };
  'POST /portal/orgs/:id/members/:uid': { B: { role: MemberRole }; R: { ok: true } };
  'POST /portal/orgs/:id/members/:uid/remove': { R: { ok: true } };
  'GET /portal/orgs/:id/requests': { R: { requests: PortalRequest[] } };
  'GET /portal/orgs/:id/requests/:rid': { R: PortalRequestDetail };
  'POST /portal/orgs/:id/requests': { B: FormData; R: { id: string } };
  'POST /portal/orgs/:id/requests/:rid/messages': { B: { body: string }; R: { ok: true } };
  'POST /portal/orgs/:id/requests/:rid/done': { R: { ok: true } };
}

// ── internal (other Planary workers) ─────────────────

export interface LimitsResponse {
  plan: PlanId;
  limits: PlanLimits;
  /** Running tournaments the owner (organisation or person) has now. */
  running: number;
  source: 'organisation' | 'event_pass' | 'person';
}

export interface TournamentEvent extends TournamentSummary {
  kind: 'created' | 'updated' | 'deleted';
  /** Optional, for the portal's tournament page: who runs it, and how many matches are played. */
  organisers?: { id: string; name: string; role: string }[];
  played?: number;
  matches?: number;
}

export interface InternalApi {
  'GET /internal/limits': { Q: { org?: string; tournament?: string; user: string }; R: LimitsResponse };
  'GET /internal/orgs/:id/membership': { Q: { user: string }; R: { role: MemberRole | null } };
  'POST /internal/tournament-events': { B: TournamentEvent; R: { ok: true } };
  'POST /internal/errors': { B: { service: ServiceId; message: string; route: string; count?: number }; R: { ok: true } };
  'GET /internal/banners': { Q: { tournament: string }; R: { banners: PortalBanner[] } };
}
