// Signed, short-lived links to support attachments: /files/:id?exp=…&sig=… (HMAC with INTERNAL_KEY).
// The route also checks that the caller is staff or a member of the request's organisation.

import type { Env } from '../env';
import { hmacHex, MINUTE, safeEqual } from './util';

export const FILE_LINK_TTL = 15 * MINUTE;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 3;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const signingKey = (env: Env) => (env.INTERNAL_KEY ? `files:${env.INTERNAL_KEY}` : '');

export async function signedFileUrl(env: Env, origin: string, id: string, now = Date.now()) {
  const exp = now + FILE_LINK_TTL;
  const key = signingKey(env);
  const sig = key ? await hmacHex(key, `${id}.${exp}`) : '';
  return `${origin}/files/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`;
}

export async function fileSignatureOk(env: Env, id: string, exp: string | undefined, sig: string | undefined, now = Date.now()) {
  const key = signingKey(env);
  if (!key || !exp || !sig || !/^\d+$/.test(exp)) return false;
  const expires = Number(exp);
  if (expires < now || expires > now + FILE_LINK_TTL + MINUTE) return false;
  return safeEqual(sig, await hmacHex(key, `${id}.${expires}`));
}

/** PNG or JPEG, by magic bytes (the declared type isn't trusted). */
export function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export function safeFileName(name: string, type: string) {
  const base = name.replace(/[^\p{L}\p{N}._ -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'bild';
  const ext = type === 'image/png' ? '.png' : '.jpg';
  return /\.(png|jpe?g)$/i.test(base) ? base : base + ext;
}
