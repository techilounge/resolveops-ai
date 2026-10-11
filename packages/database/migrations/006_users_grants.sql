-- 006 — Login identity grants (Phase 1 Blueprint §4.2).
--
-- The auth layer (packages/auth) must find or create the users row at login
-- from the ID token's (issuer, subject) and read the user's auth_epoch on
-- every session-load. Migration 001 granted the app role nothing on users —
-- correct for a wave that had no login flow, but login cannot work without
-- these grants. Least privilege: SELECT (identity lookup + epoch check),
-- INSERT (first-login provisioning), UPDATE (login-time profile refresh and
-- auth_epoch bump on revocation). users is a global identity table by design
-- (no organization_id, no RLS — see 001): tenant isolation for user rows is
-- enforced at the API layer via memberships, never by direct user reads.

GRANT SELECT, INSERT, UPDATE ON users TO resolveops_app;
