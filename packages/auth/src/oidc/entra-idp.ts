import { randomBytes } from 'node:crypto';
import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  Configuration,
  discovery,
  type IDToken,
} from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AuthError } from '../errors';
import type { ExchangeCodeParams, LoginFlow, OidcAdapter } from './types';
import type { IdTokenClaims } from './jwt';

export interface EntraIdpOptions {
  /** e.g. https://login.microsoftonline.com/<tenant-id>/v2.0 */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /**
   * Server metadata for the tenant. `discover()` fetches it over the network;
   * the literal form exists so the adapter can be constructed and
   * type-checked with zero network access (tests inject loopback endpoints).
   */
  serverMetadata: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    [key: string]: unknown;
  };
  /**
   * Loopback-test affordance ONLY: allows plain-http token/JWKS endpoints so
   * the offline protocol suite can point the adapter at 127.0.0.1 fakes.
   * `discover()` never enables this — real tenants are always https.
   */
  allowInsecureRequests?: boolean;
}

export interface EntraIdpDiscoverOptions {
  /** Tenant-specific issuer, e.g. https://login.microsoftonline.com/<tenant-id>/v2.0 */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Login-flow state TTL. Defaults to the API's 10-minute flow window. */
  loginFlowTtlMs?: number;
}

const DEFAULT_LOGIN_FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * Part B implementation (Phase 1 Blueprint §4.2): the real Entra identity
 * provider behind the same `OidcAdapter` contract as `StubIdp`.
 *
 * Protocol decisions (Authorization Code + PKCE S256):
 * - `discover()` fetches the tenant's OIDC metadata at boot; openid-client
 *   rejects a discovered issuer that does not exactly match the input URL,
 *   which pins the single-tenant app registration to its own authority.
 * - Claim validation (issuer, audience, expiry, and, when `expectedNonce`
 *   is passed, the nonce) is openid-client's job inside the grant. Its v6
 *   code-grant API does NOT verify signatures; this adapter closes that gap
 *   by verifying every token-response ID token against the tenant JWKS with
 *   `jose` under an RS256 allowlist, failing closed without a `jwks_uri`.
 *   State is validated at the API layer before the exchange (single-use
 *   `login_flow_state` row), so the adapter never sees it.
 * - Nothing here reads configuration values: the issuer/client credentials
 *   arrive through `AuthOptions` wiring from environment/secret references.
 */
export class EntraIdp implements OidcAdapter {
  private readonly configuration: Configuration;

  private readonly issuer: string;

  private readonly clientId: string;

  private readonly jwksUri: string | null;

  private remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  private readonly loginFlowTtlMs: number;

  private constructor(
    configuration: Configuration,
    issuer: string,
    clientId: string,
    jwksUri: string | null,
    loginFlowTtlMs: number,
  ) {
    this.configuration = configuration;
    this.issuer = issuer;
    this.clientId = clientId;
    this.jwksUri = jwksUri;
    this.loginFlowTtlMs = loginFlowTtlMs;
  }

  /**
   * Offline construction from explicit server metadata — the seam Part A
   * type-checked against, and the path the offline protocol tests use to
   * point the adapter at loopback token/JWKS endpoints.
   */
  static fromMetadata(options: EntraIdpOptions, loginFlowTtlMs = DEFAULT_LOGIN_FLOW_TTL_MS): EntraIdp {
    if (!options.issuer.startsWith('https://')) {
      throw new Error('EntraIdp issuer must be an https URL.');
    }
    if (options.clientId.length === 0 || options.clientSecret.length === 0) {
      throw new Error('EntraIdp requires clientId and clientSecret.');
    }
    const configuration = new Configuration(
      options.serverMetadata as never,
      options.clientId,
      options.clientSecret,
    );
    if (options.allowInsecureRequests === true) {
      allowInsecureRequests(configuration);
    }
    const jwksUri = typeof options.serverMetadata.jwks_uri === 'string' ? options.serverMetadata.jwks_uri : null;
    return new EntraIdp(configuration, options.serverMetadata.issuer, options.clientId, jwksUri, loginFlowTtlMs);
  }

  /**
   * Boot-time discovery against the tenant authority. Fails fast on an
   * unreachable tenant or an issuer that does not match the configured
   * authority — a staging deploy with a mistyped tenant id must not boot.
   */
  static async discover(options: EntraIdpDiscoverOptions): Promise<EntraIdp> {
    if (!options.issuer.startsWith('https://')) {
      throw new Error('EntraIdp issuer must be an https URL.');
    }
    if (options.clientId.length === 0 || options.clientSecret.length === 0) {
      throw new Error('EntraIdp requires clientId and clientSecret.');
    }
    const configuration = await discovery(
      new URL(options.issuer),
      options.clientId,
      options.clientSecret,
    );
    const metadata = configuration.serverMetadata();
    const issuer = metadata.issuer;
    const jwksUri = typeof metadata.jwks_uri === 'string' ? metadata.jwks_uri : null;
    return new EntraIdp(configuration, issuer, options.clientId, jwksUri, options.loginFlowTtlMs ?? DEFAULT_LOGIN_FLOW_TTL_MS);
  }

