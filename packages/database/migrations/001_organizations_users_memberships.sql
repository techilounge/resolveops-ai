-- 001 — Tenancy roots: organizations, users, memberships.
-- Phase 1 Blueprint §4.1; schema conventions per Production SaaS Blueprint §6
-- (UUID PKs, timestamptz audit columns, required organization_id on
-- tenant-owned rows). Vendor-neutral plain SQL: the final home tracks the
-- Part B provider decision (Phase 1 Blueprint §4.1).

-- Roles are cluster-scoped and must exist before the grants below and in
-- later migrations. Created idempotently so clean-from-empty and repeated
-- applies both succeed. All three login roles are non-superuser, cannot
-- create databases/roles, and have NO BYPASSRLS — least privilege is
-- testable (see src/grants.test.ts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'resolveops_app') THEN
    CREATE ROLE resolveops_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'resolveops_migrator') THEN
    CREATE ROLE resolveops_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'resolveops_audit_reader') THEN
    CREATE ROLE resolveops_audit_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- Schema usage for every login role; CREATE only for the migrator, which is
-- the sole DDL role and is never the app role (Phase 1 Blueprint §4.1).
GRANT USAGE ON SCHEMA public TO resolveops_app, resolveops_migrator, resolveops_audit_reader;
GRANT CREATE ON SCHEMA public TO resolveops_migrator;

CREATE TABLE organizations (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  -- Lifecycle values are a later-phase concern (billing/offboarding, Phase 5);
  -- no enum is invented here.
  status     text NOT NULL DEFAULT 'active',
  -- Placeholder only; billing lands in a later phase.
  plan       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Global identity rows (unique per issuer+subject, Blueprint §4.1). Users are
-- not tenant-owned — one identity may hold memberships in several
-- organizations — so no RLS here; membership rows carry the tenant binding.
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  entra_issuer  text NOT NULL,
  entra_subject text NOT NULL,
  email         text NOT NULL,
  display_name  text NOT NULL,
  -- Bumped to revoke every outstanding session for this user; sessions carry
  -- a copy of the epoch at issue time and are validated against it
  -- (Phase 1 Blueprint §4.2, "Revocation").
  auth_epoch    bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_issuer_subject_unique UNIQUE (entra_issuer, entra_subject)
);

CREATE TABLE memberships (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  role            text NOT NULL
                  CHECK (role IN ('owner', 'admin', 'analyst', 'technician', 'viewer')),
  status          text NOT NULL DEFAULT 'invited'
                  CHECK (status IN ('active', 'invited', 'revoked')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_org_user_unique UNIQUE (organization_id, user_id)
);

-- RLS: deny-by-default without tenant context. `current_setting(..., true)`
-- resolves to NULL when `app.org_id` was never set, and to the empty string
-- on a pooled connection whose `SET LOCAL app.org_id` was reverted by COMMIT
-- (the GUC stays defined but empty). `nullif(..., '')` normalizes both to
-- NULL, so a role without tenant context matches zero rows — "RLS denies
-- silently what middleware misses" (Phase 1 Blueprint §5) — deterministically,
-- independent of connection history. FORCE also binds the table owner (the
-- migrator role), not just members of public.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_isolation ON organizations
  USING (id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant_isolation ON memberships
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Least-privilege grants: Phase 1 creates orgs and reads them back; no
-- endpoint updates or deletes an organization, so no such grant exists.
GRANT SELECT, INSERT ON organizations TO resolveops_app;
-- Invites create rows, acceptance/role changes update them; revocation is a
-- status transition, not a delete.
GRANT SELECT, INSERT, UPDATE ON memberships TO resolveops_app;
