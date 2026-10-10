# ADR-007: Region/data residency

**Status:** Accepted
**Ratification:** Ratified as Accepted at the Phase 0 gate review, 2026-10-09 (TechiLounge).
**Date:** 2026-10-09
**Mandate served (prompts pack, art_6BLtxfho):** Prompt 0, "Fixed architectural defaults": "Commercial multi-tenant SaaS, US-first, tenant-scoped identity and data." Blueprint §16.1: "Choose initial US hosting region and explicit data residency policy."
**Blueprint reference (art_JDTNp9NS):** §7 (mandatory controls: documented region selection), §9/ADR-005 interplay (AI provider region eligibility), §16.1 (human decision).

## Context

Residency constrains nearly every later selection: the database provider's available regions (ADR-002), AI provider eligibility and fallback legality (ADR-005), storage and backup locations, telemetry projects, and deployment regions per environment (§5 environment separation). The prompts fix the direction — US-first — while Blueprint §16.1 lists the specific region and the explicit residency policy as human decisions that require vendor pricing/availability data not yet gathered. No infrastructure of any kind is provisioned today.

## Decision

1. **US-first residency.** All tenant data — database rows, artifact storage, backups, and telemetry containing tenant identifiers — is stored and processed in United States regions.
2. **An explicit residency policy is documented before the first live tenant**, stating where each data class may live and which processors are approved; residency is a documented guarantee, never an assumption.
3. **Region selection is open and provisional pending Phase 1 authorization.** The specific US region(s) will be selected when Phase 1 authorizes provisioning, using vendor pricing and availability data gathered at that time. This ADR fixes the policy direction; **no region is chosen and no resource is provisioned in Phase 0.**
4. **Corollary (binding, from ADR-005):** no organization data may be sent to an unapproved AI vendor or region — residency policy extends to every processor, not just the primary datastore.

## Consequences

- The provider/region matrix is restricted up front (ADR-002's evaluation includes region availability); a vendor that cannot meet US-region requirements is excluded by policy.
- US-only residency simplifies some compliance conversations but must be documented and honored in operations — an undocumented residency claim is worse than none.
- Later segments (MSPs, enterprises requiring private or alternate-region deployments) would be a new decision record, not a silent expansion of this one.
