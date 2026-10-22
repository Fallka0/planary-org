// Plans, limits and display prices (ADR 0001). Prices are the brief's placeholders until Planary
// sets them; every surface shows a "Platzhalter" chip while `placeholder` is true.
// Provider price ids come from env vars (STRIPE_PRICE_EVENT, STRIPE_PRICE_VEREIN), not from here.

import type { Plan, PlanId, PlanLimits } from './contract';

export const PLAN_IDS: readonly PlanId[] = ['gratis', 'event', 'verein'];

const GRATIS: PlanLimits = {
  maxTeams: 16,
  maxRunning: 1,
  maxOrganisers: 1,
  branding: false,
  checkIn: false,
  waitingList: false,
  export: false,
  matchDaySupport: false,
  invoice: false,
};

const EVENT: PlanLimits = {
  maxTeams: 128,
  maxRunning: 1,
  maxOrganisers: 1,
  branding: true,
  checkIn: true,
  waitingList: true,
  export: true,
  matchDaySupport: true,
  invoice: false,
};

const VEREIN: PlanLimits = {
  maxTeams: 128,
  maxRunning: null,
  maxOrganisers: 5,
  branding: true,
  checkIn: true,
  waitingList: true,
  export: true,
  matchDaySupport: true,
  invoice: true,
};

export const PLANS: Record<PlanId, Plan> = {
  gratis: { id: 'gratis', name: 'Gratis', price: 0, period: 'forever', placeholder: true, limits: GRATIS },
  event: { id: 'event', name: 'Event', price: 4900, period: 'tournament', placeholder: true, limits: EVENT },
  verein: { id: 'verein', name: 'Verein', price: 1900, period: 'month_yearly', placeholder: true, limits: VEREIN },
};

export const planList = (): Plan[] => PLAN_IDS.map((id) => PLANS[id]);

export const planName = (id: PlanId) => PLANS[id].name;
