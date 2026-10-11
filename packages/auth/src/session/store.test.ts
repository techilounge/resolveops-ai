import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { attachNoOpPoolErrorListeners, connectAuthTestDatabase } from '../testing';
import { PostgresSessionStore } from './store';
import { SessionRevokedError } from '../errors';

// DB-backed store tests follow the PR 22 teardown discipline: no-op error
// listeners on every pool before closing, then ordered pool end. Each test
// no-ops (passes) when no local Postgres is configured — the same skip
// convention as packages/database — while CI (with the service container)
// always has one.

function promisifyGet(store: PostgresSessionStore, sid: string): Promise<{ error: Error | null; session: unknown }> {
  return new Promise((resolve) => {
    store.get(sid, (error, session) => resolve({ error, session }));
  });
}

/** Session-object shape @fastify/session hands the store (cookie included). */
function makeSessionShape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: '00000000-0000-0000-0000-000000000001',
    activeOrgId: null,
    membershipRole: null,
    authEpoch: 2,
    cookie: { expires: new Date(Date.now() + 60_000) },
    ...overrides,
  };
}

describe('PostgresSessionStore', () => {
  let appRolePool: Pool | undefined;
  let superuserPool: Pool | undefined;

  beforeAll(async () => {
    const setup = await connectAuthTestDatabase();
    if (!setup) {
      return;
    }
    attachNoOpPoolErrorListeners(setup.appRolePool, setup.superuserPool);
    appRolePool = setup.appRolePool;
    superuserPool = setup.superuserPool;
  });

  afterAll(async () => {
    await appRolePool?.end();
    await superuserPool?.end();
  });

  it('round-trips a payload through set/get', async () => {
    if (!appRolePool) return;
    const store = new PostgresSessionStore({ pool: appRolePool, idleTtlMs: 30 * 60_000, defaultTtlMs: 60_000 });
    await new Promise<void>((resolve, reject) => {
      store.set('sid-roundtrip', makeSessionShape(), (error) => (error ? reject(error) : resolve()));
    });
    const { error, session } = await promisifyGet(store, 'sid-roundtrip');
    expect(error).toBeNull();
    expect(session).toMatchObject({ userId: '00000000-0000-0000-0000-000000000001', authEpoch: 2 });
  });

  it('persists ONLY the session-contents allowlist (userId, activeOrgId, membershipRole, authEpoch)', async () => {
    if (!appRolePool) return;
    const store = new PostgresSessionStore({ pool: appRolePool, idleTtlMs: 30 * 60_000, defaultTtlMs: 60_000 });
    await new Promise<void>((resolve, reject) => {
      store.set(
        'sid-allowlist',
        makeSessionShape({ sessionId: 'leak-me', encryptedSessionId: 'leak-me-too', sneakyField: 'nope' }),
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const row = await appRolePool.query<{ sess: Record<string, unknown> }>(
      'SELECT sess FROM app_sessions WHERE sid = $1',
      ['sid-allowlist'],
    );
    expect(Object.keys(row.rows[0].sess).sort()).toEqual([
      'activeOrgId',
      'authEpoch',
      'membershipRole',
      'userId',
    ]);
  });

  it('enforces absolute expiry server-side (expired rows restore nothing, ever)', async () => {
    if (!appRolePool) return;
    const store = new PostgresSessionStore({ pool: appRolePool, idleTtlMs: 30 * 60_000, defaultTtlMs: 60_000 });
    await new Promise<void>((resolve, reject) => {
      store.set(
        'sid-expired',
        makeSessionShape({ cookie: { expires: new Date(Date.now() - 1000) } }),
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const first = await promisifyGet(store, 'sid-expired');
    expect(first.error).toBeNull();
    expect(first.session).toBeNull();
    // Repeated reads never resurrect it (enforcement is on every read; row
    // sweeping is the Phase 2 worker's hygiene concern, not a correctness one).
    const second = await promisifyGet(store, 'sid-expired');
    expect(second.session).toBeNull();
  });

  it('enforces idle expiry from updated_at (stale sessions stop restoring)', async () => {
    if (!appRolePool) return;
    const store = new PostgresSessionStore({ pool: appRolePool, idleTtlMs: 30 * 60_000, defaultTtlMs: 60_000 });
    await new Promise<void>((resolve, reject) => {
      store.set('sid-idle', makeSessionShape(), (error) => (error ? reject(error) : resolve()));
    });
    // Simulate inactivity: push updated_at back beyond the idle window.
    await appRolePool.query(
      "UPDATE app_sessions SET updated_at = now() - interval '31 minutes' WHERE sid = $1",
      ['sid-idle'],
    );
    const { error, session } = await promisifyGet(store, 'sid-idle');
    expect(error).toBeNull();
    expect(session).toBeNull();
    // A live row inside the window still restores.
    await new Promise<void>((resolve, reject) => {
      store.set('sid-fresh', makeSessionShape(), (error) => (error ? reject(error) : resolve()));
    });
    const fresh = await promisifyGet(store, 'sid-fresh');
    expect(fresh.session).not.toBeNull();
  });

  it('denies a session whose stored epoch no longer matches users.auth_epoch (revocation)', async () => {
    if (!appRolePool || !superuserPool) return;
    const store = new PostgresSessionStore({ pool: appRolePool, idleTtlMs: 30 * 60_000, defaultTtlMs: 60_000 });
    const userId = '00000000-0000-0000-0000-00000000e001';
    await superuserPool.query(
      `INSERT INTO users (id, entra_issuer, entra_subject, email, display_name, auth_epoch)
       VALUES ($1, 'https://stub.example.com', $2, 'revoked@example.com', 'Revoked User', 3)`,
      [userId, `revoked-sub-${Date.now()}`],
    );
    // Session row copied epoch 2 at write time; the user's epoch is now 3.
    await new Promise<void>((resolve, reject) => {
      store.set(
        'sid-revoked',
        makeSessionShape({ userId, authEpoch: 2 }),
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const { error, session } = await promisifyGet(store, 'sid-revoked');
    expect(error).toBeInstanceOf(SessionRevokedError);
    expect(session).toBeUndefined();
    // The stale row is physically destroyed — no resurrection.
    const rows = await appRolePool.query(
      'SELECT COUNT(*)::int AS n FROM app_sessions WHERE sid = $1',
      ['sid-revoked'],
    );
    expect(rows.rows[0].n).toBe(0);
    await superuserPool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('persists across a simulated restart (a NEW store instance sees the row)', async () => {
    if (!appRolePool) return;
    const first = new PostgresSessionStore({ pool: appRolePool, idleTtlMs: 30 * 60_000, defaultTtlMs: 60_000 });
    await new Promise<void>((resolve, reject) => {
      first.set('sid-restart', makeSessionShape(), (error) => (error ? reject(error) : resolve()));
    });
    const second = new PostgresSessionStore({ pool: appRolePool, idleTtlMs: 30 * 60_000, defaultTtlMs: 60_000 });
    const { error, session } = await promisifyGet(second, 'sid-restart');
    expect(error).toBeNull();
    expect(session).toMatchObject({ userId: '00000000-0000-0000-0000-000000000001' });
  });

  it('destroy removes the row; unknown sids are no-ops', async () => {
    if (!appRolePool) return;
    const store = new PostgresSessionStore({ pool: appRolePool, idleTtlMs: 30 * 60_000, defaultTtlMs: 60_000 });
    await new Promise<void>((resolve, reject) => {
      store.set('sid-del', makeSessionShape(), (error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      store.destroy('sid-del', (error) => (error ? reject(error) : resolve()));
    });
    const rows = await appRolePool.query('SELECT COUNT(*)::int AS n FROM app_sessions WHERE sid = $1', ['sid-del']);
    expect(rows.rows[0].n).toBe(0);
    await expect(promisifyGet(store, 'sid-unknown')).resolves.toMatchObject({ error: null, session: null });
    await new Promise<void>((resolve, reject) => {
      store.destroy('sid-unknown', (error) => (error ? reject(error) : resolve()));
    });
  });
});
