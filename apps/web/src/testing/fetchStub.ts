// Test helper: a minimal global-fetch stub for the client/endpoints/provider
// suites. Handlers are matched by inspecting the recorded request; an
// unmatched request fails the test loudly instead of hanging or returning
// garbage. Deliberately in src/ (not a hidden folder) so the tsconfig/eslint
// gates see exactly what the suite sees.
import type {
  MeResponse,
  Membership,
  Organization,
  OrganizationCreatedResponse,
} from '@resolveops/shared';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubbedResponse {
  status?: number;
  body?: unknown;
}

export type FetchHandler = (request: RecordedRequest) => StubbedResponse | undefined;

export interface FetchStub {
  requests: RecordedRequest[];
  restore: () => void;
}

export function installFetchStub(handler: FetchHandler): FetchStub {
  const requests: RecordedRequest[] = [];

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.toString() : String(input);
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const recorded: RecordedRequest = {
      url,
      method,
      headers,
      body: rawBody === null ? undefined : JSON.parse(rawBody),
    };
    requests.push(recorded);

    let result = handler(recorded);
    if (result === undefined) {
      // The client performs a CSRF handshake before every first mutation
      // (GET /api/v1/auth/csrf → { csrfToken }, the shape the API's own
      // auth tests assert). Default to a usable token unless the suite's
      // handler wants to observe the handshake itself.
      if (method === 'GET' && url.endsWith('/api/v1/auth/csrf')) {
        result = { status: 200, body: { csrfToken: 'stub-csrf-token' } };
      } else {
        throw new Error(`Fetch stub has no handler for ${method} ${url}`);
      }
    }
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (result.body === undefined ? null : result.body),
    } as Response;
  };

  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Body of a shared error envelope (packages/shared ApiErrorSchema). */
export function errorEnvelope(code: string, message: string, requestId?: string): unknown {
  return { error: { code, message, ...(requestId === undefined ? {} : { requestId }) } };
}

/** Valid UUID fixtures for the schema-locked DTOs. */
export const TEST_IDS = {
  user: 'b1e0c7a2-34f9-4d58-8e26-90ab3c5d7f61',
  orgA: '3f2e6a1e-9b5c-4f7d-8a21-6c0e5d9b4a10',
  orgB: '8c41d2f0-51e7-4a3b-9d62-2b7f0a5e3c44',
} as const;

// ---------------------------------------------------------------------------
// Fixture builders — the merged shared contracts (P1-4), spoken in ONE place
// so a future contract change updates a single file. Builders return plain
// DTOs typed against the shared schemas; tests inject them into stub bodies.
// ---------------------------------------------------------------------------
export const FIXTURE_DATES = {
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
} as const;

/** Organization DTO per the merged contract (includes the server slug). */
export function orgFixture(id: string, name: string, slug: string): Organization {
  return { id, name, slug, createdAt: FIXTURE_DATES.createdAt, updatedAt: FIXTURE_DATES.updatedAt };
}

/** /me membership per the merged contract: role, status, and server-resolved name. */
export function membershipFixture(
  organizationId: string,
  organizationName: string,
  role: Membership['role'],
  status: Membership['status'] = 'active',
): Membership {
  return { organizationId, organizationName, role, status };
}

/** GET /api/v1/me body for the shared test user. */
export function meFixture(memberships: Membership[]): MeResponse {
  return {
    user: { id: TEST_IDS.user, displayName: 'Avery Analyst', email: 'avery@example.com' },
    memberships,
  };
}

/** POST /api/v1/organizations response: org + owner membership, one transaction. */
export function createdOrgEnvelope(organization: Organization): OrganizationCreatedResponse {
  return { organization, membership: { role: 'owner', status: 'active' } };
}
