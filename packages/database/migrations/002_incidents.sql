-- 002 — Incidents (Phase 1 Blueprint §4.1).
-- Status enum is the Blueprint §6 set: new, triaged, investigating,
-- awaiting_review, resolved, closed. Severity mirrors the shared contract
-- (`IncidentSeveritySchema` in packages/shared: high | medium | low).
-- `version` supports optimistic concurrency; `assignee_user_id` implements
-- delta D1 — assignment is an audited transition on the incident row, there
-- is NO assignments table (Phase 1 Blueprint §6, delta D1).

CREATE TABLE incidents (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'triaged', 'investigating', 'awaiting_review', 'resolved', 'closed')),
  severity         text NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  -- Nullable: an incident may be unassigned. References the global identity
  -- table; tenant scoping flows through the incident's organization_id.
  assignee_user_id uuid REFERENCES users (id),
  created_by       uuid NOT NULL REFERENCES users (id),
  -- Optimistic concurrency: PATCH must assert the version it observed.
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- FK target for tenant-consistent composite references from other
  -- tenant-owned rows (Blueprint §6: e.g. incident_comments
  -- (organization_id, incident_id) references this constraint).
  CONSTRAINT incidents_org_id_unique UNIQUE (organization_id, id)
);

-- List endpoint default ordering (stable, newest first) and assignee filter.
CREATE INDEX incidents_org_created_at_idx ON incidents (organization_id, created_at DESC);
CREATE INDEX incidents_org_assignee_idx ON incidents (organization_id, assignee_user_id)
  WHERE assignee_user_id IS NOT NULL;

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY incidents_tenant_isolation ON incidents
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Phase 1 surface: list/read/create/update. No endpoint deletes an incident,
-- so no DELETE grant exists. Grant changes are audited schema decisions, not
-- conveniences.
GRANT SELECT, INSERT, UPDATE ON incidents TO resolveops_app;
