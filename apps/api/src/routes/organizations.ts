import { randomUUID } from 'node:crypto';
import type { FastifyPluginCallback } from 'fastify';
import {
  CreateOrganizationRequestSchema,
  CurrentOrganizationResponseSchema,
  OrganizationCreatedResponseSchema,
  OrganizationSchema,
} from '@resolveops/shared';
import {
  AuthError,
  requireTenantContext,
  withTenantContext,
  writeAuditEvent,
} from '@resolveops/auth';
import type { ResourceRouteOptions } from '../register-resources';

/** URL-safe slug from an org name — uniqueness comes from the random suffix. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'org'
  );
}

export const organizationRoutes: FastifyPluginCallback<ResourceRouteOptions> = (app, deps, done) => {
  // Creates the organization AND the owner membership in ONE transaction
  // (spec §4.3): the creating user becomes its owner, and a failure at any
  // step leaves neither an orphan org nor an ownerless one. The org row is
  // written under its own tenant context so RLS WITH CHECK passes for the
  // org's first row set.
  app.post('/api/v1/organizations', { config: deps.mutating }, async (request, reply) => {
    const session = request.session;
    if (!session?.userId) {
      throw new AuthError('UNAUTHORIZED', 'Authentication required.');
    }
    const body = CreateOrganizationRequestSchema.parse(request.body);
    const userId = session.userId;
    const organizationId = randomUUID();
    const slug = `${slugify(body.name)}-${randomUUID().slice(0, 8)}`;

    const created = await withTenantContext(
      deps.pool,
      { organizationId, userId },
      async (client) => {
        const org = await client.query<{
          id: string;
          name: string;
          slug: string;
          created_at: Date;
          updated_at: Date;
        }>(
          `INSERT INTO organizations (id, name, slug)
           VALUES ($1, $2, $3)
           RETURNING id, name, slug, created_at, updated_at`,
          [organizationId, body.name, slug],
        );
        await client.query(
          `INSERT INTO memberships (id, organization_id, user_id, role, status)
           VALUES ($1, $2, $3, 'owner', 'active')`,
          [randomUUID(), organizationId, userId],
        );
        await writeAuditEvent(client, {
          organizationId,
          actorUserId: userId,
          action: 'organization.created',
          targetType: 'organization',
          targetId: organizationId,
          metadata: { name: body.name },
        });
        return org.rows[0];
      },
    );

    reply.code(201);
    return OrganizationCreatedResponseSchema.parse({
      organization: {
        id: created.id,
        name: created.name,
        slug: created.slug,
        createdAt: created.created_at.toISOString(),
        updatedAt: created.updated_at.toISOString(),
      },
      // The creating user becomes owner of the new organization — the same
      // transaction wrote this membership row.
      membership: { role: 'owner', status: 'active' },
    });
  });

  // Validated context: the tenant guard has already verified the session's
  // active membership; this returns the organization the context points at.
  app.get(
    '/api/v1/organizations/current',
    { preHandler: requireTenantContext({ pool: deps.pool }) },
    async (request) => {
      const context = request.tenantContext;
      if (!context) throw new AuthError('INTERNAL', 'Tenant context missing after guard.');
      const orgs = await withTenantContext(deps.pool, context, (client) =>
        client.query<{
          id: string;
          name: string;
          slug: string;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT id, name, slug, created_at, updated_at
             FROM organizations
            WHERE id = $1`,
          [context.organizationId],
        ),
      );
      const org = orgs.rows[0];
      if (!org) throw new AuthError('NOT_FOUND', 'Organization not found.');
      return CurrentOrganizationResponseSchema.parse({
        organization: {
          id: org.id,
          name: org.name,
          slug: org.slug,
          createdAt: org.created_at.toISOString(),
          updatedAt: org.updated_at.toISOString(),
        },
        // The role comes from the server-verified membership context, never
        // from a client claim.
        role: context.role,
      });
    },
  );

  done();
};
