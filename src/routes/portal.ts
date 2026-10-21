// /portal/*: the customer portal (portal.planary.ch). Any signed-in account; per organisation the
// account must be a member (404 otherwise, so an organisation's existence doesn't leak). Owners
// alone see billing and change settings and members (403 for members).

import { Hono, type Context } from 'hono';
import type { BillingContact, MemberRole, PortalInvite, PortalMember, PortalOrg, PortalOrgSummary } from '../contract';
import type { AppEnv, Env, PersonCtx } from '../env';
import { auditStmt } from '../lib/audit';
import { requirePerson } from '../lib/auth';
import { imageType, MAX_LOGO_BYTES } from '../lib/files';
import { sendMail } from '../lib/mail';
import { contactOf, contactOut, getOrg, ORG_SELECT, orgBanners, planCutoff, renewsAt, tournamentBanners, validSlug, type OrgRow } from '../lib/orgs';
import { THIS_YEAR_SQL, thisYear, TOURNAMENT_ORDER, TOURNAMENT_SELECT, organisersOf, tournamentOut, type TournamentRow } from '../lib/tournaments';
import {
  ApiError,
  bad,
  clean,
  conflict,
  DAY,
  email,
  forbidden,
  initials,
  MINUTE,
  notFound,
  randomId,
  randomToken,
  readJson,
  requireOneOf,
  requireText,
  sha256,
} from '../lib/util';
import { PLANS } from '../plans';
import { memberOf, ownerOf, portalActor } from './portal-access';
import { registerPortalBilling } from './portal-billing';
import { registerPortalSupport } from './portal-support';

export const portalApp = new Hono<AppEnv>();
type C = Context<AppEnv>;

export const INVITE_TTL = 14 * DAY;
export const DELETE_AFTER = 30 * DAY;
const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'member'];

portalApp.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  c.set('person', await requirePerson(c));
  await next();
});

// ── Me and organisations ─────────────────────────────

portalApp.get('/me', async (c) => {
  const person = c.get('person');
  const { results } = await c.env.DB.prepare(`SELECT x.*, m.role AS member_role FROM (${ORG_SELECT}) x JOIN members m ON m.org_id = x.id WHERE m.user_id = ? ORDER BY x.name`)
    .bind(planCutoff(Date.now()), person.id)
    .all<OrgRow & { member_role: MemberRole }>();
  const orgs: PortalOrgSummary[] = results.map((o) => ({ id: o.id, name: o.name, initials: initials(o.name), role: o.member_role, plan: o.plan }));
  return c.json({ me: { id: person.id, name: person.name, email: person.email }, orgs });
});

function orgName(value: unknown) {
  return requireText(value, 'name', 80, { min: 2 });
}

function slugOf(value: unknown) {
  const slug = clean(value, 41).toLowerCase();
  if (!validSlug(slug)) throw bad('The address may use a to z, 0 to 9 and dashes, 3 to 40 characters.', 'invalid_slug');
  return slug;
}

