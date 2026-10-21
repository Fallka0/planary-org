// The services planary-org watches: health checks every minute, deploys from GitHub, the state
// machine that opens incidents, and the numbers behind the Console's status page.

import type { ServiceId, ServiceState, ServiceStatus } from './contract';
import type { Env } from './env';
import { auditStmt } from './lib/audit';
import { nextSeqSql } from './lib/requests';
import { DAY, MINUTE, median, randomId } from './lib/util';

export interface ServiceDef {
  id: ServiceId;
  name: string;
  host: string;
  url: string;
  /** GitHub repository (owner/name) for deploys. */
  repo: string | null;
  /** A check passes when the status is below this. */
  okBelow: number;
  timeoutMs: number;
}

export const SERVICE_IDS: readonly ServiceId[] = ['auth', 'tournament', 'casino', 'wishlist', 'web'];

const DEFAULTS: ServiceDef[] = [
  { id: 'auth', name: 'Account', host: 'auth.planary.ch', url: 'https://auth.planary.ch/', repo: 'Fallka0/planary-auth', okBelow: 500, timeoutMs: 10_000 },
  { id: 'tournament', name: 'Tournament', host: 'tournament.planary.ch', url: 'https://tournament.planary.ch/', repo: 'Fallka0/planary-tournament', okBelow: 500, timeoutMs: 10_000 },
  { id: 'casino', name: 'Casino', host: 'casino.planary.ch', url: 'https://casino.planary.ch/', repo: 'Fallka0/planary-casino', okBelow: 500, timeoutMs: 10_000 },
  { id: 'wishlist', name: 'Wishlist', host: 'wishlist.planary.ch', url: 'https://wishlist.planary.ch/', repo: 'Fallka0/planary-wishlist', okBelow: 500, timeoutMs: 10_000 },
  { id: 'web', name: 'planary.ch', host: 'planary.ch', url: 'https://planary.ch/', repo: 'Fallka0/planary-dashboard', okBelow: 500, timeoutMs: 10_000 },
];

/**
 * The services, with SERVICES_JSON applied: a JSON array of partial entries keyed by id, e.g.
 * [{"id":"tournament","url":"https://staging.tournament.planary.ch/health"}]. Unknown ids are ignored.
 */
export function services(env: Pick<Env, 'SERVICES_JSON'>): ServiceDef[] {
  if (!env.SERVICES_JSON) return DEFAULTS;
  let overrides: Partial<ServiceDef>[] = [];
  try {
    const parsed = JSON.parse(env.SERVICES_JSON);
    if (Array.isArray(parsed)) overrides = parsed;
  } catch {
    console.log('SERVICES_JSON is not valid JSON; using the defaults');
  }
  return DEFAULTS.map((d) => {
    const o = overrides.find((x) => x && x.id === d.id);
    if (!o) return d;
    const url = typeof o.url === 'string' && /^https?:\/\//.test(o.url) ? o.url : d.url;
    return {
      ...d,
      url,
      host: typeof o.host === 'string' ? o.host : new URL(url).host,
      name: typeof o.name === 'string' ? o.name : d.name,
      repo: typeof o.repo === 'string' || o.repo === null ? o.repo : d.repo,
      okBelow: typeof o.okBelow === 'number' ? o.okBelow : d.okBelow,
      timeoutMs: typeof o.timeoutMs === 'number' ? Math.min(30_000, Math.max(1_000, o.timeoutMs)) : d.timeoutMs,
    };
  });
}

export const serviceName = (env: Env, id: ServiceId) => services(env).find((s) => s.id === id)?.name ?? id;

const minuteOf = (t: number) => Math.floor(t / MINUTE) * MINUTE;

// ── Health checks ────────────────────────────────────

export interface CheckResult {
  ok: boolean;
  status: number | null;
  ms: number | null;
}

export async function probe(def: ServiceDef, fetcher: typeof fetch = fetch): Promise<CheckResult> {
  const started = Date.now();
  try {
    const res = await fetcher(def.url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'planary-org health check', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(def.timeoutMs),
    });
    const ms = Date.now() - started;
    await res.body?.cancel().catch(() => undefined);
    const ok = res.status < def.okBelow;
    return { ok, status: res.status, ms };
  } catch {
    return { ok: false, status: null, ms: null };
  }
}

