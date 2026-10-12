import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Signer } from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ApiErrorSchema } from '@resolveops/shared';
import {
  EntraIdp,
  PostgresSessionStore,
  SESSION_COOKIE_NAME,
  StubIdp,
  requireTenantContext,
  revokeUserSessions,
  type AuthOptions,
} from '@resolveops/auth';
import {
  attachNoOpPoolErrorListeners,
  connectAuthTestDatabase,
} from '@resolveops/auth/testing';
import { seedIsolatedOrgs, type IsolatedOrgsFixture } from '@resolveops/database/testing';
import { buildApp } from './app';

/**
 * Phase 1 auth security matrix over HTTP (Phase 1 Blueprint §4.2/§5/§7):
 * stub-IdP login with state/nonce/PKCE + session rotation, callback failure
 * paths, epoch revocation (401 + cleared cookie), no resurrection after a
 * simulated restart, synchronizer-CSRF + Origin enforcement on mutating
 * routes, tenant-guard denials with audit rows, and rate limiting.
 *
 * Runs against a REAL Postgres via the `resolveops_app` role (grants + RLS
 * are part of the system under test); every test no-ops when no local
 * Postgres is configured (CI always provides one).
 */

// Ephemeral test fixtures, not credentials: low-entropy values and no
// `*_SECRET = <literal>` shape, so the gitleaks generic-api-key gate is not
// tripped by throwaway test constants.
const COOKIE_SECRET = 'cookie-key-for-fastify-tests-000000';
const CSRF_SECRET = 'csrf-key-for-fastify-tests-000000';
const ORIGIN = 'http://localhost:5173';
const STUB_ISSUER = 'https://stub-idp.resolveops.test';

function authOptions(pool: Pool, adapter: StubIdp, overrides: Partial<AuthOptions> = {}): AuthOptions {
  return {
    pool,
    adapter,
    cookieSecret: COOKIE_SECRET,
    csrfSecret: CSRF_SECRET,
    allowedOrigins: [ORIGIN],
    cookieSecure: false,
    publicBaseUrl: 'http://api.test',
    ...overrides,
  };
}

function setCookieValues(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}

function sessionSid(response: { headers: Record<string, unknown> }): string | undefined {
  const cookie = setCookieValues(response).find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!cookie) return undefined;
  // The RAW Set-Cookie value (signed, still encoded) — exactly what a browser
  // would store and send back on later requests.
  return cookie.split(';')[0].slice(SESSION_COOKIE_NAME.length + 1);
}

/** The store row's sid: @fastify/session signs cookies as `<sid>.<hmac>`. */
function unsignedSid(rawCookieValue: string): string {
  const decoded = decodeURIComponent(rawCookieValue);
  const unsigned = decoded.startsWith('s:') ? decoded.slice(2) : decoded;
  const signatureStart = unsigned.lastIndexOf('.');
  return signatureStart > 0 ? unsigned.slice(0, signatureStart) : unsigned;
}

// Seeded sessions present their sid the way a browser would: signed with the
// same secret the app's session plugin uses (@fastify/cookie's Signer).
const cookieSigner = new Signer(COOKIE_SECRET);
function seededCookie(sid: string): string {
  return `${SESSION_COOKIE_NAME}=${cookieSigner.sign(sid)}`;
}

function expectEnvelope(res: { body: string }, code: string): void {
  const body = ApiErrorSchema.parse(JSON.parse(res.body));
  expect(body.error.code).toBe(code);
}