portalApp.post('/orgs', async (c) => {
  const person = c.get('person');
  const body = await readJson(c);
  const name = orgName(body.name);
  const slug = slugOf(body.slug);
  const owned = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND role = 'owner'").bind(person.id).first<{ n: number }>();
  if ((owned?.n ?? 0) >= 20) throw new ApiError(429, 'You already own 20 organisations.', 'too_many_orgs');
  if (await c.env.DB.prepare('SELECT 1 FROM organisations WHERE slug = ?').bind(slug).first()) throw conflict('That address is taken.', 'slug_taken');
  const id = randomId('org');
  const now = Date.now();
  const DB = c.env.DB;
  try {
    await DB.batch([
      DB.prepare('INSERT INTO organisations (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, slug, person.id, now),
      DB.prepare("INSERT INTO members (org_id, user_id, name, email, role, last_active, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)").bind(
        id,
        person.id,
        person.name,
        person.email,
        now,
        now,
      ),
      DB.prepare("INSERT INTO subscriptions (org_id, plan, state, updated_at) VALUES (?, 'gratis', 'none', ?)").bind(id, now),
      DB.prepare("INSERT INTO billing_contacts (org_id, email, phone, address, updated_at) VALUES (?, ?, '', '[]', ?)").bind(id, person.email, now),
      auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'org.create', sentence: 'Created an organisation', target: name, details: slug }),
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw conflict('That address is taken.', 'slug_taken');
    throw error;
  }
  return c.json({ id });
});

export function logoUrl(c: C, org: Pick<OrgRow, 'id' | 'logo_key'>) {
  if (!org.logo_key) return null;
  return `${new URL(c.req.url).origin}/logos/${org.id}?v=${encodeURIComponent(org.logo_key.split('/').pop() ?? '')}`;
}

portalApp.get('/orgs/:id', async (c) => {
  const { org, role } = await memberOf(c);
  const now = Date.now();
  const isOwner = role === 'owner';
  const DB = c.env.DB;
  const [contact, usage, members, pendingInvites, anyTournament, banners, openRequests, overdue] = await Promise.all([
    contactOf(c.env, org.id),
    DB.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(t.max_teams), 0) AS largest FROM tournaments t WHERE t.organisation_id = ? AND ${THIS_YEAR_SQL}`)
      .bind(org.id, thisYear(now))
      .first<{ n: number; largest: number }>(),
    DB.prepare('SELECT COUNT(*) AS n FROM members WHERE org_id = ?').bind(org.id).first<{ n: number }>(),
    DB.prepare('SELECT COUNT(*) AS n FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND withdrawn_at IS NULL AND expires_at > ?').bind(org.id, now).first<{ n: number }>(),
    DB.prepare('SELECT 1 AS x FROM tournaments WHERE organisation_id = ? LIMIT 1').bind(org.id).first(),
    orgBanners(c.env, org.id, isOwner, now),
    DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE org_id = ? AND status <> 'done'").bind(org.id).first<{ n: number }>(),
    DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE org_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ?").bind(org.id, now).first<{ n: number }>(),
  ]);
  const body: PortalOrg = {
    id: org.id,
    name: org.name,
    initials: initials(org.name),
    slug: org.slug,
    logoUrl: logoUrl(c, org),
    role,
    plan: PLANS[org.plan],
    renewsAt: isOwner ? renewsAt(org) : null,
    createdAt: org.created_at,
    // Billing contact and invoices are owners' business.
    contact: isOwner ? contactOut(contact) : { email: '', phone: '', address: [] },
    usage: { tournamentsThisYear: usage?.n ?? 0, largestTournament: usage?.largest ?? 0, organisers: members?.n ?? 0 },
    onboarding: { logo: Boolean(org.logo_key), team: (members?.n ?? 0) > 1 || (pendingInvites?.n ?? 0) > 0, tournament: Boolean(anyTournament) },
    banners,
    counts: { openRequests: openRequests?.n ?? 0, overdueInvoices: isOwner ? (overdue?.n ?? 0) : 0 },
  };
  return c.json(body);
});

function contactIn(value: unknown): BillingContact {
  if (!value || typeof value !== 'object') throw bad('contact must be an object.', 'invalid_contact');
  const v = value as Record<string, unknown>;
  const mail = v.email === '' || v.email == null ? '' : email(v.email);
  if (mail === null) throw bad('Enter a valid e-mail address.', 'invalid_email');
  const phone = clean(v.phone, 41);
  if (phone.length > 40 || (phone && !/^[+()\d\s./-]{3,40}$/.test(phone))) throw bad('Enter a valid phone number.', 'invalid_phone');
  if (v.address !== undefined && !Array.isArray(v.address)) throw bad('address must be a list of lines.', 'invalid_address');
  const lines = ((v.address as unknown[]) ?? []).map((l) => clean(l, 101)).filter(Boolean);
  if (lines.length > 6 || lines.some((l) => l.length > 100)) throw bad('Up to 6 address lines of 100 characters.', 'invalid_address');
  return { email: mail, phone, address: lines };
}

portalApp.post('/orgs/:id', async (c) => {
  const { org, person } = await ownerOf(c);
  const body = await readJson(c);
  const DB = c.env.DB;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const changed: string[] = [];
  if (body.name !== undefined) {
    const name = orgName(body.name);
    if (name !== org.name) {
      stmts.push(DB.prepare('UPDATE organisations SET name = ? WHERE id = ?').bind(name, org.id));
      changed.push('name');
    }
  }
  if (body.slug !== undefined) {
    const slug = slugOf(body.slug);
    if (slug !== org.slug) {
      if (await DB.prepare('SELECT 1 FROM organisations WHERE slug = ? AND id <> ?').bind(slug, org.id).first()) throw conflict('That address is taken.', 'slug_taken');
      stmts.push(DB.prepare('UPDATE organisations SET slug = ? WHERE id = ?').bind(slug, org.id));
      changed.push('address');
    }
  }
  if (body.contact !== undefined) {
    const contact = contactIn(body.contact);
    stmts.push(
      DB.prepare(
        `INSERT INTO billing_contacts (org_id, email, phone, address, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (org_id) DO UPDATE SET email = excluded.email, phone = excluded.phone, address = excluded.address, updated_at = excluded.updated_at`,
      ).bind(org.id, contact.email, contact.phone, JSON.stringify(contact.address), now),
    );
    changed.push('contact');
  }
  if (stmts.length === 0) return c.json({ ok: true });
  stmts.push(auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'org.settings', sentence: 'Changed the organisation settings', target: org.name, details: changed.join(', ') }));
  try {
    await DB.batch(stmts);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw conflict('That address is taken.', 'slug_taken');
    throw error;
  }
  return c.json({ ok: true });
});

portalApp.post('/orgs/:id/logo', async (c) => {
  const { org, person } = await ownerOf(c);
  const form = await c.req.formData().catch(() => {
    throw bad('Send the logo as multipart form data (field "file").', 'invalid_form');
  });
  const file = form.get('file') ?? form.get('logo');
  if (!file || typeof file === 'string') throw bad('Add a PNG or JPG file.', 'invalid_file');
  if (file.size > MAX_LOGO_BYTES) throw new ApiError(413, 'The logo may be up to 2 MB.', 'file_too_large');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = imageType(bytes);
  if (!type) throw new ApiError(415, 'The logo must be a PNG or JPG.', 'invalid_file_type');
  const key = `logos/${org.id}/${randomId('logo')}`;
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE organisations SET logo_key = ? WHERE id = ?').bind(key, org.id),
    auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'org.logo', sentence: 'Changed the logo', target: org.name, details: null }),
  ]);
  if (org.logo_key) await c.env.FILES.delete(org.logo_key);
  return c.json({ logoUrl: logoUrl(c, { id: org.id, logo_key: key }) as string });
});

portalApp.post('/orgs/:id/delete', async (c) => {
  const { org, person } = await ownerOf(c);
  const body = await readJson(c);
  if (typeof body.confirm !== 'string' || body.confirm.trim() !== org.name) throw bad('Type the organisation name to confirm.', 'confirm_mismatch');
  const deleteAt = org.delete_at ?? Date.now() + DELETE_AFTER;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE organisations SET delete_at = ? WHERE id = ?').bind(deleteAt, org.id),
    auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'org.delete_request', sentence: 'Asked to delete an organisation', target: org.name, details: `deletion on ${new Date(deleteAt).toISOString().slice(0, 10)}` }),
  ]);
  return c.json({ deleteAt });
});

// ── Tournaments ──────────────────────────────────────

portalApp.get('/orgs/:id/tournaments', async (c) => {
  const { org } = await memberOf(c);
  const { results } = await c.env.DB.prepare(`${TOURNAMENT_SELECT} WHERE t.organisation_id = ? ORDER BY ${TOURNAMENT_ORDER} LIMIT 500`).bind(org.id).all<TournamentRow>();
  return c.json({ tournaments: results.map(tournamentOut) });
});

portalApp.get('/orgs/:id/tournaments/:tid', async (c) => {
  const { org } = await memberOf(c);
  const t = await c.env.DB.prepare(`${TOURNAMENT_SELECT} WHERE t.id = ? AND t.organisation_id = ?`).bind(c.req.param('tid'), org.id).first<TournamentRow>();
  if (!t) throw notFound('No tournament with that id.');
  const summary = tournamentOut(t);
  return c.json({ ...summary, organisers: organisersOf(t), played: t.played, matches: t.matches, banners: await tournamentBanners(c.env, summary, Date.now()) });
});

// ── Members and invitations ──────────────────────────

const seatsOf = (org: OrgRow) => PLANS[org.plan].limits.maxOrganisers;

async function seatsUsed(env: Env, orgId: string, now: number) {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM members WHERE org_id = ?1)
          + (SELECT COUNT(*) FROM invitations WHERE org_id = ?1 AND accepted_at IS NULL AND withdrawn_at IS NULL AND expires_at > ?2) AS n`,
  )
    .bind(orgId, now)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

portalApp.get('/orgs/:id/members', async (c) => {
  const { org, person, role } = await memberOf(c);
  const now = Date.now();
  const [members, invites] = await Promise.all([
    c.env.DB.prepare("SELECT user_id, name, email, role, last_active FROM members WHERE org_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, name")
      .bind(org.id)
      .all<{ user_id: string; name: string; email: string; role: MemberRole; last_active: number | null }>(),
    role === 'owner'
      ? c.env.DB.prepare('SELECT id, email, role, sent_at FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND withdrawn_at IS NULL AND expires_at > ? ORDER BY sent_at DESC')
          .bind(org.id, now)
          .all<{ id: string; email: string; role: MemberRole; sent_at: number }>()
      : Promise.resolve({ results: [] as { id: string; email: string; role: MemberRole; sent_at: number }[] }),
  ]);
  const list: PortalMember[] = members.results.map((m) => ({ id: m.user_id, name: m.name, email: m.email, role: m.role, lastActive: m.last_active, me: m.user_id === person.id }));
  const inv: PortalInvite[] = invites.results.map((i) => ({ id: i.id, email: i.email, role: i.role, sentAt: i.sent_at }));
  return c.json({ members: list, invites: inv, seats: seatsOf(org) });
});

async function mailInvite(c: C, org: OrgRow, inviter: PersonCtx, to: string, token: string) {
  const link = `${c.env.PORTAL_URL}/einladung/${token}`;
  return sendMail(c.env, {
    to,
    subject: `Einladung zu ${org.name} auf Planary`,
    text:
      `Hallo\n\n${inviter.name} lädt dich ein, bei ${org.name} auf Planary Turniere zu organisieren.\n\n` +
      `Einladung annehmen: ${link}\n\nMelde dich dafür mit dem Planary-Konto für ${to} an. Der Link ist 14 Tage gültig.\n\nPlanary`,
  });
}

portalApp.post('/orgs/:id/invites', async (c) => {
  const { org, person } = await ownerOf(c);
  const body = await readJson(c);
  const addr = email(body.email);
  if (!addr) throw bad('Enter a valid e-mail address.', 'invalid_email');
  const role = requireOneOf(body.role ?? 'member', MEMBER_ROLES, 'role');
  const now = Date.now();
  const DB = c.env.DB;
  if (await DB.prepare('SELECT 1 FROM members WHERE org_id = ? AND email = ?').bind(org.id, addr).first()) throw conflict('That person is already in the team.', 'already_member');
  if (await DB.prepare('SELECT 1 FROM invitations WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND withdrawn_at IS NULL AND expires_at > ?').bind(org.id, addr, now).first())
    throw conflict('That person is already invited.', 'already_invited');
  if ((await seatsUsed(c.env, org.id, now)) >= seatsOf(org)) throw conflict('All seats of your plan are taken.', 'seats_full');
  const token = randomToken();
  await DB.batch([
    DB.prepare('INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
      randomId('invite'),
      org.id,
      addr,
      role,
      await sha256(token),
      person.id,
      now,
      now + INVITE_TTL,
    ),
    auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'member.invite', sentence: 'Invited someone to an organisation', target: org.name, details: `${addr} as ${role}` }),
  ]);
  await mailInvite(c, org, person, addr, token);
  return c.json({ ok: true });
});

async function pendingInvite(c: C, orgId: string) {
  const inv = await c.env.DB.prepare('SELECT * FROM invitations WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND withdrawn_at IS NULL')
    .bind(c.req.param('iid'), orgId)
    .first<{ id: string; email: string; role: MemberRole; expires_at: number }>();
  if (!inv) throw notFound('No open invitation with that id.');
  return inv;
}

/** A new link (the old one stops working) and 14 more days. */
portalApp.post('/orgs/:id/invites/:iid/resend', async (c) => {
  const { org, person } = await ownerOf(c);
  const inv = await pendingInvite(c, org.id);
  const now = Date.now();
  const token = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE invitations SET token_hash = ?, sent_at = ?, expires_at = ? WHERE id = ?').bind(await sha256(token), now, now + INVITE_TTL, inv.id),
    auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'member.invite_resend', sentence: 'Sent an invitation again', target: org.name, details: inv.email }),
  ]);
  await mailInvite(c, org, person, inv.email, token);
  return c.json({ ok: true });
});

