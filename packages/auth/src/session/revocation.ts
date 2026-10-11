import type { Pool } from 'pg';

/**
 * Revokes every session belonging to a user: bumps `users.auth_epoch` (every
 * request validates the session's epoch copy against it) and deletes the
 * user's session rows in one transaction. The epoch bump is what enforces
 * revocation even if a session row survives (replication lag, races); the
 * delete is the cleanup.
 *
 * Returns the number of session rows deleted. Unknown users are a no-op (0).
 */
export async function revokeUserSessions(pool: Pool, userId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bumped = await client.query<{ auth_epoch: string }>(
      'UPDATE users SET auth_epoch = auth_epoch + 1, updated_at = now() WHERE id = $1 RETURNING auth_epoch',
      [userId],
    );
    if (bumped.rows.length === 0) {
      await client.query('ROLLBACK');
      return 0;
    }
    const deleted = await client.query<{ sid: string }>(
      "DELETE FROM app_sessions WHERE sess ->> 'userId' = $1 RETURNING sid",
      [userId],
    );
    await client.query('COMMIT');
    return deleted.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
