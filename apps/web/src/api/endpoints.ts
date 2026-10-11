// Typed endpoint functions over the live API client. Reads parse with the
// locked Zod contracts from @resolveops/shared; mutations stay opaque (see
// client.ts) so the parallel API wave can refine response envelopes without
// touching the web client.
import {
  MeResponseSchema,
  OrganizationSchema,
  type MeResponse,
  type Organization,
} from '@resolveops/shared';
import { apiRequest } from './client';

export const API_PATHS = {
  login: '/api/v1/auth/login',
  logout: '/api/v1/auth/logout',
  me: '/api/v1/me',
  organizationsCurrent: '/api/v1/organizations/current',
  organizationsCreate: '/api/v1/organizations',
  activeOrganization: '/api/v1/me/active-organization',
} as const;

export async function getMe(): Promise<MeResponse> {
  return MeResponseSchema.parse(await apiRequest(API_PATHS.me));
}

export async function getCurrentOrganization(): Promise<Organization> {
  return OrganizationSchema.parse(await apiRequest(API_PATHS.organizationsCurrent));
}

/**
 * Creates the organization and (API-side) the owner membership. Returns the
 * organization when the response carries the locked Organization DTO;
 * `null` when the API wave ships a different envelope — callers then
 * identify the new organization from the membership delta on GET /me.
 */
export async function createOrganization(name: string): Promise<Organization | null> {
  const body = await apiRequest(API_PATHS.organizationsCreate, { method: 'POST', body: { name } });
  const parsed = OrganizationSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
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
