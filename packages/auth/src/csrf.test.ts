import { describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME, csrfTokenFor, isCsrfTokenValid } from './csrf';

const SECRET = 'csrf-secret-for-unit-tests-0123456789abcdef';

describe('synchronizer CSRF tokens', () => {
  it('derives a stable token per session id', () => {
    expect(csrfTokenFor('sid-1', SECRET)).toBe(csrfTokenFor('sid-1', SECRET));
  });

  it('binds tokens to the session id (token for sid-1 fails for sid-2)', () => {
    const token = csrfTokenFor('sid-1', SECRET);
    expect(isCsrfTokenValid('sid-1', SECRET, token)).toBe(true);
    expect(isCsrfTokenValid('sid-2', SECRET, token)).toBe(false);
  });

  it('rejects tokens derived from a different secret', () => {
    const token = csrfTokenFor('sid-1', SECRET);
    expect(isCsrfTokenValid('sid-1', 'another-secret-0123456789abcdef', token)).toBe(false);
  });

  it('rejects tampered and garbage tokens', () => {
    const token = csrfTokenFor('sid-1', SECRET);
    expect(isCsrfTokenValid('sid-1', SECRET, `${token}x`)).toBe(false);
    expect(isCsrfTokenValid('sid-1', SECRET, `${token.slice(0, -1)}`)).toBe(false);
    expect(isCsrfTokenValid('sid-1', SECRET, '')).toBe(false);
    expect(isCsrfTokenValid('sid-1', SECRET, 'not-a-token')).toBe(false);
  });

  it('exposes the required header name', () => {
    expect(CSRF_HEADER_NAME).toBe('x-csrf-token');
  });
});
