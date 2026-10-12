// /app/team behaviors (P1-6): owner/admin roster + invitations, owner-only
// role escalation option, the graceful limited state for other roles, and the
// state classes (conflict on duplicate invite, denial, error, pagination).
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
  orgFixture,
  pageEnvelope,
  errorEnvelope,
  type FetchStub,
} from '../../testing/fetchStub';

const { orgA: ORG_A_ID } = TEST_IDS;
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

interface TeamOptions {
  role: 'owner' | 'admin' | 'analyst';
  membersStatus?: number;
  membersBody?: unknown;
}

/** Team stub with a configurable session role and roster endpoint. */
function stubTeam(options: TeamOptions): FetchStub {
  const { role, membersStatus = 200, membersBody = pageEnvelope([memberFixture()], 1, 25, 1) } = options;
  return installFetchStub((request) => {
    if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
      return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', role)]) };
    }
    if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
      return { status: 200, body: ORG_A };
    }
    if (request.method === 'GET' && request.url.includes('/organizations/current/members')) {
      return { status: membersStatus, body: membersBody };
    }
    if (request.method === 'POST' && request.url.endsWith('/organizations/current/invitations')) {
      return {
        status: 201,
        body: memberFixture({ displayName: 'New Invitee', email: 'new@example.com', role: 'technician', status: 'invited' }),
      };
    }
    return undefined;
  });
}

describe('team screen', () => {
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

  it('lists members with roles and status for an owner, offering the owner invite option', async () => {
    const stub = stubTeam({ role: 'owner' });

    renderApp(['/app/team']);

    expect(await screen.findByRole('heading', { name: 'Team' })).toBeDefined();
    expect(await screen.findByText('Dee Admin')).toBeDefined();
    expect(screen.getByText('dee@example.com')).toBeDefined();
    // 'Admin' appears as both the member badge and the role <option>.
    expect(screen.getAllByText('Admin').length).toBeGreaterThan(0);
    expect(screen.getByText('Active')).toBeDefined();

    const roleSelect = screen.getByLabelText('Role') as HTMLSelectElement;
    const options = Array.from(roleSelect.options).map((option) => option.value);
    expect(options).toContain('owner'); // escalation is owner-only
    expect(roleSelect.value).toBe('analyst'); // safe default
    stub.restore();
  });

  it('hides the owner invite option from admins', async () => {
    const stub = stubTeam({ role: 'admin' });

    renderApp(['/app/team']);
    await screen.findByRole('heading', { name: 'Team' });

    const roleSelect = screen.getByLabelText('Role') as HTMLSelectElement;
    const options = Array.from(roleSelect.options).map((option) => option.value);
    expect(options).not.toContain('owner');
    expect(options).toContain('admin');
    stub.restore();
  });

  it('posts an invitation with the CSRF header, shows the success note, and reloads the roster', async () => {
    const stub = stubTeam({ role: 'admin' });

    renderApp(['/app/team']);
    await screen.findByRole('heading', { name: 'Team' });

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'New@Example.com ' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'technician' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Send invitation' }).closest('form') as HTMLFormElement);

    // The success note renders only after the CSRF handshake + POST resolve,
    // so the request is guaranteed recorded by the time it appears.
    expect(await screen.findByText(/Invitation saved — new@example\.com joins as Technician/)).toBeDefined();
    const post = stub.requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/organizations/current/invitations'),
    );
    expect(post?.body).toEqual({ email: 'new@example.com', role: 'technician' }); // trimmed + lowercased
    expect(post?.headers['x-csrf-token']).toBe('stub-csrf-token');
    // Roster reloaded so the invited row appears.
    await waitFor(() => {
      const rosterReloads = stub.requests.filter(
        (request) => request.method === 'GET' && request.url.includes('/organizations/current/members'),
      );
      expect(rosterReloads.length).toBeGreaterThanOrEqual(2);
    });
    stub.restore();
  });

  it('shows the member-exists message when the invitation answers 409', async () => {
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'admin')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'GET' && request.url.includes('/organizations/current/members')) {
        return { status: 200, body: pageEnvelope([memberFixture()], 1, 25, 1) };
      }
      if (request.method === 'POST' && request.url.endsWith('/organizations/current/invitations')) {
        return { status: 409, body: errorEnvelope('CONFLICT', 'A member with this email already exists.') };
      }
      return undefined;
    });

    renderApp(['/app/team']);
    await screen.findByRole('heading', { name: 'Team' });

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dee@example.com' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Send invitation' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText(/already has a membership/)).toBeDefined();
    stub.restore();
  });

  it('renders the denied state when the invite answers 403', async () => {
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'admin')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'GET' && request.url.includes('/organizations/current/members')) {
        return { status: 200, body: pageEnvelope([memberFixture()], 1, 25, 1) };
      }
      if (request.method === 'POST' && request.url.endsWith('/organizations/current/invitations')) {
        return { status: 403, body: errorEnvelope('FORBIDDEN', 'Admins cannot invite in this org.') };
      }
      return undefined;
    });

    renderApp(['/app/team']);
    await screen.findByRole('heading', { name: 'Team' });

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'someone@example.com' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Send invitation' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText(/Access denied/i)).toBeDefined();
    expect(screen.getByText(/You are not allowed to invite members/)).toBeDefined();
    stub.restore();
  });

  it('renders the graceful limited state for non-privileged roles without contacting the roster', async () => {
    const stub = stubTeam({ role: 'analyst' });

    renderApp(['/app/team']);

    expect(await screen.findByText('Limited view')).toBeDefined();
    expect(screen.getByText(/you are signed in with the/i)).toBeDefined();
    // The role name is its own <strong>; an exact match avoids the sentence.
    expect(screen.getByText('Analyst', { exact: true })).toBeDefined();
    expect(stub.requests.some((request) => request.url.includes('/organizations/current/members'))).toBe(false);
    stub.restore();
  });

  it('renders the denied state when a privileged session gets 403 from the roster (role drift)', async () => {
    const stub = stubTeam({ role: 'owner', membersStatus: 403, membersBody: errorEnvelope('FORBIDDEN', 'No.') });

    renderApp(['/app/team']);

    expect(await screen.findByText(/Access denied/i)).toBeDefined();
    stub.restore();
  });

  it('renders the error state with retry when the roster fails', async () => {
    const stub = stubTeam({ role: 'owner', membersStatus: 500, membersBody: errorEnvelope('INTERNAL', 'Database unavailable.') });

    renderApp(['/app/team']);

    // The panel echoes the API's detail message, with a retry action.
    expect(await screen.findByText('Something went wrong')).toBeDefined();
    expect(screen.getByText('Database unavailable.')).toBeDefined();
    stub.restore();
  });

  it('paginates the roster', async () => {
    // The roster endpoint echoes the requested page (30 members → 2 pages).
    const stub = installFetchStub((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meFixture([membershipFixture(ORG_A_ID, 'City of Austin IT', 'owner')]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'GET' && request.url.includes('/organizations/current/members')) {
        const page = Number(new URL(request.url, 'http://localhost').searchParams.get('page') ?? '1');
        return { status: 200, body: pageEnvelope([memberFixture()], page, 25, 30) };
      }
      return undefined;
    });

    renderApp(['/app/team']);
    await screen.findByText(/Page 1 of 2 · 30 members/);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(/Page 2 of 2 · 30 members/);
    const secondCall = stub.requests.filter(
      (request) => request.method === 'GET' && request.url.includes('/organizations/current/members'),
    )[1];
    expect(new URL(secondCall.url, 'http://localhost').searchParams.get('page')).toBe('2');
    stub.restore();
  });
});
