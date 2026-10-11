-- 004 — Audit events (Phase 1 Blueprint §4.1): append-only, org-scoped.
-- Immutability is enforced by grants, not convention: NO UPDATE/DELETE grant
-- on this table is issued to any login role, ever. The app role appends; only
-- resolveops_audit_reader may read.

CREATE TABLE audit_events (
  id  uuid PRIMARY KEY,
  -- Nullable deliberately: §7 of the Phase 1 Blueprint requires audit rows
  -- for login/logout, which happen before any organization context exists.
  -- Org-scoped events always carry an organization_id and are invisible to
  -- other orgs; user-scoped rows (NULL org) are invisible to every
  -- org-scoped read because the USING clause compares NULL = <org> → NULL.
  organization_id uuid REFERENCES organizations (id),
  -- Nullable for system actors (Phase 1 Blueprint §4.1).
  actor_user_id   uuid REFERENCES users (id),
  action          text NOT NULL,
  target_type     text NOT NULL,
  target_id       text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

-- Audit endpoint lists newest-first per organization.
CREATE INDEX audit_events_org_occurred_idx ON audit_events (organization_id, occurred_at DESC);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  -- Appends from a tenant context must match it; user-scoped (NULL-org)
  -- events may be recorded outside any tenant context.
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid
              OR organization_id IS NULL);

-- Append-only: the app role can record events but cannot read or mutate
-- them. Reading belongs to resolveops_audit_reader alone (Phase 1
-- Blueprint §4.1, "for the audit endpoint").
GRANT INSERT ON audit_events TO resolveops_app;
GRANT SELECT ON audit_events TO resolveops_audit_reader;
