// /console/people: every Planary account, from planary-auth, with suspending, signing out, banning
// and the restrictions on their Planary Vault. planary-auth and planary-vault-api do the change;
// this records it in the audit log (target: the person's email) and words the mail they get.

import type { Hono } from 'hono';
import type { AuditEntry, PersonChange, PersonDetail, PersonRow, PersonStatus, VaultPerson } from '../contract';
import type { AppEnv, Env } from '../env';
import { auditStmt } from '../lib/audit';
import { ApiError, bad, clean, notFound, readJson } from '../lib/util';
import { actorOf, need } from './guard';
import type { CC } from './console';
import { vaultUsage } from './console';

const DAY = 86_400_000;
const STATUSES: readonly PersonStatus[] = ['active', 'suspended', 'banned'];

const notConnected = (what: string) => new ApiError(503, `${what} isn't connected yet.`, 'not_connected');

/** planary-auth's /api/internal/people…, with INTERNAL_KEY over the AUTH binding. */
async function auth<T>(env: Env, path: string, body?: unknown): Promise<T> {
  if (!env.INTERNAL_KEY) throw notConnected('Planary accounts');
  const res = await env.AUTH.fetch(
    new Request(`https://auth.internal/api/internal/people${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-internal-key': env.INTERNAL_KEY, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 404 && path) throw notFound(data.error || 'No Planary account with that id.');
  if (res.status === 404) throw notConnected('Planary accounts');
  if (res.status === 400) throw bad(data.error || 'That was refused.');
  if (res.status === 409) throw new ApiError(409, data.error || 'That was refused.', 'conflict');
  if (!res.ok) throw new ApiError(502, `planary-auth answered ${res.status}.`, 'upstream');
  return data;
}

/** planary-vault-api's /internal/users/:id…, over the VAULT binding (or VAULT_API locally). */
async function vault(env: Env, userId: string, body?: unknown): Promise<VaultPerson | null> {
  if (!env.INTERNAL_KEY_VAULT) throw notConnected('Planary Vault');
  const path = `/internal/users/${encodeURIComponent(userId)}${body === undefined ? '' : '/restrictions'}`;
  const init: RequestInit = {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-internal-key': env.INTERNAL_KEY_VAULT, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const base = (env.VAULT_API ?? '').trim().replace(/\/+$/, '');
  const res = env.VAULT
    ? await env.VAULT.fetch(new Request(`https://vault.internal${path}`, init))
    : /^https?:\/\//.test(base)
      ? await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(10_000) })
      : null;
  if (!res) throw notConnected('Planary Vault');
  if (res.status === 404 && body !== undefined) throw bad("This person doesn't have a vault.", 'no_vault');
  if (!res.ok) throw new ApiError(502, `Planary Vault answered ${res.status}.`, 'upstream');
  const data = (await res.json()) as { vault: unknown };
  return data.vault ? (vaultUsage({ people: [data.vault] }).people[0] ?? null) : null;
}

/** planary-auth's account, field by field. */
function personOut(raw: unknown): PersonRow {
  const p = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const s = (p.suspension ?? null) as Record<string, unknown> | null;
  return {
    id: clean(p.id, 64),
    name: clean(p.name, 80),
    email: clean(p.email, 254),
    verified: p.verified === true,
    createdAt: n(p.createdAt) ?? 0,
    lastSeen: n(p.lastSeen),
    signIn: Array.isArray(p.signIn) ? p.signIn.filter((x): x is string => typeof x === 'string').slice(0, 5) : [],
    status: STATUSES.includes(p.status as PersonStatus) ? (p.status as PersonStatus) : 'active',
    bannedAt: n(p.bannedAt),
    suspension: s ? { since: n(s.since) ?? 0, until: n(s.until), reason: clean(s.reason, 300) } : null,
  };
}

const zurich = (ms: number) => new Date(ms).toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' });

