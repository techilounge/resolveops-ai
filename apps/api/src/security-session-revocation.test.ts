import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSessionStore, SESSION_COOKIE_NAME } from '@resolveops/auth';
import {
  createTestContext,
  destroyTestContext,
  expectEnvelope,
  mutate,
  read,
  unsignedSid,
  type TestContext,
  type TestSession,
} from './testing/support';

/**
 * P1-7 — session revocation re-proofs (Blueprint §7), adversarial and
 * mid-session: every attack below starts from a session PROVEN alive (an
 * authenticated read returned 200), then revokes server-side state out
 * of band and demands the very next request fail closed. Store-level
 * behavior (allowlist, expiry shapes) belongs to the unit suites; here
 * the proof runs through the running app and the same Postgres state the
 * production store reads.
 */

function storeGet(store: PostgresSessionStore, sid: string): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    store.get(sid, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result ?? null);
    });
  });
}

/** A fresh active-org member whose session is proven alive before the attack. */
async function armedMember(context: TestContext): Promise<TestSession> {
  const session = await context.member({ role: 'owner', orgId: context.fixture.orgAId });
  const switched = await mutate(context, session, 'POST', '/api/v1/me/active-organization', {
    organizationId: context.fixture.orgAId,
  });
  expect(switched.statusCode).toBe(200);
  const alive = await read(context, session, '/api/v1/incidents');
  expect(alive.statusCode).toBe(200);
  return session;
}

async function sessionRow(context: TestContext, sid: string): Promise<number> {
  const result = await context.superuserPool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM app_sessions WHERE sid = $1',
    [sid],
  );
  return Number(result.rows[0].count);
}

