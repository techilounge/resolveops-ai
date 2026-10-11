import type { Pool } from 'pg';
import type { SessionStore } from '@fastify/session';
import { SessionRevokedError } from '../errors';

/** The plugin's callback contract, derived so store.ts can't drift from it. */
type SessionStoreGetCallback = Parameters<SessionStore['get']>[1];
type SessionResult = Parameters<SessionStoreGetCallback>[1];

export interface PostgresSessionStoreOptions {
  /** Pool connecting as the `resolveops_app` role (least privilege, RLS-enforced). */
  pool: Pool;
  /** Idle expiry: sessions untouched for this long stop restoring. */
  idleTtlMs: number;
  /** Absolute-expiry fallback when the session cookie carries no `expires`. */
  defaultTtlMs: number;
}

interface SessionRow {
  sess: Record<string, unknown>;
  issued_epoch: string | null;
  current_epoch: string | null;
}

/**
 * The brief's session-contents allowlist: userId, activeOrgId, membershipRole,
 * authEpoch. The plugin's session object also carries its own bookkeeping
 * (sessionId, encryptedSessionId, cookie) — those are projected OUT at persist
 * time so the stored payload is exactly the allowlist, nothing else.
 */
const SESSION_PAYLOAD_KEYS = ['userId', 'activeOrgId', 'membershipRole', 'authEpoch'] as const;

/**
 * Server-side session store over the `app_sessions` table (migration 005).
 *
 * - Opaque sid PK, JSON payload — nothing session-related lives client-side.
 * - Absolute expiry from the row's `expire` column; idle expiry from
 *   `updated_at`; both enforced on read (DB clock, so stale rows are dead
 *   even if a client replays the cookie).
 * - `auth_epoch` is copied into the row at write time and checked against
 *   `users.auth_epoch` on read: a row that outlives an epoch bump (the
 *   revocation race the epoch exists to close) is destroyed and surfaces as
 *   `SessionRevokedError` → 401 + cleared cookie, never an anonymous restore.
 * - Postgres, not memory: sessions survive restarts and revocations stay
 *   revoked.
 */
export class PostgresSessionStore implements SessionStore {
  private readonly pool: Pool;

  private readonly idleTtlMs: number;

  private readonly defaultTtlMs: number;

  constructor(options: PostgresSessionStoreOptions) {
    this.pool = options.pool;
    this.idleTtlMs = options.idleTtlMs;
    this.defaultTtlMs = options.defaultTtlMs;
  }

  set(sessionId: string, session: unknown, callback: (error?: Error | null) => void): void {
    // Own enumerable props only: the plugin's symbol-keyed internals are
    // excluded, the `cookie` instance serializes through its toJSON.
    const raw = JSON.parse(JSON.stringify(session)) as {
      cookie?: { expires?: string | number | Date };
      authEpoch?: number;
      [key: string]: unknown;
    };
    const expire = resolveAbsoluteExpire(raw.cookie?.expires, this.defaultTtlMs);
    const authEpoch = typeof raw.authEpoch === 'number' ? Math.trunc(raw.authEpoch) : 0;
    // Project to the allowlist before persisting — cookie/sessionId and any
    // other plugin or handler bookkeeping never reaches the database.
    const payload: Record<string, unknown> = {};
    for (const key of SESSION_PAYLOAD_KEYS) {
      if (raw[key] !== undefined) {
        payload[key] = raw[key];
      }
    }
    this.pool
      .query(
        `INSERT INTO app_sessions (sid, sess, expire, auth_epoch, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, now())
         ON CONFLICT (sid) DO UPDATE
           SET sess = EXCLUDED.sess,
               expire = EXCLUDED.expire,
               auth_epoch = EXCLUDED.auth_epoch,
               updated_at = now()`,
        [sessionId, JSON.stringify(payload), expire, authEpoch],
      )
      .then(
        () => callback(null),
        (error: Error) => callback(error),
      )
      .catch((error: Error) => {
        // Node turns `.then(onFulfilled, onRejected)` rejections from the
        // handlers themselves into unhandled rejections — never swallow them.
        throw error;
      });
  }

  get(sessionId: string, callback: SessionStoreGetCallback): void {
    this.pool
      .query<SessionRow>(
        `SELECT s.sess,
                s.auth_epoch AS issued_epoch,
                u.auth_epoch AS current_epoch
           FROM app_sessions s
           LEFT JOIN users u ON u.id = (s.sess ->> 'userId')::uuid
          WHERE s.sid = $1
            AND s.expire > now()
            AND s.updated_at > now() - ($2::double precision * interval '1 millisecond')`,
        [sessionId, this.idleTtlMs],
      )
      .then(async (result) => {
        const row = result.rows[0];
        if (!row) {
          // Missing or expired — the plugin treats this as "no session".
          callback(null, null);
          return;
        }
        if (row.current_epoch !== null && Number(row.issued_epoch) !== Number(row.current_epoch)) {
          await this.pool.query('DELETE FROM app_sessions WHERE sid = $1', [sessionId]);
          callback(new SessionRevokedError());
          return;
        }
        // The payload was projected to the allowlist at write time (set());
        // the JSONB round-trip is untyped at this boundary by nature.
        callback(null, row.sess as unknown as SessionResult);
      })
      .catch((error: Error) => callback(error));
  }

  destroy(sessionId: string, callback: (error?: Error | null) => void): void {
    this.pool
      .query('DELETE FROM app_sessions WHERE sid = $1', [sessionId])
      .then(
        () => callback(null),
        (error: Error) => callback(error),
      )
      .catch((error: Error) => {
        throw error;
      });
  }
}

function resolveAbsoluteExpire(cookieExpires: string | number | Date | undefined, fallbackTtlMs: number): Date {
  if (cookieExpires !== undefined && cookieExpires !== null) {
    const parsed = cookieExpires instanceof Date ? cookieExpires : new Date(cookieExpires);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(Date.now() + fallbackTtlMs);
}
