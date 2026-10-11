import { randomUUID } from 'node:crypto';
import pgDefault from 'pg';
import type { Pool, QueryResult } from 'pg';
import { runMigrations } from '../run';

// `pg` is CommonJS: bind the runtime class under a distinct name so the
// `Pool` *type* import stays in scope for annotations.
const pg: typeof pgDefault = pgDefault;

/**
 * Test connection config: env-provided, with a localhost default matching the
 * documented docker one-liner in the package README and the CI service
 * container (postgres:17, postgres/postgres, resolveops_test). No secrets —
 * this is a throwaway local/ephemeral database.
 */
export const DEFAULT_TEST_URL = 'postgresql://postgres:postgres@localhost:5432/resolveops_test';

export function testDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_TEST_URL;
}

/**
 * Connect to the test database, or return undefined when there is nothing to
 * talk to. An explicitly-set DATABASE_URL that is unreachable is an error —
 * CI (database.yml) must fail loudly, never silently skip. Only the
 * no-DATABASE_URL local default degrades to a skip (documented in README).
 */
export async function connectTestDatabase(): Promise<Pool | undefined> {
  const connectionString = testDatabaseUrl();
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000, max: 8 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (err) {
    // Cleanup of a pool that never connected; the connect error below is the
    // one that carries information.
    await pool.end().catch(() => {});
    if (process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is set but the database is unreachable', { cause: err });
    }
    console.warn(
      '[database] No local Postgres at the default URL — skipping database tests. ' +
        'Start one per the package README (docker run postgres:17) or set DATABASE_URL.',
    );
    return undefined;
  }
}

export interface RunAsOptions {
  /** Role to impersonate for the statement (superuser `SET ROLE` — no passwords). */
  role: string;
  /** Tenant context; omit for the no-context (deny-by-default) case. */
  orgId?: string;
}

/**
 * Run one statement as `role` inside a transaction with optional
 * `app.org_id` context — the same shape the API uses per request
 * (BEGIN; SET LOCAL; query; COMMIT). `SET LOCAL ROLE` from the superuser
 * test pool makes the current role the impersonated one, so grants and
 * (because the role has no BYPASSRLS) row-level security both apply.
 */
export async function runAs<T extends Record<string, unknown>>(
  pool: Pool,
  options: RunAsOptions,
  sql: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (options.orgId !== undefined) {
      // Transaction-scoped, exactly like the API's `SET LOCAL app.org_id`.
      await client.query('SELECT set_config($1, $2, true)', ['app.org_id', options.orgId]);
    }
    await client.query(`SET LOCAL ROLE ${options.role}`);
    const result = await client.query<T>(sql, values);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection-level failure; the original error propagates */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres SQLSTATE for insufficient privilege (grant denials and RLS WITH CHECK violations). */
export const INSUFFICIENT_PRIVILEGE = '42501';

export interface IsolatedOrgsFixture {
  orgAId: string;
  orgBId: string;
  userAId: string;
  userBId: string;
  incidentAId: string;
  incidentBId: string;
  /** String that appears only in Org B incident data — the search-inference probe. */
  orgBToken: string;
}

/**
 * Seed two demonstrably isolated organizations, mirroring the §7 matrix
 * setup: users with memberships only in their own org (plus one invited
 * membership of user A in Org B, which must stay invisible from Org A
 * context), incidents on both sides, comments, and audit events (org-scoped
 * and a user-scoped NULL-org login event). Seeding runs as the superuser,
 * which bypasses RLS by definition; assertions run as the login roles.
 */
export async function seedIsolatedOrgs(pool: Pool): Promise<IsolatedOrgsFixture> {
  const fixture: IsolatedOrgsFixture = {
    orgAId: randomUUID(),
    orgBId: randomUUID(),
    userAId: randomUUID(),
    userBId: randomUUID(),
    incidentAId: randomUUID(),
    incidentBId: randomUUID(),
    orgBToken: `orpheus-b-${randomUUID()}`,
  };

  const slugSuffix = randomUUID();
  await pool.query(
    `INSERT INTO organizations (id, name, slug) VALUES
       ($1, 'Org A', 'org-a-' || $3),
       ($2, 'Org B', 'org-b-' || $3)`,
    [fixture.orgAId, fixture.orgBId, slugSuffix],
  );
  await pool.query(
    `INSERT INTO users (id, entra_issuer, entra_subject, email, display_name) VALUES
       ($1, 'https://stub.example.com', $3, 'a@example.com', 'User A'),
       ($2, 'https://stub.example.com', $4, 'b@example.com', 'User B')`,
    [fixture.userAId, fixture.userBId, `sub-a-${randomUUID()}`, `sub-b-${randomUUID()}`],
  );
  await pool.query(
    `INSERT INTO memberships (id, organization_id, user_id, role, status) VALUES
       ($1, $2, $4, 'owner', 'active'),
       ($3, $5, $6, 'owner', 'active'),
       ($7, $5, $4, 'viewer', 'invited')`,
    [
      randomUUID(),
      fixture.orgAId,
      randomUUID(),
      fixture.userAId,
      fixture.orgBId,
      fixture.userBId,
      randomUUID(),
    ],
  );
  await pool.query(
    `INSERT INTO incidents (id, organization_id, title, description, status, severity, created_by) VALUES
       ($1, $3, 'Org A disk encryption alert', 'BitLocker suspended on two fleet devices.', 'new', 'high', $5),
       ($2, $4, $6, 'Escalated: printer reports the impossible.', 'investigating', 'low', $7)`,
    [
      fixture.incidentAId,
      fixture.incidentBId,
      fixture.orgAId,
      fixture.orgBId,
      fixture.userAId,
      `Org B printer on fire ${fixture.orgBToken}`,
      fixture.userBId,
    ],
  );
  await pool.query(
    `INSERT INTO incident_comments (id, organization_id, incident_id, author_user_id, body) VALUES
       ($1, $3, $5, $6, 'Org A comment'),
       ($2, $4, $7, $8, 'Org B comment')`,
    [
      randomUUID(),
      randomUUID(),
      fixture.orgAId,
      fixture.orgBId,
      fixture.incidentAId,
      fixture.userAId,
      fixture.incidentBId,
      fixture.userBId,
    ],
  );
  await pool.query(
    `INSERT INTO audit_events (id, organization_id, actor_user_id, action, target_type, target_id) VALUES
       ($1, $3, $5, 'incident.created', 'incident', $7),
       ($2, $4, $6, 'incident.created', 'incident', $8),
       ($9, NULL, $5, 'user.login', 'user', $5)`,
    [
      randomUUID(),
      randomUUID(),
      fixture.orgAId,
      fixture.orgBId,
      fixture.userAId,
      fixture.userBId,
      fixture.incidentAId,
      fixture.incidentBId,
      randomUUID(),
    ],
  );
  return fixture;
}

/** Ensure the packaged migrations are applied (no-op when already applied). */
export async function ensureMigrations(pool: Pool): Promise<void> {
  await runMigrations({ pool });
}

/** Create a uniquely-named scratch database for clean-from-empty runner tests. */
export async function createScratchDatabase(maintenance: Pool, name: string): Promise<void> {
  await maintenance.query(`CREATE DATABASE "${name}"`);
}

export async function dropScratchDatabase(maintenance: Pool, name: string): Promise<void> {
  // WITH (FORCE) closes lingering connections; available since Postgres 13.
  await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

/** Maintenance pool pointed at the `postgres` database on the same server. */
export function maintenancePool(connectionString: string): Pool {
  const url = new URL(connectionString);
  url.pathname = '/postgres';
  return new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
}
