# Route map — routed-app IA and API v1 surface

**Status:** docs-only transcription (Phase 0, PROD-006) · **Recorded:** 2026-10-09 · **Repo state:** `main` = `f242471` · **Amended:** 2026-10-09 Phase 0 gate review (gate-decided additions in §2.2 and §3.2; amended notes in §2.4 and §3.3)

This document transcribes the ResolveOps AI Production SaaS Blueprint's information architecture (§4) and REST API route table (§11) into the repo, and cross-checks the API surface against the enforced in-repo contract, `packages/shared/src/route-map.ts`. It is a reference for the Phase 1+ UI and API work. **No screen and no API route in this document is implemented.** The only implemented HTTP endpoint in the repo is `GET /healthz` (service status only — `apps/api/src/routes/health.ts`).

## 1. Sources, precedence, and discrepancy policy

| Source | Role |
|---|---|
| Production SaaS Blueprint §11 (REST API contracts v1) | Design source of truth for the API route table below |
| Production SaaS Blueprint §4 (UX and information architecture) | Design source of truth for the routed-app IA below |
| Production SaaS Blueprint §14 (release plan) | Source of the phase numbers in the API table |
| `packages/shared/src/route-map.ts` (`RESERVED_ROUTES`) | The enforced in-repo contract for the reserved route list — method, path, family, and `blueprintPhase` are asserted by `route-map.test.ts` |

**Discrepancy policy:** if the Blueprint and `route-map.ts` ever disagree, this document records the discrepancy as a note in §5 — a docs PR never "fixes" the code to match the docs, and a docs-only change never edits the contract to match the Blueprint. The contract is changed only by a code PR that owns it.

## 2. Routed-app information architecture (Blueprint §4, transcribed)

### 2.1 Global navigation

Command Center, Incidents, Devices, Investigations, Resolution Center, Knowledge, Reports, Integrations, Team, Model Settings, Billing, Audit Log, Account — thirteen entries. Main routes live under `/app/`, onboarding at `/onboarding/`, authentication callbacks at `/auth/`.

### 2.2 Routes and critical states

| Screen/route | Key elements | Critical states |
|---|---|---|
| `/onboarding` | Create organization, verify membership, consent explanation | invited / incomplete / consent pending |
| `/app/dashboard` | incident KPIs, high-risk groups, sync health, outstanding reviews | fresh / stale / partial / demo |
| `/app/incidents` | filters, severity, owner, service status, SLA and bulk triage | loading / empty / error |
| `/app/incidents/:id` | timeline, device evidence, run assessment, findings, notes | unsupported evidence / correlation notice |
| `/app/devices` | paginated searchable fleet, OS, compliance, last seen | source provenance / unknown / stale |
| `/app/devices/:id` | identity, state history, linked incidents, diagnostics | cross-tenant access denied |
| `/app/investigations/:id` | agent steps, evidence citations, cost, model trace, limitations | queued / running / completed / failed |
| `/app/resolutions` | draft proposals, approval requests, risk and validation plans | draft / pending / rejected / approved |
| `/app/knowledge` | nav destination — gate-decided addition, 2026-10-09 gate review (detail pending Blueprint §4) | not yet specified |
| `/app/reports` | nav destination — gate-decided addition, 2026-10-09 gate review (detail pending Blueprint §4) | not yet specified |
| `/app/settings/integrations` | Graph consent, permission scopes, sync logs, disconnect | error / revoked / syncing |
| `/app/settings/models` | allowed providers, routing, fallbacks, budgets | disabled model / budget exceeded |
| `/app/team` | invites, memberships and least-privilege roles | pending invite / revoked role |
| `/app/audit` | actor, action, target, source, timestamp | immutable event details |
| `/app/billing` | plan, device capacity, AI usage, invoices | grace period / canceled |
| `/app/account` | nav destination — gate-decided addition, 2026-10-09 gate review (detail pending Blueprint §4) | not yet specified |

### 2.3 Experience standards

- Responsive from 320px to large monitors.
- WCAG 2.2 AA target; visible keyboard focus; accessible tables and dialogs.
- No unintended horizontal page overflow.
- Skeleton, empty, and error states for every data surface.
- Timezone-aware timestamps.
- Clear demo/live badges, evidence-age warnings, and reduced-motion support.
- Never silently fall back to synthetic records after a live connector fails.

### 2.4 Transcription notes (recorded, not fixed)

1. Three global-navigation entries — Knowledge, Reports, Account — have no dedicated rows in the Blueprint §4 route table; "Command Center" corresponds to `/app/dashboard` and "Resolution Center" to `/app/resolutions`. Found at PROD-006; resolved at the 2026-10-09 Phase 0 gate review — §2.2 above now carries minimal placeholder rows (`/app/knowledge`, `/app/reports`, `/app/account`; kebab-case `/app/<name>` where §4 names no path), each marked as a gate-decided addition pending incorporation into Blueprint §4.
2. The Blueprint names `/auth/` for authentication callbacks but defines no per-route rows for it. Any callback routes must be designed in the phase that implements identity (Phase 1, ADR-003).

