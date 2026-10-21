// Membership checks for /portal/orgs/:id/*: 404 for non-members, 403 for members where owners are needed.

import type { Context } from 'hono';
import type { MemberRole } from '../contract';
import type { AppEnv, PersonCtx } from '../env';
import { getOrg, type OrgRow } from '../lib/orgs';
import { forbidden, MINUTE, notFound } from '../lib/util';

type C = Context<AppEnv>;

export interface Membership {
  org: OrgRow;
  role: MemberRole;
  person: PersonCtx;
}

/** The organisation in the path, if the caller is a member; 404 otherwise. */
export async function memberOf(c: C): Promise<Membership> {
  const person = c.get('person');
  const orgId = c.req.param('id') ?? '';
  const now = Date.now();
  const [org, m] = await Promise.all([
    getOrg(c.env, orgId, now),
    c.env.DB.prepare('SELECT role, name, email, last_active FROM members WHERE org_id = ? AND user_id = ?')
      .bind(orgId, person.id)
      .first<{ role: MemberRole; name: string; email: string; last_active: number | null }>(),
  ]);
  if (!org || !m) throw notFound('No organisation with that id.');
  if (m.name !== person.name || m.email !== person.email || !m.last_active || now - m.last_active > MINUTE) {
    await c.env.DB.prepare('UPDATE members SET name = ?, email = ?, last_active = ? WHERE org_id = ? AND user_id = ?')
      .bind(person.name, person.email, now, orgId, person.id)
      .run();
  }
  return { org, role: m.role, person };
}

export async function ownerOf(c: C): Promise<Membership> {
  const m = await memberOf(c);
  if (m.role !== 'owner') throw forbidden('Only owners of the organisation can do that.', 'owner_only');
  return m;
}

export const portalActor = (p: PersonCtx) => ({ id: p.id, name: p.name });
