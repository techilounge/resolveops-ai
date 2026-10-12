import { pathToFileURL } from 'node:url';
import pgDefault from 'pg';
import { runMigrations } from './run';

// `pg` is CommonJS: bind the runtime class under a distinct name so the
// Pool type stays in scope for annotations (same pattern as run.ts).
const pg: typeof pgDefault = pgDefault;

/**
 * Migration connection policy (Phase 1 Blueprint §4.6): DATABASE_URL is the
 * direct (session-mode) connection — DDL, role creation, and the advisory
 * lock want a stable session. The transaction-pooler path (APP_DATABASE_URL)
 * is reserved for the app runtime. Either alone still works in local dev,
 * where only one URL exists.
 */
export function resolveMigrateUrl(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.DATABASE_URL;
  if (direct !== undefined && direct.length > 0) return direct;
  const pooled = env.APP_DATABASE_URL;
  if (pooled !== undefined && pooled.length > 0) return pooled;
  throw new Error('Missing database connection: set DATABASE_URL (direct) or APP_DATABASE_URL.');
}

/**
 * Applies pending migrations and logs the result. Exported (rather than
 * inline) so the E2E harness and CI run the exact same migration path.
 */
export async function main(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  const pool = new pg.Pool({ connectionString: resolveMigrateUrl(env), max: 1 });
  try {
    const result = await runMigrations({ pool });
    log(`[migrate] applied: ${result.applied.length === 0 ? '(none)' : result.applied.join(', ')}`);
    log(`[migrate] skipped (already recorded): ${result.skipped.length === 0 ? '(none)' : result.skipped.join(', ')}`);
  } finally {
    await pool.end();
  }
}

// Run when invoked directly (npx tsx packages/database/src/cli.ts), not when
// imported as a library by the E2E harness.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
