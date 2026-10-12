import { randomUUID } from 'node:crypto';
import type { FastifyPluginCallback } from 'fastify';
import {
  CreateIncidentCommentRequestSchema,
  IncidentCommentDtoSchema,
  IncidentCommentListResponseSchema,
  IncidentIdParamsSchema,
  ListIncidentCommentsQuerySchema,
  type IncidentCommentDto,
} from '@resolveops/shared';
import {
  AuthError,
  requireTenantContext,
  withTenantContext,
} from '@resolveops/auth';
import type { ResourceRouteOptions } from '../register-resources';

interface CommentRow {
  id: string;
  incident_id: string;
  organization_id: string;
  author_user_id: string;
  author_display_name: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

const COMMENT_COLUMNS = `c.id, c.incident_id, c.organization_id, c.author_user_id,
         u.display_name AS author_display_name, c.body, c.created_at, c.updated_at`;

/** Row → DTO; the schema parse at the edge enforces the shared contract. */
function toCommentDto(row: CommentRow): IncidentCommentDto {
  return IncidentCommentDtoSchema.parse({
    id: row.id,
    incidentId: row.incident_id,
    organizationId: row.organization_id,
    authorUserId: row.author_user_id,
    authorDisplayName: row.author_display_name,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

/**
 * Comment routes (P1-4 addendum, delta D4): the §4.4 detail screen's
 * discussion surface. Both routes live entirely inside the tenant context —
 * RLS scopes `incident_comments` by organization, and the composite FK
 * `(organization_id, incident_id)` means a comment can only ever attach to
 * an incident in the same org.
 *
 * No audit rows here by design: the spec §7 audit list (login, logout, org
 * create, role/invite change, incident create/update/assign, denials on
 * sensitive ops) does not include comments — a comment is already-attributed
 * data rather than an authorization transition. Recorded as the delta-D4
 * reading in docs/EVIDENCE-LOG.md.
 */
export const incidentCommentRoutes: FastifyPluginCallback<ResourceRouteOptions> = (
  app,
  deps,
  done,
) => {
  // Creation: any active member who can see the incident (spec §4.3). The
  // zero-row existence check under RLS makes a foreign-org id and a
  // nonexistent id the same 404 — no enumeration signal either way.
  app.post(
    '/api/v1/incidents/:id/comments',
    { preHandler: requireTenantContext({ pool: deps.pool }), config: deps.mutating },
    async (request, reply) => {
      const context = request.tenantContext;
      if (!context) throw new AuthError('INTERNAL', 'Tenant context missing after guard.');
      const params = IncidentIdParamsSchema.parse(request.params);
      const body = CreateIncidentCommentRequestSchema.parse(request.body);
      const commentId = randomUUID();
      const inserted = await withTenantContext(deps.pool, context, async (client) => {
        const found = await client.query<{ id: string }>(
          'SELECT id FROM incidents WHERE id = $1',
          [params.id],
        );
        if (!found.rows[0]) throw new AuthError('NOT_FOUND', 'Incident not found.');
        const rows = await client.query<CommentRow>(
          `WITH new_comment AS (
             INSERT INTO incident_comments
               (id, organization_id, incident_id, author_user_id, body)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, organization_id, incident_id, author_user_id,
                       body, created_at, updated_at
           )
           SELECT ${COMMENT_COLUMNS}
             FROM new_comment c
             JOIN users u ON u.id = c.author_user_id`,
          [commentId, context.organizationId, params.id, context.userId, body.body],
        );
        return rows.rows[0];
      });
      reply.code(201);
      return toCommentDto(inserted);
    },
  );

  app.get(
    '/api/v1/incidents/:id/comments',
    { preHandler: requireTenantContext({ pool: deps.pool }) },
    async (request) => {
      const context = request.tenantContext;
      if (!context) throw new AuthError('INTERNAL', 'Tenant context missing after guard.');
      const params = IncidentIdParamsSchema.parse(request.params);
      const query = ListIncidentCommentsQuerySchema.parse(request.query ?? {});
      return withTenantContext(deps.pool, context, async (client) => {
        const found = await client.query<{ id: string }>(
          'SELECT id FROM incidents WHERE id = $1',
          [params.id],
        );
        if (!found.rows[0]) throw new AuthError('NOT_FOUND', 'Incident not found.');
        // Oldest first; the id tiebreaker keeps pages stable when comments
        // land in the same timestamp.
        const rows = await client.query<CommentRow>(
          `SELECT ${COMMENT_COLUMNS}
             FROM incident_comments c
             JOIN users u ON u.id = c.author_user_id
            WHERE c.incident_id = $1
            ORDER BY c.created_at ASC, c.id ASC
            LIMIT $2 OFFSET $3`,
          [params.id, query.pageSize, (query.page - 1) * query.pageSize],
        );
        const count = await client.query<{ count: string }>(
          'SELECT count(*) AS count FROM incident_comments WHERE incident_id = $1',
          [params.id],
        );
        return IncidentCommentListResponseSchema.parse({
          data: rows.rows.map(toCommentDto),
          page: {
            page: query.page,
            pageSize: query.pageSize,
            total: Number(count.rows[0].count),
          },
        });
      });
    },
  );

  done();
};
