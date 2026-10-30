// Who is calling: the Planary access token, checked by planary-auth over the AUTH binding.

import type { Context } from 'hono';
import type { AppEnv, Env, PersonCtx } from '../env';
import { ApiError, safeEqual } from './util';

export async function personFromToken(env: Env, authorization: string | undefined): Promise<PersonCtx | null> {
  if (!authorization || !/^Bearer\s+\S+/i.test(authorization)) return null;
  let res: Response;
  try {
    res = await env.AUTH.fetch(new Request('https://auth.internal/api/auth/me', { headers: { Authorization: authorization } }));
  } catch (error) {
    console.log(`auth binding failed: ${error}`);
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { user?: { id?: unknown; name?: unknown; email?: unknown } } | null;
  const user = data?.user;
  if (!user || typeof user.id !== 'string' || !user.id) return null;
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  const name = (typeof user.name === 'string' && user.name.trim()) || email.split('@')[0] || 'Planary';
  return { id: user.id, name: name.slice(0, 120), email: email.slice(0, 254) };
}

export async function requirePerson(c: Context<AppEnv>): Promise<PersonCtx> {
  const person = await personFromToken(c.env, c.req.header('authorization'));
  if (!person) throw new ApiError(401, 'Sign in first.', 'unauthenticated');
  return person;
}

/** x-internal-key, compared in constant time. */
export function internalKeyOk(env: Env, given: string | undefined) {
  if (!given) return false;
  // The shared key, or a caller's own key (Vault has one, so it can be revoked without touching the others).
  return [env.INTERNAL_KEY, env.INTERNAL_KEY_VAULT].some((expected) => Boolean(expected) && safeEqual(given, expected as string));
}
