import { describe, expect, it } from 'vitest';
import { CreateOrganizationRequestSchema, OrganizationSchema } from './organizations';

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