portalApp.post('/orgs/:id/invites/:iid/withdraw', async (c) => {
  const { org, person } = await ownerOf(c);
  const inv = await pendingInvite(c, org.id);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE invitations SET withdrawn_at = ? WHERE id = ?').bind(Date.now(), inv.id),
    auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'member.invite_withdraw', sentence: 'Withdrew an invitation', target: org.name, details: inv.email }),
  ]);
  return c.json({ ok: true });
});

portalApp.post('/invites/:token/accept', async (c) => {
  const person = c.get('person');
  const token = c.req.param('token');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notFound('This invitation is not valid.');
  const now = Date.now();
  const inv = await c.env.DB.prepare('SELECT * FROM invitations WHERE token_hash = ?').bind(await sha256(token)).first<{
    id: string;
    org_id: string;
    email: string;
    role: MemberRole;
    expires_at: number;
    accepted_at: number | null;
    withdrawn_at: number | null;
  }>();
  if (!inv || inv.withdrawn_at) throw notFound('This invitation is not valid.');
  if (inv.accepted_at) {
    const already = await c.env.DB.prepare('SELECT 1 FROM members WHERE org_id = ? AND user_id = ?').bind(inv.org_id, person.id).first();
    if (already) return c.json({ orgId: inv.org_id });
    throw new ApiError(410, 'This invitation was already used.', 'invite_used');
  }
  if (inv.expires_at < now) throw new ApiError(410, 'This invitation has expired. Ask for a new one.', 'invite_expired');
  if (!person.email || person.email !== inv.email.toLowerCase()) throw forbidden(`This invitation is for ${inv.email}. Sign in with that account.`, 'email_mismatch');
  const org = await getOrg(c.env, inv.org_id, now);
  if (!org) throw notFound('This invitation is not valid.');
  const existing = await c.env.DB.prepare('SELECT 1 FROM members WHERE org_id = ? AND user_id = ?').bind(org.id, person.id).first();
  const members = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE org_id = ?').bind(org.id).first<{ n: number }>();
  if (!existing && (members?.n ?? 0) >= seatsOf(org)) throw conflict('All seats of this plan are taken.', 'seats_full');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').bind(now, inv.id),
    c.env.DB.prepare('INSERT OR IGNORE INTO members (org_id, user_id, name, email, role, last_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      org.id,
      person.id,
      person.name,
      person.email,
      inv.role,
      now,
      now,
    ),
    auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'member.join', sentence: 'Joined an organisation', target: org.name, details: inv.role }),
  ]);
  return c.json({ orgId: org.id });
});

