// Console permission checks shared by the /console route files.

import type { MiddlewareHandler } from 'hono';
import type { Area } from '../contract';
import type { AppEnv, StaffCtx } from '../env';
import { forbidden } from '../lib/util';
import { can } from '../permissions';

/** GET needs read, anything else edit, for the area. */
export const need =
  (area: Area): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const required = c.req.method === 'GET' || c.req.method === 'HEAD' ? 'read' : 'edit';
    if (!can(c.get('staff').role, area, required)) throw forbidden();
    await next();
  };

export const actorOf = (staff: StaffCtx) => ({ id: staff.id, name: staff.name });
