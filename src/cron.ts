// Scheduled work: health checks and the deploy cache every minute; cleanup once a day.

import type { Env } from './env';
import { stripe, stripeConfigured } from './lib/stripe';
import { auditStmt } from './lib/audit';
import { applySwitchStmts } from './routes/portal-billing';
import { cleanUpMonitoring, refreshDeploys, runChecks } from './services';

export const EVERY_MINUTE = '* * * * *';

export async function runScheduled(env: Env, cron: string, scheduledTime = Date.now()) {
  if (cron === EVERY_MINUTE) {
    await runChecks(env, scheduledTime);
    await refreshDeploys(env, scheduledTime);
    return;
  }
  await dailyCleanup(env, scheduledTime);
}

export async function dailyCleanup(env: Env, now = Date.now()) {
  await cleanUpMonitoring(env, now);
  await env.DB.prepare('DELETE FROM invitations WHERE (accepted_at IS NOT NULL OR withdrawn_at IS NOT NULL OR expires_at < ?) AND sent_at < ?')
    .bind(now, now - 90 * 86_400_000)
    .run();
  await deleteDueOrganisations(env, now);
  await applyDueSwitches(env, now);
}

/**
 * Switches to Gratis whose date has passed but whose subscription.deleted webhook didn't arrive
 * (or arrived before the keep list was stored): the members who weren't kept leave.
 */
export async function applyDueSwitches(env: Env, now = Date.now()) {
  const { results } = await env.DB.prepare("SELECT org_id AS id, cancel_keep FROM subscriptions WHERE cancel_at IS NOT NULL AND cancel_at < ? AND plan = 'gratis' LIMIT 50")
    .bind(now - 86_400_000)
    .all<{ id: string; cancel_keep: string | null }>();
  for (const row of results) await env.DB.batch(applySwitchStmts(env, row, now));
}

/** Organisations whose owners asked for deletion 30 days ago: cancel billing, drop files and rows. */
export async function deleteDueOrganisations(env: Env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.name, o.logo_key, s.subscription_id, s.state, p.subscription_id AS vault_subscription_id, p.state AS vault_state
     FROM organisations o LEFT JOIN subscriptions s ON s.org_id = o.id LEFT JOIN product_subscriptions p ON p.org_id = o.id AND p.product = 'vault'
     WHERE o.delete_at IS NOT NULL AND o.delete_at <= ? LIMIT 20`,
  )
    .bind(now)
    .all<{
      id: string;
      name: string;
      logo_key: string | null;
      subscription_id: string | null;
      state: string | null;
      vault_subscription_id: string | null;
      vault_state: string | null;
    }>();
  for (const org of results) {
    const running = [
      org.state !== 'canceled' ? org.subscription_id : null,
      org.vault_state !== 'canceled' ? org.vault_subscription_id : null,
    ].filter((s): s is string => Boolean(s));
    if (running.length && stripeConfigured(env)) {
      try {
        for (const sub of running) await stripe(env, 'DELETE', `/subscriptions/${encodeURIComponent(sub)}`);
      } catch (error) {
        console.log(`could not cancel subscription of ${org.id}: ${error}`);
        continue; // try again tomorrow rather than leave a subscription running
      }
    }
    const files = await env.DB.prepare('SELECT r2_key FROM attachments WHERE org_id = ?').bind(org.id).all<{ r2_key: string }>();
    const keys = [...files.results.map((f) => f.r2_key), ...(org.logo_key ? [org.logo_key] : [])];
    if (keys.length) await env.FILES.delete(keys);
    const del = (sql: string) => env.DB.prepare(sql).bind(org.id);
    await env.DB.batch([
      del('DELETE FROM attachments WHERE request_id IN (SELECT id FROM requests WHERE org_id = ?)'),
      del('DELETE FROM request_messages WHERE request_id IN (SELECT id FROM requests WHERE org_id = ?)'),
      del('DELETE FROM requests WHERE org_id = ?'),
      ...['members', 'invitations', 'subscriptions', 'product_subscriptions', 'passes', 'checkouts', 'invoices', 'payment_methods', 'billing_contacts', 'customer_notes'].map((t) =>
        del(`DELETE FROM ${t} WHERE org_id = ?`),
      ),
      del('DELETE FROM organisations WHERE id = ?'),
      auditStmt(env, { area: 'system', actor: null, action: 'org.delete', sentence: 'Deleted an organisation', target: org.name, details: 'deletion requested 30 days earlier', at: now }),
    ]);
  }
}
