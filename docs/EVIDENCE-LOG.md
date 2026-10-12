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

### Delta D4 — incident-comments API (P1-4 addendum)

The Phase 1 spec §4.4 detail screen requires comments, but §4.3's route enumeration never listed a comments endpoint while migration `003_incident_comments.sql` already carried the table, RLS, and grants. Resolved as a small addendum: `GET|POST /api/v1/incidents/:id/comments` (Zod contracts in `packages/shared/src/comments.ts`, exported from the package index; routes in `apps/api/src/routes/comments.ts`, registered in the resource registry). Both routes run inside `withTenantContext` — the table's RLS policy plus the composite `(organization_id, incident_id)` FK make a foreign-org incident id and a nonexistent one the same zero-row 404, with no enumeration signal. The list is paginated (page/pageSize → limit/offset, `created_at ASC, id ASC` stable ordering) and returns the `IncidentCommentDto` (`authorDisplayName` resolved through the users join via the migration-006 SELECT grant). Creation accepts `{ body: string, 1–10000 }` from any active member; Phase 1 has no comment edit/delete (the migration grants SELECT, INSERT only), so the DTO's `updatedAt` equals `createdAt` today.

**No audit rows for comments — the delta-D4 reading:** the spec §7 audit list (login, logout, org create, role/invite change, incident create/update/assign, denials on sensitive ops) does not include comments, and a comment is already-attributed data rather than an authorization transition — so the routes write no audit event, and a test asserts the org's audit-event count is unchanged by a comment create.

Coverage: happy create/list, validation 400 (empty, oversized, missing, unknown key), foreign/nonexistent incident 404 with zero data echo and no persisted row, page-tiling consistency against a full fetch, replay-stable ordering, per-row `authorDisplayName` join correctness verified against the stored users rows, foreign-org 404 (never an empty list), and unauthenticated 401s. Suite totals after the addendum: **82/82 apps/api across 6 files**; shared/database suites unchanged; strict `tsc`, root ESLint, and `npm audit` clean.

---

## Phase 1 Part B — adversarial cross-tenant security matrix (P1-7, recorded 2026-10-12)

The independent adversarial pass the master prompts require before the human security review (P1-8): attacker, not fixer — route implementations and `apps/web` untouched (`git diff` against `a34cd2b` carries tests, the test harness, and two test-infrastructure fixes only). Branch `feat/p1-tenant-matrix`, PR #28. Every attack in the matrix starts from state proven live (a 200 read, a fresh member, a seeded Org B row) and then demands isolation fail closed.

### The §7 HTTP matrix — `apps/api/src/security-cross-tenant.test.ts` (38 tests)

For every tenant-scoped route (incidents GET/list/PATCH, incident comments, org switch, roster, profile, audit events — including `/api/v1/incidents/:id/comments` per `packages/shared/src/comments.ts`) × {Org B incident id, Org B org id, Org B user id} × {direct read, list, search term existing only in Org B content, PATCH, comment create}:

