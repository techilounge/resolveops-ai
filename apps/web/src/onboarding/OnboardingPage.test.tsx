// Onboarding states (P1-5): already-member, create-org happy path (create →
// membership verification → switch → land in /app), API error, denied, and
// the membership-verification failure the acceptance cases name.
// @vitest-environment jsdom
import { fireEvent, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { OnboardingPage } from './OnboardingPage';
import { SessionProvider } from '../session/SessionProvider';
import { resetClientState, setUnauthorizedHandler } from '../api/client';
import { TEST_IDS, installFetchStub, type FetchHandler } from '../testing/fetchStub';

const { user: USER_ID, orgA: ORG_A_ID, orgB: ORG_B_ID } = TEST_IDS;

const ORG_A = {
  id: ORG_A_ID,
  name: 'City of Austin IT',
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
};

function orgBody(id: string, name: string): unknown {
  return { id, name, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' };
}

function meBody(memberships: { organizationId: string; role: string }[]): unknown {
  return {
    user: { id: USER_ID, displayName: 'Avery Analyst', email: 'avery@example.com' },
    memberships,
  };
}

function AppLanding(): ReactElement {
  return <div>APP_LANDING</div>;
}

function renderOnboarding(): void {
  render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <SessionProvider>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/app" element={<AppLanding />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('OnboardingPage', () => {
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

  it('already-member: offers opening the organization and lands in /app', async () => {
    const stub = installFetchStub(((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meBody([{ organizationId: ORG_A_ID, role: 'owner' }]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 200, body: ORG_A };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/me/active-organization')) {
        return { status: 204, body: null };
      }
      return undefined;
    }) satisfies FetchHandler);
    restore = stub.restore;

    renderOnboarding();

    // The membership's org is already active, so the card offers "Continue as
    // <org name> (<role>)" — clicking it switches (no-op) and lands in /app.
    const openButton = await screen.findByRole('button', { name: /continue as city of austin it/i });
    fireEvent.click(openButton);

    await waitFor(() => expect(screen.getByText('APP_LANDING')).toBeDefined());
    stub.restore();
  });

  it('create-org happy path: creates, verifies membership, switches, lands in /app', async () => {
    let created = false;
    const stub = installFetchStub(((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        // Before create: no memberships; after create: the new one appears.
        return {
          status: 200,
          body: created ? meBody([{ organizationId: ORG_B_ID, role: 'owner' }]) : meBody([]),
        };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No active organization.' } } };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/organizations')) {
        created = true;
        return { status: 201, body: orgBody(ORG_B_ID, 'New Shire IT') };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/me/active-organization')) {
        return { status: 204, body: null };
      }
      return undefined;
    }) satisfies FetchHandler);
    restore = stub.restore;

    renderOnboarding();

    const input = await screen.findByLabelText('Organization name');
    fireEvent.change(input, { target: { value: 'New Shire IT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(screen.getByText('APP_LANDING')).toBeDefined());

    const post = stub.requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/api/v1/organizations'),
    );
    expect(post?.body).toEqual({ name: 'New Shire IT' });
    const switchCall = stub.requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/api/v1/me/active-organization'),
    );
    expect(switchCall?.body).toEqual({ organizationId: ORG_B_ID });
    stub.restore();
  });

  it('create-org API error: shows the retryable error panel and keeps the form', async () => {
    const stub = installFetchStub(((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meBody([]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No active organization.' } } };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/organizations')) {
        return { status: 500, body: { error: { code: 'INTERNAL', message: 'Database unavailable.' } } };
      }
      return undefined;
    }) satisfies FetchHandler);
    restore = stub.restore;

    renderOnboarding();

    const input = await screen.findByLabelText('Organization name');
    fireEvent.change(input, { target: { value: 'New Shire IT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText('Something went wrong')).toBeDefined();
    expect(await screen.findByText(/Database unavailable|could not be created/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create organization' }).hasAttribute('disabled')).toBe(false);
    stub.restore();
  });

  it('create-org denied: shows the denied panel on 403', async () => {
    const stub = installFetchStub(((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meBody([]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No active organization.' } } };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/organizations')) {
        return { status: 403, body: { error: { code: 'FORBIDDEN', message: 'You do not have access.' } } };
      }
      return undefined;
    }) satisfies FetchHandler);
    restore = stub.restore;

    renderOnboarding();

    const input = await screen.findByLabelText('Organization name');
    fireEvent.change(input, { target: { value: 'New Shire IT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    // 403 → the canonical denied panel renders (no API detail echoed).
    expect(await screen.findByText(/Access denied/i)).toBeDefined();
    stub.restore();
  });

  it('membership verification failure: flags a create whose membership never appears', async () => {
    const stub = installFetchStub(((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        // /me never reflects the new organization even after create.
        return { status: 200, body: meBody([]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No active organization.' } } };
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/organizations')) {
        return { status: 201, body: orgBody(ORG_B_ID, 'New Shire IT') };
      }
      return undefined;
    }) satisfies FetchHandler);
    restore = stub.restore;

    renderOnboarding();

    const input = await screen.findByLabelText('Organization name');
    fireEvent.change(input, { target: { value: 'New Shire IT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText(/membership is not visible yet/i)).toBeDefined();
    stub.restore();
  });

  it('empty name is rejected client-side without a network call', async () => {
    const stub = installFetchStub(((request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/me')) {
        return { status: 200, body: meBody([]) };
      }
      if (request.method === 'GET' && request.url.endsWith('/api/v1/organizations/current')) {
        return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No active organization.' } } };
      }
      return undefined;
    }) satisfies FetchHandler);
    restore = stub.restore;

    renderOnboarding();

    await screen.findByLabelText('Organization name');
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText(/Enter an organization name/i)).toBeDefined();
    const post = stub.requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/api/v1/organizations'),
    );
    expect(post).toBeUndefined();
    stub.restore();
  });
});
