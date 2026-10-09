import { describe, expect, it } from 'vitest';
import type { Incident } from '@resolveops/domain/types';
import {
  CreateIncidentRequestSchema,
  IncidentDtoSchema,
  IncidentListResponseSchema,
  ListIncidentsQuerySchema,
  PatchIncidentRequestSchema,
} from './incidents';

// Typed as the domain Incident to prove the DTO accepts domain values as-is.
const validIncident: Incident = {
  id: 'INC-2026-1047',
  title: 'BitLocker compliance incident',
  description: 'Synthetic lab incident for contract testing.',
  severity: 'high',
  status: 'open',
  createdAt: '2026-10-08T09:00:00.000Z',
  affectedDevices: 47,
  tags: ['bitlocker', 'windows-11'],
};

describe('IncidentDtoSchema', () => {
  it('parses a domain-shaped incident unchanged', () => {
    expect(IncidentDtoSchema.parse(validIncident)).toEqual(validIncident);
  });

  it('rejects a severity outside the domain enum', () => {
    expect(() => IncidentDtoSchema.parse({ ...validIncident, severity: 'critical' })).toThrow();
  });

  it('rejects the §6 SaaS status value — the Phase 1 adapter owns that transition', () => {
    expect(() => IncidentDtoSchema.parse({ ...validIncident, status: 'closed' })).toThrow();
  });

  it('rejects a negative device count', () => {
    expect(() => IncidentDtoSchema.parse({ ...validIncident, affectedDevices: -1 })).toThrow();
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
      CreateIncidentRequestSchema.parse({ title: 'x', description: 'y', severity: 'low', affectedDevices: 1 }),
    ).toThrow();
  });
});

describe('PatchIncidentRequestSchema', () => {
  it('parses a partial change', () => {
    expect(PatchIncidentRequestSchema.parse({ status: 'investigating' })).toEqual({ status: 'investigating' });
  });

  it('rejects an empty patch', () => {
    expect(() => PatchIncidentRequestSchema.parse({})).toThrow();
  });
});

describe('ListIncidentsQuerySchema', () => {
  it('applies pagination defaults and accepts filters', () => {
    expect(ListIncidentsQuerySchema.parse({ severity: 'high' })).toEqual({
      page: 1,
      pageSize: 25,
      severity: 'high',
    });
  });
});

describe('IncidentListResponseSchema', () => {
  it('parses a paginated envelope of incidents', () => {
    const envelope = { data: [validIncident], page: { page: 1, pageSize: 25, total: 1 } };
    expect(IncidentListResponseSchema.parse(envelope)).toEqual(envelope);
  });
});
