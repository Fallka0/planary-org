// /console/status and /console/incidents: service health, incidents and their updates.

import type { Hono } from 'hono';
import type { ErrorGroup, IncidentDetail, IncidentStatus, IncidentSummary, IncidentUpdate, ServiceId, Severity, StatusResponse } from '../contract';
import type { AppEnv, Env } from '../env';
import { auditStmt } from '../lib/audit';
import { sendMail } from '../lib/mail';
import { billingRecipients, ORGANISER_SERVICES } from '../lib/orgs';
import { nextSeqSql } from '../lib/requests';
import { TOURNAMENT_SELECT, tournamentOut, type TournamentRow } from '../lib/tournaments';
import { bad, HOUR, MINUTE, notFound, randomId, readJson, requireOneOf, requireText } from '../lib/util';
import { SERVICE_IDS, serviceName, serviceStatuses } from '../services';
import { actorOf, need } from './guard';

const SEVERITIES: readonly Severity[] = ['minor', 'major', 'critical'];
const INCIDENT_STATUSES: readonly IncidentStatus[] = ['investigating', 'identified', 'monitoring', 'resolved'];

interface IncidentRow {
  id: string;
  code: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  started_at: number;
  resolved_at: number | null;
  show_to_organisers: number;
  services: string | null;
}

const INCIDENT_SELECT = `SELECT i.*, (SELECT group_concat(service) FROM incident_services s WHERE s.incident_id = i.id) AS services FROM incidents i`;

function incidentOut(r: IncidentRow): IncidentSummary {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    severity: r.severity,
    status: r.status,
    services: (r.services ?? '').split(',').filter((s): s is ServiceId => (SERVICE_IDS as readonly string[]).includes(s)),
    startedAt: r.started_at,
    resolvedAt: r.resolved_at,
    showToOrganisers: r.show_to_organisers === 1,
  };
}

async function errorGroups(env: Env, service: ServiceId, since: number): Promise<ErrorGroup[]> {
  const { results } = await env.DB.prepare(
    'SELECT message, route, SUM(count) AS count, MAX(minute) AS lastAt FROM error_reports WHERE service = ? AND minute >= ? GROUP BY message, route ORDER BY count DESC LIMIT 10',
  )
    .bind(service, since)
    .all<ErrorGroup>();
  return results;
}

async function loadIncident(env: Env, id: string) {
  const row = await env.DB.prepare(`${INCIDENT_SELECT} WHERE i.id = ? OR i.code = ?`).bind(id, id.toUpperCase()).first<IncidentRow>();
  if (!row) throw notFound('No incident with that id.');
  return row;
}

/** Live tournaments on the affected services (only Tournament runs organisers' events for now). */
async function liveEventsFor(env: Env, services: ServiceId[]) {
  if (!services.some((s) => (ORGANISER_SERVICES as readonly string[]).includes(s))) return [];
  const { results } = await env.DB.prepare(`${TOURNAMENT_SELECT} WHERE t.state = 'live' ORDER BY t.viewers DESC LIMIT 200`).all<TournamentRow>();
  return results;
}

