// The Console's bwd Portal pages: roles, teacher assignments and classes over the portal's /api/internal.

import { beforeEach, describe, expect, it } from 'vitest';
import { addAllStaff, auditRows, get, json, MANAGER, post, reset, SUPPORT, VIEWER } from './helpers';

/** A tiny bwd Portal: accounts and classes in memory, answers like its /api/internal. */
function fakePortal() {
  const people: Record<string, Record<string, unknown>> = {
    p1: { id: 'p1', name: 'Lea Muster', email: 'lea.muster@bwdbern.ch', role: 'student', classCode: 'IM24a', lastLoginAt: null, assignments: [], classTeacherOf: [], secret: 'x' },
  };
  const classes: Record<string, Record<string, unknown>> = { IM24a: { id: 'c-im24a', code: 'IM24a', program: null, classTeacher: null, students: 1, teachers: 0 } };
  const calls: string[] = [];
  const BWDPORTAL = {
    fetch: async (req: Request) => {
      if (req.headers.get('x-internal-key') !== 'portal-key') return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
      const url = new URL(req.url);
      const path = url.pathname.replace('/api/internal', '');
      calls.push(`${req.method} ${path}`);
      const body = req.method === 'GET' ? {} : ((await req.json()) as Record<string, unknown>);
      const person = /^\/people\/([^/]+)/.exec(path)?.[1];
      if (path === '/people') return Response.json({ people: Object.values(people) });
      if (person && !people[person]) return Response.json({ error: { code: 'not_found', message: 'Dieses Konto gibt es nicht.' } }, { status: 404 });
      if (person && path.endsWith('/assignments')) {
        if (people[person]!.role !== 'teacher') return Response.json({ error: { code: 'invalid', message: 'Nur Lehrpersonen haben Zuteilungen.' } }, { status: 422 });
        people[person]!.assignments = body.assignments;
        return Response.json(people[person]);
      }
      if (person) {
        Object.assign(people[person]!, body.role ? { role: body.role, classCode: body.role === 'teacher' ? null : people[person]!.classCode } : {}, 'classCode' in body ? { classCode: body.classCode } : {});
        return Response.json(people[person]);
      }
      if (path === '/classes' && req.method === 'GET') return Response.json({ classes: Object.values(classes) });
      if (path === '/classes') {
        if (classes[body.code as string]) return Response.json({ error: { code: 'exists', message: 'Die Klasse gibt es schon.' } }, { status: 409 });
        classes[body.code as string] = { id: `c-${body.code}`, code: body.code, program: body.program, classTeacher: null, students: 0, teachers: 0 };
        return Response.json(classes[body.code as string]);
      }
      const cls = /^\/classes\/(.+)$/.exec(path)?.[1];
      if (cls) {
        const c = classes[decodeURIComponent(cls)]!;
        if ('classTeacherId' in body) c.classTeacher = body.classTeacherId ? { id: body.classTeacherId, name: String(people[body.classTeacherId as string]?.name) } : null;
        return Response.json(c);
      }
      if (path === '/subjects') return Response.json({ subjects: [{ code: 'MA', name: 'Mathematik' }] });
      return new Response('nope', { status: 404 });
    },
  } as unknown as Fetcher;
  return { BWDPORTAL, calls, people };
}

const ENV = { INTERNAL_KEY_BWDPORTAL: 'portal-key' };

describe('bwd portal', () => {
  beforeEach(reset);
  beforeEach(addAllStaff);

  it('is off without the key, read-only for support, hidden from viewers', async () => {
    const off = await get('/console/bwdportal/people', { who: SUPPORT });
    expect(off.status).toBe(503);
    expect((await json(off)).code).toBe('not_connected');
    const { BWDPORTAL } = fakePortal();
    expect((await get('/console/bwdportal/people', { who: VIEWER, env: { ...ENV, BWDPORTAL } })).status).toBe(403);
    const list = await json(get('/console/bwdportal/people', { who: SUPPORT, env: { ...ENV, BWDPORTAL } }));
    expect(list.people).toEqual([{ id: 'p1', name: 'Lea Muster', email: 'lea.muster@bwdbern.ch', role: 'student', classCode: 'IM24a', lastLoginAt: null, assignments: [], classTeacherOf: [] }]);
    expect((await post('/console/bwdportal/people/p1', { role: 'teacher' }, { who: SUPPORT, env: { ...ENV, BWDPORTAL } })).status).toBe(403);
  });

  it('makes a teacher, assigns classes and subjects, sets the class teacher, all in the audit log', async () => {
    const { BWDPORTAL } = fakePortal();
    const env = { ...ENV, BWDPORTAL };
    const t = await json(post('/console/bwdportal/people/p1', { role: 'teacher' }, { who: MANAGER, env }));
    expect(t).toMatchObject({ role: 'teacher', classCode: null });
    const a = await json(post('/console/bwdportal/people/p1/assignments', { assignments: [{ classCode: 'IM24a', subject: 'MA' }] }, { who: MANAGER, env }));
    expect(a.assignments).toEqual([{ classCode: 'IM24a', subject: 'MA' }]);
    const created = await post('/console/bwdportal/classes', { code: 'IM25a', program: 'Informatikmittelschule' }, { who: MANAGER, env });
    expect(created.status).toBe(201);
    const kt = await json(post('/console/bwdportal/classes/IM25a', { classTeacherId: 'p1' }, { who: MANAGER, env }));
    expect(kt.classTeacher).toEqual({ id: 'p1', name: 'Lea Muster' });
    const rows = (await auditRows()).filter((r) => r.area === 'bwdportal');
    expect(rows.map((r) => [r.action, r.target])).toEqual([
      ['bwdportal.role', 'lea.muster@bwdbern.ch'],
      ['bwdportal.assignments', 'lea.muster@bwdbern.ch'],
      ['bwdportal.class_create', 'IM25a'],
      ['bwdportal.class_teacher', 'IM25a'],
    ]);
    expect(rows[1]!.details).toBe('MA in IM24a');
    expect(rows[0]!.actor_id).toBe(MANAGER.id);
  });

  it('passes the portal refusing a change on as 400, 404 and 409', async () => {
    const { BWDPORTAL } = fakePortal();
    const env = { ...ENV, BWDPORTAL };
    expect((await post('/console/bwdportal/people/p1', { role: 'admin' }, { who: MANAGER, env })).status).toBe(400);
    const no = await post('/console/bwdportal/people/p1/assignments', { assignments: [{ classCode: 'IM24a', subject: 'MA' }] }, { who: MANAGER, env });
    expect(no.status).toBe(400);
    expect((await json(no)).error).toBe('Nur Lehrpersonen haben Zuteilungen.');
    expect((await post('/console/bwdportal/people/nobody', { role: 'teacher' }, { who: MANAGER, env })).status).toBe(404);
    expect((await post('/console/bwdportal/classes', { code: 'IM24a' }, { who: MANAGER, env })).status).toBe(409);
    expect((await auditRows()).filter((r) => r.area === 'bwdportal')).toEqual([]);
    expect((await json(get('/console/bwdportal/subjects', { who: SUPPORT, env }))).subjects).toEqual([{ code: 'MA', name: 'Mathematik' }]);
  });
});
