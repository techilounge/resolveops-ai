// Typed endpoint functions over the live API client. Reads AND mutations
// parse with the locked Zod contracts from @resolveops/shared — the P1-4/D4
// API wave merged those envelopes, so every response shape here is a schema
// (P1-5's "mutations stay opaque" hedge is retired: the envelopes landed).
// A parse failure surfaces as a CONTRACT ApiError rather than leaking a
// malformed body into screen state.
import {
  CreateIncidentCommentRequestSchema,
  CreateIncidentRequestSchema,
  CreateInvitationRequestSchema,
  IncidentCommentDtoSchema,
  IncidentCommentListResponseSchema,
  IncidentListResponseSchema,
  IncidentResponseSchema,
  ListIncidentCommentsQuerySchema,
  ListIncidentsQuerySchema,
  ListQuerySchema,
  MeResponseSchema,
  MemberListResponseSchema,
  MemberSchema,
  OrganizationCreatedResponseSchema,
  OrganizationSchema,
  PatchIncidentRequestSchema,
  type CreateIncidentCommentRequest,
  type CreateIncidentRequest,
  type CreateInvitationRequest,
  type IncidentCommentDto,
  type IncidentCommentListResponse,
  type IncidentListResponse,
  type IncidentResponse,
  type ListIncidentCommentsQuery,
  type ListIncidentsQuery,
  type ListQuery,
  type MeResponse,
  type Member,
  type MemberListResponse,
  type Organization,
  type PatchIncidentRequest,
} from '@resolveops/shared';
import { apiRequest } from './client';

export const API_PATHS = {
  login: '/api/v1/auth/login',
  logout: '/api/v1/auth/logout',
  me: '/api/v1/me',
  organizationsCurrent: '/api/v1/organizations/current',
  organizationsCreate: '/api/v1/organizations',
  activeOrganization: '/api/v1/me/active-organization',
  incidents: '/api/v1/incidents',
  members: '/api/v1/organizations/current/members',
  invitations: '/api/v1/organizations/current/invitations',
} as const;

/** Per-incident comment collection (delta D4): POST and GET live here. */
export function incidentCommentsPath(incidentId: string): string {
  return `${API_PATHS.incidents}/${incidentId}/comments`;
}

/**
 * Serializes a list query into a query string. Undefined keys are omitted;
 * everything else is stringified for the transport edge (the shared schemas
 * coerce strings back to numbers server-side).
 */
export function listQueryToParams(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

function withQuery(path: string, search: string): string {
  return search === '' ? path : `${path}?${search}`;
}

export async function getMe(): Promise<MeResponse> {
  return MeResponseSchema.parse(await apiRequest(API_PATHS.me));
}

export async function getCurrentOrganization(): Promise<Organization> {
  return OrganizationSchema.parse(await apiRequest(API_PATHS.organizationsCurrent));
}

/**
 * Creates the organization; the API writes the owner membership in the SAME
 * transaction and answers with the merged create envelope (org + membership,
 * packages/shared organizations.ts). Returns the organization, or `null` when
 * the body does not match the contract — callers then identify the new
 * organization from the membership delta on GET /me.
 */
export async function createOrganization(name: string): Promise<Organization | null> {
  const body = await apiRequest(API_PATHS.organizationsCreate, { method: 'POST', body: { name } });
  const parsed = OrganizationCreatedResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.organization : null;
}

/**
 * Switches the server-side session's active organization (D2 route,
 * spec §6). The request body `{ organizationId }` is the planned wire shape;
 * the response envelope lands with the API wave and is not interpreted.
 */
export async function switchActiveOrganization(organizationId: string): Promise<void> {
  await apiRequest(API_PATHS.activeOrganization, { method: 'POST', body: { organizationId } });
}

/** Revokes the server session (row delete + cookie clear). 204 expected. */
export async function logout(): Promise<void> {
  await apiRequest(API_PATHS.logout, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Incidents (spec §4.3): list with filters/search, create, read, version-aware
// patch — every response parsed with the shared contract.
// ---------------------------------------------------------------------------

export async function listIncidents(query: ListIncidentsQuery): Promise<IncidentListResponse> {
  const parsed = ListIncidentsQuerySchema.parse(query);
  const search = listQueryToParams({
    page: parsed.page,
    pageSize: parsed.pageSize,
    status: parsed.status,
    severity: parsed.severity,
    assignee: parsed.assignee,
    q: parsed.q,
  });
  return IncidentListResponseSchema.parse(await apiRequest(withQuery(API_PATHS.incidents, search)));
}

export async function createIncident(request: CreateIncidentRequest): Promise<IncidentResponse> {
  const body = CreateIncidentRequestSchema.parse(request);
  return IncidentResponseSchema.parse(await apiRequest(API_PATHS.incidents, { method: 'POST', body }));
}

export async function getIncident(incidentId: string): Promise<IncidentResponse> {
  return IncidentResponseSchema.parse(await apiRequest(`${API_PATHS.incidents}/${incidentId}`));
}

export async function patchIncident(incidentId: string, patch: PatchIncidentRequest): Promise<IncidentResponse> {
  const body = PatchIncidentRequestSchema.parse(patch);
  return IncidentResponseSchema.parse(
    await apiRequest(`${API_PATHS.incidents}/${incidentId}`, { method: 'PATCH', body }),
  );
}

// ---------------------------------------------------------------------------
// Incident comments (delta D4): paginated list (oldest first) + create.
// ---------------------------------------------------------------------------

export async function listIncidentComments(
  incidentId: string,
  query: ListIncidentCommentsQuery,
): Promise<IncidentCommentListResponse> {
  const parsed = ListIncidentCommentsQuerySchema.parse(query);
  const search = listQueryToParams({ page: parsed.page, pageSize: parsed.pageSize });
  return IncidentCommentListResponseSchema.parse(
    await apiRequest(withQuery(incidentCommentsPath(incidentId), search)),
  );
}

export async function createIncidentComment(
  incidentId: string,
  request: CreateIncidentCommentRequest,
): Promise<IncidentCommentDto> {
  const body = CreateIncidentCommentRequestSchema.parse(request);
  return IncidentCommentDtoSchema.parse(
    await apiRequest(incidentCommentsPath(incidentId), { method: 'POST', body }),
  );
}

// ---------------------------------------------------------------------------
// Team (delta D2): the owner/admin roster and invitations. Both routes are
// privilege-gated server-side; a non-privileged caller gets the FORBIDDEN
// envelope (which this client turns into ApiError code FORBIDDEN).
// ---------------------------------------------------------------------------

export async function listMembers(query: ListQuery): Promise<MemberListResponse> {
  const parsed = ListQuerySchema.parse(query);
  const search = listQueryToParams({ page: parsed.page, pageSize: parsed.pageSize });
  return MemberListResponseSchema.parse(await apiRequest(withQuery(API_PATHS.members, search)));
}

export async function createInvitation(request: CreateInvitationRequest): Promise<Member> {
  const body = CreateInvitationRequestSchema.parse(request);
  return MemberSchema.parse(
    await apiRequest(API_PATHS.invitations, { method: 'POST', body }),
  );
}
