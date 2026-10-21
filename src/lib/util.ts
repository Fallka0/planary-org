// Small helpers shared by every route: errors, ids, input validation, crypto, formatting.

import type { Context } from 'hono';
import type { AppEnv } from '../env';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// ── Errors ───────────────────────────────────────────

/** Thrown anywhere in a handler; app.onError turns it into { error, code, requestId }. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const bad = (message: string, code = 'invalid') => new ApiError(400, message, code);
export const notFound = (message = 'Not found.') => new ApiError(404, message, 'not_found');
export const forbidden = (message = "Your role can't do that.", code = 'forbidden') => new ApiError(403, message, code);
export const conflict = (message: string, code: string) => new ApiError(409, message, code);

export function errorBody(c: Context<AppEnv>, error: string, code?: string) {
  return { error, ...(code ? { code } : {}), requestId: c.get('requestId') ?? '' };
}

// ── Ids ──────────────────────────────────────────────

const ALPHABET = '0123456789abcdefghijkmnpqrstuvwxyz';

export function randomId(prefix: string, length = 14) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ── Input ────────────────────────────────────────────

export async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? '';
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  if (type && !type.includes('json')) throw new ApiError(415, 'Send JSON.', 'unsupported_media_type');
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw bad('The body is not valid JSON.', 'bad_json');
}

/** Strips control characters (keeps newlines and tabs if multiline), trims and caps the length. */
export function clean(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const pattern = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return String(value).replace(/\r\n/g, '\n').replace(pattern, '').trim().slice(0, max);
}

export function requireText(value: unknown, field: string, max: number, opts: { min?: number; multiline?: boolean } = {}) {
  const text = clean(value, max + 1, opts.multiline);
  if (text.length < (opts.min ?? 1)) throw bad(`${field} is required.`, 'invalid_' + field);
  if (text.length > max) throw bad(`${field} is too long (max ${max}).`, 'invalid_' + field);
  return text;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const v = oneOf(value, allowed);
  if (!v) throw bad(`${field} must be one of ${allowed.join(', ')}.`, 'invalid_' + field);
  return v;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function email(value: unknown): string | null {
  const e = clean(value, 254).toLowerCase();
  return EMAIL.test(e) ? e : null;
}

export function int(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Escapes LIKE wildcards; use with `ESCAPE '\\'`. */
export function likeTerm(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

// ── Crypto ───────────────────────────────────────────

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hex(buffer: ArrayBuffer | Uint8Array) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(text: string) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Constant-time comparison of two strings (as UTF-8). */
export function safeEqual(a: string, b: string) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ── Display ──────────────────────────────────────────

const SKIP_WORDS = new Set(['verein', 'der', 'die', 'das', 'the']);

/** "Verein Gurten LAN" → "GL", "FC Länggasse Esports" → "FL", "Lena" → "LE". */
export function initials(name: string) {
  const words = name.split(/\s+/).filter(Boolean);
  const useful = words.length > 1 && SKIP_WORDS.has(words[0].toLowerCase()) ? words.slice(1) : words;
  if (useful.length === 0) return '?';
  if (useful.length === 1) return useful[0].slice(0, 2).toUpperCase();
  return (useful[0][0] + useful[1][0]).toUpperCase();
}

const ZURICH = 'Europe/Zurich';

function parts(at: number, options: Intl.DateTimeFormatOptions) {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('de-CH', { timeZone: ZURICH, ...options }).formatToParts(new Date(at))) out[p.type] = p.value;
  return out;
}

/** "20:06" in Zurich time. */
export function timeOfDay(at: number) {
  const p = parts(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
}

/** "17.10." */
export function shortDate(at: number) {
  const p = parts(at, { day: '2-digit', month: '2-digit' });
  return `${p.day}.${p.month}.`;
}

export function zurichDay(at: number) {
  const p = parts(at, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** "3. November", with the year when it isn't the current one. */
export function longDate(at: number, now: number) {
  const p = parts(at, { year: 'numeric', month: 'numeric', day: 'numeric' });
  const year = parts(now, { year: 'numeric' }).year;
  return `${Number(p.day)}. ${MONTHS[Number(p.month) - 1]}${p.year === year ? '' : ` ${p.year}`}`;
}

/** Rappen → "CHF 1’228.00" (Swiss format). */
export function chf(rappen: number) {
  const francs = Math.floor(Math.abs(rappen) / 100);
  const cents = Math.abs(rappen) % 100;
  const grouped = String(francs).replace(/\B(?=(\d{3})+(?!\d))/g, '’');
  return `CHF ${rappen < 0 ? '-' : ''}${grouped}.${String(cents).padStart(2, '0')}`;
}

/** Start of the current calendar year (UTC). */
export function yearStart(now: number) {
  return Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function parseJsonArray<T>(text: string | null | undefined, fallback: T[] = []): T[] {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}
