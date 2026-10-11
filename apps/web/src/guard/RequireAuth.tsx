// Route guard for every authenticated area. While session state is loading it
// renders the loading screen; a dead session redirects to /auth/login and
// remembers the attempted path so onboarding can restore it after the OIDC
// round-trip (sessionStorage survives the full-page navigations).
import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSession } from '../session/SessionProvider';
import { FullPageError, FullPageLoading } from '../states/States';

export const POST_LOGIN_REDIRECT_KEY = 'resolveops.post-login-redirect';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, refresh } = useSession();
  const location = useLocation();

  useEffect(() => {
    if (status === 'unauthenticated') {
      sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, location.pathname);
    }
  }, [status, location.pathname]);

  if (status === 'loading') {
    return <FullPageLoading label="Checking your session…" />;
  }
  if (status === 'error') {
    return (
      <FullPageError
        title="ResolveOps could not be reached"
        detail="We could not load your session. Check your connection and try again."
        onRetry={() => {
          void refresh();
        }}
      />
    );
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/auth/login" replace />;
  }
  return <>{children}</>;
}