async function memberTarget(c: C, orgId: string) {
  const m = await c.env.DB.prepare('SELECT user_id, name, email, role FROM members WHERE org_id = ? AND user_id = ?')
    .bind(orgId, c.req.param('uid'))
    .first<{ user_id: string; name: string; email: string; role: MemberRole }>();
  if (!m) throw notFound('No member with that id.');
  return m;
}

async function otherOwners(env: Env, orgId: string, userId: string) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE org_id = ? AND role = 'owner' AND user_id <> ?").bind(orgId, userId).first<{ n: number }>();
  return r?.n ?? 0;
}

portalApp.post('/orgs/:id/members/:uid/remove', async (c) => {
  const { org, person } = await ownerOf(c);
  const m = await memberTarget(c, org.id);
  if (m.role === 'owner' && (await otherOwners(c.env, org.id, m.user_id)) === 0) throw conflict("The last owner can't be removed.", 'last_owner');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM members WHERE org_id = ? AND user_id = ?').bind(org.id, m.user_id),
    auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'member.remove', sentence: 'Removed a member', target: org.name, details: m.name || m.email }),
  ]);
  return c.json({ ok: true });
});

portalApp.post('/orgs/:id/members/:uid', async (c) => {
  const { org, person } = await ownerOf(c);
  const m = await memberTarget(c, org.id);
  const body = await readJson(c);
  const role = requireOneOf(body.role, MEMBER_ROLES, 'role');
  if (role === m.role) return c.json({ ok: true });
  if (m.role === 'owner' && (await otherOwners(c.env, org.id, m.user_id)) === 0) throw conflict("The last owner can't be made a member.", 'last_owner');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE members SET role = ? WHERE org_id = ? AND user_id = ?').bind(role, org.id, m.user_id),
    auditStmt(c.env, { area: 'portal', actor: portalActor(person), action: 'member.role', sentence: "Changed a member's role", target: org.name, details: `${m.name || m.email}: ${m.role} → ${role}` }),
  ]);
  return c.json({ ok: true });
});

registerPortalBilling(portalApp);
registerPortalSupport(portalApp);
