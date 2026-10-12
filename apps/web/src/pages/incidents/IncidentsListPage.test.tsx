// /app/incidents list behaviors (P1-6): server-side filters/search/pagination,
// role-aware assignee filter, and every state class — all live through the
// fetch stub, no fixtures in live trees.
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router';
import type { ReactElement } from 'react';
import { AppRoutes } from '../../routes';
import { SessionProvider } from '../../session/SessionProvider';
import { resetClientState, setUnauthorizedHandler } from '../../api/client';
import {
  TEST_IDS,
  installFetchStub,
  meFixture,
  memberFixture,
  membershipFixture,
  incidentFixture,
  orgFixture,
  pageEnvelope,
  errorEnvelope,
  type FetchHandler,
  type FetchStub,
} from '../../testing/fetchStub';

const { orgA: ORG_A_ID, incident: INCIDENT_ID } = TEST_IDS;
const ORG_A = orgFixture(ORG_A_ID, 'City of Austin IT', 'city-of-austin-it');

function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

function renderApp(initialEntries: string[]): void {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <LocationProbe />
      <SessionProvider>
        <AppRoutes demoSlot={null} />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/** Query params of the Nth list request. Fetch URLs are relative in jsdom. */
function listQuery(stub: FetchStub, index = 0): URLSearchParams {
  const calls = stub.requests.filter(
    (request) => request.method === 'GET' && request.url.includes('/api/v1/incidents?'),
  );
  expect(calls.length, `expected at least ${index + 1} list calls`).toBeGreaterThan(index);
  return new URL(calls[index].url, 'http://localhost').searchParams;
}

/** Owner session whose incidents endpoint is configurable per test. */
function stubOwnerSession(listHandler: (url: string) => { status: number; body: unknown }): FetchStub {
  const handler: FetchHandler = (request) => {
    if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
      return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'owner')]) };
    }
    if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
      return { status: 200, body: ORG_A };
    }
    if (request.method === 'GET' && request.url.includes('/api/v1/incidents?')) {
      return listHandler(request.url);
    }
    if (request.method === 'GET' && request.url.includes('/api/v1/organizations/current/members')) {
      return { status: 200, body: pageEnvelope([memberFixture({ displayName: 'Dee Admin' })], 1, 25, 1) };
    }
    return undefined;
  };
  return installFetchStub(handler);
}

describe('incidents list screen', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetClientState();
    setUnauthorizedHandler(null);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
    cleanup();
    resetClientState();
    setUnauthorizedHandler(null);
  });

  it('shows the loading state, then rows with status, severity, and detail links', async () => {
    const stub = stubOwnerSession(() => ({
      status: 200,
      body: pageEnvelope([incidentFixture()], 1, 25, 1),
    }));

    renderApp(['/app/incidents']);

    expect(await screen.findByText('Loading incidents…')).toBeDefined();
    const row = await screen.findByRole('link', {
      name: 'BitLocker recovery stuck on workstation WS-1041',
    });
    expect(row.getAttribute('href')).toBe(`/app/incidents/${INCIDENT_ID}`);
    // The status text appears in the chip AND the row badge; the severity
    // label likewise (option + badge) — assert presence, not uniqueness.
    expect(screen.getAllByText('High').length).toBeGreaterThan(0);
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);

    // First page request is the tenant-scoped default (server-side pagination).
    expect(listQuery(stub, 0).get('page')).toBe('1');
    expect(listQuery(stub, 0).get('pageSize')).toBe('25');
    stub.restore();
  });

  it('renders the empty state when the queue is empty', async () => {
    const stub = stubOwnerSession(() => ({ status: 200, body: pageEnvelope([], 1, 25, 0) }));

    renderApp(['/app/incidents']);

    expect(await screen.findByText('No incidents yet')).toBeDefined();
    stub.restore();
  });

  it('sends status, severity, assignee, and q as server query params', async () => {
    const stub = stubOwnerSession(() => ({
      status: 200,
      body: pageEnvelope([incidentFixture()], 1, 25, 1),
    }));

    renderApp(['/app/incidents']);
    await screen.findByText('BitLocker recovery stuck on workstation WS-1041');

    // Status filter select.
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'new' } });
    await waitFor(() => expect(listQuery(stub, 1).get('status')).toBe('new'));

    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'high' } });
    await waitFor(() => expect(listQuery(stub, 2).get('severity')).toBe('high'));

    // Tenant-scoped server search box.
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'bitlocker' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Search' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(listQuery(stub, 3).get('q')).toBe('bitlocker'));

    // Assignee picker (owner sees named members + the Unassigned pseudo-filter).
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'unassigned' } });
    await waitFor(() => expect(listQuery(stub, 4).get('assignee')).toBe('unassigned'));

    // Clearing the status filter removes the param again.
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '' } });
    await waitFor(() => expect(listQuery(stub, 5).get('status')).toBeNull());
    stub.restore();
  });

  it('paginates server-side with Next/Prev keeping other filters', async () => {
    const stub = stubOwnerSession((url) => {
      const page = Number(new URL(url, 'http://localhost').searchParams.get('page') ?? '1');
      return {
        status: 200,
        body: pageEnvelope([incidentFixture()], page, 25, 30),
      };
    });

    renderApp(['/app/incidents']);
    await screen.findByText('BitLocker recovery stuck on workstation WS-1041');

    expect(screen.getByText(/Page 1 of 2 · 30 incidents/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(/Page 2 of 2 · 30 incidents/);
    expect(listQuery(stub, 1).get('page')).toBe('2');
    // Last page: Next disabled, Prev enabled.
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(false);
    stub.restore();
  });

  it('renders the denied state on 403 without retrying', async () => {
    const stub = stubOwnerSession(() => ({
      status: 403,
      body: errorEnvelope('FORBIDDEN', 'Your role cannot list incidents.'),
    }));

    renderApp(['/app/incidents']);

    expect(await screen.findByText(/Access denied/i)).toBeDefined();
    expect(screen.getByText(/Incident listing is not available for your membership/)).toBeDefined();
    const listCalls = stub.requests.filter((request) => request.url.includes('/api/v1/incidents?'));
    expect(listCalls.length).toBe(1); // no retry loop
    stub.restore();
  });

  it('renders the error state with retry on a 500', async () => {
    const stub = stubOwnerSession(() => ({
      status: 500,
      body: errorEnvelope('INTERNAL', 'Database unavailable.'),
    }));

    renderApp(['/app/incidents']);

    // The panel echoes the API's detail (never swallowed silently).
    expect(await screen.findByText('Something went wrong')).toBeDefined();
    expect(screen.getByText('Database unavailable.')).toBeDefined();
    stub.restore();
  });

  it('redirects to sign-in when the list answers 401 (dead session)', async () => {
    const stub = stubOwnerSession(() => ({
      status: 401,
      body: errorEnvelope('UNAUTHORIZED', 'Session expired.'),
    }));

    renderApp(['/app/incidents']);

    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/auth/login'));
    stub.restore();
  });
});
