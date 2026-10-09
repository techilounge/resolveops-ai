import { z } from 'zod';

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
