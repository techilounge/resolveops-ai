import { z } from 'zod';
import type { Incident } from '@resolveops/domain/types';
import { MirrorWith } from './mirror';
import { ListQuerySchema, PaginatedResponseSchema } from './pagination';

// Severity is stable across the domain and SaaS contracts.
export const IncidentSeveritySchema = z.enum(['high', 'medium', 'low']);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

// Phase 0 mirrors the domain status enum. The SaaS-side status set from
// Blueprint §6 (new/triaged/investigating/awaiting_review/resolved/closed)
// arrives with the Phase 1 schema adapter — Blueprint §2: "place schema
// adapters between old and new domain models". Deliberately not invented
// here.
export const IncidentStatusSchema = z.enum(['open', 'investigating', 'resolved']);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

// Incident DTO — mirrored from the domain contract in @resolveops/domain,
// not duplicated: the mirror assertion at the bottom of this file stops the
// build if the DTO and the domain type drift apart.
export const IncidentDtoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string(),
  severity: IncidentSeveritySchema,
  status: IncidentStatusSchema,
  createdAt: z.string().datetime(),
  affectedDevices: z.number().int().min(0),
  tags: z.array(z.string()),
});
export type IncidentDto = z.infer<typeof IncidentDtoSchema>;

// POST /api/v1/incidents — scoped create.
export const CreateIncidentRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    severity: IncidentSeveritySchema,
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type CreateIncidentRequest = z.infer<typeof CreateIncidentRequestSchema>;

// PATCH /api/v1/incidents/:id — scoped change; at least one field must move.
export const PatchIncidentRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(1).optional(),
    severity: IncidentSeveritySchema.optional(),
    status: IncidentStatusSchema.optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Patch must change at least one field.',
  });
export type PatchIncidentRequest = z.infer<typeof PatchIncidentRequestSchema>;

// GET /api/v1/incidents — scoped list with optional filters.
export const ListIncidentsQuerySchema = ListQuerySchema.extend({
  severity: IncidentSeveritySchema.optional(),
  status: IncidentStatusSchema.optional(),
});
export type ListIncidentsQuery = z.infer<typeof ListIncidentsQuerySchema>;

export const IncidentListResponseSchema = PaginatedResponseSchema(IncidentDtoSchema);
export type IncidentListResponse = z.infer<typeof IncidentListResponseSchema>;

export const IncidentResponseSchema = IncidentDtoSchema;
export type IncidentResponse = IncidentDto;

// Compile-time mirror check: the DTO must stay mutually assignable with the
// domain contract. If domain types drift, this line stops compiling.
const _incidentMirrorsDomain: MirrorWith<IncidentDto, Incident> = true;
