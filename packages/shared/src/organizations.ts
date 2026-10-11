import { z } from 'zod';
import { TenantRoleSchema } from './tenancy';
import { PaginatedResponseSchema } from './pagination';

// Organization contracts — POST /api/v1/organizations (authorized tenant
// creation) and GET /api/v1/organizations/current (validated organization
// context), per Blueprint §11.
export const OrganizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

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
