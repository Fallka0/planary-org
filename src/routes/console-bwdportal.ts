// /console/bwdportal: the bwd Portal (school portal of the bwd Bern). Accounts with their role (student, teacher),
// teachers' assignments (class and subject), classes and their class teacher. The portal does the change over its
// /api/internal (BWDPORTAL binding, INTERNAL_KEY_BWDPORTAL); this checks the Console role and writes the audit log
// (target: the person's school address or the class).

import type { Hono } from 'hono';
import type { BwdAssignment, BwdClass, BwdPerson, BwdRole, BwdSubject } from '../contract';
import type { AppEnv, Env } from '../env';
import { auditStmt } from '../lib/audit';
import { ApiError, bad, clean, notFound, readJson } from '../lib/util';
import { actorOf, need } from './guard';
import type { CC } from './console';

const notConnected = () => new ApiError(503, "The bwd Portal isn't connected yet.", 'not_connected');

/** The portal's /api/internal…, over the BWDPORTAL binding (or BWDPORTAL_API locally). */
async function portal<T>(env: Env, path: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET', body?: unknown): Promise<T> {
  if (!env.INTERNAL_KEY_BWDPORTAL) throw notConnected();
  const init: RequestInit = {
    method,
    headers: { 'x-internal-key': env.INTERNAL_KEY_BWDPORTAL, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const base = (env.BWDPORTAL_API ?? '').trim().replace(/\/+$/, '');
  const res = env.BWDPORTAL
    ? await env.BWDPORTAL.fetch(new Request(`https://bwdportal.internal/api/internal${path}`, init))
    : /^https?:\/\//.test(base)
      ? await fetch(`${base}/api/internal${path}`, { ...init, signal: AbortSignal.timeout(10_000) })
      : null;
  if (!res) throw notConnected();
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: string } };
  const message = data.error?.message;
  if (res.status === 404) throw notFound(message || 'Not found in the bwd Portal.');
  if (res.status === 409) throw new ApiError(409, message || 'That was refused.', 'conflict');
  if (res.status === 422 || res.status === 400) throw bad(message || 'That was refused.');
  if (res.status === 401 || res.status === 503) throw notConnected();
  if (!res.ok) throw new ApiError(502, `The bwd Portal answered ${res.status}.`, 'upstream');
  return data;
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const role = (v: unknown): BwdRole => (v === 'teacher' ? 'teacher' : 'student');
const assignment = (v: unknown): BwdAssignment | null => {
  const a = v as Record<string, unknown> | null;
  return a && typeof a.classCode === 'string' && typeof a.subject === 'string' ? { classCode: str(a.classCode, 12), subject: str(a.subject, 8) } : null;
};

/** The portal's account, field by field: only what the Console shows passes. */
export function bwdPerson(raw: unknown): BwdPerson {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(p.id, 80),
    name: str(p.name),
    email: str(p.email),
    role: role(p.role),
    classCode: typeof p.classCode === 'string' ? str(p.classCode, 12) : null,
    lastLoginAt: typeof p.lastLoginAt === 'string' ? str(p.lastLoginAt, 25) : null,
    assignments: Array.isArray(p.assignments) ? p.assignments.map(assignment).filter((a): a is BwdAssignment => !!a) : [],
    classTeacherOf: Array.isArray(p.classTeacherOf) ? p.classTeacherOf.filter((c): c is string => typeof c === 'string').map((c) => str(c, 12)) : [],
  };
}

export function bwdClass(raw: unknown): BwdClass {
  const c = (raw ?? {}) as Record<string, unknown>;
  const kt = c.classTeacher as Record<string, unknown> | null;
  return {
    id: str(c.id, 80),
    code: str(c.code, 12),
    program: typeof c.program === 'string' ? str(c.program, 120) : null,
    classTeacher: kt && typeof kt.id === 'string' ? { id: str(kt.id, 80), name: str(kt.name) } : null,
    students: Number(c.students) || 0,
    teachers: Number(c.teachers) || 0,
  };
}

const describe = (list: BwdAssignment[]) => (list.length ? list.map((a) => `${a.subject} in ${a.classCode}`).join(', ') : 'none');

