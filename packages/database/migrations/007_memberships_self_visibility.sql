-- 007 — Memberships self-visibility (Phase 1 spec §4.3, the "memberships
-- tension" resolution).
--
-- The API must list a user's own memberships across ALL organizations for
-- GET /api/v1/me (profile + org selector), but the org-scoped isolation
-- policy (003) only shows rows when app.org_id is set — a pre-selection
-- request has no org context. This policy adds a permissive SELECT-only
-- policy: a user sees the rows WHERE user_id = the acting app.user_id.
--
-- Properties (all asserted in rls.test.ts):
-- - SELECT visibility is the OR of permissive policies, so a caller with an
--   org context still sees the whole org roster (member listing keeps working
--   inside withTenantContext), and a caller with only app.user_id sees
--   exactly their own rows — never another user's, in any org.
-- - Writes gain no new path: a FOR SELECT policy contributes no USING/WITH
--   CHECK to INSERT/UPDATE/DELETE, so those remain governed solely by the
--   org-scoped isolation policy. With no org context, writes are denied or
--   filtered exactly as before.
-- - Deny-by-default is preserved: an un-set app.user_id makes the policy
--   evaluate to NULL, matching nothing.
--
-- The comparison uses nullif(..., '') because `current_setting` with
-- `missing_ok` returns '' (empty string), not NULL, for an unset custom GUC.
CREATE POLICY memberships_self_visibility ON memberships
  FOR SELECT
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
