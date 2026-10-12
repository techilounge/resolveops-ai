import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '@resolveops/auth';
import {
  createTestContext,
  destroyTestContext,
  expectEnvelope,
  mutate,
  read,
  auditCount,
  type TestContext,
  type TestSession,
} from './testing/support';
import { ORIGIN } from './testing/constants';

/**
 * Phase 1 spec §4.3 tenancy surface over HTTP: /me, organization create
 * (single transaction), current-org context, delta-D2 active-organization
 * switching (server-verified membership, audited), and the delta-D3
 * audit-events reader route. Denials assert the envelope code AND the
 * audit row, and never echo foreign-org data.
 */

describe('tenancy and organizations (HTTP)', () => {
  let context: TestContext | undefined;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    if (context) await destroyTestContext(context);
  });

  /** Second scratch org (superuser-seeded) for switch/invite tests. */
  async function scratchOrg(name: string): Promise<string> {
    const orgId = randomUUID();
    await context!.superuserPool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
      [orgId, name, `scratch-${name.toLowerCase().replaceAll(' ', '-')}-${randomUUID()}`],
    );
    return orgId;
  }

  it('no-ops cleanly when no local Postgres is configured', () => {
    if (!context) return;
    expect(true).toBe(true);
  });

  describe('GET /api/v1/me', () => {
    it('returns an empty membership list before any organization exists', async () => {
      if (!context) return;
      const session = await context.loginOnly();
      const response = await read(context, session, '/api/v1/me');
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { user: { id: string }; memberships: unknown[] };
      expect(body.user.id).toBe(session.userId);
      expect(body.memberships).toEqual([]);
    });

    it('lists the user memberships across organizations with status and role', async () => {
      if (!context) return;
      const session = await context.member({ role: 'owner' });
      const invitedOrg = await scratchOrg('Invited Side');
      await context.superuserPool.query(
        `INSERT INTO memberships (id, organization_id, user_id, role, status) VALUES ($1, $2, $3, 'viewer', 'invited')`,
        [randomUUID(), invitedOrg, session.userId],
      );
      const response = await read(context, session, '/api/v1/me');
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        memberships: Array<{ organizationId: string; role: string; status: string }>;
      };
      expect(body.memberships).toHaveLength(2);
      const roles = body.memberships.map((m) => m.role).sort();
      expect(roles).toEqual(['owner', 'viewer']);
      const statuses = body.memberships.map((m) => m.status).sort();
      expect(statuses).toEqual(['active', 'invited']);
      // Zero foreign memberships: this user must not see the fixture's other users.
      const orgIds = body.memberships.map((m) => m.organizationId).sort();
      expect(orgIds).toContain(context.fixture.orgAId);
      expect(orgIds).toContain(invitedOrg);
      expect(orgIds).not.toContain(context.fixture.orgBId);
    });

    it('requires a session', async () => {
      if (!context) return;
      const response = await read(context, undefined, '/api/v1/me');
      expectEnvelope(response, 'UNAUTHORIZED');
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/organizations', () => {
    it('creates the organization and owner membership in one transaction, audited', async () => {
      if (!context) return;
      const session = await context.member();
      const name = `Txn Org ${randomUUID()}`;
      const response = await mutate(context, session, 'POST', '/api/v1/organizations', {
        name,
      });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body) as {
        organization: { id: string; name: string; slug: string };
        membership: { role: string; status: string };
      };
      expect(body.organization.name).toBe(name);
      // The slug is server-generated (the contract has no slug input).
      expect(body.organization.slug).toBeTruthy();
      expect(body.membership.role).toBe('owner');
      expect(body.membership.status).toBe('active');

      // Same transaction, both sides present (org-create transactionality).
      const memberships = await context.superuserPool.query<{ count: string }>(
        'SELECT count(*) AS count FROM memberships WHERE organization_id = $1 AND user_id = $2 AND role = $3',
        [body.organization.id, session.userId, 'owner'],
      );
      expect(Number(memberships.rows[0].count)).toBe(1);
      expect(await auditCount(context, body.organization.id, 'organization.created')).toBe(1);
    });

    it('rejects invalid payloads with the shared validation envelope', async () => {
      if (!context) return;
      const session = await context.member();
      const response = await mutate(context, session, 'POST', '/api/v1/organizations', {
        name: 'Bad Slug Org',
        slug: 'Not a Slug!',
      });
      expectEnvelope(response, 'BAD_REQUEST');
      expect(response.statusCode).toBe(400);
    });

    it('generates distinct slugs for repeated names (server-side uniqueness)', async () => {
      if (!context) return;
      const session = await context.member();
      const first = await mutate(context, session, 'POST', '/api/v1/organizations', {
        name: 'Same Name Org',
      });
      expect(first.statusCode).toBe(201);
      const second = await mutate(context, session, 'POST', '/api/v1/organizations', {
        name: 'Same Name Org',
      });
      expect(second.statusCode).toBe(201);
      const a = JSON.parse(first.body) as { organization: { slug: string } };
      const b = JSON.parse(second.body) as { organization: { slug: string } };
      expect(a.organization.slug).not.toBe(b.organization.slug);
    });
  });

  describe('organization switching (delta D2)', () => {
    it('switches between active memberships and updates only the session', async () => {
      if (!context) return;
      const session = await context.member({ role: 'owner' });
      const orgTwo = await scratchOrg('Switch Target');
      await context.superuserPool.query(
        `INSERT INTO memberships (id, organization_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')`,
        [randomUUID(), orgTwo, session.userId],
      );

      const before = await read(context, session, '/api/v1/organizations/current');
      // Authenticated but no active org selected — the guard's documented
      // 403 (401 is reserved for "no session user").
      expectEnvelope(before, 'FORBIDDEN');
      expect(before.statusCode).toBe(403);

      const switchOne = await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: context.fixture.orgAId,
      });
      expect(switchOne.statusCode).toBe(200);
      const currentOne = await read(context, session, '/api/v1/organizations/current');
      expect(currentOne.statusCode).toBe(200);
      expect((JSON.parse(currentOne.body) as { organization: { id: string } }).organization.id).toBe(
        context.fixture.orgAId,
      );

      const switchTwo = await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: orgTwo,
      });
      expect(switchTwo.statusCode).toBe(200);
      const currentTwo = await read(context, session, '/api/v1/organizations/current');
      expect((JSON.parse(currentTwo.body) as { organization: { id: string } }).organization.id).toBe(
        orgTwo,
      );

      expect(await auditCount(context, context.fixture.orgAId, 'organization.switched')).toBe(1);
      expect(await auditCount(context, orgTwo, 'organization.switched')).toBe(1);
    });

    it('denies switching to an organization without an active membership, audited', async () => {
      if (!context) return;
      const session = await context.member({ role: 'owner' });
      await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: context.fixture.orgAId,
      });
      const foreignOrg = await scratchOrg('Foreign Switch');
      const response = await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: foreignOrg,
      });
      expectEnvelope(response, 'FORBIDDEN');
      expect(response.statusCode).toBe(403);
      // The denial lands in the TARGET org's audit log with no data echo.
      expect(await auditCount(context, foreignOrg, 'tenant.access_denied')).toBe(1);
      // The previously valid selection survives a denied switch.
      const current = await read(context, session, '/api/v1/organizations/current');
      expect(current.statusCode).toBe(200);
      expect((JSON.parse(current.body) as { organization: { id: string } }).organization.id).toBe(
        context.fixture.orgAId,
      );
    });

    it('denies switching to a nonexistent organization with a clean 403 and a user-scoped denial row (F-1)', async () => {
      if (!context) return;
      const session = await context.member({ role: 'owner' });
      await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: context.fixture.orgAId,
      });
      // F-1: a well-formed but nonexistent org id must be a clean 403 denial
      // envelope — never the audit-FK 500 — and echo nothing, not even the
      // attempted id.
      const nonexistent = randomUUID();
      const response = await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: nonexistent,
      });
      expectEnvelope(response, 'FORBIDDEN');
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(nonexistent);
      // The denial stays auditable without a (nonexistent) org to scope the
      // row to: the user-scoped shape user.login uses — organization_id NULL
      // (nullable by design), the actor preserved, the attempted id carried
      // in metadata. Actor-scoped so parallel workers stay deterministic.
      const denials = await context.superuserPool.query<{
        actor_user_id: string;
        target_id: string | null;
        reason: string | null;
        attempted: string | null;
      }>(
        `SELECT actor_user_id, target_id,
                metadata->>'reason' AS reason,
                metadata->>'attemptedOrganizationId' AS attempted
           FROM audit_events
          WHERE action = 'tenant.access_denied'
            AND organization_id IS NULL
            AND actor_user_id = $1`,
        [session.userId],
      );
      expect(denials.rows).toHaveLength(1);
      expect(denials.rows[0].actor_user_id).toBe(session.userId);
      expect(denials.rows[0].target_id).toBe(nonexistent);
      expect(denials.rows[0].reason).toBe('not_active_member');
      expect(denials.rows[0].attempted).toBe(nonexistent);
      // The previously valid selection survives a denied switch.
      const current = await read(context, session, '/api/v1/organizations/current');
      expect(current.statusCode).toBe(200);
      expect((JSON.parse(current.body) as { organization: { id: string } }).organization.id).toBe(
        context.fixture.orgAId,
      );
    });

    it('denies switching to an invited-but-not-active membership', async () => {
      if (!context) return;
      const session = await context.member({ role: 'owner' });
      const invitedOrg = await scratchOrg('Invite Only');
      await context.superuserPool.query(
        `INSERT INTO memberships (id, organization_id, user_id, role, status) VALUES ($1, $2, $3, 'viewer', 'invited')`,
        [randomUUID(), invitedOrg, session.userId],
      );
      const response = await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: invitedOrg,
      });
      expectEnvelope(response, 'FORBIDDEN');
      expect(response.statusCode).toBe(403);
    });

    it('rejects malformed switch payloads with the validation envelope', async () => {
      if (!context) return;
      const session = await context.member();
      const response = await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: 'not-a-uuid',
      });
      expectEnvelope(response, 'BAD_REQUEST');
      expect(response.statusCode).toBe(400);
    });
  });

  describe('guard rails carried over from P1-3 on this surface', () => {
    it('rejects a mutating call without the CSRF header', async () => {
      if (!context) return;
      const session = await context.member();
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${session.cookie}`,
          origin: ORIGIN,
        },
        payload: { name: 'No CSRF' },
      });
      expectEnvelope(response, 'FORBIDDEN');
      expect(response.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/audit-events (delta D3)', () => {
    let owner: TestSession | undefined;

    beforeAll(async () => {
      if (!context) return;
      owner = await context.member({ role: 'owner' });
      await mutate(context!, owner, 'POST', '/api/v1/me/active-organization', {
        organizationId: context!.fixture.orgAId,
      });
    });

    it('lists org-scoped events for an owner with the pagination envelope', async () => {
      if (!context || !owner) return;
      const response = await read(context, owner, '/api/v1/audit-events');
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        data: Array<{ id: string; action: string }>;
        page: { page: number; pageSize: number; total: number };
      };
      expect(body.page.page).toBe(1);
      expect(body.page.total).toBeGreaterThanOrEqual(1);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.some((event) => event.action === 'organization.switched')).toBe(true);
      // No foreign-org identifiers may leak through ids or metadata.
      expect(JSON.stringify(body)).not.toContain(context!.fixture.orgBId);
    });

    it('paginates deterministically', async () => {
      if (!context || !owner) return;
      const pageOne = await read(context, owner, '/api/v1/audit-events?page=1&pageSize=1');
      const pageTwo = await read(context, owner, '/api/v1/audit-events?page=2&pageSize=1');
      expect(pageOne.statusCode).toBe(200);
      expect(pageTwo.statusCode).toBe(200);
      const one = JSON.parse(pageOne.body) as { data: unknown[]; page: { total: number } };
      const two = JSON.parse(pageTwo.body) as { data: unknown[]; page: { total: number } };
      expect(one.data).toHaveLength(1);
      expect(one.page.total).toBe(two.page.total);
      expect(JSON.stringify(one.data)).not.toEqual(JSON.stringify(two.data));
    });

    it('rejects invalid pagination with the validation envelope', async () => {
      if (!context || !owner) return;
      const response = await read(context, owner, '/api/v1/audit-events?page=0');
      expectEnvelope(response, 'BAD_REQUEST');
      expect(response.statusCode).toBe(400);
    });

    it('denies non-admin roles, audited, on the app pool', async () => {
      if (!context || !owner) return;
      const analyst = await context.member({ role: 'analyst' });
      await mutate(context, analyst, 'POST', '/api/v1/me/active-organization', {
        organizationId: context.fixture.orgAId,
      });
      const response = await read(context, analyst, '/api/v1/audit-events');
      expectEnvelope(response, 'FORBIDDEN');
      expect(response.statusCode).toBe(403);
      expect(await auditCount(context, context.fixture.orgAId, 'audit.read_denied')).toBe(1);
      // The denial is also visible to the owner through the reader route.
      const ownerView = await read(context, owner, '/api/v1/audit-events');
      expect(ownerView.statusCode).toBe(200);
      const body = JSON.parse(ownerView.body) as { data: Array<{ action: string }> };
      expect(body.data.some((event) => event.action === 'audit.read_denied')).toBe(true);
    });
  });
});
