// Typed endpoint functions (P1-5): reads parse with the locked shared Zod
// contracts; mutations keep opaque envelopes and stable wire shapes.
import { describe, expect, it } from 'vitest';
import {
  API_PATHS,
  createOrganization,
  getCurrentOrganization,
  getMe,
  logout,
  switchActiveOrganization,
} from './endpoints';
import { TEST_IDS, installFetchStub } from '../testing/fetchStub';

const { user: USER_ID, orgA: ORG_A_ID } = TEST_IDS;

function meBody(memberships: { organizationId: string; role: string }[]): unknown {
  return {
    user: { id: USER_ID, displayName: 'Avery Analyst', email: 'avery@example.com' },
    memberships,
  };
}

function orgBody(id: string, name: string): unknown {
  return { id, name, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' };
}

describe('getMe', () => {
  it('parses a valid /me payload into the shared contract', async () => {
    const stub = installFetchStub((request) =>
      request.method === 'GET' && request.url.endsWith(API_PATHS.me)
        ? { status: 200, body: meBody([{ organizationId: ORG_A_ID, role: 'owner' }]) }
        : undefined,
    );
    const me = await getMe();
    expect(me.user.email).toBe('avery@example.com');
    expect(me.memberships).toEqual([{ organizationId: ORG_A_ID, role: 'owner' }]);
    stub.restore();
  });

  it('rejects a payload that violates the shared contract', async () => {
    const stub = installFetchStub((request) =>
      request.method === 'GET' && request.url.endsWith(API_PATHS.me)
        ? { status: 200, body: { user: { id: 'not-a-uuid' }, memberships: [] } }
        : undefined,
    );
    await expect(getMe()).rejects.toThrow();
    stub.restore();
  });
});

describe('getCurrentOrganization', () => {
  it('parses the organization DTO', async () => {
    const stub = installFetchStub((request) =>
      request.method === 'GET' && request.url.endsWith(API_PATHS.organizationsCurrent)
        ? { status: 200, body: orgBody(ORG_A_ID, 'City of Austin IT') }
        : undefined,
    );
    const org = await getCurrentOrganization();
    expect(org).toEqual({
      id: ORG_A_ID,
      name: 'City of Austin IT',
      createdAt: '2026-10-11T00:00:00.000Z',
      updatedAt: '2026-10-11T00:00:00.000Z',
    });
    stub.restore();
  });
});

describe('createOrganization', () => {
  it('POSTs { name } and returns the created organization', async () => {
    const stub = installFetchStub((request) =>
      request.method === 'POST' && request.url.endsWith(API_PATHS.organizationsCreate)
        ? { status: 201, body: orgBody(ORG_A_ID, 'New Org') }
        : undefined,
    );
    const org = await createOrganization('New Org');
    expect(org?.id).toBe(ORG_A_ID);
    const post = stub.requests.find((request) => request.method === 'POST');
    expect(post?.body).toEqual({ name: 'New Org' });
    stub.restore();
  });

  it('returns null when the response does not match the Organization DTO', async () => {
    const stub = installFetchStub((request) =>
      request.method === 'POST' && request.url.endsWith(API_PATHS.organizationsCreate)
        ? { status: 201, body: { unexpected: 'shape' } }
        : undefined,
    );
    await expect(createOrganization('New Org')).resolves.toBeNull();
    stub.restore();
  });
});

describe('switchActiveOrganization', () => {
  it('POSTs { organizationId } to the D2 route', async () => {
    const stub = installFetchStub((request) =>
      request.method === 'POST' && request.url.endsWith(API_PATHS.activeOrganization)
        ? { status: 204, body: null }
        : undefined,
    );
    await switchActiveOrganization(ORG_A_ID);
    const post = stub.requests.find((request) => request.method === 'POST');
    expect(post?.url.endsWith('/api/v1/me/active-organization')).toBe(true);
    expect(post?.body).toEqual({ organizationId: ORG_A_ID });
    stub.restore();
  });
});

describe('logout', () => {
  it('POSTs the logout route', async () => {
    const stub = installFetchStub((request) =>
      request.method === 'POST' && request.url.endsWith(API_PATHS.logout) ? { status: 204, body: null } : undefined,
    );
    await logout();
    expect(stub.requests.some((request) => request.url.endsWith('/api/v1/auth/logout'))).toBe(true);
    stub.restore();
  });
});
