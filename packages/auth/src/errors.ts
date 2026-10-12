import type { ApiErrorCode } from '@resolveops/shared';

/**
 * Error type raised by the auth layer. The API's shared error handler turns
 * it into the shared `ApiErrorSchema` envelope; `clearSessionCookie` asks the
 * handler to also drop the session cookie (used on revocation so a stolen
 * cookie cannot outlive its row).
 */
export class AuthError extends Error {
  readonly code: ApiErrorCode;

  readonly clearSessionCookie: boolean;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { clearSessionCookie?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AuthError';
    this.code = code;
    this.clearSessionCookie = options.clearSessionCookie ?? false;
  }
}

/**
 * Raised by the session store when a presented session row still exists but
 * its `auth_epoch` copy no longer matches `users.auth_epoch` — i.e. the
 * session was revoked (or superseded) and the row outlived the bump. The API
 * handler maps this to 401 + cleared cookie.
 */
export class SessionRevokedError extends AuthError {
  constructor(message = 'Session was revoked.') {
    super('UNAUTHORIZED', message, { clearSessionCookie: true });
    this.name = 'SessionRevokedError';
  }
}
