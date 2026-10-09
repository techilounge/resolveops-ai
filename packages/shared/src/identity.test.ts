import { describe, expect, it } from 'vitest';
import { MeResponseSchema } from './identity';

const validMe = {
  user: {
    id: '0b9c4619-9ec6-4a11-9a31-2f3f2c17b8a2',
    displayName: 'Taylor Analyst',
    email: 'taylor@example.com',
  },
  memberships: [
    { organizationId: '3f6d3c58-0f4c-4d64-9d5f-6f3ff9cf6b21', role: 'analyst' },
  ],
} as const;

describe('MeResponseSchema', () => {
  it('parses an authenticated profile with memberships', () => {
    expect(MeResponseSchema.parse(validMe)).toEqual(validMe);
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
        memberships: [{ organizationId: validMe.memberships[0].organizationId, role: 'superuser' }],
      }),
    ).toThrow();
  });
});
