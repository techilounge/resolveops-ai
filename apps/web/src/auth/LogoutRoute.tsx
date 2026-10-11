// /auth/logout — revokes the server session (row delete + cookie clear via
// POST /api/v1/auth/logout with the synchronizer token) and lands on the
// sign-in screen. A 401 during sign-out means the session was already gone:
// that is success for this route's purpose.
import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { ApiError } from '../api/client';
import { useSession } from '../session/SessionProvider';

export function LogoutRoute() {
  const { signOut } = useSession();
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    signOut()
      .then(() => setDone(true))
      .catch((error: unknown) => {
        // Already signed out server-side — the goal is achieved either way.
        if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
          setDone(true);
          return;
        }
        setFailure(error instanceof Error ? error.message : 'Sign-out could not be completed.');
      });
  }, [signOut]);

  if (done) {
    return <Navigate to="/auth/login" replace />;
  }

  if (failure !== null) {
    return (
      <div className="state-fullscreen">
        <div className="state-card state-error" role="alert">
          <h1>Sign-out problem</h1>
          <p>{failure}</p>
          <Link className="live-button" to="/auth/login">
            Back to sign-in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="state-fullscreen" role="status">
      <div className="state-card">
        <span className="live-kicker">SIGN OUT</span>
        <h1>Signing you out…</h1>
      </div>
    </div>
  );
}
