import { describe, expect, it } from 'vitest';
import { ListQuerySchema, PaginatedResponseSchema } from './pagination';
import { IncidentDtoSchema, type IncidentDto } from './incidents';

const validIncident: IncidentDto = {
  id: 'INC-2026-1047',
  title: 'BitLocker compliance incident',
  description: 'Synthetic lab incident for contract testing.',
  severity: 'high',
  status: 'open',
  createdAt: '2026-10-08T09:00:00.000Z',
  affectedDevices: 47,
  tags: ['bitlocker', 'windows-11'],
};

describe('ListQuerySchema', () => {
  it('defaults page and pageSize', () => {
    expect(ListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
  });

  it('coerces numeric strings from the query edge', () => {
    expect(ListQuerySchema.parse({ page: '2', pageSize: '10' })).toEqual({ page: 2, pageSize: 10 });
  });

  it('rejects out-of-range or fractional values', () => {
    expect(() => ListQuerySchema.parse({ pageSize: 101 })).toThrow();
    expect(() => ListQuerySchema.parse({ page: 0 })).toThrow();
    expect(() => ListQuerySchema.parse({ pageSize: 2.5 })).toThrow();
  });
});

describe('PaginatedResponseSchema', () => {
  it('parses an incident list envelope', () => {
    const envelope = { data: [validIncident], page: { page: 1, pageSize: 25, total: 1 } };
    expect(PaginatedResponseSchema(IncidentDtoSchema).parse(envelope)).toEqual(envelope);
  });

  it('rejects a negative total or non-integer page', () => {
    const envelope = (page: Record<string, unknown>) => ({ data: [], page });
    expect(() =>
      PaginatedResponseSchema(IncidentDtoSchema).parse(envelope({ page: 1, pageSize: 25, total: -1 })),
    ).toThrow();
    expect(() =>
      PaginatedResponseSchema(IncidentDtoSchema).parse(envelope({ page: 1.5, pageSize: 25, total: 0 })),
    ).toThrow();
  });
});
