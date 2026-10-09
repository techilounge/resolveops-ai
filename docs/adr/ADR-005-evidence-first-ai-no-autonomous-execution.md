# ADR-005: Evidence-first AI with no autonomous execution

**Status:** Proposed — pending ratification at the Phase 0 gate
**Date:** 2026-10-09
**Mandate served (prompts pack, art_6BLtxfho):** Prompt 0, "Fixed architectural defaults": "In-product AI investigation orchestrator is separate from Obvious coding agents. Rule-first evidence-based investigations, provider-independent model routing, tenant-allowed fallbacks, structured output validation and budget controls." Prompt 0: "R0-R5 must have NO arbitrary endpoint execution, production PowerShell actions, remote remediation, recovery-key retrieval or model-generated command execution. Proposals are drafts until authorized humans review them." Security gates: "AI output is untrusted; schemas/citations/role policy checks are enforced by deterministic code; AI cannot grant approval or call an execution tool." "Provider fallback may never send organization data to an unapproved or disallowed AI vendor/region."
**Blueprint reference (art_JDTNp9NS):** §9 (incident intelligence and AI orchestration), §10 (proposals and approvals), §16.6 (what data may go to approved model providers).

## Context

The in-product AI investigation orchestrator is distinct from the Obvious coding agents that build the product. Blueprint §9 sets the operating order: deterministic before generative — normalize evidence, apply versioned rules, group affected devices, and correlate time windows before AI is invoked, and only when uncertainty or explanation benefits. The orchestrator is a sequence of persisted steps (intake → tenant/permission validation → evidence snapshot → rules → approved knowledge base → authorized model → structured hypotheses → schema/citation/policy validation → draft investigation → human review) with idempotency, retry, cancellation, and cost budgets. The model router (§9) supports provider registry, task-specific routing, fallback priority, region/compliance eligibility, and budgets; organization-specific routing overrides platform defaults. §10 keeps proposals draft-only with backend-controlled approval transitions. No AI code, provider integration, or model configuration exists today.

## Decision

1. **AI assists investigation; it never executes.** Through R5 there is no endpoint execution path of any kind: no arbitrary endpoint execution, no production PowerShell actions, no remote remediation, no recovery-key retrieval, no model-generated command execution. Remediation execution, if ever built, is Phase 6's lab-validated, allowlisted, dual-control mechanism — never an AI capability.
2. **Evidence-first ordering.** Deterministic rules run first; AI is invoked only for uncertainty or explanation; every factual finding references evidence IDs, rule versions, and observed timestamps with supported/tentative/insufficient confidence categories.
3. **Untrusted-output containment.** AI output is validated by deterministic code: schema checks, citation verification against tenant evidence, and role-policy checks. AI cannot grant an approval, call an execution tool, or set proposal status — approvals are backend-controlled, human transitions.
4. **Provider routing is policy-bounded.** Tenant-approved provider allowlists, region/compliance eligibility (per ADR-007), fail-closed behavior when no compliant provider is available, structured-output validation, and token/latency/cost budgets; prompt-injected evidence cannot authorize new tools or change approved task policy.
5. **Phase 0 boundary.** Phase 0 ships no AI code and no provider configuration — contracts and named placeholders only (PROD-004). Default state is no external AI transmissions until explicitly configured by a tenant.

## Consequences

- Hallucination risk is contained by construction (citations, schemas, deterministic validation) rather than by prompt discipline.
- AI cost and latency are measurable and capped per tenant; budget exhaustion is a designed state, not an incident.
- Fail-closed fallback means an investigation can stall by design when no compliant provider is configured — availability is deliberately subordinate to data policy.
- The separation between Obvious (build-time coding agents) and the in-product orchestrator must stay visible in architecture and docs so customers can reason about data flows.
