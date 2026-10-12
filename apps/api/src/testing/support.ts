import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { expect } from 'vitest';
import {
  auditReaderDatabaseUrl,
  ensureAuditReaderPassword,
  seedIsolatedOrgs,
  type IsolatedOrgsFixture,
} from '@resolveops/database/testing';
import type { AppRolePoolResult } from '@resolveops/auth/testing';
import {
  SESSION_COOKIE_NAME,
  StubIdp,
  csrfTokenFor,
  type AuthOptions,
} from '@resolveops/auth';
import { ApiErrorSchema, type ApiError } from '@resolveops/shared';
import { buildApp } from '../app';
import { COOKIE_SECRET, CSRF_SECRET, ORIGIN, STUB_ISSUER } from './constants';

/**
 * Shared harness for the DB-backed resource-route suites. Reuses the shared
 * `resolveops_test` database and the P1-3 discipline: every fixture gets a
 * fresh UUID, no-op pool error listeners keep teardown quiet, and pools end
 * in beforeAll/afterAll order. No-op when no local Postgres is configured
 * (CI always provides one).
 */

export interface TestSession {
  /** Raw signed Set-Cookie value — exactly what a browser would store. */
  cookie: string;
  /** Synchronizer CSRF token computed from the unsigned sid. */
  csrfToken: string;
  /** The app-side user id the session resolved to. */
  userId: string;
  subject: string;
  email: string;
}

export interface TestContext {
  app: FastifyInstance;
  appRolePool: Pool;
  superuserPool: Pool;
  fixture: IsolatedOrgsFixture;
  /** The stub IdP backing `login`/`member` — exposed for flow-level probes. */
  stub: StubIdp;
  /** Signs in (stub IdP) and seeds the caller's membership in the given org. */
  member: (options?: MemberOptions) => Promise<TestSession>;
  /** Signs in (stub IdP) with NO membership — the no-organization user. */
  loginOnly: () => Promise<TestSession>;
  /** Full stub-IdP login using the app's own adapter (PKCE codes live there). */
  login: (subject: string, email: string, displayName?: string) => Promise<{ cookie: string }>;
}

export interface MemberOptions {
  role?: 'owner' | 'admin' | 'analyst' | 'technician' | 'viewer';
  orgId?: string;
}

function setCookieValues(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}

function sessionCookieValue(response: { headers: Record<string, unknown> }): string {
  const cookie = setCookieValues(response).find((value) =>
    value.startsWith(`${SESSION_COOKIE_NAME}=`),
  );
  if (!cookie) throw new Error('no session cookie on response');
  return cookie.split(';')[0].slice(SESSION_COOKIE_NAME.length + 1);
}

/** The store row's sid: @fastify/session signs cookies as `s:<sid>.<hmac>`. */
export function unsignedSid(rawCookieValue: string): string {
  const decoded = decodeURIComponent(rawCookieValue);
  const unsigned = decoded.startsWith('s:') ? decoded.slice(2) : decoded;
  const signatureStart = unsigned.lastIndexOf('.');
  return signatureStart > 0 ? unsigned.slice(0, signatureStart) : unsigned;
}

export function expectEnvelope(
  response: { statusCode: number; body: string },
  code: ApiError['error']['code'],
): ApiError {
  const parsed = ApiErrorSchema.parse(JSON.parse(response.body));
  expect(
    parsed.error.code,
    `expected ${code} envelope (status ${response.statusCode}), got: ${response.body}`,
  ).toBe(code);
  return parsed;
}

/**
 * Transient Postgres conflicts from concurrent role bootstrap: parallel vitest
 * workers each run connectAuthTestDatabase, and ensureAppRolePassword's ALTER
 * ROLE (packages/auth, report-only for this wave — race documented in the PR
 * body) can lose the race with "tuple concurrently updated". A short retry
 * loop around the whole connect keeps the suite deterministic without editing
 * the merged auth package.
 */
const BOOTSTRAP_CONFLICT_MARKERS = ['tuple concurrently updated', 'deadlock detected'];

