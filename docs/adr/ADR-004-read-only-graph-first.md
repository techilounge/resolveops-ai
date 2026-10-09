# ADR-004: Read-only Graph first

**Status:** Proposed — pending ratification at the Phase 0 gate
**Date:** 2026-10-09
**Mandate served (prompts pack, art_6BLtxfho):** Prompt 0, "Fixed architectural defaults": "Microsoft Graph/Intune read-only customer consent as first live integration." Prompt 0: "R0-R5 must have NO arbitrary endpoint execution, production PowerShell actions, remote remediation, recovery-key retrieval or model-generated command execution."
**Blueprint reference (art_JDTNp9NS):** §8 (Microsoft Intune integration specification), §10 (no endpoint execution path in R1–R5), §16.8 (dedicated test tenant).

## Context

The first evidence source for real investigations is the Microsoft Graph-managed device inventory from a customer-authorized tenant. Blueprint §8 specifies the opening integration precisely: `GET /v1.0/deviceManagement/managedDevices` with the `DeviceManagementManagedDevices.Read.All` application permission and customer administrative consent; validation of current Microsoft documentation, permissions, and license requirements before implementing; OAuth admin-consent state/nonce/callback validation with verified tenant binding, revocation detection, and disconnect; credential **references** (never token values) persisted in app tables. §8 also carries the critical semantic warning: managed-device compliance, volume encryption, protection, and recovery-key escrow are distinct facts — a missing Graph field must never be read as escrow absence, and actual BitLocker recovery passwords are never retrieved or persisted in this product's MVP. No Graph connection of any kind exists today, and AGENTS.md's boundary forbids connections during Phase 0.

## Decision

1. **All Graph access is read-only, beginning with managed-device inventory.** The initial permission set is the single read scope named in Blueprint §8; no write scopes are requested, approved, or implemented in any release through R5.
2. **Customer administrative consent gates every tenant connection.** Consent initiation/callback with state and nonce validation, verified tenant binding, revoked-consent detection, and a disconnect flow; the integration is customer-revocable at any time.
3. **Credential references only.** Token/certificate material is stored as encrypted secret references in server-side secret management; no Graph tokens in application tables, browser, telemetry, or PR artifacts.
4. **Evidence honesty over inference.** Unsupported or unobserved device facts (compliance, encryption, protection, escrow) are recorded as `unknown`/`not_verified` with source and freshness metadata; missing API fields never become positive claims; recovery passwords are never retrieved or persisted.
5. **Sequencing.** The connector lands in Phase 2 behind explicit human data/permission review, piloted on a dedicated test tenant before any customer connection. **Phase 0 contacts nothing** — this ADR fixes the integration's shape, not its activation.

## Consequences

- Product capability grows only by explicit, separately reviewed permission expansion — read-only first keeps consent friction, blast radius, and review scope minimal.
- The `unknown`/`not_verified` discipline becomes a schema and UX requirement (freshness and quality indicators on device data, per §8) rather than a documentation aspiration.
- Graph throttling, pagination, revocation, and schema-drift behavior must be mock-tested (§8 validation list) before any live call.
- Microsoft documentation must be re-validated at Phase 2 implementation time; the permissions named here reflect the Blueprint's October 2026 snapshot.
