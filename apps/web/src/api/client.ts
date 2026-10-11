// Live API client (P1-5). One fetch seam for every live screen: session-cookie
// credentials, synchronizer CSRF header on mutations (mirroring
// packages/auth `CSRF_HEADER_NAME` — the wire contract cannot be imported
// into the web bundle because packages/auth is node-side), shared error
// envelope parsing, and a 401 hook the session provider registers so a dead
// session clears app state and lands on the sign-in screen.
//
// Mutating calls do not parse response bodies: the D2 routes
// (POST /me/active-organization) and POST /organizations land with the
// parallel API wave, so callers treat mutations as success/failure and
// rebuild state from the schema-parsed reads (GET /me, GET
// /organizations/current) whose Zod contracts are locked in
// @resolveops/shared.
// The shared package contributes the error-envelope schema and code union;
// `ApiError` here is the client's own throwable — its name must stay distinct
// from the shared envelope type on import.
import { ApiErrorSchema, type ApiErrorCode } from '@resolveops/shared';

/** Wire header the API's CSRF guard requires on mutating calls. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Error codes the client can synthesize beyond the shared taxonomy. */
export type ClientErrorCode = ApiErrorCode | 'NETWORK' | 'CONTRACT';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly requestId?: string;

  constructor(fields: { code: ClientErrorCode; status: number; message: string; requestId?: string; cause?: unknown }) {
    super(fields.message, { cause: fields.cause });
    this.name = 'ApiError';
    this.code = fields.code;
    this.status = fields.status;
    this.requestId = fields.requestId;
  }
}

/**
 * API base URL from deployment config: `VITE_API_BASE_URL` when set
 * (Vercel preview / split hosting), same-origin relative when empty —
 * the Part A localhost and proxied-production topology.
 */
export function apiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL;
  return typeof raw === 'string' ? raw.replace(/\/+$/, '') : '';
}

// Session-scoped client state. Reset on logout and in tests.
let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function resetClientState(): void {
  csrfToken = null;
}

/** Minimal response surface the client relies on — keeps mocks honest. */
interface ApiFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type ApiRequestMethod = 'GET' | 'POST' | 'PATCH';

export interface ApiRequestOptions {
  method?: ApiRequestMethod;
  body?: unknown;
}

async function fetchCsrfToken(): Promise<string> {
  const response = await fetch(`${apiBaseUrl()}/api/v1/auth/csrf`, {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && body !== null && typeof body === 'object' && 'csrfToken' in body) {
    const token = (body as { csrfToken: unknown }).csrfToken;
    if (typeof token === 'string' && token.length > 0) {
      csrfToken = token;
      return token;
    }
  }
  if (response.status === 401) {
    unauthorizedHandler?.();
    throw new ApiError({ code: 'UNAUTHORIZED', status: 401, message: 'Your session has ended. Sign in again.' });
  }
  throw new ApiError({
    code: 'CONTRACT',
    status: response.status,
    message: 'The API returned an unreadable CSRF token response.',
  });
}

async function parseErrorEnvelope(response: ApiFetchResponse): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const envelope = body === null ? null : ApiErrorSchema.safeParse(body);
  if (envelope?.success) {
    return new ApiError({
      code: envelope.data.error.code,
      status: response.status,
      message: envelope.data.error.message,
      requestId: envelope.data.error.requestId,
    });
  }
  return new ApiError({
    code: 'CONTRACT',
    status: response.status,
    message: `The API responded with an unexpected error shape (HTTP ${response.status}).`,
  });
}

/**
 * One API call. Resolves with the parsed JSON body (unknown — endpoints
 * layer applies the shared Zod schemas), throws ApiError otherwise. Any 401
 * also notifies the registered handler so session state clears app-wide.
 */
export async function apiRequest(path: string, options: ApiRequestOptions = {}): Promise<unknown> {
  const method: ApiRequestMethod = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (method !== 'GET') {
    let token = csrfToken;
    if (!token) {
      token = await fetchCsrfToken();
    }
    headers[CSRF_HEADER_NAME] = token;
  }

  let response: ApiFetchResponse;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method,
      credentials: 'include',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause: unknown) {
    throw new ApiError({
      code: 'NETWORK',
      status: 0,
      message: 'Could not reach the ResolveOps API. Check your connection and try again.',
      cause,
    });
  }

  if (response.ok) {
    return response.json().catch(() => null);
  }

  const error = await parseErrorEnvelope(response);
  if (error.code === 'UNAUTHORIZED') {
    resetClientState();
    unauthorizedHandler?.();
  }
  throw error;
}
