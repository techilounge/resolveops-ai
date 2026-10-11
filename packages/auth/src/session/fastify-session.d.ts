import type { TenantContext } from '@resolveops/shared';

/**
 * Session payload contract — the brief's allowlist: userId, activeOrgId
 * (nullable until onboarding), membershipRole, authEpoch. Nothing else may be
 * stored in the session (the CSRF token is derived from the sid, not stored).
 */
declare module 'fastify' {
  interface Session {
    /** users.id — present once login completed. */
    userId?: string;
    /** Selected organization; null until onboarding/org switch. */
    activeOrgId?: string | null;
    /** Role on the active membership; refreshed on every tenant request. */
    membershipRole?: TenantContext['role'] | null;
    /** users.auth_epoch snapshot at login; the store validates it per request. */
    authEpoch?: number;
  }

  interface FastifyRequest {
    /** Set by the tenant guard for tenant-owned routes. */
    tenantContext?: TenantContext;
  }
}
