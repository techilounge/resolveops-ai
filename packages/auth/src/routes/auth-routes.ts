import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { AuthError } from '../errors';
import { AuthCallbackQuerySchema, CsrfTokenResponseSchema } from '../contracts';
import { csrfTokenFor } from '../csrf';
import { writeAuditEvent } from '../audit';
import { SESSION_COOKIE_NAME, type ResolvedAuthOptions } from '../config';
import type { IdTokenClaims } from '../oidc/jwt';

export interface AuthRouteDeps {
  resolved: ResolvedAuthOptions;
}

interface LoginFlowRow {
  nonce: string;
  code_verifier: string;
  expires_at: Date;
}

function resolveRedirectUri(resolved: ResolvedAuthOptions): string {
  // Always absolute — OIDC redirect_uris are absolute and the stub's local
  // authorization endpoint needs a parseable URL to build the callback.
  return `${resolved.publicBaseUrl.replace(/\/$/, '')}/api/v1/auth/callback`;
}

/**
 * Finds the users row for the validated identity or provisions it on first
 * login. Runs as `resolveops_app` (grants via migration 006); users is a
 * global identity table — no tenant context applies.
 */
async function findOrCreateUser(pool: Pool, claims: IdTokenClaims): Promise<{ id: string; authEpoch: number }> {
  const existing = await pool.query<{ id: string; auth_epoch: string; email: string; display_name: string | null }>(
    'SELECT id, auth_epoch, email, display_name FROM users WHERE entra_issuer = $1 AND entra_subject = $2',
    [claims.issuer, claims.subject],
  );
  const user = existing.rows[0];
  if (user) {
    const email = claims.email ?? user.email;
    const displayName = claims.displayName ?? user.display_name;
    if (email !== user.email || displayName !== user.display_name) {
      await pool.query(
        'UPDATE users SET email = $2, display_name = $3, updated_at = now() WHERE id = $1',
        [user.id, email, displayName],
      );
    }
    return { id: user.id, authEpoch: Number(user.auth_epoch) };
  }
  const email = claims.email ?? `${claims.subject}@${new URL(claims.issuer).host}`;
  const inserted = await pool.query<{ id: string; auth_epoch: string }>(
    `INSERT INTO users (id, entra_issuer, entra_subject, email, display_name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, auth_epoch`,
    [randomUUID(), claims.issuer, claims.subject, email, claims.displayName ?? claims.subject],
  );
  return { id: inserted.rows[0].id, authEpoch: Number(inserted.rows[0].auth_epoch) };
}

