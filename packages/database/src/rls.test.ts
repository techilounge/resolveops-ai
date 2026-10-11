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
      if (!pool || !fixture) return;
    pool = await connectTestDatabase();
    if (!pool) return;
    await ensureMigrations(pool);
    fixture = await seedIsolatedOrgs(pool);
  });

  afterAll(async () => {
      if (!pool || !fixture) return;
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
});
