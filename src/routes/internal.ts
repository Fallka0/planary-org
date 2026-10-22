// /internal/*: other Planary workers (x-internal-key, constant-time). 404 without the key.

import { Hono } from 'hono';
import type { LimitsResponse, MemberRole, PlanId, ServiceId, TournamentState } from '../contract';
import type { AppEnv, Env } from '../env';
import { internalKeyOk } from '../lib/auth';
import { getOrg, ORG_SELECT, planCutoff, servicesOf, tournamentBanners, type OrgRow } from '../lib/orgs';
import { bad, clean, errorBody, initials, int, MINUTE, notFound, oneOf, readJson, requireOneOf, requireText } from '../lib/util';
import { PLAN_IDS, PLANS } from '../plans';
import { SERVICE_IDS } from '../services';

export const internalApp = new Hono<AppEnv>();

internalApp.use('*', async (c, next) => {
  if (!internalKeyOk(c.env, c.req.header('x-internal-key'))) return c.json(errorBody(c, 'Not found.', 'not_found'), 404);
  await next();
});

const id = (v: unknown, field: string) => {
  const s = clean(v, 101);
  if (!s || s.length > 100 || !/^[\w.:-]+$/.test(s)) throw bad(`${field} is required (letters, digits, - _ . :).`, `invalid_${field}`);
  return s;
};
const optId = (v: unknown, field: string) => (v === undefined || v === null || v === '' ? null : id(v, field));

