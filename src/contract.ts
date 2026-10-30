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

/** The organisation's tier. 'pro' is reserved for a bigger tier above Plus, not built yet. */
export type PlanId = 'gratis' | 'plus';
/** One-off purchases, named after what they unlock. The pass is an entitlement on one tournament. */
export type PassId = 'tournament_pass';
/** How the organisation pays its subscription. TWINT is left room for, not offered yet. */
export type PayBy = 'card' | 'invoice';
/** Products sold as their own subscription next to Planary Plus (ADR 0003). */
export type ProductId = 'vault';
/** Vault's tiers, per person: Vault Free, Vault Plus, Vault Pro. */
export type VaultPlanId = 'free' | 'plus' | 'pro';
export type BillingPeriod = 'month' | 'year';
/** 'personal': an organisation of one, created when a person buys a product on their own. */
export type OrgKind = 'team' | 'personal';
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
/** The Planary services an organisation can switch on and manage in the portal. */
export type OrgService = 'tournament' | 'wishlist';
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

/** What a plan allows in Wishlist, for the organisation's own wishlists. */
export interface WishlistLimits {
  /** Wishlists the organisation may own. null = unlimited */
  maxLists: number | null;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Rappen. Plus: per year, one invoice. */
  price: number;
  period: 'forever' | 'year';
  /** Tournament's limits (kept under this name for the Tournament API). */
  limits: PlanLimits;
  wishlist: WishlistLimits;
}

/** The Turnier-Pass: CHF 29 once, for one tournament, gives it Plus's tournament limits. */
export interface Pass {
  id: PassId;
  /** "Turnier-Pass" (German surfaces); `nameEn` "Tournament Pass" for English ones. */
  name: string;
  nameEn: string;
  /** Rappen, once per tournament. */
  price: number;
  period: 'tournament';
  limits: PlanLimits;
}

/** A pass bought for one tournament. Passes stack: one per tournament, any number. */
export interface PassEntitlement {
  id: string;
  tournamentId: string;
  tournamentName: string;
  boughtAt: number;
  /** Rappen */
  amount: number;
  /** 'done' once the tournament is finished: it keeps everything, read-only beyond Gratis limits. */
  state: 'active' | 'done';
  teams: number;
  invoiceId: string | null;
  receiptUrl: string | null;
}

/** A Vault tier and its prices. */
export interface VaultPlan {
  id: VaultPlanId;
  /** "Vault Free", "Vault Plus", "Vault Pro" */
  name: string;
  /** Rappen per month, and per year (one invoice). 0 for Vault Free. */
  monthly: number;
  yearly: number;
  quotaGb: number;
}

/** An account's Vault subscription, for the portal's billing page. */
export interface VaultBilling {
  plans: VaultPlan[];
  /** The plan in effect, including a staff override. */
  current: VaultPlanId;
  period: BillingPeriod | null;
  payBy: PayBy | null;
  renewsAt: number | null;
  /** Cancelling: the day it falls back to Vault Free. */
  cancelAt: number | null;
  /** A downgrade that takes effect at `renewsAt`. */
  pending: { plan: Exclude<VaultPlanId, 'free'>; period: BillingPeriod } | null;
}

/** One line of the subscription or an invoice: the base plan, an add-on, or a one-off. */
export interface SubscriptionLine {
  kind: 'base' | 'addon' | 'once';
  /** "Planary Plus", "Vault Plus", "Turnier-Pass · Planary Winter Cup" */
  name: string;
  period: 'month' | 'year' | 'once';
  /** Rappen */
  amount: number;
  tournamentId: string | null;
}

/** free: Gratis without anything open. card_expires: the card expires before the renewal. */
export type BillingState = 'free' | 'active' | 'overdue' | 'card_expires' | 'canceling';

/** The checkout body: a plan (Plus, by card or invoice) or a pass (one tournament, by card). */
export type CheckoutBody =
  | { plan: 'plus'; payBy: PayBy; returnTo?: string }
  | { pass: 'tournament'; tournamentId: string; returnTo?: string }
  /** Vault: monthly by card; yearly by card or invoice. */
  | { product: 'vault'; plan: 'plus' | 'pro'; period: BillingPeriod; payBy: PayBy; returnTo?: string };

export interface CheckoutResult {
  /** Card: the provider's checkout page. Invoice (Plus): the portal's done page, nothing charged today. */
  url: string;
  checkoutId: string;
}

