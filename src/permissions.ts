// The Console's permission matrix: what each staff role may do per area.
// Source: CONSOLE.matrix in the Console copy (console.en.json). GET needs read, POST needs edit.

import type { Access, Area, StaffRole } from './contract';

export const AREAS: readonly Area[] = [
  'overview',
  'incidents',
  'customers',
  'notes',
  'support',
  'tournament',
  'casino',
  'casino_moderation',
  'wishlist',
  'audit',
  'staff',
];

export const ROLES: readonly StaffRole[] = ['owner', 'manager', 'support', 'viewer'];

/** Row label in the Console's matrix → columns Owner, Manager, Support, Viewer. */
export const MATRIX: Record<Area, { label: string; access: [Access, Access, Access, Access] }> = {
  overview: { label: 'Overview and status', access: ['edit', 'edit', 'read', 'read'] },
  incidents: { label: 'Incidents and roll-back', access: ['edit', 'edit', 'read', 'read'] },
  customers: { label: 'Customers and plans', access: ['edit', 'edit', 'read', 'read'] },
  notes: { label: 'Customer notes', access: ['edit', 'edit', 'edit', 'read'] },
  support: { label: 'Support inbox', access: ['edit', 'edit', 'edit', 'read'] },
  tournament: { label: 'Tournament', access: ['edit', 'edit', 'read', 'read'] },
  casino: { label: 'Casino (chips, games, economy)', access: ['edit', 'edit', 'none', 'none'] },
  casino_moderation: { label: 'Casino moderation', access: ['edit', 'edit', 'edit', 'read'] },
  wishlist: { label: 'Wishlist totals', access: ['read', 'read', 'read', 'read'] },
  audit: { label: 'Audit log', access: ['read', 'read', 'none', 'none'] },
  staff: { label: 'Staff and roles', access: ['edit', 'none', 'none', 'none'] },
};

export function accessFor(role: StaffRole, area: Area): Access {
  const column = ROLES.indexOf(role);
  if (column < 0) return 'none';
  return MATRIX[area].access[column];
}

export function accessMap(role: StaffRole): Record<Area, Access> {
  return Object.fromEntries(AREAS.map((a) => [a, accessFor(role, a)])) as Record<Area, Access>;
}

export function can(role: StaffRole, area: Area, need: 'read' | 'edit') {
  const a = accessFor(role, area);
  return need === 'read' ? a === 'read' || a === 'edit' : a === 'edit';
}
