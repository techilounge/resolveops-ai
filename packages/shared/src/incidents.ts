import { z } from 'zod';
import type { Incident } from '@resolveops/domain/types';
import { MirrorWith } from './mirror';
import { PaginatedResponseSchema } from './pagination';

// Severity is stable across the domain and SaaS contracts (the incidents
// table's CHECK constraint in migration 002 carries the same three values).
export const IncidentSeveritySchema = z.enum(['high', 'medium', 'low']);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

/**
 * Incident status — Blueprint §6 (Production SaaS Blueprint v1.0 §6, mirrored by
 * the Phase 1 spec §4.1): the database enum is the source of truth. Recorded at
 * P1-1; the Phase 0 demo set ('open'|'investigating'|'resolved') described the
 * synthetic dashboard only and never reached the database.
 */
export const IncidentStatusSchema = z.enum([
  'new',
  'triaged',
  'investigating',
  'awaiting_review',
  'resolved',
  'closed',
]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

/**
 * SaaS incident DTO (Phase 1 spec §4.1): the persisted incidents row
 * (migration 002) plus its audit columns. Unlike the Phase 0 demo contract,
 * this carries no `affectedDevices`/`tags` — those are demo-assessment
 * projections with no storage in the incidents table, so the scoped API cannot
 * honestly return them.
 */
export const IncidentDtoSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200),
    description: z.string(),
    status: IncidentStatusSchema,
    severity: IncidentSeveritySchema,
    assigneeUserId: z.string().uuid().nullable(),
    createdBy: z.string().uuid(),
    version: z.number().int().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type IncidentDto = z.infer<typeof IncidentDtoSchema>;

export const IncidentResponseSchema = IncidentDtoSchema;
export type IncidentResponse = IncidentDto;

export const CreateIncidentRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string(),
    severity: IncidentSeveritySchema,
  })
  .strict();
export type CreateIncidentRequest = z.infer<typeof CreateIncidentRequestSchema>;

/**
 * PATCH contract (Phase 1 spec §4.3): status transitions per the §6 enum,
 * assignment (delta D1 — audited on change), and optimistic concurrency via
 * the row's `version` column. `expectedVersion` is required: a patch without
 * it would silently degrade to last-write-wins, which is exactly what the
 * column exists to prevent. Mismatch is a 409 CONFLICT envelope.
 */
export const PatchIncidentRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().optional(),
    severity: IncidentSeveritySchema.optional(),
    status: IncidentStatusSchema.optional(),
    assigneeUserId: z.string().uuid().nullable().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict()
  .refine(
    (patch) =>
      ['title', 'description', 'severity', 'status', 'assigneeUserId'].some(
        (key) => patch[key as keyof typeof patch] !== undefined,
      ),
    { message: 'At least one mutable field must be provided.' },
  );
export type PatchIncidentRequest = z.infer<typeof PatchIncidentRequestSchema>;

/**
 * List query (Phase 1 spec §4.3): status/severity/assignee filters, stable
 * limit/offset pagination via the shared envelope, and `q` — an ILIKE search
 * over title/description that is always tenant-scoped (the §7 "search cannot
 * infer another org" acceptance case). `assignee: 'unassigned'` filters to
 * incidents with no assignee.
 */
export const ListIncidentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    status: IncidentStatusSchema.optional(),
    severity: IncidentSeveritySchema.optional(),
    assignee: z.union([z.string().uuid(), z.literal('unassigned')]).optional(),
    q: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ListIncidentsQuery = z.infer<typeof ListIncidentsQuerySchema>;

export const IncidentIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type IncidentIdParams = z.infer<typeof IncidentIdParamsSchema>;

export const IncidentListResponseSchema = PaginatedResponseSchema(IncidentDtoSchema);
export type IncidentListResponse = z.infer<typeof IncidentListResponseSchema>;

/**
 * Domain mirror (Phase 0 contract, PR #5): the scoped API DTO still mirrors the
 * frozen domain `Incident` on the fields the two surfaces genuinely share —
 * id/title/description/severity/createdAt. The demo-computed fields
 * (affectedDevices, tags) and the Phase 0 status values were dropped from the
 * SaaS DTO (see above), so the mirror is scoped to the surviving shared fields
 * rather than pretending the whole shape still aligns. If a shared field drifts
 * in either direction, this line stops compiling.
 */
type SharedDomainMirrorFields = Omit<Incident, 'status' | 'affectedDevices' | 'tags'>;
type ScopedIncidentDto = Omit<
  IncidentDto,
  'status' | 'assigneeUserId' | 'createdBy' | 'version' | 'updatedAt'
>;

const _sharedFieldMirror: MirrorWith<ScopedIncidentDto, SharedDomainMirrorFields> = true;
void _sharedFieldMirror;
