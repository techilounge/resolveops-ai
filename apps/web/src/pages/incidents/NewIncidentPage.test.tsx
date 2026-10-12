// /app/incidents/new behaviors (P1-6): shared-Zod validation before any
// request, the POST payload shape, 201 → detail navigation, CSRF header on
// the mutation, and the denied/error state classes.
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
  membershipFixture,
  incidentFixture,
  orgFixture,
  errorEnvelope,
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

describe('new incident screen', () => {
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

  it('blocks an empty submission with a field error and fires no request', async () => {
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'analyst')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      return undefined;
    });

    renderApp(['/app/incidents/new']);
    await screen.findByRole('heading', { name: 'New incident' });

    fireEvent.submit(screen.getByRole('button', { name: 'Create incident' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText('A title is required (1–200 characters).')).toBeDefined();
    expect(stub.requests.some((request) => request.method === 'POST')).toBe(false);
    stub.restore();
  });

  it('posts the shared DTO with the CSRF header and navigates to the created detail', async () => {
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'analyst')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/incidents')) {
        return { status: 201, body: incidentFixture() };
      }
      // The 201 navigates to the detail route, which fetches the incident.
      if (request.method === 'GET' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
        return { status: 200, body: incidentFixture() };
      }
      return undefined;
    });

    renderApp(['/app/incidents/new']);
    await screen.findByRole('heading', { name: 'New incident' });

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Ransomware canary detected on FS-01' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'A honeypot file was touched on the file server.' },
    });
    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'high' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create incident' }).closest('form') as HTMLFormElement);

    // Navigation happens only after the CSRF handshake + POST resolve, so the
    // request is guaranteed to be recorded by the time the path flips.
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe(`/app/incidents/${INCIDENT_ID}`));
    const post = stub.requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/api/v1/incidents'),
    );
    expect(post?.body).toEqual({
      title: 'Ransomware canary detected on FS-01',
      description: 'A honeypot file was touched on the file server.',
      severity: 'high',
    });
    expect(post?.headers['x-csrf-token']).toBe('stub-csrf-token');
    // The 201 response is the created incident; the detail screen renders it.
    expect(await screen.findByText('BitLocker recovery stuck on workstation WS-1041')).toBeDefined();
    stub.restore();
  });

  it('renders the denied state when creation answers 403', async () => {
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'viewer')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/incidents')) {
        return { status: 403, body: errorEnvelope('FORBIDDEN', 'Viewers cannot create incidents.') };
      }
      return undefined;
    });

    renderApp(['/app/incidents/new']);
    await screen.findByRole('heading', { name: 'New incident' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Escalation from AV' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create incident' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText(/Access denied/i)).toBeDefined();
    expect(screen.getByText(/Incident creation is not available for your membership/)).toBeDefined();
    stub.restore();
  });

  it('renders the error state with retry when creation answers 500', async () => {
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'owner')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/incidents')) {
        return { status: 500, body: errorEnvelope('INTERNAL', 'Database unavailable.') };
      }
      return undefined;
    });

    renderApp(['/app/incidents/new']);
    await screen.findByRole('heading', { name: 'New incident' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Escalation from AV' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create incident' }).closest('form') as HTMLFormElement);

    // The panel echoes the API's detail message, with a retry action.
    expect(await screen.findByText('Something went wrong')).toBeDefined();
    expect(screen.getByText('Database unavailable.')).toBeDefined();
    stub.restore();
  });
});
