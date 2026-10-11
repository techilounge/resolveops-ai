import { describe, expect, it } from 'vitest';
import {
  CreateIncidentRequestSchema,
  IncidentDtoSchema,
  IncidentListResponseSchema,
  ListIncidentsQuerySchema,
  PatchIncidentRequestSchema,
} from './incidents';

const validIncident = {
  id: '0b9c4619-9ec6-4a11-9a31-2f3f2c17b8a2',
  title: 'BitLocker compliance incident',
  description: 'Synthetic lab incident for contract testing.',
  severity: 'high',
  status: 'investigating',
  assigneeUserId: null,
  createdBy: '5e2f4b5a-3f21-4e0e-8c1d-6a2b7f0d3c99',
  version: 1,
  createdAt: '2026-10-08T09:00:00.000Z',
  updatedAt: '2026-10-08T09:00:00.000Z',
} as const;

describe('IncidentDtoSchema', () => {
  it('parses a persisted-row-shaped incident (Phase 1 spec §4.1)', () => {
    expect(IncidentDtoSchema.parse(validIncident)).toEqual(validIncident);
  });

  it('parses an assigned incident and a critical-tracked severity set', () => {
    const assigned = {
      ...validIncident,
      assigneeUserId: '5e2f4b5a-3f21-4e0e-8c1d-6a2b7f0d3c99',
      status: 'awaiting_review',
      version: 3,
    };
    expect(IncidentDtoSchema.parse(assigned)).toEqual(assigned);
  });

  it('rejects the Phase 0 demo status — the §6 database enum is the source of truth', () => {
    expect(() => IncidentDtoSchema.parse({ ...validIncident, status: 'open' })).toThrow();
  });

  it('rejects an unknown §6 status', () => {
    expect(() => IncidentDtoSchema.parse({ ...validIncident, status: 'closed_done' })).toThrow();
  });

  it('rejects a severity outside the database CHECK set', () => {
    expect(() => IncidentDtoSchema.parse({ ...validIncident, severity: 'critical' })).toThrow();
  });

  it('rejects unknown keys — no demo-only affectedDevices/tags on the SaaS DTO', () => {
    expect(() => IncidentDtoSchema.parse({ ...validIncident, affectedDevices: 47 })).toThrow();
    expect(() => IncidentDtoSchema.parse({ ...validIncident, tags: [] })).toThrow();
  });

  it('rejects a version below 1', () => {
    expect(() => IncidentDtoSchema.parse({ ...validIncident, version: 0 })).toThrow();
  });
});

describe('CreateIncidentRequestSchema', () => {
  it('parses a create request', () => {
    expect(
      CreateIncidentRequestSchema.parse({ title: 'New incident', description: 'Details.', severity: 'low' }),
    ).toEqual({ title: 'New incident', description: 'Details.', severity: 'low' });
  });

  it('rejects unknown keys (strict request bodies)', () => {
    expect(() =>
      CreateIncidentRequestSchema.parse({ title: 'x', description: 'y', severity: 'low', status: 'new' }),
    ).toThrow();
  });
});

describe('PatchIncidentRequestSchema', () => {
  it('parses a partial change with its expected version', () => {
    expect(PatchIncidentRequestSchema.parse({ status: 'investigating', expectedVersion: 2 })).toEqual({
      status: 'investigating',
      expectedVersion: 2,
    });
  });

  it('accepts an unassign (assigneeUserId null)', () => {
    expect(PatchIncidentRequestSchema.parse({ assigneeUserId: null, expectedVersion: 1 })).toEqual({
      assigneeUserId: null,
      expectedVersion: 1,
    });
  });

  it('rejects a patch without expectedVersion — concurrency is not optional', () => {
    expect(() => PatchIncidentRequestSchema.parse({ status: 'triaged' })).toThrow();
  });

  it('rejects an empty patch and a version-only patch', () => {
    expect(() => PatchIncidentRequestSchema.parse({})).toThrow();
    expect(() => PatchIncidentRequestSchema.parse({ expectedVersion: 1 })).toThrow();
  });
});

describe('ListIncidentsQuerySchema', () => {
  it('applies pagination defaults and accepts filters', () => {
    expect(
      ListIncidentsQuerySchema.parse({
        severity: 'high',
        status: 'new',
        assignee: 'unassigned',
        q: 'bitlocker',
      }),
    ).toEqual({
      page: 1,
      pageSize: 25,
      severity: 'high',
      status: 'new',
      assignee: 'unassigned',
      q: 'bitlocker',
    });
  });

  it('rejects an unknown filter key', () => {
    expect(() => ListIncidentsQuerySchema.parse({ org: '3f6d3c58-0f4c-4d64-9d5f-6f3ff9cf6b21' })).toThrow();
  });
});

describe('IncidentListResponseSchema', () => {
  it('parses a paginated envelope of incidents', () => {
    const envelope = { data: [validIncident], page: { page: 1, pageSize: 25, total: 1 } };
    expect(IncidentListResponseSchema.parse(envelope)).toEqual(envelope);
  });
});
