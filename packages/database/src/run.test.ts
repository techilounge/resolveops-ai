import { mkdtemp, writeFile, rm, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pgDefault from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  MigrationChecksumError,
  computeChecksum,
  orderMigrations,
  runMigrations,
} from './run';
import {
  connectTestDatabase,
  createScratchDatabase,
  dropScratchDatabase,
  maintenancePool,
  testDatabaseUrl,
} from './support/db';
import type { Pool } from 'pg';

const pg: typeof pgDefault = pgDefault;

// Clean-from-empty proofs run against throwaway databases so the shared test
// database (other files' fixtures) never contaminates them.
describe('runMigrations', () => {
  let pool: Pool | undefined;
  let maintenance: Pool | undefined;

  beforeAll(async () => {
    pool = await connectTestDatabase();
    if (!pool) return;
    maintenance = maintenancePool(testDatabaseUrl());
  });

  afterAll(async () => {
    await pool?.end();
    await maintenance?.end();
  });

  it('orders migration files lexically and ignores non-SQL entries', () => {
    expect(
      orderMigrations(['010_z.sql', '002_a.sql', 'README.md', '001_a.sql', 'notes.txt']),
    ).toEqual(['001_a.sql', '002_a.sql', '010_z.sql']);
  });

  it('checksums file content as sha256 (stable, hex)', () => {
    expect(computeChecksum('hello')).toHaveLength(64);
    expect(computeChecksum('hello')).toBe(computeChecksum('hello'));
    expect(computeChecksum('hello')).not.toBe(computeChecksum('hello '));
  });

  it('applies clean from empty twice — the second run applies nothing', async () => {
    if (!pool || !maintenance) return;
    const scratch = `resolveops_runner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await createScratchDatabase(maintenance, scratch);
    const target = new pg.Pool({ connectionString: replaceDbName(testDatabaseUrl(), scratch) });
    try {
      const first = await runMigrations({ pool: target });
      const second = await runMigrations({ pool: target });

      expect(first.applied).toEqual([
        '001_organizations_users_memberships.sql',
        '002_incidents.sql',
        '003_incident_comments.sql',
        '004_audit_events.sql',
        '005_app_sessions.sql',
      ]);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(first.applied);

      // Applied exactly once: re-running must not duplicate schema objects or
      // bookkeeping rows (idempotent-from-empty).
      const recorded = await target.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      );
      expect(recorded.rows.map((row) => row.name)).toEqual(first.applied);
    } finally {
      await target.end();
      await dropScratchDatabase(maintenance, scratch);
    }
  });

  it('fails closed on a checksum mismatch and applies nothing new', async () => {
    if (!pool || !maintenance) return;
    const dir = await copyMigrationsToTempDir();
    const scratch = `resolveops_runner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await createScratchDatabase(maintenance, scratch);
    const target = new pg.Pool({ connectionString: replaceDbName(testDatabaseUrl(), scratch) });
    try {
      await runMigrations({ pool: target, migrationsDir: dir });

      // Tamper with an already-applied migration.
      await writeFile(path.join(dir, '002_incidents.sql'), '-- tampered\nSELECT 1;\n', 'utf8');

      let error: unknown;
      try {
        await runMigrations({ pool: target, migrationsDir: dir });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(MigrationChecksumError);
      expect((error as MigrationChecksumError).migration).toBe('002_incidents.sql');

      // Fail closed: history is unchanged, no new migration got applied.
      const recorded = await target.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      );
      expect(recorded.rows.map((row) => row.name)).toEqual([
        '001_organizations_users_memberships.sql',
        '002_incidents.sql',
        '003_incident_comments.sql',
        '004_audit_events.sql',
        '005_app_sessions.sql',
      ]);
    } finally {
      await target.end();
      await dropScratchDatabase(maintenance, scratch);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a recorded migration goes missing from the directory', async () => {
    if (!pool || !maintenance) return;
    const dir = await copyMigrationsToTempDir();
    const scratch = `resolveops_runner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await createScratchDatabase(maintenance, scratch);
    const target = new pg.Pool({ connectionString: replaceDbName(testDatabaseUrl(), scratch) });
    try {
      await runMigrations({ pool: target, migrationsDir: dir });
      await rm(path.join(dir, '003_incident_comments.sql'));

      await expect(runMigrations({ pool: target, migrationsDir: dir })).rejects.toBeInstanceOf(
        MigrationChecksumError,
      );
    } finally {
      await target.end();
      await dropScratchDatabase(maintenance, scratch);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exposes the packaged migrations directory', async () => {
    const files = await readdir(MIGRATIONS_DIR);
    expect(files.sort()).toEqual([
      '001_organizations_users_memberships.sql',
      '002_incidents.sql',
      '003_incident_comments.sql',
      '004_audit_events.sql',
      '005_app_sessions.sql',
    ]);
  });
});

async function copyMigrationsToTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'resolveops-migrations-'));
  for (const name of await readdir(MIGRATIONS_DIR)) {
    await copyFile(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
  }
  return dir;
}

function replaceDbName(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}
