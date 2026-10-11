// Routed app integration (P1-5): route guards, auth-route wiring, the shell,
// the organization selector switch, placeholders, and the /demo boundary —
// all against the fetch stub, no state library, no fixtures in live trees.
// @vitest-environment jsdom
import { fireEvent, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { Suspense, lazy } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { AppRoutes } from './routes';
import { SessionProvider } from './session/SessionProvider';
import { resetClientState, setUnauthorizedHandler } from './api/client';
import { TEST_IDS, installFetchStub, meFixture, membershipFixture, orgFixture, type FetchHandler, type FetchStub } from './testing/fetchStub';

const { orgA: ORG_A_ID, orgB: ORG_B_ID } = TEST_IDS;

const ME_TWO_ORGS = meFixture([
  membershipFixture(ORG_A_ID, 'City of Austin IT', 'owner'),
  membershipFixture(ORG_B_ID, 'Harborview Ops', 'analyst'),
]);

const ORG_A = orgFixture(ORG_A_ID, 'City of Austin IT', 'city-of-austin-it');

function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

// Real composition: main.tsx supplies the lazily-imported demo chunk, so the
// tests exercise the same boundary (and the real dashboard) at /demo.
const DemoApp = lazy(() => import('./demo'));

/** Full app composition matching main.tsx, under MemoryRouter for tests. */
function renderApp(initialEntries: string[]): void {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <LocationProbe />
      <SessionProvider>
        <AppRoutes
          demoSlot={
            <Suspense fallback={null}>
              <DemoApp />
            </Suspense>
          }
        />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/** Standard authenticated stub: /me with two orgs, Org A active. */
function stubSession(): FetchStub {
  const handler: FetchHandler = (request) => {
    if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
      return { status: 200, body: ME_TWO_ORGS };
    }
    if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
      return { status: 200, body: ORG_A };
    }
    if (request.method === 'POST' && request.url.endsWith('/api/v1/me/active-organization')) {
      return { status: 204, body: null };
    }
    return undefined;
  };
  return installFetchStub(handler);
}

describe('routing guards', () => {
  beforeEach(() => {
    resetClientState();
    setUnauthorizedHandler(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    resetClientState();
    setUnauthorizedHandler(null);
  });

  it('redirects an unauthenticated /app visit to /auth/login and remembers the path', async () => {
    // jsdom logs its non-implemented navigation attempt for the login redirect.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = installFetchStub((request) =>
      request.url.endsWith('/api/v1/me')
        ? { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Session expired.' } } }
        : undefined,
    );

    renderApp(['/app/incidents']);

    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/auth/login'));
    expect(sessionStorage.getItem('resolveops.post-login-redirect')).toBe('/app/incidents');
    stub.restore();
    consoleError.mockRestore();
  });

  it('lands the login route on the redirect screen pointing at the API login flow', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = installFetchStub(() => undefined);
    stub.restore();

    renderApp(['/auth/login']);

    // The no-script fallback link targets the API login route (full-page redirect).
    const link = await screen.findByRole('link', { name: /continue to sign-in/i });
    expect(link.getAttribute('href')).toBe('/api/v1/auth/login');
    consoleError.mockRestore();
  });
});

describe('authenticated shell', () => {
  beforeEach(() => {
    resetClientState();
    setUnauthorizedHandler(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    resetClientState();
    setUnauthorizedHandler(null);
  });

  it('renders the shell with org selector, account email, and Phase 1 nav', async () => {
    const stub = stubSession();

    renderApp(['/app/incidents']);

    expect(await screen.findByText('Incident workspace')).toBeDefined();
    expect(screen.getByText('avery@example.com')).toBeDefined();
    const selector = screen.getByLabelText(/organization/i) as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe(ORG_A_ID));
    // Every membership labels with its org name (server-resolved in /me);
    // the selector value points at the active organization.
    const labels = Array.from(selector.options).map((option) => option.textContent);
    expect(labels.some((label) => (label ?? '').includes('City of Austin IT (owner)'))).toBe(true);
    expect(labels.some((label) => (label ?? '').includes('Harborview Ops (analyst)'))).toBe(true);
    stub.restore();
  });

  it('navigates to the Team placeholder and later-phase placeholders without 404s', async () => {
    const stub = stubSession();

    renderApp(['/app/incidents']);
    await screen.findByText('Incident workspace');

    fireEvent.click(screen.getByRole('link', { name: 'Team' }));
    expect(await screen.findByText('Team administration')).toBeDefined();

    fireEvent.click(screen.getByRole('link', { name: 'Devices' }));
    expect(await screen.findByText(/Devices is not yet available/i)).toBeDefined();
    expect(screen.getByTestId('path').textContent).toBe('/app/devices');
    stub.restore();
  });

  it('switches organizations through the D2 route with the CSRF header', async () => {
    const stub = stubSession();

    renderApp(['/app/incidents']);
    const selector = (await screen.findByLabelText(/organization/i)) as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe(ORG_A_ID));

    // The stub answers the CSRF handshake with 'stub-csrf-token'; the switch
    // must carry it on the mutating call.
    fireEvent.change(selector, { target: { value: ORG_B_ID } });

    await waitFor(() => {
      const post = stub.requests.find(
        (request) => request.method === 'POST' && request.url.endsWith('/api/v1/me/active-organization'),
      );
      expect(post).toBeDefined();
    });
    const post = stub.requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/api/v1/me/active-organization'),
    );
    expect(post?.body).toEqual({ organizationId: ORG_B_ID });
    expect(post?.headers['x-csrf-token']).toBe('stub-csrf-token');
    stub.restore();
  });

  it('renders the denied state when the switch answers 403', async () => {
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: ME_TWO_ORGS };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/me/active-organization')) {
        return { status: 403, body: { error: { code: 'FORBIDDEN', message: 'You do not have access.' } } };
      }
      return undefined;
    });

    renderApp(['/app/incidents']);
    const selector = (await screen.findByLabelText(/organization/i)) as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe(ORG_A_ID));

    // The switch answers 403; the canonical denied panel renders (the API's
    // detail is intentionally not echoed for forbidden switches).
    fireEvent.change(selector, { target: { value: ORG_B_ID } });

    expect(await screen.findByText(/Access denied/i)).toBeDefined();
    stub.restore();
  });

  it('surfaces the full-page error state when bootstrap fails', async () => {
    const stub = installFetchStub((request) =>
      request.url.endsWith('/api/v1/me')
        ? { status: 500, body: { error: { code: 'INTERNAL', message: 'Database unavailable.' } } }
        : undefined,
    );

    renderApp(['/app/incidents']);

    expect(await screen.findByText(/could not be reached/i)).toBeDefined();
    stub.restore();
  });
});

describe('demo boundary', () => {
  beforeEach(() => {
    resetClientState();
    setUnauthorizedHandler(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    resetClientState();
    setUnauthorizedHandler(null);
  });

  it('renders the fixture-backed demo under /demo with its DEMO badge', async () => {
    const stub = installFetchStub(() => undefined);
    stub.restore();

    renderApp(['/demo']);

    // From the demo's own content (demo.tsx): badge + headline.
    expect(await screen.findByText('DEMO / SYNTHETIC DATA')).toBeDefined();
    expect(await screen.findByText('Incident command center')).toBeDefined();
  });
});
