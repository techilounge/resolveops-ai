import { z } from 'zod';
import { TenantRoleSchema } from './tenancy';

export const MembershipStatusSchema = z.enum(['active', 'invited', 'revoked']);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

/**
 * One membership as /me reports it (Phase 1 spec §4.3): role, and — the whole
 * point of the endpoint — whether it is active or still an invitation.
 * `organizationName` is resolved server-side through per-org tenant-context
 * reads (RLS-legal: the org is the user's own verified membership target);
 * null only in the degenerate case of an org row disappearing mid-request.
 */
export const MembershipSchema = z
  .object({
    organizationId: z.string().uuid(),
    organizationName: z.string().max(200).nullable(),
    role: TenantRoleSchema,
    status: MembershipStatusSchema,
  })
  .strict();
export type Membership = z.infer<typeof MembershipSchema>;

export const MeResponseSchema = z
  .object({
    user: z
      .object({
        id: z.string().uuid(),
        displayName: z.string().min(1),
        email: z.string().email(),
      })
      .strict(),
    memberships: z.array(MembershipSchema),
  })
  .strict();
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const MeUserSchema = MeResponseSchema.shape.user;
export type MeUser = z.infer<typeof MeUserSchema>;

/**
 * POST /api/v1/me/active-organization (delta D2) — request and refreshed
 * context response. The server verifies an active membership; the client
 * never gets to assert role or context.
 */
export const SwitchOrganizationRequestSchema = z
  .object({ organizationId: z.string().uuid() })
  .strict();
export type SwitchOrganizationRequest = z.infer<typeof SwitchOrganizationRequestSchema>;

export const ActiveOrganizationResponseSchema = z
  .object({
    organizationId: z.string().uuid(),
    role: TenantRoleSchema,
  })
  .strict();
export type ActiveOrganizationResponse = z.infer<typeof ActiveOrganizationResponseSchema>;
