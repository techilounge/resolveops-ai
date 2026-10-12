import pgDefault from 'pg';
import type { Pool } from 'pg';
import { connectTestDatabase, ensureMigrations, testDatabaseUrl } from '@resolveops/database/testing';

// `pg` is CommonJS: bind the runtime class under a distinct name so the
// `Pool` *type* import stays in scope for annotations (same pattern as the
// database package's support module).
const pg: typeof pgDefault = pgDefault;

/**
 * Test-only: the app role connects with a password in tests. Production
 * provisions the credential outside the repo (Part B); this password exists
 * only in throwaway local/ephemeral databases.
 */
export const APP_ROLE_TEST_PASSWORD = 'postgres';

export function appRoleDatabaseUrl(connectionString = testDatabaseUrl()): string {
  const url = new URL(connectionString);
  url.username = 'resolveops_app';
  url.password = APP_ROLE_TEST_PASSWORD;
  return url.toString();
}

/** Superuser one-liner: let the app role authenticate with the test password. */
export async function ensureAppRolePassword(superuserPool: Pool): Promise<void> {
  // The advisory lock serializes role bootstrap across parallel vitest
  // workers on a fresh database: concurrent ALTER ROLE on one role races
  // ("tuple concurrently updated") and intermittently fails the first
  // CI job after the postgres service container boots. Session-scoped lock
  // on ONE dedicated connection — the same pattern (and lock key) as the
  // audit-reader password in packages/database/src/support/db.ts.
  const client = await superuserPool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('resolveops-test-role-bootstrap'))");
    try {
      await client.query(
        `ALTER ROLE resolveops_app LOGIN PASSWORD '${APP_ROLE_TEST_PASSWORD}'`,
      );
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('resolveops-test-role-bootstrap'))");
    }
  } finally {
    client.release();
  }
}

export interface AppRolePoolResult {
  /** Pool AS `resolveops_app` — the production connection shape. */
  appRolePool: Pool;
  /** Superuser pool, for test setup/teardown and assertion plumbing. */
  superuserPool: Pool;
}

/**
 * Connects the test database (skips via undefined when no local Postgres —
 * same convention as packages/database), applies migrations, unlocks the app
 * role for password auth, and returns both pools. Auth tests MUST run
 * against the app-role pool: grants and RLS are the system under test.
 */
export async function connectAuthTestDatabase(): Promise<AppRolePoolResult | undefined> {
  const superuserPool = await connectTestDatabase();
  if (!superuserPool) {
    return undefined;
  }
  await ensureMigrations(superuserPool);
  await ensureAppRolePassword(superuserPool);
  const appRolePool = new pg.Pool({
    connectionString: appRoleDatabaseUrl(),
    connectionTimeoutMillis: 3000,
    max: 8,
  });
  try {
    await appRolePool.query('SELECT 1');
  } catch (error) {
    await appRolePool.end().catch(() => {});
    await superuserPool.end().catch(() => {});
    throw new Error('resolveops_app could not connect to the test database', { cause: error });
  }
  return { appRolePool, superuserPool };
}

/**
 * Teardown helper following the PR 22 discipline: silence pool error events
 * (no-op listeners) BEFORE closing, then end. Callers close pools in order
 * (app-role first, then superuser) after their queries have drained.
 */
export function attachNoOpPoolErrorListeners(...pools: Pool[]): void {
  for (const pool of pools) {
    pool.on('error', () => {});
  }
}
