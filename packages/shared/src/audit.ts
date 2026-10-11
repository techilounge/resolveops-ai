import { z } from 'zod';
import { PaginatedResponseSchema } from './pagination';

/**
 * Audit event contracts — GET /api/v1/audit-events (delta D3: API-only in
 * Phase 1; the /app/audit screen follows in a later phase). Rows are org-
 * scoped by construction: the endpoint runs as the SELECT-only
 * resolveops_audit_reader role inside the caller's tenant context.
 */
export const AuditEventSchema = z
  .object({
    id: z.string().uuid(),
    actorUserId: z.string().uuid().nullable(),
    action: z.string().min(1).max(100),
    targetType: z.string().min(1).max(100),
    targetId: z.string().max(200).nullable(),
    metadata: z.record(z.string(), z.unknown()),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const ListAuditEventsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ListAuditEventsQuery = z.infer<typeof ListAuditEventsQuerySchema>;

export const AuditEventListResponseSchema = PaginatedResponseSchema(AuditEventSchema);
export type AuditEventListResponse = z.infer<typeof AuditEventListResponseSchema>;
