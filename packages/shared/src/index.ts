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
export {
  ActiveOrganizationResponseSchema,
  MeUserSchema,
  MembershipSchema,
  MembershipStatusSchema,
  MeResponseSchema,
  SwitchOrganizationRequestSchema,
  type ActiveOrganizationResponse,
  type MeUser,
  type Membership,
  type MembershipStatus,
  type MeResponse,
  type SwitchOrganizationRequest,
} from './identity';
export {
  CreateInvitationRequestSchema,
  CreateOrganizationRequestSchema,
  CurrentOrganizationResponseSchema,
  MemberListResponseSchema,
  MemberSchema,
  OrganizationCreatedResponseSchema,
  OrganizationSchema,
  type CreateInvitationRequest,
  type CreateOrganizationRequest,
  type CurrentOrganizationResponse,
  type Member,
  type MemberListResponse,
  type Organization,
  type OrganizationCreatedResponse,
} from './organizations';
export {
  AuditEventListResponseSchema,
  AuditEventSchema,
  ListAuditEventsQuerySchema,
  type AuditEvent,
  type AuditEventListResponse,
  type ListAuditEventsQuery,
} from './audit';
export {
  CreateIncidentRequestSchema,
  IncidentDtoSchema,
  IncidentIdParamsSchema,
  IncidentListResponseSchema,
  IncidentResponseSchema,
  IncidentSeveritySchema,
  IncidentStatusSchema,
  ListIncidentsQuerySchema,
  PatchIncidentRequestSchema,
  type CreateIncidentRequest,
  type IncidentDto,
  type IncidentIdParams,
  type IncidentListResponse,
  type IncidentResponse,
  type IncidentSeverity,
  type IncidentStatus,
  type ListIncidentsQuery,
  type PatchIncidentRequest,
} from './incidents';
export {
  CreateIncidentCommentRequestSchema,
  IncidentCommentDtoSchema,
  IncidentCommentListResponseSchema,
  ListIncidentCommentsQuerySchema,
  type CreateIncidentCommentRequest,
  type IncidentCommentDto,
  type IncidentCommentListResponse,
  type ListIncidentCommentsQuery,
} from './comments';
export {
  DeviceDtoSchema,
  DeviceListResponseSchema,
  InventorySummaryDtoSchema,
  type DeviceDto,
  type DeviceListResponse,
  type InventorySummaryDto,
} from './devices';
export { RESERVED_ROUTES, type ReservedRoute } from './route-map';
