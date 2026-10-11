// API client behaviors (P1-5): envelope parsing, 401 hook, CSRF token
// lifecycle on mutations, and base-URL composition from deployment config.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiBaseUrl,
  apiRequest,
  CSRF_HEADER_NAME,
  resetClientState,
  setUnauthorizedHandler,
} from './client';
import { errorEnvelope, installFetchStub, type FetchHandler } from '../testing/fetchStub';

describe('apiRequest', () => {
  beforeEach(() => {
    resetClientState();
    setUnauthorizedHandler(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetClientState();
    setUnauthorizedHandler(null);
  });

  it('resolves with the parsed body on 200', async () => {
    const stub = installFetchStub(() => ({ status: 200, body: { ok: true } }));
    await expect(apiRequest('/api/v1/example')).resolves.toEqual({ ok: true });
    stub.restore();
  });

  it('throws ApiError with the shared envelope code and message on 403', async () => {
    const stub = installFetchStub(() => ({
      status: 403,
      body: errorEnvelope('FORBIDDEN', 'You do not have access.', 'req-1'),
    }));
    const error = await apiRequest('/api/v1/example').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('FORBIDDEN');
    expect((error as ApiError).message).toBe('You do not have access.');
    expect((error as ApiError).requestId).toBe('req-1');
    expect((error as ApiError).status).toBe(403);
    stub.restore();
  });

  it('synthesizes CONTRACT for an unreadable error envelope', async () => {
    const stub = installFetchStub(() => ({ status: 500, body: { completely: 'wrong' } }));
    const error = await apiRequest('/api/v1/example').catch((caught: unknown) => caught);
    expect((error as ApiError).code).toBe('CONTRACT');
    stub.restore();
  });

  it('synthesizes NETWORK when fetch itself throws', async () => {
    const stub = installFetchStub(() => undefined);
    stub.restore();
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('network down')) as unknown as typeof fetch;
    try {
      const error = await apiRequest('/api/v1/example').catch((caught: unknown) => caught);
      expect((error as ApiError).code).toBe('NETWORK');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('notifies the handler and throws UNAUTHORIZED on a 401', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const stub = installFetchStub(() => ({
      status: 401,
      body: errorEnvelope('UNAUTHORIZED', 'Session expired.'),
    }));

    const error = await apiRequest('/api/v1/me').catch((caught: unknown) => caught);
    expect((error as ApiError).code).toBe('UNAUTHORIZED');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    stub.restore();
  });

  it('sends no CSRF header on GET', async () => {
    const stub = installFetchStub((request) =>
      request.method === 'GET' && request.url.endsWith('/api/v1/me') ? { status: 200, body: {} } : undefined,
    );
    await apiRequest('/api/v1/me');
    expect(stub.requests[0]?.headers[CSRF_HEADER_NAME]).toBeUndefined();
    stub.restore();
  });

  it('fetches the CSRF token once and reuses it across mutations', async () => {
    const handler: FetchHandler = (request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/auth/csrf')) {
        return { status: 200, body: { csrfToken: 'token-1' } };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/things')) {
        return { status: 200, body: null };
      }
      return undefined;
    };
    const stub = installFetchStub(handler);

    await apiRequest('/api/v1/things', { method: 'POST', body: { a: 1 } });
    await apiRequest('/api/v1/things', { method: 'POST', body: { b: 2 } });

    const csrfFetches = stub.requests.filter((request) => request.url.endsWith('/api/v1/auth/csrf'));
    expect(csrfFetches).toHaveLength(1);
    const posts = stub.requests.filter((request) => request.url.endsWith('/api/v1/things'));
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.headers[CSRF_HEADER_NAME]).toBe('token-1');
      expect(post.headers['content-type']).toBe('application/json');
    }
    stub.restore();
  });

  it('maps a 401 during the CSRF fetch to UNAUTHORIZED and notifies the handler', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const stub = installFetchStub((request) =>
      request.url.endsWith('/api/v1/auth/csrf')
        ? { status: 401, body: errorEnvelope('UNAUTHORIZED', 'Session expired.') }
        : undefined,
    );

    const error = await apiRequest('/api/v1/things', { method: 'POST', body: {} }).catch((caught: unknown) => caught);
    expect((error as ApiError).code).toBe('UNAUTHORIZED');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    stub.restore();
  });

  it('clears the cached CSRF token through resetClientState', async () => {
    const handler: FetchHandler = (request) => {
      if (request.url.endsWith('/api/v1/auth/csrf')) {
        return { status: 200, body: { csrfToken: 'token-2' } };
      }
      return { status: 200, body: null };
    };
    const stub = installFetchStub(handler);

    await apiRequest('/api/v1/things', { method: 'POST', body: {} });
    resetClientState();
    await apiRequest('/api/v1/things', { method: 'POST', body: {} });

    const csrfFetches = stub.requests.filter((request) => request.url.endsWith('/api/v1/auth/csrf'));
    expect(csrfFetches).toHaveLength(2);
    stub.restore();
  });
});

describe('apiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is same-origin relative when no base URL is configured', () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(apiBaseUrl()).toBe('');
  });

  it('returns the configured base URL without a trailing slash', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/');
    expect(apiBaseUrl()).toBe('https://api.example.com');
  });
});
