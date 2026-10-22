// /console/support: the support inbox. Staff replies are e-mailed to the requester; internal notes
// never leave the Console.

import type { Hono } from 'hono';
import type { RequestDetail, RequestStatus, StaffRole } from '../contract';
import type { AppEnv } from '../env';
import { auditStmt } from '../lib/audit';
import { sendMail } from '../lib/mail';
import { getOrg } from '../lib/orgs';
import { messagesOf, REQUEST_SELECT, requestSummary, STATUSES, type RequestRow } from '../lib/requests';
import { bad, notFound, oneOf, randomId, readJson, requireOneOf, requireText } from '../lib/util';
import { can } from '../permissions';
import { actorOf, need } from './guard';

const STATUS_WORD: Record<RequestStatus, string> = { open: 'open', waiting: 'waiting', done: 'done' };

export function registerSupport(app: Hono<AppEnv>) {
  app.get('/support', need('support'), async (c) => {
    const status = oneOf(c.req.query('status'), STATUSES);
    const who = oneOf(c.req.query('who'), ['all', 'mine', 'unassigned'] as const) ?? 'all';
    const me = c.get('staff');
    const whoSql = who === 'mine' ? 'r.assignee_id = ?' : who === 'unassigned' ? 'r.assignee_id IS NULL' : '1 = 1';
    const whoBind = who === 'mine' ? [me.id] : [];
    const [list, counts] = await Promise.all([
      c.env.DB.prepare(
        `${REQUEST_SELECT} WHERE ${whoSql}${status ? ' AND r.status = ?' : ''}
         ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, r.urgent DESC, r.updated_at DESC LIMIT 200`,
      )
        .bind(...whoBind, ...(status ? [status] : []))
        .all<RequestRow>(),
      c.env.DB.prepare(`SELECT r.status, COUNT(*) AS n FROM requests r WHERE ${whoSql} GROUP BY r.status`)
        .bind(...whoBind)
        .all<{ status: RequestStatus; n: number }>(),
    ]);
    const byStatus: Record<RequestStatus, number> = { open: 0, waiting: 0, done: 0 };
    for (const r of counts.results) byStatus[r.status] = r.n;
    // Who a request can be assigned to: signed-in staff whose role may edit the support inbox.
    const staff = await c.env.DB.prepare('SELECT id, name, email, role FROM staff WHERE user_id IS NOT NULL ORDER BY name').all<{ id: string; name: string; email: string; role: StaffRole }>();
    const assignable = staff.results.filter((s) => can(s.role, 'support', 'edit')).map((s) => ({ id: s.id, name: s.name || s.email }));
    return c.json({ requests: list.results.map(requestSummary), counts: byStatus, assignable });
  });

  const load = async (env: AppEnv['Bindings'], id: string) => {
    const row = await env.DB.prepare(`${REQUEST_SELECT} WHERE r.id = ? OR r.code = ?`).bind(id, id.toUpperCase()).first<RequestRow>();
    if (!row) throw notFound('No request with that id.');
    return row;
  };


  /** Opening a request marks it seen by staff (for `unread`). */
  app.get('/support/:id', need('support'), async (c) => {
    const row = await load(c.env, c.req.param('id'));
    const now = Date.now();
    await c.env.DB.prepare('UPDATE requests SET staff_seen_at = ? WHERE id = ?').bind(now, row.id).run();
    const org = row.org_id ? await getOrg(c.env, row.org_id, now) : null;
    const detail: RequestDetail = {
      ...requestSummary({ ...row, staff_seen_at: now }),
      plan: org?.plan ?? null,
      messages: await messagesOf(c.env, row.id, new URL(c.req.url).origin, true),
    };
    return c.json(detail);
  });

  app.post('/support/:id/messages', need('support'), async (c) => {
    const row = await load(c.env, c.req.param('id'));
    const body = await readJson(c);
    const kind = requireOneOf(body.kind, ['staff', 'internal'] as const, 'kind');
    const text = requireText(body.body, 'body', 10_000, { multiline: true });
    const setStatus = body.setStatus === undefined || body.setStatus === null ? null : requireOneOf(body.setStatus, STATUSES, 'setStatus');
    const me = c.get('staff');
    const now = Date.now();
    const DB = c.env.DB;
    const status = setStatus ?? row.status;
    await DB.batch([
      DB.prepare('INSERT INTO request_messages (id, request_id, kind, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        randomId('msg'),
        row.id,
        kind,
        me.id,
        me.name,
        text,
        now,
      ),
      DB.prepare(
        "UPDATE requests SET status = ?1, updated_at = ?2, staff_seen_at = ?2, done_at = CASE WHEN ?1 = 'done' THEN COALESCE(done_at, ?2) ELSE NULL END WHERE id = ?3",
      ).bind(status, now, row.id),
      auditStmt(c.env, {
        area: 'support',
        actor: actorOf(me),
        action: kind === 'staff' ? 'request.reply' : 'request.note',
        sentence: kind === 'staff' ? 'Replied to a support request' : 'Added an internal note',
        target: row.code,
        details: setStatus && setStatus !== row.status ? `set to ${STATUS_WORD[setStatus]}` : null,
      }),
    ]);
    if (kind === 'staff' && row.user_email) {
      const first = row.user_name.split(/\s+/)[0] || '';
      await sendMail(c.env, {
        to: row.user_email,
        subject: `Antwort auf deine Anfrage ${row.code}: ${row.subject}`,
        text:
          `Hallo${first ? ` ${first}` : ''}\n\n${text}\n\n` +
          (row.org_id ? `Du kannst im Portal antworten: ${c.env.PORTAL_URL}/support/${row.id}\n\n` : '') +
          `${me.name.split(/\s+/)[0]} von Planary`,
      });
    }
    return c.json({ ok: true });
  });

  app.post('/support/:id', need('support'), async (c) => {
    const row = await load(c.env, c.req.param('id'));
    const body = await readJson(c);
    const status = body.status === undefined ? null : requireOneOf(body.status, STATUSES, 'status');
    const hasAssignee = Object.prototype.hasOwnProperty.call(body, 'assigneeId');
    if (!status && !hasAssignee) throw bad('Send status or assigneeId.', 'nothing_to_change');
    let assignee: { id: string; name: string } | null = null;
    if (hasAssignee && body.assigneeId !== null) {
      if (typeof body.assigneeId !== 'string') throw bad('assigneeId must be a staff id or null.', 'invalid_assigneeId');
      assignee = await c.env.DB.prepare('SELECT id, name FROM staff WHERE id = ? AND user_id IS NOT NULL').bind(body.assigneeId).first<{ id: string; name: string }>();
      if (!assignee) throw bad('No active staff member with that id.', 'invalid_assigneeId');
    }
    const me = c.get('staff');
    const now = Date.now();
    const DB = c.env.DB;
    const stmts: D1PreparedStatement[] = [];
    if (status) {
      stmts.push(
        DB.prepare("UPDATE requests SET status = ?1, updated_at = ?2, done_at = CASE WHEN ?1 = 'done' THEN COALESCE(done_at, ?2) ELSE NULL END WHERE id = ?3").bind(status, now, row.id),
        auditStmt(c.env, { area: 'support', actor: actorOf(me), action: 'request.status', sentence: 'Changed the status of a support request', target: row.code, details: `${row.status} → ${status}` }),
      );
    }
    if (hasAssignee) {
      stmts.push(
        DB.prepare('UPDATE requests SET assignee_id = ?, updated_at = ? WHERE id = ?').bind(assignee?.id ?? null, now, row.id),
        auditStmt(c.env, {
          area: 'support',
          actor: actorOf(me),
          action: 'request.assign',
          sentence: assignee ? 'Assigned a support request' : 'Unassigned a support request',
          target: row.code,
          details: assignee ? assignee.name : null,
        }),
      );
    }
    await DB.batch(stmts);
    return c.json({ ok: true });
  });
}
