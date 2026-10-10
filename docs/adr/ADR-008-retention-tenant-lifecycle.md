# ADR-008: Retention and tenant lifecycle

**Status:** Accepted
**Ratification:** Ratified as Accepted at the Phase 0 gate review, 2026-10-09 (TechiLounge).
**Date:** 2026-10-09
**Mandate served (prompts pack, art_6BLtxfho):** Prompt 0, Phase 5 workstreams: "Comprehensive audits/exports/deletion, retention policy, customer offboarding, evidence storage lifecycle, documented model provider disclosure and consent." Blueprint §7 mandatory controls: "configurable retention/export/delete."
**Blueprint reference (art_JDTNp9NS):** §6 (schema and lifecycle: `deleted_at`, retention), §7 (audit integrity, retention), §12 (billing/offboarding), §13 (backup/restore drills).

## Context

A commercial SaaS accumulates tenant data — incidents, device evidence and snapshots, investigations, AI traces, audit events, usage records — that customers must be able to export, bound, and ultimately delete when they offboard. Blueprint §6 shapes the schema for this from the start (`deleted_at` only where appropriate, `version` for concurrency, evidence provenance kept separate from normalized claims), §7 requires audit integrity and configurable retention/export/delete, §12 ties subscription changes to entitlements without withholding legally required exports, and §13 requires backup/restore drills. No database exists yet; the lifecycle is implemented in later phases (deletion tooling and drills are Phase 5 deliverables). Phase 0 records the policy shape so migrations from Phase 1 onward anticipate it.

## Decision

1. **Retention is configurable per tenant class, documented before the first live tenant.** Defaults are set from pilot usage data when it exists — retention limits are configured, not invented in source.
2. **Tenant lifecycle states are fixed:** onboarding → active → suspended → export → deletion → offboarding, with each state transition recorded (and sensitive transitions audited). Offboarding has a documented runbook including evidence-storage disposition.
3. **Exports are honored** — subscription cancellation never withholds legally required customer data exports (§12).
4. **Deletion removes tenant data with narrow, documented exceptions** where law or legitimate operations require retention (e.g., billing records); exceptions are enumerated in the policy, not left to case-by-case judgment.
5. **Audit events are immutable.** The audit trail survives tenant deletion windows per the retention policy; nothing may rewrite history.
6. **Backups and evidence storage follow the same lifecycle** — restore drills (§13) verify that retention actually works, and the evidence-storage lifecycle aligns artifact retention with tenant retention.

## Consequences

- Phase 1 migrations carry `deleted_at`/`version` columns where the lifecycle needs them and keep provenance separate from normalized claims — schema decisions this ADR informs retroactively only at cost.
- Deletion tooling, retention tests, export tests, and restore drills become explicit Phase 5 acceptance work rather than aspirations.
- Audit immutability constrains storage design (append-only paths) from the first audit table in Phase 1.
- Model-provider disclosure and consent (which processors saw which data) ride the same lifecycle records, keeping ADR-005's privacy routing auditable end to end.
