import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES, API_ERROR_STATUS, ApiErrorSchema, apiErrorStatus } from './errors';

describe('ApiErrorSchema', () => {
  it('parses a full error envelope', () => {
    const body = {
      error: { code: 'NOT_FOUND', message: 'No such incident.', requestId: 'req-1', details: { field: 'id' } },
    };
    expect(ApiErrorSchema.parse(body)).toEqual(body);
  });

  it('parses with optional fields absent', () => {
    expect(ApiErrorSchema.parse({ error: { code: 'CONFLICT', message: 'Duplicate.' } }).error.code).toBe('CONFLICT');
  });

  it('rejects an unknown error code', () => {
    expect(() => ApiErrorSchema.parse({ error: { code: 'TEAPOT', message: 'x' } })).toThrow();
  });

  it('rejects an empty message', () => {
    expect(() => ApiErrorSchema.parse({ error: { code: 'CONFLICT', message: '' } })).toThrow();
  });

  it('maps the taxonomy onto the Blueprint status set exactly (400/401/403/404/409/429/5xx)', () => {
    expect(Object.keys(API_ERROR_STATUS)).toEqual([...API_ERROR_CODES]);
    expect(API_ERROR_CODES.map(apiErrorStatus)).toEqual([400, 401, 403, 404, 409, 429, 500]);
  });
});
