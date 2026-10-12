// Type-only import: pulls the fastify module augmentation (Session and
// request.tenantContext) into every program that imports this package.
import type {} from './session/fastify-session';
export { AuthError, SessionRevokedError } from './errors';
export { authPlugin } from './session/plugin';
export { PostgresSessionStore } from './session/store';
export { revokeUserSessions } from './session/revocation';
export { CSRF_HEADER_NAME, csrfTokenFor, isCsrfTokenValid } from './csrf';
export { withTenantContext, loadTenantContext, requireTenantContext, type TenantCredentials } from './tenancy';
export { writeAuditEvent, type AuditEventInput } from './audit';
export { SESSION_COOKIE_NAME, sessionCookieOptions, resolveAuthOptions, type AuthOptions } from './config';
export type { OidcAdapter, LoginFlow, ExchangeCodeParams } from './oidc/types';
export { StubIdp, type StubIdpOptions } from './oidc/stub-idp';
export { EntraIdp, type EntraIdpOptions, type EntraIdpDiscoverOptions } from './oidc/entra-idp';
export {
  validateIdTokenClaims,
  verifyJwtHS256,
  signJwt,
  type IdTokenClaims,
  type IdTokenValidationOptions,
  type IdTokenValidationResult,
} from './oidc/jwt';
export { CsrfTokenResponseSchema, AuthCallbackQuerySchema, type CsrfTokenResponse } from './contracts';
