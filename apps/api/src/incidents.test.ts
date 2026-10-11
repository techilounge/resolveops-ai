import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * Phase 1 spec §4.3 scoped incident surface over HTTP: list with
 * status/severity/assignee filters + tenant-scoped ILIKE search (the
 * no-inference case), create as any active member, view, and update with
 * Blueprint §6 status transitions, optimistic concurrency (version → 409),
 * and assignment through assignee_user_id with delta-D1 audit rows.
 * Every denial case uses a foreign Org B id and asserts zero foreign data
 * echoed and no count oracle.
 */

describe('scoped incidents (HTTP)', () => {
  let context: TestContext | undefined;
  let owner: TestSession | undefined; // Org A owner
  let analyst: TestSession | undefined; // Org A analyst (can create + be assigned)
  let orgBOwner: TestSession | undefined; // Org B owner (foreign user)

  const ORG_A = () => context!.fixture.orgAId;

  beforeAll(async () => {
    context = await createTestContext();
    if (!context) return;
    owner = await context.member({ role: 'owner' });
    analyst = await context.member({ role: 'analyst' });
    orgBOwner = await context.member({ role: 'owner', orgId: context.fixture.orgBId });
    for (const session of [owner, analyst, orgBOwner]) {
      await mutate(
        context,
        session,
        'POST',
        '/api/v1/me/active-organization',
        session === orgBOwner
          ? { organizationId: context.fixture.orgBId }
          : { organizationId: context.fixture.orgAId },
      );
    }
  });

  afterAll(async () => {
    if (context) await destroyTestContext(context);
  });

  it('no-ops cleanly when no local Postgres is configured', () => {
    if (!context) return;
    expect(true).toBe(true);
  });

  describe('POST /api/v1/incidents', () => {
    it('creates an incident as any active member with defaults, audited', async () => {
      if (!context || !analyst) return;
      const title = `BitLocker recovery key missing on FIN-0042 ${randomUUID()}`;
      const response = await mutate(context, analyst, 'POST', '/api/v1/incidents', {
        title,
        description: 'TPM validation failed after motherboard swap.',
        severity: 'high',
      });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body) as {
        id: string;
        title: string;
        status: string;
        severity: string;
        version: number;
        createdBy: string;
      };
      expect(body.title).toBe(title);
      expect(body.status).toBe('new');
      expect(body.severity).toBe('high');
      expect(body.version).toBe(1);
      expect(body.createdBy).toBe(analyst.userId);
      // Scoped by target id: the fixture seeds its own 'incident.created'
      // audit row for the pre-seeded org A incident.
      expect(await auditCount(context, ORG_A(), 'incident.created', body.id)).toBe(1);
    });

    it('rejects invalid payloads with the validation envelope', async () => {
      if (!context || !analyst) return;
      const response = await mutate(context, analyst, 'POST', '/api/v1/incidents', {
        title: 'x',
        severity: 'catastrophic',
      });
      expectEnvelope(response, 'BAD_REQUEST');
      expect(response.statusCode).toBe(400);
    });

    it('requires a session', async () => {
      if (!context) return;
      const response = await read(context, undefined, '/api/v1/incidents');
      expectEnvelope(response, 'UNAUTHORIZED');
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/incidents (list, filters, search)', () => {
    it('lists only the active org incidents in stable order', async () => {
      if (!context || !owner) return;
      const first = await mutate(context, owner, 'POST', '/api/v1/incidents', {
        title: `Org A incident one ${randomUUID()}`,
        description: 'first',
        severity: 'medium',
      });
      expect(first.statusCode).toBe(201);
      const second = await mutate(context, owner, 'POST', '/api/v1/incidents', {
        title: `Org A incident two ${randomUUID()}`,
        description: 'second',
        severity: 'low',
      });
      expect(second.statusCode).toBe(201);

      const response = await read(context, owner, '/api/v1/incidents');
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        data: Array<{ id: string; status: string; version: number }>;
        page: { page: number; pageSize: number; total: number };
      };
      expect(body.page.page).toBe(1);
      expect(body.page.total).toBeGreaterThanOrEqual(2);
      // Newest first (created_at DESC, id DESC tiebreaker).
      expect(body.data[0].id).toBe((JSON.parse(second.body) as { id: string }).id);
      // Every listed row carries the current status enum and version column.
      for (const row of body.data) {
        expect([
          'new',
          'triaged',
          'investigating',
          'awaiting_review',
          'resolved',
          'closed',
        ]).toContain(row.status);
        expect(row.version).toBeGreaterThanOrEqual(1);
      }
    });

    it('filters by status, severity, and assignee', async () => {
      if (!context || !owner || !analyst) return;
      const created = await mutate(context, owner, 'POST', '/api/v1/incidents', {
        title: `Filter probe ${randomUUID()}`,
        description: 'filter',
        severity: 'high',
      });
      const incidentId = (JSON.parse(created.body) as { id: string }).id;

      const byStatus = await read(context, owner, '/api/v1/incidents?status=new&severity=high');
      expect(byStatus.statusCode).toBe(200);
      const statusBody = JSON.parse(byStatus.body) as { data: Array<{ id: string }> };
      expect(statusBody.data.some((row) => row.id === incidentId)).toBe(true);

      const patched = await mutate(context, owner, 'PATCH', `/api/v1/incidents/${incidentId}`, {
        assigneeUserId: analyst.userId,
        expectedVersion: 1,
      });
      expect(patched.statusCode).toBe(200);

      const byAssignee = await read(context, owner, `/api/v1/incidents?assignee=${analyst.userId}`);
      expect(byAssignee.statusCode).toBe(200);
      const assigneeBody = JSON.parse(byAssignee.body) as { data: Array<{ id: string }> };
      expect(assigneeBody.data.some((row) => row.id === incidentId)).toBe(true);
    });

    it('searches titles and descriptions tenant-scoped', async () => {
      if (!context || !owner) return;
      const token = `needle-${randomUUID()}`;
      await mutate(context, owner, 'POST', '/api/v1/incidents', {
        title: `Needle in title ${token}`,
        description: 'haystack',
        severity: 'medium',
      });
      await mutate(context, owner, 'POST', '/api/v1/incidents', {
        title: 'Other incident',
        description: `haystack with ${token} in the body`,
        severity: 'low',
      });

      const byNeedle = await read(context, owner, `/api/v1/incidents?q=${encodeURIComponent(token)}`);
      expect(byNeedle.statusCode).toBe(200);
      const needleBody = JSON.parse(byNeedle.body) as { data: unknown[] };
      expect(needleBody.data).toHaveLength(2);

      const noMatch = await read(
        context,
        owner,
        `/api/v1/incidents?q=${encodeURIComponent(`zzz-${randomUUID()}`)}`,
      );
      expect(noMatch.statusCode).toBe(200);
      expect((JSON.parse(noMatch.body) as { data: unknown[] }).data).toEqual([]);
    });

    it('search for a string existing only in Org B returns empty (no inference)', async () => {
      if (!context || !owner || !orgBOwner) return;
      // Org B incident whose title+description contain a token Org A never sees.
      const orgBToken = `quokka-xyzzy-${randomUUID()}`;
      const orgBIncident = await mutate(context, orgBOwner, 'POST', '/api/v1/incidents', {
        title: `Org B secret ${orgBToken}`,
        description: `unique string ${orgBToken} only in Org B`,
        severity: 'high',
      });
      expect(orgBIncident.statusCode).toBe(201);

      const response = await read(context, owner, `/api/v1/incidents?q=${encodeURIComponent(orgBToken)}`);
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { data: unknown[]; page: { total: number } };
      expect(body.data).toEqual([]);
      expect(body.page.total).toBe(0);
      expect(JSON.stringify(body)).not.toContain(orgBToken);
      expect(JSON.stringify(body)).not.toContain(context.fixture.orgBId);
    });

    it('treats LIKE metacharacters as literals, without erroring', async () => {
      if (!context || !owner) return;
      const response = await read(
        context,
        owner,
        `/api/v1/incidents?q=${encodeURIComponent("%'; DROP TABLE incidents; --")}`,
      );
      expect(response.statusCode).toBe(200);
      expect((JSON.parse(response.body) as { data: unknown[] }).data).toEqual([]);
      const stillThere = await read(context, owner, '/api/v1/incidents');
      expect(stillThere.statusCode).toBe(200);
    });

    it('paginates with a stable order', async () => {
      if (!context || !owner) return;
      const pageOne = await read(context, owner, '/api/v1/incidents?pageSize=1&page=1');
      const pageTwo = await read(context, owner, '/api/v1/incidents?pageSize=1&page=2');
      expect(pageOne.statusCode).toBe(200);
      expect(pageTwo.statusCode).toBe(200);
      const one = JSON.parse(pageOne.body) as { data: Array<{ id: string }>; page: { total: number } };
      const two = JSON.parse(pageTwo.body) as { data: Array<{ id: string }>; page: { total: number } };
      expect(one.page.total).toBe(two.page.total);
      expect(one.page.total).toBeGreaterThanOrEqual(2);
      expect(one.data[0].id).not.toBe(two.data[0].id);
    });
  });

  describe('GET /api/v1/incidents/:id', () => {
    it('returns a member-visible incident', async () => {
      if (!context || !analyst) return;
      const created = await mutate(context, analyst, 'POST', '/api/v1/incidents', {
        title: `Detail probe ${randomUUID()}`,
        description: 'detail',
        severity: 'low',
      });
      const id = (JSON.parse(created.body) as { id: string }).id;
      const response = await read(context, analyst, `/api/v1/incidents/${id}`);
      expect(response.statusCode).toBe(200);
      expect((JSON.parse(response.body) as { id: string }).id).toBe(id);
    });

    it('404s a foreign-org incident id with zero foreign data', async () => {
      if (!context || !analyst || !orgBOwner) return;
      const foreign = await mutate(context, orgBOwner, 'POST', '/api/v1/incidents', {
        title: `Org B private ${randomUUID()}`,
        description: 'foreign',
        severity: 'high',
      });
      const foreignId = (JSON.parse(foreign.body) as { id: string }).id;

      const response = await read(context, analyst, `/api/v1/incidents/${foreignId}`);
      expect(response.statusCode).toBe(404);
      expectEnvelope(response, 'NOT_FOUND');
      expect(response.body).not.toContain('Org B private');
      expect(response.body).not.toContain(foreignId);
    });

    it('404s a well-formed unknown id and 400s a malformed one', async () => {
      if (!context || !analyst) return;
      const unknown = await read(context, analyst, `/api/v1/incidents/${randomUUID()}`);
      expect(unknown.statusCode).toBe(404);
      expectEnvelope(unknown, 'NOT_FOUND');

      const malformed = await read(context, analyst, '/api/v1/incidents/not-a-uuid');
      expectEnvelope(malformed, 'BAD_REQUEST');
      expect(malformed.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/v1/incidents/:id', () => {
    it('updates status per the Blueprint enum with an audit row', async () => {
      if (!context || !owner) return;
      const created = await mutate(context, owner, 'POST', '/api/v1/incidents', {
        title: `Transition probe ${randomUUID()}`,
        description: 'transitions',
        severity: 'medium',
      });
      const id = (JSON.parse(created.body) as { id: string }).id;

      const triaged = await mutate(context, owner, 'PATCH', `/api/v1/incidents/${id}`, {
        status: 'triaged',
        expectedVersion: 1,
      });
      expect(triaged.statusCode).toBe(200);
      expect((JSON.parse(triaged.body) as { version: number }).version).toBe(2);
      // The route's action name is 'incident.updated' (one row per patch),
      // scoped to this incident's id (the fixture seeds its own audit rows).
      expect(await auditCount(context, ORG_A(), 'incident.updated', id)).toBe(1);

      const investigating = await mutate(context, owner, 'PATCH', `/api/v1/incidents/${id}`, {
        status: 'investigating',
        expectedVersion: 2,
      });
      expect((JSON.parse(investigating.body) as { version: number }).version).toBe(3);
    });

    it('assigns a member with a delta-D1 audit row', async () => {
      if (!context || !owner || !analyst) return;
      const created = await mutate(context, owner, 'POST', '/api/v1/incidents', {
        title: `Assign probe ${randomUUID()}`,
        description: 'assignment',
        severity: 'high',
      });
      const id = (JSON.parse(created.body) as { id: string }).id;

      const assigned = await mutate(context, owner, 'PATCH', `/api/v1/incidents/${id}`, {
        assigneeUserId: analyst.userId,
        expectedVersion: 1,
      });
      expect(assigned.statusCode).toBe(200);
      const body = JSON.parse(assigned.body) as { assigneeUserId: string | null };
      expect(body.assigneeUserId).toBe(analyst.userId);
      expect(await auditCount(context, ORG_A(), 'incident.assigned', id)).toBe(1);
    });

    it('combines status, description, and assignment in one update', async () => {
      if (!context || !owner || !analyst) return;
      const created = await mutate(context, owner, 'POST', '/api/v1/incidents', {
        title: `Combo probe ${randomUUID()}`,
        description: 'combo',
        severity: 'medium',
      });
      const id = (JSON.parse(created.body) as { id: string }).id;
      const response = await mutate(context, owner, 'PATCH', `/api/v1/incidents/${id}`, {
        status: 'awaiting_review',
        description: 'updated by combo probe',
        assigneeUserId: analyst.userId,
        expectedVersion: 1,
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        status: string;
        description: string;
        assigneeUserId: string | null;
        version: number;
      };
      expect(body.status).toBe('awaiting_review');
      expect(body.description).toBe('updated by combo probe');
      expect(body.assigneeUserId).toBe(analyst.userId);
      expect(body.version).toBe(2);
    });

    it('409s on a stale expectedVersion and rolls nothing forward', async () => {
      if (!context || !owner) return;
      const created = await mutate(context, owner, 'POST', '/api/v1/incidents', {
        title: `Conflict probe ${randomUUID()}`,
        description: 'conflict',
        severity: 'medium',
      });
      const id = (JSON.parse(created.body) as { id: string }).id;

      const winner = await mutate(context, owner, 'PATCH', `/api/v1/incidents/${id}`, {
        description: 'winner writes first',
        expectedVersion: 1,
      });
      expect(winner.statusCode).toBe(200);

      const loser = await mutate(context, owner, 'PATCH', `/api/v1/incidents/${id}`, {
        description: 'loser wrote stale',
        expectedVersion: 1,
      });
      expect(loser.statusCode).toBe(409);
      expectEnvelope(loser, 'CONFLICT');
      // Losing write did not clobber the winner's state.
      const after = await read(context, owner, `/api/v1/incidents/${id}`);
      expect((JSON.parse(after.body) as { description: string }).description).toBe(
        'winner writes first',
      );
    });

    it('rejects empty patches and invalid statuses with the validation envelope', async () => {
      if (!context || !owner) return;
      const created = await mutate(context, owner, 'POST', '/api/v1/incidents', {
        title: `Validation probe ${randomUUID()}`,
        description: 'validation',
        severity: 'low',
      });
      const id = (JSON.parse(created.body) as { id: string }).id;

      const empty = await mutate(context, owner, 'PATCH', `/api/v1/incidents/${id}`, {
        expectedVersion: 1,
      });
      expect(empty.statusCode).toBe(400);
      expectEnvelope(empty, 'BAD_REQUEST');

      const badStatus = await mutate(context, owner, 'PATCH', `/api/v1/incidents/${id}`, {
        status: 'cancelled-forever',
        expectedVersion: 1,
      });
      expect(badStatus.statusCode).toBe(400);
      expectEnvelope(badStatus, 'BAD_REQUEST');
    });

    it('404s a foreign-org patch attempt with zero foreign data echoed', async () => {
      if (!context || !owner || !orgBOwner) return;
      const foreign = await mutate(context, orgBOwner, 'POST', '/api/v1/incidents', {
        title: `Org B patch target ${randomUUID()}`,
        description: 'foreign patch',
        severity: 'high',
      });
      const foreignId = (JSON.parse(foreign.body) as { id: string }).id;

      const response = await mutate(context, owner, 'PATCH', `/api/v1/incidents/${foreignId}`, {
        status: 'closed',
        expectedVersion: 1,
      });
      expect(response.statusCode).toBe(404);
      expectEnvelope(response, 'NOT_FOUND');
      expect(response.body).not.toContain('Org B patch target');
      expect(response.body).not.toContain(foreignId);
    });
  });
});
