import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
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
 * P1-7 — invitation and privilege-escalation re-proofs (Blueprint §7),
 * adversarial: an `invited` membership must never become an active-org
 * context through any route; the invitation surface must not be a
 * self-elevation path for viewers or admins; denials must be audited and
 * must create no membership rows. Unique emails everywhere so suites on a
 * shared database cannot contaminate the stub-IdP identity resolution.
 */

async function memberCount(pool: Pool, orgId: string, role: string): Promise<string> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM memberships WHERE organization_id = $1 AND role = $2',
    [orgId, role],
  );
  return result.rows[0].count;
}

async function membershipCountByEmail(pool: Pool, email: string): Promise<string> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1',
    [email],
  );
  return result.rows[0].count;
}

describe('P1-7 invitation escalation re-proofs (HTTP, Blueprint §7)', () => {
  let context: TestContext | undefined;
  let ownerA: TestSession;
  let adminA: TestSession;
  let viewerA: TestSession;

  beforeAll(async () => {
    const setup = await createTestContext();
    if (!setup) return;
    context = setup;

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

  it('an invited membership grants nothing: the org switch is 403 + audited, the queue stays unreachable, and the row is still invited', async () => {
    if (!context) return;
    const f = context.fixture;
    const invited = await context.loginOnly();
    await context.superuserPool.query(
      `INSERT INTO memberships (id, organization_id, user_id, role, status)
       VALUES ($1, $2, $3, 'viewer', 'invited')`,
      [randomUUID(), f.orgAId, invited.userId],
    );

    // The invited user can see their own (pending) membership...
    const me = await read(context, invited, '/api/v1/me');
    expect(me.statusCode).toBe(200);
    expect(me.body).toContain(f.orgAId);

    // ...but activating the org is denied, with the denial audited.
    const before = await auditCount(context, f.orgAId, 'tenant.access_denied', f.orgAId);
    const denied = await mutate(context, invited, 'POST', '/api/v1/me/active-organization', {
      organizationId: f.orgAId,
    });
    expect(denied.statusCode).toBe(403);
    expectEnvelope(denied, 'FORBIDDEN');
    expect(await auditCount(context, f.orgAId, 'tenant.access_denied', f.orgAId)).toBe(before + 1);

    // Every tenant-scoped read stays unreachable — no active org context.
    for (const url of ['/api/v1/incidents', '/api/v1/audit-events', '/api/v1/organizations/current/members']) {
      const blocked = await read(context, invited, url);
      expect(blocked.statusCode, url).toBe(403);
      expectEnvelope(blocked, 'FORBIDDEN');
      expect(blocked.body.includes(f.orgBToken)).toBe(false);
    }
    const noCreate = await mutate(context, invited, 'POST', '/api/v1/incidents', {
      title: 'invited user should never write',
      severity: 'low',
    });
    expect(noCreate.statusCode).toBe(403);
    expectEnvelope(noCreate, 'FORBIDDEN');

    // And the row itself is unchanged: invited, not active.
    const status = await context.superuserPool.query<{ status: string }>(
      'SELECT status FROM memberships WHERE organization_id = $1 AND user_id = $2',
      [f.orgAId, invited.userId],
    );
    expect(status.rows[0].status).toBe('invited');
  });

  it('a viewer cannot mint an owner invite: 403, audited, and zero owner rows added', async () => {
    if (!context) return;
    const f = context.fixture;
    const email = `p1-7-viewer-elevate-${randomUUID()}@example.com`;
    const before = await memberCount(context.superuserPool, f.orgAId, 'owner');
    expect(before).toBe('2'); // seeded userA + this suite's ownerA

    const denied = await mutate(context, viewerA, 'POST', '/api/v1/organizations/current/invitations', {
      email,
      role: 'owner',
    });
    expect(denied.statusCode).toBe(403);
    expectEnvelope(denied, 'FORBIDDEN');

    expect(await auditCount(context, f.orgAId, 'invitation.create_denied', f.orgAId)).toBe(1);

    expect(await memberCount(context.superuserPool, f.orgAId, 'owner')).toBe('2');
    expect(await membershipCountByEmail(context.superuserPool, email)).toBe('0');
  });

  it('an admin cannot grant the owner role either: 403, audited, zero owner rows added', async () => {
    if (!context) return;
    const f = context.fixture;
    const email = `p1-7-admin-elevate-${randomUUID()}@example.com`;
    const before = await memberCount(context.superuserPool, f.orgAId, 'owner');

    const denied = await mutate(context, adminA, 'POST', '/api/v1/organizations/current/invitations', {
      email,
      role: 'owner',
    });
    expect(denied.statusCode).toBe(403);
    expectEnvelope(denied, 'FORBIDDEN');

    expect(await auditCount(context, f.orgAId, 'invitation.create_denied', f.orgAId)).toBe(2);

    expect(await memberCount(context.superuserPool, f.orgAId, 'owner')).toBe(before);
    expect(await membershipCountByEmail(context.superuserPool, email)).toBe('0');
  });

  it('positive control: an admin CAN invite a non-owner role (201) — the denials above are role-specific, not a broken route', async () => {
    if (!context) return;
    const f = context.fixture;
    const email = `p1-7-admin-ok-${randomUUID()}@example.com`;
    const created = await mutate(context, adminA, 'POST', '/api/v1/organizations/current/invitations', {
      email,
      role: 'viewer',
    });
    expect(created.statusCode).toBe(201);

    const seeded = await context.superuserPool.query<{ status: string; role: string }>(
      `SELECT m.status, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE u.email = $1 AND m.organization_id = $2`,
      [email, f.orgAId],
    );
    expect(seeded.rows).toHaveLength(1);
    expect(seeded.rows[0]).toMatchObject({ status: 'invited', role: 'viewer' });
  });
});
