// Health checks, incidents opened by the system, error ingestion, deploys and cleanup.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dailyCleanup, runScheduled } from '../src/cron';
import { DAY, HOUR, MINUTE } from '../src/lib/util';
import { refreshDeploys, runChecks } from '../src/services';
import { addOrg, addStaff, addTournament, auditRows, env, fakeFetch, get, json, OWNER, post, reset } from './helpers';

beforeEach(async () => {
  await reset();
  await addStaff(OWNER, 'owner');
});
afterEach(() => vi.restoreAllMocks());

/** Every service answers 200 except those listed, which answer `status` (or throw for 0). */
function probes(failing: Record<string, number> = {}, slowMs = 0) {
  return (async (input: RequestInfo | URL) => {
    const host = new URL(String(input instanceof Request ? input.url : input)).host;
    const status = failing[host];
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    if (status === 0) throw new Error('connection refused');
    return new Response('ok', { status: status ?? 200 });
  }) as typeof fetch;
}

const T0 = Math.floor(Date.now() / MINUTE) * MINUTE - 10 * MINUTE;
const at = (i: number) => T0 + i * MINUTE;

describe('health checks', () => {
  it('goes down after two failures, opens one incident, and notes the recovery once', async () => {
    await runChecks(env, at(0), probes());
    let status = await json(get('/console/status', { who: OWNER }));
    expect(status.services.find((s: any) => s.id === 'tournament').state).toBe('ok');

    await runChecks(env, at(1), probes({ 'tournament.planary.ch': 503 }));
    status = await json(get('/console/status', { who: OWNER }));
    expect(status.services.find((s: any) => s.id === 'tournament').state).toBe('ok');
    expect(status.open).toEqual([]);

    await runChecks(env, at(2), probes({ 'tournament.planary.ch': 0 }));
    await runChecks(env, at(3), probes({ 'tournament.planary.ch': 502 }));
    status = await json(get('/console/status', { who: OWNER }));
    const t = status.services.find((s: any) => s.id === 'tournament');
    expect(t).toMatchObject({ state: 'down', downSince: at(1) });
    expect(status.open).toHaveLength(1);
    expect(status.open[0]).toMatchObject({ code: 'INC-0001', title: 'Tournament is down', severity: 'major', status: 'investigating', services: ['tournament'], startedAt: at(1) });
    expect(status.errorGroups.tournament).toEqual([]);
    const audit = await auditRows();
    expect(audit.filter((a) => a.action === 'incident.open')).toEqual([expect.objectContaining({ area: 'system', actor_id: null, target: 'INC-0001' })]);

    // Recovery: one system update, the incident stays open.
    await runChecks(env, at(4), probes());
    await runChecks(env, at(5), probes());
    const detail = await json(get(`/console/incidents/${status.open[0].id}`, { who: OWNER }));
    expect(detail.status).toBe('investigating');
    expect(detail.updates.filter((u: any) => u.message === 'Checks pass again.')).toHaveLength(1);
    expect(detail.updates[0]).toMatchObject({ message: 'Checks pass again.', by: 'System' });

    // Down again while it is still open: no second incident.
    await runChecks(env, at(6), probes({ 'tournament.planary.ch': 500 }));
    await runChecks(env, at(7), probes({ 'tournament.planary.ch': 500 }));
    status = await json(get('/console/status', { who: OWNER }));
    expect(status.open).toHaveLength(1);
    expect(status.services.find((s: any) => s.id === 'tournament').spark.filter((x: unknown) => x === null).length).toBeGreaterThan(50);
  });

  it('treats 4xx as up and reports uptime and median', async () => {
    await runChecks(env, at(0), probes({ 'casino.planary.ch': 404 }));
    await runChecks(env, at(1), probes({ 'casino.planary.ch': 404 }));
    const status = await json(get('/console/status', { who: OWNER }));
    const casino = status.services.find((s: any) => s.id === 'casino');
    expect(casino.state).toBe('ok');
    expect(casino.uptime30).toBe(1);
    expect(casino.medianMs).not.toBeNull();
    expect(casino.spark).toHaveLength(60);
  });

  it('marks degraded when the median of the last five checks is over 2 s', async () => {
    for (let i = 0; i < 4; i++) {
      await env.DB.prepare('INSERT INTO checks (service, at, ok, status, ms) VALUES (?, ?, 1, 200, 2500)').bind('web', at(i)).run();
    }
    // The fifth check is fast, but the median of the last five is still 2500 ms.
    await runChecks(env, at(4), probes());
    const s = await env.DB.prepare("SELECT state FROM service_state WHERE service = 'web'").first<{ state: string }>();
    expect(s?.state).toBe('degraded');
    const other = await env.DB.prepare("SELECT state FROM service_state WHERE service = 'auth'").first<{ state: string }>();
    expect(other?.state).toBe('ok');
  });

  it('honours SERVICES_JSON', async () => {
    const seen: string[] = [];
    await runChecks({ ...env, SERVICES_JSON: JSON.stringify([{ id: 'web', url: 'https://staging.planary.test/health' }]) }, at(0), (async (u: RequestInfo | URL) => {
      seen.push(String(u));
      return new Response('ok');
    }) as typeof fetch);
    expect(seen).toContain('https://staging.planary.test/health');
    expect(seen).not.toContain('https://planary.ch/');
  });
});

