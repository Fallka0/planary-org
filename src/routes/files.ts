// /files/:id (support attachments: signed link AND a signed-in staff member or org member)
// and /logos/:orgId (organisation logos, public: they appear on tournament pages and beamers).

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { personFromToken } from '../lib/auth';
import { fileSignatureOk } from '../lib/files';
import { ApiError, forbidden, notFound } from '../lib/util';
import { can } from '../permissions';

export const filesApp = new Hono<AppEnv>();

filesApp.get('/files/:id', async (c) => {
  const id = c.req.param('id');
  if (!(await fileSignatureOk(c.env, id, c.req.query('exp'), c.req.query('sig')))) throw forbidden('This link is not valid or has expired.', 'bad_signature');
  const person = await personFromToken(c.env, c.req.header('authorization'));
  if (!person) throw new ApiError(401, 'Sign in first.', 'unauthenticated');
  const file = await c.env.DB.prepare('SELECT a.*, r.org_id AS request_org FROM attachments a JOIN requests r ON r.id = a.request_id WHERE a.id = ?')
    .bind(id)
    .first<{ r2_key: string; name: string; type: string; request_org: string | null; message_id: string }>();
  if (!file) throw notFound();
  const staff = await c.env.DB.prepare('SELECT role FROM staff WHERE user_id = ?').bind(person.id).first<{ role: 'owner' | 'manager' | 'support' | 'viewer' }>();
  let allowed = Boolean(staff && can(staff.role, 'support', 'read'));
  if (!allowed && file.request_org) {
    const member = await c.env.DB.prepare('SELECT 1 FROM members WHERE org_id = ? AND user_id = ?').bind(file.request_org, person.id).first();
    // Members never get files attached to internal notes.
    const internal = await c.env.DB.prepare("SELECT 1 FROM request_messages WHERE id = ? AND kind = 'internal'").bind(file.message_id).first();
    allowed = Boolean(member) && !internal;
  }
  if (!allowed) throw notFound();
  const obj = await c.env.FILES.get(file.r2_key);
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      'Content-Type': file.type,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'private, max-age=600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

filesApp.get('/logos/:orgId', async (c) => {
  const org = await c.env.DB.prepare('SELECT logo_key FROM organisations WHERE id = ?').bind(c.req.param('orgId')).first<{ logo_key: string | null }>();
  if (!org?.logo_key) throw notFound();
  const obj = await c.env.FILES.get(org.logo_key);
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
      'Cache-Control': c.req.query('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