const GB = 1024 ** 3;
const size = (bytes: number) => (bytes >= GB ? `${Math.round((bytes / GB) * 10) / 10} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** Asks planary-auth to mail the person. A failed mail never undoes the change. */
async function mail(env: Env, id: string, subject: string, heading: string, body: string): Promise<boolean> {
  try {
    const res = await auth<{ mailed: boolean }>(env, `/${encodeURIComponent(id)}/notice`, { subject, heading, body });
    return res.mailed === true;
  } catch (error) {
    console.log(`notice mail failed: ${error}`);
    return false;
  }
}

async function record(c: CC, action: string, sentence: string, person: PersonRow, details: string | null) {
  await auditStmt(c.env, { area: 'people', actor: actorOf(c.get('staff')), action, sentence, target: person.email, details }).run();
}

const idOf = (c: CC) => {
  const id = c.req.param('id') ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw notFound('No Planary account with that id.');
  return id;
};

const flag = (v: unknown) => v !== false;

export function registerPeople(app: Hono<AppEnv>) {
  app.get('/people', need('people'), async (c) => {
    const q = clean(c.req.query('q'), 100);
    const status = c.req.query('status');
    const offset = Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0);
    const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(status === 'suspended' || status === 'banned' ? { status } : {}), offset: String(offset) });
    const data = await auth<{ people: unknown[]; more: boolean; counts: { all: number; suspended: number; banned: number } }>(c.env, `?${qs}`);
    return c.json({ people: (data.people ?? []).map(personOut), more: data.more === true, counts: data.counts });
  });

  app.get('/people/:id', need('people'), async (c) => {
    const id = idOf(c);
    const { person: raw } = await auth<{ person: unknown }>(c.env, `/${encodeURIComponent(id)}`);
    const person = personOut(raw);
    let v: PersonDetail['vault'];
    try {
      v = await vault(c.env, id);
    } catch {
      v = 'not_connected';
    }
    const { results } = await c.env.DB.prepare("SELECT * FROM audit_log WHERE area = 'people' AND target = ? ORDER BY id DESC LIMIT 50")
      .bind(person.email)
      .all<{ id: number; at: number; area: AuditEntry['area']; actor_id: string | null; actor_name: string | null; action: string; sentence: string; target: string | null; details: string | null }>();
    const history: AuditEntry[] = results.map((r) => ({
      id: String(r.id),
      at: r.at,
      area: r.area,
      actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? '' } : null,
      action: r.action,
      sentence: r.sentence,
      target: r.target,
      details: r.details,
    }));
    return c.json({ person, vault: v, history } satisfies PersonDetail);
  });

  app.post('/people/:id/suspend', need('people'), async (c) => {
    const id = idOf(c);
    const b = await readJson(c);
    const reason = clean(b.reason, 300);
    if (!reason) throw bad('Give a reason; the person sees it.', 'reason_required');
    const until = typeof b.until === 'number' && Number.isFinite(b.until) ? b.until : null;
    if (until !== null && (until <= Date.now() || until > Date.now() + 3650 * DAY)) throw bad('Pick an end within the next ten years.', 'invalid_until');
    const { person: raw } = await auth<{ person: unknown }>(c.env, `/${encodeURIComponent(id)}/suspend`, { until, reason });
    const person = personOut(raw);
    const when = until ? `until ${zurich(until)}` : 'until lifted';
    await record(c, 'person.suspend', `Suspended the account ${when}`, person, reason);
    const mailed = flag(b.notify)
      ? await mail(
          c.env,
          id,
          'Your Planary account is suspended',
          'Your account is suspended',
          `Planary staff suspended your Planary account ${until ? `until ${zurich(until)}` : 'until further notice'}. You can't sign in to any Planary app until then; nothing has been deleted.\n\nReason: ${reason}`,
        )
      : false;
    return c.json({ person, mailed } satisfies PersonChange);
  });

  app.post('/people/:id/unsuspend', need('people'), async (c) => {
    const id = idOf(c);
    const b = await readJson(c);
    const { person: raw } = await auth<{ person: unknown }>(c.env, `/${encodeURIComponent(id)}/unsuspend`, {});
    const person = personOut(raw);
    await record(c, 'person.unsuspend', 'Lifted the suspension', person, null);
    const mailed = flag(b.notify)
      ? await mail(c.env, id, 'Your Planary account works again', 'You can sign in again', 'Planary staff lifted the suspension of your Planary account. You can sign in to every Planary app again.')
      : false;
    return c.json({ person, mailed } satisfies PersonChange);
  });

  app.post('/people/:id/sign-out', need('people'), async (c) => {
    const id = idOf(c);
    const { person: raw } = await auth<{ person: unknown }>(c.env, `/${encodeURIComponent(id)}/sign-out`, {});
    const person = personOut(raw);
    await record(c, 'person.sign_out', 'Signed the account out on every device', person, null);
    return c.json({ person, mailed: false } satisfies PersonChange);
  });

  app.post('/people/:id/vault', need('people'), async (c) => {
    const id = idOf(c);
    const b = await readJson(c);
    const uploads = b.uploads !== false;
    const sharing = b.sharing !== false;
    const quota = b.quota === null || b.quota === undefined ? null : Number(b.quota);
    if (quota !== null && (!Number.isSafeInteger(quota) || quota < 0 || quota > 100 * 1024 ** 4)) throw bad('The storage limit has to be between 0 and 100 TB.', 'invalid_quota');
    const any = !uploads || !sharing || quota !== null;
    const reason = clean(b.reason, 300);
    if (any && !reason) throw bad('Give a reason; the person sees it.', 'reason_required');
    const { person: raw } = await auth<{ person: unknown }>(c.env, `/${encodeURIComponent(id)}`);
    const person = personOut(raw);
    const v = await vault(c.env, id, { uploads, sharing, quota, reason });
    const what = [!uploads && 'uploads off', !sharing && 'sharing off', quota !== null && `limit ${size(quota)}`].filter(Boolean).join(', ');
    await record(c, 'person.vault_restrict', any ? `Restricted the Vault: ${what}` : 'Lifted the Vault restrictions', person, any ? reason : null);
    const mailed = flag(b.notify)
      ? any
        ? await mail(
            c.env,
            id,
            'Changes to your Planary Vault',
            'Your vault is restricted',
            `Planary staff changed what your Planary Vault allows: ${what}. Your files stay readable and downloadable.\n\nReason: ${reason}`,
          )
        : await mail(c.env, id, 'Your Planary Vault works again', 'Your vault is back to normal', 'Planary staff lifted the restrictions on your Planary Vault. Uploads, sharing and storage follow your plan again.')
      : false;
    return c.json({ person, vault: v, mailed } satisfies PersonChange);
  });

  app.post('/people/:id/ban', need('people_ban'), async (c) => {
    const id = idOf(c);
    const b = await readJson(c);
    const reason = clean(b.reason, 300);
    if (!reason) throw bad('Give a reason for the ban.', 'reason_required');
    const { person: before } = await auth<{ person: unknown }>(c.env, `/${encodeURIComponent(id)}`);
    // Typed out by hand, so a ban never lands on the wrong row.
    if (clean(b.email, 254).toLowerCase() !== personOut(before).email.toLowerCase()) throw bad("Type the person's email to confirm.", 'confirm_email');
    const res = await auth<{ person: unknown; vault: 'deleted' | 'not_configured' | 'failed' }>(c.env, `/${encodeURIComponent(id)}/ban`, {});
    const person = personOut(res.person);
    await record(c, 'person.ban', 'Banned the account for good', person, `${reason} · Vault ${res.vault.replace('_', ' ')}`);
    const mailed = flag(b.notify)
      ? await mail(c.env, id, 'Your Planary account is closed', 'Your account is closed', `Planary closed your account for good. You can't sign in to any Planary app any more, and your Planary Vault has been deleted.\n\nReason: ${reason}`)
      : false;
    return c.json({ person, mailed, vaultDeleted: res.vault });
  });
}
