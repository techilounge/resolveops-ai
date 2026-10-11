import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pgDefault from 'pg';
import type { Pool } from 'pg';

// `pg` is CommonJS: bind the runtime class under a distinct name so the
// `Pool` *type* import stays in scope for annotations.
const pg: typeof pgDefault = pgDefault;

/** Packaged migrations directory — resolved relative to this module. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Session-level advisory lock key serializing concurrent runners against the
 * same database (e.g. parallel Vitest workers, or an app boot racing a
 * deploy script). Arbitrary fixed bigint; only uniqueness matters.
 */
const ADVISORY_LOCK_KEY = 721834826492;

export interface RunMigrationsOptions {
  /** Pool to run against. The pool is not closed by the runner. */
  pool: Pool;
  /** Defaults to the packaged `migrations/` directory. */
  migrationsDir?: string;
}

/** Names of migrations applied by this run, and ones skipped (already recorded). */
export interface RunMigrationsResult {
  applied: string[];
  skipped: string[];
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

/**
 * Fail-closed drift: a recorded migration's file changed (checksum mismatch)
 * or disappeared from the directory. The runner refuses to proceed either
 * way — schema history and the directory must agree (Phase 1 Blueprint §4.1).
 */
export class MigrationChecksumError extends Error {
  readonly migration: string;

  constructor(migration: string, detail: string) {
    super(`Migration drift on ${migration}: ${detail}`);
    this.name = 'MigrationChecksumError';
    this.migration = migration;
  }
}

/** sha256 of the file content — the checksum recorded in schema_migrations. */
export function computeChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Lexical order over `.sql` filenames. Migrations are zero-padded
 * (001_, 002_, ...) so lexical order equals numeric order; `sort()` is
 * deterministic byte order, unaffected by locale.
 */
export function orderMigrations(fileNames: string[]): string[] {
  return fileNames.filter((name) => name.endsWith('.sql')).sort();
}

/** Load and order migration files from a directory. */
export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const ordered = orderMigrations(entries);
  return Promise.all(
    ordered.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: computeChecksum(sql) };
    }),
  );
}

/**
 * Apply pending migrations.
 *
 * - Lexical order; one transaction per migration (apply + record together,
 *   so a failed migration leaves no bookkeeping row).
 * - A session-level advisory lock serializes concurrent runners; released
 *   in `finally` (a dropped connection releases it implicitly).
 * - Fail closed on checksum mismatch or a recorded file gone missing, before
 *   applying anything new.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { pool } = options;
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;

  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text PRIMARY KEY,
         checksum   text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const migrations = await loadMigrationFiles(migrationsDir);
    const recorded = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(recorded.rows.map((row) => [row.name, row.checksum]));

    // Drift check runs before any new apply: history must match the
    // directory exactly — nothing missing, nothing rewritten.
    for (const file of migrations) {
      const recordedChecksum = applied.get(file.name);
      if (recordedChecksum === undefined) continue;
      if (recordedChecksum !== file.checksum) {
        throw new MigrationChecksumError(
          file.name,
          `checksum mismatch — recorded ${recordedChecksum}, file now ${file.checksum}`,
        );
      }
    }
    for (const [name] of applied) {
      if (!migrations.some((file) => file.name === name)) {
        throw new MigrationChecksumError(
          name,
          'recorded in schema_migrations but missing from the migrations directory',
        );
      }
    }

    const result: RunMigrationsResult = { applied: [], skipped: [] };
    for (const file of migrations) {
      if (applied.has(file.name)) {
        result.skipped.push(file.name);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file.name, file.checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        // Roll back the failed migration, then surface the original error —
        // never swallowed. If the connection is dead the rollback itself
        // fails; the error below is still the one that matters.
        try {
          await client.query('ROLLBACK');
        } catch {
          /* original error propagates */
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${file.name} failed: ${message}`, { cause: err });
      }
      result.applied.push(file.name);
    }
    return result;
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    } finally {
      client.release();
    }
  }
}

/** Convenience pool from a connection string (env-provided, never a secret here). */
export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString });
}
