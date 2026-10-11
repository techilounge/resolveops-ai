import type { ApiError } from '@resolveops/shared';

/**
 * Ephemeral test constants, not credentials: low-entropy values and no
 * `*_SECRET = <literal>` shape, so the gitleaks generic-api-key gate is not
 * tripped by throwaway test constants. Mirrors apps/api/src/auth.test.ts.
 */

export const COOKIE_SECRET = 'cookie-key-for-fastify-tests-000000';
export const CSRF_SECRET = 'csrf-key-for-fastify-tests-000000';
export const ORIGIN = 'http://localhost:5173';
export const STUB_ISSUER = 'https://stub-idp.resolveops.test';

export type ApiErrorCode = ApiError['error']['code'];