/**
 * Phase 1 auth surface (Blueprint §4.2/§5): login redirect, OIDC callback
 * with state/nonce/PKCE validation + session rotation, logout with row
 * revocation + cookie clearing, and the CSRF token endpoint. All routes are
 * rate limited via route config; the mutating route (logout) is covered by
 * the plugin-level Origin + synchronizer-token guard.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { resolved } = deps;
  const rateLimitConfig = { rateLimit: { max: resolved.rateLimitMax, timeWindow: resolved.rateLimitTimeWindowMs } };

  app.get('/api/v1/auth/login', { config: rateLimitConfig }, async (_request, reply) => {
    // Opportunistic hygiene: expired flow rows are dead on arrival.
    await resolved.pool.query('DELETE FROM login_flow_state WHERE expires_at < now()');
    const redirectUri = resolveRedirectUri(resolved);
    const flow = await resolved.adapter.createLoginFlow(redirectUri);
    await resolved.pool.query(
      `INSERT INTO login_flow_state (state, nonce, code_verifier, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [flow.state, flow.nonce, flow.codeVerifier, flow.expiresAt],
    );
    return reply.redirect(flow.authorizationUrl);
  });

  app.get('/api/v1/auth/callback', { config: rateLimitConfig }, async (request, reply) => {
    const query = AuthCallbackQuerySchema.parse(request.query);
    if (query.error !== undefined) {
      throw new AuthError('BAD_REQUEST', `Identity provider reported: ${query.error}`);
    }
    const state = query.state as string;
    const code = query.code as string;

    const flowResult = await resolved.pool.query<LoginFlowRow>(
      'SELECT nonce, code_verifier, expires_at FROM login_flow_state WHERE state = $1',
      [state],
    );
    const flow = flowResult.rows[0];
    if (!flow) {
      // Unknown, expired-and-swept, or already-consumed state — one message,
      // no signal for state enumeration or replay.
      throw new AuthError('BAD_REQUEST', 'Unknown or expired login state. Restart the login.');
    }
    // Single-use before the exchange: a concurrent duplicate callback loses.
    await resolved.pool.query('DELETE FROM login_flow_state WHERE state = $1', [state]);
    if (flow.expires_at.getTime() <= Date.now()) {
      throw new AuthError('BAD_REQUEST', 'Unknown or expired login state. Restart the login.');
    }
    const claims = await resolved.adapter.exchangeCode({
      code,
      codeVerifier: flow.code_verifier,
      // The same server-resolved redirect_uri the login route bound into the
      // authorization request (login_flow_state does not store it).
      redirectUri: resolveRedirectUri(resolved),
      // Strict in-band nonce validation (EntraIdp) — the API re-checks the
      // returned claim below for every adapter.
      expectedNonce: flow.nonce,
    }).catch((error: unknown) => {
      // Adapter failures (bad/expired code, verifier or redirect mismatch,
      // token error responses) are protocol denials — client errors, not
      // outages. Wrap so the envelope stays 400 and the cause is preserved.
      throw new AuthError('BAD_REQUEST', 'Login could not be completed. Restart the login.', {
        cause: error,
      });
    });
    if (claims.nonce === null || claims.nonce !== flow.nonce) {
      throw new AuthError('BAD_REQUEST', 'ID token nonce mismatch.');
    }
    const user = await findOrCreateUser(resolved.pool, claims);

    // Session fixation: rotate the sid on login (destroys the pre-auth row).
    await request.session.regenerate();
    request.session.userId = user.id;
    request.session.activeOrgId = null;
    request.session.membershipRole = null;
    request.session.authEpoch = user.authEpoch;
    // Persist the rotated session deterministically — never rely on the
    // plugin's response-end autosave (it is conditional and has failed under
    // inject in the session spike).
    await new Promise<void>((resolve, reject) => {
      request.session.save((error) => (error ? reject(error) : resolve()));
    });

    await writeAuditEvent(resolved.pool, {
      organizationId: null,
      actorUserId: user.id,
      action: 'user.login',
      targetType: 'user',
      targetId: user.id,
      metadata: { issuer: claims.issuer },
    });
    // activeOrgId is null at login by design: memberships cannot be
    // enumerated pre-context under RLS; onboarding (P1-4/P1-5) picks the org.
    return reply.redirect('/onboarding');
  });

  app.post('/api/v1/auth/logout', { config: rateLimitConfig }, async (request, reply) => {
    const session = request.session;
    if (!session?.userId) {
      throw new AuthError('UNAUTHORIZED', 'Authentication required.');
    }
    await session.destroy();
    await writeAuditEvent(resolved.pool, {
      organizationId: null,
      actorUserId: session.userId,
      action: 'user.logout',
      targetType: 'user',
      targetId: session.userId,
    });
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/v1/auth/csrf', { config: rateLimitConfig }, async (request, reply) => {
    // Tokens exist to authorize mutations by the logged-in user; anonymous
    // callers get 401 (and no session row is persisted for them —
    // saveUninitialized stays false for every other route).
    if (!request.session?.userId) {
      throw new AuthError('UNAUTHORIZED', 'Authentication required.');
    }
    // Re-persist so the sid exists server-side before the client relies on
    // the derived token.
    await request.session.save();
    const body = CsrfTokenResponseSchema.parse({
      csrfToken: csrfTokenFor(request.session.sessionId, resolved.csrfSecret),
    });
    return reply.send(body);
  });
}
