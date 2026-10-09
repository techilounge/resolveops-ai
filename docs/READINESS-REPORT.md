> **ARCHIVED — period document, not a live instruction.** Archived 2026-10-09 (PROD-001).
> This pre-event readiness audit (October 8, 2026) describes the starter before any delivery work: 3 baseline tests, no git history, and no hosted CI run — all since superseded.
> Delivered reality: TASK-01/02/03 are implemented and merged (PRs #1–#3; `main` = `a0f342b`); see `README.md` and `docs/EVIDENCE-LOG.md`.
> Do not follow the content below as current instructions.


# Pre-hackathon readiness — October 8, 2026

The starter installs, passes its three existing tests, compiles with strict TypeScript, and builds for production. The dashboard was verified in the local browser. TASK-01, TASK-02, and TASK-03 remain unimplemented for Obvious on October 9.

## Audit

Read README, AGENTS, package/configuration files, every original file in docs, all three task specifications, the scripts landing-zone README, CI, PR template, and all application source files.

Architecture: React 18 mounts a single dashboard in `src/main.tsx`; local state controls three views and inventory search. Typed deterministic records live in `src/data/incident.ts`, with a pure baseline summary in `src/lib/inventory.ts`. Vite builds the app, Vitest tests the summary, and TypeScript uses strict mode. No backend or application API calls were found. No new dependencies or application features were added.

The unchanged fixture contains 47 synthetic Windows 11 devices, IDs DEV-001 through DEV-047 and LAB-W11 hostnames. Incident INC-2026-1047 is the hypothetical BitLocker compliance drift demonstration. Browser totals: 47 devices, 40 noncompliant, 7 unknown, 12 unencrypted, 8 missing escrow flags. All three delivery evidence entries remain `not-started`; the event evidence log retains its pending entries.

## Fixes

- Split Vite and Vitest configurations. The original `vitest/config` import combined Vite 6 React plugin types with Vitest 2's bundled Vite 5 types and failed TypeScript with TS2769. Build config now imports from Vite; pure TypeScript tests use a standalone Vitest config. Both configurations are included in the TypeScript check.
- Added `package-lock.json`; GitHub Actions now runs `npm ci --no-audit --no-fund` then `npm run check`, matching final local validation.
- Removed the Google Fonts CSS import so the offline dashboard uses local font fallbacks.
- Extended `.gitignore` for TypeScript build metadata, temporary/backup files, cache, and temporary directories. Existing rules exclude node_modules, dist, coverage, environment secrets, logs, and editor files; `.env.example` remains intentionally allowed. Patterns were inspected; Git ignore behavior cannot be checked in this folder without a Git repository.
- Clarified preparation-only scope, approval before publishing, file ownership, and TASK-03 draft labeling in the instructions and launch prompt. Corrected the baseline comment to name TASK-01's specified `assessIncident` function.
- Made TASK-02's separate fixture-only Pester verification and baseline Node check explicit. Resolved the conflict between the optional TASK-03 UI scope cut and its former mandatory UI-label criterion: generated output and documentation must carry the draft label, and any optional UI must use it too.

## Executed validation

Environment: Windows PowerShell, Node v24.19.0, npm 11.17.0. README and CI target Node 22; Node 22 was not available in this local validation, and hosted CI has not run.

Commands and observed results:

```text
node --version
v24.19.0
npm --version
11.17.0

npm install --no-audit --no-fund
added 110 packages in 23s; exit 0

npm run check                  (original configuration)
Test Files 1 passed; Tests 3 passed
TypeScript TS2769 in vite.config.ts; exit 1

npm run check                  (after configuration fix)
Test Files 1 passed; Tests 3 passed
tsc -b succeeded; Vite production build succeeded; exit 0

npm ci --no-audit --no-fund     (after stopping dev server)
added 110 packages in 11s; exit 0

npm run check                  (final, after clean install)
Test Files 1 passed (1); Tests 3 passed (3)
tsc -b succeeded
vite v6.4.4: 1578 modules transformed; built in 6.17s
dist/index.html                    0.44 kB
dist/assets/index-mIIubjfk.css      6.73 kB
dist/assets/index-S3rL1iQB.js      158.58 kB
exit 0

npm run dev -- --host 127.0.0.1
Vite ready; http://127.0.0.1:5173/
```

The sandbox initially prevented registry access (ENOTCACHED) and esbuild worker spawning (EPERM); authorized execution outside the sandbox resolved these environment restrictions. The first clean-install attempt encountered a locked esbuild executable while Vite was running; stopping the local dev server and retrying succeeded. npm emitted allow-scripts notices for esbuild; the tests and build nevertheless completed successfully, with no configuration workaround to disable protections.

Browser checks on the local dev server:
- Command center rendered the incident, expected totals, and zero verified workstreams.
- Inventory rendered 47 table body rows. Searching `dev-047` returned LAB-W11-047; a nonexistent search returned zero rows.
- Factory workstreams displayed all three tasks as ready for assignment and not started.
- No captured browser warning/error logs during these checks.
- At a 390 x 844 viewport, the command center rendered correctly and document scroll width did not exceed viewport width. The navigation has its own horizontal scroller. The temporary viewport override was reset.
- The dev server was stopped after verification. Browser verification used the dev server; the production bundle was built successfully but was not separately browser-tested.

## Hackathon handoff

| Assignment | Owned files | Verification still to implement during event |
|---|---|---|
| TASK-01 | assessment module/tests; dashboard integration | Fixture, empty, overlap, compliant cases; `npm run check`; findings UI and separate PR |
| TASK-02 | scripts and diagnostic runbook | Read-only diagnostics, fixture JSON, graceful errors; PowerShell 7/Pester 5 fixture tests and actual fixture output; baseline Node check |
| TASK-03 | proposal module/tests and remediation runbook | Typed proposal, manual investigation flags, explicit approval label, safety tests; `npm run check`; independent review |

TASK-01 and TASK-02 can proceed concurrently in isolated branches. TASK-03 waits for an agreed assessment contract or documents its own normalized input shape. TASK-01 owns the shared dashboard; optional TASK-03 UI integration waits for TASK-01 to merge and uses a separate integration change. The source fixture and types remain unchanged. No assessment/proposal modules, diagnostic scripts, or feature runbooks were created during preparation.

## Git and publishing gate

`git status --short`, `git branch --show-current`, and `git remote -v` each reported `fatal: not a git repository`. This directory has no `.git`; there is no branch or configured remote to verify. No Git initialization, commits, pushes, PRs, or publishing were performed. A clean Git working tree and hosted CI success therefore cannot be claimed. Local dependencies and generated build artifacts are covered by ignore rules.

Before publishing, obtain human approval and the target GitHub repository. Then verify the intended branch and remote, publish the reviewed starter, and confirm the Node 22 GitHub Actions run. During the event, record actual task PR/test/review evidence, and request approval separately before merges.
