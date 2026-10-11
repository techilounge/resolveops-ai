import { describe, expect, it } from 'vitest';
import { signJwt, validateIdTokenClaims, verifyJwtHS256, type JsonValue } from './oidc/jwt';

type JsonPayload = { [key: string]: JsonValue };

const SECRET = 'test-secret-for-hmac-signing-0123456789';
const NOW_SEC = 1_700_000_000;

function makePayload(overrides: JsonPayload = {}): JsonPayload {
  return {
    iss: 'https://stub-idp.resolveops.test',
    sub: 'user-1',
    aud: 'client-under-test',
    exp: NOW_SEC + 600,
    iat: NOW_SEC,
    nonce: 'nonce-1',
    email: 'user-1@example.com',
    name: 'User One',
    ...overrides,
  };
}

describe('signJwt / verifyJwtHS256', () => {
  it('round-trips claims through sign and verify', () => {
    const token = signJwt(makePayload(), SECRET);
    const decoded = verifyJwtHS256(token, SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded?.signatureValid).toBe(true);
    expect(decoded?.payload.iss).toBe('https://stub-idp.resolveops.test');
    expect(decoded?.payload.sub).toBe('user-1');
  });

  it('rejects a signature from a different key', () => {
    const token = signJwt(makePayload(), 'another-secret-entirely-0123456789');
    const decoded = verifyJwtHS256(token, SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded?.signatureValid).toBe(false);
  });

  it('rejects a tampered payload with a valid-signature prefix', () => {
    const token = signJwt(makePayload(), SECRET);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ iss: 'https://evil.test', sub: 'admin' }), 'utf8').toString('base64url');
    const decoded = verifyJwtHS256(`${header}.${forgedPayload}.${signature}`, SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded?.signatureValid).toBe(false);
  });

  it('returns null for tokens that are not three-segment HS256 JWTs', () => {
    expect(verifyJwtHS256('not-a-jwt', SECRET)).toBeNull();
    expect(verifyJwtHS256('a.b', SECRET)).toBeNull();
    const rs256 = signJwt(makePayload(), SECRET).split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), 'utf8').toString('base64url');
    expect(verifyJwtHS256(`${header}.${rs256[1]}.${rs256[2]}`, SECRET)).toBeNull();
  });
});

describe('validateIdTokenClaims', () => {
  const options = {
    issuer: 'https://stub-idp.resolveops.test',
    audience: 'client-under-test',
    now: NOW_SEC * 1000,
  };

  it('accepts claims matching issuer, audience, and expiry, mapping profile fields', () => {
    const result = validateIdTokenClaims(makePayload(), options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.issuer).toBe(options.issuer);
      expect(result.claims.subject).toBe('user-1');
      expect(result.claims.audience).toBe(options.audience);
      expect(result.claims.email).toBe('user-1@example.com');
      expect(result.claims.displayName).toBe('User One');
      expect(result.claims.nonce).toBe('nonce-1');
      expect(result.claims.expiresAt).toBe(NOW_SEC + 600);
    }
  });

  it('rejects a mismatched issuer', () => {
    const result = validateIdTokenClaims(makePayload({ iss: 'https://evil.test' }), options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/issuer/i);
  });

  it('rejects a token where the client is not in the audience', () => {
    const result = validateIdTokenClaims(makePayload({ aud: 'someone-else' }), options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/audience/i);
  });

  it('accepts an array audience containing the client', () => {
    const result = validateIdTokenClaims(makePayload({ aud: ['client-under-test', 'other'] }), options);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.audience).toBe('client-under-test');
  });

  it('rejects an expired exp', () => {
    const result = validateIdTokenClaims(makePayload({ exp: NOW_SEC - 60 }), options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/i);
  });

  it('accepts exp within the clock-tolerance window but rejects beyond it', () => {
    const slightlyStale = validateIdTokenClaims(makePayload({ exp: NOW_SEC - 10 }), options);
    expect(slightlyStale.ok).toBe(true); // within the default 30s tolerance
    const farStale = validateIdTokenClaims(makePayload({ exp: NOW_SEC - 60 }), { ...options, clockToleranceSec: 0 });
    expect(farStale.ok).toBe(false);
  });

  it('rejects a missing subject', () => {
    const result = validateIdTokenClaims(makePayload({ sub: '' }), options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/subject/i);
  });

  it('maps non-string profile claims to null rather than passing them through', () => {
    const result = validateIdTokenClaims(makePayload({ email: 42, name: true, nonce: 7 }), options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.email).toBeNull();
      expect(result.claims.displayName).toBeNull();
      expect(result.claims.nonce).toBeNull();
    }
  });
});
