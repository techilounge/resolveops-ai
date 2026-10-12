import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INSUFFICIENT_PRIVILEGE,
  type IsolatedOrgsFixture,
  connectTestDatabase,
  ensureMigrations,
  runAs,
  seedIsolatedOrgs,
} from './support/db';
import type { Pool } from 'pg';


/**
 * RLS negative matrix at the SQL layer (Phase 1 Blueprint §4.1, §7). The
 * API-level matrix over HTTP is task P1-7; this proves the database layer
 * itself: without `SET LOCAL app.org_id` the app role reads zero tenant
 * rows, and with Org A context no Org B row is enumerable, readable,
 * writable, or inferable by search — even by guessed UUID.
 */
describe('row-level security tenant matrix', () => {
  let pool: Pool | undefined;
  let fixture: IsolatedOrgsFixture;

  beforeAll(async () => {
    pool = await connectTestDatabase();
    if (!pool) return;
    await ensureMigrations(pool);
    fixture = await seedIsolatedOrgs(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('deny-by-default without tenant context', () => {
    const tenantTables = ['organizations', 'memberships', 'incidents', 'incident_comments'];

    it.each(tenantTables)(
      '%s matches zero rows for resolveops_app without SET LOCAL',
      async (table) => {
        if (!pool || !fixture) return;
        const result = await runAs<{ count: string }>(
          pool!,
          { role: 'resolveops_app' },
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        expect(result.rows[0].count).toBe('0');
      },
    );

    // audit_events is absent from the list above on purpose: the app role
    // holds no SELECT grant on it at all (append-only — grants.test.ts proves
    // the denial), so a row count is not the right probe there.

    it('a guessed Org B incident UUID reads zero rows without context', async () => {
      if (!pool || !fixture) return;
      const result = await runAs(
        pool!,
        { role: 'resolveops_app' },
        'SELECT id FROM incidents WHERE id = $1',
        [fixture.incidentBId],
      );
      expect(result.rowCount).toBe(0);
    });
  });

  describe('with Org A context, Org B is invisible and unwritable', () => {
    it('lists only Org A incidents (direct read, list)', async () => {
      if (!pool || !fixture) return;
      const result = await runAs<{ id: string }>(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'SELECT id FROM incidents ORDER BY id',
      );
      expect(result.rows.map((row) => row.id)).toEqual([fixture.incidentAId]);
    });

    it('a guessed Org B incident UUID reads zero rows (direct read by id)', async () => {
      if (!pool || !fixture) return;
      const result = await runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'SELECT id FROM incidents WHERE id = $1',
        [fixture.incidentBId],
      );
      expect(result.rowCount).toBe(0);
    });

    it('sees only Org A organizations and memberships', async () => {
      if (!pool || !fixture) return;
      const orgs = await runAs<{ id: string }>(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'SELECT id FROM organizations',
      );
      expect(orgs.rows.map((row) => row.id)).toEqual([fixture.orgAId]);

      const memberships = await runAs<{ organization_id: string }>(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'SELECT organization_id FROM memberships',
      );
      expect(memberships.rows.map((row) => row.organization_id)).toEqual([fixture.orgAId]);
    });

    it('a search term unique to Org B returns zero rows (no count oracle, no inference)', async () => {
      if (!pool || !fixture) return;
      const result = await runAs<{ count: string }>(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'SELECT count(*)::text AS count FROM incidents WHERE title ILIKE $1',
        [`%${fixture.orgBToken}%`],
      );
      expect(result.rows[0].count).toBe('0');
    });

    it('UPDATE on an Org B incident affects zero rows (edit denial, silently filtered)', async () => {
      if (!pool || !fixture) return;
      const result = await runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'UPDATE incidents SET title = title WHERE id = $1',
        [fixture.incidentBId],
      );
      expect(result.rowCount).toBe(0);
    });

    it('INSERT of an incident for Org B violates row-level security (WITH CHECK)', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        `INSERT INTO incidents (id, organization_id, title, severity, created_by)
         VALUES ($1, $2, 'cross-tenant attempt', 'high', $3)`,
        [randomUUID(), fixture.orgBId, fixture.userAId],
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('INSERT of an Org B membership violates row-level security (WITH CHECK)', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        `INSERT INTO memberships (id, organization_id, user_id, role, status)
         VALUES ($1, $2, $3, 'admin', 'active')`,
        [randomUUID(), fixture.orgBId, fixture.userAId],
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('UPDATE moving an Org A row into Org B violates row-level security (WITH CHECK)', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'UPDATE incidents SET organization_id = $2 WHERE id = $1',
        [fixture.incidentAId, fixture.orgBId],
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('a comment referencing an Org B incident cannot be created from Org A context', async () => {
      if (!pool || !fixture) return;
      // Two denials combine here: RLS hides the Org B incident, and the
      // composite tenant FK (organization_id, incident_id) rejects the
      // reference outright.
      const promise = runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        `INSERT INTO incident_comments (id, organization_id, incident_id, author_user_id, body)
         VALUES ($1, $2, $3, $4, 'should not land')`,
        [randomUUID(), fixture.orgAId, fixture.incidentBId, fixture.userAId],
      );
      await expect(promise).rejects.toThrow();
    });

    it('Org B data is unchanged after every denial', async () => {
      if (!pool || !fixture) return;
      const result = await runAs<{ title: string }>(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgBId },
        'SELECT title FROM incidents WHERE id = $1',
        [fixture.incidentBId],
      );
      expect(result.rows[0].title).toContain(fixture.orgBToken);
    });
  });

  describe('audit event scoping', () => {
    it('the audit reader sees only the context org; NULL-org login events stay invisible to org reads', async () => {
      if (!pool || !fixture) return;
      const orgA = await runAs<{ organization_id: string | null }>(
        pool!,
        { role: 'resolveops_audit_reader', orgId: fixture.orgAId },
        'SELECT organization_id FROM audit_events',
      );
      expect(orgA.rows).toHaveLength(1);
      expect(orgA.rows[0].organization_id).toBe(fixture.orgAId);

      const orgB = await runAs<{ organization_id: string | null }>(
        pool!,
        { role: 'resolveops_audit_reader', orgId: fixture.orgBId },
        'SELECT organization_id FROM audit_events',
      );
      expect(orgB.rows).toHaveLength(1);
      expect(orgB.rows[0].organization_id).toBe(fixture.orgBId);

      const noContext = await runAs(
        pool!,
        { role: 'resolveops_audit_reader' },
        'SELECT organization_id FROM audit_events',
      );
      expect(noContext.rowCount).toBe(0);
    });
  });

  describe('FORCE row-level security binds the table owner too', () => {
    it('row security is enabled and forced on every tenant table', async () => {
      if (!pool || !fixture) return;
      const result = await runAs<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relname IN ('organizations', 'memberships', 'incidents', 'incident_comments', 'audit_events')`,
      );
      expect(result.rows).toHaveLength(5);
      for (const row of result.rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.relforcerowsecurity, row.relname).toBe(true);
      }
    });
  });

  describe('memberships self-visibility (migration 007)', () => {
    it('a caller with only app.user_id sees exactly their own membership rows across orgs', async () => {
      if (!pool || !fixture) return;
      const own = await runAs<{ organization_id: string; user_id: string }>(
        pool!,
        { role: 'resolveops_app', userId: fixture.userAId },
        'SELECT organization_id, user_id FROM memberships',
      );
      // Owner of Org A (active) + the invited membership in Org B — and
      // nothing else, ever.
      expect(own.rows).toHaveLength(2);
      for (const row of own.rows) {
        expect(row.user_id).toBe(fixture.userAId);
      }
    });

    it('cross-user enumeration stays denied — user B sees only their own row', async () => {
      if (!pool || !fixture) return;
      const own = await runAs<{ user_id: string }>(
        pool!,
        { role: 'resolveops_app', userId: fixture.userBId },
        'SELECT user_id FROM memberships',
      );
      expect(own.rows).toHaveLength(1);
      expect(own.rows[0].user_id).toBe(fixture.userBId);
    });

    it('no user context still matches nothing — deny-by-default preserved', async () => {
      if (!pool || !fixture) return;
      const none = await runAs(pool!, { role: 'resolveops_app' }, 'SELECT id FROM memberships');
      expect(none.rowCount).toBe(0);
    });

    it('self-visibility adds no write path — UPDATE under user-only context filters to zero rows', async () => {
      if (!pool || !fixture) return;
      // A FOR SELECT policy contributes no USING clause to UPDATE; the rows
      // the self policy can SEE are still not rows it may TOUCH. With no org
      // context the org-scoped isolation policy filters every row out.
      const update = await runAs(
        pool!,
        { role: 'resolveops_app', userId: fixture.userAId },
        "UPDATE memberships SET role = role WHERE user_id = (SELECT nullif(current_setting('app.user_id', true), '')::uuid)",
      );
      expect(update.rowCount).toBe(0);
    });

    it('self-visibility adds no write path — INSERT with only user context is denied', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app', userId: fixture.userAId },
        `INSERT INTO memberships (id, organization_id, user_id, role, status)
         VALUES ($1, $2, $3, 'viewer', 'invited')`,
        [randomUUID(), fixture.orgAId, fixture.userBId],
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('org-context member listing still sees the full roster — permissive policies OR together', async () => {
      if (!pool || !fixture) return;
      const roster = await runAs<{ user_id: string }>(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgBId },
        'SELECT user_id FROM memberships',
      );
      // Org B owner + the invited Org A user: inside a tenant context the
      // member list keeps seeing every membership of that org.
      expect(roster.rows).toHaveLength(2);
    });
  });
});

/**
 * P1-7 adversarial extension (Phase 1 Blueprint §7): the SQL-layer matrix
 * completed to EVERY tenant-owned table — the original matrix above omitted
 * `incident_comments` (P1-4 addendum) and probes `audit_events` only through
 * the audit-reader role — plus roster-listing negatives without tenant
 * context and per-table guessed-UUID probes.
 */
describe('P1-7 adversarial extension: every tenant table, roster without context', () => {
  let pool: Pool | undefined;
  let fixture: IsolatedOrgsFixture;

  beforeAll(async () => {
    pool = await connectTestDatabase();
    if (!pool) return;
    await ensureMigrations(pool);
    fixture = await seedIsolatedOrgs(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('with Org A context, every tenant-owned table shows zero Org B rows', () => {
    it.each([
      ['incidents', 'resolveops_app'],
      ['incident_comments', 'resolveops_app'],
      ['memberships', 'resolveops_app'],
    ] as const)('%s: Org B rows are invisible (count over organization_id = Org B)', async (table, role) => {
      if (!pool || !fixture) return;
      const result = await runAs<{ count: string }>(
        pool!,
        { role, orgId: fixture.orgAId },
        `SELECT count(*)::text AS count FROM ${table} WHERE organization_id = $1`,
        [fixture.orgBId],
      );
      expect(result.rows[0].count).toBe('0');
    });

    it('audit_events via the audit reader: Org B rows are invisible from Org A context', async () => {
      if (!pool || !fixture) return;
      const result = await runAs<{ count: string }>(
        pool!,
        { role: 'resolveops_audit_reader', orgId: fixture.orgAId },
        'SELECT count(*)::text AS count FROM audit_events WHERE organization_id = $1',
        [fixture.orgBId],
      );
      expect(result.rows[0].count).toBe('0');
    });

    it('audit_events via the app role is a grant denial outright — no read, no count, ever', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'SELECT count(*) FROM audit_events',
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('guessed UUIDs match zero rows in every tenant table', () => {
    it.each([
      ['incidents', 'resolveops_app'],
      ['incident_comments', 'resolveops_app'],
      ['memberships', 'resolveops_app'],
    ] as const)('%s: a guessed uuid matches zero rows from Org A context', async (table, role) => {
      if (!pool || !fixture) return;
      const guessed = randomUUID();
      const result = await runAs(
        pool!,
        { role, orgId: fixture.orgAId },
        `SELECT id FROM ${table} WHERE id = $1`,
        [guessed],
      );
      expect(result.rowCount).toBe(0);
    });

    it('audit_events: a guessed uuid matches zero rows via the audit reader', async () => {
      if (!pool || !fixture) return;
      const result = await runAs(
        pool!,
        { role: 'resolveops_audit_reader', orgId: fixture.orgAId },
        'SELECT id FROM audit_events WHERE id = $1',
        [randomUUID()],
      );
      expect(result.rowCount).toBe(0);
    });

    it('incident_comments: Org B comments are not enumerable from Org A by incident id either', async () => {
      if (!pool || !fixture) return;
      const result = await runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'SELECT id FROM incident_comments WHERE incident_id = $1',
        [fixture.incidentBId],
      );
      expect(result.rowCount).toBe(0);
    });
  });

  describe('roster listing without tenant context (members-route query shape)', () => {
    // The exact query shape the roster route runs (memberships JOIN users) —
    // proven unable to list anything without an org context.
    const ROSTER_SQL = `SELECT m.user_id, u.email, u.display_name, m.role, m.status
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1
          ORDER BY m.created_at ASC, m.user_id ASC`;

    it('with NO tenant context the roster query lists zero rows — no user emails leak', async () => {
      if (!pool || !fixture) return;
      const none = await runAs<{ user_id: string }>(
        pool!,
        { role: 'resolveops_app' },
        ROSTER_SQL,
        [fixture.orgAId],
      );
      // Even with the org id as a BIND PARAMETER (not the RLS setting), the
      // unscoped table contributes no rows: the policy filters memberships
      // to nothing first.
      expect(none.rowCount).toBe(0);
    });

    it('with ONLY the user context (no org), the roster query shows only the caller\'s own row', async () => {
      if (!pool || !fixture) return;
      const own = await runAs<{ user_id: string }>(
        pool!,
        { role: 'resolveops_app', userId: fixture.userBId },
        ROSTER_SQL,
        [fixture.orgBId],
      );
      // User B's own Org B membership — and NOT user A's invited membership
      // in the same org, which the org context would show but the user-only
      // context must not.
      expect(own.rows).toHaveLength(1);
      expect(own.rows[0].user_id).toBe(fixture.userBId);
    });

    it('user-only context cannot enumerate another org\'s roster by org id (007 cross-user negative)', async () => {
      if (!pool || !fixture) return;
      const probed = await runAs<{ user_id: string }>(
        pool!,
        { role: 'resolveops_app', userId: fixture.userAId },
        'SELECT user_id FROM memberships WHERE organization_id = $1',
        [fixture.orgBId],
      );
      // User A holds an invited membership in Org B — visible as their OWN
      // row — but the enumeration attempt returns only rows where
      // user_id = the acting user, so Org B's owner (user B) never appears.
      for (const row of probed.rows) {
        expect(row.user_id).toBe(fixture.userAId);
      }
    });
  });
});
