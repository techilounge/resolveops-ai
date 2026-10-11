import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT encode/decode plus the shared ID-token claim validation.
 * The stub signs and validates with these helpers; Part B's EntraIdp reuses
 * `validateIdTokenClaims` for the real issuer (RS256/JWKS handling lives in
 * `openid-client`, not here).
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface IdTokenClaims {
  issuer: string;
  subject: string;
  audience: string;
  email: string | null;
  displayName: string | null;
  /** Nonce echoed from the authorization request; the API checks it against login_flow_state. */
  nonce: string | null;
  /** Unix seconds. */
  expiresAt: number;
}

export interface IdTokenValidationOptions {
  issuer: string;
  audience: string;
  /** Injected clock, unix millis. */
  now?: number;
  /** Tolerance for clock skew on exp checks (seconds). */
  clockToleranceSec?: number;
}

export type IdTokenValidationResult =
  | { ok: true; claims: IdTokenClaims }
  | { ok: false; reason: string };

function base64UrlJson(value: JsonValue): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseBase64UrlJson<T extends JsonValue>(segment: string): T | null {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Signs a compact HS256 JWT. Payload timestamps are the caller's job. */
export function signJwt(payload: { [key: string]: JsonValue }, key: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createHmac('sha256', key).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export interface DecodedJwt {
  payload: { [key: string]: JsonValue };
  signatureValid: boolean;
}

/** Verifies the HS256 signature only; claim checks live in validateIdTokenClaims. */
export function verifyJwtHS256(token: string, key: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = parseBase64UrlJson<{ alg?: JsonValue; typ?: JsonValue }>(headerSegment);
  if (!header || header.alg !== 'HS256') {
    return null;
  }
  const expected = createHmac('sha256', key).update(`${headerSegment}.${payloadSegment}`).digest();
  const presented = Buffer.from(signatureSegment, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { payload: parseBase64UrlJson<{ [key: string]: JsonValue }>(payloadSegment) ?? {}, signatureValid: false };
  }
  const payload = parseBase64UrlJson<{ [key: string]: JsonValue }>(payloadSegment);
  return payload ? { payload, signatureValid: true } : null;
}

/**
 * Shared claim rule set (iss/aud/exp with clock tolerance). The stub applies
 * it to tokens it just minted (proving the validator); Part B applies it to
 * real Entra tokens.
 */
export function validateIdTokenClaims(
  payload: { [key: string]: JsonValue },
  options: IdTokenValidationOptions,
): IdTokenValidationResult {
  const nowSec = (options.now ?? Date.now()) / 1000;
  const tolerance = options.clockToleranceSec ?? 30;

  if (payload.iss !== options.issuer) {
    return { ok: false, reason: `ID token issuer mismatch: expected ${options.issuer}` };
  }
  const audience = payload.aud;
  const audienceOk = audience === options.audience
    || (Array.isArray(audience) && audience.includes(options.audience));
  if (!audienceOk) {
    return { ok: false, reason: `ID token audience mismatch: expected ${options.audience}` };
  }
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  if (exp === null || exp + tolerance <= nowSec) {
    return { ok: false, reason: 'ID token expired' };
  }
  const subject = payload.sub;
  if (typeof subject !== 'string' || subject.length === 0) {
    return { ok: false, reason: 'ID token subject missing' };
  }
  const email = typeof payload.email === 'string' && payload.email.length > 0 ? payload.email : null;
  const displayName = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : null;
  const nonce = typeof payload.nonce === 'string' && payload.nonce.length > 0 ? payload.nonce : null;
  return {
    ok: true,
    claims: {
      issuer: options.issuer,
      subject,
      audience: options.audience,
      email,
      displayName,
      nonce,
      expiresAt: exp,
    },
  };
}
