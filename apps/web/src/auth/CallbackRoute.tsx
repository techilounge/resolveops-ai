// /auth/callback — the browser lands here only when the API's OIDC callback
// redirected to the web origin (split-hosting setup) or someone opened the
// route directly. In the same-origin topology the API's callback already set
// the session cookie and forwarded to /onboarding; this screen completes the
// same journey by walking to the guarded area, whose session check is the
// real verdict. An IdP-reported error (?error=…) is displayed verbatim.
import { Link, Navigate, useSearchParams } from 'react-router';

export function CallbackRoute() {
  const [searchParams] = useSearchParams();
  const idpError = searchParams.get('error');

  if (idpError) {
    return (
      <div className="state-fullscreen">
        <div className="state-card state-error" role="alert">
          <span className="live-kicker">SIGN IN</span>
          <h1>Sign-in failed</h1>
          <p>
            The identity provider reported: <strong>{idpError}</strong>
          </p>
          <Link className="live-button" to="/auth/login">
            Restart sign-in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="state-fullscreen" role="status">
      <div className="state-card">
        <span className="live-kicker">SIGN IN</span>
        <h1>Completing sign-in…</h1>
        <p>
          Taking you to your workspace. If nothing happens,{' '}
          <Link to="/onboarding">continue to setup</Link>.
        </p>
      </div>
      <Navigate to="/onboarding" replace />
    </div>
  );
}
