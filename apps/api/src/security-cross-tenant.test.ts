import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '@resolveops/auth';
import {
  auditCount,
  createTestContext,
  destroyTestContext,
  expectEnvelope,
  mutate,
  read,
  type TestContext,
  type TestSession,
} from './testing/support';

/**
 * P1-7 — the Phase 1 Blueprint §7 cross-tenant adversarial matrix over HTTP,
 * run against a fresh-from-empty database (the CI postgres:17 job).
 *
 * For every tenant-scoped route × {Org B incident id, Org B org id, Org B
 * user id, guessed UUID} × {direct read, list, search, PATCH, comment}:
 * 404/403 only, zero foreign data echoed (ids, titles, counts), no count
 * oracle (a term matching only Org B content returns an empty list, not a
 * number), and an audit row for the denial where the spec requires one.
 * Anonymous calls are denied on every route; tenant-ID substitution in
 * bodies is rejected.
 *
 * This suite is the attacker, not the fixer: route implementations are
 * treated as fixed. Findings are reported in the PR body, never patched
 * here.
 */

/** Every string that would betray Org B data if a response ever echoed it. */
function foreignTokens(context: TestContext, extra: (string | RegExp)[] = []): (string | RegExp)[] {
  const f = context.fixture;
  return [
    f.orgBId,
    f.incidentBId,
    f.userBId,
    f.orgBToken,
    'Org B',
    'User B',
    // userB's exact email, boundary-guarded: fixture emails are generated as
    // `mem-<hex>@example.com`, so a bare 'b@example.com' substring would
    // false-positive whenever a hex suffix ends in 'b' (seen in CI).
    /(?<![0-9a-f-])b@example\.com/,
    ...extra,
  ];
}

function assertNoForeignData(body: string, tokens: (string | RegExp)[]): void {
  for (const token of tokens) {
    const leaked = typeof token === 'string' ? body.includes(token) : token.test(body);
    expect(leaked, `response leaked foreign token ${String(token)}: ${body}`).toBe(false);
  }
}

interface CellResponse {
  statusCode: number;
  body: string;
}

/**
 * A cross-tenant denial cell: the status must be one of the allowed denial
 * statuses, the envelope must carry the expected code, and no foreign data
 * may appear anywhere in the response body.
 */
function expectTenantDenial(
  res: CellResponse,
  statuses: number[],
  code: 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST',
  tokens: (string | RegExp)[],
): CellResponse {
  expect(
    statuses.includes(res.statusCode),
    `expected a ${statuses.join('/')} denial, got ${res.statusCode}: ${res.body}`,
  ).toBe(true);
  if (res.statusCode >= 400) {
    expectEnvelope(res, code);
  }
  assertNoForeignData(res.body, tokens);
  return res;
}

