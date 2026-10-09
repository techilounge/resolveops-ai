import { z } from 'zod';

// Roles per Blueprint §7. `approver` and the future `executor` are
// privileges layered onto roles, not roles themselves — they stay out of
// this enum until a phase defines them in the role matrix.
export const TENANT_ROLES = ['owner', 'admin', 'analyst', 'technician', 'viewer'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];
export const TenantRoleSchema = z.enum(TENANT_ROLES);

// Server-verified tenant context (ADR-002): the API derives it from the
// authenticated session's verified membership — a client-supplied tenant
// identifier is never trusted on its own. Identity authentication is not
// authorization (Blueprint §7). Interface only: this is the shape later
// phases (identity, RLS scoping) must produce, not a wire DTO, and Phase 0
// attaches no enforcement logic to it.
export interface TenantContext {
  organizationId: string;
  userId: string;
  role: TenantRole;
}
