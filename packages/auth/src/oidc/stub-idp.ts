import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { calculatePKCECodeChallenge } from 'openid-client';
import type { ExchangeCodeParams, LoginFlow, OidcAdapter } from './types';
import { signJwt, validateIdTokenClaims, verifyJwtHS256, type IdTokenClaims, type JsonValue } from './jwt';
import { AuthError } from '../errors';

export interface StubIdpOptions {
  /** Absolute issuer URL; the authorization endpoint is `${issuer}/authorize`. */
  issuer?: string;
  clientId?: string;
  /** Defaults to clientId — OIDC requires aud to include the client. */
  audience?: string;
  /** HMAC key for code tickets and ID tokens. Random per instance when omitted. */
  signingKey?: string;
  /** Default claims minted into ID tokens; `authorizeFromUrl` can override per login. */
  claims?: { email?: string; displayName?: string };
  /** Ticket (authorization code) lifetime. */
  codeTtlMs?: number;
  /** Convenience ceiling surfaced for the API's login_flow_state row. */
  loginFlowTtlMs?: number;
  now?: () => Date;
}

interface CodeTicketPayload {
  sub: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  email: string | null;
  name: string | null;
  exp: number;
}

const TICKET_SEGMENT_SEPARATOR = '.';

function hmacBase64Url(key: string, input: string): string {
  return createHmac('sha256', key).update(input).digest('base64url');
}

/**
 * Dev/test identity provider: signs its own code tickets and ID tokens with
 * an in-process HMAC key, performs PKCE verification exactly like a real
 * token endpoint would, and never touches the network. The CONTRACT is not
 * stubbed — tokens are minted and validated through the same claim rule set
 * Part B uses (`validateIdTokenClaims`).
 */
export class StubIdp implements OidcAdapter {
  readonly issuer: string;

  readonly clientId: string;

  private readonly audience: string;

  private readonly signingKey: string;

  private readonly defaultClaims: { email?: string; displayName?: string };

  private readonly codeTtlMs: number;

  private readonly loginFlowTtlMs: number;

  private readonly now: () => Date;

  constructor(options: StubIdpOptions = {}) {
    this.issuer = options.issuer ?? 'https://stub-idp.resolveops.test';
    this.clientId = options.clientId ?? 'resolveops-api-dev';
    this.audience = options.audience ?? this.clientId;
    this.signingKey = options.signingKey ?? randomBytes(32).toString('base64url');
    this.defaultClaims = options.claims ?? {};
    this.codeTtlMs = options.codeTtlMs ?? 60_000;
    this.loginFlowTtlMs = options.loginFlowTtlMs ?? 600_000;
    this.now = options.now ?? (() => new Date());
  }

  async createLoginFlow(redirectUri: string): Promise<LoginFlow> {
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return {
      authorizationUrl: `${this.issuer}/authorize?${params.toString()}`,
      state,
      nonce,
      codeVerifier,
      redirectUri,
      expiresAt: new Date(this.now().getTime() + this.loginFlowTtlMs),
    };
  }

