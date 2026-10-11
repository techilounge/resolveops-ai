import type { FastifyPluginCallback } from 'fastify';
import type { Pool } from 'pg';
import {
  ActiveOrganizationResponseSchema,
  MeResponseSchema,
  SwitchOrganizationRequestSchema,
  type MembershipStatus,
} from '@resolveops/shared';
import { AuthError, loadTenantContext, withTenantContext, writeAuditEvent } from '@resolveops/auth';
import { bindPendingInvitations } from '../invite-binding';
import { withSelfContext } from '../self-context';
import type { ResourceRouteOptions } from '../register-resources';
import type { TenantRole } from '@resolveops/shared';

/** Resolves the display name of an organization the user has a membership in. */
async function organizationName(
  pool: Pool,
  userId: string,
  organizationId: string,
): Promise<string | null> {
  const result = await withTenantContext(pool, { organizationId, userId }, (client) =>
    client.query<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [organizationId],
    ),
  );
  return result.rows[0]?.name ?? null;
}

export const meRoutes: FastifyPluginCallback<ResourceRouteOptions> = (app, deps, done) => {
  app.get('/api/v1/me', async (request) => {
    const session = request.session;
    if (!session?.userId) {
      throw new AuthError('UNAUTHORIZED', 'Authentication required.');
    }

    const users = await deps.pool.query<{
      id: string;
      display_name: string;
      email: string;
    }>(
      'SELECT id, display_name, email FROM users WHERE id = $1',
      [session.userId],
    );
    const user = users.rows[0];
    if (!user) {
      // The session outlived its user row (hard delete) — fail closed.
      throw new AuthError('UNAUTHORIZED', 'Authenticated user no longer exists.', {
        clearSessionCookie: true,
      });
    }

    // First-login invitation binding (spec §4.3): pending invites addressed
    // to this email bind to the real subject here, before memberships list.
    // Idempotent — a second call finds nothing left to bind.
    await bindPendingInvitations(deps.pool, { userId: user.id, email: user.email });

    // Migration 007 self-visibility: the caller sees exactly their own
    // membership rows in every organization — never anyone else's.
    const memberships = await withSelfContext(deps.pool, user.id, (client) =>
      client.query<{
        organization_id: string;
        role: string;
        status: string;
      }>(
        `SELECT organization_id, role, status
           FROM memberships
          WHERE user_id = $1
          ORDER BY organization_id`,
        [user.id],
      ),
    );

    const dtos = await Promise.all(
      memberships.rows.map(async (row) => ({
        organizationId: row.organization_id,
        organizationName: await organizationName(deps.pool, user.id, row.organization_id),
        role: row.role as TenantRole,
        status: row.status as MembershipStatus,
      })),
    );

    return MeResponseSchema.parse({
      user: {
        id: user.id,
        displayName: user.display_name,
        email: user.email,
      },
      memberships: dtos,
    });
  });

  // Delta D2 (spec §4.3): the membership switch. The server verifies the
  // active membership under the target org's RLS context, then writes ONLY
  // the session's active-org — never trusting a client-asserted role or org.
  app.post('/api/v1/me/active-organization', { config: deps.mutating }, async (request) => {
    const session = request.session;
    if (!session?.userId) {
      throw new AuthError('UNAUTHORIZED', 'Authentication required.');
    }
    const body = SwitchOrganizationRequestSchema.parse(request.body);
    const requested = { organizationId: body.organizationId, userId: session.userId };

    const context = await loadTenantContext(deps.pool, requested);
    if (!context) {
      // Non-member selection: audited into the TARGET org's log. The session
      // is deliberately untouched — a denied switch changes no state, so the
      // previously valid selection survives (and nothing stale can slip: the
      // guard re-verifies the stored org's active membership on every
      // request, so a mid-session revocation fails the guard regardless).
      await withTenantContext(deps.pool, requested, (client) =>
        writeAuditEvent(client, {
          organizationId: requested.organizationId,
          actorUserId: requested.userId,
          action: 'tenant.access_denied',
          targetType: 'organization',
          targetId: requested.organizationId,
          metadata: { reason: 'not_active_member' },
        }));
      throw new AuthError('FORBIDDEN', 'Not an active member of the selected organization.');
    }

    session.activeOrgId = context.organizationId;
    session.membershipRole = context.role;
    await request.session.save();

    await withTenantContext(deps.pool, requested, (client) =>
      writeAuditEvent(client, {
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'organization.switched',
        targetType: 'organization',
        targetId: context.organizationId,
        metadata: { role: context.role },
      }));

    return ActiveOrganizationResponseSchema.parse({
      organizationId: context.organizationId,
      role: context.role,
    });
  });

  done();
};
