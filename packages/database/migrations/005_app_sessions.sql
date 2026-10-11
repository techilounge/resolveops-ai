-- 005 — Server-side session store for @fastify/session and the pre-auth OIDC
-- login flow state (Phase 1 Blueprint §4.1, §4.2).
-- Not tenant-owned: a session belongs to a user before any organization
-- context exists (the active org lives inside the session payload), so there
-- is no organization_id and no RLS here. Access is limited to
-- resolveops_app via grants.

CREATE TABLE app_sessions (
  -- Opaque session id (@fastify/session sid).
  sid        text PRIMARY KEY,
  -- Session payload: userId, active organization, membership role,
  -- auth_epoch (Phase 1 Blueprint §4.2).
  sess       jsonb NOT NULL,
  -- Absolute expiry; idle expiry is enforced by the store on read.
  expire     timestamptz NOT NULL,
  -- Copy of users.auth_epoch at issue time; every request validates the
  -- session's epoch against the user's current epoch (§4.2 "Revocation").
  auth_epoch bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Expiry sweeps and idle-timeout enforcement.
CREATE INDEX app_sessions_expire_idx ON app_sessions (expire);

-- Pre-auth window only: state/nonce/PKCE verifier with a short TTL. The OIDC
-- `state` parameter protects the login flow; it is not the app's CSRF
-- mechanism (Phase 1 Blueprint §4.2).
CREATE TABLE login_flow_state (
  state         text PRIMARY KEY,
  nonce         text NOT NULL,
  code_verifier text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The session store needs full CRUD; flow state is created, read once at
-- callback, and deleted (expiry cleanup included). No updates to flow rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON app_sessions TO resolveops_app;
GRANT SELECT, INSERT, DELETE ON login_flow_state TO resolveops_app;
