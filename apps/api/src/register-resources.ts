import type { FastifyPluginCallback } from 'fastify';
import type { Pool } from 'pg';
import { resolveAuthOptions } from '@resolveops/auth';
import { meRoutes } from './routes/me';
import { organizationRoutes } from './routes/organizations';
import { memberRoutes } from './routes/members';
import { incidentRoutes } from './routes/incidents';
import { incidentCommentRoutes } from './routes/comments';
import { auditEventRoutes } from './routes/audit-events';

export interface ResourceRouteDeps {
  /** The application's tenant-scoped pool (connects as resolveops_app). */
  pool: Pool;
  /** SELECT-only audit-reader pool; the audit-events route exists only when provided. */
  auditReaderPool?: Pool;
  /** Raw auth options — resolved here once to source the rate-limit budget. */
  auth: Parameters<typeof resolveAuthOptions>[0];
}

export interface ResourceRouteOptions extends ResourceRouteDeps {
  /** Attach to every mutating route — the budget the auth plugin resolved. */
  mutating: { rateLimit: { max: number; timeWindow: number } };
}

/**
 * Registers the Phase 1 §4.3 resource surface on top of the P1-3 auth
 * plugin: /me + organization + members/invitations + incidents + audit-events,
 * all Zod-validated against @resolveops/shared contracts, all returning the
 * shared error envelope (the factory's error handler owns that), all
 * tenant-owned queries through withTenantContext, and rate limiting on every
 * mutating route (the P1-3 plugin already limits the auth routes themselves).
 */
export const registerResourceRoutes: FastifyPluginCallback<ResourceRouteDeps> = (
  app,
  deps,
  done,
) => {
  const resolved = resolveAuthOptions(deps.auth);
  const shared: ResourceRouteOptions = {
    ...deps,
    mutating: {
      rateLimit: { max: resolved.rateLimitMax, timeWindow: resolved.rateLimitTimeWindowMs },
    },
  };

  app.register(meRoutes, shared);
  app.register(organizationRoutes, shared);
  app.register(memberRoutes, shared);
  app.register(incidentRoutes, shared);
  // Delta D4 (P1-4 addendum): the §4.4 detail screen's comment surface.
  app.register(incidentCommentRoutes, shared);
  // Delta D3: the audit surface needs the SELECT-only reader pool; without
  // one the route does not exist (fail closed by absence).
  if (deps.auditReaderPool) {
    app.register(auditEventRoutes, shared);
  }

  done();
};
