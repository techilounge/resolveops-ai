import type { Pool } from 'pg';
import type { OidcAdapter } from './oidc/types';

/** Session cookie name — stable across the API so handlers/tests agree. */
export const SESSION_COOKIE_NAME = 'resolveops.sid';

export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // absolute 12h
export const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000; // idle 30m
export const DEFAULT_LOGIN_FLOW_TTL_MS = 10 * 60 * 1000; // login flow 10m
export const DEFAULT_RATE_LIMIT_MAX = 30;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

export interface AuthOptions {
  /** Pool connecting as `resolveops_app` (RLS-enforced, no BYPASSRLS). */
  pool: Pool;
  adapter: OidcAdapter;
  /** Cookie-signing secret for @fastify/session (opaque sid cookie). */
  cookieSecret: string;
  /** HMAC secret for the synchronizer CSRF token. */
  csrfSecret: string;
  /** Exact scheme+host origins allowed to issue mutating calls. */
  allowedOrigins: string[];
  /** Default true; test/dev over plain http may run false. */
  cookieSecure?: boolean;
  sessionTtlMs?: number;
  idleTtlMs?: number;
  loginFlowTtlMs?: number;
  /** Public base URL for the OIDC redirect_uri. Required: OIDC redirect URIs are always absolute. */
  publicBaseUrl?: string;
  rateLimitMax?: number;
  rateLimitTimeWindowMs?: number;
}

export interface ResolvedAuthOptions {
  pool: Pool;
  adapter: OidcAdapter;
  cookieSecret: string;
  csrfSecret: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  sessionTtlMs: number;
  idleTtlMs: number;
  loginFlowTtlMs: number;
  publicBaseUrl: string;
  rateLimitMax: number;
  rateLimitTimeWindowMs: number;
}

export function resolveAuthOptions(options: AuthOptions): ResolvedAuthOptions {
  if (options.cookieSecret.length < 32) {
    throw new Error('AuthOptions.cookieSecret must be at least 32 characters.');
  }
  if (options.csrfSecret.length < 32) {
    throw new Error('AuthOptions.csrfSecret must be at least 32 characters.');
  }
  if (options.allowedOrigins.length === 0) {
    throw new Error('AuthOptions.allowedOrigins must list at least one deployment origin.');
  }
  return {
    pool: options.pool,
    adapter: options.adapter,
    cookieSecret: options.cookieSecret,
    csrfSecret: options.csrfSecret,
    allowedOrigins: options.allowedOrigins,
    cookieSecure: options.cookieSecure ?? true,
    sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    idleTtlMs: options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
    loginFlowTtlMs: options.loginFlowTtlMs ?? DEFAULT_LOGIN_FLOW_TTL_MS,
    // OIDC requires absolute redirect_uris — tests pass an explicit fake host
    // (e.g. http://api.test); servers must configure their public base URL.
    publicBaseUrl: options.publicBaseUrl ?? 'http://localhost:3000',
    rateLimitMax: options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
    rateLimitTimeWindowMs: options.rateLimitTimeWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  };
}

/**
 * Cookie shape: HttpOnly + SameSite=Lax always, Secure by default (the CSRF
 * origin check does the cross-site work; Lax keeps top-level navigations
 * working). maxAge IS the session's absolute expiry — the store enforces it
 * server-side from the row, the browser just stops sending the cookie.
 */
export function sessionCookieOptions(secure: boolean, sessionTtlMs: number): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
} {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: sessionTtlMs };
}
