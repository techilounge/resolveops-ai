# ResolveOps AI — instructions for autonomous coding agents

## Mission
Turn a synthetic BitLocker compliance incident into verifiable engineering deliverables. Obvious is the autonomous **coding** factory. The app is the **domain-specific result** and must never pretend local mock steps are real external agent runs.

> 2026-10-09: Phases 1-2 will introduce Entra/Graph capabilities under ADR-003/ADR-004; the no-connection boundary remains fully binding for all Phase 0 work.

## Hard safety boundaries
- No connections to Intune, Entra, Microsoft Graph, ServiceNow, City of Austin systems, or production assets.
- Never add production credentials, real endpoint inventory, API keys, telemetry, or personal data.
- Diagnostics must be read-only. No `manage-bde -off`, TPM resets, KeyProtector deletion, key disclosures, or enforcement/remediation commands.
- TASK-03 produces a proposal and a human-approval gate, NOT a one-click production repair.
- Never claim generated artifacts were tested without showing commands and results.
- Don't forge PR links, test counts, merged statuses, or agent autonomy.

## Local setup
`npm install && npm run check && npm run dev`

## Build approach
Pre-hackathon preparation is limited to baseline configuration, validation, and documentation. Leave all three feature implementations for Obvious during the event. Before any Git commit or push, inspect the branch, remote, and status; publishing requires human approval.

1. Establish baseline `npm run check`; do not change starter sample data contract.
2. Work on TASK-01, TASK-02, TASK-03 in separate branches or isolated worktrees.
3. Follow exact acceptance criteria in `tasks/`. Keep change sets small.
4. Add meaningful automated tests for each implementation. Run all existing checks.
5. Open PRs against main with evidence and request independent review.
6. Only update delivery evidence with verified outcomes. Do not automatically merge without review.

## Engineering conventions
- TypeScript strict, small pure functions, no backend/cloud credentials.
- Prefer deterministic input/output, injected clocks where needed.
- Mobile responsive UI; no horizontal page overflow.
- Remain accessible (semantic headings, labels, keyboard controls, useful status text).
- Use deterministic fixture data only; avoid new dependencies unless justified.

## Assignment order
Start TASK-01; TASK-02 can run concurrently because it operates under `scripts/`. After TASK-01 interface is established, TASK-03 may reuse its findings, but must not modify TASK-01's files. See `docs/BUILD-PLAN.md`.
