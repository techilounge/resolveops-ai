import type { FastifyPluginCallback } from 'fastify';
import { HealthResponseSchema, type HealthResponse } from '@resolveops/shared';

export const SERVICE_NAME = 'resolveops-api';
// Kept in step with package.json version; reading it from disk would be I/O
// the Phase 0 boundary does not need.
export const SERVICE_VERSION = '0.1.0';

export interface HealthRouteOptions {
  now: () => Date;
}

// GET /healthz — liveness per the shared contract (PROD-004). Returns service
// status only: no customer data, no tenant context, no auth surface.
export const healthRoute: FastifyPluginCallback<HealthRouteOptions> = (app, options, done) => {
  app.get('/healthz', () => {
    const payload: HealthResponse = {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      timestamp: options.now().toISOString(),
    };
    // Parse at the edge: the response is verified against the shared
    // contract, not merely assumed to satisfy it.
    return HealthResponseSchema.parse(payload);
  });
  done();
};
