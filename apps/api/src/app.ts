import Fastify, { type FastifyInstance } from 'fastify';
import { ApiErrorSchema, apiErrorStatus, type ApiErrorCode } from '@resolveops/shared';
import { AuthError, SESSION_COOKIE_NAME, authPlugin, type AuthOptions } from '@resolveops/auth';
import { healthRoute } from './routes/health';

export interface BuildAppOptions {
  // Injected clock (repo convention) — feeds the health timestamp so the
  // endpoint is deterministic under test.
  now?: () => Date;
  // When provided, wires the Phase 1 auth surface: rate limiting, the
  // Postgres-backed session plugin, Origin/CSRF guards, and the auth routes.
  // Absent = Phase 0 surface (health only) — demo and smoke paths unchanged.
  auth?: AuthOptions;
}

// Zod parse failures surface as `name: 'ZodError'` + an `issues` array;
// structural detection keeps this file free of a direct zod dependency.
function isZodError(error: unknown): boolean {
  return (
    error instanceof Error
    && error.name === 'ZodError'
    && Array.isArray((error as { issues?: unknown[] }).issues)
  );
}

// App factory, separate from the start entry (server.ts): tests exercise the
// app in-process via fastify.inject; nothing here opens a socket.
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify();

  app.register(healthRoute, { now: options.now ?? (() => new Date()) });

  if (options.auth) {
    app.register(authPlugin, options.auth);
  }

  // Every error response uses the shared taxonomy envelope — including
  // routes that do not exist, so the error shape is observable from day one.
  app.setNotFoundHandler((_request, reply) => {
    reply.status(apiErrorStatus('NOT_FOUND')).send(
      ApiErrorSchema.parse({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }),
    );
  });

  app.setErrorHandler((error, _request, reply) => {
    // Auth errors carry their own taxonomy code; a revoked session also
    // clears the cookie so a stolen sid cannot outlive its row.
    if (error instanceof AuthError) {
      if (error.clearSessionCookie) {
        reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      }
      reply
        .status(apiErrorStatus(error.code))
        .send(ApiErrorSchema.parse({ error: { code: error.code, message: error.message } }));
      return;
    }
    // Zod parse failures are client errors (missing/malformed input).
    if (isZodError(error)) {
      reply
        .status(apiErrorStatus('BAD_REQUEST'))
        .send(ApiErrorSchema.parse({ error: { code: 'BAD_REQUEST', message: 'Request validation failed.' } }));
      return;
    }
    // Rate-limit rejections carry a 429 status; normalize them into the
    // shared envelope (in-process counter at Phase 1's single-instance scale).
    // @fastify/rate-limit v10 THROWS the errorResponseBuilder payload — an
    // already-envelope-shaped object with no statusCode — so recognize it by
    // shape and reply with the 429 the limiter intended.
    const asEnvelope = ApiErrorSchema.safeParse(error);
    if (asEnvelope.success && asEnvelope.data.error.code === 'RATE_LIMITED') {
      reply
        .status(apiErrorStatus('RATE_LIMITED'))
        .send(asEnvelope.data);
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      reply
        .status(apiErrorStatus('RATE_LIMITED'))
        .send(ApiErrorSchema.parse({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and retry.' } }));
      return;
    }
    // Validation-shaped failures (fastify schema validation) are client
    // errors; anything else is 5xx and must not leak internals.
    const isValidation = Array.isArray((error as { validation?: unknown[] }).validation);
    const code: ApiErrorCode = isValidation ? 'BAD_REQUEST' : 'INTERNAL';
    const message = isValidation ? 'Request validation failed.' : 'Internal server error.';
    reply
      .status(apiErrorStatus(code))
      .send(ApiErrorSchema.parse({ error: { code, message } }));
  });

  return app;
}
