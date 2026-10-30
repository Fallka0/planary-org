// /console/*: the Console (admin.planary.ch). Staff only; GET needs read, POST needs edit for the
// endpoint's area (src/permissions.ts). Every change writes the audit log in the same batch.

import { Hono, type Context } from 'hono';
import type {
  AuditEntry,
  ConsoleMe,
  OrganiserRow,
  OverviewResponse,
  StaffRole,
  StaffRow,
  TournamentState,
  VaultPlanId,
  VaultUsage,
  WishlistTotals,
} from '../contract';
import type { AppEnv, Env } from '../env';
import { actorOf, need } from './guard';
import { auditStmt } from '../lib/audit';
import { requirePerson } from '../lib/auth';
import { ORG_SELECT, type OrgRow } from '../lib/orgs';
import { REQUEST_SELECT, requestSummary, type RequestRow } from '../lib/requests';
import { TOURNAMENT_ORDER, TOURNAMENT_SELECT, tournamentOut, type TournamentRow } from '../lib/tournaments';
import { bad, clean, conflict, email, errorBody, initials, likeTerm, MINUTE, notFound, oneOf, randomId, readJson, requireOneOf } from '../lib/util';
import { accessMap, AREAS, can, ROLES } from '../permissions';
import { PLAN_IDS } from '../plans';
import { serviceStatuses } from '../services';
import { registerCustomers } from './console-customers';
import { registerStatus } from './console-status';
import { registerSupport } from './console-support';

export const consoleApp = new Hono<AppEnv>();
export type CC = Context<AppEnv>;

const LAST_ACTIVE_EVERY = MINUTE;

interface StaffDbRow {
  id: string;
  user_id: string | null;
  email: string;
  name: string;
  role: StaffRole;
  last_active: number | null;
  created_at: number;
}

// ── Who is this ──────────────────────────────────────

consoleApp.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  const person = await requirePerson(c);
  const DB = c.env.DB;
  const now = Date.now();
  let row = await DB.prepare('SELECT * FROM staff WHERE user_id = ?').bind(person.id).first<StaffDbRow>();

  // Added on the Staff page by e-mail before this account signed in: the row becomes theirs now.
  if (!row && person.email) {
    const pending = await DB.prepare('SELECT * FROM staff WHERE user_id IS NULL AND email = ?').bind(person.email).first<StaffDbRow>();
    if (pending) {
      const actor = { id: person.id, name: person.name };
      await DB.batch([
        DB.prepare('UPDATE staff SET id = ?, user_id = ?, name = ?, last_active = ? WHERE id = ?').bind(person.id, person.id, person.name, now, pending.id),
        DB.prepare('UPDATE audit_log SET actor_id = ? WHERE actor_id = ?').bind(person.id, pending.id),
        DB.prepare('UPDATE requests SET assignee_id = ? WHERE assignee_id = ?').bind(person.id, pending.id),
        DB.prepare('UPDATE customer_notes SET staff_id = ? WHERE staff_id = ?').bind(person.id, pending.id),
        auditStmt(c.env, { area: 'staff', actor, action: 'staff.join', sentence: 'Joined the Console', target: person.name, details: pending.role }),
      ]);
      row = { ...pending, id: person.id, user_id: person.id, name: person.name, last_active: now };
    }
  }

  // The owner named in the config claims the Console the first time, while nobody holds Owner.
  if (!row && person.email && person.email === (c.env.OWNER_EMAIL ?? '').trim().toLowerCase()) {
    const owner = await DB.prepare("SELECT 1 FROM staff WHERE role = 'owner'").first();
    if (!owner) {
      await DB.batch([
        DB.prepare("INSERT INTO staff (id, user_id, email, name, role, last_active, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)").bind(
          person.id,
          person.id,
          person.email,
          person.name,
          now,
          now,
        ),
        auditStmt(c.env, { area: 'staff', actor: { id: person.id, name: person.name }, action: 'staff.bootstrap', sentence: 'Claimed the Owner role', target: person.name, details: 'OWNER_EMAIL' }),
      ]);
      row = { id: person.id, user_id: person.id, email: person.email, name: person.name, role: 'owner', last_active: now, created_at: now };
    }
  }

  if (!row) return c.json(errorBody(c, "This account doesn't have access to the Console.", 'not_staff'), 403);

  if (row.name !== person.name || !row.last_active || now - row.last_active > LAST_ACTIVE_EVERY) {
    await DB.prepare('UPDATE staff SET name = ?, last_active = ? WHERE id = ?').bind(person.name, now, row.id).run();
  }
  if (person.email && row.email !== person.email) {
    // Copied only when no other row (e.g. a pending invitation) holds that address.
    await DB.prepare('UPDATE staff SET email = ?1 WHERE id = ?2 AND NOT EXISTS (SELECT 1 FROM staff x WHERE x.email = ?1)').bind(person.email, row.id).run();
  }
  c.set('staff', { id: row.id, name: person.name, email: person.email || row.email, role: row.role });
  await next();
});

