// planary-org: organisations, billing, support, incidents and the Console's data (docs/adr/0001).
//   /console/*        the Console (admin.planary.ch), staff only
//   /portal/*         the customer portal (portal.planary.ch), signed-in accounts, per-org membership
//   /internal/*       other Planary workers (x-internal-key)
//   /webhooks/stripe  Stripe (Stripe-Signature)
//   /files/:id        signed links to support attachments; /logos/:id organisation logos
// Request and response shapes: src/contract.ts.

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Env } from './env';
import { ApiError, errorBody } from './lib/util';
import { consoleApp } from './routes/console';
import { filesApp } from './routes/files';
import { internalApp } from './routes/internal';
import { portalApp } from './routes/portal';
import { webhooksApp } from './routes/webhooks';
import { runScheduled } from './cron';

export const app = new Hono<AppEnv>();

const KB = 1024;
const MB = 1024 * KB;

/** Uploads get room for three 10 MB images; webhooks for Stripe's payloads; everything else is small JSON. */
function maxBody(method: string, path: string) {
  if (method !== 'POST') return 16 * KB;
  if (/^\/portal\/orgs\/[^/]+\/requests\/?$/.test(path)) return 31 * MB;
  if (/^\/portal\/orgs\/[^/]+\/logo\/?$/.test(path)) return 2 * MB + 64 * KB;
  if (path === '/webhooks/stripe') return 512 * KB;
  return 64 * KB;
}

app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  await next();
  c.header('x-request-id', requestId);
});

const origins = (list: string | undefined) =>
  (list ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

const corsFor = (pick: (env: Env) => string[]) =>
  cors({
    origin: (origin, c) => (pick(c.env as Env).includes(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    exposeHeaders: ['x-request-id', 'Content-Disposition'],
    maxAge: 86400,
  });

app.use('/console/*', corsFor((env) => origins(env.CONSOLE_ORIGINS)));
app.use('/portal/*', corsFor((env) => origins(env.PORTAL_ORIGINS)));
app.use('/files/*', corsFor((env) => [...origins(env.CONSOLE_ORIGINS), ...origins(env.PORTAL_ORIGINS)]));

app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  return bodyLimit({
    maxSize: maxBody(c.req.method, c.req.path),
    onError: (c) => c.json(errorBody(c as never, 'The request body is too large.', 'payload_too_large'), 413),
  })(c, next);
});

app.get('/', (c) => c.json({ service: 'planary-org', ok: true }));

app.route('/console', consoleApp);
app.route('/portal', portalApp);
app.route('/internal', internalApp);
app.route('/webhooks', webhooksApp);
app.route('/', filesApp);

app.notFound((c) => c.json(errorBody(c, 'Not found.', 'not_found'), 404));

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(errorBody(c, err.message, err.code), err.status);
  if (err instanceof HTTPException) {
    const status = err.status;
    return c.json(errorBody(c, status === 413 ? 'The request body is too large.' : err.message || 'Request failed.', status === 413 ? 'payload_too_large' : 'http_error'), status);
  }
  console.error(`[${c.get('requestId')}] ${c.req.method} ${c.req.path}:`, err);
  return c.json(errorBody(c, 'Something went wrong on our side.', 'internal'), 500);
});

export default {
  fetch: app.fetch,
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduled(env, controller.cron, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
