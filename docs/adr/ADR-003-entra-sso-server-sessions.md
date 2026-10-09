# ADR-003: Entra SSO + server sessions

**Status:** Proposed — pending ratification at the Phase 0 gate
**Date:** 2026-10-09
**Mandate served (prompts pack, art_6BLtxfho):** Prompt 0, "Fixed architectural defaults": "Commercial multi-tenant SaaS, US-first, tenant-scoped identity and data. Entra OIDC sign-in first." Blueprint §16.7: "Decide whether MVP starts with Entra-only login (recommended)."
**Blueprint reference (art_JDTNp9NS):** §7 (identity, roles and security boundaries), §16.7 (Entra-only MVP recommendation), §16.2/§16.8 (test-tenant prerequisites).

## Context

The product has no authentication of any kind today. Blueprint §7 specifies the identity machinery: user identity bound to issuer plus subject; multi-tenant customer organizations with verified tenant mapping; cookie-based server-side sessions with Secure/HttpOnly/SameSite controls; CSRF protection; session expiry, refresh rotation as appropriate, and forced revocation; and the standing rule that "Identity authentication is not by itself authorization." Blueprint §16.7 recommends Entra-only login for the MVP. Creating the vendor-owned Entra multitenant app in a dedicated development tenant (§16.2) and securing a dedicated test Microsoft 365/Intune tenant (§16.8) are listed human prerequisites. Phase 0 must not connect anything, and no identity resource has been created.

## Decision

1. **Entra-first authentication: Microsoft Entra OIDC is the only login mechanism for the MVP.** Users authenticate through their Microsoft identity; no password-based local accounts ship in the MVP.
2. **Server-side sessions.** Cookie-based sessions with Secure/HttpOnly/SameSite attributes, CSRF protection, expiry, rotation as appropriate, and forced revocation. Session state lives server-side so revocation is immediate and reliable.
3. **Verified tenant binding.** The session's organization context is derived from server-verified memberships (issuer + subject bound identity evaluated against membership records), never from a frontend-selected tenant identifier.
4. **Test-tenant creation deferred.** The dedicated Entra test tenant and app registration are Phase 1 human prerequisites (§16.2, §16.8). This ADR records the authentication shape; **no identity tenant, app registration, or credential is created or configured in Phase 0.** The decision is provisional pending Phase 1 authorization.
5. **Supersession note.** This boundary interacts with AGENTS.md's no-connections rule; the dated supersession note added to AGENTS.md alongside this ADR records that Phases 1–2 introduce Entra/Graph capabilities under ADR-003/ADR-004 while the no-connection boundary stays fully binding for Phase 0.

## Consequences

- Users without a Microsoft identity cannot log in during the MVP. Accepted: the initial customer segment (internal IT/endpoint teams with Intune-managed Windows endpoints) is Microsoft-native, and the Blueprint recommends Entra-only.
- A session store and session lifecycle management become Phase 1 backend work (membership switching, logout, revocation are Phase 1 acceptance criteria).
- No password handling removes a class of credential liability from the product; identity federation shifts account-recovery workflows to the customer's directory.
- Non-Entra identity providers (if ever demanded by MSP or private-deployment segments) are a later, separate decision.
