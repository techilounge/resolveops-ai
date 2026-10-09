import { z } from 'zod';
import { TenantRoleSchema } from './tenancy';

// GET /api/v1/me — authenticated profile/memberships (Blueprint §11).
export const MembershipSchema = z.object({
  organizationId: z.string().uuid(),
  role: TenantRoleSchema,
});
export type Membership = z.infer<typeof MembershipSchema>;

export const MeResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    displayName: z.string().min(1),
    email: z.string().email(),
  }),
  memberships: z.array(MembershipSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
