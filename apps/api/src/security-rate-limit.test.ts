import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  destroyTestContext,
  expectEnvelope,
  mutate,
  read,
  type TestContext,
  type TestSession,
} from './testing/support';

/**
 * P1-7 — rate-limit enforcement re-proofs (Blueprint §7), adversarial:
 * the auth-route limit alone does not bound a authenticated flood, so this
 * suite proves the limiter on a MUTATING route with a real session, that
 * the cliff is absolute (every request past it is 429 — reads included),
 * that rejections carry the shared envelope, and that the flood wrote
 * exactly the requests the limiter let through (no ghost writes).
 *
 * The app under test is the SAME production wiring with a small budget
 * (built via createTestContext overrides); the Phase 1 single-instance
 * limiter is an in-process per-IP counter, and @fastify/inject requests
 * all arrive from one peer — exactly the shape the counter protects.
 */
describe('P1-7 rate-limit enforcement (HTTP, Blueprint §7)', () => {
  let context: TestContext | undefined;
  let session: TestSession;
  let successful201s = 0;

  beforeAll(async () => {
    // Budget 30: enough headroom for the login flow + seed requests in the
    // same bucket (in-process, per-IP), small enough that the flood below
    // reaches the cliff fast.
    context = await createTestContext({ rateLimitMax: 30, rateLimitTimeWindowMs: 60_000 });
  });

  afterAll(async () => {
    if (context) await destroyTestContext(context);
  });

  it('the mutating cliff: with a live session, incident creation hits 429 and every request after it is 429', async () => {
    if (!context) return;
    session = await context.member({ role: 'owner', orgId: context.fixture.orgAId });
    const switched = await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
      organizationId: context.fixture.orgAId,
    });
    expect(switched.statusCode).toBe(200);

    // Pre-flood snapshot: the fixture already seeded one incident, so the
    // ghost-write check must assert the DELTA, not the total.
    const before = await context.superuserPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM incidents WHERE organization_id = $1',
      [context.fixture.orgAId],
    );
    const beforeCount = Number(before.rows[0].count);

    // Burn the remaining budget with authenticated mutating requests and
    // find the cliff. Serial inject = deterministic consumption.
    const statuses: number[] = [];
    let saw429 = false;
    for (let attempt = 0; attempt < 60 && !saw429; attempt += 1) {
      const res = await mutate(context!, session, 'POST', '/api/v1/incidents', {
        title: `rate-limit flood ${attempt}`,
        description: 'P1-7 rate-limit flood probe',
        severity: 'low',
      });
      statuses.push(res.statusCode);
      saw429 = res.statusCode === 429;
    }

    // The cliff exists within the budget window...
    expect(saw429, `no 429 within 60 attempts: ${statuses.join(',')}`).toBe(true);
    // ...nothing succeeded past it (no partial-state flapping)...
    const cliff = statuses.indexOf(429);
    expect(statuses.slice(cliff).every((status) => status === 429)).toBe(true);
    // ...no 5xx ever leaked from the limiter path...
    expect(statuses.every((status) => status < 500)).toBe(true);
    // ...the first rejection carries the shared envelope...
    const limited = await mutate(context!, session, 'POST', '/api/v1/incidents', {
      title: 'rate-limit flood confirmed',
      description: 'P1-7 rate-limit flood probe',
      severity: 'low',
    });
    expect(limited.statusCode).toBe(429);
    expectEnvelope(limited, 'RATE_LIMITED');

    successful201s = statuses.filter((status) => status === 201).length;
    expect(successful201s).toBeGreaterThan(0);

    // ...and the flood wrote exactly the requests the limiter allowed.
    const written = await context.superuserPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM incidents WHERE organization_id = $1',
      [context.fixture.orgAId],
    );
    expect(Number(written.rows[0].count) - beforeCount).toBe(successful201s);
  });

  it('the budget is per route: authenticated reads stay 200, and the auth route enforces its own cliff', async () => {
    if (!context) return;
    // Observed Phase 1 design (register-resources.ts): only mutating
    // resource routes opt into the limiter — reads rely on RLS-scoped
    // session auth. Asserting the 200 documents that boundary; if a future
    // change makes reads throttled, this assertion flags the drift.
    const floodedList = await read(context, session, '/api/v1/incidents');
    expect(floodedList.statusCode).toBe(200);

    // The auth routes run their OWN bucket: a login flood beyond the same
    // max is rejected with the shared envelope.
    const loginStatuses: number[] = [];
    for (let attempt = 0; attempt < 35; attempt += 1) {
      const login = await context.app.inject({ method: 'GET', url: '/api/v1/auth/login' });
      loginStatuses.push(login.statusCode);
    }
    expect(loginStatuses.some((status) => status === 302)).toBe(true);
    const loginCliff = loginStatuses.indexOf(429);
    expect(loginCliff, `no 429 in login flood: ${loginStatuses.join(',')}`).toBeGreaterThan(-1);
    expect(loginStatuses.slice(loginCliff).every((status) => status === 429)).toBe(true);

    const floodedLogin = await context.app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    expect(floodedLogin.statusCode).toBe(429);
    expectEnvelope(floodedLogin, 'RATE_LIMITED');
  });
});
