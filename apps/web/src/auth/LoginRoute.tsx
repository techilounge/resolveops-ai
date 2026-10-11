// /auth/login — hands the browser to the API's login flow, which owns the
// OIDC state/nonce/PKCE machinery (packages/auth). The rendered link is the
// no-script fallback and the testable surface for the redirect target.
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { apiBaseUrl } from '../api/client';
import { API_PATHS } from '../api/endpoints';

export function LoginRoute() {
  const loginUrl = `${apiBaseUrl()}${API_PATHS.login}`;
  const didRedirect = useRef(false);

  useEffect(() => {
    if (didRedirect.current) {
      return; // StrictMode double-invoke must not fire two navigations
    }
    didRedirect.current = true;
    window.location.assign(loginUrl);
  }, [loginUrl]);

  return (
    <div className="state-fullscreen">
      <div className="state-card">
        <span className="live-kicker">SIGN IN</span>
        <h1>Redirecting you to your organization's sign-in page…</h1>
        <p role="status">
          If you are not redirected, <a href={loginUrl}>continue to sign-in</a>.
        </p>
        <p className="state-detail">
          Just looking around? The <Link to="/demo">offline demo</Link> needs no sign-in.
        </p>
      </div>
    </div>
  );
}
