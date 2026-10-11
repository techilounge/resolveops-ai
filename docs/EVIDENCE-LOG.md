# Delivery evidence — TASK-01/02/03 (recorded 2026-10-09, PROD-001)

| Task | Branch | PR link | CI (post-merge run on `main`) | Independent review | Merged? | Test evidence |
|---|---|---|---|---|---|---|
| TASK-01 | feat/incident-assessment | [#1](https://github.com/techilounge/resolveops-ai/pull/1) | [run 37970857542](https://github.com/techilounge/resolveops-ai/actions/runs/37970857542) — success | APPROVED (`art_nkO6paNO`, Obvious project record) | **Yes** — `b2ab034` | 11/11 Vitest in `src/lib/assessment.test.ts`; `npm run check` green |
| TASK-02 | feat/read-only-diagnostics | [#2](https://github.com/techilounge/resolveops-ai/pull/2) | [run 37971154465](https://github.com/techilounge/resolveops-ai/actions/runs/37971154465) — success | APPROVED (`art_V7Xhwm7l`, Obvious project record) | **Yes** — `bd5ac6f` | Pester 17/17 fixture-only (PowerShell 7.4.6 + Pester 5.7.1 on Linux); `npm run check` green |
| TASK-03 | feat/remediation-proposal | [#3](https://github.com/techilounge/resolveops-ai/pull/3) | [run 37974491047](https://github.com/techilounge/resolveops-ai/actions/runs/37974491047) — success | APPROVED (`art_7Gcx5zJ6`, Obvious project record) | **Yes** — `a0f342b` | 18/18 Vitest in `src/lib/proposal.test.ts`; `npm run check` green |

Totals at `main` = `a0f342b`: **32/32 Vitest**, strict `tsc -b`, production build — green. Pester runs outside Node CI by design; its 17/17 fixture-only result is documented in `docs/DIAGNOSTIC-RUNBOOK.md`.

---

## Phase 0 additions — PROD-003/004/006 (recorded 2026-10-09)

| Addition | Where | Direct evidence |
|---|---|---|
| npm-workspaces monorepo (`apps/web`, `apps/api`, `apps/worker`, `packages/domain`, `packages/shared`) — PROD-003 | PR [#6](https://github.com/techilounge/resolveops-ai/pull/6), merged `4a35873` | `git log origin/main` shows `4a35873 build: adopt npm workspaces monorepo layout (PROD-003) (#6)`; CI run [37998634762](https://github.com/techilounge/resolveops-ai/actions/runs/37998634762) — success on `main` |
| Shared contract layer + `/healthz` (Zod DTOs, error taxonomy, pagination envelope, TenantContext, RESERVED_ROUTES) — PROD-004 | PR [#7](https://github.com/techilounge/resolveops-ai/pull/7), merged `f242471` | `git log origin/main` shows `f242471 feat: add shared contract layer and API health endpoint (PROD-004) (#7)`; CI run [38001820672](https://github.com/techilounge/resolveops-ai/actions/runs/38001820672) — success on `main` |
| Route map (Blueprint §4 routed-app IA + §11 API route surface, cross-checked against `packages/shared/src/route-map.ts`) — PROD-006 | `docs/ROUTE-MAP.md` — this PR | Scripted cross-check: 20/20 method+path pairs and 13/13 reserved phases match `route-map.ts` (script + output in the PR body); unimplemented routes marked reserved/planned |
| Design-token transcription (palette, typography, spacing, radii, shadows from `apps/web/src/style.css`) — PROD-006 | `docs/DESIGN-TOKENS.md` — this PR | Values transcribed from `apps/web/src/style.css` @ `f242471`; the file is byte-identical before and after this PR (docs-only diff) |

Totals at `main` = `f242471` (verified locally on 2026-10-09, Node v20.20.2 sandbox — the audit's compatibility note; CI Node 22 is the enforcement point): **77/77 Vitest across 13 test files**, strict `tsc -b`, production build — green.

---

## Phase 0 gate close-out — decisions recorded 2026-10-09

At the Phase 0 gate review on 2026-10-09, TechiLounge ratified three decisions. The docs-only PR `docs/phase0-gate-ratification` lands their mechanical follow-through:

| # | Gate decision | Where recorded | Direct evidence |
|---|---|---|---|
| 1 | ADR-001…008 ratified as **Accepted** | `docs/adr/ADR-001…008` — each status line flipped, with the ratification note "Ratified as Accepted at the Phase 0 gate review, 2026-10-09 (TechiLounge)" | The eight `docs/adr/` files in this PR; `git diff --name-only origin/main..HEAD` shows docs-only paths |
| 2 | PROD-005 descoped CI items — ESLint job (new dev deps), secrets scanning, `npm audit` (drop the blanket `--no-audit`), API `/healthz` smoke test — **folded into Phase 1 tooling** per gate decision | This entry; Phase 1 planning must include them | Descoping recorded in PR [#8](https://github.com/techilounge/resolveops-ai/pull/8) ("Deliberately out of scope" section), merged `8406c88`; no CI files changed by this PR |
| 3 | Blueprint §11 gaps **fixed in repo docs** per gate decision — `GET /api/v1/jobs/:id` added to the API route table; Knowledge/Reports/Account rows added to the routed-app IA table | `docs/ROUTE-MAP.md` §2.2 and §3.2, with the §2.4/§3.3 notes amended to point at their resolution | Additions carry gate provenance ("Added at the Phase 0 gate review, 2026-10-09 — resolves the job-status gap noted at PROD-006"); gaps found at PROD-006 (PR [#9](https://github.com/techilounge/resolveops-ai/pull/9)) |

**Blueprint incorporation note:** the Blueprint artifact itself (`art_JDTNp9NS`) is **not** amended by repo docs — these fixes live in the repo only. Incorporating the gate-decided rows into Blueprint §4 (IA) and §11 (API routes) remains open for a future Blueprint revision.

**Do not update statuses without direct evidence.** Each row above cites its merge SHA, its post-merge CI run on `main`, and its independent review verdict. Distinguish PR opened, approved, and merged — all three are complete for TASK-01/02/03.


---

## Phase 1 Part A — scoped API deltas as implemented (recorded 2026-10-11)

Phase 1 spec §6 requires the three deltas to be repeated at implementation time. Recorded here as shipped on branch `feat/p1-scoped-api` (P1-4):

| Delta | Spec wording (§6) | As implemented | Direct evidence |
|---|---|---|---|
| **D1 — assignments** | `incidents.assignee_user_id` + an `audit_events` row per assignment change, not a separate assignments table | `assignee_user_id` column shipped in migration `002_incidents.sql`; every PATCH that changes the assignee writes `incident.assigned` / `incident.unassigned` (plus the patch-level `incident.updated` row) in the same transaction | `apps/api/src/routes/incidents.ts` (assign/unassign transition block); `apps/api/src/incidents.test.ts` asserts the delta-D1 audit row scoped to the incident id |
| **D2 — route additions** | `POST /api/v1/me/active-organization`, `GET /api/v1/organizations/current/members`, `POST /api/v1/organizations/current/invitations` documented in `docs/ROUTE-MAP.md` as spec-decided additions pending Blueprint §11 incorporation | All three routes shipped, Zod-validated against the shared DTOs, on the shared error envelope with request-id and pagination; switching is audited, roster listing is owner/admin (audited denial), invitations create `status='invited'` memberships with first-login subject binding | `docs/ROUTE-MAP.md` §3.2 rows (this PR); `apps/api/src/routes/{me,members}.ts`; `apps/api/src/tenancy-orgs.test.ts`, `apps/api/src/members-invites.test.ts` |
| **D3 — audit events API-only** | `GET /audit-events` + tests this phase; the `/app/audit` screen follows in a later phase per §4 IA | Route shipped against the dedicated `resolveops_audit_reader` SELECT-only pool (separate connection, least-privilege grant from migration `004`), org-scoped and paginated; denied reads audited through the app pool; zero web UI | `apps/api/src/routes/audit-events.ts`; `apps/api/src/tenancy-orgs.test.ts` (audit authorization + pagination cases) |

Status reconciliation recorded at P1-1 and now consumed by these routes: the shared incident DTO enum is the Blueprint §6 set (`new|triaged|investigating|awaiting_review|resolved|closed`) — the database is the source of truth.

Suite totals at the P1-4 head (fresh-from-empty PostgreSQL 17 in CI and locally): **72/72 apps/api across 5 files**, **62/62 packages/shared**, **42/42 packages/database**, strict `tsc`, ESLint clean, `npm audit` clean. Known issue disclosed to the orchestrator (report-only): the packages/auth audit-reader role bootstrap (`ensureAppRolePassword`) races under parallel suites — a session-scoped advisory lock mitigates it in the test harness, but the upstream fix belongs to packages/auth (P1-3's file, not edited here).