describe('P1-7 cross-tenant adversarial matrix (HTTP, Blueprint §7)', () => {
  let context: TestContext | undefined;
  let ownerA: TestSession;
  let adminA: TestSession;
  let viewerA: TestSession;

  beforeAll(async () => {
    const setup = await createTestContext();
    if (!setup) return;
    context = setup;

    // Three Org A principals at different privilege levels, each with the
    // active-org switch performed, so every denial below is a genuine
    // authorization denial — never a missing-context artifact.
    ownerA = await setup.member({ role: 'owner', orgId: setup.fixture.orgAId });
    adminA = await setup.member({ role: 'admin', orgId: setup.fixture.orgAId });
    viewerA = await setup.member({ role: 'viewer', orgId: setup.fixture.orgAId });
    for (const session of [ownerA, adminA, viewerA]) {
      const switched = await mutate(setup, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: setup.fixture.orgAId,
      });
      expect(switched.statusCode).toBe(200);
    }
  });

  afterAll(async () => {
    if (context) await destroyTestContext(context);
  });

  it('positive control: the Org A session can read its own incident (probes below are real denials)', async () => {
    if (!context) return;
    const res = await read(context, ownerA, `/api/v1/incidents/${context.fixture.incidentAId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(context.fixture.incidentAId);
  });

  describe('foreign incident id × {direct read, PATCH, comment create, comment list}', () => {
    it.each([
      ['GET /api/v1/incidents/:id', 'GET'],
      ['PATCH /api/v1/incidents/:id', 'PATCH'],
      ['POST /api/v1/incidents/:id/comments', 'POST_COMMENT'],
      ['GET /api/v1/incidents/:id/comments', 'GET_COMMENTS'],
    ] as const)('%s with the real Org B incident id denies with zero foreign data', async (_label, action) => {
      if (!context) return;
      const id = context.fixture.incidentBId;
      const res =
        action === 'GET'
          ? await read(context, ownerA, `/api/v1/incidents/${id}`)
          : action === 'PATCH'
            ? await mutate(context, ownerA, 'PATCH', `/api/v1/incidents/${id}`, {
                title: 'owned by attacker',
                expectedVersion: 1,
              })
            : action === 'POST_COMMENT'
              ? await mutate(context, ownerA, 'POST', `/api/v1/incidents/${id}/comments`, {
                  body: 'cross-tenant comment attempt',
                })
              : await read(context, ownerA, `/api/v1/incidents/${id}/comments`);
      expectTenantDenial(res, [404], 'NOT_FOUND', foreignTokens(context));
    });

    it.each([
      ['GET /api/v1/incidents/:id', 'GET'],
      ['PATCH /api/v1/incidents/:id', 'PATCH'],
      ['POST /api/v1/incidents/:id/comments', 'POST_COMMENT'],
      ['GET /api/v1/incidents/:id/comments', 'GET_COMMENTS'],
    ] as const)('%s with a guessed (well-formed, nonexistent) UUID denies identically — no enumeration signal', async (_label, action) => {
      if (!context) return;
      const guessed = randomUUID();
      const res =
        action === 'GET'
          ? await read(context, ownerA, `/api/v1/incidents/${guessed}`)
          : action === 'PATCH'
            ? await mutate(context, ownerA, 'PATCH', `/api/v1/incidents/${guessed}`, {
                title: 'owned by attacker',
                expectedVersion: 1,
              })
            : action === 'POST_COMMENT'
              ? await mutate(context, ownerA, 'POST', `/api/v1/incidents/${guessed}/comments`, {
                  body: 'cross-tenant comment attempt',
                })
              : await read(context, ownerA, `/api/v1/incidents/${guessed}/comments`);
      expectTenantDenial(res, [404], 'NOT_FOUND', foreignTokens(context, [guessed]));
      // The foreign id and the guessed id must be indistinguishable: the
      // same status, envelope code, and message — no existence oracle.
      const id = context.fixture.incidentBId;
      const twin =
        action === 'GET'
          ? await read(context, ownerA, `/api/v1/incidents/${id}`)
          : action === 'PATCH'
            ? await mutate(context, ownerA, 'PATCH', `/api/v1/incidents/${id}`, {
                title: 'owned by attacker',
                expectedVersion: 1,
              })
            : action === 'POST_COMMENT'
              ? await mutate(context, ownerA, 'POST', `/api/v1/incidents/${id}/comments`, {
                  body: 'cross-tenant comment attempt',
                })
              : await read(context, ownerA, `/api/v1/incidents/${id}/comments`);
      expect(twin.statusCode).toBe(res.statusCode);
      expect(JSON.parse(twin.body).error.code).toBe(JSON.parse(res.body).error.code);
      expect(JSON.parse(twin.body).error.message).toBe(JSON.parse(res.body).error.message);
    });
  });

  describe('foreign org id × {switch to org} and guessed org id', () => {
    it('switching to the real Org B org id is a 403, audited into the TARGET org, and changes no session state', async () => {
      if (!context) return;
      const f = context.fixture;
      const before = await auditCount(context, f.orgBId, 'tenant.access_denied', f.orgBId);
      const res = await mutate(context, ownerA, 'POST', '/api/v1/me/active-organization', {
        organizationId: f.orgBId,
      });
      expectTenantDenial(res, [403], 'FORBIDDEN', foreignTokens(context));
      expect(await auditCount(context, f.orgBId, 'tenant.access_denied', f.orgBId)).toBe(before + 1);

      // The denied switch changed nothing: the active org is still Org A.
      const current = await read(context, ownerA, '/api/v1/organizations/current');
      expect(current.statusCode).toBe(200);
      expect(current.body).toContain(f.orgAId);
      assertNoForeignData(current.body, foreignTokens(context));
    });

    it('switching to a guessed org uuid never succeeds, echoes no data, and leaves the session intact', async () => {
      if (!context) return;
      const f = context.fixture;
      const guessed = randomUUID();
      const res = await mutate(context, ownerA, 'POST', '/api/v1/me/active-organization', {
        organizationId: guessed,
      });
      // F-1 fix: a well-formed but nonexistent org id is a clean 403 denial
      // envelope. The denial-audit row is user-scoped (organization_id NULL,
      // actor preserved, attempted id in metadata) because an org-scoped row
      // would violate audit_events.organization_id's FK. The security
      // properties stay as pinned: never a success, never foreign data,
      // shared envelope, session untouched.
      expectTenantDenial(res, [403], 'FORBIDDEN', foreignTokens(context, [guessed]));

      const current = await read(context, ownerA, '/api/v1/organizations/current');
      expect(current.statusCode).toBe(200);
      expect(current.body).toContain(f.orgAId);
    });
  });

  describe('foreign user id × {assignment, roster, own-profile}', () => {
    it('PATCH of an OWN incident with the Org B user as assignee is a 400 and mutates nothing', async () => {
      if (!context) return;
      const f = context.fixture;
      const res = await mutate(context, ownerA, 'PATCH', `/api/v1/incidents/${f.incidentAId}`, {
        assigneeUserId: f.userBId,
        expectedVersion: 1,
      });
      expectTenantDenial(res, [400], 'BAD_REQUEST', foreignTokens(context));

      // The Org A incident is unchanged: no assignment slipped through.
      const after = await read(context, ownerA, `/api/v1/incidents/${f.incidentAId}`);
      expect(after.statusCode).toBe(200);
      expect(JSON.parse(after.body).assigneeUserId).toBeNull();
      expect(JSON.parse(after.body).version).toBe(1);
    });

    it('PATCH of an OWN incident with a guessed user uuid behaves exactly as with a foreign user', async () => {
      if (!context) return;
      const guessed = randomUUID();
      const res = await mutate(context, ownerA, 'PATCH', `/api/v1/incidents/${context.fixture.incidentAId}`, {
        assigneeUserId: guessed,
        expectedVersion: 1,
      });
      expectTenantDenial(res, [400], 'BAD_REQUEST', foreignTokens(context, [guessed]));
    });

    it('the roster list never echoes a foreign user (fresh member sees only Org A rows)', async () => {
      if (!context) return;
      const res = await read(context, adminA, '/api/v1/organizations/current/members');
      expect(res.statusCode).toBe(200);
      assertNoForeignData(res.body, foreignTokens(context));
      const parsed = JSON.parse(res.body) as { data: unknown[]; page: { total: number } };
      // Exactly this suite's org roster: the seeded userA owner plus the three
      // sessions created in beforeAll — no Org B rows.
      expect(parsed.page.total).toBe(4);
      expect(parsed.data).toHaveLength(4);
    });

    it('GET /me shows only the caller\'s own memberships — no Org B rows for a member with none', async () => {
      if (!context) return;
      const res = await read(context, ownerA, '/api/v1/me');
      expect(res.statusCode).toBe(200);
      assertNoForeignData(res.body, foreignTokens(context));
      const parsed = JSON.parse(res.body) as { memberships: { organizationId: string }[] };
      expect(parsed.memberships.map((m) => m.organizationId)).toEqual([context!.fixture.orgAId]);
    });
  });

  describe('search: no count oracle, no inference', () => {
    it('a term matching only Org B content returns an empty list and total 0', async () => {
      if (!context) return;
      const res = await read(context, ownerA, `/api/v1/incidents?q=${encodeURIComponent(context.fixture.orgBToken)}`);
      expect(res.statusCode).toBe(200);
      assertNoForeignData(res.body, foreignTokens(context));
      const parsed = JSON.parse(res.body) as { data: unknown[]; page: { total: number } };
      expect(parsed.data).toEqual([]);
      expect(parsed.page.total).toBe(0);
    });

    it('metacharacter-wrapped probes stay literal and leak nothing', async () => {
      if (!context) return;
      const res = await read(context, ownerA, `/api/v1/incidents?q=${encodeURIComponent(`%${context.fixture.orgBToken}%_`)}`);
      expect(res.statusCode).toBe(200);
      assertNoForeignData(res.body, foreignTokens(context));
      const parsed = JSON.parse(res.body) as { data: unknown[]; page: { total: number } };
      expect(parsed.data).toEqual([]);
      expect(parsed.page.total).toBe(0);
    });

    it('the unscoped list shows only Org A incidents (ids, count, and content)', async () => {
      if (!context) return;
      const res = await read(context, ownerA, '/api/v1/incidents');
      expect(res.statusCode).toBe(200);
      assertNoForeignData(res.body, foreignTokens(context));
      const parsed = JSON.parse(res.body) as { data: { id: string }[]; page: { total: number } };
      expect(parsed.data.map((row) => row.id)).toEqual([context!.fixture.incidentAId]);
      expect(parsed.page.total).toBe(1);
    });
  });

  describe('sensitive-op denials are 403 and audited', () => {
    it('roster listing as a viewer is 403 with an audited denial and zero data echo', async () => {
      if (!context) return;
      const f = context.fixture;
      const before = await auditCount(context, f.orgAId, 'members.read_denied', f.orgAId);
      const res = await read(context, viewerA, '/api/v1/organizations/current/members');
      expectTenantDenial(res, [403], 'FORBIDDEN', foreignTokens(context));
      expect(await auditCount(context, f.orgAId, 'members.read_denied', f.orgAId)).toBe(before + 1);
    });

    it('audit-events listing as a viewer is 403 with an audited denial and zero data echo', async () => {
      if (!context) return;
      const f = context.fixture;
      const before = await auditCount(context, f.orgAId, 'audit.read_denied', f.orgAId);
      const res = await read(context, viewerA, '/api/v1/audit-events');
      expectTenantDenial(res, [403], 'FORBIDDEN', foreignTokens(context));
      expect(await auditCount(context, f.orgAId, 'audit.read_denied', f.orgAId)).toBe(before + 1);
    });

    it('the audit-events list for an admin never contains Org B events', async () => {
      if (!context) return;
      const res = await read(context, adminA, '/api/v1/audit-events');
      expect(res.statusCode).toBe(200);
      assertNoForeignData(res.body, foreignTokens(context));
      const parsed = JSON.parse(res.body) as { data: { targetId: string | null }[] };
      for (const event of parsed.data) {
        expect(event.targetId).not.toBe(context!.fixture.incidentBId);
        expect(event.targetId).not.toBe(context!.fixture.orgBId);
      }
    });
  });

  describe('anonymous access is denied on every tenant-scoped route', () => {
    const ROUTES: readonly { method: 'GET' | 'POST' | 'PATCH'; url: string }[] = [
      { method: 'GET', url: '/api/v1/me' },
      { method: 'POST', url: '/api/v1/me/active-organization' },
      { method: 'POST', url: '/api/v1/organizations' },
      { method: 'GET', url: '/api/v1/organizations/current' },
      { method: 'GET', url: '/api/v1/organizations/current/members' },
      { method: 'POST', url: '/api/v1/organizations/current/invitations' },
      { method: 'GET', url: '/api/v1/incidents' },
      { method: 'POST', url: '/api/v1/incidents' },
      { method: 'GET', url: `/api/v1/incidents/guessed-probe` },
      { method: 'PATCH', url: `/api/v1/incidents/guessed-probe` },
      { method: 'POST', url: `/api/v1/incidents/guessed-probe/comments` },
      { method: 'GET', url: `/api/v1/incidents/guessed-probe/comments` },
      { method: 'GET', url: '/api/v1/audit-events' },
    ];

    it.each(ROUTES.map((route) => [`${route.method} ${route.url}`, route] as const))(
      'anonymous %s gets 401 with the shared envelope',
      async (_label, route) => {
        if (!context) return;
        const res = await context.app.inject({
          method: route.method,
          url: route.url.replace('guessed-probe', randomUUID()),
          headers: { origin: 'http://localhost:5173' },
          payload: route.method === 'GET' ? undefined : { organizationId: randomUUID() },
        });
        expect(res.statusCode, res.body).toBe(401);
        expectEnvelope(res, 'UNAUTHORIZED');
        assertNoForeignData(res.body, foreignTokens(context));
      },
    );

    it('a forged session cookie is rejected like no cookie at all', async () => {
      if (!context) return;
      const res = await read(context, undefined, '/api/v1/me');
      expect(res.statusCode).toBe(401);
      const forged = await context.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: `${SESSION_COOKIE_NAME}=attacker-chosen-sid.forged-signature` },
      });
      expect(forged.statusCode).toBe(401);
      expectEnvelope(forged, 'UNAUTHORIZED');
    });
  });

  describe('tenant-ID substitution in request bodies is rejected', () => {
    it('POST /api/v1/incidents rejects an injected foreign organizationId with 400 and writes nothing', async () => {
      if (!context) return;
      const f = context.fixture;
      const res = await mutate(context, ownerA, 'POST', '/api/v1/incidents', {
        title: 'substitution probe',
        description: 'P1-7 substitution probe',
        severity: 'high',
        organizationId: f.orgBId,
      });
      // Strict Zod schemas reject the unknown key before any write.
      expectTenantDenial(res, [400], 'BAD_REQUEST', foreignTokens(context));

      // Org B is untouched either way: no incident appeared there.
      const list = await read(context, ownerA, '/api/v1/incidents');
      expect(list.statusCode).toBe(200);
      assertNoForeignData(list.body, foreignTokens(context));
      const parsed = JSON.parse(list.body) as { page: { total: number } };
      expect(parsed.page.total).toBe(1);
    });

    it('comment creation rejects an injected foreign organizationId with 400', async () => {
      if (!context) return;
      const f = context.fixture;
      const res = await mutate(context, ownerA, 'POST', `/api/v1/incidents/${f.incidentAId}/comments`, {
        body: 'substitution probe comment',
        organizationId: f.orgBId,
      });
      expectTenantDenial(res, [400], 'BAD_REQUEST', foreignTokens(context));
    });

    it('invitation creation rejects an injected foreign organizationId with 400', async () => {
      if (!context) return;
      const f = context.fixture;
      const res = await mutate(context, adminA, 'POST', '/api/v1/organizations/current/invitations', {
        email: `sub-${randomUUID()}@example.com`,
        role: 'viewer',
        organizationId: f.orgBId,
      });
      expectTenantDenial(res, [400], 'BAD_REQUEST', foreignTokens(context));
    });
  });
});
