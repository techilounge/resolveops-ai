import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { seedIsolatedOrgs, type IsolatedOrgsFixture } from '@resolveops/database/testing';
import { attachNoOpPoolErrorListeners, connectAuthTestDatabase } from './testing';
import { AuthError } from './errors';
import { loadTenantContext, requireTenantContext, withTenantContext } from './tenancy';
import { writeAuditEvent } from './audit';

describe('tenant context plumbing', () => {
  let appRolePool: Pool | undefined;
  let superuserPool: Pool | undefined;
  let fixture: IsolatedOrgsFixture | undefined;

  beforeAll(async () => {
    const setup = await connectAuthTestDatabase();
    if (!setup) {
      return;
    }
    attachNoOpPoolErrorListeners(setup.appRolePool, setup.superuserPool);
    appRolePool = setup.appRolePool;
    superuserPool = setup.superuserPool;
    fixture = await seedIsolatedOrgs(setup.superuserPool);
  });

  afterAll(async () => {
    await appRolePool?.end();
    await superuserPool?.end();
  });

  it('withTenantContext scopes reads to the acting org and commits', async () => {
    if (!appRolePool || !fixture) return;
    const visible = await withTenantContext(appRolePool, { organizationId: fixture.orgAId, userId: fixture.userAId }, (client) =>
      client.query<{ id: string }>('SELECT id FROM incidents'),
    );
    expect(visible.rows.map((row) => row.id)).toEqual([fixture.incidentAId]);

    // Writes commit with the transaction: an audit row appended inside the
    // context persists after it ends.
    await withTenantContext(appRolePool, { organizationId: fixture.orgAId, userId: fixture.userAId }, (client) =>
      writeAuditEvent(client, {
        organizationId: fixture!.orgAId,
        actorUserId: fixture!.userAId,
        action: 'test.context_write',
        targetType: 'test',
        targetId: null,
      }),
    );
    const audit = await superuserPool!.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE action = 'test.context_write' AND organization_id = $1",
      [fixture.orgAId],
    );
    expect(audit.rows[0].n).toBe('1');
  });

  it('rolls the whole transaction back when the callback throws', async () => {
    if (!appRolePool || !fixture) return;
    await expect(
      withTenantContext(appRolePool, { organizationId: fixture.orgAId, userId: fixture.userAId }, async (client) => {
        await writeAuditEvent(client, {
          organizationId: fixture!.orgAId,
          actorUserId: fixture!.userAId,
          action: 'test.doomed_write',
          targetType: 'test',
          targetId: null,
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const audit = await superuserPool!.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE action = 'test.doomed_write'",
    );
    expect(audit.rows[0].n).toBe('0');
  });

  it('loadTenantContext resolves the active role and null for non-members', async () => {
    if (!appRolePool || !fixture) return;
    const owner = await loadTenantContext(appRolePool, {
      organizationId: fixture.orgAId,
      userId: fixture.userAId,
    });
    expect(owner?.role).toBe('owner');

    // User A has only an INVITED membership in Org B — not active.
    const invited = await loadTenantContext(appRolePool, {
      organizationId: fixture.orgBId,
      userId: fixture.userAId,
    });
    expect(invited).toBeNull();

    // A guessed org id the user has no membership row for at all.
    const stranger = await loadTenantContext(appRolePool, {
      organizationId: '00000000-0000-0000-0000-0000000000ff',
      userId: fixture.userAId,
    });
    expect(stranger).toBeNull();
  });

  it('requireTenantContext throws 401 without a session user', async () => {
    if (!appRolePool || !fixture) return;
    const guard = requireTenantContext({ pool: appRolePool });
    await expect(guard({ session: {} })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('requireTenantContext throws 403 when no active org is selected', async () => {
    if (!appRolePool || !fixture) return;
    const guard = requireTenantContext({ pool: appRolePool });
    const request = { session: { userId: fixture.userAId, activeOrgId: null, membershipRole: null } };
    await expect(guard(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a non-member org selection returns 403, writes a denial audit row, and clears the stale selection', async () => {
    if (!appRolePool || !fixture) return;
    const guard = requireTenantContext({ pool: appRolePool });
    // User A selects Org B (they hold only an invited membership there).
    const request = {
      session: { userId: fixture.userAId, activeOrgId: fixture.orgBId, membershipRole: 'owner' },
      tenantContext: undefined,
    };
    await expect(guard(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const denials = await superuserPool!.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE action = 'tenant.access_denied' AND organization_id = $1 AND actor_user_id = $2",
      [fixture.orgBId, fixture.userAId],
    );
    expect(denials.rows[0].n).toBe('1');
    expect(request.session.activeOrgId).toBeNull();
    expect(request.session.membershipRole).toBeNull();
    expect(request.tenantContext).toBeUndefined();
  });

  it('a valid member gets the tenant context and their session role refreshed', async () => {
    if (!appRolePool || !fixture) return;
    const guard = requireTenantContext({ pool: appRolePool });
    const request = {
      session: {
        userId: fixture.userAId,
        activeOrgId: fixture.orgAId,
        membershipRole: 'viewer' as const, // stale role from login
      },
      tenantContext: undefined,
    };
    await guard(request);
    expect(request.tenantContext).toEqual({
      organizationId: fixture.orgAId,
      userId: fixture.userAId,
      role: 'owner',
    });
    expect(request.session.membershipRole).toBe('owner');
  });

  it('AuthError codes map through the shared taxonomy', () => {
    expect(new AuthError('UNAUTHORIZED', 'x').code).toBe('UNAUTHORIZED');
    expect(new AuthError('FORBIDDEN', 'x', { clearSessionCookie: true }).clearSessionCookie).toBe(true);
    expect(new AuthError('FORBIDDEN', 'x').clearSessionCookie).toBe(false);
  });
});
