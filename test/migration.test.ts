// Migration 0003 (plans v2): old stored plan values move to the new ones, and nothing else is lost.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const run = async (db: D1Database, queries: string[]) => {
  for (const q of queries) await db.prepare(q).run();
};

describe('migration 0003_plans_v2', () => {
  it('moves verein to plus and event to gratis, keeps passes, members and invoices', async () => {
    const db = env.MIGRATION_DB;
    const [m1, m2, m3] = env.TEST_MIGRATIONS;
    expect(m3.name).toMatch(/0003_plans_v2/);
    await run(db, [...m1.queries, ...m2.queries]);
    await db.batch([
      db.prepare("INSERT INTO organisations (id, name, slug, plan_override, created_by, created_at) VALUES ('o_v', 'Verein', 'verein', NULL, 'u', 1), ('o_e', 'Event', 'event', NULL, 'u', 1), ('o_c', 'Comp', 'comp', 'event', 'u', 1), ('o_g', 'Gratis', 'gratis', 'verein', 'u', 1)"),
      db.prepare("INSERT INTO subscriptions (org_id, plan, state, collection_method, updated_at) VALUES ('o_v', 'verein', 'active', 'send_invoice', 1), ('o_e', 'event', 'none', NULL, 1), ('o_c', 'gratis', 'none', NULL, 1)"),
      db.prepare("INSERT INTO members (org_id, user_id, role, created_at) VALUES ('o_v', 'u1', 'owner', 1), ('o_e', 'u2', 'owner', 1)"),
      db.prepare("INSERT INTO event_passes (id, org_id, tournament_id, amount, created_at) VALUES ('p1', 'o_e', 't1', 4900, 1)"),
      db.prepare("INSERT INTO invoices (id, org_id, created_at, amount, status, updated_at) VALUES ('in_1', 'o_v', 1, 22800, 'paid', 1)"),
      db.prepare("INSERT INTO tournaments (id, name, state, owner_id, plan, updated_at) VALUES ('t1', 'A', 'open', 'u', 'event', 1), ('t2', 'B', 'open', 'u', 'verein', 1)"),
    ]);
    await run(db, m3.queries);

    const orgs = await db.prepare('SELECT o.id, o.plan_override, s.plan, s.pay_by FROM organisations o LEFT JOIN subscriptions s ON s.org_id = o.id ORDER BY o.id').all();
    expect(orgs.results).toEqual([
      { id: 'o_c', plan_override: 'plus', plan: 'gratis', pay_by: null },
      { id: 'o_e', plan_override: null, plan: 'gratis', pay_by: null },
      { id: 'o_g', plan_override: 'plus', plan: null, pay_by: null },
      { id: 'o_v', plan_override: null, plan: 'plus', pay_by: 'invoice' },
    ]);
    expect((await db.prepare('SELECT id, tournament_id, amount FROM passes').all()).results).toEqual([{ id: 'p1', tournament_id: 't1', amount: 4900 }]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM members').first<{ n: number }>())?.n).toBe(2);
    expect(await db.prepare("SELECT lines, paid_with FROM invoices WHERE id = 'in_1'").first()).toEqual({ lines: '[]', paid_with: null });
    expect((await db.prepare('SELECT id, plan FROM tournaments ORDER BY id').all()).results).toEqual([
      { id: 't1', plan: 'gratis' },
      { id: 't2', plan: 'plus' },
    ]);
    // The old values can't come back.
    await expect(db.prepare("UPDATE subscriptions SET plan = 'verein' WHERE org_id = 'o_v'").run()).rejects.toThrow(/CHECK/);
    await expect(db.prepare("INSERT INTO passes (id, org_id, tournament_id, amount, created_at) VALUES ('p2', 'o_e', 't1', 2900, 2)").run()).rejects.toThrow(/UNIQUE/);
  });
});
