import { describe, expect, it } from 'vitest';
import { AuditEventListResponseSchema, AuditEventSchema, ListAuditEventsQuerySchema } from './audit';

const validEvent = {
  id: '7a2f4b5a-3f21-4e0e-8c1d-6a2b7f0d3c55',
  actorUserId: '0b9c4619-9ec6-4a11-9a31-2f3f2c17b8a2',
  action: 'incident.assigned',
  targetType: 'incident',
  targetId: '5e2f4b5a-3f21-4e0e-8c1d-6a2b7f0d3c99',
  metadata: { assigneeUserId: '0b9c4619-9ec6-4a11-9a31-2f3f2c17b8a2' },
  occurredAt: '2026-10-11T09:00:00.000Z',
} as const;

describe('AuditEventSchema', () => {
  it('parses an audit row', () => {
    expect(AuditEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it('allows a system actor (null actorUserId) and null targetId', () => {
    const system = { ...validEvent, actorUserId: null, targetId: null };
    expect(AuditEventSchema.parse(system)).toEqual(system);
  });

  it('rejects unknown keys', () => {
    expect(() => AuditEventSchema.parse({ ...validEvent, organizationId: 'x' })).toThrow();
  });
});

describe('ListAuditEventsQuerySchema', () => {
  it('applies pagination defaults and rejects unknown keys', () => {
    expect(ListAuditEventsQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(() => ListAuditEventsQuerySchema.parse({ action: 'incident.assigned' })).toThrow();
  });
});

describe('AuditEventListResponseSchema', () => {
  it('parses a paginated envelope of audit rows', () => {
    const envelope = { data: [validEvent], page: { page: 1, pageSize: 25, total: 1 } };
    expect(AuditEventListResponseSchema.parse(envelope)).toEqual(envelope);
  });
});
