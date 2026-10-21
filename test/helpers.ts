// Shared test helpers: requests against the real app with a local D1/R2 and the fake AUTH/STATS.

import { env } from 'cloudflare:workers';
import { app } from '../src/index';
import type { Env } from '../src/env';
import type { StaffRole } from '../src/contract';

export { env };

export const token = (id: string, email: string, name = 'Test Person') => `Bearer test|${id}|${email}|${name}`;

export interface Who {
  id: string;
  email: string;
  name?: string;
}

export const OWNER: Who = { id: 'u_owner', email: 'owner@planary.test', name: 'Mykyta Pantelei' };
export const MANAGER: Who = { id: 'u_manager', email: 'lea@planary.test', name: 'Lea Graf' };
export const SUPPORT: Who = { id: 'u_support', email: 'sven@planary.test', name: 'Sven Huber' };
export const VIEWER: Who = { id: 'u_viewer', email: 'tim@planary.test', name: 'Tim Roth' };

export interface CallOptions {
  who?: Who | null;
  body?: unknown;
  form?: FormData;
  env?: Partial<Env>;
  headers?: Record<string, string>;
  internal?: boolean;
}

export function call(method: string, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.who) headers.Authorization = token(opts.who.id, opts.who.email, opts.who.name);
  if (opts.internal) headers['x-internal-key'] = 'test-internal-key';
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  return app.request(path, { method, headers, body }, opts.env ? { ...env, ...opts.env } : env);
}

export const get = (path: string, opts: CallOptions = {}) => call('GET', path, opts);
export const post = (path: string, body: unknown = {}, opts: CallOptions = {}) => call('POST', path, { ...opts, body });

export async function json<T = any>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

const TABLES = [
  'attachments',
  'request_messages',
  'requests',
  'customer_notes',
  'invitations',
  'members',
  'event_passes',
  'invoices',
  'payment_methods',
  'billing_contacts',
  'subscriptions',
  'organisations',
  'provider_events',
  'incident_updates',
  'incident_services',
  'incidents',
  'checks',
  'service_state',
  'error_reports',
  'deploys',
  'staff',
  'audit_log',
  'tournaments',
  'meta',
];

export async function reset() {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export async function addStaff(who: Who, role: StaffRole) {
  await env.DB.prepare('INSERT INTO staff (id, user_id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(who.id, who.id, who.email, who.name ?? '', role, Date.now())
    .run();
}

export async function addAllStaff() {
  await addStaff(OWNER, 'owner');
  await addStaff(MANAGER, 'manager');
  await addStaff(SUPPORT, 'support');
  await addStaff(VIEWER, 'viewer');
}

export async function addOrg(id: string, name: string, members: { who: Who; role: 'owner' | 'member' }[], opts: { slug?: string; createdAt?: number } = {}) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO organisations (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, opts.slug ?? id.replace(/_/g, '-'), members[0]?.who.id ?? 'x', opts.createdAt ?? now),
    env.DB.prepare("INSERT INTO subscriptions (org_id, plan, state, updated_at) VALUES (?, 'gratis', 'none', ?)").bind(id, now),
    env.DB.prepare("INSERT INTO billing_contacts (org_id, email, phone, address, updated_at) VALUES (?, ?, '', '[]', ?)").bind(id, `billing@${id}.test`, now),
    ...members.map((m) =>
      env.DB.prepare('INSERT INTO members (org_id, user_id, name, email, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, m.who.id, m.who.name ?? '', m.who.email, m.role, now),
    ),
  ]);
}

export async function addTournament(t: { id: string; name?: string; state?: string; org?: string | null; owner?: string; maxTeams?: number; teams?: number; startsAt?: number | null }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tournaments (id, slug, name, game, starts_at, state, teams, max_teams, organisation_id, owner_id, plan, updated_at)
     VALUES (?, ?, ?, 'Counter-Strike 2', ?, ?, ?, ?, ?, ?, 'gratis', ?)`,
  )
    .bind(t.id, t.id, t.name ?? t.id, t.startsAt === undefined ? now : t.startsAt, t.state ?? 'open', t.teams ?? 8, t.maxTeams ?? 16, t.org ?? null, t.owner ?? 'u_someone', now)
    .run();
}

export async function auditRows() {
  return (await env.DB.prepare('SELECT * FROM audit_log ORDER BY id').all<{ area: string; action: string; sentence: string; actor_id: string | null; target: string | null; details: string | null }>())
    .results;
}

/** A fetch replacement that answers by URL prefix and records the calls. */
export function fakeFetch(routes: [prefix: string, handler: (req: Request) => Response | Promise<Response>][]) {
  const calls: { url: string; method: string; body: string; headers: Headers }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const body = req.method === 'GET' ? '' : new TextDecoder().decode(await req.clone().arrayBuffer());
    calls.push({ url: req.url, method: req.method, body, headers: req.headers });
    for (const [prefix, handler] of routes) if (req.url.startsWith(prefix)) return handler(req);
    return new Response('not mocked', { status: 599 });
  };
  return { fn: fn as typeof fetch, calls };
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
