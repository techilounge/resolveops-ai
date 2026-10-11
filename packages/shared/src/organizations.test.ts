import { describe, expect, it } from 'vitest';
import {
  CreateInvitationRequestSchema,
  CreateOrganizationRequestSchema,
  MemberListResponseSchema,
  MemberSchema,
  OrganizationSchema,
} from './organizations';

const validOrg = {
  id: '9e2f4b5a-3f21-4e0e-8c1d-6a2b7f0d3c01',
  name: 'Acme IT',
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
} as const;

describe('OrganizationSchema', () => {
  it('parses a valid organization', () => {
    expect(OrganizationSchema.parse(validOrg)).toEqual(validOrg);
  });

  it('rejects an empty or oversized name', () => {
    expect(() => OrganizationSchema.parse({ ...validOrg, name: '' })).toThrow();
    expect(() => OrganizationSchema.parse({ ...validOrg, name: 'x'.repeat(201) })).toThrow();
  });
});

describe('CreateOrganizationRequestSchema', () => {
  it('parses a create request', () => {
    expect(CreateOrganizationRequestSchema.parse({ name: 'Acme IT' })).toEqual({ name: 'Acme IT' });
  });

  it('rejects unknown keys (strict request bodies)', () => {
    expect(() => CreateOrganizationRequestSchema.parse({ name: 'Acme IT', plan: 'enterprise' })).toThrow();
  });
});

const validMember = {
  userId: '0b9c4619-9ec6-4a11-9a31-2f3f2c17b8a2',
  email: 'taylor@example.com',
  displayName: 'Taylor Analyst',
  role: 'analyst',
  status: 'active',
  createdAt: '2026-10-09T10:00:00.000Z',
} as const;

describe('MemberSchema', () => {
  it('parses an active member', () => {
    expect(MemberSchema.parse(validMember)).toEqual(validMember);
  });

  it('parses a pending invite and rejects unknown keys', () => {
    expect(MemberSchema.parse({ ...validMember, status: 'invited' })).toEqual({
      ...validMember,
      status: 'invited',
    });
    expect(() => MemberSchema.parse({ ...validMember, organizationId: 'x' })).toThrow();
  });
});

describe('MemberListResponseSchema', () => {
  it('parses a paginated roster', () => {
    const envelope = { data: [validMember], page: { page: 1, pageSize: 25, total: 1 } };
    expect(MemberListResponseSchema.parse(envelope)).toEqual(envelope);
  });
});

describe('CreateInvitationRequestSchema', () => {
  it('defaults the role to analyst', () => {
    expect(CreateInvitationRequestSchema.parse({ email: 'new@example.com' })).toEqual({
      email: 'new@example.com',
      role: 'analyst',
    });
  });

  it('rejects unknown keys and malformed emails', () => {
    expect(() => CreateInvitationRequestSchema.parse({ email: 'x@example.com', status: 'active' })).toThrow();
    expect(() => CreateInvitationRequestSchema.parse({ email: 'not-an-email' })).toThrow();
  });
});
