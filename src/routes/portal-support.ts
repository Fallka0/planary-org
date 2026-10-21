// /portal/orgs/:id/requests: "Etwas stimmt nicht". Internal notes are filtered out in SQL
// (lib/requests.ts messagesOf) and never appear in any response here.

import type { Hono } from 'hono';
import type { PortalRequestDetail, PortalRequestMessage, RequestTopic } from '../contract';
import type { AppEnv, Env } from '../env';
import { auditStmt } from '../lib/audit';
import { imageType, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, safeFileName } from '../lib/files';
import { sendMail } from '../lib/mail';
import { messagesOf, nextSeqSql, portalRequest, REQUEST_SELECT, TOPICS, type RequestRow } from '../lib/requests';
import { ApiError, bad, clean, notFound, randomId, readJson, requireText } from '../lib/util';
import { memberOf, portalActor } from './portal-access';

type LastVisible = { request_id: string; kind: 'customer' | 'staff'; at: number };

async function lastVisible(env: Env, ids: string[]) {
  const out = new Map<string, LastVisible>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT m.request_id, m.kind, m.created_at AS at FROM request_messages m
     WHERE m.request_id IN (${marks}) AND m.kind <> 'internal'
       AND m.rowid = (SELECT m2.rowid FROM request_messages m2 WHERE m2.request_id = m.request_id AND m2.kind <> 'internal' ORDER BY m2.created_at DESC, m2.rowid DESC LIMIT 1)`,
  )
    .bind(...ids)
    .all<LastVisible>();
  for (const r of results) out.set(r.request_id, r);
  return out;
}

/** Staff appear as "Mykyta von Planary" in the portal, without their account id. */
function portalMessages(messages: Awaited<ReturnType<typeof messagesOf>>): PortalRequestMessage[] {
  return messages
    .filter((m) => m.kind !== 'internal')
    .map((m) => ({
      ...m,
      kind: m.kind as 'customer' | 'staff',
      author: m.kind === 'staff' ? { id: 'planary', name: `${m.author.name.split(/\s+/)[0] || 'Team'} von Planary` } : m.author,
    }));
}

interface Upload {
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
  bytes: Uint8Array;
}

/** Images from a form (`files` or `files[]`): PNG or JPG by their bytes, up to 10 MB each. */
async function readUploads(form: FormData, orgId: string): Promise<Upload[]> {
  const files = [...form.getAll('files[]'), ...form.getAll('files')].filter((f): f is File => typeof f !== 'string');
  if (files.length > MAX_ATTACHMENTS) throw bad(`Up to ${MAX_ATTACHMENTS} images.`, 'too_many_files');
  const uploads: Upload[] = [];
  for (const f of files) {
    if (f.size > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'Images may be up to 10 MB.', 'file_too_large');
    const bytes = new Uint8Array(await f.arrayBuffer());
    const type = imageType(bytes);
    if (!type) throw new ApiError(415, 'Images must be PNG or JPG.', 'invalid_file_type');
    const id = randomId('att');
    uploads.push({ id, key: `attachments/${orgId}/${id}`, name: safeFileName(f.name, type), size: bytes.length, type, bytes });
  }
  return uploads;
}

async function loadRequest(env: Env, orgId: string, rid: string) {
  const row = await env.DB.prepare(`${REQUEST_SELECT} WHERE r.org_id = ? AND (r.id = ? OR r.code = ?)`).bind(orgId, rid, rid.toUpperCase()).first<RequestRow>();
  if (!row) throw notFound('No request with that id.');
  return row;
}

const TOPIC_NAMES: Record<RequestTopic, string> = { tournament: 'Tournament', billing: 'Billing', plan: 'Plan', account: 'Team and account', other: 'Other' };

export function registerPortalSupport(app: Hono<AppEnv>) {
  app.get('/orgs/:id/requests', async (c) => {
    const { org } = await memberOf(c);
    const now = Date.now();
    const { results } = await c.env.DB.prepare(`${REQUEST_SELECT} WHERE r.org_id = ? ORDER BY CASE r.status WHEN 'done' THEN 1 ELSE 0 END, r.updated_at DESC LIMIT 200`)
      .bind(org.id)
      .all<RequestRow>();
    const last = await lastVisible(c.env, results.map((r) => r.id));
    return c.json({ requests: results.map((r) => portalRequest(r, last.get(r.id) ?? null, now)) });
  });

  app.get('/orgs/:id/requests/:rid', async (c) => {
    const { org } = await memberOf(c);
    const row = await loadRequest(c.env, org.id, c.req.param('rid'));
    const messages = portalMessages(await messagesOf(c.env, row.id, new URL(c.req.url).origin, false));
    const lastMsg = messages[messages.length - 1];
    const detail: PortalRequestDetail = { ...portalRequest(row, lastMsg ? { kind: lastMsg.kind, at: lastMsg.at } : null, Date.now()), messages };
    return c.json(detail);
  });

  /** Multipart: topic, subject, body, tournamentId?, urgent ('1'), files[] (PNG/JPG, 10 MB, up to 3). */
  app.post('/orgs/:id/requests', async (c) => {
    const { org, person } = await memberOf(c);
    const form = await c.req.formData().catch(() => {
      throw bad('Send the request as multipart form data.', 'invalid_form');
    });
    const field = (name: string) => {
      const v = form.get(name);
      return typeof v === 'string' ? v : '';
    };
    const topic = TOPICS.includes(field('topic') as RequestTopic) ? (field('topic') as RequestTopic) : null;
    if (!topic) throw bad(`topic must be one of ${TOPICS.join(', ')}.`, 'invalid_topic');
    const body = requireText(field('body'), 'body', 10_000, { multiline: true });
    const subject = clean(field('subject'), 120) || clean(body.split('\n')[0], 120);
    const urgent = field('urgent') === '1';
    let tournament: { id: string; name: string } | null = null;
    const tid = clean(field('tournamentId'), 100);
    if (tid) {
      tournament = await c.env.DB.prepare('SELECT id, name FROM tournaments WHERE id = ? AND organisation_id = ?').bind(tid, org.id).first<{ id: string; name: string }>();
      if (!tournament) throw bad('No tournament with that id in this organisation.', 'invalid_tournamentId');
    }

    const uploads = await readUploads(form, org.id);

    const id = randomId('req');
    const messageId = randomId('msg');
    const now = Date.now();
    for (const u of uploads) await c.env.FILES.put(u.key, u.bytes, { httpMetadata: { contentType: u.type } });
    const DB = c.env.DB;
    try {
      await DB.batch([
        DB.prepare(
          `INSERT INTO requests (id, seq, code, org_id, user_id, user_name, user_email, topic, subject, status, urgent, tournament_id, tournament_name, created_at, updated_at, last_customer_at)
           VALUES (?1, ${nextSeqSql('requests')}, printf('REQ-%04d', ${nextSeqSql('requests')}), ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, ?9, ?10, ?11, ?11, ?11)`,
        ).bind(id, org.id, person.id, person.name, person.email, topic, subject, urgent ? 1 : 0, tournament?.id ?? null, tournament?.name ?? null, now),
        DB.prepare("INSERT INTO request_messages (id, request_id, kind, author_id, author_name, body, created_at) VALUES (?, ?, 'customer', ?, ?, ?, ?)").bind(
          messageId,
          id,
          person.id,
          person.name,
          body,
          now,
        ),
        ...uploads.map((u) =>
          DB.prepare('INSERT INTO attachments (id, request_id, message_id, org_id, r2_key, name, size, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
            u.id,
            id,
            messageId,
            org.id,
            u.key,
            u.name,
            u.size,
            u.type,
            now,
          ),
        ),
        auditStmt(c.env, {
          area: 'portal',
          actor: portalActor(person),
          action: 'request.open',
          sentence: 'Opened a support request',
          targetSql: { sql: 'SELECT code FROM requests WHERE id = ?', bind: [id] },
          details: org.name,
        }),
      ]);
    } catch (error) {
      if (uploads.length) await c.env.FILES.delete(uploads.map((u) => u.key));
      throw error;
    }
    const code = (await DB.prepare('SELECT code FROM requests WHERE id = ?').bind(id).first<{ code: string }>())?.code ?? id;
    await sendMail(c.env, {
      to: c.env.STAFF_INBOX,
      replyTo: person.email || undefined,
      subject: `${urgent ? '[Urgent] ' : ''}New support request ${code}: ${subject}`,
      text:
        `${person.name} <${person.email}> from ${org.name} opened ${code}.\n\nTopic: ${TOPIC_NAMES[topic]}` +
        `${tournament ? `\nTournament: ${tournament.name}` : ''}${urgent ? '\nThe tournament is running now.' : ''}` +
        `${uploads.length ? `\nAttachments: ${uploads.length}` : ''}\n\n${body}\n\nOpen in the Console: ${c.env.CONSOLE_URL}/support/${id}`,
    });
    return c.json({ id });
  });

  app.post('/orgs/:id/requests/:rid/messages', async (c) => {
    const { org, person } = await memberOf(c);
    const row = await loadRequest(c.env, org.id, c.req.param('rid'));
    // JSON { body }, or form data with body and images.
    let raw: unknown;
    let uploads: Upload[] = [];
    if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
      const form = await c.req.formData().catch(() => {
        throw bad('Send the reply as JSON or multipart form data.', 'invalid_form');
      });
      raw = form.get('body');
      uploads = await readUploads(form, org.id);
    } else {
      raw = (await readJson(c)).body;
    }
    const text = requireText(raw, 'body', 10_000, { multiline: true });
    const now = Date.now();
    const DB = c.env.DB;
    const messageId = randomId('msg');
    for (const u of uploads) await c.env.FILES.put(u.key, u.bytes, { httpMetadata: { contentType: u.type } });
    // A customer's answer puts the request back in staff's queue.
    try {
      await DB.batch([
        DB.prepare("INSERT INTO request_messages (id, request_id, kind, author_id, author_name, body, created_at) VALUES (?, ?, 'customer', ?, ?, ?, ?)").bind(
          messageId,
          row.id,
          person.id,
          person.name,
          text,
          now,
        ),
        ...uploads.map((u) =>
          DB.prepare('INSERT INTO attachments (id, request_id, message_id, org_id, r2_key, name, size, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
            u.id,
            row.id,
            messageId,
            org.id,
            u.key,
            u.name,
            u.size,
            u.type,
            now,
          ),
        ),
        DB.prepare("UPDATE requests SET status = 'open', done_at = NULL, updated_at = ?1, last_customer_at = ?1 WHERE id = ?2").bind(now, row.id),
        auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'request.reply', sentence: 'Answered a support request', target: row.code, details: org.name }),
      ]);
    } catch (error) {
      if (uploads.length) await c.env.FILES.delete(uploads.map((u) => u.key));
      throw error;
    }
    await sendMail(c.env, {
      to: c.env.STAFF_INBOX,
      replyTo: person.email || undefined,
      subject: `${person.name} replied on ${row.code}: ${row.subject}`,
      text: `${person.name} <${person.email}> from ${org.name} wrote:\n\n${text}${uploads.length ? `\n\nAttachments: ${uploads.length}` : ''}\n\nOpen in the Console: ${c.env.CONSOLE_URL}/support/${row.id}`,
    });
    return c.json({ ok: true });
  });

  app.post('/orgs/:id/requests/:rid/done', async (c) => {
    const { org, person } = await memberOf(c);
    const row = await loadRequest(c.env, org.id, c.req.param('rid'));
    if (row.status === 'done') return c.json({ ok: true });
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE requests SET status = 'done', done_at = ?1, updated_at = ?1 WHERE id = ?2").bind(now, row.id),
      auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'request.done', sentence: 'Marked a support request as done', target: row.code, details: org.name }),
    ]);
    return c.json({ ok: true });
  });
}
