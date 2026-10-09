// @resolveops/shared — API contract layer (PROD-004).
// Contracts only: Zod schemas, DTO types, error taxonomy, pagination
// envelope, tenant context, reserved route map. No business logic, no I/O,
// no environment access.
export { HealthResponseSchema, type HealthResponse } from './health';
export {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  ApiErrorCodeSchema,
  ApiErrorSchema,
  apiErrorStatus,
  type ApiErrorCode,
  type ApiError,
} from './errors';
export {
  PAGE_DEFAULTS,
  ListQuerySchema,
  PageInfoSchema,
  PaginatedResponseSchema,
  type ListQuery,
  type PageInfo,
  type PaginatedResponse,
} from './pagination';
export { TENANT_ROLES, TenantRoleSchema, type TenantRole, type TenantContext } from './tenancy';
export { MembershipSchema, MeResponseSchema, type Membership, type MeResponse } from './identity';
export {
  CreateOrganizationRequestSchema,
  OrganizationSchema,
  type CreateOrganizationRequest,
  type Organization,
} from './organizations';
export {
  CreateIncidentRequestSchema,
  IncidentDtoSchema,
  IncidentListResponseSchema,
  IncidentResponseSchema,
  IncidentSeveritySchema,
  IncidentStatusSchema,
  ListIncidentsQuerySchema,
  PatchIncidentRequestSchema,
  type CreateIncidentRequest,
  type IncidentDto,
  type IncidentListResponse,
  type IncidentResponse,
  type IncidentSeverity,
  type IncidentStatus,
  type ListIncidentsQuery,
  type PatchIncidentRequest,
} from './incidents';
export {
  DeviceDtoSchema,
  DeviceListResponseSchema,
  InventorySummaryDtoSchema,
  type DeviceDto,
  type DeviceListResponse,
  type InventorySummaryDto,
} from './devices';
export { RESERVED_ROUTES, type ReservedRoute } from './route-map';
