import { describe, expect, it } from 'vitest';
import { TENANT_ROLES, TenantRoleSchema, type TenantContext } from './tenancy';

describe('TenantRoleSchema', () => {
  it('accepts every Blueprint §7 role', () => {
    for (const role of TENANT_ROLES) expect(TenantRoleSchema.parse(role)).toBe(role);
  });

  it('rejects privileges disguised as roles (approver, executor)', () => {
    expect(() => TenantRoleSchema.parse('approver')).toThrow();
    expect(() => TenantRoleSchema.parse('executor')).toThrow();
  });
});

describe('TenantContext', () => {
  it('carries exactly the server-verified triple (organization, user, role)', () => {
    const context: TenantContext = { organizationId: 'org-1', userId: 'user-1', role: 'admin' };
    expect(Object.keys(context).sort()).toEqual(['organizationId', 'role', 'userId']);
  });
});