## 3. API v1 route surface (Blueprint §11, transcribed)

### 3.1 Global conventions (Blueprint §11, verbatim requirements)

- **Error envelope:** every route returns the shared taxonomy envelope on failure — `{ error: { code, message, requestId?, details? } }` with codes `BAD_REQUEST`/`UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/`CONFLICT`/`RATE_LIMITED`/`INTERNAL` mapping to HTTP `400/401/403/404/409/429/5xx` (`packages/shared/src/errors.ts`). The "Errors" column below cites this envelope for every row.
- **Pagination:** scoped list/search routes use the shared pagination envelope — `{ data: [...], page: { page, pageSize, total } }`, defaults page 1 / pageSize 25, capped at 100 (`packages/shared/src/pagination.ts`).
- **Long operations** (syncs, AI investigations) return `202` plus a job ID/status endpoint and never block a browser waiting for an LLM or a full sync.
- Also mandated by §11: OpenAPI 3.1 + Zod DTOs, idempotency keys, request IDs, versioning, and quota enforcement — landing with the phases that implement the routes.
- **Auth/tenancy markers describe the planned enforcement contract, not current behavior.** Today nothing is enforced: Phase 0 attaches no auth, no tenancy, and no enforcement logic to any route (per the Phase 0 Blueprint and ADR-002). `TenantContext` (`packages/shared/src/tenancy.ts`) is the interface later phases must produce server-side from verified membership — a client-supplied tenant identifier is never trusted (Blueprint §7).

### 3.2 Route table — 21 method/path pairs (20 Blueprint §11 pairs + 1 gate-decided addition)

Phase = Blueprint §14 release phase that owns the capability (for reserved rows, verbatim from `RESERVED_ROUTES[].blueprintPhase`; the PRD's R1–R6 release labels correspond to §14 phases 1–6). "DTO shipped (PROD-004)" means the Zod request/response schemas exist in `packages/shared` — **not** that the route exists. No `/api/v1` route is implemented; the reserved rows are named only in `RESERVED_ROUTES` (no schemas, no handlers, no client).

| Method | Path | Purpose (Blueprint §11) | Phase | Contract status | Auth / tenancy | Errors | Notes |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/me` | authenticated profile/memberships | 1 | R1 — DTO shipped (PROD-004) | Authenticated user; cross-tenant (returns all memberships) | ApiError (§11 set) | `MeResponseSchema` |
| POST | `/api/v1/organizations` | authorized tenant creation | 1 | R1 — DTO shipped (PROD-004) | Authenticated user; creates a tenant, so no TenantContext yet | ApiError (§11 set) | `CreateOrganizationRequestSchema` / `OrganizationSchema` |
| GET | `/api/v1/organizations/current` | validated organization context | 1 | R1 — DTO shipped (PROD-004) | TenantContext (server-verified membership) | ApiError (§11 set) | `OrganizationSchema` |
| GET | `/api/v1/incidents` | scoped list | 1 | R1 — DTO shipped (PROD-004) | TenantContext; scoped to organization | ApiError (§11 set) | Paginated; severity/status filters (`ListIncidentsQuerySchema`) |
| POST | `/api/v1/incidents` | scoped create | 1 | R1 — DTO shipped (PROD-004) | TenantContext | ApiError (§11 set) | `CreateIncidentRequestSchema` (strict) |
| GET | `/api/v1/incidents/:id` | scoped view | 1 | R1 — DTO shipped (PROD-004) | TenantContext | ApiError (§11 set) | `IncidentResponseSchema` |
| PATCH | `/api/v1/incidents/:id` | scoped change | 1 | R1 — DTO shipped (PROD-004) | TenantContext | ApiError (§11 set) | `PatchIncidentRequestSchema` — at least one field must change |
| POST | `/api/v1/incidents/:id/assessments` | create versioned assessment | 3 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `assessments`; versioned, evidence-linked rules (PRD P-06) |
| GET | `/api/v1/devices` | paginated scoped search | 2 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `devices`; paginated per §11 |
| GET | `/api/v1/devices/:id` | state/evidence history | 2 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `devices`; cross-tenant access denied state (§4) |
| POST | `/api/v1/integrations/intune/consent` | begin approved consent | 2 | Reserved (RESERVED_ROUTES) — planned | Tenant admin; customer admin consent (§8) | ApiError (§11 set) | family `integrations`; Graph admin-consent flow, consent state validation |
| GET | `/api/v1/integrations` | integration health | 2 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `integrations` |
| POST | `/api/v1/integrations/:id/sync` | enqueue idempotent sync | 2 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `integrations`; 202 + job ID; throttle-aware per §8 |
| POST | `/api/v1/incidents/:id/investigations` | enqueue AI investigation | 4 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `investigations`; 202 + job ID; cost budgets (§9) |
| GET | `/api/v1/investigations/:id` | status/evidence/results | 4 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `investigations` |
| GET | `/api/v1/jobs/:id` | job status polling | 2 | Gate-decided addition (2026-10-09) — pending Blueprint §11 incorporation; **not** in `RESERVED_ROUTES`, no DTO shipped | TenantContext | ApiError (§11 set) | family `jobs`; the shared status endpoint for long operations that return 202 + job ID (`integrations/:id/sync`, `incidents/:id/investigations`); distinct from `GET /api/v1/investigations/:id` (investigation results, not generic job status). Added at the Phase 0 gate review, 2026-10-09 — resolves the job-status gap noted at PROD-006; pending incorporation into Blueprint §11 |
| POST | `/api/v1/incidents/:id/proposals` | draft only | 4 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `proposals`; draft-only, approval is a separate transition (§10) |
| POST | `/api/v1/proposals/:id/approval-requests` | request review | 4 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `proposals` |
| POST | `/api/v1/approvals/:id/decision` | privileged decision | 4 | Reserved (RESERVED_ROUTES) — planned | Privileged approver; two-person rule, self-approval prohibited (§7, §10) | ApiError (§11 set) | family `approvals` |
| GET | `/api/v1/audit-events` | authorized audit search | 1 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `audit`; immutable events (§4) |
| GET | `/api/v1/usage` | usage/cost overview | 5 | Reserved (RESERVED_ROUTES) — planned | TenantContext | ApiError (§11 set) | family `usage`; billing/usage metering (§12) |

