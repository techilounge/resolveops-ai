import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from './health';

const valid = {
  status: 'ok',
  service: 'resolveops-api',
  version: '0.1.0',
  timestamp: '2026-10-09T12:00:00.000Z',
} as const;

describe('HealthResponseSchema', () => {
  it('parses a valid health payload', () => {
    expect(HealthResponseSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a status other than the ok literal', () => {
    expect(() => HealthResponseSchema.parse({ ...valid, status: 'degraded' })).toThrow();
  });

  it('rejects a non-ISO timestamp', () => {
    expect(() => HealthResponseSchema.parse({ ...valid, timestamp: 'not-a-date' })).toThrow();
  });

  it('rejects a missing field', () => {
    const { version: _omitted, ...incomplete } = valid;
    expect(() => HealthResponseSchema.parse(incomplete)).toThrow();
  });
});