  async createLoginFlow(redirectUri: string): Promise<LoginFlow> {
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    // client_id comes from the Configuration (discovered or injected) —
    // duplicating it in the parameters would be a second source of truth.
    const authorizationUrl = buildAuthorizationUrl(this.configuration, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return {
      authorizationUrl: authorizationUrl.href,
      state,
      nonce,
      codeVerifier,
      redirectUri,
      expiresAt: new Date(Date.now() + this.loginFlowTtlMs),
    };
  }

  /**
   * The adapter contract's exchange: verifies the authorization code against
   * the tenant token endpoint (PKCE S256), validates the ID token strictly
   * (JWKS signature, issuer, audience, expiry, nonce), and maps the result
   * into the repo's normalized `IdTokenClaims` shape.
   */
  async exchangeCode(params: ExchangeCodeParams): Promise<IdTokenClaims> {
    if (params.expectedNonce === undefined) {
      // Strict nonce validation is the point of the Entra path — a caller
      // that drops the flow nonce must not silently downgrade to no check.
      throw new AuthError('BAD_REQUEST', 'EntraIdp requires the login flow nonce to validate the ID token.');
    }
    // The callback the API received carries only code (+ state, checked at
    // the API layer); openid-client derives both the code and the token
    // request's redirect_uri from this URL (params are stripped).
    const currentUrl = new URL(params.redirectUri);
    currentUrl.searchParams.set('code', params.code);
    const tokenSet = await authorizationCodeGrant(this.configuration, currentUrl, {
      pkceCodeVerifier: params.codeVerifier,
      expectedNonce: params.expectedNonce,
    });
    // openid-client v6 validates ID token CLAIMS in the code flow (iss, aud,
    // exp, and the expected nonce — confirmed in its source) but not the
    // signature; that responsibility is ours. An unverified token must never
    // become a session, so this runs before any claim mapping.
    if (!tokenSet.id_token) {
      throw new AuthError('BAD_REQUEST', 'The identity provider did not return an ID token.');
    }
    await this.verifyIdTokenSignature(tokenSet.id_token);
    const raw = tokenSet.claims();
    if (!raw) {
      throw new AuthError('BAD_REQUEST', 'The identity provider did not return an ID token.');
    }
    return this.mapClaims(raw);
  }

  /**
   * Verifies the token-response ID token's signature against the tenant
   * JWKS (fetched once per adapter, cached by jose) under a strict RS256
   * allowlist, re-checking issuer and audience. Fails closed when the
   * tenant metadata does not advertise a `jwks_uri`.
   */
  private async verifyIdTokenSignature(idToken: string): Promise<void> {
    if (this.jwksUri === null) {
      throw new AuthError('BAD_REQUEST', 'Tenant server metadata does not advertise a jwks_uri; unable to verify ID token signatures.');
    }
    this.remoteJwks ??= createRemoteJWKSet(new URL(this.jwksUri));
    await jwtVerify(idToken, this.remoteJwks, {
      issuer: this.issuer,
      audience: this.clientId,
      algorithms: ['RS256'],
    });
  }

  /**
   * Maps the validated ID token into the repo's claim shape. Entra v2 tokens
   * carry the user principal in `preferred_username` and only include `email`
   * when optional claims are configured — the fallback keeps first-login
   * provisioning and invite-email binding working in both cases.
   */
  private mapClaims(raw: IDToken): IdTokenClaims {
    if (typeof raw.sub !== 'string' || raw.sub.length === 0) {
      throw new AuthError('BAD_REQUEST', 'ID token subject missing.');
    }
    const email = typeof raw.email === 'string' && raw.email.length > 0
      ? raw.email
      : typeof raw.preferred_username === 'string' && raw.preferred_username.includes('@')
        ? raw.preferred_username
        : null;
    return {
      issuer: this.issuer,
      subject: raw.sub,
      audience: typeof raw.aud === 'string' ? raw.aud : this.clientId,
      email,
      displayName: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null,
      nonce: typeof raw.nonce === 'string' ? raw.nonce : null,
      expiresAt: typeof raw.exp === 'number' ? raw.exp : 0,
    };
  }
}
