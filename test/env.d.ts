import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as WorkerEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      /** An empty database for running the migrations step by step (test/migration.test.ts). */
      MIGRATION_DB: D1Database;
    }
  }
}
