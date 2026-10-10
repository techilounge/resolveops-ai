# @resolveops/database

Phase 1 database foundation: numbered plain-SQL migrations, restrictive row-level
security, least-privilege roles, and a fail-closed migration runner. The SQL is
vendor-neutral; its final home tracks the Part B managed-provider decision.

## Layout

```
migrations/   001..005 numbered SQL, applied lexically, checksummed
src/run.ts    the runner (advisory lock, one transaction per file)
src/index.ts  package surface (runner + test support re-exports)
src/support/  test helpers (never imported by runtime code)
```

## Running the tests

The suite talks to a real PostgreSQL (major version 17). Locally:

```sh
docker run -d --name resolveops-pg -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=resolveops_test postgres:17
npx vitest run packages/database
```

Connection config: `DATABASE_URL` if set (default
`postgresql://postgres:postgres@localhost:5432/resolveops_test`).

Behavior when nothing is listening:

- `DATABASE_URL` set but unreachable → tests **fail loudly**. CI
  (`.github/workflows/database.yml`) relies on this.
- No `DATABASE_URL` (local default) → database-dependent tests **skip** with a
  console note, so `npm run check` works offline.

CI runs against a `postgres:17` service container, so a green run always
exercised real PostgreSQL.

## Conventions

- UUID primary keys; `organization_id` required on tenant-owned rows;
  `timestamptz` audit columns.
- Tenant FKs are composite, e.g. `incident_comments (organization_id, incident_id)`
  references `incidents (organization_id, id)` — a comment cannot point at
  another tenant's incident even if RLS were bypassed.
- RLS is `ENABLE`d and `FORCE`d on every tenant-owned table; policies read
  `current_setting('app.org_id', true)` — **no context matches zero rows**
  (fail-closed), rather than erroring.
- Roles: `resolveops_app` (login, DML only, no `BYPASSRLS`, no DDL),
  `resolveops_migrator` (DDL), `resolveops_audit_reader` (SELECT on
  `audit_events` only). `audit_events` receives **no** UPDATE/DELETE grants —
  immutability is enforced by grants, not convention.

## Runner guarantees

1. Lexical file order; non-SQL files ignored.
2. Per-file SHA-256 recorded in `schema_migrations` at apply time.
3. `pg_advisory_lock` serializes concurrent runners.
4. One transaction per migration; `COMMIT` records the checksum atomically
   with the DDL.
5. Fail-closed: an applied file whose checksum changed, or a recorded file that
   went missing, aborts before applying anything.