/** Median latency of the last 5 successful checks above this → degraded. */
export const DEGRADED_MS = 2000;

/**
 * Runs one round of checks. A service is down after two failed checks in a row; then an incident
 * is opened for it unless an open one covers it. Coming back adds "Checks pass again." to that
 * incident once; it is never resolved automatically.
 */
export async function runChecks(env: Env, now = Date.now(), fetcher: typeof fetch = fetch) {
  const defs = services(env);
  const at = minuteOf(now);
  const results = await Promise.all(defs.map(async (d) => ({ def: d, result: await probe(d, fetcher) })));
  for (const { def, result } of results) {
    await recordCheck(env, def, at, result);
  }
  return results.map(({ def, result }) => ({ id: def.id, ...result }));
}

export async function recordCheck(env: Env, def: ServiceDef, at: number, result: CheckResult) {
  const DB = env.DB;
  await DB.prepare('INSERT OR REPLACE INTO checks (service, at, ok, status, ms) VALUES (?, ?, ?, ?, ?)')
    .bind(def.id, at, result.ok ? 1 : 0, result.status, result.ms)
    .run();

  const [recent, prev] = await Promise.all([
    DB.prepare('SELECT at, ok, ms FROM checks WHERE service = ? AND at <= ? ORDER BY at DESC LIMIT 5').bind(def.id, at).all<{ at: number; ok: number; ms: number | null }>(),
    DB.prepare('SELECT state, down_since FROM service_state WHERE service = ?').bind(def.id).first<{ state: ServiceState; down_since: number | null }>(),
  ]);
  const last = recent.results;
  const prevState: ServiceState = prev?.state ?? 'unknown';

  let state: ServiceState;
  let downSince: number | null = null;
  if (last.length >= 2 && last[0].ok === 0 && last[1].ok === 0) {
    state = 'down';
    downSince = prevState === 'down' && prev?.down_since ? prev.down_since : last[1].at;
  } else if (last[0]?.ok === 0) {
    state = prevState === 'down' ? 'ok' : prevState; // one failure isn't an outage yet
  } else {
    const m = median(last.filter((c) => c.ok === 1 && c.ms != null).map((c) => c.ms as number));
    state = m != null && m > DEGRADED_MS ? 'degraded' : 'ok';
  }

  const stmts: D1PreparedStatement[] = [
    DB.prepare(
      'INSERT INTO service_state (service, state, down_since, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (service) DO UPDATE SET state = excluded.state, down_since = excluded.down_since, updated_at = excluded.updated_at',
    ).bind(def.id, state, downSince, at),
  ];

  const open = await DB.prepare(
    `SELECT i.id, i.code, i.status FROM incidents i JOIN incident_services s ON s.incident_id = i.id
     WHERE s.service = ? AND i.status <> 'resolved' ORDER BY i.started_at DESC LIMIT 1`,
  )
    .bind(def.id)
    .first<{ id: string; code: string; status: string }>();

  if (state === 'down' && prevState !== 'down' && !open) {
    const id = randomId('inc');
    const startedAt = downSince ?? at;
    stmts.push(
      DB.prepare(
        `INSERT INTO incidents (id, seq, code, title, severity, status, started_at, show_to_organisers, created_by, created_by_name)
         VALUES (?1, ${nextSeqSql('incidents')}, printf('INC-%04d', ${nextSeqSql('incidents')}), ?2, 'major', 'investigating', ?3, 0, 'system', 'System')`,
      ).bind(id, `${def.name} is down`, startedAt),
      DB.prepare('INSERT INTO incident_services (incident_id, service) VALUES (?, ?)').bind(id, def.id),
      DB.prepare(
        "INSERT INTO incident_updates (id, incident_id, status, message, show_to_organisers, by_id, by_name, created_at) VALUES (?, ?, 'investigating', ?, 0, 'system', 'System', ?)",
      ).bind(randomId('upd'), id, 'Opened automatically: two health checks in a row failed.', at),
      auditStmt(env, {
        area: 'system',
        actor: null,
        action: 'incident.open',
        sentence: 'Opened an incident',
        targetSql: { sql: 'SELECT code FROM incidents WHERE id = ?', bind: [id] },
        details: `${def.name} failed two health checks in a row`,
        at,
      }),
    );
  }

  if (prevState === 'down' && state !== 'down' && open) {
    const lastUpdate = await DB.prepare('SELECT message FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .bind(open.id)
      .first<{ message: string }>();
    if (lastUpdate?.message !== RECOVERED) {
      stmts.push(
        DB.prepare(
          'INSERT INTO incident_updates (id, incident_id, status, message, show_to_organisers, by_id, by_name, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
        ).bind(randomId('upd'), open.id, open.status, RECOVERED, 'system', 'System', at),
      );
    }
  }

  await DB.batch(stmts);
  return state;
}

export const RECOVERED = 'Checks pass again.';

// ── Status numbers ───────────────────────────────────

interface DeployRow {
  service: ServiceId;
  id: string;
  at: number;
  commit_sha: string;
  author: string;
  message: string | null;
  url: string | null;
}

export async function serviceStatuses(env: Env, now = Date.now()): Promise<ServiceStatus[]> {
  const defs = services(env);
  const hourAgo = minuteOf(now) - 59 * MINUTE;
  const [states, lastHour, uptime, errors, deploys] = await Promise.all([
    env.DB.prepare('SELECT service, state, down_since FROM service_state').all<{ service: ServiceId; state: ServiceState; down_since: number | null }>(),
    env.DB.prepare('SELECT service, at, ok, ms FROM checks WHERE at >= ? ORDER BY at').bind(hourAgo).all<{ service: ServiceId; at: number; ok: number; ms: number | null }>(),
    env.DB.prepare('SELECT service, COUNT(*) AS n, SUM(ok) AS ok FROM checks WHERE at >= ? GROUP BY service').bind(now - 30 * DAY).all<{ service: ServiceId; n: number; ok: number }>(),
    env.DB.prepare('SELECT service, SUM(count) AS n FROM error_reports WHERE minute >= ? GROUP BY service').bind(now - DAY).all<{ service: ServiceId; n: number }>(),
    env.DB.prepare('SELECT d.* FROM deploys d WHERE d.at = (SELECT MAX(at) FROM deploys x WHERE x.service = d.service)').all<DeployRow>(),
  ]);
  return defs.map((d) => {
    const st = states.results.find((s) => s.service === d.id);
    const checks = lastHour.results.filter((c) => c.service === d.id);
    const byMinute = new Map(checks.map((c) => [c.at, c]));
    const spark = Array.from({ length: 60 }, (_, i) => {
      const c = byMinute.get(hourAgo + i * MINUTE);
      return c && c.ok === 1 ? c.ms : null;
    });
    const up = uptime.results.find((u) => u.service === d.id);
    const dep = deploys.results.find((x) => x.service === d.id);
    return {
      id: d.id,
      name: d.name,
      host: d.host,
      state: st?.state ?? 'unknown',
      downSince: st?.state === 'down' ? st.down_since : null,
      medianMs: median(checks.filter((c) => c.ok === 1 && c.ms != null).map((c) => c.ms as number)),
      spark,
      uptime30: up && up.n > 0 ? up.ok / up.n : null,
      errors24h: errors.results.find((e) => e.service === d.id)?.n ?? 0,
      deploy: dep ? { at: dep.at, commit: dep.commit_sha.slice(0, 7), author: dep.author, message: dep.message, url: dep.url } : null,
    };
  });
}

// ── Deploys (GitHub) ─────────────────────────────────

export const DEPLOY_REFRESH = 10 * MINUTE;
const DEPLOYS_PER_REPO = 5;

const firstLine = (message: string | undefined) => (message ? message.split('\n')[0].trim().slice(0, 200) || null : null);

async function github<T>(env: Env, path: string, fetcher: typeof fetch): Promise<T | null> {
  try {
    const res = await fetcher(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'planary-org',
      },
    });
    if (!res.ok) {
      console.log(`github ${path}: ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    console.log(`github ${path} failed: ${error}`);
    return null;
  }
}

interface GhDeployment {
  id: number;
  sha: string;
  created_at: string;
  creator?: { login?: string } | null;
}
interface GhCommit {
  sha: string;
  html_url?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } | null; committer?: { date?: string } | null };
  author?: { login?: string } | null;
}

/**
 * Refreshes the deploy cache at most every 10 minutes: the latest production deployments per
 * repository, or the latest commit on main when a repository has none. No-op without GITHUB_TOKEN.
 */
export async function refreshDeploys(env: Env, now = Date.now(), fetcher: typeof fetch = fetch, force = false) {
  if (!env.GITHUB_TOKEN) return false;
  if (!force) {
    const last = await env.DB.prepare("SELECT value FROM meta WHERE key = 'deploys_fetched_at'").first<{ value: string }>();
    if (last && now - Number(last.value) < DEPLOY_REFRESH) return false;
  }
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('deploys_fetched_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(String(now))
    .run();
  for (const def of services(env)) {
    if (!def.repo || !/^[\w.-]+\/[\w.-]+$/.test(def.repo)) continue;
    const stmts: D1PreparedStatement[] = [];
    const insert = (id: string, at: number, sha: string, author: string, message: string | null, url: string | null) =>
      env.DB.prepare(
        `INSERT INTO deploys (service, id, at, commit_sha, author, message, url) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (service, id) DO UPDATE SET at = excluded.at, commit_sha = excluded.commit_sha, author = excluded.author,
           message = COALESCE(excluded.message, deploys.message), url = excluded.url`,
      ).bind(def.id, id, at, sha, author.slice(0, 80), message, url);
    const deployments = await github<GhDeployment[]>(env, `/repos/${def.repo}/deployments?environment=production&per_page=${DEPLOYS_PER_REPO}`, fetcher);
    if (deployments && deployments.length > 0) {
      // Commit messages aren't on deployments: one lookup per commit not cached yet.
      const known = await env.DB.prepare('SELECT commit_sha FROM deploys WHERE service = ? AND message IS NOT NULL').bind(def.id).all<{ commit_sha: string }>();
      const cached = new Set(known.results.map((r) => r.commit_sha));
      for (const d of deployments.slice(0, DEPLOYS_PER_REPO)) {
        const at = Date.parse(d.created_at);
        if (!d.sha || !/^[0-9a-f]{7,40}$/i.test(d.sha) || !Number.isFinite(at)) continue;
        let message: string | null = null;
        if (!cached.has(d.sha)) {
          const commit = await github<GhCommit>(env, `/repos/${def.repo}/commits/${d.sha}`, fetcher);
          message = firstLine(commit?.commit?.message);
          cached.add(d.sha);
        }
        stmts.push(insert(`deployment:${d.id}`, at, d.sha, d.creator?.login ?? '', message, `https://github.com/${def.repo}/commit/${d.sha}`));
      }
    } else if (deployments) {
      const commits = await github<GhCommit[]>(env, `/repos/${def.repo}/commits?sha=main&per_page=1`, fetcher);
      const c = commits?.[0];
      const at = Date.parse(c?.commit?.committer?.date ?? c?.commit?.author?.date ?? '');
      if (c?.sha && Number.isFinite(at)) {
        stmts.push(
          insert(`commit:${c.sha}`, at, c.sha, c.commit?.author?.name ?? c.author?.login ?? '', firstLine(c.commit?.message), c.html_url ?? `https://github.com/${def.repo}/commit/${c.sha}`),
        );
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
  return true;
}

// ── Cleanup ──────────────────────────────────────────

export const CHECKS_KEEP = 31 * DAY;
export const ERRORS_KEEP = 7 * DAY;

export async function cleanUpMonitoring(env: Env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM checks WHERE at < ?').bind(now - CHECKS_KEEP),
    env.DB.prepare('DELETE FROM error_reports WHERE minute < ?').bind(now - ERRORS_KEEP),
    env.DB.prepare('DELETE FROM deploys WHERE at < ?').bind(now - 180 * DAY),
    env.DB.prepare('DELETE FROM provider_events WHERE received_at < ?').bind(now - 90 * DAY),
  ]);
}

