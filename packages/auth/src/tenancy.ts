import type { Pool, PoolClient } from 'pg';
import type { TenantContext } from '@resolveops/shared';
import { AuthError } from './errors';
import { writeAuditEvent } from './audit';

export interface TenantCredentials {
  organizationId: string;
  userId: string;
}

/**
 * Runs `fn` inside a transaction scoped to the tenant context:
 *
 *   BEGIN;
 *   SET LOCAL app.org_id  = <organizationId>;
 *   SET LOCAL app.user_id = <userId>;
 *   fn(client);
 *   COMMIT;   (ROLLBACK on error)
 *
 * `SET LOCAL` reverts at transaction end, so transaction-mode pooling can
 * reuse the connection immediately — the compatibility property the Phase 1
 * Blueprint (§2) relies on for managed Postgres. The pool MUST connect as the
 * `resolveops_app` role: RLS policies read these settings and fail closed
 * without them, and the role carries no BYPASSRLS.
 *
 * This is the helper every tenant-owned query in the resource routes (P1-4)
 * must go through — org context is never assembled from request bodies.
 */
export async function withTenantContext<T>(
  pool: Pool,
  credentials: TenantCredentials,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
      [credentials.organizationId, credentials.userId],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Resolves the tenant context for a session's active membership: the active
 * org is verified by reading the membership row UNDER that org's RLS context,
 * so a client-selected org id that is not an active membership yields null.
 * Role changes at the database are picked up here (the caller refreshes the
 * session's membershipRole from the result).
 */
export async function loadTenantContext(
  pool: Pool,
  credentials: TenantCredentials,
): Promise<TenantContext | null> {
  return withTenantContext(pool, credentials, async (client) => {
    const result = await client.query<{ role: string }>(
      `SELECT role
         FROM memberships
        WHERE organization_id = $1
          AND user_id = $2
          AND status = 'active'`,
      [credentials.organizationId, credentials.userId],
    );
    const row = result.rows[0];
    return row
      ? { organizationId: credentials.organizationId, userId: credentials.userId, role: row.role as TenantContext['role'] }
      : null;
  });
}

export interface TenantGuardDeps {
  pool: Pool;
}

/**
 * preHandler for every tenant-owned route: derives org context ONLY from the
 * server-side session (which the active-organization switch route — P1-4 —
 * is the sole writer of), verifies the membership row server-side, and on a
 * non-member selection writes a denial audit row into the target org's audit
 * log and clears the stale active-org from the session.
 *
 * 401 when no session user; 403 when no active org is selected or the
 * selected org has no active membership (no data, no enumeration signal —
 * the same envelope either way).
 */
export function requireTenantContext(deps: TenantGuardDeps) {
  return async (request: { session?: { userId?: string; activeOrgId?: string | null; membershipRole?: string | null }; tenantContext?: TenantContext }): Promise<void> => {
    const session = request.session;
    if (!session?.userId) {
      throw new AuthError('UNAUTHORIZED', 'Authentication required.');
    }
    if (!session.activeOrgId) {
      throw new AuthError('FORBIDDEN', 'No active organization selected.');
    }
    const requested = { organizationId: session.activeOrgId, userId: session.userId };
    const context = await loadTenantContext(deps.pool, requested);
    if (!context) {
      await withTenantContext(deps.pool, requested, (client) =>
        writeAuditEvent(client, {
          organizationId: requested.organizationId,
          actorUserId: requested.userId,
          action: 'tenant.access_denied',
          targetType: 'organization',
          targetId: requested.organizationId,
          metadata: { reason: 'not_active_member' },
        }));
      session.activeOrgId = null;
      session.membershipRole = null;
      throw new AuthError('FORBIDDEN', 'Not an active member of the selected organization.');
    }
    session.membershipRole = context.role;
    request.tenantContext = context;
  };
}