### 3.3 Transcription notes (recorded, not fixed)

1. The Blueprint §11 table combines two methods per row for incidents (`GET/POST /api/v1/incidents`, `GET/PATCH /api/v1/incidents/:id`); this document and `RESERVED_ROUTES` treat each method/path as its own pair — 18 §11 rows expand to 20 pairs.
2. §11 mandates a "job ID/status endpoint" for long operations but names no job-status path (e.g. no `GET /api/v1/jobs/:id` row exists in §11, and none is in `RESERVED_ROUTES`). Found at PROD-006; resolved at the 2026-10-09 Phase 0 gate review — §3.2 above documents `GET /api/v1/jobs/:id` (phase 2, family `jobs`) as a gate-decided addition: it is not in `RESERVED_ROUTES`, ships no DTO, and awaits incorporation into Blueprint §11. It does not replace `GET /api/v1/investigations/:id`, which remains the investigation status/evidence/results route (phase 4).

## 4. Cross-check against `packages/shared/src/route-map.ts`

The comparison script (run from the repo root, kept outside the repo — docs-only PR):

```bash
node /home/user/work/route-map-check.mjs
```

It parses `RESERVED_ROUTES` out of `packages/shared/src/route-map.ts`, parses the §3.2 table above, and asserts: (1) 13 reserved entries parse; (2) the doc table has 20 unique method/path pairs, all under `/api/v1/`; (3) the doc table equals the Blueprint §11 transcription exactly (method + path + phase); (4) every `RESERVED_ROUTES` entry matches a doc row on method + path + `blueprintPhase` and is marked Reserved; (5) no reserved row claims "shipped"; (6) the remaining 7 rows are exactly the R1 pairs marked DTO shipped.

Result at `main` = `f242471` (full output in the PR body):

```text
RESULT: PASS — 20/20 method+path pairs match; 13/13 reserved phases match; 7/7 R1 rows match
```

**Post-gate note (2026-10-09):** the Phase 0 gate review added one row to §3.2 — `GET /api/v1/jobs/:id`, a gate-decided addition that is **not** in `RESERVED_ROUTES`. The PASS result above stands as verified at `f242471` (20/20 pairs); the §3.2 table now holds 21 pairs — the same 20 §11 pairs plus the gate addition pending Blueprint §11 incorporation. The contract file `route-map.ts` is unchanged by docs and still reserves 13 entries.

## 5. Discrepancies between Blueprint §11 and `route-map.ts`

**None found.** Verified at `f242471`: the 20 §11 method/path pairs partition exactly into the 7 R1 pairs covered by implemented DTOs (`me`, organizations create + current, incidents list/create, incidents view/patch) and the 13 `RESERVED_ROUTES` entries; and every reserved `blueprintPhase` is consistent with the Blueprint §14 release table (devices + integrations → 2, assessments → 3, investigations/proposals/approvals → 4, audit-events → 1, usage → 5). The two open items in §3.3 were §11 gaps/omissions recorded for the implementing phases, not contract disagreements — both were resolved in this document at the 2026-10-09 Phase 0 gate review (the `GET /api/v1/jobs/:id` row in §3.2 and the Knowledge/Reports/Account rows in §2.2); incorporating them into the Blueprint itself remains open for a future Blueprint revision. The gate-decided row sits outside the §11 partition above — it is not in `RESERVED_ROUTES` and carries no DTO.