consoleApp.get('/me', (c) => {
  const s = c.get('staff');
  const me: ConsoleMe = { id: s.id, name: s.name, email: s.email, role: s.role, access: accessMap(s.role) };
  return c.json(me);
});

// ── Overview ─────────────────────────────────────────

interface AuthStats {
  accounts: number;
  accountsNew: number;
  signups: number[];
  activeToday?: number;
}

async function authStats(env: Env, days: number): Promise<AuthStats | null> {
  if (!env.INTERNAL_KEY) return null;
  try {
    const res = await env.AUTH.fetch(new Request(`https://auth.internal/api/internal/stats?days=${days}`, { headers: { 'x-internal-key': env.INTERNAL_KEY } }));
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<AuthStats>;
    return {
      accounts: num(data.accounts),
      accountsNew: num(data.accountsNew),
      signups: Array.isArray(data.signups) ? data.signups.map(num) : [],
      ...(typeof data.activeToday === 'number' ? { activeToday: num(data.activeToday) } : {}),
    };
  } catch (error) {
    console.log(`auth stats failed: ${error}`);
    return null;
  }
}

export interface Visitors {
  days: string[];
  sites: Record<string, number[]>;
}

/** Unique visitors per day per site from planary-stats; null when it isn't bound or doesn't answer. */
export async function visitors(env: Env, days: number): Promise<Visitors | null> {
  if (!env.STATS || !env.INTERNAL_KEY) return null;
  try {
    const res = await env.STATS.fetch(new Request(`https://stats.internal/api/internal/visitors?days=${days}`, { headers: { 'x-internal-key': env.INTERNAL_KEY } }));
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<Visitors>;
    if (!data || typeof data.sites !== 'object' || data.sites === null) return null;
    const sites: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(data.sites)) if (Array.isArray(v)) sites[k] = v.map(num);
    return { days: Array.isArray(data.days) ? data.days.map(String) : [], sites };
  } catch (error) {
    console.log(`stats visitors failed: ${error}`);
    return null;
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** The last n values, padded with zeros at the front (oldest first). */
const lastN = (xs: number[], n: number) => (xs.length >= n ? xs.slice(xs.length - n) : [...Array(n - xs.length).fill(0), ...xs]);

export const APP_SITES = { tournament: 'tournament.planary.ch', casino: 'casino.planary.ch', wishlist: 'wishlist.planary.ch' } as const;

consoleApp.get('/overview', need('overview'), async (c) => {
  const days = (oneOf(c.req.query('days'), ['7', '30', '90'] as const) ? Number(c.req.query('days')) : 30) as 7 | 30 | 90;
  const now = Date.now();
  const window = Math.max(days, 30);
  const [auth, visits, orgs, reqCounts, top, statuses] = await Promise.all([
    authStats(c.env, days * 2),
    visitors(c.env, window),
    c.env.DB.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN plan <> 'gratis' THEN 1 ELSE 0 END) AS paid FROM (${ORG_SELECT} WHERE o.delete_at IS NULL)`)
      .first<{ n: number; paid: number | null }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS open, SUM(CASE WHEN assignee_id IS NULL THEN 1 ELSE 0 END) AS unassigned FROM requests WHERE status = 'open'").first<{
      open: number;
      unassigned: number | null;
    }>(),
    c.env.DB.prepare(`${REQUEST_SELECT} WHERE r.status = 'open' ORDER BY r.urgent DESC, r.created_at DESC LIMIT 5`).all<RequestRow>(),
    serviceStatuses(c.env, now),
  ]);

  const signupsAll = lastN(auth?.signups ?? [], days * 2);
  const signups = signupsAll.slice(days);
  const apps = (Object.keys(APP_SITES) as (keyof typeof APP_SITES)[]).map((app) => {
    const series = lastN(visits?.sites[APP_SITES[app]] ?? [], window);
    return {
      app,
      today: series[series.length - 1] ?? 0,
      d7: sum(series.slice(-7)),
      d30: sum(series.slice(-30)),
      spark: series.slice(-days),
      state: statuses.find((s) => s.id === app)?.state ?? 'unknown',
    };
  });
  const active = Array.from({ length: days }, (_, i) => sum(apps.map((a) => a.spark[i] ?? 0)));

  const body: OverviewResponse = {
    days,
    accounts: auth?.accounts ?? 0,
    accountsNew7: sum(signupsAll.slice(-7)),
    activeToday: auth?.activeToday ?? Math.max(0, ...apps.map((a) => a.today)),
    organisations: orgs?.n ?? 0,
    paidOrganisations: orgs?.paid ?? 0,
    openRequests: reqCounts?.open ?? 0,
    unassignedRequests: reqCounts?.unassigned ?? 0,
    signups,
    active,
    signupsPrev: sum(signupsAll.slice(0, days)),
    requests: top.results.map(requestSummary),
    apps,
    services: statuses.map((s) => ({ id: s.id, name: s.name, state: s.state, medianMs: s.medianMs, uptime30: s.uptime30 })),
  };
  return c.json(body);
});

// ── Search ───────────────────────────────────────────

consoleApp.get('/search', async (c) => {
  const q = clean(c.req.query('q'), 80);
  if (q.length < 2) return c.json({ results: [] });
  const role = c.get('staff').role;
  const term = likeTerm(q.toLowerCase());
  type Result = { kind: 'organisation' | 'tournament' | 'request' | 'staff'; id: string; label: string; sub: string; href: string };
  const results: Result[] = [];
  const jobs: Promise<void>[] = [];
  if (can(role, 'customers', 'read')) {
    jobs.push(
      c.env.DB.prepare("SELECT id, name, slug FROM organisations WHERE lower(name) LIKE ?1 ESCAPE '\\' OR slug LIKE ?1 ESCAPE '\\' ORDER BY name LIMIT 10")
        .bind(term)
        .all<{ id: string; name: string; slug: string }>()
        .then((r) => {
          for (const o of r.results) results.push({ kind: 'organisation', id: o.id, label: o.name, sub: o.slug, href: `/customers/${o.id}` });
        }),
    );
  }
  if (can(role, 'tournament', 'read')) {
    jobs.push(
      c.env.DB.prepare(`${TOURNAMENT_SELECT} WHERE lower(t.name) LIKE ?1 ESCAPE '\\' OR t.slug LIKE ?1 ESCAPE '\\' ORDER BY t.updated_at DESC LIMIT 10`)
        .bind(term)
        .all<TournamentRow>()
        .then((r) => {
          for (const t of r.results)
            results.push({ kind: 'tournament', id: t.id, label: t.name, sub: [t.organisation_name, t.game].filter(Boolean).join(' · '), href: `/tournament?t=${encodeURIComponent(t.id)}` });
        }),
    );
  }
  if (can(role, 'support', 'read')) {
    jobs.push(
      c.env.DB.prepare(`${REQUEST_SELECT} WHERE lower(r.code) LIKE ?1 ESCAPE '\\' OR lower(r.subject) LIKE ?1 ESCAPE '\\' ORDER BY r.updated_at DESC LIMIT 10`)
        .bind(term)
        .all<RequestRow>()
        .then((r) => {
          for (const x of r.results) results.push({ kind: 'request', id: x.id, label: `${x.code} ${x.subject}`, sub: x.org_name ?? x.user_name, href: `/support/${x.id}` });
        }),
    );
  }
  if (can(role, 'staff', 'read')) {
    jobs.push(
      c.env.DB.prepare("SELECT id, name, email, role FROM staff WHERE lower(name) LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\' ORDER BY name LIMIT 10")
        .bind(term)
        .all<{ id: string; name: string; email: string; role: string }>()
        .then((r) => {
          for (const s of r.results) results.push({ kind: 'staff', id: s.id, label: s.name || s.email, sub: `${s.email} · ${s.role}`, href: '/staff' });
        }),
    );
  }
  await Promise.all(jobs);
  const order = { organisation: 0, request: 1, tournament: 2, staff: 3 };
  results.sort((a, b) => order[a.kind] - order[b.kind]);
  return c.json({ results: results.slice(0, 10) });
});

// ── Tournament ───────────────────────────────────────

consoleApp.get('/tournaments', need('tournament'), async (c) => {
  const state = oneOf(c.req.query('state'), ['draft', 'open', 'live', 'done'] as const satisfies readonly TournamentState[]);
  const plan = oneOf(c.req.query('plan'), PLAN_IDS);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (state) {
    where.push('t.state = ?');
    binds.push(state);
  }
  if (plan) {
    where.push('t.plan = ?');
    binds.push(plan);
  }
  const { results } = await c.env.DB.prepare(`${TOURNAMENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${TOURNAMENT_ORDER} LIMIT 500`)
    .bind(...binds)
    .all<TournamentRow>();
  return c.json({ tournaments: results.map(tournamentOut) });
});

consoleApp.get('/organisers', need('tournament'), async (c) => {
  const now = Date.now();
  const [tournaments, orgs, members, overdue] = await Promise.all([
    c.env.DB.prepare(`${TOURNAMENT_SELECT} ORDER BY ${TOURNAMENT_ORDER}`).all<TournamentRow>(),
    c.env.DB.prepare(`${ORG_SELECT}`).all<OrgRow>(),
    c.env.DB.prepare('SELECT org_id, COUNT(*) AS n FROM members GROUP BY org_id').all<{ org_id: string; n: number }>(),
    c.env.DB.prepare("SELECT DISTINCT org_id FROM invoices WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ?").bind(now).all<{ org_id: string }>(),
  ]);
  const orgById = new Map(orgs.results.map((o) => [o.id, o]));
  const overdueSet = new Set(overdue.results.map((r) => r.org_id));
  const memberCount = new Map(members.results.map((m) => [m.org_id, m.n]));
  const groups = new Map<string, { kind: 'organisation' | 'person'; list: TournamentRow[] }>();
  for (const t of tournaments.results) {
    const known = t.organisation_id && orgById.has(t.organisation_id);
    const key = known ? `o:${t.organisation_id}` : `p:${t.owner_id}`;
    const g = groups.get(key) ?? { kind: known ? 'organisation' : 'person', list: [] };
    g.list.push(t);
    groups.set(key, g);
  }
  const rows: OrganiserRow[] = [];
  for (const [key, g] of groups) {
    const first = g.list[0]; // already ordered: live, open, draft, done
    if (g.kind === 'organisation') {
      const org = orgById.get(key.slice(2))!;
      rows.push({
        id: org.id,
        kind: 'organisation',
        name: org.name,
        initials: initials(org.name),
        plan: org.plan,
        organisers: memberCount.get(org.id) ?? 0,
        tournaments: g.list.length,
        latest: { name: first.name, at: first.starts_at, state: first.state },
        status: overdueSet.has(org.id) ? 'overdue' : org.plan === 'gratis' ? 'free' : 'active',
      });
    } else {
      const name = first.organisation_id ? first.organisation_name || 'Organisation' : first.organisation_name || `Account ${first.owner_id.slice(0, 6)}`;
      rows.push({
        id: first.owner_id,
        kind: 'person',
        name,
        initials: initials(name),
        plan: 'gratis',
        organisers: 1,
        tournaments: g.list.length,
        latest: { name: first.name, at: first.starts_at, state: first.state },
        status: 'free',
      });
    }
  }
  rows.sort((a, b) => b.tournaments - a.tournaments || a.name.localeCompare(b.name));
  return c.json({ organisers: rows });
});

// ── Wishlist (totals only, passed through) ───────────

consoleApp.get('/wishlist', need('wishlist'), async (c) => {
  const notConnected = () => c.json(errorBody(c, "The Wishlist API isn't connected yet.", 'not_connected'), 503);
  if (!c.env.INTERNAL_KEY) return notConnected();
  const base = (c.env.WISHLIST_API ?? '').trim().replace(/\/+$/, '');
  const headers = { 'x-internal-key': c.env.INTERNAL_KEY };
  try {
    // The service binding when there is one, else WISHLIST_API (the Worker's /api base, for local runs).
    const res = c.env.WISHLIST
      ? await c.env.WISHLIST.fetch(new Request('https://wishlist.internal/api/internal/totals', { headers }))
      : /^https?:\/\//.test(base)
        ? await fetch(`${base}/internal/totals`, { headers, signal: AbortSignal.timeout(10_000) })
        : null;
    if (!res?.ok) return notConnected();
    return c.json(wishlistTotals(await res.json()));
  } catch (error) {
    console.log(`wishlist totals failed: ${error}`);
    return notConnected();
  }
});

consoleApp.get('/vault', need('vault'), async (c) => {
  const notConnected = () => c.json(errorBody(c, "Planary Vault isn't connected yet.", 'not_connected'), 503);
  if (!c.env.INTERNAL_KEY_VAULT) return notConnected();
  const base = (c.env.VAULT_API ?? '').trim().replace(/\/+$/, '');
  const headers = { 'x-internal-key': c.env.INTERNAL_KEY_VAULT };
  try {
    // The service binding when there is one, else VAULT_API (for local runs).
    const res = c.env.VAULT
      ? await c.env.VAULT.fetch(new Request('https://vault.internal/internal/usage', { headers }))
      : /^https?:\/\//.test(base)
        ? await fetch(`${base}/internal/usage`, { headers, signal: AbortSignal.timeout(10_000) })
        : null;
    if (!res?.ok) return notConnected();
    return c.json(vaultUsage(await res.json()));
  } catch (error) {
    console.log(`vault usage failed: ${error}`);
    return notConnected();
  }
});

/** Vault's /internal/usage, checked field by field: only what the Console shows passes. */
export function vaultUsage(raw: unknown): VaultUsage {
  const d = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const people = (Array.isArray(d.people) ? d.people : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as Record<string, unknown>).userId === 'string')
    .map((p) => ({
      userId: text(p.userId, 64),
      name: text(p.name, 48),
      email: text(p.email, 254),
      plan: (p.plan === 'plus' || p.plan === 'pro' ? p.plan : 'free') as VaultPlanId,
      used: num(p.used),
      quota: num(p.quota),
      files: num(p.files),
      createdAt: num(p.createdAt),
      lastSeen: typeof p.lastSeen === 'number' ? num(p.lastSeen) : null,
    }))
    .sort((a, b) => b.used - a.used);
  return {
    people,
    totals: {
      vaults: people.length,
      used: people.reduce((sum, p) => sum + p.used, 0),
      quota: people.reduce((sum, p) => sum + p.quota, 0),
    },
  };
}

/** Wishlist's /api/internal/totals in the Console's shape. Shops come as item counts and become shares. */
export function wishlistTotals(raw: unknown): WishlistTotals {
  const d = (raw ?? {}) as Record<string, unknown>;
  const weekly = Array.isArray(d.newListsPerWeek) ? d.newListsPerWeek : Array.isArray(d.newPerWeek) ? d.newPerWeek : [];
  const newPerWeek = weekly.slice(-12).map(num);
  let shops: [string, number][] = [];
  if (Array.isArray(d.shopDomains)) {
    const rows = d.shopDomains.filter((s): s is { domain: string; items: number } => !!s && typeof s.domain === 'string' && typeof s.items === 'number');
    const total = rows.reduce((a, s) => a + s.items, 0);
    shops = rows.slice(0, 20).map((s) => [s.domain.slice(0, 100), total ? s.items / total : 0]);
  } else if (Array.isArray(d.shops)) {
    shops = d.shops
      .filter((s): s is [string, number] => Array.isArray(s) && typeof s[0] === 'string' && typeof s[1] === 'number')
      .slice(0, 20)
      .map(([domain, share]) => [domain.slice(0, 100), share]);
  }
  return {
    lists: num(d.lists),
    listsNewWeek: d.listsNewWeek !== undefined ? num(d.listsNewWeek) : (newPerWeek.at(-1) ?? 0),
    items: num(d.items),
    sharedLists: num(d.sharedLists),
    reservationsMonth: num(d.reservationsMonth ?? d.reservationsThisMonth),
    newPerWeek,
    shops,
  };
}

// ── Audit log ────────────────────────────────────────

const AUDIT_PAGE = 100;

consoleApp.get('/audit', need('audit'), async (c) => {
  const area = c.req.query('area');
  const staff = clean(c.req.query('staff'), 80);
  const before = c.req.query('before');
  const where: string[] = [];
  const binds: unknown[] = [];
  // area: one area or a comma-separated list (e.g. customers,notes); empty means all.
  const areas = [...new Set((area ?? '').split(',').map((a) => a.trim()).filter(Boolean))];
  if (areas.length) {
    for (const a of areas) if (!(AREAS as readonly string[]).includes(a) && a !== 'portal' && a !== 'system') throw bad(`Unknown area: ${a.slice(0, 40)}.`, 'invalid_area');
    where.push(`area IN (${areas.map(() => '?').join(', ')})`);
    binds.push(...areas);
  }
  if (staff) {
    where.push('actor_id = ?');
    binds.push(staff);
  }
  // before: the id of the last entry of the previous page; returns entries older than it.
  if (before) {
    if (!/^\d{1,15}$/.test(before)) throw bad('before must be an entry id.', 'invalid_before');
    where.push('id < ?');
    binds.push(Number(before));
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${AUDIT_PAGE + 1}`)
    .bind(...binds)
    .all<{ id: number; at: number; area: AuditEntry['area']; actor_id: string | null; actor_name: string | null; action: string; sentence: string; target: string | null; details: string | null }>();
  const entries: AuditEntry[] = results.slice(0, AUDIT_PAGE).map((r) => ({
    id: String(r.id),
    at: r.at,
    area: r.area,
    actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? '' } : null,
    action: r.action,
    sentence: r.sentence,
    target: r.target,
    details: r.details,
  }));
  return c.json({ entries, more: results.length > AUDIT_PAGE });
});

// ── Staff and roles ──────────────────────────────────

const roleOrder = "CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'support' THEN 2 ELSE 3 END";

consoleApp.get('/staff', need('staff'), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM staff ORDER BY ${roleOrder}, name, email`).all<StaffDbRow>();
  const staff: StaffRow[] = results.map((r) => ({
    id: r.id,
    name: r.name || r.email.split('@')[0],
    email: r.email,
    role: r.role,
    lastActive: r.user_id ? r.last_active : null,
    since: r.created_at,
  }));
  return c.json({ staff });
});

/**
 * planary-auth has no account lookup by e-mail, so a new staff member is stored by e-mail and
 * the row becomes theirs when that address signs in to the Console.
 */
consoleApp.post('/staff', need('staff'), async (c) => {
  const body = await readJson(c);
  const addr = email(body.email);
  if (!addr) throw bad('Enter a valid e-mail address.', 'invalid_email');
  const role = requireOneOf(body.role, ROLES, 'role');
  const me = c.get('staff');
  const exists = await c.env.DB.prepare('SELECT 1 FROM staff WHERE email = ?').bind(addr).first();
  if (exists) throw conflict('That person is already on the staff list.', 'already_staff');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO staff (id, user_id, email, name, role, last_active, created_at, invited_by) VALUES (?, NULL, ?, ?, ?, NULL, ?, ?)').bind(
      randomId('pending'),
      addr,
      '',
      role,
      now,
      me.id,
    ),
    auditStmt(c.env, { area: 'staff', actor: actorOf(me), action: 'staff.add', sentence: 'Added a staff member', target: addr, details: role }),
  ]);
  return c.json({ ok: true });
});

async function staffTarget(c: CC) {
  const row = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(c.req.param('id')).first<StaffDbRow>();
  if (!row) throw notFound('No staff member with that id.');
  return row;
}

async function isLastOwner(env: Env, row: StaffDbRow) {
  if (row.role !== 'owner') return false;
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner' AND user_id IS NOT NULL AND id <> ?").bind(row.id).first<{ n: number }>();
  return (n?.n ?? 0) === 0;
}

consoleApp.post('/staff/:id/remove', need('staff'), async (c) => {
  const row = await staffTarget(c);
  if (await isLastOwner(c.env, row)) throw conflict("The last Owner can't be removed.", 'last_owner');
  const me = c.get('staff');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE requests SET assignee_id = NULL WHERE assignee_id = ?').bind(row.id),
    c.env.DB.prepare('DELETE FROM staff WHERE id = ?').bind(row.id),
    auditStmt(c.env, { area: 'staff', actor: actorOf(me), action: 'staff.remove', sentence: 'Removed a staff member', target: row.name || row.email, details: row.role }),
  ]);
  return c.json({ ok: true });
});

consoleApp.post('/staff/:id', need('staff'), async (c) => {
  const row = await staffTarget(c);
  const body = await readJson(c);
  const role = requireOneOf(body.role, ROLES, 'role');
  if (role === row.role) return c.json({ ok: true });
  if (role !== 'owner' && (await isLastOwner(c.env, row))) throw conflict("The last Owner can't be demoted.", 'last_owner');
  const me = c.get('staff');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE staff SET role = ? WHERE id = ?').bind(role, row.id),
    auditStmt(c.env, { area: 'staff', actor: actorOf(me), action: 'staff.role', sentence: 'Changed a role', target: row.name || row.email, details: `${row.role} → ${role}` }),
  ]);
  return c.json({ ok: true });
});

registerStatus(consoleApp);
registerCustomers(consoleApp);
registerSupport(consoleApp);
