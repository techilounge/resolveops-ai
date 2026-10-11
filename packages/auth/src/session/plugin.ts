import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import type { FastifyPluginCallback } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { PostgresSessionStore } from './store';
import { CSRF_HEADER_NAME, isCsrfTokenValid } from '../csrf';
import { AuthError } from '../errors';
import {
  SESSION_COOKIE_NAME,
  resolveAuthOptions,
  sessionCookieOptions,
  type AuthOptions,
  type ResolvedAuthOptions,
} from '../config';
import { registerAuthRoutes } from '../routes/auth-routes';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Origin + synchronizer-token guard for mutating calls (Blueprint §4.2):
 * Origin must exactly match the deployment allowlist, and the presented
 * token must be the session's derived synchronizer token. Runs after the
 * session plugin's onRequest, so a restored session's sid is available.
 */
function csrfOriginGuard(resolved: ResolvedAuthOptions) {
  return async function guard(request: {
    method: string;
    headers: Record<string, unknown>;
    session?: { sessionId: string; userId?: string | null } | null;
  }): Promise<void> {
    if (!MUTATING_METHODS.has(request.method)) {
      return;
    }
    // An unauthenticated caller cannot be CSRF-forged (the mutation target
    // requires authentication and will 401 below) — the synchronizer token is
    // meaningless without a session, so let the route's own auth check run.
    if (request.session?.userId == null) {
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !resolved.allowedOrigins.includes(origin)) {
      throw new AuthError('FORBIDDEN', 'Origin is not allowed for mutating requests.');
    }
    const presented = request.headers[CSRF_HEADER_NAME];
    const sessionId = request.session?.sessionId;
    if (
      sessionId === undefined
      || typeof presented !== 'string'
      || !isCsrfTokenValid(sessionId, resolved.csrfSecret, presented)
    ) {
      throw new AuthError('FORBIDDEN', 'CSRF token missing or invalid.');
    }
  };
}

/**
 * One-stop auth wiring for the API app factory: rate limiting, session
 * plugin with the Postgres store, the Origin/CSRF guard, and the auth
 * routes. Register with `BuildAppOptions.auth` from apps/api.
 */
const authPluginCallback: FastifyPluginCallback<AuthOptions> = (app, options, done) => {
  const resolved = resolveAuthOptions(options);

  // Rate limiting first so its onRequest hook precedes session work; in-process
  // counting is acceptable at Phase 1's single-instance scale — multi-instance
  // deployments need a shared store (known limitation, Part B).
  app.register(rateLimit, {
    global: false,
    max: resolved.rateLimitMax,
    timeWindow: resolved.rateLimitTimeWindowMs,
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: 'RATE_LIMITED',
        message: `Too many requests. Retry after ${context.after}.`,
      },
    }),
  });
  app.register(fastifyCookie);
  app.register(fastifySession, {
    secret: resolved.cookieSecret,
    cookieName: SESSION_COOKIE_NAME,
    saveUninitialized: false,
    rolling: true,
    cookie: sessionCookieOptions(resolved.cookieSecure, resolved.sessionTtlMs),
    store: new PostgresSessionStore({
      pool: resolved.pool,
      idleTtlMs: resolved.idleTtlMs,
      defaultTtlMs: resolved.sessionTtlMs,
    }),
  });
  app.addHook('onRequest', csrfOriginGuard(resolved));
  // Routes register in a sibling plugin so they load AFTER @fastify/rate-limit:
  // the limiter attaches via an onRoute hook, which only sees routes registered
  // after it has loaded (routes in this plugin body would never be limited).
  app.register(async (scope) => {
    registerAuthRoutes(scope, { resolved });
  });
  done();
};

export const authPlugin = fastifyPlugin(authPluginCallback, {
  name: '@resolveops/auth',
  fastify: '5.x',
});