async function connectAuthTestDatabaseWithRetry(
  attempts = 5,
): Promise<AppRolePoolResult | undefined> {
  const { connectAuthTestDatabase } = await import('@resolveops/auth/testing');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connectAuthTestDatabase();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = BOOTSTRAP_CONFLICT_MARKERS.some((marker) => message.includes(marker));
      if (!transient || attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
  return undefined;
}

export async function createTestContext(
  overrides: Partial<AuthOptions> = {},
): Promise<TestContext | undefined> {
  const { attachNoOpPoolErrorListeners } = await import('@resolveops/auth/testing');
  const setup = await connectAuthTestDatabaseWithRetry();
  if (!setup) return undefined;

  const { appRolePool, superuserPool } = setup;
  attachNoOpPoolErrorListeners(appRolePool, superuserPool);
  await ensureAuditReaderPassword(superuserPool);

  const readerUrl = auditReaderDatabaseUrl();
  const auditReaderPool = new Pool({ connectionString: readerUrl, max: 2 });
  attachNoOpPoolErrorListeners(auditReaderPool);

  const stub = new StubIdp({ issuer: STUB_ISSUER, clientId: 'resolveops-api-dev' });
  const auth: AuthOptions = {
    pool: appRolePool,
    adapter: stub,
    cookieSecret: COOKIE_SECRET,
    csrfSecret: CSRF_SECRET,
    allowedOrigins: [ORIGIN],
    cookieSecure: false,
    publicBaseUrl: 'http://api.test',
    // Route tests exercise per-route behavior; P1-3's dedicated suite proves
    // the rate limiter. A high ceiling keeps these suites hermetic.
    rateLimitMax: 100_000,
    // Overrides let adversarial suites build the same app with, e.g., a tiny
    // rate-limit budget; explicit overrides win over the hermetic defaults.
    ...overrides,
  };
  const app = buildApp({ auth, auditReaderPool });
  await app.ready();

  const fixture = await seedIsolatedOrgs(superuserPool);

  /** Full stub login: /auth/login → stub authorize → /auth/callback. */
  async function login(
    subject: string,
    email: string,
    displayName = subject,
  ): Promise<{ cookie: string }> {
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    expect(start.statusCode).toBe(302);
    const authorizeUrl = start.headers.location as string;
    const state = new URL(authorizeUrl).searchParams.get('state') as string;
    const callbackUrl = await stub.authorizeFromUrl(authorizeUrl, {
      subject,
      email,
      displayName,
    });
    const code = new URL(callbackUrl).searchParams.get('code') as string;
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(302);
    return { cookie: sessionCookieValue(callback) };
  }

  async function provisionedUserId(subject: string): Promise<string> {
    const row = await superuserPool.query<{ id: string }>(
      'SELECT id FROM users WHERE entra_issuer = $1 AND entra_subject = $2',
      [STUB_ISSUER, subject],
    );
    if (row.rows.length !== 1) throw new Error(`no provisioned user for ${subject}`);
    return row.rows[0].id;
  }

  const loginOnly = async (): Promise<TestSession> => {
    const suffix = randomUUID();
    const subject = `mem-${suffix}`;
    const email = `${subject}@example.com`;
    const { cookie } = await login(subject, email, `Member ${suffix.slice(0, 6)}`);
    const userId = await provisionedUserId(subject);
    return {
      cookie,
      csrfToken: csrfTokenFor(unsignedSid(cookie), CSRF_SECRET),
      userId,
      subject,
      email,
    };
  };

  const member = async (options: MemberOptions = {}): Promise<TestSession> => {
    const session = await loginOnly();
    await superuserPool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role, status) VALUES ($1, $2, $3, $4, 'active')`,
      [randomUUID(), options.orgId ?? fixture.orgAId, session.userId, options.role ?? 'owner'],
    );
    return session;
  };

  return { app, appRolePool, superuserPool, fixture, stub, member, loginOnly, login };
}

export async function destroyTestContext(context: TestContext): Promise<void> {
  await context.app.close();
  await context.appRolePool.end();
  await context.superuserPool.end();
}

/**
 * The raw session cookie is URL-encoded by @fastify/session (`s%3A<sid>.<hmac>`).
 * light-my-request's `cookies` option re-encodes the `%` and the server then
 * fails the signature check — send the header verbatim instead (probe-verified:
 * header → 200, cookies option → 401 on the same session).
 */
function sessionCookieHeader(session: TestSession | undefined): Record<string, string> {
  return session ? { cookie: `${SESSION_COOKIE_NAME}=${session.cookie}` } : {};
}

/** Authenticated mutating request (cookie + CSRF synchronizer + Origin). */
export function mutate(
  context: TestContext,
  session: TestSession,
  method: 'POST' | 'PATCH',
  url: string,
  payload?: object,
): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  return context.app.inject({
    method,
    url,
    headers: { ...sessionCookieHeader(session), origin: ORIGIN, 'x-csrf-token': session.csrfToken },
    payload,
  });
}

/** Authenticated read (cookie only — CSRF protects mutating calls). */
export function read(
  context: TestContext,
  session: TestSession | undefined,
  url: string,
): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  return context.app.inject({
    method: 'GET',
    url,
    headers: sessionCookieHeader(session),
  });
}

/**
 * Superuser audit probe — the tests read audit rows out of band. The optional
 * targetId scopes the count to one entity: the shared fixture seeds its own
 * audit rows (e.g. 'incident.created' for the pre-seeded incidents), so
 * unscoped counts cannot assert "exactly this event".
 */
export async function auditCount(
  context: TestContext,
  organizationId: string,
  action: string,
  targetId?: string,
): Promise<number> {
  const result = targetId
    ? await context.superuserPool.query<{ count: string }>(
        'SELECT count(*) AS count FROM audit_events WHERE organization_id = $1 AND action = $2 AND target_id = $3',
        [organizationId, action, targetId],
      )
    : await context.superuserPool.query<{ count: string }>(
        'SELECT count(*) AS count FROM audit_events WHERE organization_id = $1 AND action = $2',
        [organizationId, action],
      );
  return Number(result.rows[0].count);
}
