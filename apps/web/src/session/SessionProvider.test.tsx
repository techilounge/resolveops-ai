// Session provider lifecycle (P1-5): bootstrap from /me + current org, the
// 401 → unauthenticated transition, refresh after a transient failure, and
// the no-active-organization state. Renders a live probe against the fetch
// stub so observable UI status is the assertion.
// @vitest-environment jsdom
import { fireEvent, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { SessionProvider, useSession } from './SessionProvider';
import { resetClientState, setUnauthorizedHandler } from '../api/client';
import { TEST_IDS, installFetchStub, meFixture, membershipFixture, orgFixture, type FetchHandler } from '../testing/fetchStub';

const { orgA: ORG_A_ID, orgB: ORG_B_ID } = TEST_IDS;

const ME_BODY = meFixture([
  membershipFixture(ORG_A_ID, 'City of Austin IT', 'owner'),
  membershipFixture(ORG_B_ID, 'Harborview Ops', 'analyst'),
]);

const ORG_A_BODY = orgFixture(ORG_A_ID, 'City of Austin IT', 'city-of-austin-it');

// Probe: exposes the session status plus a retry button wired to refresh()
// — the same control the error screens render.
function SessionProbe(): ReactElement {
  const { status, me, currentOrg, refresh } = useSession();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{me?.user.email ?? 'none'}</span>
      <span data-testid="org">{currentOrg?.name ?? 'none'}</span>
      <button type="button" data-testid="retry" onClick={() => void refresh()}>
        retry
      </button>
    </div>
  );
}

describe('SessionProvider', () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = null;
    resetClientState();
    setUnauthorizedHandler(null);
  });

  afterEach(() => {
    restore?.();
    restore = null;
    setUnauthorizedHandler(null);
    resetClientState();
    cleanup();
  });

  function renderSession(): void {
    render(
      <SessionProvider>
        <SessionProbe />
      </SessionProvider>,
    );
  }

  it('bootstraps to ready with me and the active organization', async () => {
    const stub = installFetchStub(((request) => {
      if (request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: ME_BODY };
      }
      if (request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A_BODY };
      }
      return undefined;
    }) satisfies FetchHandler);
    restore = stub.restore;

    renderSession();

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('email').textContent).toBe('avery@example.com');
    expect(screen.getByTestId('org').textContent).toBe('City of Austin IT');
  });

  it('becomes unauthenticated when /me answers 401', async () => {
    const stub = installFetchStub((request) =>
      request.url.endsWith('/api/v1/me')
        ? { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Session expired.' } } }
        : undefined,
    );
    restore = stub.restore;

    renderSession();

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthenticated'));
    expect(screen.getByTestId('email').textContent).toBe('none');
    expect(screen.getByTestId('org').textContent).toBe('none');
  });

  it('surfaces an error state on a 5xx and recovers through refresh', async () => {
    let meCalls = 0;
    const stub = installFetchStub((request) => {
      if (request.url.endsWith('/api/v1/me')) {
        meCalls += 1;
        return meCalls === 1
          ? { status: 500, body: { error: { code: 'INTERNAL', message: 'Boom.' } } }
          : { status: 200, body: ME_BODY };
      }
      if (request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A_BODY };
      }
      return undefined;
    });
    restore = stub.restore;

    renderSession();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));

    fireEvent.click(screen.getByTestId('retry'));

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('email').textContent).toBe('avery@example.com');
  });

  it('treats a 4xx /organizations/current as "no active organization", not an error', async () => {
    const stub = installFetchStub((request) => {
      if (request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: ME_BODY };
      }
      if (request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No active organization.' } } };
      }
      return undefined;
    });
    restore = stub.restore;

    renderSession();

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('email').textContent).toBe('avery@example.com');
    expect(screen.getByTestId('org').textContent).toBe('none');
  });

  it('clears session state when a later request answers 401 (handler wiring)', async () => {
    let meIsExpired = false;
    const stub = installFetchStub((request) => {
      if (request.url.endsWith('/api/v1/me')) {
        return meIsExpired
          ? { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Session expired.' } } }
          : { status: 200, body: ME_BODY };
      }
      if (request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A_BODY };
      }
      return undefined;
    });
    restore = stub.restore;

    renderSession();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));

    // The session dies server-side; the next live call (the retry) answers 401.
    meIsExpired = true;
    fireEvent.click(screen.getByTestId('retry'));

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthenticated'));
    expect(screen.getByTestId('email').textContent).toBe('none');
    expect(screen.getByTestId('org').textContent).toBe('none');
  });
});
