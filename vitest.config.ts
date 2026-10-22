import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside the Workers runtime against a local D1 (migrations applied in test/setup.ts)
// and a local R2. AUTH stands in for planary-auth: "Bearer test|<id>|<email>|<name>" is that
// person, anything else is signed out. STATS stands in for planary-stats. Stripe, Resend and
// GitHub are reached with fetch, which the tests replace.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    plugins: [
      cloudflareTest({
        main: 'src/index.ts',
        miniflare: {
          compatibilityDate: '2025-09-01',
          d1Databases: ['DB'],
          r2Buckets: ['FILES'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            CONSOLE_ORIGINS: 'https://admin.planary.ch,http://localhost:3003',
            PORTAL_ORIGINS: 'https://portal.planary.ch,http://localhost:3010',
            OWNER_EMAIL: 'owner@planary.test',
            PORTAL_URL: 'https://portal.planary.test',
            CONSOLE_URL: 'https://admin.planary.test',
            MAIL_FROM: 'Planary <info@planary.test>',
            STAFF_INBOX: 'staff@planary.test',
            WISHLIST_API: '',
            INTERNAL_KEY: 'test-internal-key',
            STRIPE_WEBHOOK_SECRET: 'whsec_test',
          },
          serviceBindings: {
            AUTH(req: Request) {
              const url = new URL(req.url);
              if (url.pathname === '/api/internal/stats') {
                if (req.headers.get('x-internal-key') !== 'test-internal-key') return new Response('{}', { status: 404 });
                const days = Number(url.searchParams.get('days'));
                return Response.json({ accounts: 12480, accountsNew: days, signups: Array.from({ length: days }, (_, i) => (i < days / 2 ? 1 : 2)) });
              }
              const parts = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '').split('|');
              if (parts.length < 3 || parts[0] !== 'test') return new Response(JSON.stringify({ error: 'not authenticated' }), { status: 401 });
              return Response.json({ user: { id: parts[1], email: parts[2], name: parts[3] ?? '' } });
            },
            STATS(req: Request) {
              const url = new URL(req.url);
              if (url.pathname !== '/api/internal/visitors' || req.headers.get('x-internal-key') !== 'test-internal-key') return new Response('{}', { status: 404 });
              const days = Number(url.searchParams.get('days'));
              const series = (n: number) => Array.from({ length: days }, () => n);
              return Response.json({ days: series(0).map((_, i) => `d${i}`), sites: { 'tournament.planary.ch': series(10), 'casino.planary.ch': series(20), 'wishlist.planary.ch': series(5) } });
            },
          },
        },
      }),
    ],
    test: { setupFiles: ['test/setup.ts'] },
  };
});
