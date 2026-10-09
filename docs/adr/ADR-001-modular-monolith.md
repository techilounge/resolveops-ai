# ADR-001: Modular monolith

**Status:** Proposed — pending ratification at the Phase 0 gate
**Date:** 2026-10-09
**Mandate served (prompts pack, art_6BLtxfho):** Prompt 0, "Fixed architectural defaults": "Modular TypeScript backend: Fastify or NestJS (decide via documented ADR), managed PostgreSQL with RLS and database-level tenant constraints, separate worker for durable long operations, private artifact storage." This ADR is that documented decision.
**Blueprint reference (art_JDTNp9NS):** §5 (target architecture, monorepo target, deployment), §2 (avoid a big-bang rewrite), §15 (governance).

## Context

ResolveOps AI is today a frontend-only React 18 + TypeScript + Vite SPA with a pure, dependency-free domain chain (`Device → assessIncident() → IncidentAssessment → buildRemediationProposal() → RemediationProposal`), a read-only PowerShell diagnostic script, and no backend, database, worker, identity, or external integration. The Production SaaS Blueprint §5 targets a "modular monolith and one background worker": a single API gateway hosting internal services (tenancy/RBAC, incidents/assessment, integrations/consent, AI gateway and investigation orchestrator, proposals/approvals, billing/usage/audit), a separate durable worker, managed PostgreSQL, and private artifact storage. Prompt 0 delegates the backend-framework choice (Fastify vs NestJS) to a documented ADR. Blueprint §2 requires a "staged modular monorepo migration" that keeps the original tests green — no big-bang rewrite. Phase 0 (PROD-003) stands up the workspace structure without changing product behavior.

## Decision

1. **Adopt a modular monolith with one separate worker.** One deployable API with enforced internal module boundaries (tenancy/RBAC, incidents/assessment, integrations/consent, AI gateway/orchestrator, proposals/approvals, billing/usage/audit) plus one distinct worker process for durable long operations. No microservice split is planned for any phase currently scoped.
2. **Backend framework: Fastify.** Rationale: the smallest framework surface consistent with the "minimize new dependencies" convention while the API is contracts plus a health endpoint; its plugin model maps directly onto the module boundaries and RLS-scoped tenancy shape; both governing documents left this choice to the ADR. *Reversal condition:* if later phases require NestJS's opinionated enterprise structure (heavy DI, decorated module graph), the decision can be revisited before Phase 1 API work lands — recorded here so the choice is deliberate either way.
3. **Target package map (Blueprint §5).** The monorepo destination that later phases populate incrementally is:
   - `apps/web` — the existing React/TypeScript/Vite application
   - `apps/api` — the Fastify API
   - `apps/worker` — durable-job worker
   - `packages/domain` — the pure domain chain (types, assessment, proposal)
   - `packages/shared` — DTO contracts, errors, tenant context
   - `packages/database`, `packages/auth`, `packages/integrations`, `packages/ai-gateway`, `packages/workflow`, `supabase/migrations` — destinations created and populated by the phases that need them (database/RLS: Phase 1; integrations: Phase 2; AI gateway: Phase 4; workflow/jobs: Phase 3–4).
4. **Phase 0 scope boundary.** Phase 0 stands up only the five workspaces the prompts name — `apps/web`, `apps/api`, `apps/worker`, `packages/domain`, `packages/shared` — plus root config ownership. The remaining entries in the package map are recorded destinations, not Phase 0 deliverables.
5. **Note on work-item numbering (resolves the Blueprint §15 collision).** The prompts pack's **PROD-001…006 numbering governs Phase 0 execution** (the prompts doc is the operative task list both governing documents point to). Blueprint §15's "first wave: PROD-001 architecture/workspace contracts; PROD-002 database/tenancy and RLS; PROD-003 routed web shell" uses its own roadmap numbering, which **collides** with the prompts' Phase 0 PROD-001…006; the §15 wave describes early Phase 1 workstreams. No agent executing Phase 0 should conflate the two schemes.

## Consequences

- Single deployment unit keeps early operational burden low; module boundaries must be enforced by directory structure, ownership rules, and tests until (and unless) any module is ever extracted.
- Separating the worker now lets long Graph syncs and AI investigations scale, retry, and fail independently of the request path, matching the §11 requirement that long operations never block a browser.
- The package map is a destination, not scaffolding to create preemptively — empty placeholder packages would be drift.
- Fastify commits the API to its plugin/lifecycle model; the cost is bounded because the Phase 0 API surface is a health endpoint plus contracts (PROD-004).
- The numbering note prevents future agents from reading Blueprint §15 as the Phase 0 task list.
