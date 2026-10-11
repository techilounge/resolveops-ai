import { z } from 'zod';
import { TenantRoleSchema } from './tenancy';
import { PaginatedResponseSchema } from './pagination';

// Organization contracts — POST /api/v1/organizations (authorized tenant
// creation) and GET /api/v1/organizations/current (validated organization
// context), per Blueprint §11.
export const OrganizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  // Server-generated on create (the request contract has no slug input) and
  // unique per organization (migration 001).
  slug: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

/**
 * POST /api/v1/organizations response: the created organization plus the
 * creating user's owner membership — both written in ONE transaction
 * (Phase 1 spec §4.3), so the response presents them together.
 */
export const OrganizationCreatedResponseSchema = z
  .object({
    organization: OrganizationSchema,
    membership: z.object({
      role: TenantRoleSchema,
      status: z.enum(['active', 'invited', 'revoked']),
    }),
  })
  .strict();
export type OrganizationCreatedResponse = z.infer<typeof OrganizationCreatedResponseSchema>;

/**
 * GET /api/v1/organizations/current response: the validated organization
 * context — the guard has verified the session's active membership; the
 * caller's role rides along for shell rendering (P1-5).
 */
export const CurrentOrganizationResponseSchema = z
  .object({
    organization: OrganizationSchema,
    role: TenantRoleSchema,
  })
  .strict();
export type CurrentOrganizationResponse = z.infer<typeof CurrentOrganizationResponseSchema>;

// Strict on purpose: unknown keys in a request body are client errors, not
// fields to silently drop.
export const CreateOrganizationRequestSchema = z
  .object({ name: z.string().min(1).max(200) })
  .strict();
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;

/**
 * One membership row as the member list reports it (delta D2). Includes
 * invited-but-not-yet-active members so the roster shows pending invites.
 */
export const MemberSchema = z
  .object({
    userId: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1),
    role: TenantRoleSchema,
    status: z.enum(['active', 'invited', 'revoked']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Member = z.infer<typeof MemberSchema>;

export const MemberListResponseSchema = PaginatedResponseSchema(MemberSchema);
export type MemberListResponse = z.infer<typeof MemberListResponseSchema>;

/**
 * POST /api/v1/organizations/current/invitations (delta D2) — creates a
 * status='invited' membership; owner/admin only, and granting the owner role
 * is owner-only (an admin elevating someone to owner is an escalation vector).
 * If no user with this email exists yet, a pending identity is provisioned and
 * bound to the real Entra subject at first login (Phase 1 spec §4.3).
 */
export const CreateInvitationRequestSchema = z
  .object({
    email: z.string().email().max(320),
    role: TenantRoleSchema.default('analyst'),
  })
  .strict();
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;
