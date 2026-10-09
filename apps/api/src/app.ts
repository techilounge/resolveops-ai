import Fastify, { type FastifyInstance } from 'fastify';
import { ApiErrorSchema, apiErrorStatus, type ApiErrorCode } from '@resolveops/shared';
import { healthRoute } from './routes/health';

export interface BuildAppOptions {
  // Injected clock (repo convention) — feeds the health timestamp so the
  // endpoint is deterministic under test.
  now?: () => Date;
}

// App factory, separate from the start entry (server.ts): tests exercise the
// app in-process via fastify.inject; nothing here opens a socket.
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify();

  app.register(healthRoute, { now: options.now ?? (() => new Date()) });

  // Every error response uses the shared taxonomy envelope — including
  // routes that do not exist, so the error shape is observable from day one.
  app.setNotFoundHandler((_request, reply) => {
    reply.status(apiErrorStatus('NOT_FOUND')).send(
      ApiErrorSchema.parse({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }),
    );
  });

  app.setErrorHandler((error, _request, reply) => {
    // Validation-shaped failures are client errors; anything else is 5xx and
    // must not leak internals into the response body.
    const isValidation = Array.isArray((error as { validation?: unknown[] }).validation);
    const code: ApiErrorCode = isValidation ? 'BAD_REQUEST' : 'INTERNAL';
    const message = isValidation ? 'Request validation failed.' : 'Internal server error.';
    reply
      .status(apiErrorStatus(code))
      .send(ApiErrorSchema.parse({ error: { code, message } }));
  });

  return app;
}
