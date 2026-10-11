import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  createTestContext,
  destroyTestContext,
  expectEnvelope,
  mutate,
  read,
  unsignedSid,
  type TestContext,
  type TestSession,
} from './testing/support';
import { CSRF_SECRET } from './testing/constants';
import { csrfTokenFor } from '@resolveops/auth';

/**
 * Phase 1 spec §4.3 team surface over HTTP (delta D2): the org roster
 * (members list inside the org's RLS context) and invitations (owner/admin
 * only, pending-identity user rows, duplicate 409, every denial audited)
 * plus the first-login email→subject binding: a real sign-in with the
 * invited email rebinds the pending membership to the real user row inside
 * the target org's tenant context, and the freshly-bound user still cannot
 * select the org until the membership is activated.
 */

describe('members and invitations (HTTP)', () => {
  let context: TestContext | undefined;
  let owner: TestSession | undefined;
  let admin: TestSession | undefined;
  let analyst: TestSession | undefined;

  const ORG_A = () => context!.fixture.orgAId;

  beforeAll(async () => {
    context = await createTestContext();
    if (!context) return;
    owner = await context.member({ role: 'owner' });
    admin = await context.member({ role: 'admin' });
    analyst = await context.member({ role: 'analyst' });
    for (const session of [owner, admin, analyst]) {
      await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
        organizationId: context.fixture.orgAId,
      });
    }
  });

  afterAll(async () => {
    if (context) await destroyTestContext(context);
  });

  it('no-ops cleanly when no local Postgres is configured', () => {
    if (!context) return;
    expect(true).toBe(true);
  });

  describe('GET /api/v1/organizations/current/members', () => {
    it('lists the org roster for an admin with roles and statuses', async () => {
      if (!context || !admin) return;
      const response = await read(context, admin, '/api/v1/organizations/current/members');
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        data: Array<{ userId: string; role: string; status: string; email: string }>;
        page: { page: number; total: number };
      };
      const ids = body.data.map((row) => row.userId);
      expect(ids).toContain(admin.userId);
      // The roster never contains foreign-org identifiers.
      expect(JSON.stringify(body)).not.toContain(context!.fixture.orgBId);
      for (const row of body.data) {
        expect(['owner', 'admin', 'analyst', 'technician', 'viewer']).toContain(row.role);
        expect(['active', 'invited', 'revoked']).toContain(row.status);
      }
    });

    it('denies non-admin roles with an audited 403 and zero data echo', async () => {
      if (!context || !analyst) return;
      const response = await read(context, analyst, '/api/v1/organizations/current/members');
      expectEnvelope(response, 'FORBIDDEN');
      expect(response.statusCode).toBe(403);
      expect(await auditCount(context, ORG_A(), 'members.read_denied')).toBe(1);
      expect(response.body).not.toContain(analyst.email);
    });

    it('requires a session', async () => {
      if (!context) return;
      const response = await read(context, undefined, '/api/v1/organizations/current/members');
      expectEnvelope(response, 'UNAUTHORIZED');
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/organizations/current/invitations (delta D2)', () => {
    it('creates an invited membership plus a pending-identity user, audited', async () => {
      if (!context || !owner) return;
      const email = `invitee-${randomUUID()}@example.com`;
      const response = await mutate(
        context,
        owner,
        'POST',
        '/api/v1/organizations/current/invitations',
        { email, role: 'analyst' },
      );
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body) as { userId: string; role: string; status: string };
      expect(body.status).toBe('invited');
      expect(body.role).toBe('analyst');

      // The pending user row exists, keyed by the pending issuer + email.
      const pending = await context.superuserPool.query<{ id: string; entra_issuer: string }>(
        'SELECT id, entra_issuer FROM users WHERE email = $1',
        [email],
      );
      expect(pending.rows).toHaveLength(1);
      expect(pending.rows[0].entra_issuer).toBe('invite:pending');

      // The invited membership points at the pending row.
      const membership = await context.superuserPool.query<{ status: string; role: string }>(
        'SELECT status, role FROM memberships WHERE user_id = $1 AND organization_id = $2',
        [pending.rows[0].id, ORG_A()],
      );
      expect(membership.rows).toHaveLength(1);
      expect(membership.rows[0].status).toBe('invited');
      expect(await auditCount(context, ORG_A(), 'invitation.created')).toBe(1);
    });

    it('409s on a duplicate membership for the same email', async () => {
      if (!context || !owner) return;
      const email = `dup-${randomUUID()}@example.com`;
      const first = await mutate(
        context,
        owner,
        'POST',
        '/api/v1/organizations/current/invitations',
        { email, role: 'viewer' },
      );
      expect(first.statusCode).toBe(201);
      const second = await mutate(
        context,
        owner,
        'POST',
        '/api/v1/organizations/current/invitations',
        { email, role: 'viewer' },
      );
      expectEnvelope(second, 'CONFLICT');
      expect(second.statusCode).toBe(409);
    });

    it('denies a non-admin inviter with an audited 403', async () => {
      if (!context || !analyst) return;
      const response = await mutate(
        context,
        analyst,
        'POST',
        '/api/v1/organizations/current/invitations',
        { email: `blocked-${randomUUID()}@example.com`, role: 'analyst' },
      );
      expectEnvelope(response, 'FORBIDDEN');
      expect(response.statusCode).toBe(403);
      expect(await auditCount(context, ORG_A(), 'invitation.create_denied')).toBe(1);
    });

    it('rejects invalid roles and emails with the validation envelope', async () => {
      if (!context || !owner) return;
      const badRole = await mutate(
        context,
        owner,
        'POST',
        '/api/v1/organizations/current/invitations',
        { email: `x-${randomUUID()}@example.com`, role: 'supreme-leader' },
      );
      expect(badRole.statusCode).toBe(400);
      expectEnvelope(badRole, 'BAD_REQUEST');

      const badEmail = await mutate(
        context,
        owner,
        'POST',
        '/api/v1/organizations/current/invitations',
        { email: 'not-an-email', role: 'viewer' },
      );
      expect(badEmail.statusCode).toBe(400);
      expectEnvelope(badEmail, 'BAD_REQUEST');
    });

    it('rebinds the invited email to the real subject at first login, audited', async () => {
      if (!context || !admin) return;
      const email = `bind-${randomUUID()}@example.com`;
      const invited = await mutate(
        context,
        admin,
        'POST',
        '/api/v1/organizations/current/invitations',
        { email, role: 'technician' },
      );
      expect(invited.statusCode).toBe(201);
      const invitedUserId = (JSON.parse(invited.body) as { userId: string }).userId;

      // First login with the invited email under a brand-new Entra subject —
      // using the app's own stub adapter (PKCE codes live in its memory).
      const subject = `real-${randomUUID()}`;
      const { cookie } = await context.login(subject, email, 'Bound User');
      const session: TestSession = {
        cookie,
        csrfToken: csrfTokenFor(unsignedSid(cookie), CSRF_SECRET),
        userId: '',
        subject,
        email,
      };

      // /me binds the pending membership to this user and lists it as invited.
      const me = await read(context, session, '/api/v1/me');
      expect(me.statusCode).toBe(200);
      const meBody = JSON.parse(me.body) as {
        user: { id: string };
        memberships: Array<{ organizationId: string; status: string; role: string }>;
      };
      expect(
        meBody.memberships.some((m) => m.organizationId === ORG_A() && m.status === 'invited'),
      ).toBe(true);

      // The pending identity is consumed: every membership moved to the
      // real user. The sentinel user row itself remains — the app role is
      // deliberately not granted users DELETE (least privilege, migration
      // 006) — and is reused if the same email is ever invited again.
      const pending = await context.superuserPool.query<{ id: string }>(
        'SELECT id FROM memberships WHERE user_id = $1',
        [invitedUserId],
      );
      expect(pending.rows).toHaveLength(0);
      const rebound = await context.superuserPool.query<{ organization_id: string }>(
        'SELECT organization_id FROM memberships WHERE user_id = $1',
        [meBody.user.id],
      );
      expect(rebound.rows.some((row) => row.organization_id === ORG_A())).toBe(true);
      expect(await auditCount(context, ORG_A(), 'membership.invite_accepted')).toBe(1);

      // The freshly-bound user still cannot select the org (membership is
      // invited, not active) — invite escalation stays closed end to end.
      const switchResponse = await mutate(
        context,
        session,
        'POST',
        '/api/v1/me/active-organization',
        { organizationId: ORG_A() },
      );
      expectEnvelope(switchResponse, 'FORBIDDEN');
      expect(switchResponse.statusCode).toBe(403);
    });
  });
});