describe('P1-7 session revocation re-proofs (HTTP, Blueprint §7)', () => {
  let context: TestContext | undefined;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    if (context) await destroyTestContext(context);
  });

  it('killing the server session row mid-session: the next request is 401 and a restarted store cannot resurrect it', async () => {
    if (!context) return;
    const session = await armedMember(context);
    const sid = unsignedSid(session.cookie);
    const restartedStore = new PostgresSessionStore({
      pool: context.appRolePool,
      idleTtlMs: 30 * 60_000,
      defaultTtlMs: 60_000,
    });

    // Positive control: a freshly built store over the same Postgres DOES
    // restore this session before the kill — so the later null is the
    // revocation, not a store quirk.
    expect(await storeGet(restartedStore, sid)).not.toBeNull();

    // The attack: delete the server-side row out of band.
    const deleted = await context.superuserPool.query('DELETE FROM app_sessions WHERE sid = $1', [sid]);
    expect(deleted.rowCount).toBe(1);

    // The very next request fails closed.
    const denied = await read(context, session, '/api/v1/incidents');
    expect(denied.statusCode).toBe(401);
    expectEnvelope(denied, 'UNAUTHORIZED');

    // No resurrection: a RESTARTED store (new instance, same Postgres —
    // nothing is cached in memory) restores nothing.
    expect(await storeGet(restartedStore, sid)).toBeNull();
    expect(await sessionRow(context, sid)).toBe(0);
    const stillDenied = await read(context, session, '/api/v1/incidents');
    expect(stillDenied.statusCode).toBe(401);
    expectEnvelope(stillDenied, 'UNAUTHORIZED');
  });

  it('bumping auth_epoch mid-session (the revocation race): the next request is 401, the stale row is destroyed, and it stays dead', async () => {
    if (!context) return;
    const session = await armedMember(context);
    const sid = unsignedSid(session.cookie);
    const store = new PostgresSessionStore({
      pool: context.appRolePool,
      idleTtlMs: 30 * 60_000,
      defaultTtlMs: 60_000,
    });
    expect(await storeGet(store, sid)).not.toBeNull();

    // The attack: bump users.auth_epoch the way revokeUserSessions does,
    // while the session row still holds the old epoch — the race window
    // the epoch exists to close.
    const bumped = await context.superuserPool.query<{ auth_epoch: string }>(
      'UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = $1 RETURNING auth_epoch',
      [session.userId],
    );
    expect(bumped.rows).toHaveLength(1);

    const denied = await read(context, session, '/api/v1/incidents');
    expect(denied.statusCode).toBe(401);
    expectEnvelope(denied, 'UNAUTHORIZED');

    // The store destroyed the stale row itself — not merely refused it —
    // so no later code path or restart can bring it back.
    expect(await sessionRow(context, sid)).toBe(0);
    expect(await storeGet(store, sid)).toBeNull();
    const stillDenied = await read(context, session, '/api/v1/incidents');
    expect(stillDenied.statusCode).toBe(401);
    expectEnvelope(stillDenied, 'UNAUTHORIZED');
  });

  it('idle expiry is enforced from the DB clock: a backdated updated_at kills the mid-session', async () => {
    if (!context) return;
    const session = await armedMember(context);
    const sid = unsignedSid(session.cookie);

    // The attack: make the session look idle past the 30-minute idle TTL.
    const backdated = await context.superuserPool.query(
      `UPDATE app_sessions SET updated_at = now() - interval '31 minutes' WHERE sid = $1`,
      [sid],
    );
    expect(backdated.rowCount).toBe(1);

    const denied = await read(context, session, '/api/v1/incidents');
    expect(denied.statusCode).toBe(401);
    expectEnvelope(denied, 'UNAUTHORIZED');
  });

  it('absolute expiry is enforced from the DB clock: a backdated expire kills the mid-session even when updated_at is fresh', async () => {
    if (!context) return;
    const session = await armedMember(context);
    const sid = unsignedSid(session.cookie);

    // The attack: keep updated_at fresh but expire the row outright —
    // absolute expiry must win.
    const backdated = await context.superuserPool.query(
      `UPDATE app_sessions SET expire = now() - interval '1 second', updated_at = now() WHERE sid = $1`,
      [sid],
    );
    expect(backdated.rowCount).toBe(1);

    const denied = await read(context, session, '/api/v1/incidents');
    expect(denied.statusCode).toBe(401);
    expectEnvelope(denied, 'UNAUTHORIZED');
  });

  it('fixation resistance: a cookie value planted before authentication is never adopted as the session', async () => {
    if (!context) return;
    // The attacker plants a cookie value of their choosing, then rides the
    // victim through the login flow carrying it.
    const planted = 'attacker-chosen-sid-value';
    const plantedCookie = `${SESSION_COOKIE_NAME}=${planted}`;

    const start = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/login',
      headers: { cookie: plantedCookie },
    });
    expect(start.statusCode).toBe(302);
    const authorizeUrl = start.headers.location as string;
    const state = new URL(authorizeUrl).searchParams.get('state') as string;
    const subject = `fixation-${randomUUID()}`;
    const callbackUrl = await context.stub.authorizeFromUrl(authorizeUrl, {
      subject,
      email: `${subject}@example.com`,
      displayName: 'Fixation Probe',
    });
    const code = new URL(callbackUrl).searchParams.get('code') as string;
    const callback = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      headers: { cookie: plantedCookie },
    });
    expect(callback.statusCode).toBe(302);

    // The issued session id is fresh — never the attacker's planted value.
    // Pick the last non-empty Set-Cookie for the session name: the plugin
    // may also emit a clearing cookie alongside the fresh one.
    const issued = (callback.headers['set-cookie'] as string[] | undefined)
      ?.filter((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`))
      .filter((value) => value.slice(SESSION_COOKIE_NAME.length + 1).split(';')[0].trim().length > 0)
      .pop();
    expect(issued).toBeDefined();
    const authenticatedValue = issued!.split(';')[0].slice(SESSION_COOKIE_NAME.length + 1);
    const authenticatedSid = unsignedSid(authenticatedValue);
    expect(authenticatedSid).not.toBe(planted);

    // Exactly ONE session row exists for the new user, keyed by the fresh
    // sid — the planted value was never persisted as a session.
    const userRow = await context.superuserPool.query<{ id: string }>(
      'SELECT id FROM users WHERE entra_issuer = $1 AND entra_subject = $2',
      [context.stub.issuer, subject],
    );
    expect(userRow.rows).toHaveLength(1);
    const rows = await context.superuserPool.query<{ sid: string }>(
      `SELECT sid FROM app_sessions WHERE sess ->> 'userId' = $1`,
      [userRow.rows[0].id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].sid).toBe(authenticatedSid);

    // And the planted value itself is not a session: it grants nothing.
    const replayed = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: plantedCookie },
    });
    expect(replayed.statusCode).toBe(401);
    expectEnvelope(replayed, 'UNAUTHORIZED');
  });
});
