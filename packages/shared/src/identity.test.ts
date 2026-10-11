import { describe, expect, it } from 'vitest';
import { ActiveOrganizationResponseSchema, MeResponseSchema, SwitchOrganizationRequestSchema } from './identity';

const validMe = {
  user: {
    id: '0b9c4619-9ec6-4a11-9a31-2f3f2c17b8a2',
    displayName: 'Taylor Analyst',
    email: 'taylor@example.com',
  },
  memberships: [
    {
      organizationId: '3f6d3c58-0f4c-4d64-9d5f-6f3ff9cf6b21',
      organizationName: 'Acme IT',
      role: 'analyst',
      status: 'active',
    },
  ],
} as const;

describe('MeResponseSchema', () => {
  it('parses an authenticated profile with memberships', () => {
    expect(MeResponseSchema.parse(validMe)).toEqual(validMe);
  });

  it('carries the active/invited distinction and a nullable org name', () => {
    const withInvite = {
      ...validMe,
      memberships: [
        ...validMe.memberships,
        {
          organizationId: '9e2f4b5a-3f21-4e0e-8c1d-6a2b7f0d3c01',
          organizationName: null,
          role: 'viewer',
          status: 'invited',
        },
      ],
    };
    expect(MeResponseSchema.parse(withInvite)).toEqual(withInvite);
  });

  it('rejects a malformed email', () => {
    expect(() =>
      MeResponseSchema.parse({ ...validMe, user: { ...validMe.user, email: 'not-an-email' } }),
    ).toThrow();
  });

  it('rejects an unknown membership role', () => {
    expect(() =>
      MeResponseSchema.parse({
        ...validMe,
        memberships: [{ ...validMe.memberships[0], role: 'superuser' }],
      }),
    ).toThrow();
  });

  it('rejects an unknown membership status', () => {
    expect(() =>
      MeResponseSchema.parse({
        ...validMe,
        memberships: [{ ...validMe.memberships[0], status: 'pending' }],
      }),
    ).toThrow();
  });
});

describe('SwitchOrganizationRequestSchema', () => {
  it('parses an organization selection and rejects extra keys', () => {
    expect(SwitchOrganizationRequestSchema.parse({ organizationId: validMe.user.id })).toEqual({
      organizationId: validMe.user.id,
    });
    expect(() =>
      SwitchOrganizationRequestSchema.parse({ organizationId: validMe.user.id, role: 'owner' }),
    ).toThrow();
  });
});

describe('ActiveOrganizationResponseSchema', () => {
  it('parses the refreshed context', () => {
    expect(
      ActiveOrganizationResponseSchema.parse({ organizationId: validMe.user.id, role: 'viewer' }),
    ).toEqual({ organizationId: validMe.user.id, role: 'viewer' });
  });
});
