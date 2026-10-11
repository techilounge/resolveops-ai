-- 003 — Incident comments (Phase 1 Blueprint §4.1).
-- The composite tenant FK keeps references tenant-consistent: a comment can
-- only attach to an incident in the same organization (Blueprint §6).

CREATE TABLE incident_comments (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  incident_id     uuid NOT NULL,
  author_user_id  uuid NOT NULL REFERENCES users (id),
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_comments_incident_fk
    FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id)
);

-- Comment threads read newest-first per incident.
CREATE INDEX incident_comments_org_incident_idx
  ON incident_comments (organization_id, incident_id, created_at DESC);

ALTER TABLE incident_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_comments_tenant_isolation ON incident_comments
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Phase 1 surface: read and create. No comment edit/delete endpoint exists.
GRANT SELECT, INSERT ON incident_comments TO resolveops_app;