export interface CheckoutStatus {
  id: string;
  orgId: string;
  kind: 'plan' | 'pass';
  /** Set when a product plan was bought (Vault), with its plan and period. */
  product: ProductId | null;
  productPlan: 'plus' | 'pro' | null;
  period: BillingPeriod | null;
  state: 'pending' | 'paid' | 'failed';
  /** Why a card payment failed, in German, when the provider says so. */
  failure: string | null;
  /** Rappen charged today (0 for Plus on invoice). */
  amount: number;
  payBy: PayBy;
  tournamentId: string | null;
  tournamentName: string | null;
  /** Where the receipt went. */
  receiptEmail: string;
  receiptUrl: string | null;
  /** The page to go back to, e.g. the tournament being edited. Only planary.ch hosts. */
  returnTo: string | null;
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
  /** What it covers, e.g. "Plus, 3.2.2026 bis 2.2.2027". */
  description: string;
  /** The lines that make up `amount`. */
  lines: SubscriptionLine[];
  /** How it was paid, once paid. */
  paidWith: PayBy | null;
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
  services: OrgService[];
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
  /** Planary Plus by default; `product: 'vault'` sets the Vault plan instead (`plan` a VaultPlanId). */
  'POST /console/customers/:id/plan': { B: { plan: PlanId; reason: string; product?: undefined } | { product: 'vault'; plan: VaultPlanId; reason: string }; R: { ok: true } };
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

export interface PortalOrgSummary { id: string; name: string; initials: string; role: MemberRole; plan: PlanId; services: OrgService[]; kind: OrgKind }

export interface PortalBanner {
  kind: 'incident' | 'overdue';
  /** German, ready to show, in bold: "Rechnung 2026-0142 über CHF 228.00 ist seit 12 Tagen überfällig." */
  title: string;
  /** German, the sentences after the title. */
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
  services: OrgService[];
  /** 'personal': a person's own billing account (Vault); the portal shows Abrechnung and Support only. */
  kind: OrgKind;
  /** Plus: next renewal. */
  renewsAt: number | null;
  billingState: BillingState;
  /** Gratis organisations: passes on tournaments that aren't finished. */
  activePasses: number;
  createdAt: number;
  contact: BillingContact;
  usage: { tournamentsThisYear: number; largestTournament: number; organisers: number };
  /** Steps for the services the organisation uses; `tournament` is false while Tournament is off. */
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
  /** Who wrote last (internal notes don't count). */
  lastBy: 'customer' | 'staff';
}

export interface PortalRequestDetail extends PortalRequest { messages: PortalRequestMessage[] }

export interface PortalTournamentDetail extends TournamentSummary {
  createdAt: number;
  registration: { opensAt: number | null; closesAt: number | null };
  /** e.g. "Gurtenpark, Bern" */
  venue: string | null;
  /** e.g. "Gruppen + K.-o. · Best of 3" */
  format: string | null;
  organisers: { id: string; name: string; role: string }[];
  played: number;
  matches: number;
  banners: PortalBanner[];
}

/** One of the organisation's wishlists. No reservations, by design: the owners never learn what's reserved. */
export interface OrgWishlist {
  id: number;
  title: string;
  items: number;
  /** Rappen, sum of the items' prices in CHF. */
  value: number;
  shared: boolean;
  createdBy: string;
  updatedAt: number;
  /** Opens the list in Wishlist. */
  url: string;
}

export interface PortalWishlists {
  /** False while Wishlist can't be reached; `lists` is then empty. */
  connected: boolean;
  lists: OrgWishlist[];
  /** From the plan. null = unlimited */
  maxLists: number | null;
  /** Starts a new wishlist for the organisation in Wishlist. */
  newUrl: string;
}

export interface PortalApi {
  'GET /portal/me': { R: { me: Person; orgs: PortalOrgSummary[] } };
  'POST /portal/orgs': { B: { name: string; slug: string; services: OrgService[] }; R: { id: string } };
  'GET /portal/orgs/:id': { R: PortalOrg };
  /** `services`: at least one. Turning one off hides it in the portal; its data stays. */
  'POST /portal/orgs/:id': { B: { name?: string; slug?: string; contact?: BillingContact; removeLogo?: true; services?: OrgService[] }; R: { ok: true } };
  'POST /portal/orgs/:id/logo': { B: FormData; R: { logoUrl: string } };
  'POST /portal/orgs/:id/delete': { B: { confirm: string }; R: { deleteAt: number } };
  'GET /portal/orgs/:id/tournaments': { R: { tournaments: TournamentSummary[] } };
  'GET /portal/orgs/:id/tournaments/:tid': { R: PortalTournamentDetail };
  /** 404 while Wishlist is off for the organisation. */
  'GET /portal/orgs/:id/wishlists': { R: PortalWishlists };
  /** Owners only. */
  'GET /portal/orgs/:id/billing': { R: Billing };
  /** Owners only. Pass: the tournament must belong to the organisation (or its owner, who joins it). */
  'POST /portal/orgs/:id/checkout': { B: CheckoutBody; R: CheckoutResult };
  /** A person without an organisation: creates it (they become owner), then checks out. For Vault, `org` may be left out: the person's personal account is used (created on first use). */
  'POST /portal/checkout': { B: CheckoutBody & { org?: { name: string; email: string } }; R: CheckoutResult & { orgId: string } };
  'GET /portal/checkout/:cid': { R: CheckoutStatus };
  /** Plus: switch between card and invoice for the next renewal. */
  'POST /portal/orgs/:id/pay-by': { B: { payBy: PayBy }; R: { ok: true } };
  /** The provider's hosted page for one open invoice. */
  'POST /portal/orgs/:id/invoices/:iid/pay': { R: { url: string } };
  /** Switch to Gratis at the end of the paid year. `keep`: the members who keep organising (Gratis seats). */
  'POST /portal/orgs/:id/cancel': { B: { keep: string[] }; R: { cancelAt: number } };
  'POST /portal/orgs/:id/cancel/undo': { R: { ok: true } };
  'POST /portal/orgs/:id/billing-portal': { R: { url: string } };
  /** Owners only. Upgrades apply now (prorated), downgrades at the end of the period; the current plan and period undo a pending downgrade. */
  'POST /portal/orgs/:id/vault/change': { B: { plan: 'plus' | 'pro'; period: BillingPeriod }; R: { ok: true; at: number | null } };
  /** Owners only. Vault Free at the end of the period, or undo that. */
  'POST /portal/orgs/:id/vault/cancel': { R: { cancelAt: number } };
  'POST /portal/orgs/:id/vault/cancel/undo': { R: { ok: true } };
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
  /** JSON `{ body }`, or form data with `body` and up to 3 PNG/JPG `files` (10 MB each). */
  'POST /portal/orgs/:id/requests/:rid/messages': { B: { body: string } | FormData; R: { ok: true } };
  'POST /portal/orgs/:id/requests/:rid/done': { R: { ok: true } };
}

// ── internal (other Planary workers) ─────────────────

export interface Billing {
  plans: Plan[];
  pass: Pass;
  current: PlanId;
  state: BillingState;
  /** Plus and its add-ons; passes bought this year appear as 'once' lines. */
  lines: SubscriptionLine[];
  passes: PassEntitlement[];
  invoices: Invoice[];
  paymentMethod: PaymentMethod | null;
  payBy: PayBy | null;
  contact: BillingContact;
  renewsAt: number | null;
  /** 30 days before renewal. */
  reminderAt: number | null;
  /** Overdue: Plus runs normally until then; after it, new tournaments get Gratis limits. */
  graceUntil: number | null;
  /** Canceling: the day the organisation is on Gratis. */
  cancelAt: number | null;
  usage: { largestTournament: number; running: number; organisers: number; wishlists: number };
  /** The account's Vault subscription; Vault Free when it has none. */
  vault: VaultBilling;
}

/** What one person may use in each product, from their personal account and the organisations they own. */
export interface EntitlementsResponse {
  vault: {
    plan: VaultPlanId;
    /** override: staff set it. overdue: an invoice is past its grace date, so Vault Free applies. */
    source: 'subscription' | 'override' | 'overdue' | 'default';
    /** Cancelling: when it falls back to Vault Free. */
    until: number | null;
    /** The billing account it comes from. */
    orgId: string | null;
  };
}

export interface LimitsResponse {
  plan: PlanId;
  /** source 'event_pass': the tournament asked about has a pass. */
  passTournamentId?: string | null;
  limits: PlanLimits;
  /** Running tournaments the owner (organisation or person) has now. */
  running: number;
  source: 'organisation' | 'event_pass' | 'person';
}

export interface TournamentEvent extends TournamentSummary {
  kind: 'created' | 'updated' | 'deleted';
  /** Optional, for the portal's tournament page: who runs it, and how many matches are played. */
  organisers?: { id: string; name: string; role: string }[];
  createdAt?: number;
  registrationOpensAt?: number | null;
  registrationClosesAt?: number | null;
  venue?: string | null;
  format?: string | null;
  played?: number;
  matches?: number;
}

export interface InternalApi {
  'GET /internal/limits': { Q: { org?: string; tournament?: string; user: string }; R: LimitsResponse };
  'GET /internal/entitlements': { Q: { user: string }; R: EntitlementsResponse };
  'GET /internal/orgs/:id/membership': { Q: { user: string }; R: { role: MemberRole | null } };
  /** The account's organisations, for Tournament and Wishlist (each filters by `services`). */
  'GET /internal/people/:id/orgs': { R: { orgs: (PortalOrgSummary & { wishlist: WishlistLimits })[] } };
  'POST /internal/tournament-events': { B: TournamentEvent; R: { ok: true } };
  'POST /internal/errors': { B: { service: ServiceId; message: string; route: string; count?: number }; R: { ok: true } };
  'GET /internal/banners': { Q: { tournament: string }; R: { banners: PortalBanner[] } };
}