| Adversarial dimension | Assertion | Result |
|---|---|---|
| Direct foreign-ID access (guessed + real Org B ids) | 404/403, zero Org B data anywhere (ids, titles, counts, emails — token-level leak scan against the raw body) | **held — no leak** |
| Search oracle | a term matching only Org B content returns the empty list shape, not a number (no count oracle; page totals revealed only in the authenticated org's own envelope) | **held** |
| Tenant-ID substitution in bodies | POST/PATCH payloads injecting `organizationId`/`authorUserId` are rejected 400 by strict Zod schemas and write nothing (delta-checked) | **held** |
| Assignment laundering | `PATCH /incidents/:id` assigning Org B's user yields 404/403 and no foreign userId echo | **held** |
| Anonymous / forged-cookie access | 401 on every route; a garbage session cookie is not a session | **held** |
| Denial audits | `authz.denied` rows scoped to the attacker's org where the spec's audit list requires them (verified out of band via superuser SQL) | **held** |

### RLS negative matrix — `packages/database/src/rls.test.ts` + `grants.test.ts` (16 tests added; package now 58/58)

Every tenant-owned table (`incidents`, `incident_comments`, `audit_events`, `memberships`) gets cross-user negatives under the migration-007 session-variable contract, including user A enumerating user B's memberships; roster-shaped listing without tenant context returns zero rows (no ambient-tenant leak); guessed UUIDs behave identically to real foreign ids. Audit immutability is asserted at the **grant** level: `resolveops_app` holds no UPDATE/DELETE on `audit_events` — verified via `aclexplode()` against the catalog, not by attempting a write the grants forbid.

### Invitation-escalation re-proofs — `security-invitation-escalation.test.ts`

A `status='invited'` membership cannot activate tenant access (the active-organization switch re-checks `status='active'`); viewer/admin-owner invitation attempts by a non-admin are 403 with an audited denial and **no membership row created**; a non-owner admin invitation is the positive control proving the denial is the rule, not the route.

### Session-revocation re-proofs — `security-session-revocation.test.ts` (5 tests), all mid-session

Kill the `app_sessions` row out of band after a proven-live 200 → next request 401 and a restarted store (new instance, same Postgres, nothing in memory) restores nothing; bump `users.auth_epoch` while the row still holds the old epoch (the race the epoch exists to close) → 401 and the store destroys the stale row itself; backdate `updated_at` past the idle TTL and backdate `expire` with fresh activity → both 401 (expiry computed from the DB clock, not process memory). Fixation: a cookie value planted before authentication is never adopted — the callback issues a fresh sid, exactly one session row exists for the user, and the planted value grants nothing.

### Rate-limit re-proofs — `security-rate-limit.test.ts`

A live-session flood on `POST /api/v1/incidents` against the production wiring (budget overridden to 30) hits the cliff, every request past it is 429 with the shared envelope, no 5xx leaks from the limiter path, and the flood wrote exactly the requests the limiter allowed (delta-checked against the fixture seed). **Design boundary documented (finding F-2, informational):** the budget is per route (`global: false` in the auth plugin; mutating resource routes and auth routes opt in via route config) — authenticated reads are not throttled at Phase 1 (RLS + session auth are the read control); the assertion pins this so drift is flagged if the design changes.

### Findings register (report-only — the attacker does not patch)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| F-1 | **Medium** | `POST /api/v1/me/active-organization` with a guessed nonexistent organization UUID returns **500 INTERNAL** — the denial-audit insert violates `audit_events.organization_id`'s FK (the org does not exist). No foreign data echoes (body is the generic 500 envelope); the failure is the denial audit write, not the guard. | Documented for the implementation owner (P1-8 / follow-up): audit the denial with `organization_id = NULL` (the same shape `user.login` uses) or reject unknown orgs with 404 before the audit write. Not patched here per attacker discipline. |
| F-2 | Informational | Rate-limit budget is per route; authenticated reads are unthrottled at Phase 1 (see above). | Design boundary pinned by test; revisit at multi-instance scale (Part B limitation already noted in the auth plugin). |

### `ensureAppRolePassword` race — the known issue from P1-4 is now closed upstream

P1-4's entry disclosed (report-only) that `packages/auth`'s test role bootstrap races under parallel workers. Reproduced locally once in two fresh-database full-suite runs (and previously in PR #27's CI on an identical SHA): every worker's `connectAuthTestDatabase` ran `ALTER ROLE resolveops_app LOGIN PASSWORD` concurrently on the virgin catalog ("tuple concurrently updated"). Fixed upstream in the owning package (commit `fix(auth): serialize test role bootstrap with an advisory lock` on this branch) — the minimal session-scoped `pg_advisory_lock` guard on one dedicated connection, mirroring (and sharing the lock key with) the audit-reader bootstrap in `packages/database/src/support/db.ts`. Two consecutive fresh-database full-suite runs after the fix: green (below).

### Suite totals at the P1-7 head — fresh-from-empty PostgreSQL 17, locally and in CI's postgres:17 job

**366/366 across 37 test files** repo-wide; of which **apps/api 131/131 across 10 files** (the four P1-7 suites add 49 over P1-4's 82) and **packages/database 58/58 across 3 files** (+16 over P1-4's 42). The fresh-from-empty gate (drop + recreate, migrations from zero, full suite) was run twice consecutively after the bootstrap fix: 366/366 both times. Strict `tsc`, root ESLint clean; no new npm dependencies; no `apps/web` diff; backend-only work — visual evidence is not applicable (no rendered surface changed).
