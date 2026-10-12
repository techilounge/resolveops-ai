// /app/incidents/:id behaviors (P1-6): version-aware status transitions, the
// 409 conflict state with reload, role-aware assignment, the delta-D4 comment
// surface (paginated list + create), and the state classes.
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
  commentFixture,
  incidentFixture,
  orgFixture,
  pageEnvelope,
  errorEnvelope,
  type FetchStub,
} from '../../testing/fetchStub';

const { orgA: ORG_A_ID, incident: INCIDENT_ID, member: MEMBER_ID } = TEST_IDS;
const ORG_A = orgFixture(ORG_A_ID, 'City of Austin IT', 'city-of-austin-it');
const DETAIL_PATH = `/app/incidents/${INCIDENT_ID}`;

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

interface DetailOptions {
  role: 'owner' | 'admin' | 'analyst';
  incident?: ReturnType<typeof incidentFixture>;
  detailStatus?: number;
  detailBody?: unknown;
  commentsStatus?: number;
  commentsBody?: unknown;
}

/** Detail stub with configurable role, incident payload, and comments page. */
function stubDetail(options: DetailOptions): FetchStub {
  const {
    role,
    incident = incidentFixture(),
    detailStatus = 200,
    detailBody,
    commentsStatus = 200,
    commentsBody = pageEnvelope([], 1, 10, 0),
  } = options;
  return installFetchStub((request) => {
    if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
      return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', role)]) };
    }
    if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
      return { status: 200, body: ORG_A };
    }
    if (request.method === 'GET' && request.url.includes(`${INCIDENT_ID}/comments`)) {
      return { status: commentsStatus, body: commentsBody };
    }
    if (request.method === 'POST' && request.url.endsWith(`${INCIDENT_ID}/comments`)) {
      return { status: 201, body: commentFixture() };
    }
    if (request.method === 'GET' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
      return { status: detailStatus, body: detailBody ?? incident };
    }
    if (request.method === 'PATCH' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
      // Echo the update with a bumped version (success path).
      return { status: 200, body: incidentFixture({ ...incident, version: incident.version + 1 }) };
    }
    if (request.method === 'GET' && request.url.includes('/organizations/current/members')) {
      return { status: 200, body: pageEnvelope([memberFixture({ userId: MEMBER_ID, displayName: 'Dee Admin' })], 1, 25, 1) };
    }
    return undefined;
  });
}

