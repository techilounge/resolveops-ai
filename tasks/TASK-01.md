> **ARCHIVED — period document, not a live instruction.** Archived 2026-10-09 (PROD-001).
> This task specification was implemented and delivered by PR #1 (squash-merged as `b2ab034`).
> Delivered reality: TASK-01/02/03 are implemented and merged (PRs #1–#3; `main` = `a0f342b`); see `README.md` and `docs/EVIDENCE-LOG.md`.
> Do not follow the content below as current instructions.


# TASK-01 — Evidence-backed incident assessment
**Branch:** `feat/incident-assessment`  
**Primary ownership:** `src/lib/assessment.ts`, `src/lib/assessment.test.ts`; small UI changes permitted only in `src/main.tsx`.

## Goal
Given 47 synthetic device records, generate accurate findings and a prioritized incident assessment. No AI API is required for deterministic classification.

## Acceptance criteria
- Implement pure function `assessIncident(devices: Device[])` returning totals, grouped causes (`unencrypted`, `missingEscrow`, `unknownStatus`), unique impacted device IDs, and 3 evidence-backed recommendations.
- Clearly distinguish *correlation* from a proven cause; no claims that policy change caused device status.
- Empty inventory returns zero counts and a safe `no data` outcome.
- Present assessment in the dashboard with clear severity and evidence summary.
- Tests cover fixture, empty input, overlapping conditions, and no-impact compliant devices.
- `npm run check` passes. Submit separate PR with real test output.

## Out of scope
Live Intune polling, incident enrichment via Graph, security tool credentials.
