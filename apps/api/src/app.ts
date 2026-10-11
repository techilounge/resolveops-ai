import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { ApiErrorSchema, apiErrorStatus, type ApiErrorCode } from '@resolveops/shared';
import { AuthError, SESSION_COOKIE_NAME, authPlugin, type AuthOptions } from '@resolveops/auth';
import { healthRoute } from './routes/health';
import { registerResourceRoutes } from './register-resources';

export interface BuildAppOptions {
  // Injected clock (repo convention) — feeds the health timestamp so the
  // endpoint is deterministic under test.
  now?: () => Date;
  // When provided, wires the Phase 1 auth surface: rate limiting, the
  // Postgres-backed session plugin, Origin/CSRF guards, and the auth routes.
  // Absent = Phase 0 surface (health only) — demo and smoke paths unchanged.
  auth?: AuthOptions;
  // Dedicated SELECT-only pool for GET /api/v1/audit-events (Phase 1 spec
  // §4.3, delta D3). RLS still applies to the reader role, so the route keeps
  // running inside the caller's tenant context — this pool only narrows what
  // the connection can do. Routes register only when it is provided.
  auditReaderPool?: Pool;
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
  const app = Fastify({
    // Blueprint §11 mandates request IDs end to end: generated per request,
    // echoed in the x-request-id response header and the error envelope.
    genReqId: () => randomUUID(),
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  app.register(healthRoute, { now: options.now ?? (() => new Date()) });

  if (options.auth) {
    app.register(authPlugin, options.auth);
    app.register(registerResourceRoutes, {
      pool: options.auth.pool,
      auditReaderPool: options.auditReaderPool,
      auth: options.auth,
    });
  }

  // Every error response uses the shared taxonomy envelope — including
  // routes that do not exist, so the error shape is observable from day one.
  app.setNotFoundHandler((request, reply) => {
    reply.status(apiErrorStatus('NOT_FOUND')).send(
      ApiErrorSchema.parse({
        error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: request.id },
      }),
    );
  });

  app.setErrorHandler((error, request, reply) => {
    // Auth errors carry their own taxonomy code; a revoked session also
    // clears the cookie so a stolen sid cannot outlive its row.
    if (error instanceof AuthError) {
      if (error.clearSessionCookie) {
        reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      }
      reply
        .status(apiErrorStatus(error.code))
        .send(ApiErrorSchema.parse({
          error: { code: error.code, message: error.message, requestId: request.id },
        }));
      return;
    }
    // Zod parse failures are client errors (missing/malformed input).
    if (isZodError(error)) {
      reply
        .status(apiErrorStatus('BAD_REQUEST'))
        .send(ApiErrorSchema.parse({
          error: { code: 'BAD_REQUEST', message: 'Request validation failed.', requestId: request.id },
        }));
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
        .send(ApiErrorSchema.parse({
          error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and retry.', requestId: request.id },
        }));
      return;
    }
    // Validation-shaped failures (fastify schema validation) are client
    // errors; anything else is 5xx and must not leak internals.
    const isValidation = Array.isArray((error as { validation?: unknown[] }).validation);
    const code: ApiErrorCode = isValidation ? 'BAD_REQUEST' : 'INTERNAL';
    const message = isValidation ? 'Request validation failed.' : 'Internal server error.';
    reply
      .status(apiErrorStatus(code))
      .send(ApiErrorSchema.parse({
        error: { code, message, requestId: request.id },
      }));
  });

  return app;
}
