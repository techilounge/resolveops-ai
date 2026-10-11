// Session context for the live app: who is signed in, their memberships, the
// active organization, and the operations that mutate server-side session
// state. No state library — one provider, plain hooks (P1-5 constraint).
// Registers the API client's 401 handler so a dead session clears state
// app-wide and the route guards land the user on sign-in.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MeResponse, Organization } from '@resolveops/shared';
import { ApiError, resetClientState, setUnauthorizedHandler } from '../api/client';
import { getCurrentOrganization, getMe, logout, switchActiveOrganization } from '../api/endpoints';

export type SessionStatus = 'loading' | 'ready' | 'unauthenticated' | 'error';

export interface SessionContextValue {
  status: SessionStatus;
  me: MeResponse | null;
  currentOrg: Organization | null;
  /** Full reload of session data (initial mount, retry after error). */
  refresh: () => Promise<void>;
  /** Switches the session's active organization, then reloads reads. */
  switchOrg: (organizationId: string) => Promise<void>;
  /** Revokes the server session and clears local state. */
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used within SessionProvider.');
  }
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [currentOrg, setCurrentOrg] = useState<Organization | null>(null);
  const [status, setStatus] = useState<SessionStatus>('loading');

  const refresh = useCallback(async (mode: 'initial' | 'silent' = 'initial') => {
    if (mode === 'initial') {
      setStatus('loading');
    }
    try {
      const nextMe = await getMe();
      setMe(nextMe);
      try {
        setCurrentOrg(await getCurrentOrganization());
      } catch (error) {
        // A failed GET /organizations/current with a live session usually
        // means "no active organization yet" (fresh login, or the route's
        // 4xx shapes from the API wave) — an empty-org state, not an error.
        if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
          return; // handler already moved the app to the sign-in state
        }
        if (!(error instanceof ApiError) || error.status >= 500) {
          throw error; // outer catch → app error state
        }
        setCurrentOrg(null);
      }
      setStatus('ready');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
        return; // handler already moved the app to the sign-in state
      }
      setStatus('error');
    }
  }, []);

  const switchOrg = useCallback(
    async (organizationId: string) => {
      await switchActiveOrganization(organizationId);
      await refresh('silent');
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await logout();
    } finally {
      resetClientState();
      setMe(null);
      setCurrentOrg(null);
      setStatus('unauthenticated');
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      resetClientState();
      setMe(null);
      setCurrentOrg(null);
      setStatus('unauthenticated');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    void refresh('initial');
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ status, me, currentOrg, refresh, switchOrg, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}
