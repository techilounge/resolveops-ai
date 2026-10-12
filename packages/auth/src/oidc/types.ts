/**
 * The OIDC adapter seam (Phase 1 Blueprint §4.2). Two implementations share
 * this interface: `StubIdp` (dev/test, fully local, zero network) and
 * `EntraIdp` (Part B — real Entra wiring behind the same contract, so claim
 * shape risk is confined to one adapter).
 */
import type { IdTokenClaims } from './jwt';

export interface LoginFlow {
  /** Absolute URL the browser is redirected to (the IdP authorization endpoint). */
  authorizationUrl: string;
  /** Anti-CSRF parameter for the login flow (protects only the login round-trip). */
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  /** After this instant the flow state is dead even if its row lingers. */
  expiresAt: Date;
}

export interface ExchangeCodeParams {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /**
   * The nonce bound to this login flow (from `login_flow_state`). Adapters
   * that validate the ID token in-band (EntraIdp via openid-client's strict
   * nonce check) require it; the API layer re-checks the returned claim for
   * every adapter, so a stub that ignores the field stays correct.
   */
  expectedNonce?: string;
}

/**
 * Everything the login flow needs from the identity provider. Implementations
 * must validate issuer/audience/expiry (and signature where applicable) before
 * returning claims — `validateIdTokenClaims` is the shared rule set.
 */
export interface OidcAdapter {
  createLoginFlow(redirectUri: string): Promise<LoginFlow>;
  exchangeCode(params: ExchangeCodeParams): Promise<IdTokenClaims>;
}