  /**
   * The stub's "local authorization endpoint": parses the authorization URL
   * the login route redirected to, authenticates the supplied subject, and
   * returns the callback redirect URL carrying a single-use signed code.
   * Tests (and later a dev-only HTTP route) call this in place of a browser.
   */
  async authorizeFromUrl(
    authorizationUrl: string,
    authentication: { subject: string; email?: string; displayName?: string } = { subject: 'stub-user' },
  ): Promise<string> {
    const url = new URL(authorizationUrl);
    if (!url.pathname.endsWith('/authorize')) {
      throw new AuthError('BAD_REQUEST', 'StubIdp.authorizeFromUrl expects the authorization endpoint URL.');
    }
    const state = url.searchParams.get('state');
    const nonce = url.searchParams.get('nonce');
    const challenge = url.searchParams.get('code_challenge');
    const redirectUri = url.searchParams.get('redirect_uri');
    const clientId = url.searchParams.get('client_id');
    if (!state || !nonce || !challenge || !redirectUri || !clientId) {
      throw new AuthError('BAD_REQUEST', 'Authorization request is missing required parameters.');
    }
    if (clientId !== this.clientId) {
      throw new AuthError('BAD_REQUEST', `Unknown client_id: ${clientId}`);
    }
    const exp = Math.floor(this.now().getTime() / 1000) + Math.floor(this.codeTtlMs / 1000);
    const ticket: CodeTicketPayload = {
      sub: authentication.subject,
      nonce,
      challenge,
      redirectUri,
      email: authentication.email ?? this.defaultClaims.email ?? null,
      name: authentication.displayName ?? this.defaultClaims.displayName ?? null,
      exp,
    };
    const encodedTicket = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url');
    const signature = hmacBase64Url(this.signingKey, encodedTicket);
    const code = `${encodedTicket}${TICKET_SEGMENT_SEPARATOR}${signature}`;
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);
    return callbackUrl.toString();
  }

  async exchangeCode(params: ExchangeCodeParams): Promise<IdTokenClaims> {
    const ticket = this.decodeTicket(params.code);
    if (ticket.exp * 1000 <= this.now().getTime()) {
      throw new AuthError('BAD_REQUEST', 'Authorization code expired.');
    }
    if (ticket.redirectUri !== params.redirectUri) {
      throw new AuthError('BAD_REQUEST', 'redirect_uri mismatch on code exchange.');
    }
    const challenge = await calculatePKCECodeChallenge(params.codeVerifier);
    if (challenge !== ticket.challenge) {
      throw new AuthError('BAD_REQUEST', 'PKCE verification failed.');
    }
    const nowSec = Math.floor(this.now().getTime() / 1000);
    const idToken = signJwt(
      {
        iss: this.issuer,
        sub: ticket.sub,
        aud: this.audience,
        email: ticket.email,
        name: ticket.name,
        nonce: ticket.nonce,
        iat: nowSec,
        exp: nowSec + 300,
      },
      this.signingKey,
    );
    return this.validateIdToken(idToken);
  }

  /** Validates a minted token through the shared rule set (iss/aud/exp). */
  validateIdToken(idToken: string): IdTokenClaims {
    const decoded = verifyJwtHS256(idToken, this.signingKey);
    if (!decoded || !decoded.signatureValid) {
      throw new AuthError('BAD_REQUEST', 'ID token signature verification failed.');
    }
    const result = validateIdTokenClaims(decoded.payload, {
      issuer: this.issuer,
      audience: this.audience,
      now: this.now().getTime(),
    });
    if (!result.ok) {
      throw new AuthError('BAD_REQUEST', result.reason);
    }
    return result.claims;
  }

  private decodeTicket(code: string): CodeTicketPayload {
    const separatorIndex = code.lastIndexOf(TICKET_SEGMENT_SEPARATOR);
    if (separatorIndex <= 0) {
      throw new AuthError('BAD_REQUEST', 'Authorization code is malformed.');
    }
    const encodedTicket = code.slice(0, separatorIndex);
    const presentedSignature = code.slice(separatorIndex + 1);
    const expectedSignature = hmacBase64Url(this.signingKey, encodedTicket);
    const presented = Buffer.from(presentedSignature);
    const expected = Buffer.from(expectedSignature);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new AuthError('BAD_REQUEST', 'Authorization code signature verification failed.');
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(Buffer.from(encodedTicket, 'base64url').toString('utf8')) as JsonValue;
    } catch {
      throw new AuthError('BAD_REQUEST', 'Authorization code is malformed.');
    }
    const ticket = parsed as unknown as CodeTicketPayload;
    if (
      typeof ticket.sub !== 'string'
      || typeof ticket.nonce !== 'string'
      || typeof ticket.challenge !== 'string'
      || typeof ticket.redirectUri !== 'string'
      || typeof ticket.exp !== 'number'
    ) {
      throw new AuthError('BAD_REQUEST', 'Authorization code payload is malformed.');
    }
    return ticket;
  }
}
