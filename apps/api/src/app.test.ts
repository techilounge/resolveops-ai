import { describe, expect, it } from 'vitest';
import { ApiErrorSchema, HealthResponseSchema } from '@resolveops/shared';
import { buildApp } from './app';

describe('GET /healthz', () => {
  it('returns 200 with a contract-shaped payload', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    const body = HealthResponseSchema.parse(response.json());
    expect(body.status).toBe('ok');
    expect(body.service).toBe('resolveops-api');
    await app.close();
  });

  it('returns service status only — the exact key set proves no customer data', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(Object.keys(response.json()).sort()).toEqual(['service', 'status', 'timestamp', 'version']);
    await app.close();
  });

  it('honors the injected clock', async () => {
    const app = buildApp({ now: () => new Date('2026-10-09T00:00:00.000Z') });
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(HealthResponseSchema.parse(response.json()).timestamp).toBe('2026-10-09T00:00:00.000Z');
    await app.close();
  });
});

describe('error envelope', () => {
  it('maps unknown routes onto the shared 404 taxonomy', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/definitely-not-a-route' });
    expect(response.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    await app.close();
  });
});
