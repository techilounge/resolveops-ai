import type { Pool, PoolClient } from 'pg';

/**
 * Runs `fn` inside a transaction scoped to the acting USER (no organization):
 *
 *   BEGIN;
 *   SET LOCAL app.user_id = <userId>;
 *   fn(client);
 *   COMMIT;
 *
 * This is the /me read path. Migration 007's self-visibility policy matches
 * membership rows on `app.user_id`, so profile-level queries see the caller's
 * own memberships in every organization without any org context — the exact
 * hole the org-scoped policy (003) leaves before an organization is selected.
 * The user id comes only from the server-side session, never from a request
 * body. Everything the mirror rule `withTenantContext` enforces for org
 * reads applies here at the user grain: transaction-scoped, `SET LOCAL`
 * reverted at commit, RLS still deny-by-default when the setting is absent.
 */
export async function withSelfContext<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
