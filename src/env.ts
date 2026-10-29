// Bindings, vars and secrets. Every secret is optional: without it, its integration switches off.

export interface Env {
  DB: D1Database;
  /** Support attachments and organisation logos. */
  FILES: R2Bucket;
  /** planary-auth: /api/auth/me (tokens) and /api/internal/stats (account totals). */
  AUTH: Fetcher;
  /** planary-stats: /api/internal/visitors (unique visitors per app). Optional. */
  STATS?: Fetcher;
  /** planary-wishlist: /api/internal/* (the Console's totals, an organisation's wishlists). Optional. */
  WISHLIST?: Fetcher;
  /** Public address of Wishlist, for links in the portal. Default https://wishlist.planary.ch */
  WISHLIST_URL?: string;
  /** planary-tournament-api, not built yet. Nothing depends on it. */
  TOURNAMENT?: Fetcher;

  CONSOLE_ORIGINS: string;
  PORTAL_ORIGINS: string;
  OWNER_EMAIL: string;
  PORTAL_URL: string;
  CONSOLE_URL: string;
  MAIL_FROM: string;
  STAFF_INBOX: string;
  /** Base URL of the Wishlist API; empty until it has /internal/totals. */
  WISHLIST_API?: string;
  /** JSON array overriding the health-checked services (see src/services.ts). */
  SERVICES_JSON?: string;

  // Secrets
  INTERNAL_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Stripe price of Plus (CHF 149, yearly). */
  STRIPE_PRICE_PLUS?: string;
  /** Stripe price of the Turnier-Pass (CHF 29, one-off). */
  STRIPE_PRICE_PASS?: string;
  RESEND_API_KEY?: string;
  GITHUB_TOKEN?: string;
}

export interface StaffCtx {
  id: string;
  name: string;
  email: string;
  role: import('./contract').StaffRole;
}

export interface PersonCtx {
  id: string;
  name: string;
  email: string;
}

export type Vars = {
  requestId: string;
  staff: StaffCtx;
  person: PersonCtx;
};

export type AppEnv = { Bindings: Env; Variables: Vars };
