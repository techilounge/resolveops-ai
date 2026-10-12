import { randomUUID } from 'node:crypto';
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
 * Incident comments over HTTP (P1-4 addendum, delta D4): the §4.4 detail
 * screen's discussion surface. Both routes run inside the tenant context;
 * a foreign-org incident id and a nonexistent one are the same zero-row
 * 404 (no enumeration signal), and comments write NO audit rows (the spec
 * §7 audit list does not include them — see the route module's note).
 */

describe('incident comments (HTTP, delta D4)', () => {
  let context: TestContext | undefined;
  let owner: TestSession | undefined; // Org A owner
  let analyst: TestSession | undefined; // Org A analyst (second author)
  let orgBOwner: TestSession | undefined; // Org B owner (foreign user)

  const ORG_A = () => context!.fixture.orgAId;
  const INCIDENT_A = () => context!.fixture.incidentAId;
  const INCIDENT_B = () => context!.fixture.incidentBId;

  beforeAll(async () => {
    context = await createTestContext();
    if (!context) return;
    owner = await context.member({ role: 'owner' });
    analyst = await context.member({ role: 'analyst' });
    orgBOwner = await context.member({ role: 'owner', orgId: context.fixture.orgBId });
    for (const session of [owner, analyst]) {
      await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: context.fixture.orgAId,
      });
    }
    await mutate(context, orgBOwner, 'POST', '/api/v1/me/active-organization', {
      organizationId: context.fixture.orgBId,
    });
  });

  afterAll(async () => {
    if (context) await destroyTestContext(context);
  });

  it('no-ops cleanly when no local Postgres is configured', () => {
    if (!context) return;
    expect(true).toBe(true);
  });

  describe('POST /api/v1/incidents/:id/comments', () => {
    it('creates a comment as any active member with the author resolved server-side', async () => {
      if (!context || !analyst) return;
      const body = `TPM logs collected from FIN-0042 before reimage ${randomUUID()}`;
      const response = await mutate(
        context,
        analyst,
        'POST',
        `/api/v1/incidents/${INCIDENT_A()}/comments`,
        { body },
      );
      expect(response.statusCode).toBe(201);
      const dto = JSON.parse(response.body) as {
        id: string;
        incidentId: string;
        organizationId: string;
        authorUserId: string;
        authorDisplayName: string;
        body: string;
        createdAt: string;
        updatedAt: string;
      };
      expect(dto.body).toBe(body);
      expect(dto.incidentId).toBe(INCIDENT_A());
      expect(dto.organizationId).toBe(ORG_A());
      expect(dto.authorUserId).toBe(analyst.userId);
      // The author's display name comes from the users row via the join —
      // verified against the stored row, not anything the client sent.
      const stored = await context.superuserPool.query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE id = $1',
        [analyst.userId],
      );
      expect(dto.authorDisplayName).toBe(stored.rows[0].display_name);
      // Phase 1 has no comment edit — the audit columns start identical.
      expect(dto.updatedAt).toBe(dto.createdAt);
    });

    it('writes no audit rows (spec §7 audit list excludes comments — delta D4 reading)', async () => {
      if (!context || !owner) return;
      const before = await context.superuserPool.query<{ count: string }>(
        'SELECT count(*) AS count FROM audit_events WHERE organization_id = $1',
        [ORG_A()],
      );
      const response = await mutate(context, owner, 'POST', `/api/v1/incidents/${INCIDENT_A()}/comments`, {
        body: `audit-silence probe ${randomUUID()}`,
      });
      expect(response.statusCode).toBe(201);
      const after = await context.superuserPool.query<{ count: string }>(
        'SELECT count(*) AS count FROM audit_events WHERE organization_id = $1',
        [ORG_A()],
      );
      expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count));
    });

    it('rejects invalid payloads with the validation envelope', async () => {
      if (!context || !owner) return;
      for (const payload of [
        { body: '' }, // below minLength 1
        { body: 'x'.repeat(10001) }, // above maxLength 10000
        {}, // missing body
        { body: 'valid', extra: 1 }, // strict — unknown key
      ]) {
        const response = await mutate(
          context,
          owner,
          'POST',
          `/api/v1/incidents/${INCIDENT_A()}/comments`,
          payload,
        );
        expectEnvelope(response, 'BAD_REQUEST');
        expect(response.statusCode).toBe(400);
      }
    });

    it('a foreign-org incident id is the same 404 as a nonexistent one — zero data echoed', async () => {
      if (!context || !orgBOwner) return;
      const before = await context.superuserPool.query<{ count: string }>(
        'SELECT count(*) AS count FROM incident_comments WHERE incident_id = $1',
        [INCIDENT_A()],
      );
      const foreign = await mutate(
        context,
        orgBOwner,
        'POST',
        `/api/v1/incidents/${INCIDENT_A()}/comments`,
        { body: `should never persist ${randomUUID()}` },
      );
      expectEnvelope(foreign, 'NOT_FOUND');
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).not.toContain('FIN-'); // the fixture's Org A incident title prefix
      const nonexistent = await mutate(
        context,
        orgBOwner,
        'POST',
        `/api/v1/incidents/${randomUUID()}/comments`,
        { body: 'nonexistent target' },
      );
      expectEnvelope(nonexistent, 'NOT_FOUND');
      expect(nonexistent.statusCode).toBe(404);
      // Nothing was written by either denied attempt.
      const after = await context.superuserPool.query<{ count: string }>(
        'SELECT count(*) AS count FROM incident_comments WHERE incident_id = $1',
        [INCIDENT_A()],
      );
      expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count));
    });

    it('rejects unauthenticated calls', async () => {
      if (!context) return;
      const response = await context.app.inject({
        method: 'POST',
        url: `/api/v1/incidents/${INCIDENT_A()}/comments`,
        payload: { body: 'no session' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/incidents/:id/comments', () => {
    it('lists oldest first with a stable sequence and a correct page total', async () => {
      if (!context || !owner || !analyst) return;
      const authors = [owner, analyst, owner];
      const created: string[] = [];
      for (const [index, session] of authors.entries()) {
        const response = await mutate(
          context,
          session,
          'POST',
          `/api/v1/incidents/${INCIDENT_A()}/comments`,
          { body: `stability probe ${index} ${randomUUID()}` },
        );
        expect(response.statusCode).toBe(201);
        created.push((JSON.parse(response.body) as { id: string }).id);
      }
      // Walk every page at pageSize=2 and compare against one full fetch:
      // the union must reproduce the full list's ids in the same order,
      // proving the limit/offset windows tile the same stable sequence.
      const full = await read(context, owner, `/api/v1/incidents/${INCIDENT_A()}/comments?pageSize=100`);
      expect(full.statusCode).toBe(200);
      const all = JSON.parse(full.body) as {
        data: { id: string; createdAt: string }[];
        page: { page: number; pageSize: number; total: number };
      };
      expect(all.page.total).toBeGreaterThanOrEqual(3);
      expect(all.data).toHaveLength(all.page.total);
      for (const id of created) expect(all.data.map((row) => row.id)).toContain(id);
      const timestamps = all.data.map((row) => row.createdAt);
      for (let index = 1; index < timestamps.length; index += 1) {
        expect(timestamps[index] >= timestamps[index - 1]).toBe(true);
      }
      const windowed: string[] = [];
      const totalPages = Math.ceil(all.page.total / 2);
      for (let page = 1; page <= totalPages; page += 1) {
        const response = await read(context, owner, `/api/v1/incidents/${INCIDENT_A()}/comments?page=${page}&pageSize=2`);
        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body) as {
          data: { id: string }[];
          page: { page: number; total: number };
        };
        expect(body.page.page).toBe(page);
        windowed.push(...body.data.map((row) => row.id));
      }
      expect(windowed).toEqual(all.data.map((row) => row.id));
      // Stability: the identical request replays the identical sequence.
      const replay = await read(context, owner, `/api/v1/incidents/${INCIDENT_A()}/comments?pageSize=100`);
      expect(
        (JSON.parse(replay.body) as typeof all).data.map((row) => row.id),
      ).toEqual(all.data.map((row) => row.id));
    });

    it('resolves each author through the users join', async () => {
      if (!context || !owner || !analyst) return;
      const listed = await read(context, analyst, `/api/v1/incidents/${INCIDENT_A()}/comments?pageSize=100`);
      expect(listed.statusCode).toBe(200);
      const rows = (JSON.parse(listed.body) as {
        data: { authorUserId: string; authorDisplayName: string }[];
      }).data;
      // Every listed row's display name equals the users table's value for
      // that author — the join is correct for each row, not just the first.
      const stored = await context.superuserPool.query<{ id: string; display_name: string }>(
        'SELECT id, display_name FROM users',
      );
      const namesById = new Map(stored.rows.map((row) => [row.id, row.display_name]));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.authorDisplayName).toBe(namesById.get(row.authorUserId));
      }
      // Two distinct authors resolve to their own (distinct) names.
      const analystRow = rows.find((row) => row.authorUserId === analyst!.userId);
      const ownerRow = rows.find((row) => row.authorUserId === owner!.userId);
      expect(analystRow).toBeDefined();
      expect(ownerRow).toBeDefined();
      expect(analystRow!.authorDisplayName).not.toBe(ownerRow!.authorDisplayName);
    });

    it('a foreign org gets a 404 (never an empty list) and zero foreign data', async () => {
      if (!context || !orgBOwner) return;
      const denied = await read(context, orgBOwner, `/api/v1/incidents/${INCIDENT_A()}/comments`);
      expectEnvelope(denied, 'NOT_FOUND');
      expect(denied.statusCode).toBe(404);
      // No count oracle: the envelope carries no Org A comment text.
      expect(denied.body).not.toContain('stability probe');
      // Org B's own incident lists fine but never contains Org A rows.
      const own = await read(context, orgBOwner, `/api/v1/incidents/${INCIDENT_B()}/comments`);
      expect(own.statusCode).toBe(200);
      const rows = JSON.parse(own.body) as { data: { organizationId: string }[] };
      for (const row of rows.data) {
        expect(row.organizationId).toBe(context!.fixture.orgBId);
      }
    });

    it('rejects unauthenticated calls', async () => {
      if (!context) return;
      const response = await read(context, undefined, `/api/v1/incidents/${INCIDENT_A()}/comments`);
      expect(response.statusCode).toBe(401);
    });
  });
});
