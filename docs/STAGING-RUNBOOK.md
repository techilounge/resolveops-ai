# Staging runbook — Phase 1 Part B

Blueprint: Phase 1 spec §4.2, §4.6, §9 (art_DxKZGGyf). Scope: real Entra OIDC,
managed Supabase Postgres (US region), staging API deployment, and the live
E2E that closes P1-9. Decisions below were approved by the owner (2026-10-12).

## What ships in the repo

| File | Purpose |
|---|---|
| `packages/auth/src/entra-idp.ts` | Real issuer adapter on the `OidcAdapter` seam (Authorization Code + PKCE S256, JWKS-verified tokens) |
| `apps/api/src/server.ts` | Boot wiring: `AUTH_PROVIDER=stub\|entra`, `APP_DATABASE_URL`, `PUBLIC_BASE_URL` |
| `packages/database/src/cli.ts` | Environment-driven migration runner entry point |
| `Dockerfile.api` | API runtime image (runs sources via tsx; env-configured) |
| `.github/workflows/staging-deploy.yml` | Manual, gated deploy: migrate → build/push → deploy → health check |
| `e2e/staging-live.ts` | Operator-assisted live E2E (two orgs, P1-7 matrix, revocation) |

## One-time setup

### 1. Supabase Postgres (US region)

- Create the project in a **US region** (spec §9.1).
- From *Project settings → Database*, capture:
  - the **direct** connection string (session mode) → this is the migrator's
    `DATABASE_URL`;
  - the **transaction-pooler** connection string → the app runtime's
    `APP_DATABASE_URL`. The RLS context is `SET LOCAL`-per-transaction, so
    transaction-mode pooling is safe by construction (spec §2).
- Provisioning note: RLS and role grants are created by the migrations
  themselves; nothing is configured by hand in the Supabase console.
  Run against a *scratch* project first if you want a dry run — migrations are
  forward-only; there is no down path.

### 2. Entra ID dedicated development tenant (vendor-owned)

- Register an app: **single-tenant** accounts only (spec §9.2).
- Redirect URI: `https://<staging-host>/api/v1/auth/callback`
  — the API builds `redirect_uri` as `PUBLIC_BASE_URL` + `/api/v1/auth/callback`
  (`packages/auth/src/routes/auth-routes.ts`). Register it **HTTPS**, exact host.
- Create a client secret; record its **value** only into the GitHub
  Environment secret (step 4) — never into the repo or issue logs.
- Two test accounts in this tenant will be the two org owners for the E2E.

### 3. Staging hostname + TLS

- One DNS name you control (spec §9.3), e.g. `staging.<your-domain>`, A/CNAME
  to the docker host running the API container.
- TLS terminates in front of port 3000 (reverse proxy or cloud LB). The API
  serves `Secure` cookies — HTTPS is mandatory.
- The host needs Docker and the GitHub runner's SSH key authorized.

### 4. GitHub Environment `staging` + secrets

Create environment **`staging`** on the repo (Settings → Environments) and add
exactly these secrets — **references only**; the workflow reads them, GitHub
masks values in logs:

| Secret | Feeds |
|---|---|
| `DATABASE_URL` | migrator job (direct/session connection) |
| `APP_DATABASE_URL` | API runtime container (transaction pooler) |
| `COOKIE_SECRET` | session signing (`openssl rand -base64 48`) |
| `ENTRA_TENANT_ID` | issuer/discovery for `EntraIdp` |
| `ENTRA_CLIENT_ID` | app registration client id |
| `ENTRA_CLIENT_SECRET` | app registration secret |
| `STAGING_BASE_URL` | `PUBLIC_BASE_URL` (redirect_uri) + health-check target |
| `STAGING_SSH_HOST` / `STAGING_SSH_USER` / `STAGING_SSH_KEY` | deploy step |

Optionally protect the environment with required reviewers — the deploy then
waits on a human before anything touches managed infrastructure.

## Deploy

1. Actions → **Staging deploy** → *Run workflow* (on `main` after this PR).
2. Job order is fixed: **migrate** (forward-only, checksummed, advisory-locked)
   → **build-and-push** (GHCR image pinned to the commit SHA) → **deploy**
   (SSH `docker run` with the environment's secret references) → **health
   check** (`/healthz` must return `status: ok` within 60s).
3. Failed deploy? A failed image pull leaves the old container untouched —
   the stop happens immediately before the new run starts.

## First-run verification (closes P1-9)

1. **Automated tier — matrix on the managed database:**
   `DATABASE_URL=<direct connection string> npx vitest run packages/database apps/api`
   from a workstation with repo access. Every P1-7 suite re-runs against
   Supabase Postgres; a pooling/policy divergence fails here first.
2. **Live tier — the operator harness:**
   - In a browser, open `https://<staging>/api/v1/auth/login`, complete the
     real Entra sign-in as test user A; copy the `resolveops.sid` cookie.
     Repeat in a second (private) window as user B.
   - `npx tsx e2e/staging-live.ts --base-url=https://<staging> --cookie=<A> --cookie-b=<B>`
   - It onboards two independent orgs, runs the incident create/edit/comment/
     search flow, then asserts the full cross-tenant matrix (enumerate, view,
     edit, comment, search-inference, guessed UUID, foreign org switch, 403
     audit) and session revocation (logout → 401 on the dead session, user B
     unaffected). Non-zero exit on any violation; transcript is the evidence.
3. **Recorded demo:** capture in the browser — sign-in on the real tenant,
   onboarding both orgs, incident create/edit/comment/search as both users,
   the denial path (user A opening user B's incident URL → 404), and a
   logout/revocation. Store per the master prompts' evidence conventions.

## Rollback

- **App:** redeploy the previous image — the workflow tags images by commit
  SHA, so run the previous SHA's image manually on the host, or dispatch the
  workflow from the previous commit. No DB action required.
- **Database:** forward-only by design (spec §4.1). If a migration must be
  reversed, restore from Supabase's PITR backup and re-run migrations — a
  human decision, never an automatic one.

## Security notes

- No secret values live in the repo, workflow file, container image, or CI
  logs (GitHub masks environment-secret values automatically).
- `audit_events` is append-only by grants; staging runs the same role set as
  any production deployment would.
- The deploy workflow is `workflow_dispatch`-only and can be environment-
  protected; who dispatched what is in the Actions history.
