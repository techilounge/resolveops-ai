> **ARCHIVED — period document, not a live instruction.** Archived 2026-10-09 (PROD-001).
> This task specification was implemented and delivered by PR #3 (squash-merged as `a0f342b`).
> Delivered reality: TASK-01/02/03 are implemented and merged (PRs #1–#3; `main` = `a0f342b`); see `README.md` and `docs/EVIDENCE-LOG.md`.
> Do not follow the content below as current instructions.


# TASK-03 — Human-approved remediation proposal and technician runbook
**Branch:** `feat/remediation-proposal`  
**Primary ownership:** `src/lib/proposal.ts`, `src/lib/proposal.test.ts`, `docs/REMEDIATION-RUNBOOK.md`; UI may add a read-only preview.

## Goal
Generate an understandable remediation **proposal** from incident findings; no device action is permitted.

## Acceptance criteria
- Implement pure `buildRemediationProposal(...)` with typed, deterministic input/output. Accept assessment results, or a documented normalized finding shape if TASK-01 is not merged yet.
- Include issue summary, impacted population, proposed investigation steps, preconditions, potential impact, validation plan, rollback/escalation instructions, and explicit human approval requirement.
- High-risk or unknown-state findings must be flagged for manual investigation; no automatic action path.
- Label the proposal as `Draft — human approval required` in generated output and documentation; if an optional UI preview is added, use the same label there. Coordinate dashboard integration after TASK-01 merges; do not modify TASK-01 files.
- Unit tests ensure no executable device-modifying commands are included and unknown states cannot be auto-approved.
- `npm run check` passes; independently reviewed PR with evidence.

## Out of scope
Scripts that change disk encryption, a real approval service, an autonomous endpoint action engine.