async function running(env: Env, where: string, bind: unknown[]) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tournaments WHERE state = 'live' AND ${where}`).bind(...bind).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * The limits Tournament enforces: Verein (or a staff-set plan) on the organisation, else an
 * event pass on the tournament, else Gratis. `running` counts the owner's live tournaments.
 */
internalApp.get('/limits', async (c) => {
  const user = id(c.req.query('user'), 'user');
  const orgId = optId(c.req.query('org'), 'org');
  const tournamentId = optId(c.req.query('tournament'), 'tournament');
  const now = Date.now();
  const respond = (plan: PlanId, source: LimitsResponse['source'], n: number) => c.json({ plan, limits: PLANS[plan].limits, running: n, source } satisfies LimitsResponse);

  let org = null;
  if (orgId) {
    org = await getOrg(c.env, orgId, now);
    if (!org) throw notFound('No organisation with that id.');
  }
  const runningNow = org ? await running(c.env, 'organisation_id = ?', [org.id]) : await running(c.env, 'owner_id = ? AND organisation_id IS NULL', [user]);

  if (org) {
    const orgPlan = org.plan_override ?? (org.plan === 'verein' ? 'verein' : null);
    if (orgPlan && orgPlan !== 'gratis') return respond(orgPlan, 'organisation', runningNow);
  }
  if (tournamentId && !(org?.plan_override === 'gratis')) {
    const pass = await c.env.DB.prepare('SELECT 1 FROM event_passes WHERE tournament_id = ?').bind(tournamentId).first();
    if (pass) return respond('event', 'event_pass', runningNow);
  }
  return respond('gratis', org ? 'organisation' : 'person', runningNow);
});

internalApp.get('/orgs/:id/membership', async (c) => {
  const user = id(c.req.query('user'), 'user');
  const m = await c.env.DB.prepare('SELECT m.role FROM members m JOIN organisations o ON o.id = m.org_id WHERE m.org_id = ? AND m.user_id = ? AND o.delete_at IS NULL')
    .bind(c.req.param('id'), user)
    .first<{ role: MemberRole }>();
  return c.json({ role: m?.role ?? null });
});

/** The organisations an account belongs to, for Tournament's "run this tournament for …". */
internalApp.get('/people/:id/orgs', async (c) => {
  const user = id(c.req.param('id'), 'user');
  const { results } = await c.env.DB.prepare(`SELECT x.*, m.role AS member_role FROM (${ORG_SELECT}) x JOIN members m ON m.org_id = x.id WHERE m.user_id = ? AND x.delete_at IS NULL ORDER BY x.name`)
    .bind(planCutoff(Date.now()), user)
    .all<OrgRow & { member_role: MemberRole }>();
  return c.json({
    orgs: results.map((o) => ({ id: o.id, name: o.name, initials: initials(o.name), role: o.member_role, plan: o.plan, services: servicesOf(o), wishlist: PLANS[o.plan].wishlist })),
  });
});

const STATES: readonly TournamentState[] = ['draft', 'open', 'live', 'done'];
const time = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e14 ? Math.trunc(v) : undefined);

/** The Tournament API reports each lifecycle change; the mirror is replaced, or removed on delete. */
internalApp.post('/tournament-events', async (c) => {
  const b = await readJson(c);
  const kind = requireOneOf(b.kind, ['created', 'updated', 'deleted'] as const, 'kind');
  const tid = id(b.id, 'id');
  if (kind === 'deleted') {
    await c.env.DB.prepare('DELETE FROM tournaments WHERE id = ?').bind(tid).run();
    return c.json({ ok: true });
  }
  const startsAt = time(b.startsAt);
  const endsAt = time(b.endsAt);
  if (startsAt === undefined || endsAt === undefined) throw bad('startsAt and endsAt are epoch ms or null.', 'invalid_time');
  const createdAt = time(b.createdAt);
  const opensAt = time(b.registrationOpensAt);
  const closesAt = time(b.registrationClosesAt);
  if (createdAt === undefined || opensAt === undefined || closesAt === undefined) throw bad('createdAt and the registration times are epoch ms or null.', 'invalid_time');
  const organisers = Array.isArray(b.organisers)
    ? b.organisers
        .slice(0, 50)
        .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object')
        .map((o) => ({ id: clean(o.id, 100), name: clean(o.name, 120), role: clean(o.role, 60) }))
        .filter((o) => o.id)
    : [];
  const row = {
    id: tid,
    slug: clean(b.slug, 100),
    name: requireText(b.name, 'name', 200),
    game: clean(b.game, 100),
    starts_at: startsAt,
    ends_at: endsAt,
    state: requireOneOf(b.state, STATES, 'state'),
    phase: clean(b.phase, 100) || null,
    teams: int(b.teams, 0, 100_000, 0),
    max_teams: int(b.maxTeams, 0, 100_000, 0),
    waiting: int(b.waiting, 0, 100_000, 0),
    organisation_id: optId(b.organisationId, 'organisationId'),
    owner_id: id(b.ownerId, 'ownerId'),
    organisation_name: clean(b.organisationName, 120) || null,
    plan: oneOf(b.plan, PLAN_IDS) ?? 'gratis',
    viewers: int(b.viewers, 0, 10_000_000, 0),
    organisers: JSON.stringify(organisers),
    played: int(b.played, 0, 100_000, 0),
    matches: int(b.matches, 0, 100_000, 0),
    created_at: createdAt,
    registration_opens_at: opensAt,
    registration_closes_at: closesAt,
    venue: clean(b.venue, 120) || null,
    format: clean(b.format, 120) || null,
    updated_at: time(b.updatedAt) ?? Date.now(),
  };
  const cols = Object.keys(row);
  await c.env.DB.prepare(
    `INSERT INTO tournaments (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${cols
       .filter((k) => k !== 'id')
       .map((k) => (k === 'created_at' ? 'created_at = COALESCE(tournaments.created_at, excluded.created_at)' : `${k} = excluded.${k}`))
       .join(', ')}
     WHERE excluded.updated_at >= tournaments.updated_at`,
  )
    .bind(...Object.values(row))
    .run();
  return c.json({ ok: true });
});

/** 5xx reports from the workers, added up per service, message, route and minute. */
internalApp.post('/errors', async (c) => {
  const b = await readJson(c);
  const service = requireOneOf(b.service, SERVICE_IDS, 'service') as ServiceId;
  const message = requireText(b.message, 'message', 300);
  const route = requireText(b.route, 'route', 200);
  const count = int(b.count ?? 1, 1, 100_000, 1);
  const minute = Math.floor(Date.now() / MINUTE) * MINUTE;
  await c.env.DB.prepare(
    'INSERT INTO error_reports (service, message, route, minute, count) VALUES (?, ?, ?, ?, ?) ON CONFLICT (service, message, route, minute) DO UPDATE SET count = count + excluded.count',
  )
    .bind(service, message, route, minute, count)
    .run();
  return c.json({ ok: true });
});

internalApp.get('/banners', async (c) => {
  const tid = id(c.req.query('tournament'), 'tournament');
  const t = await c.env.DB.prepare('SELECT id, state FROM tournaments WHERE id = ?').bind(tid).first<{ id: string; state: TournamentState }>();
  if (!t) return c.json({ banners: [] });
  return c.json({ banners: await tournamentBanners(c.env, t, Date.now()) });
});
