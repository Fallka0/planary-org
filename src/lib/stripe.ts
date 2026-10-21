// Stripe over REST (form-encoded, no SDK) and webhook signature checks with Web Crypto.

import type { Env } from '../env';
import { ApiError, hmacHex, safeEqual } from './util';

export const STRIPE_API = 'https://api.stripe.com/v1';
/** Webhook timestamps older (or newer) than this are rejected. */
export const SIGNATURE_TOLERANCE_S = 300;

export function stripeConfigured(env: Env) {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export function requireStripe(env: Env): string {
  if (!env.STRIPE_SECRET_KEY) throw new ApiError(503, 'Billing is not set up yet.', 'billing_not_configured');
  return env.STRIPE_SECRET_KEY;
}

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/** { a: { b: 1 }, c: ['x', 'y'] } → a[b]=1&c[]=x&c[]=y (arrays of objects get indexes). */
export function formEncode(data: Record<string, FormValue>): string {
  const out: string[] = [];
  const walk = (key: string, value: FormValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v !== null && typeof v === 'object' ? `${key}[${i}]` : `${key}[]`, v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(data)) walk(k, v);
  return out.join('&');
}

export async function stripe<T = Record<string, unknown>>(
  env: Env,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  data?: Record<string, FormValue>,
  idempotencyKey?: string,
): Promise<T> {
  const key = requireStripe(env);
  const body = data ? formEncode(data) : '';
  const url = method === 'GET' && body ? `${STRIPE_API}${path}?${body}` : `${STRIPE_API}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(method === 'GET' ? {} : { body }),
    });
  } catch (error) {
    console.log(`stripe ${method} ${path} failed: ${error}`);
    throw new ApiError(502, "The payment provider didn't answer.", 'billing_unavailable');
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; type?: string } };
  if (!res.ok) {
    console.log(`stripe ${method} ${path}: ${res.status} ${json.error?.type ?? ''} ${json.error?.message ?? ''}`);
    throw new ApiError(502, "The payment provider didn't accept the request.", 'billing_error');
  }
  return json;
}

/**
 * Checks a Stripe-Signature header (t=…,v1=…) against the raw body:
 * HMAC-SHA256 of `${t}.${body}` with the endpoint secret, and t within the tolerance.
 */
export async function verifyStripeSignature(secret: string, header: string | undefined, body: string, nowMs = Date.now()) {
  if (!header) return false;
  let t = '';
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s?.trim() ?? '');
    if (k === 't') t = v;
    if (k === 'v1' && v) v1.push(v);
  }
  if (!/^\d+$/.test(t) || v1.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return v1.some((sig) => safeEqual(sig, expected));
}

/** Builds a valid header; for tests and local tooling. */
export async function signStripePayload(secret: string, body: string, tSeconds = Math.floor(Date.now() / 1000)) {
  return `t=${tSeconds},v1=${await hmacHex(secret, `${tSeconds}.${body}`)}`;
}
