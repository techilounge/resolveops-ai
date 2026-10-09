# One-day build plan

## Baseline (tonight)
- Run `npm ci && npm run check` and inspect UI.
- Prepare the clean scaffold and three TASK files; publish only after human approval.
- Make no manual implementations of TASK-01/02/03. They are the hackathon proof.

## During the event
1. Connect repository and confirm agent GitHub permissions.
2. Ask Obvious to audit repo and confirm tests pass before any changes.
3. TASK-01 and TASK-02 can run concurrently in isolated branches; TASK-03 starts once a normalized assessment data contract is agreed. Avoid simultaneous writes to `src/main.tsx`.
4. Require independent verification/test evidence for each PR. A PR opened is **not** a PR merged.
5. After merges, rerun `npm run check` from main, validate inventory and assessments manually, and record IDs and screenshots.
6. Prepare a 2-minute demo by mid-afternoon; stop adding scope once the demonstration is stable.

## Scope cuts if blocked
- Keep core TASK-01, abandon complex UI styling.
- TASK-02's fixture-only mode is enough; Windows live mode is optional.
- TASK-03 can ship as typed JSON + tests + markdown; mark its draft as `Draft — human approval required`. UI integration is optional.
- Do not add databases, auth, external APIs, LLM endpoints, service desk integrations, or deployments.

## Definition of done
Each task has working implementation, automated test results, one reviewable PR, and logged evidence. Claims about CI or merge status must use actual links/logs.

## File ownership and verification
- TASK-01 owns `src/lib/assessment.ts`, its tests, and dashboard integration in `src/main.tsx`.
- TASK-02 owns `scripts/` and `docs/DIAGNOSTIC-RUNBOOK.md`. Run its fixture-only Pester tests separately from `npm run check`; include the actual PowerShell command and results in its PR. The baseline Node CI does not run Pester.
- TASK-03 owns `src/lib/proposal.ts`, its tests, and `docs/REMEDIATION-RUNBOOK.md`. Agree its input shape after TASK-01 establishes the interface; do not edit TASK-01 files or the shared dashboard concurrently. An optional UI preview must wait until TASK-01 is merged and use a separate integration change.
- Keep `src/data/incident.ts`, `src/types.ts`, and the baseline inventory summary stable. Coordinate any shared configuration or styling changes through one owner.
