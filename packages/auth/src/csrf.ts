import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header every mutating API call must carry the synchronizer token in. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Synchronizer token for a session: HMAC(server secret, session id).
 *
 * Stateless derivation (as in Django) rather than a stored random token — the
 * brief caps session contents at userId/activeOrgId/membershipRole/authEpoch,
 * so the token cannot live in the session. It is still bound to the session
 * (rotates with the sid at login), is not computable without the server
 * secret, and is validated with a timing-safe comparison.
 */
export function csrfTokenFor(sessionId: string, csrfSecret: string): string {
  return createHmac('sha256', csrfSecret).update(`csrf:${sessionId}`).digest('base64url');
}

/** Timing-safe token check; false on any length or content mismatch. */
export function isCsrfTokenValid(sessionId: string, csrfSecret: string, presented: string): boolean {
  const expected = Buffer.from(csrfTokenFor(sessionId, csrfSecret));
  const presentedBuffer = Buffer.from(presented);
  if (presentedBuffer.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(presentedBuffer, expected);
}