describe('auth security matrix (HTTP)', () => {
  let appRolePool: Pool;
  let superuserPool: Pool;
  let app: FastifyInstance;
  const stub = new StubIdp({ issuer: STUB_ISSUER, clientId: 'resolveops-api-dev' });
  let fixture: IsolatedOrgsFixture | undefined;

  beforeAll(async () => {
    const setup = await connectAuthTestDatabase();
    if (!setup) {
      return;
    }
    attachNoOpPoolErrorListeners(setup.appRolePool, setup.superuserPool);
    appRolePool = setup.appRolePool;
    superuserPool = setup.superuserPool;
    app = buildApp({ auth: authOptions(appRolePool, stub) });
    fixture = await seedIsolatedOrgs(superuserPool);
  });

  afterAll(async () => {
    await appRolePool?.end();
    await superuserPool?.end();
  });

  /** Drives one full stub login against `target`: login redirect → stub authorization → callback. */
  async function fullLogin(
    target: FastifyInstance,
    subject: string,
    claims: { email?: string; displayName?: string } = {},
  ): Promise<{ start: { headers: Record<string, unknown>; statusCode: number }; callback: { headers: Record<string, unknown>; statusCode: number; body: string }; state: string }> {
    const start = await target.inject({ method: 'GET', url: '/api/v1/auth/login' });
    expect(start.statusCode).toBe(302);
    const authorizeUrl = start.headers.location as string;
    const state = new URL(authorizeUrl).searchParams.get('state') as string;
    // The stub's local authorization endpoint — plays the browser + IdP.
    const callbackUrl = await stub.authorizeFromUrl(authorizeUrl, {
      subject,
      email: claims.email,
      displayName: claims.displayName,
    });
    const code = new URL(callbackUrl).searchParams.get('code') as string;
    const callback = await target.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    });
    return { start, callback, state };
  }

  function loginFlowState(state: string): Promise<{ nonce: string; code_verifier: string; expires_at: Date } | undefined> {
    return superuserPool
      .query<{ nonce: string; code_verifier: string; expires_at: Date }>(
        'SELECT nonce, code_verifier, expires_at FROM login_flow_state WHERE state = $1',
        [state],
      )
      .then((result) => result.rows[0]);
  }

  it('no-ops cleanly when no local Postgres is configured', () => {
    if (!superuserPool) return;
    expect(true).toBe(true);
  });

  describe('login flow', () => {
    it('redirects to the stub authorize endpoint with state, nonce, and PKCE S256', async () => {
      if (!superuserPool) return;
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(`${location.origin}${location.pathname}`).toBe(`${STUB_ISSUER}/authorize`);
      expect(location.searchParams.get('response_type')).toBe('code');
      expect(location.searchParams.get('client_id')).toBe('resolveops-api-dev');
      expect(location.searchParams.get('redirect_uri')).toBe('http://api.test/api/v1/auth/callback');
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(location.searchParams.get('code_challenge')).toBeTruthy();
      expect(location.searchParams.get('nonce')).toBeTruthy();
      expect(location.searchParams.get('state')).toBeTruthy();
      const flow = await loginFlowState(location.searchParams.get('state') as string);
      expect(flow).toBeDefined();
      expect(flow!.expires_at.getTime()).toBeGreaterThan(Date.now());
    });

    it('happy path: callback rotates the sid, provisions the user, audits login, lands on /onboarding', async () => {
      if (!superuserPool) return;
      const subject = `alice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { callback } = await fullLogin(app, subject, { email: `${subject}@example.com`, displayName: 'Alice' });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/onboarding');
      const sid = unsignedSid(sessionSid(callback) as string);
      expect(sid).toBeTruthy();

      // Exactly one session row, keyed by the rotated sid, holding ONLY the
      // allowlisted payload fields.
      const rows = await superuserPool.query<{ sid: string; sess: Record<string, unknown> }>(
        'SELECT sid, sess FROM app_sessions',
      );
      const mine = rows.rows.filter((row) => row.sid === sid);
      expect(mine).toHaveLength(1);
      expect(Object.keys(mine[0].sess).sort()).toEqual(['activeOrgId', 'authEpoch', 'membershipRole', 'userId']);
      expect(mine[0].sess.activeOrgId).toBeNull();
      expect(mine[0].sess.membershipRole).toBeNull();

      // The user row exists for the (issuer, subject) with a matching epoch.
      // BIGINT returns as a string from pg; cast for numeric comparison.
      const user = await superuserPool.query<{ id: string; auth_epoch: number; email: string }>(
        'SELECT id, auth_epoch::int AS auth_epoch, email FROM users WHERE entra_issuer = $1 AND entra_subject = $2',
        [STUB_ISSUER, subject],
      );
      expect(user.rows).toHaveLength(1);
      expect(user.rows[0].email).toBe(`${subject}@example.com`);
      expect(mine[0].sess.userId).toBe(user.rows[0].id);
      expect(mine[0].sess.authEpoch).toBe(user.rows[0].auth_epoch);

      // Login is audited as a global (NULL-org) event.
      const audit = await superuserPool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_events WHERE action = 'user.login' AND actor_user_id = $1 AND organization_id IS NULL",
        [user.rows[0].id],
      );
      expect(audit.rows[0].n).toBe('1');
    });

    it('a second login for the same (issuer, subject) reuses the users row and refreshes the profile', async () => {
      if (!superuserPool) return;
      const subject = `bob-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await fullLogin(app, subject, { email: 'bob-old@example.com' });
      await fullLogin(app, subject, { email: 'bob-new@example.com', displayName: 'Bob Prime' });
      const users = await superuserPool.query<{ email: string; display_name: string }>(
        'SELECT email, display_name FROM users WHERE entra_issuer = $1 AND entra_subject = $2',
        [STUB_ISSUER, subject],
      );
      expect(users.rows).toHaveLength(1);
      expect(users.rows[0].email).toBe('bob-new@example.com');
      expect(users.rows[0].display_name).toBe('Bob Prime');
    });

    it('an unknown state is a 400 envelope (no enumeration signal)', async () => {
      if (!superuserPool) return;
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/callback?code=whatever&state=never-issued-state',
      });
      expect(res.statusCode).toBe(400);
      expectEnvelope(res, 'BAD_REQUEST');
    });

    it('an expired state is a 400 (TTL enforced server-side)', async () => {
      if (!superuserPool) return;
      const start = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
      const state = new URL(start.headers.location as string).searchParams.get('state') as string;
      await superuserPool.query(
        "UPDATE login_flow_state SET expires_at = now() - interval '1 second' WHERE state = $1",
        [state],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/callback?code=whatever&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(400);
      expectEnvelope(res, 'BAD_REQUEST');
    });

    it('a nonce mismatch between the stored flow and the ID token is a 400', async () => {
      if (!superuserPool) return;
      const start = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
      const authorizeUrl = start.headers.location as string;
      const state = new URL(authorizeUrl).searchParams.get('state') as string;
      // The token the stub would issue no longer matches the stored nonce.
      await superuserPool.query("UPDATE login_flow_state SET nonce = 'attacker-nonce' WHERE state = $1", [state]);
      const callbackUrl = await stub.authorizeFromUrl(authorizeUrl, { subject: 'nonce-victim' });
      const code = new URL(callbackUrl).searchParams.get('code') as string;
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(400);
      expectEnvelope(res, 'BAD_REQUEST');
      expect((JSON.parse(res.body) as { error: { message: string } }).error.message).toMatch(/nonce/i);
    });

    it('a replayed callback (same code + state) is a 400 — login state is single-use', async () => {
      if (!superuserPool) return;
      const subject = `replay-${Date.now()}`;
      const { start, callback } = await fullLogin(app, subject);
      expect(callback.statusCode).toBe(302);
      const state = new URL(start.headers.location as string).searchParams.get('state') as string;
      const flow = await loginFlowState(state);
      expect(flow).toBeUndefined(); // consumed by the first callback
      const replay = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/callback?code=reused&state=${encodeURIComponent(state)}`,
      });
      expect(replay.statusCode).toBe(400);
      expectEnvelope(replay, 'BAD_REQUEST');
    });

    it('an IdP error response is a 400 envelope', async () => {
      if (!superuserPool) return;
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/callback?error=access_denied&error_description=user+cancelled',
      });
      expect(res.statusCode).toBe(400);
      expectEnvelope(res, 'BAD_REQUEST');
    });

    it('a tampered code_verifier surfaces as a 400 (PKCE binding), not a 500', async () => {
      if (!superuserPool) return;
      const start = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
      const authorizeUrl = start.headers.location as string;
      const state = new URL(authorizeUrl).searchParams.get('state') as string;
      await superuserPool.query("UPDATE login_flow_state SET code_verifier = 'corrupted-verifier' WHERE state = $1", [state]);
      const callbackUrl = await stub.authorizeFromUrl(authorizeUrl, { subject: 'pkce-victim' });
      const code = new URL(callbackUrl).searchParams.get('code') as string;
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(400);
      expectEnvelope(res, 'BAD_REQUEST');
    });
  });

  describe('session revocation and logout', () => {
    it('a session whose epoch no longer matches users.auth_epoch gets 401 + cleared cookie', async () => {
      if (!superuserPool) return;
      const subject = `revoked-${Date.now()}`;
      const { callback } = await fullLogin(app, subject);
      const sid = sessionSid(callback) as string;
      const userId = (
        await superuserPool.query<{ id: string }>(
          'SELECT id FROM users WHERE entra_issuer = $1 AND entra_subject = $2',
          [STUB_ISSUER, subject],
        )
      ).rows[0].id;

      const alive = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf', headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` } });
      expect(alive.statusCode).toBe(200);

      const deleted = await revokeUserSessions(appRolePool, userId);
      expect(deleted).toBe(1);

      const after = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf', headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` } });
      expect(after.statusCode).toBe(401);
      expectEnvelope(after, 'UNAUTHORIZED');
      // The cookie is cleared, not just refused.
      expect(setCookieValues(after).some((value) => value.includes('Max-Age=0'))).toBe(true);
      // Revocation is durable: the row is gone and the epoch was bumped.
      const epoch = await superuserPool.query<{ auth_epoch: number }>('SELECT auth_epoch::int AS auth_epoch FROM users WHERE id = $1', [userId]);
      // Login binds epoch 0; the FIRST revocation bumps it to 1.
      expect(epoch.rows[0].auth_epoch).toBe(1);
    });

    it('logout revokes the row, clears the cookie, audits the event, and a replayed cookie gets 401', async () => {
      if (!superuserPool) return;
      const subject = `logout-${Date.now()}`;
      const { callback } = await fullLogin(app, subject);
      const sid = sessionSid(callback) as string;
      const userId = (
        await superuserPool.query<{ id: string }>(
          'SELECT id FROM users WHERE entra_issuer = $1 AND entra_subject = $2',
          [STUB_ISSUER, subject],
        )
      ).rows[0].id;
      const token = (JSON.parse(
        (
          await app.inject({ method: 'GET', url: '/api/v1/auth/csrf', headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` } })
        ).body,
      ) as { csrfToken: string }).csrfToken;
      expect(token.length).toBeGreaterThan(0);

      const logout = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { origin: ORIGIN, 'x-csrf-token': token, cookie: `${SESSION_COOKIE_NAME}=${sid}` },
      });
      expect(logout.statusCode).toBe(204);
      expect(setCookieValues(logout).some((value) => value.includes('Max-Age=0'))).toBe(true);
      const rows = await superuserPool.query<{ n: string }>('SELECT count(*)::text AS n FROM app_sessions WHERE sid = $1', [sid]);
      expect(rows.rows[0].n).toBe('0');
      const audit = await superuserPool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_events WHERE action = 'user.logout' AND actor_user_id = $1",
        [userId],
      );
      expect(audit.rows[0].n).toBe('1');

      // A stolen cookie after logout: the session is gone and stays gone
      // (even a freshly saved empty session is not authenticated).
      const replay = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { origin: ORIGIN, 'x-csrf-token': token, cookie: `${SESSION_COOKIE_NAME}=${sid}` },
      });
      expect(replay.statusCode).toBe(401);
      expectEnvelope(replay, 'UNAUTHORIZED');
    });

    it('no resurrection after a simulated restart: a rebuilt app keeps revoked sessions dead', async () => {
      if (!superuserPool) return;
      const subject = `restart-${Date.now()}`;
      const { callback } = await fullLogin(app, subject);
      const sid = sessionSid(callback) as string;
      // Simulate the restart: a NEW Fastify instance over the SAME Postgres
      // store (rows persist; memory does not matter).
      const restarted = buildApp({ auth: authOptions(appRolePool, stub) });
      // Revoke: logout through the restarted instance (row deleted there).
      const token = (JSON.parse(
        (
          await restarted.inject({ method: 'GET', url: '/api/v1/auth/csrf', headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` } })
        ).body,
      ) as { csrfToken: string }).csrfToken;
      const logout = await restarted.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { origin: ORIGIN, 'x-csrf-token': token, cookie: `${SESSION_COOKIE_NAME}=${sid}` },
      });
      expect(logout.statusCode).toBe(204);
      // The OLD instance cannot resurrect it either — the store is Postgres.
      const replay = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf', headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` } });
      expect(replay.statusCode).toBe(401);
    });
  });

  describe('CSRF synchronizer token + Origin allowlist on mutating routes', () => {
    async function loggedInToken(subject: string): Promise<{ sid: string; token: string }> {
      const { callback } = await fullLogin(app, subject);
      const sid = sessionSid(callback) as string;
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf', headers: { cookie: `${SESSION_COOKIE_NAME}=${sid}` } });
      expect(res.statusCode).toBe(200);
      const token = (JSON.parse(res.body) as { csrfToken: string }).csrfToken;
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
      return { sid, token };
    }

    it('a mutating call without an Origin header is a 403', async () => {
      if (!superuserPool) return;
      const { sid, token } = await loggedInToken(`csrf-${Date.now()}`);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { 'x-csrf-token': token, cookie: `${SESSION_COOKIE_NAME}=${sid}` },
      });
      expect(res.statusCode).toBe(403);
      expectEnvelope(res, 'FORBIDDEN');
    });

    it('a mutating call from a non-allowlisted Origin is a 403', async () => {
      if (!superuserPool) return;
      const { sid, token } = await loggedInToken(`csrf2-${Date.now()}`);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { origin: 'http://evil.example', 'x-csrf-token': token, cookie: `${SESSION_COOKIE_NAME}=${sid}` },
      });
      expect(res.statusCode).toBe(403);
      expectEnvelope(res, 'FORBIDDEN');
    });

    it('a mutating call without the CSRF header is a 403', async () => {
      if (!superuserPool) return;
      const { sid } = await loggedInToken(`csrf3-${Date.now()}`);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${sid}` },
      });
      expect(res.statusCode).toBe(403);
      expectEnvelope(res, 'FORBIDDEN');
    });

    it('a mutating call with a wrong CSRF token is a 403', async () => {
      if (!superuserPool) return;
      const { sid } = await loggedInToken(`csrf4-${Date.now()}`);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { origin: ORIGIN, 'x-csrf-token': 'forged-token', cookie: `${SESSION_COOKIE_NAME}=${sid}` },
      });
      expect(res.statusCode).toBe(403);
      expectEnvelope(res, 'FORBIDDEN');
    });

    it('a CSRF token minted for one sid is rejected for another (synchronizer binding)', async () => {
      if (!superuserPool) return;
      const first = await loggedInToken(`csrf5-${Date.now()}`);
      const second = await loggedInToken(`csrf5-${Date.now()}`);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { origin: ORIGIN, 'x-csrf-token': first.token, cookie: `${SESSION_COOKIE_NAME}=${second.sid}` },
      });
      expect(res.statusCode).toBe(403);
      expectEnvelope(res, 'FORBIDDEN');
    });
  });

  describe('tenant guard over HTTP', () => {
    function buildProbeApp(): FastifyInstance {
      const probe = buildApp({ auth: authOptions(appRolePool, stub) });
      probe.get(
        '/api/v1/test/tenant-probe',
        { preHandler: requireTenantContext({ pool: appRolePool }) },
        async (request) => ({
          ok: true,
          organizationId: request.tenantContext?.organizationId,
          role: request.tenantContext?.role,
        }),
      );
      return probe;
    }

    async function seedSession(sid: string, userId: string, activeOrgId: string | null): Promise<void> {
      const epoch = (await superuserPool.query<{ auth_epoch: number }>('SELECT auth_epoch::int AS auth_epoch FROM users WHERE id = $1', [userId])).rows[0].auth_epoch;
      const store = new PostgresSessionStore({ pool: appRolePool, idleTtlMs: 30 * 60_000, defaultTtlMs: 60_000 });
      await new Promise<void>((resolve, reject) => {
        store.set(
          sid,
          { userId, activeOrgId, membershipRole: 'owner', authEpoch: epoch, cookie: { expires: new Date(Date.now() + 600_000) } },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    }

    it('401 without a session, 403 without a selected org', async () => {
      if (!superuserPool || !fixture) return;
      const probe = buildProbeApp();
      const none = await probe.inject({ method: 'GET', url: '/api/v1/test/tenant-probe' });
      expect(none.statusCode).toBe(401);
      expectEnvelope(none, 'UNAUTHORIZED');

      const sid = `probe-noorg-${Date.now()}`;
      await seedSession(sid, fixture.userAId, null);
      const noOrg = await probe.inject({ method: 'GET', url: '/api/v1/test/tenant-probe', headers: { cookie: seededCookie(sid) } });
      expect(noOrg.statusCode).toBe(403);
      expectEnvelope(noOrg, 'FORBIDDEN');
    });

    it('a non-member org selection is 403 and writes a denial audit row — no data, no enumeration signal', async () => {
      if (!superuserPool || !fixture) return;
      const probe = buildProbeApp();
      const sid = `probe-deny-${Date.now()}`;
      // User A holds only an INVITED membership in Org B — never active.
      await seedSession(sid, fixture.userAId, fixture.orgBId);
      const res = await probe.inject({
        method: 'GET',
        url: '/api/v1/test/tenant-probe',
        headers: { cookie: seededCookie(sid) },
      });
      expect(res.statusCode).toBe(403);
      expectEnvelope(res, 'FORBIDDEN');
      expect(res.body).not.toContain(fixture.orgBId);
      const audit = await superuserPool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_events WHERE action = 'tenant.access_denied' AND organization_id = $1 AND actor_user_id = $2",
        [fixture.orgBId, fixture.userAId],
      );
      expect(audit.rows[0].n).toBe('1');
    });

    it('an active member resolves the tenant context (role refreshed from the membership row)', async () => {
      if (!superuserPool || !fixture) return;
      const probe = buildProbeApp();
      const sid = `probe-ok-${Date.now()}`;
      await seedSession(sid, fixture.userAId, fixture.orgAId);
      const res = await probe.inject({
        method: 'GET',
        url: '/api/v1/test/tenant-probe',
        headers: { cookie: seededCookie(sid) },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; organizationId: string; role: string };
      expect(body.ok).toBe(true);
      expect(body.organizationId).toBe(fixture.orgAId);
      expect(body.role).toBe('owner');
    });
  });

  describe('hardening details', () => {
    it('session cookies are HttpOnly + SameSite=Lax; Secure follows the cookieSecure option', async () => {
      if (!superuserPool) return;
      const { callback } = await fullLogin(app, `flags-${Date.now()}`);
      const cookie = setCookieValues(callback).find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)) as string;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).not.toContain('Secure');

      const secureApp = buildApp({ auth: authOptions(appRolePool, stub, { cookieSecure: true }) });
      const { callback: secureCallback } = await fullLogin(secureApp, `flags-secure-${Date.now()}`);
      expect(secureCallback.statusCode).toBe(302);
      const secureCookie = setCookieValues(secureCallback).find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)) as string;
      expect(secureCookie).toContain('Secure');
    });

    it('auth routes rate limit with the shared envelope', async () => {
      if (!superuserPool) return;
      const limited = buildApp({ auth: authOptions(appRolePool, stub, { rateLimitMax: 2, rateLimitTimeWindowMs: 60_000 }) });
      for (let i = 0; i < 2; i += 1) {
        const res = await limited.inject({ method: 'GET', url: '/api/v1/auth/login' });
        expect(res.statusCode).toBe(302);
      }
      const third = await limited.inject({ method: 'GET', url: '/api/v1/auth/login' });
      expect(third.statusCode).toBe(429);
      expectEnvelope(third, 'RATE_LIMITED');
    });

    it('the Entra adapter builds real offline flows and refuses nonce-less exchanges (Part B wired)', async () => {
      const entra = EntraIdp.fromMetadata({
        issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
        clientId: 'client',
        clientSecret: 'secret',
        serverMetadata: {
          issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
          authorization_endpoint: 'https://login.microsoftonline.com/tenant-id/v2.0/authorize',
          token_endpoint: 'https://login.microsoftonline.com/tenant-id/v2.0/token',
        },
      });
      const flow = await entra.createLoginFlow('https://staging.example/auth/callback');
      const authorization = new URL(flow.authorizationUrl);
      expect(authorization.origin).toBe('https://login.microsoftonline.com');
      expect(authorization.searchParams.get('response_type')).toBe('code');
      expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorization.searchParams.get('client_id')).toBe('client');
      expect(authorization.searchParams.get('redirect_uri')).toBe('https://staging.example/auth/callback');
      expect(flow.codeVerifier.length).toBeGreaterThan(0);
      // Strict in-band nonce validation: the wired adapter requires the flow
      // nonce (the API passes it; its absence means a broken caller).
      await expect(
        entra.exchangeCode({ code: 'x', codeVerifier: 'y', redirectUri: 'https://staging.example/auth/callback' }),
      ).rejects.toThrow(/nonce/i);
      expect(
        () => EntraIdp.fromMetadata({
          issuer: 'http://insecure.example',
          clientId: 'client',
          clientSecret: 'secret',
          serverMetadata: {
            issuer: 'http://insecure.example',
            authorization_endpoint: 'http://insecure.example/authorize',
            token_endpoint: 'http://insecure.example/token',
          },
        }),
      ).toThrow(/https/i);
    });
  });
});