describe('errors', () => {
  it('aggregates reports per minute and counts the last 24 hours', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await post('/internal/errors', { service: 'tournament', message: '503 Upstream timeout', route: 'GET /api/live/:id' }, { internal: true })).status).toBe(200);
    }
    await post('/internal/errors', { service: 'tournament', message: '503 Upstream timeout', route: 'GET /api/live/:id', count: 7 }, { internal: true });
    await post('/internal/errors', { service: 'casino', message: 'boom', route: 'POST /bet' }, { internal: true });
    await env.DB.prepare("INSERT INTO error_reports (service, message, route, minute, count) VALUES ('tournament', 'old', 'x', ?, 100)").bind(Date.now() - 2 * DAY).run();
    const rows = await env.DB.prepare("SELECT count FROM error_reports WHERE service = 'tournament' AND message = '503 Upstream timeout'").all<{ count: number }>();
    expect(rows.results.length).toBeLessThanOrEqual(2); // one row per minute
    const status = await json(get('/console/status', { who: OWNER }));
    expect(status.services.find((s: any) => s.id === 'tournament').errors24h).toBe(10);
    expect(status.services.find((s: any) => s.id === 'casino').errors24h).toBe(1);
    expect((await post('/internal/errors', { service: 'nope', message: 'x', route: 'y' }, { internal: true })).status).toBe(400);
    expect((await post('/internal/errors', { service: 'casino', message: 'x', route: 'y' })).status).toBe(404);
  });
});

