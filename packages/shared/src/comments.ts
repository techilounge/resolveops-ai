import { z } from 'zod';
import { ListQuerySchema, PaginatedResponseSchema } from './pagination';

/**
 * Comment creation contract (P1-4 addendum, delta D4): the body text only —
 * author and organization come from the server-side session/tenant context,
 * never from the client.
 */
export const CreateIncidentCommentRequestSchema = z
  .object({
    body: z.string().min(1).max(10000),
  })
  .strict();
export type CreateIncidentCommentRequest = z.infer<
  typeof CreateIncidentCommentRequestSchema
>;

/**
 * Incident-comment DTO (P1-4 addendum, delta D4): the persisted
 * `incident_comments` row (migration 003) plus the author's display name,
 * resolved at read time through the app role's users SELECT grant
 * (migration 006). The DTO carries `updatedAt` for contract stability —
 * Phase 1 has no comment edit endpoint (the table grants SELECT, INSERT
 * only), so it always equals `createdAt` today.
 */
export const IncidentCommentDtoSchema = z
  .object({
    id: z.string().uuid(),
    incidentId: z.string().uuid(),
    organizationId: z.string().uuid(),
    authorUserId: z.string().uuid(),
    authorDisplayName: z.string(),
    body: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type IncidentCommentDto = z.infer<typeof IncidentCommentDtoSchema>;

/**
 * The comment list shares the scoped pagination contract (page/pageSize →
 * limit/offset with a PageInfo total) and orders created_at ASC, id ASC —
 * oldest first, stable under equal timestamps via the id tiebreaker.
 */
export const ListIncidentCommentsQuerySchema = ListQuerySchema;
export type ListIncidentCommentsQuery = z.infer<
  typeof ListIncidentCommentsQuerySchema
>;

export const IncidentCommentListResponseSchema =
  PaginatedResponseSchema(IncidentCommentDtoSchema);
export type IncidentCommentListResponse = z.infer<
  typeof IncidentCommentListResponseSchema
>;
