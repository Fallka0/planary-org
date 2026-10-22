// Support requests: rows → contract shapes for the Console and (without internal notes) the portal.

import type { Attachment, PortalRequest, RequestMessage, RequestStatus, RequestSummary, RequestTopic } from '../contract';
import type { Env } from '../env';
import { signedFileUrl } from './files';
import { shortDate, timeOfDay, zurichDay } from './util';

export const TOPICS: readonly RequestTopic[] = ['tournament', 'billing', 'plan', 'account', 'other'];
export const STATUSES: readonly RequestStatus[] = ['open', 'waiting', 'done'];

export interface RequestRow {
  id: string;
  code: string;
  org_id: string | null;
  org_name: string | null;
  user_id: string;
  user_name: string;
  user_email: string;
  topic: RequestTopic;
  subject: string;
  status: RequestStatus;
  urgent: number;
  tournament_id: string | null;
  tournament_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  created_at: number;
  updated_at: number;
  last_customer_at: number | null;
  staff_seen_at: number | null;
  done_at: number | null;
}

export const REQUEST_SELECT = `SELECT r.id, r.code, r.org_id, o.name AS org_name, r.user_id, r.user_name, r.user_email, r.topic, r.subject,
  r.status, r.urgent, r.tournament_id, r.tournament_name, r.assignee_id, st.name AS assignee_name, r.created_at, r.updated_at,
  r.last_customer_at, r.staff_seen_at, r.done_at
  FROM requests r LEFT JOIN organisations o ON o.id = r.org_id LEFT JOIN staff st ON st.id = r.assignee_id`;

export const isUnread = (r: Pick<RequestRow, 'last_customer_at' | 'staff_seen_at'>) =>
  r.last_customer_at != null && r.last_customer_at > (r.staff_seen_at ?? 0);

export function requestSummary(r: RequestRow): RequestSummary {
  return {
    id: r.id,
    code: r.code,
    subject: r.subject,
    topic: r.topic,
    status: r.status,
    urgent: r.urgent === 1,
    organisation: r.org_id ? { id: r.org_id, name: r.org_name ?? '' } : null,
    from: { id: r.user_id, name: r.user_name, email: r.user_email },
    tournament: r.tournament_id ? { id: r.tournament_id, name: r.tournament_name ?? '' } : null,
    assignee: r.assignee_id && r.assignee_name != null ? { id: r.assignee_id, name: r.assignee_name } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    unread: isUnread(r),
  };
}

function when(at: number, now: number, prefixTime: string, prefixDate: string) {
  return zurichDay(at) === zurichDay(now) ? `${prefixTime} ${timeOfDay(at)}` : `${prefixDate} ${shortDate(at)}`;
}

/** The German line under a request in the portal, from its status and last visible message. */
export function lastEvent(r: RequestRow, last: { kind: 'customer' | 'staff'; at: number } | null, now: number) {
  if (r.status === 'done') return `Erledigt am ${shortDate(r.done_at ?? r.updated_at)}`;
  if (r.status === 'waiting') return 'Wir brauchen noch eine Angabe von dir';
  if (last?.kind === 'staff') return `Planary hat ${when(last.at, now, 'um', 'am')} geantwortet`;
  return `Gesendet ${when(last?.at ?? r.created_at, now, 'um', 'am')}`;
}

export function portalRequest(r: RequestRow, last: { kind: 'customer' | 'staff'; at: number } | null, now: number): PortalRequest {
  const { unread: _unread, assignee: _assignee, ...rest } = requestSummary(r);
  return { ...rest, lastEvent: lastEvent(r, last, now), lastBy: last?.kind ?? 'customer' };
}

interface MessageRow {
  id: string;
  request_id: string;
  kind: 'customer' | 'staff' | 'internal';
  author_id: string;
  author_name: string;
  body: string;
  created_at: number;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  name: string;
  size: number;
  type: string;
}

/**
 * Messages of a request with signed attachment links. `includeInternal: false` filters internal
 * notes out in SQL, so neither the notes nor their attachments ever reach a portal response.
 */
export async function messagesOf(env: Env, requestId: string, origin: string, includeInternal: boolean): Promise<RequestMessage[]> {
  const filter = includeInternal ? '' : " AND kind <> 'internal'";
  const [messages, attachments] = await Promise.all([
    env.DB.prepare(`SELECT * FROM request_messages WHERE request_id = ?${filter} ORDER BY created_at, rowid`).bind(requestId).all<MessageRow>(),
    env.DB.prepare(
      `SELECT a.id, a.message_id, a.name, a.size, a.type FROM attachments a JOIN request_messages m ON m.id = a.message_id
       WHERE a.request_id = ?${includeInternal ? '' : " AND m.kind <> 'internal'"} ORDER BY a.created_at, a.rowid`,
    )
      .bind(requestId)
      .all<AttachmentRow>(),
  ]);
  const byMessage = new Map<string, Attachment[]>();
  for (const a of attachments.results) {
    const list = byMessage.get(a.message_id) ?? [];
    list.push({ id: a.id, name: a.name, size: a.size, type: a.type, url: await signedFileUrl(env, origin, a.id) });
    byMessage.set(a.message_id, list);
  }
  return messages.results.map((m) => ({
    id: m.id,
    kind: m.kind,
    author: { id: m.author_id, name: m.author_name },
    body: m.body,
    attachments: byMessage.get(m.id) ?? [],
    at: m.created_at,
  }));
}

/** Sequential codes (REQ-1185, INC-0043) assigned inside the insert, so a batch stays atomic. */
export const nextSeqSql = (table: 'requests' | 'incidents') => `(SELECT COALESCE(MAX(seq), 0) + 1 FROM ${table})`;
