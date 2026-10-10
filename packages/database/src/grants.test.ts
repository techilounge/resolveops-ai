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
 * Role/grant matrix, least privilege made testable (Phase 1 Blueprint §4.1):
 * resolveops_app is DML-only with no BYPASSRLS and no DDL; audit_events is
 * append-only by grants — the app can INSERT but never read, UPDATE, or
 * DELETE it; reading belongs to resolveops_audit_reader; DDL belongs to
 * resolveops_migrator, never the app.
 */
describe('least-privilege roles and grants', () => {
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

  describe('resolveops_app cannot mutate audit_events (immutability by grants)', () => {
    it('UPDATE audit_events is denied', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'UPDATE audit_events SET action = $2 WHERE id = $1',
        [randomUUID(), 'tampered'],
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('DELETE audit_events is denied', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'DELETE FROM audit_events WHERE id = $1',
        [randomUUID()],
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('TRUNCATE audit_events is denied', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'TRUNCATE audit_events',
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('SELECT audit_events is denied — reading belongs to the audit reader', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        'SELECT id FROM audit_events',
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('INSERT audit_events succeeds — the append path the API uses', async () => {
      if (!pool || !fixture) return;
      const result = await runAs(
        pool!,
        { role: 'resolveops_app', orgId: fixture.orgAId },
        `INSERT INTO audit_events (id, organization_id, actor_user_id, action, target_type, target_id)
         VALUES ($1, $2, $3, 'incident.updated', 'incident', $4)`,
        [randomUUID(), fixture.orgAId, fixture.userAId, fixture.incidentAId],
      );
      expect(result.rowCount).toBe(1);
    });
  });

  describe('resolveops_app cannot DDL', () => {
    it('CREATE TABLE is denied', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app' },
        'CREATE TABLE should_not_exist (id integer)',
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('ALTER TABLE is denied', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_app' },
        'ALTER TABLE incidents ADD COLUMN should_not_exist integer',
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('DROP TABLE is denied', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(pool!, { role: 'resolveops_app' }, 'DROP TABLE incidents');
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('migration bookkeeping (schema_migrations) is not readable by the app role', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(pool!, { role: 'resolveops_app' }, 'SELECT name FROM schema_migrations');
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('role attributes are least privilege', () => {
    it('all login roles are non-superuser, non-creator, no BYPASSRLS', async () => {
      if (!pool || !fixture) return;
      const result = await pool!.query<{
        rolname: string;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }>(
        `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin
           FROM pg_roles
          WHERE rolname IN ('resolveops_app', 'resolveops_migrator', 'resolveops_audit_reader')
          ORDER BY rolname`,
      );
      expect(result.rows.map((row) => row.rolname)).toEqual([
        'resolveops_app',
        'resolveops_audit_reader',
        'resolveops_migrator',
      ]);
      for (const row of result.rows) {
        expect(row.rolsuper, row.rolname).toBe(false);
        expect(row.rolcreatedb, row.rolname).toBe(false);
        expect(row.rolcreaterole, row.rolname).toBe(false);
        expect(row.rolbypassrls, row.rolname).toBe(false);
        expect(row.rolcanlogin, row.rolname).toBe(true);
      }
    });
  });

  describe('the other two roles do their jobs', () => {
    it('resolveops_migrator holds DDL and can create/drop a scratch table', async () => {
      if (!pool || !fixture) return;
      await runAs(pool!, { role: 'resolveops_migrator' }, 'CREATE TABLE migrator_probe (id integer)');
      await runAs(pool!, { role: 'resolveops_migrator' }, 'DROP TABLE migrator_probe');
    });

    it('resolveops_migrator cannot read tenant rows (FORCE RLS binds the owner; no DML grants)', async () => {
      if (!pool || !fixture) return;
      const promise = runAs(
        pool!,
        { role: 'resolveops_migrator' },
        'SELECT id FROM incidents',
      );
      await expect(promise).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it('resolveops_audit_reader reads audit rows only — every other probe is denied', async () => {
      if (!pool || !fixture) return;
      await runAs(
        pool!,
        { role: 'resolveops_audit_reader', orgId: fixture.orgAId },
        'SELECT id FROM audit_events',
      );

      await expect(
        runAs(pool!, { role: 'resolveops_audit_reader' }, 'SELECT id FROM incidents'),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(
        runAs(pool!, { role: 'resolveops_audit_reader' }, 'SELECT id FROM users'),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(
        runAs(pool!, { role: 'resolveops_audit_reader' }, 'CREATE TABLE audit_probe (id integer)'),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });
  });
});