export function registerBwdPortal(app: Hono<AppEnv>) {
  const audit = (c: CC, action: string, sentence: string, target: string, details?: string) =>
    auditStmt(c.env, { area: 'bwdportal', actor: actorOf(c.get('staff')), action, sentence, target, details }).run();

  app.get('/bwdportal/people', need('bwdportal'), async (c) => {
    const q = new URLSearchParams();
    for (const k of ['q', 'role', 'class']) {
      const v = clean(c.req.query(k), 80);
      if (v) q.set(k, v);
    }
    const data = await portal<{ people?: unknown[] }>(c.env, `/people${q.size ? `?${q}` : ''}`);
    return c.json({ people: (data.people ?? []).map(bwdPerson) });
  });

  app.get('/bwdportal/people/:id', need('bwdportal'), async (c) => c.json(bwdPerson(await portal(c.env, `/people/${encodeURIComponent(c.req.param('id'))}`))));

  /** Role (student, teacher) or class. */
  app.post('/bwdportal/people/:id', need('bwdportal'), async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c);
    const change: { role?: BwdRole; classCode?: string | null } = {};
    if (b.role !== undefined) {
      if (b.role !== 'student' && b.role !== 'teacher') throw bad('Role is student or teacher.');
      change.role = b.role;
    }
    if (b.classCode !== undefined) change.classCode = b.classCode === null || b.classCode === '' ? null : clean(b.classCode, 12);
    if (!Object.keys(change).length) throw bad('Nothing to change.');
    const before = bwdPerson(await portal(c.env, `/people/${encodeURIComponent(id)}`));
    const after = bwdPerson(await portal(c.env, `/people/${encodeURIComponent(id)}`, 'PATCH', change));
    if (change.role && change.role !== before.role) {
      await audit(c, 'bwdportal.role', change.role === 'teacher' ? `Made ${after.name} a teacher in the bwd Portal` : `Made ${after.name} a student in the bwd Portal`, after.email, `${before.role} → ${after.role}`);
    }
    if (change.classCode !== undefined && change.classCode !== before.classCode) {
      await audit(c, 'bwdportal.class', `Moved ${after.name} to ${after.classCode ?? 'no class'}`, after.email, `${before.classCode ?? 'none'} → ${after.classCode ?? 'none'}`);
    }
    return c.json(after);
  });

  /** Replace a teacher's assignments (class and subject). */
  app.post('/bwdportal/people/:id/assignments', need('bwdportal'), async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c);
    if (!Array.isArray(b.assignments)) throw bad('Send assignments as a list.');
    const list = b.assignments.map(assignment);
    if (list.some((a) => !a || !a.classCode || !a.subject)) throw bad('Each assignment needs a class and a subject.');
    if (list.length > 200) throw bad('At most 200 assignments.');
    const after = bwdPerson(await portal(c.env, `/people/${encodeURIComponent(id)}/assignments`, 'PUT', { assignments: list }));
    await audit(c, 'bwdportal.assignments', `Changed what ${after.name} teaches in the bwd Portal`, after.email, describe(after.assignments));
    return c.json(after);
  });

  app.get('/bwdportal/classes', need('bwdportal'), async (c) => {
    const data = await portal<{ classes?: unknown[] }>(c.env, '/classes');
    return c.json({ classes: (data.classes ?? []).map(bwdClass) });
  });

  app.post('/bwdportal/classes', need('bwdportal'), async (c) => {
    const b = await readJson(c);
    const code = clean(b.code, 12);
    if (!code) throw bad('The class needs a code like IM25a.');
    const program = b.program == null ? null : clean(b.program, 120) || null;
    const created = bwdClass(await portal(c.env, '/classes', 'POST', { code, program }));
    await audit(c, 'bwdportal.class_create', `Created class ${created.code} in the bwd Portal`, created.code, program ?? undefined);
    return c.json(created, 201);
  });

  /** Program or class teacher. */
  app.post('/bwdportal/classes/:code', need('bwdportal'), async (c) => {
    const code = c.req.param('code');
    const b = await readJson(c);
    const change: { program?: string | null; classTeacherId?: string | null } = {};
    if (b.program !== undefined) change.program = b.program === null ? null : clean(b.program, 120) || null;
    if (b.classTeacherId !== undefined) change.classTeacherId = b.classTeacherId === null || b.classTeacherId === '' ? null : clean(b.classTeacherId, 80);
    if (!Object.keys(change).length) throw bad('Nothing to change.');
    const after = bwdClass(await portal(c.env, `/classes/${encodeURIComponent(code)}`, 'PATCH', change));
    if (change.classTeacherId !== undefined) {
      await audit(c, 'bwdportal.class_teacher', after.classTeacher ? `Made ${after.classTeacher.name} class teacher of ${after.code}` : `Removed the class teacher of ${after.code}`, after.code);
    }
    if (change.program !== undefined) await audit(c, 'bwdportal.class_program', `Changed the program of ${after.code}`, after.code, after.program ?? 'none');
    return c.json(after);
  });

  app.get('/bwdportal/subjects', need('bwdportal'), async (c) => {
    const data = await portal<{ subjects?: unknown[] }>(c.env, '/subjects');
    const subjects: BwdSubject[] = (data.subjects ?? []).map((x) => {
      const s = (x ?? {}) as Record<string, unknown>;
      return { code: str(s.code, 8), name: str(s.name, 80) };
    });
    return c.json({ subjects });
  });
}
