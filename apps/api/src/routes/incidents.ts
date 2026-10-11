import { randomUUID } from 'node:crypto';
import type { FastifyPluginCallback } from 'fastify';
import {
  CreateIncidentRequestSchema,
  IncidentDtoSchema,
  IncidentListResponseSchema,
  IncidentIdParamsSchema,
  ListIncidentsQuerySchema,
  PatchIncidentRequestSchema,
  type IncidentDto,
} from '@resolveops/shared';
import {
  AuthError,
  requireTenantContext,
  withTenantContext,
  writeAuditEvent,
} from '@resolveops/auth';
import type { ResourceRouteOptions } from '../register-resources';

interface IncidentRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  severity: string;
  assignee_user_id: string | null;
  created_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** Row → DTO; the schema parse at the edge enforces the shared contract. */
function toIncidentDto(row: IncidentRow): IncidentDto {
  return IncidentDtoSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    severity: row.severity,
    assigneeUserId: row.assignee_user_id,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

/**
 * ILIKE pattern with metacharacters escaped (spec: search cannot infer —
 * a literal `%` or `_` in user input must not widen the match). Paired with
 * the ESCAPE '\' clause in the query.
 */
function likePattern(term: string): string {
  return `%${term.replace(/[%_\\]/g, (character) => `\\${character}`)}%`;
}

const INCIDENT_COLUMNS = `id, title, description, status, severity,
         assignee_user_id, created_by, version, created_at, updated_at`;

export const incidentRoutes: FastifyPluginCallback<ResourceRouteOptions> = (app, deps, done) => {
  // The scoped incident list: filters + stable ordering + tenant-scoped
  // search (the no-inference acceptance case — a term that exists only in
  // another org's rows matches nothing here, and the empty result leaks no
  // count).
  app.get(
    '/api/v1/incidents',
    { preHandler: requireTenantContext({ pool: deps.pool }) },
    async (request) => {
      const context = request.tenantContext;
      if (!context) throw new AuthError('INTERNAL', 'Tenant context missing after guard.');
      const query = ListIncidentsQuerySchema.parse(request.query ?? {});
      return withTenantContext(deps.pool, context, async (client) => {
        const conditions: string[] = ['organization_id = $1'];
        const values: unknown[] = [context.organizationId];
        let parameter = 2;
        if (query.status) {
          conditions.push(`status = $${parameter}`);
          values.push(query.status);
          parameter += 1;
        }
        if (query.severity) {
          conditions.push(`severity = $${parameter}`);
          values.push(query.severity);
          parameter += 1;
        }
        if (query.assignee === 'unassigned') {
          conditions.push('assignee_user_id IS NULL');
        } else if (query.assignee) {
          conditions.push(`assignee_user_id = $${parameter}`);
          values.push(query.assignee);
          parameter += 1;
        }
        if (query.q) {
          conditions.push(
            `(title ILIKE $${parameter} ESCAPE '\\' OR description ILIKE $${parameter} ESCAPE '\\')`,
          );
          values.push(likePattern(query.q));
          parameter += 1;
        }
        const where = conditions.join(' AND ');
        const rows = await client.query<IncidentRow>(
          `SELECT ${INCIDENT_COLUMNS}
             FROM incidents
            WHERE ${where}
            ORDER BY created_at DESC, id DESC
            LIMIT $${parameter} OFFSET $${parameter + 1}`,
          [...values, query.pageSize, (query.page - 1) * query.pageSize],
        );
        const count = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM incidents WHERE ${where}`,
          values,
        );
        return IncidentListResponseSchema.parse({
          data: rows.rows.map(toIncidentDto),
          page: {
            page: query.page,
            pageSize: query.pageSize,
            total: Number(count.rows[0].count),
          },
        });
      });
    },
  );

  // Creation: any active member (spec §4.3). Status starts at 'new', the
  // Blueprint §6 enum's entry state; version starts at 1.
  app.post('/api/v1/incidents', { preHandler: requireTenantContext({ pool: deps.pool }), config: deps.mutating }, async (request, reply) => {
    const context = request.tenantContext;
    if (!context) throw new AuthError('INTERNAL', 'Tenant context missing after guard.');
    const body = CreateIncidentRequestSchema.parse(request.body);
    const incidentId = randomUUID();
    const inserted = await withTenantContext(deps.pool, context, async (client) => {
      const rows = await client.query<IncidentRow>(
        `INSERT INTO incidents
           (id, organization_id, title, description, status, severity, created_by)
         VALUES ($1, $2, $3, $4, 'new', $5, $6)
         RETURNING ${INCIDENT_COLUMNS}`,
        [incidentId, context.organizationId, body.title, body.description ?? null, body.severity, context.userId],
      );
      await writeAuditEvent(client, {
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'incident.created',
        targetType: 'incident',
        targetId: incidentId,
        metadata: { title: body.title, severity: body.severity },
      });
      return rows.rows[0];
    });
    reply.code(201);
    return toIncidentDto(inserted);
  });

  app.get(
    '/api/v1/incidents/:id',
    { preHandler: requireTenantContext({ pool: deps.pool }) },
    async (request) => {
      const context = request.tenantContext;
      if (!context) throw new AuthError('INTERNAL', 'Tenant context missing after guard.');
      const params = IncidentIdParamsSchema.parse(request.params);
      const rows = await withTenantContext(deps.pool, context, (client) =>
        client.query<IncidentRow>(
          `SELECT ${INCIDENT_COLUMNS}
             FROM incidents
            WHERE id = $1`,
          [params.id],
        ),
      );
      // A foreign-org id and a nonexistent id are the same 404 — no
      // enumeration signal either way.
      const row = rows.rows[0];
      if (!row) throw new AuthError('NOT_FOUND', 'Incident not found.');
      return toIncidentDto(row);
    },
  );

  // Delta D1 + §4.3: the scoped update path. Optimistic concurrency via the
  // version column (stale expectedVersion → 409), status transitions via the
  // Blueprint §6 enum, assignment via assignee_user_id + its own audit row.
  app.patch(
    '/api/v1/incidents/:id',
    { preHandler: requireTenantContext({ pool: deps.pool }), config: deps.mutating },
    async (request) => {
      const context = request.tenantContext;
      if (!context) throw new AuthError('INTERNAL', 'Tenant context missing after guard.');
      const params = IncidentIdParamsSchema.parse(request.params);
      const patch = PatchIncidentRequestSchema.parse(request.body);

      type Outcome =
        | { kind: 'ok'; incident: IncidentDto }
        | { kind: 'not_found' }
        | { kind: 'conflict' }
        | { kind: 'bad_assignee' };

      const outcome = await withTenantContext(deps.pool, context, async (client): Promise<Outcome> => {
        const current = await client.query<IncidentRow>(
          `SELECT ${INCIDENT_COLUMNS}
             FROM incidents
            WHERE id = $1
            FOR UPDATE`,
          [params.id],
        );
        const row = current.rows[0];
        if (!row) return { kind: 'not_found' };
        // Optimistic concurrency: the caller must have seen this version.
        if (row.version !== patch.expectedVersion) return { kind: 'conflict' };
        // Assignment target must be an active member of THIS org (RLS makes
        // foreign members invisible; the explicit check makes intent clear).
        if (patch.assigneeUserId !== undefined && patch.assigneeUserId !== null) {
          const members = await client.query<{ id: string }>(
            `SELECT id FROM memberships
              WHERE organization_id = $1
                AND user_id = $2
                AND status = 'active'`,
            [context.organizationId, patch.assigneeUserId],
          );
          if (!members.rows[0]) return { kind: 'bad_assignee' };
        }

        const assignments: string[] = [];
        const values: unknown[] = [];
        let parameter = 1;
        if (patch.title !== undefined) {
          assignments.push(`title = $${parameter}`);
          values.push(patch.title);
          parameter += 1;
        }
        if (patch.description !== undefined) {
          assignments.push(`description = $${parameter}`);
          values.push(patch.description);
          parameter += 1;
        }
        if (patch.severity !== undefined) {
          assignments.push(`severity = $${parameter}`);
          values.push(patch.severity);
          parameter += 1;
        }
        if (patch.status !== undefined) {
          assignments.push(`status = $${parameter}`);
          values.push(patch.status);
          parameter += 1;
        }
        if (patch.assigneeUserId !== undefined) {
          assignments.push(`assignee_user_id = $${parameter}`);
          values.push(patch.assigneeUserId);
          parameter += 1;
        }
        assignments.push('version = version + 1', 'updated_at = now()');

        const updated = await client.query<IncidentRow>(
          `UPDATE incidents
              SET ${assignments.join(', ')}
            WHERE id = $${parameter}
            RETURNING ${INCIDENT_COLUMNS}`,
          [...values, params.id],
        );
        const dto = toIncidentDto(updated.rows[0]);

        await writeAuditEvent(client, {
          organizationId: context.organizationId,
          actorUserId: context.userId,
          action: 'incident.updated',
          targetType: 'incident',
          targetId: params.id,
          metadata: {
            fields: (
              [
                ['title', patch.title],
                ['description', patch.description],
                ['severity', patch.severity],
                ['status', patch.status],
                ['assigneeUserId', patch.assigneeUserId],
              ] as const
            )
              .filter(([, value]) => value !== undefined)
              .map(([field]) => field),
          },
        });
        // Delta D1: every assignment change gets its own audited transition.
        if (patch.assigneeUserId !== undefined && row.assignee_user_id !== patch.assigneeUserId) {
          await writeAuditEvent(client, {
            organizationId: context.organizationId,
            actorUserId: context.userId,
            action: patch.assigneeUserId === null ? 'incident.unassigned' : 'incident.assigned',
            targetType: 'incident',
            targetId: params.id,
            metadata: { assigneeUserId: patch.assigneeUserId },
          });
        }
        return { kind: 'ok', incident: dto };
      });

      switch (outcome.kind) {
        case 'not_found':
          throw new AuthError('NOT_FOUND', 'Incident not found.');
        case 'conflict':
          throw new AuthError('CONFLICT', 'The incident was modified concurrently; reload it and retry.');
        case 'bad_assignee':
          throw new AuthError('BAD_REQUEST', 'Assignee must be an active member of this organization.');
        case 'ok':
          return outcome.incident;
      }
    },
  );

  done();
};
