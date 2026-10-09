# Remediation runbook

> **Status: `Draft — human approval required`.** Every proposal this runbook describes is a
> draft that authorizes nothing. No step below executes anything on a device, and no approval
> exists until a human records one outside this repository.

## Purpose

This runbook describes how a technician takes a generated remediation proposal from
`src/lib/proposal.ts` through human review. It covers proposal generation, review, and the
approval record. **Execution of any remediation is out of scope** for this deliverable, per
`tasks/TASK-03.md`: scripts that change disk encryption, a real approval service, and an
autonomous endpoint action engine are all excluded.

## Safety envelope

- Proposals are generated from read-only assessments. Diagnostics are read-only; no device is
  ever modified by this codebase.
- Generated output never contains executable device-modifying commands. The test suite
  (`src/lib/proposal.test.ts`) scans the entire output for a denylist (`manage-bde`,
  `Set-BitLocker*`, `repair-bde`, `reg`, `Invoke-*`, `-ExecutionPolicy`) and for shell command
  shapes in step details.
- No connections to Intune, Entra, Microsoft Graph, ServiceNow, or production assets; no
  credentials; no key material in output (per `AGENTS.md`).
- Findings are correlations from a single snapshot, not proven causes; the proposal carries
  the assessment's correlation notice forward.

## Technician flow

1. **Obtain the assessment.** The input is the typed `IncidentAssessment` produced by
   `assessIncident` (TASK-01, `src/lib/assessment.ts`) from the synthetic device inventory.
2. **Generate the proposal.** Call `buildRemediationProposal({ assessment, proposedBy,
   createdAtIso })`. `createdAtIso` is an injected clock — output is fully deterministic, with
   no hidden `Date.now()`.
3. **Read the summary and warnings first.** `status` is always the literal
   `Draft — human approval required`; `issueSummary` and `impactedPopulation` carry the counts;
   `warnings` flags unknown-state devices (manual investigation required, no automated action
   path) and repeats the correlation notice.
4. **Verify preconditions.** Every `investigationSteps` entry is human work
   (`requiresManualInvestigation` is always `true`). Devices with unknown compliance state
   must be verified by a person before anything else is decided.
5. **Human review.** An approver reads `investigationSteps`, `potentialImpact`,
   `validationPlan`, and `rollbackAndEscalation` in full.
6. **Record the approval decision.** The record of who approved and when is kept by a human
   process outside this repository. There is no approval service in this codebase.
7. **Execution (out of scope).** If — and only if — a recorded human approval exists, any
   subsequent execution happens in a separate, human-driven process that is not part of this
   repository.

## What the approval fields mean

Generated proposals always carry:

```json
{
  "status": "Draft — human approval required",
  "approval": { "required": true, "approver": null, "approvedAtIso": null }
}
```

`approver` and `approvedAtIso` are **always null in generated output** — no code path in this
repository can set them. They exist so a downstream human process (never this code) has a
typed place to record the decision. The field is named `approver` consistently across the
interface, implementation, and tests.

## Invariants enforced by tests

- `status` is always the literal `Draft — human approval required`.
- `approval.required` is always `true`; `approver` and `approvedAtIso` are always `null`.
- Denylist scan over the entire output: no device-modifying command tokens, no shell command
  lines in step details.
- Unknown-state and no-data inputs cannot produce an approvable or auto-actionable proposal
  (a no-data proposal is a placeholder with an empty impacted population).
- Deterministic output for fixed input plus the injected clock.

## Running the checks

`npm run check` runs the Vitest suite (including `src/lib/proposal.test.ts`), the TypeScript
build, and the Vite production build. This repository's CI runs these Node checks only; the
read-only PowerShell diagnostic toolkit (TASK-02) is exercised separately under `scripts/`.