export function registerStatus(app: Hono<AppEnv>) {
  app.get('/status', need('overview'), async (c) => {
    const now = Date.now();
    const [services, open, recent] = await Promise.all([
      serviceStatuses(c.env, now),
      c.env.DB.prepare(`${INCIDENT_SELECT} WHERE i.status <> 'resolved' ORDER BY i.started_at DESC LIMIT 50`).all<IncidentRow>(),
      c.env.DB.prepare(`${INCIDENT_SELECT} WHERE i.status = 'resolved' ORDER BY i.started_at DESC LIMIT 10`).all<IncidentRow>(),
    ]);
    const groups: StatusResponse['errorGroups'] = {};
    for (const s of services.filter((x) => x.state === 'down')) groups[s.id] = await errorGroups(c.env, s.id, now - HOUR);
    const body: StatusResponse = { services, open: open.results.map(incidentOut), recent: recent.results.map(incidentOut), errorGroups: groups };
    return c.json(body);
  });

  app.get('/incidents/:id', need('incidents'), async (c) => {
    const now = Date.now();
    const row = await loadIncident(c.env, c.req.param('id'));
    const summary = incidentOut(row);
    const services = summary.services;
    const from = Math.floor((row.started_at - 30 * MINUTE) / MINUTE) * MINUTE;
    const until = Math.min(row.resolved_at ?? now, from + 12 * HOUR);
    const marks = services.map(() => '?').join(', ') || "''";
    const [updates, live, errors, deploys] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC, rowid DESC').bind(row.id).all<{
        id: string;
        status: IncidentStatus;
        message: string;
        show_to_organisers: number;
        by_name: string;
        created_at: number;
      }>(),
      liveEventsFor(c.env, services),
      c.env.DB.prepare(`SELECT minute, SUM(count) AS n FROM error_reports WHERE service IN (${marks}) AND minute >= ? AND minute <= ? GROUP BY minute`)
        .bind(...services, from, until)
        .all<{ minute: number; n: number }>(),
      c.env.DB.prepare(`SELECT * FROM deploys WHERE service IN (${marks}) ORDER BY at DESC LIMIT 50`)
        .bind(...services)
        .all<{ service: ServiceId; id: string; at: number; commit_sha: string; author: string; message: string | null }>(),
    ]);
    const perMinute = new Map(errors.results.map((e) => [e.minute, e.n]));
    const errorsPerMinute = [];
    for (let t = from; t <= until; t += MINUTE) errorsPerMinute.push({ at: t, n: perMinute.get(t) ?? 0 });

    const out: IncidentDetail['deploys'] = [];
    for (const service of services) {
      const list = deploys.results.filter((d) => d.service === service);
      const suspect = list.find((d) => d.at <= row.started_at && d.at >= row.started_at - HOUR);
      list.slice(0, 5).forEach((d, i) =>
        out.push({ service, at: d.at, commit: d.commit_sha.slice(0, 7), author: d.author, message: d.message, running: i === 0, suspect: d === suspect }),
      );
      if (suspect && !list.slice(0, 5).includes(suspect)) {
        out.push({ service, at: suspect.at, commit: suspect.commit_sha.slice(0, 7), author: suspect.author, message: suspect.message, running: false, suspect: true });
      }
    }
    out.sort((a, b) => b.at - a.at);

    const detail: IncidentDetail = {
      ...summary,
      updates: updates.results.map(
        (u): IncidentUpdate => ({ id: u.id, status: u.status, message: u.message, showToOrganisers: u.show_to_organisers === 1, by: u.by_name, at: u.created_at }),
      ),
      liveEvents: live.map(tournamentOut),
      errorsPerMinute,
      deploys: out,
    };
    return c.json(detail);
  });

  app.post('/incidents', need('incidents'), async (c) => {
    const body = await readJson(c);
    const title = requireText(body.title, 'title', 120);
    const severity = requireOneOf(body.severity, SEVERITIES, 'severity');
    const message = requireText(body.message, 'message', 2000, { multiline: true });
    if (!Array.isArray(body.services) || body.services.length === 0) throw bad('Pick at least one service.', 'invalid_services');
    const services = [...new Set(body.services.map((s) => requireOneOf(s, SERVICE_IDS, 'services')))];
    const me = c.get('staff');
    const now = Date.now();
    const id = randomId('inc');
    const DB = c.env.DB;
    await DB.batch([
      DB.prepare(
        `INSERT INTO incidents (id, seq, code, title, severity, status, started_at, show_to_organisers, created_by, created_by_name)
         VALUES (?1, ${nextSeqSql('incidents')}, printf('INC-%04d', ${nextSeqSql('incidents')}), ?2, ?3, 'investigating', ?4, 0, ?5, ?6)`,
      ).bind(id, title, severity, now, me.id, me.name),
      ...services.map((s) => DB.prepare('INSERT INTO incident_services (incident_id, service) VALUES (?, ?)').bind(id, s)),
      DB.prepare(
        "INSERT INTO incident_updates (id, incident_id, status, message, show_to_organisers, by_id, by_name, created_at) VALUES (?, ?, 'investigating', ?, 0, ?, ?, ?)",
      ).bind(randomId('upd'), id, message, me.id, me.name, now),
      auditStmt(c.env, {
        area: 'incidents',
        actor: actorOf(me),
        action: 'incident.open',
        sentence: 'Opened an incident',
        targetSql: { sql: 'SELECT code FROM incidents WHERE id = ?', bind: [id] },
        details: `${severity}, ${services.map((s) => serviceName(c.env, s)).join(', ')}`,
      }),
    ]);
    return c.json({ id });
  });

  app.post('/incidents/:id/updates', need('incidents'), async (c) => {
    const row = await loadIncident(c.env, c.req.param('id'));
    const body = await readJson(c);
    const status = requireOneOf(body.status, INCIDENT_STATUSES, 'status');
    const message = requireText(body.message, 'message', 2000, { multiline: true });
    if (body.showToOrganisers !== undefined && typeof body.showToOrganisers !== 'boolean') throw bad('showToOrganisers must be true or false.', 'invalid_showToOrganisers');
    const show = body.showToOrganisers === true;
    const me = c.get('staff');
    const now = Date.now();
    const DB = c.env.DB;
    await DB.batch([
      DB.prepare('INSERT INTO incident_updates (id, incident_id, status, message, show_to_organisers, by_id, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
        randomId('upd'),
        row.id,
        status,
        message,
        show ? 1 : 0,
        me.id,
        me.name,
        now,
      ),
      DB.prepare(
        `UPDATE incidents SET status = ?1, resolved_at = CASE WHEN ?1 = 'resolved' THEN COALESCE(resolved_at, ?2) ELSE NULL END,
           show_to_organisers = CASE WHEN ?3 = 1 THEN 1 ELSE show_to_organisers END WHERE id = ?4`,
      ).bind(status, now, show ? 1 : 0, row.id),
      auditStmt(c.env, {
        area: 'incidents',
        actor: actorOf(me),
        action: 'incident.update',
        sentence: 'Posted an incident update',
        target: row.code,
        details: `status: ${status}${show ? ', shown to organisers' : ''}`,
      }),
    ]);
    return c.json({ ok: true });
  });

  /** E-mails the organisations with a live tournament on an affected service. */
  app.post('/incidents/:id/notify', need('incidents'), async (c) => {
    const row = await loadIncident(c.env, c.req.param('id'));
    const body = await readJson(c);
    const message = requireText(body.message, 'message', 2000, { multiline: true });
    const services = incidentOut(row).services;
    const live = await liveEventsFor(c.env, services);
    const orgIds = [...new Set(live.map((t) => t.organisation_id).filter((x): x is string => Boolean(x)))];
    let mailed = 0;
    for (const orgId of orgIds) {
      const to = await billingRecipients(c.env, orgId);
      if (await sendMail(c.env, { to, subject: 'Störung bei Planary', text: `Hallo\n\n${message}\n\nPlanary` })) mailed++;
    }
    const me = c.get('staff');
    await c.env.DB.batch([
      auditStmt(c.env, {
        area: 'incidents',
        actor: actorOf(me),
        action: 'incident.notify',
        sentence: 'Notified organisers about an incident',
        target: row.code,
        details: `${orgIds.length} organisations, ${mailed} e-mails sent`,
      }),
    ]);
    return c.json({ organisations: orgIds.length });
  });
}
