# ADR-006: Postgres jobs with idempotency

**Status:** Proposed — pending ratification at the Phase 0 gate
**Date:** 2026-10-09
**Mandate served (prompts pack, art_6BLtxfho):** Prompt 0, "Non-negotiable security quality gates": "Jobs must be idempotent, tenant-scoped, restartable, observable and bounded by time/cost limits."
**Blueprint reference (art_JDTNp9NS):** §5 (durable worker; "durable jobs: PostgreSQL-backed queue at initial scale"), §6 (job states), §11 (202 + job ID/status endpoint for long operations).

## Context

Durable long operations — Graph device syncs (Phase 2), evidence-backed assessments (Phase 3), AI investigations (Phase 4) — must survive process restarts, be auditable, scoped per organization, and never block a browser (§11: long operations return `202` plus a job ID/status endpoint). No worker, queue, or job table exists today; the Blueprint sets a separate worker as part of the modular monolith (ADR-001) and names a PostgreSQL-backed queue as the initial-scale mechanism. Job states are fixed by §6: `queued, running, retrying, succeeded, failed, dead_letter`.

## Decision

1. **A separate worker process backed by a PostgreSQL queue** is the durable-job substrate at initial scale, per Blueprint §5. The worker is the process ADR-001 separates from the API deployment.
2. **Explicit job state machine** exactly as §6 defines: `queued → running`, with `retrying`, `succeeded`, `failed`, and `dead_letter` terminal/terminal-bound states; transitions are persisted and observable.
3. **Idempotency is a first-class property.** Job submission carries idempotency keys; job effects are idempotent upserts (unique keys such as `(organization_id, external_provider, external_id)` for external assets, per §6) so sync replay and duplicate scheduling cannot corrupt data.
4. **Tenant scoping and bounded execution.** Every job carries its organization scope and is enforced per-organization (per-job tenant isolation is mandatory for the Phase 2 connector); retries use backoff/jitter with `Retry-After` awareness; jobs are bounded by time and cost limits and are restartable from checkpoints.
5. **API integration.** Long operations are enqueued and return `202` with a job ID and status endpoint; no browser waits on an LLM call or a full sync.

## Consequences

- No additional queue infrastructure at initial scale — one managed dependency (Postgres) covers storage, tenancy (ADR-002), and job durability.
- Postgres becomes an operational dependency for job semantics: lock management, polling, and migration care around job tables; queue-depth and dead-letter monitoring arrive with the phases that introduce real jobs.
- Queue poisoning and sync replay are in the Blueprint threat model (§7) and require targeted tests (duplicate sync/replay in the Phase 2 verification list).
- Migration to a dedicated queue technology later remains possible behind the same job interface, because the state machine and idempotency semantics do not depend on the substrate.
