import type { FastifyPluginCallback } from 'fastify';
import {
  AuditEventSchema,
  AuditEventListResponseSchema,
  ListAuditEventsQuerySchema,
} from '@resolveops/shared';
import {
  AuthError,
  requireTenantContext,
  withTenantContext,
  writeAuditEvent,
} from '@resolveops/auth';
import type { ResourceRouteOptions } from '../register-resources';

export const auditEventRoutes: FastifyPluginCallback<ResourceRouteOptions> = (app, deps, done) => {
  if (!deps.auditReaderPool) {
    // Registered only with a reader pool (register-resources enforces this);
    // failing closed here too, in case of future registration drift.
    done();
    return;
  }
  const readerPool = deps.auditReaderPool;

  // Delta D3 (spec §4.3): the audit surface — API-only this phase. Reads run
  // on the resolveops_audit_reader pool (SELECT granted on audit_events ONLY,
  // nothing else on the server); RLS still scopes rows to the caller's org,
  // enforced by running inside the same tenant context as every other route.
  app.get(
    '/api/v1/audit-events',
    { preHandler: requireTenantContext({ pool: deps.pool }) },
    async (request) => {
      const context = request.tenantContext;
      if (!context) throw new AuthError('INTERNAL', 'Tenant context missing after guard.');
      const query = ListAuditEventsQuerySchema.parse(request.query ?? {});

      if (context.role !== 'owner' && context.role !== 'admin') {
        // Denial is audited through the APP pool — the reader role has no
        // INSERT grant by design.
        await withTenantContext(deps.pool, context, (client) =>
          writeAuditEvent(client, {
            organizationId: context.organizationId,
            actorUserId: context.userId,
            action: 'audit.read_denied',
            targetType: 'organization',
            targetId: context.organizationId,
            metadata: { role: context.role },
          }));
        throw new AuthError('FORBIDDEN', 'Audit events require an owner or admin role.');
      }

      return withTenantContext(readerPool, context, async (client) => {
        const offset = (query.page - 1) * query.pageSize;
        const rows = await client.query<{
          id: string;
          actor_user_id: string | null;
          action: string;
          target_type: string;
          target_id: string | null;
          metadata: Record<string, unknown>;
          occurred_at: Date;
        }>(
          `SELECT id, actor_user_id, action, target_type, target_id, metadata, occurred_at
             FROM audit_events
            WHERE organization_id = $1
            ORDER BY occurred_at DESC, id DESC
            LIMIT $2 OFFSET $3`,
          [context.organizationId, query.pageSize, offset],
        );
        const count = await client.query<{ count: string }>(
          'SELECT count(*) AS count FROM audit_events WHERE organization_id = $1',
          [context.organizationId],
        );
        return AuditEventListResponseSchema.parse({
          data: rows.rows.map((row) =>
            AuditEventSchema.parse({
              id: row.id,
              actorUserId: row.actor_user_id,
              action: row.action,
              targetType: row.target_type,
              targetId: row.target_id,
              metadata: row.metadata ?? {},
              occurredAt: row.occurred_at.toISOString(),
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

  done();
};
