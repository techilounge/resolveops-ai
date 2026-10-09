# ADR-002: Tenant scoping + RLS

**Status:** Proposed — pending ratification at the Phase 0 gate
**Date:** 2026-10-09
**Mandate served (prompts pack, art_6BLtxfho):** Prompt 0, "Non-negotiable security quality gates": "A server-verified active organization and role on every tenant-owned API operation; SQL RLS and tenant-consistent relational references; cross-tenant negative tests." Prompt 0, "Fixed architectural defaults": "managed PostgreSQL with RLS and database-level tenant constraints."
**Blueprint reference (art_JDTNp9NS):** §6 (PostgreSQL schema and data lifecycle), §7 (identity and security boundaries), §16.3 (provider decision criteria).

## Context

The target product is a commercial multi-tenant SaaS with tenant-scoped identity and data. No database exists today — there is nothing to migrate, and equally nothing to lean on. Blueprint §6 fixes the shape of tenant isolation: `organization_id` required on every tenant-owned row; composite tenant foreign keys (e.g. `(organization_id, device_id)` referencing `device (organization_id, id)`); RLS policies on every sensitive table; fail-closed default privileges; service-role use controlled and logged; no client-supplied tenant ID trusted without membership evaluation. Blueprint §16.3 leaves the provider choice open: "Decide Supabase managed Postgres versus equivalent managed Postgres based on pricing and operational controls." Provider selection and provisioning are Phase 1 human decisions — Phase 0 must not make or imply either.

## Decision

1. **PostgreSQL Row-Level Security is the primary tenant-isolation boundary**, implemented as restrictive (default-deny) policies on every tenant-sensitive table, with database-level tenant constraints: composite foreign keys that make cross-tenant references structurally inexpressible.
2. **Server-verified organization context on every tenant-owned operation.** The authenticated session's verified membership determines the tenant context; a client-supplied tenant identifier is never trusted on its own (Blueprint §6). Identity authentication is not authorization (§7).
3. **Defense in depth:** application-layer scoping (RBAC, query filters) remains mandatory; RLS is the boundary of last resort, not the only control. Cross-tenant negative tests (direct read, search/filter, joins, writes, storage, jobs, cached AI context — §6) are acceptance criteria for Phase 1, not optional coverage.
4. **Provider decision framework (selection provisional pending Phase 1 authorization).** The choice between Supabase managed Postgres and an equivalent managed Postgres is evaluated against the Blueprint's own §16.3 criteria:
   - **Pricing** — total cost shape under device-capacity and usage metering (ADR-008's metering), including connection-based pricing effects of a chatty worker.
   - **Operational controls** — backup/restore drill support, connection pooling, migration ergonomics, telemetry/log access, RLS behavior parity with self-managed Postgres, region availability consistent with ADR-007.
   No vendor is selected and no resource is provisioned in Phase 0. This ADR fixes the criteria and the isolation mechanism; the vendor selection is recorded when Phase 1 authorizes provisioning.

## Consequences

- Every tenant-sensitive table must carry `organization_id` and an RLS policy from its first migration — retrofitting isolation is the expensive path this ADR exists to prevent.
- Phase 1 inherits a mandatory cross-tenant test matrix (the Phase 1 acceptance gate: a user assigned only to Org A cannot enumerate, view, edit, search, or infer Org B objects even by guessed UUID).
- Service-role code paths must be few, explicit, and logged; fail-closed default privileges make unlogged paths unusable rather than merely discouraged.
- Policy authorship adds per-table overhead; in exchange, isolation becomes a database property that survives application bugs rather than a convention that depends on them.
- The provider question stays open without blocking Phase 0: contracts (PROD-004) define `TenantContext` without binding it to a vendor.