describe('deploys', () => {
  it('reads GitHub at most every 10 minutes, with commit messages, and shows nothing without a token', async () => {
    const now = Date.now();
    const gh = fakeFetch([
      ['https://api.github.com/repos/Fallka0/planary-tournament/deployments', () =>
        Response.json([
          { id: 2, sha: 'aaaaaaa1111111', created_at: new Date(now - 20 * MINUTE).toISOString(), creator: { login: 'leagraf' } },
          { id: 1, sha: 'bbbbbbb2222222', created_at: new Date(now - 2 * DAY).toISOString(), creator: { login: 'mykyta' } },
        ])],
      ['https://api.github.com/repos/Fallka0/planary-tournament/commits/aaaaaaa1111111', () => Response.json({ sha: 'aaaaaaa1111111', commit: { message: 'Live API: batch writes\n\nlong body' } })],
      ['https://api.github.com/repos/Fallka0/planary-tournament/commits/bbbbbbb2222222', () => Response.json({ sha: 'bbbbbbb2222222', commit: { message: 'Brackets' } })],
      ['https://api.github.com/repos/', (r) =>
        r.url.includes('/deployments')
          ? Response.json([])
          : Response.json([{ sha: 'ccccccc3333333', html_url: 'https://github.com/x/commit/c', commit: { message: 'Main commit', author: { name: 'Mykyta P.', date: new Date(now - DAY).toISOString() } } }])],
    ]);
    expect(await refreshDeploys(env, now, gh.fn)).toBe(false); // no GITHUB_TOKEN
    expect(gh.calls).toHaveLength(0);
    const e = { ...env, GITHUB_TOKEN: 'ghp_test' };
    expect(await refreshDeploys(e, now, gh.fn)).toBe(true);
    expect(await refreshDeploys(e, now + 5 * MINUTE, gh.fn)).toBe(false);
    expect(gh.calls.every((c) => c.headers.get('authorization') === 'Bearer ghp_test')).toBe(true);

    const status = await json(get('/console/status', { who: OWNER }));
    expect(status.services.find((s: any) => s.id === 'tournament').deploy).toMatchObject({ commit: 'aaaaaaa', author: 'leagraf', message: 'Live API: batch writes' });
    expect(status.services.find((s: any) => s.id === 'auth').deploy).toMatchObject({ commit: 'ccccccc', author: 'Mykyta P.', message: 'Main commit' });

    // Incident detail: running and suspect deploys.
    const inc = await json(post('/console/incidents', { title: 'Live results delayed', severity: 'major', services: ['tournament'], message: 'Looking.' }, { who: OWNER }));
    await post('/internal/errors', { service: 'tournament', message: 'x', route: 'y', count: 4 }, { internal: true });
    await addOrg('org_a', 'Verein Gurten LAN', []);
    await addTournament({ id: 't_live', org: 'org_a', state: 'live' });
    const detail = await json(get(`/console/incidents/${inc.id}`, { who: OWNER }));
    expect(detail.deploys).toEqual([
      expect.objectContaining({ service: 'tournament', commit: 'aaaaaaa', running: true, suspect: true, message: 'Live API: batch writes' }),
      expect.objectContaining({ service: 'tournament', commit: 'bbbbbbb', running: false, suspect: false }),
    ]);
    expect(detail.liveEvents.map((t: any) => t.id)).toEqual(['t_live']);
    expect(detail.errorsPerMinute.length).toBeGreaterThanOrEqual(30);
    expect(detail.errorsPerMinute.reduce((a: number, p: any) => a + p.n, 0)).toBe(4);
  });
});

describe('scheduled', () => {
  it('runs checks on the minute cron and cleans up daily', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(probes());
    await runScheduled(env, '* * * * *', at(0));
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM checks').first<{ n: number }>();
    expect(n?.n).toBe(5);

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO checks (service, at, ok) VALUES ('web', ?, 1)").bind(now - 32 * DAY),
      env.DB.prepare("INSERT INTO error_reports (service, message, route, minute, count) VALUES ('web', 'm', 'r', ?, 1)").bind(now - 8 * DAY),
      env.DB.prepare("INSERT INTO error_reports (service, message, route, minute, count) VALUES ('web', 'm', 'r', ?, 1)").bind(now - HOUR),
    ]);
    await addOrg('org_gone', 'Gone Club', []);
    await env.DB.prepare("UPDATE organisations SET delete_at = ? WHERE id = 'org_gone'").bind(now - 1).run();
    await dailyCleanup(env, now);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM checks WHERE at < ?').bind(now - 31 * DAY).first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM error_reports').first<{ n: number }>())?.n).toBe(1);
    expect(await env.DB.prepare("SELECT 1 FROM organisations WHERE id = 'org_gone'").first()).toBeNull();
    expect((await auditRows()).find((a) => a.action === 'org.delete')).toMatchObject({ area: 'system', target: 'Gone Club' });
  });
});
