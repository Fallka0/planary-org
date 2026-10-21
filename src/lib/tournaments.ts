// The tournaments mirror: a summary per tournament, written by the Tournament API.

import type { PlanId, TournamentState, TournamentSummary } from '../contract';
import { parseJsonArray, yearStart } from './util';

export interface TournamentRow {
  id: string;
  slug: string;
  name: string;
  game: string;
  starts_at: number | null;
  ends_at: number | null;
  state: TournamentState;
  phase: string | null;
  teams: number;
  max_teams: number;
  waiting: number;
  organisation_id: string | null;
  owner_id: string;
  /** Display name: the known organisation's name, else what the Tournament API reported. */
  organisation_name: string | null;
  plan: PlanId;
  viewers: number;
  organisers: string;
  played: number;
  matches: number;
  updated_at: number;
}

export function tournamentOut(r: TournamentRow): TournamentSummary {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    game: r.game,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    state: r.state,
    phase: r.phase,
    teams: r.teams,
    maxTeams: r.max_teams,
    waiting: r.waiting,
    organisationId: r.organisation_id,
    organisationName: r.organisation_name,
    ownerId: r.owner_id,
    plan: r.plan,
    viewers: r.viewers,
    updatedAt: r.updated_at,
  };
}

export function organisersOf(r: TournamentRow): { id: string; name: string; role: string }[] {
  return parseJsonArray<{ id?: unknown; name?: unknown; role?: unknown }>(r.organisers)
    .filter((o) => o && typeof o.id === 'string')
    .map((o) => ({ id: String(o.id), name: String(o.name ?? ''), role: String(o.role ?? '') }));
}

/** Every tournament query selects through this, so organisationName follows renames. */
export const TOURNAMENT_SELECT = `SELECT t.id, t.slug, t.name, t.game, t.starts_at, t.ends_at, t.state, t.phase, t.teams, t.max_teams, t.waiting,
  t.organisation_id, t.owner_id, COALESCE(tog.name, t.organisation_name) AS organisation_name, t.plan, t.viewers, t.organisers,
  t.played, t.matches, t.updated_at
  FROM tournaments t LEFT JOIN organisations tog ON tog.id = t.organisation_id`;

/** Live first, then sign-up open, drafts and finished; within each, by start. */
export const TOURNAMENT_ORDER = `CASE t.state WHEN 'live' THEN 0 WHEN 'open' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
  CASE WHEN t.state = 'done' THEN -COALESCE(t.starts_at, t.updated_at) ELSE COALESCE(t.starts_at, 9e15) END`;

/** SQL condition for "this year" on a tournament (by start, or last update when undated). */
export const THIS_YEAR_SQL = 'COALESCE(t.starts_at, t.updated_at) >= ?';
export const thisYear = (now: number) => yearStart(now);
