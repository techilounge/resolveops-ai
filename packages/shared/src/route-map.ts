// Reserved later-phase routes — the Blueprint §11 v1 rows whose contract
// work is outside PROD-004's first set. Named only: no schemas, no handlers,
// no client. The list is exactly the 13 rows of the §11 table that remain
// after the R1 rows covered by implemented DTOs (me, organizations create +
// current, incidents list/create, incidents view/patch), so this file plus
// the implemented DTOs transcribe the full §11 surface in the shape the
// eventual OpenAPI 3.1 document will take.
export type ReservedRoute = {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  family: string;
  // Blueprint §14 release phase that owns the capability.
  blueprintPhase: 1 | 2 | 3 | 4 | 5;
};

export const RESERVED_ROUTES: readonly ReservedRoute[] = [
  { method: 'POST', path: '/api/v1/incidents/:id/assessments', family: 'assessments', blueprintPhase: 3 },
  { method: 'GET', path: '/api/v1/devices', family: 'devices', blueprintPhase: 2 },
  { method: 'GET', path: '/api/v1/devices/:id', family: 'devices', blueprintPhase: 2 },
  { method: 'POST', path: '/api/v1/integrations/intune/consent', family: 'integrations', blueprintPhase: 2 },
  { method: 'GET', path: '/api/v1/integrations', family: 'integrations', blueprintPhase: 2 },
  { method: 'POST', path: '/api/v1/integrations/:id/sync', family: 'integrations', blueprintPhase: 2 },
  { method: 'POST', path: '/api/v1/incidents/:id/investigations', family: 'investigations', blueprintPhase: 4 },
  { method: 'GET', path: '/api/v1/investigations/:id', family: 'investigations', blueprintPhase: 4 },
  { method: 'POST', path: '/api/v1/incidents/:id/proposals', family: 'proposals', blueprintPhase: 4 },
  { method: 'POST', path: '/api/v1/proposals/:id/approval-requests', family: 'proposals', blueprintPhase: 4 },
  { method: 'POST', path: '/api/v1/approvals/:id/decision', family: 'approvals', blueprintPhase: 4 },
  { method: 'GET', path: '/api/v1/audit-events', family: 'audit', blueprintPhase: 1 },
  { method: 'GET', path: '/api/v1/usage', family: 'usage', blueprintPhase: 5 },
] as const;