describe('incident detail screen', () => {
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

  it('renders the incident with version, status, severity, and comments', async () => {
    const stub = stubDetail({
      role: 'owner',
      commentsBody: pageEnvelope([commentFixture()], 1, 10, 1),
    });

    renderApp([DETAIL_PATH]);

    expect(await screen.findByRole('heading', { name: 'BitLocker recovery stuck on workstation WS-1041' })).toBeDefined();
    expect(screen.getByText(/Version 1/)).toBeDefined();
    expect(screen.getByText('High')).toBeDefined();
    expect(await screen.findByText('Starting triage — pulling the BitLocker event log next.')).toBeDefined();
    expect(screen.getByText(/1 comment/)).toBeDefined();

    const commentGet = stub.requests.find((request) => request.method === 'GET' && request.url.includes(`${INCIDENT_ID}/comments`));
    expect(commentGet).toBeDefined();
    expect(new URL(commentGet?.url ?? '', 'http://localhost').searchParams.get('page')).toBe('1');
    stub.restore();
  });

  it('PATCHes a status transition with the expected version and shows the result', async () => {
    const stub = stubDetail({ role: 'admin' });

    renderApp([DETAIL_PATH]);
    await screen.findByRole('heading', { name: 'BitLocker recovery stuck on workstation WS-1041' });

    fireEvent.change(screen.getByLabelText('Change status'), { target: { value: 'investigating' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Update status' }).closest('form') as HTMLFormElement);

    // The PATCH issues only after the async CSRF handshake resolves — find it
    // once it exists, then assert its shape.
    await waitFor(() => {
      const patch = stub.requests.find(
        (request) => request.method === 'PATCH' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`),
      );
      expect(patch?.body).toEqual({ status: 'investigating', expectedVersion: 1 });
      expect(patch?.headers['x-csrf-token']).toBe('stub-csrf-token');
    });
    expect(await screen.findByText(/Version 2/)).toBeDefined();
    stub.restore();
  });

  it('shows the conflict state and reloads the incident when PATCH answers 409', async () => {
    let firstPatch = true;
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'owner')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'GET' && request.url.includes(`${INCIDENT_ID}/comments`)) {
        return { status: 200, body: pageEnvelope([], 1, 10, 0) };
      }
      if (request.method === 'PATCH' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
        if (firstPatch) {
          firstPatch = false;
          return { status: 409, body: errorEnvelope('CONFLICT', 'The incident was updated by someone else.') };
        }
        return undefined;
      }
      if (request.method === 'GET' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
        // After the conflict the server has version 3 (someone else's save).
        return { status: 200, body: incidentFixture({ status: 'triaged', version: 3 }) };
      }
      return undefined;
    });

    renderApp([DETAIL_PATH]);
    await screen.findByRole('heading', { name: 'BitLocker recovery stuck on workstation WS-1041' });

    fireEvent.change(screen.getByLabelText('Change status'), { target: { value: 'investigating' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Update status' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText(/This incident changed while you were working/)).toBeDefined();
    // The reload brings the server's version; drafts reset to it.
    expect(await screen.findByText(/Version 3/)).toBeDefined();
    const statusSelect = screen.getByLabelText('Change status') as HTMLSelectElement;
    expect(statusSelect.value).toBe('triaged');
    stub.restore();
  });

  it('lets an admin assign a member via the picker and unassign back', async () => {
    let assigned = false;
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'admin')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'GET' && request.url.includes(`${INCIDENT_ID}/comments`)) {
        return { status: 200, body: pageEnvelope([], 1, 10, 0) };
      }
      if (request.method === 'PATCH' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
        const body = request.body as { assigneeUserId?: string | null };
        assigned = body.assigneeUserId === MEMBER_ID;
        return {
          status: 200,
          body: incidentFixture({ assigneeUserId: assigned ? MEMBER_ID : null, version: 2 }),
        };
      }
      if (request.method === 'GET' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
        return {
          status: 200,
          body: incidentFixture({ assigneeUserId: assigned ? MEMBER_ID : null, version: assigned ? 2 : 1 }),
        };
      }
      if (request.method === 'GET' && request.url.includes('/organizations/current/members')) {
        return { status: 200, body: pageEnvelope([memberFixture({ userId: MEMBER_ID, displayName: 'Dee Admin' })], 1, 25, 1) };
      }
      return undefined;
    });

    renderApp([DETAIL_PATH]);
    await screen.findByRole('heading', { name: 'BitLocker recovery stuck on workstation WS-1041' });

    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: MEMBER_ID } });
    fireEvent.submit(screen.getByRole('button', { name: 'Assign' }).closest('form') as HTMLFormElement);

    // For privileged roles the assignment state IS the picker value (the
    // read-only card is the non-privileged UX). The select updates only after
    // the CSRF handshake + PATCH + response resolve.
    await waitFor(() =>
      expect((screen.getByLabelText('Assignee') as HTMLSelectElement).value).toBe(MEMBER_ID),
    );
    const patch = stub.requests.find(
      (request) => request.method === 'PATCH' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`),
    );
    expect(patch?.body).toEqual({ assigneeUserId: MEMBER_ID, expectedVersion: 1 });
    expect(patch?.headers['x-csrf-token']).toBe('stub-csrf-token');

    // Unassign again: the button label flips once the incident has an assignee.
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Update assignment' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign' })).toBeDefined());
    const patches = stub.requests.filter(
      (request) => request.method === 'PATCH' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`),
    );
    expect(patches[1]?.body).toEqual({ assigneeUserId: null, expectedVersion: 2 });
    stub.restore();
  });

  it('shows assignment read-only for non-privileged roles and fetches no roster', async () => {
    const stub = stubDetail({ role: 'analyst' });

    renderApp([DETAIL_PATH]);
    await screen.findByRole('heading', { name: 'BitLocker recovery stuck on workstation WS-1041' });

    // The read-only surface explains the limit (the spec did not resolve
    // non-admin assignment UX; delta D1 renders the current assignee only).
    expect(screen.getByText('Unassigned')).toBeDefined();
    expect(screen.getByText(/Assignment changes are limited to owners and admins/)).toBeDefined();
    expect(screen.queryByLabelText('Assignee')).toBeNull();
    expect(stub.requests.some((request) => request.url.includes('/organizations/current/members'))).toBe(false);
    stub.restore();
  });

  it('paginates comments and jumps to the last page after creating one', async () => {
    const comments = Array.from({ length: 11 }, (_, index) =>
      commentFixture({
        id: `f0000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
        body: `Comment number ${index + 1}`,
      }),
    );
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'analyst')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'POST' && request.url.endsWith(`${INCIDENT_ID}/comments`)) {
        return { status: 201, body: commentFixture() };
      }
      if (request.method === 'GET' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
        return { status: 200, body: incidentFixture() };
      }
      if (request.method === 'GET' && request.url.includes(`${INCIDENT_ID}/comments`)) {
        const page = Number(new URL(request.url, 'http://localhost').searchParams.get('page') ?? '1');
        const start = (page - 1) * 10;
        return { status: 200, body: pageEnvelope(comments.slice(start, start + 10), page, 10, 11) };
      }
      return undefined;
    });

    renderApp([DETAIL_PATH]);
    await screen.findByText('Comment number 1');
    expect(screen.getByText(/Page 1 of 2 · 11 comments/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Comment number 11')).toBeDefined();

    // Create a comment → refetch lands on the page showing the newest entry.
    fireEvent.change(screen.getByLabelText('Add a comment'), {
      target: { value: 'Confirmed the recovery key was escrowed.' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Post comment' }).closest('form') as HTMLFormElement);

    await waitFor(() => {
      const post = stub.requests.find(
        (request) => request.method === 'POST' && request.url.endsWith(`${INCIDENT_ID}/comments`),
      );
      expect(post?.body).toEqual({ body: 'Confirmed the recovery key was escrowed.' });
      expect(post?.headers['x-csrf-token']).toBe('stub-csrf-token');
    });
    await waitFor(() => {
      const page = new URL(
        stub.requests.filter((request) => request.method === 'GET' && request.url.includes('/comments')).at(-1)?.url ?? '',
        'http://localhost',
      ).searchParams.get('page');
      expect(page).toBe('2'); // refetched with the new total (12 → last page)
    });
    stub.restore();
  });

  it('blocks an empty comment with a field error and fires no request', async () => {
    const stub = stubDetail({ role: 'analyst' });

    renderApp([DETAIL_PATH]);
    // The comment form enables once its GET resolves; the transient loading
    // text may already be gone by the first poll, so assert the stable end state.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Post comment' }) as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.submit(screen.getByRole('button', { name: 'Post comment' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText('Write a comment before posting.')).toBeDefined();
    expect(stub.requests.some((request) => request.method === 'POST')).toBe(false);
    stub.restore();
  });

  it('renders the not-found state for a missing incident id', async () => {
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'analyst')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'GET' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
        return { status: 404, body: errorEnvelope('NOT_FOUND', 'Incident not found in this organization.') };
      }
      return undefined;
    });

    renderApp([DETAIL_PATH]);

    expect(await screen.findByText('Incident not found')).toBeDefined();
    expect(screen.getByText(/does not exist in your organization/)).toBeDefined();
    stub.restore();
  });

  it('renders the denied state when the detail answers 403', async () => {
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'analyst')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'GET' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
        return { status: 403, body: errorEnvelope('FORBIDDEN', 'Not your organization.') };
      }
      return undefined;
    });

    renderApp([DETAIL_PATH]);

    expect(await screen.findByText(/Access denied/i)).toBeDefined();
    stub.restore();
  });

  it('redirects to sign-in when the detail answers 401 (dead session)', async () => {
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'analyst')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'GET' && request.url.endsWith(`/api/v1/incidents/${INCIDENT_ID}`)) {
        return { status: 401, body: errorEnvelope('UNAUTHORIZED', 'Session expired.') };
      }
      return undefined;
    });

    renderApp([DETAIL_PATH]);

    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/auth/login'));
    stub.restore();
  });
});
