// The audit log. Every Console change writes one entry in the same DB.batch as the change.

import type { Area } from '../contract';
import type { Env } from '../env';

export interface AuditInput {
  area: Area | 'portal' | 'system';
  actor: { id: string; name: string } | null;
  /** Machine name, e.g. incident.update */
  action: string;
  /** Human sentence, e.g. "Posted an incident update" */
  sentence: string;
  target?: string | null;
  details?: string | null;
  /** Instead of `target`: read it with this query in the same batch (e.g. a code assigned there). */
  targetSql?: { sql: string; bind: unknown[] };
  at?: number;
}

export function auditStmt(env: Env, entry: AuditInput): D1PreparedStatement {
  const at = entry.at ?? Date.now();
  const details = entry.details == null ? null : String(entry.details).slice(0, 500);
  if (entry.targetSql) {
    return env.DB.prepare(
      `INSERT INTO audit_log (at, area, actor_id, actor_name, action, sentence, target, details)
       VALUES (?, ?, ?, ?, ?, ?, (${entry.targetSql.sql}), ?)`,
    ).bind(at, entry.area, entry.actor?.id ?? null, entry.actor?.name ?? null, entry.action, entry.sentence, ...entry.targetSql.bind, details);
  }
  return env.DB.prepare(
    'INSERT INTO audit_log (at, area, actor_id, actor_name, action, sentence, target, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(at, entry.area, entry.actor?.id ?? null, entry.actor?.name ?? null, entry.action, entry.sentence, entry.target ?? null, details);
}
