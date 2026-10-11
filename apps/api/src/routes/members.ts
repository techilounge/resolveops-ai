import { randomUUID } from 'node:crypto';
import type { FastifyPluginCallback } from 'fastify';
import {
  CreateInvitationRequestSchema,
  ListQuerySchema,
  MemberListResponseSchema,
  MemberSchema,
  type MembershipStatus,
  type TenantRole,
} from '@resolveops/shared';
import {
  AuthError,
  requireTenantContext,
  withTenantContext,
  writeAuditEvent,
} from '@resolveops/auth';
import { PENDING_INVITE_ISSUER } from '../invite-binding';
import type { ResourceRouteOptions } from '../register-resources';

const INVITABLE_ROLES: readonly TenantRole[] = ['owner', 'admin', 'analyst', 'technician', 'viewer'];

export const memberRoutes: FastifyPluginCallback<ResourceRouteOptions> = (app, deps, done) => {
  // Delta D2 (spec §4.3): the org roster. Runs inside the org's RLS context,
  // so it lists exactly the org's memberships — the self-visibility policy
  // ORs in but adds nothing here (the org context is broader for these rows).
  app.get(
    '/api/v1/organizations/current/members',
    { preHandler: requireTenantContext({ pool: deps.pool }) },
    async (request) => {
      const context = request.tenantContext;
      if (!context) throw new AuthError('INTERNAL', 'Tenant context missing after guard.');
      const query = ListQuerySchema.parse(request.query ?? {});
      return withTenantContext(deps.pool, context, async (client) => {
        const offset = (query.page - 1) * query.pageSize;
        const rows = await client.query<{
          user_id: string;
          email: string;
          display_name: string;
          role: string;
          status: string;
          created_at: Date;
        }>(
          `SELECT m.user_id, u.email, u.display_name, m.role, m.status, m.created_at
             FROM memberships m
             JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = $1
            ORDER BY m.created_at ASC, m.user_id ASC
            LIMIT $2 OFFSET $3`,
          [context.organizationId, query.pageSize, offset],
        );
        const count = await client.query<{ count: string }>(
          'SELECT count(*) AS count FROM memberships WHERE organization_id = $1',
          [context.organizationId],
        );
        return MemberListResponseSchema.parse({
          data: rows.rows.map((row) => ({
            userId: row.user_id,
            email: row.email,
            displayName: row.display_name,
            role: row.role as TenantRole,
            status: row.status as 'active' | 'invited' | 'revoked',
            createdAt: row.created_at.toISOString(),
          })),
          page: {
            page: query.page,
            pageSize: query.pageSize,
            total: Number(count.rows[0].count),
          },
        });
      });
    },
  );

  // Delta D2 (spec §4.3): invitations. Privilege rules, both enforced from
  // the session role REFRESHED FROM THE DATABASE by the tenant guard (never
  // from a client claim): admin/owner may invite; granting the owner role is
  // owner-only. A duplicate live membership is a 409. Invitees that have
  // never signed in get a pending user row keyed to their email — the real
  // subject binds at first login (invite-binding.ts).
  app.post(
    '/api/v1/organizations/current/invitations',
    { preHandler: requireTenantContext({ pool: deps.pool }), config: deps.mutating },
    async (request, reply) => {
      const context = request.tenantContext;
      if (!context) throw new AuthError('INTERNAL', 'Tenant context missing after guard.');
      const body = CreateInvitationRequestSchema.parse(request.body);
      const email = body.email.toLowerCase();

      // Denials are audited BEFORE throwing, through the app pool in the
      // caller's tenant context (the reader role never writes).
      const deny = async (reason: string): Promise<never> => {
        await withTenantContext(deps.pool, context, (client) =>
          writeAuditEvent(client, {
            organizationId: context.organizationId,
            actorUserId: context.userId,
            action: 'invitation.create_denied',
            targetType: 'organization',
            targetId: context.organizationId,
            metadata: { reason, requestedRole: body.role, email },
          }));
        throw new AuthError('FORBIDDEN', 'You are not allowed to invite members to this organization.');
      };

      if (!INVITABLE_ROLES.includes(body.role)) {
        // Unreachable via the schema (it already restricts to invitable
        // roles); kept as a guard because the privilege matrix below must
        // reason over a closed set.
        await deny('unknown_role');
      }
      if (context.role !== 'owner' && context.role !== 'admin') {
        await deny('insufficient_role');
      }
      if (body.role === 'owner' && context.role !== 'owner') {
        await deny('owner_grant_requires_owner');
      }

      const created = await withTenantContext(deps.pool, context, async (client) => {
        // Resolve the invitee: an existing real identity, an existing pending
        // invite for the same email, or a brand-new pending user.
        const realUsers = await client.query<{ id: string }>(
          `SELECT id FROM users
            WHERE lower(email) = $1
              AND entra_issuer <> $2`,
          [email, PENDING_INVITE_ISSUER],
        );
        if (realUsers.rows.length > 1) {
          throw new AuthError('BAD_REQUEST', 'This email matches multiple accounts; invitation is ambiguous.');
        }
        let targetUserId: string;
        if (realUsers.rows[0]) {
          targetUserId = realUsers.rows[0].id;
        } else {
          const pendingUsers = await client.query<{ id: string }>(
            `SELECT id FROM users
              WHERE entra_issuer = $1
                AND lower(entra_subject) = $2`,
            [PENDING_INVITE_ISSUER, email],
          );
          if (pendingUsers.rows[0]) {
            targetUserId = pendingUsers.rows[0].id;
          } else {
            targetUserId = randomUUID();
            await client.query(
              `INSERT INTO users (id, entra_issuer, entra_subject, email, display_name)
               VALUES ($1, $2, $3, $3, $3)`,
              [targetUserId, PENDING_INVITE_ISSUER, email],
            );
          }
        }

        const duplicates = await client.query<{ id: string }>(
          `SELECT id FROM memberships
            WHERE organization_id = $1
              AND user_id = $2`,
          [context.organizationId, targetUserId],
        );
        if (duplicates.rows[0]) {
          throw new AuthError('CONFLICT', 'A membership for this email already exists in this organization.');
        }

        const membership = await client.query<{
          id: string;
          role: string;
          status: string;
          created_at: Date;
        }>(
          `INSERT INTO memberships (id, organization_id, user_id, role, status)
           VALUES ($1, $2, $3, $4, 'invited')
           RETURNING id, role, status, created_at`,
          [randomUUID(), context.organizationId, targetUserId, body.role],
        );
        const invitee = await client.query<{ email: string; display_name: string }>(
          'SELECT email, display_name FROM users WHERE id = $1',
          [targetUserId],
        );
        await writeAuditEvent(client, {
          organizationId: context.organizationId,
          actorUserId: context.userId,
          action: 'invitation.created',
          targetType: 'membership',
          targetId: membership.rows[0].id,
          metadata: { email, role: body.role },
        });
        return {
          membership: membership.rows[0],
          invitee: invitee.rows[0],
          targetUserId,
        };
      });

      reply.code(201);
      return MemberSchema.parse({
        userId: created.targetUserId,
        email: created.invitee.email,
        displayName: created.invitee.display_name,
        role: created.membership.role as TenantRole,
        status: 'invited' as const,
        createdAt: created.membership.created_at.toISOString(),
      });
    },
  );

  done();
};
