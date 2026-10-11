import { Configuration } from 'openid-client';
import { EntraIdpNotWiredError } from '../errors';
import type { ExchangeCodeParams, LoginFlow, OidcAdapter } from './types';

export interface EntraIdpOptions {
  /** e.g. https://login.microsoftonline.com/<tenant-id>/v2.0 */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /**
   * Server metadata for the tenant. Part B fetches it via discovery(); Part A
   * accepts it as a literal (typically from tests) so the seam can be
   * constructed and type-checked with zero network access.
   */
  serverMetadata: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    [key: string]: unknown;
  };
}

/**
 * Part B seam (Phase 1 Blueprint §4.2): constructing it validates
 * configuration and builds the openid-client v6 configuration without any
 * network access, but every protocol operation throws until Part B wires the
 * real tenant. Part B's implementation must use Authorization Code + PKCE
 * (S256) and validate the returned ID token through `validateIdTokenClaims`
 * (issuer/audience/expiry; the nonce check stays at the API layer).
 */
export class EntraIdp implements OidcAdapter {
  private readonly configuration: Configuration;

  constructor(options: EntraIdpOptions) {
    if (!options.issuer.startsWith('https://')) {
      throw new Error('EntraIdp issuer must be an https URL.');
    }
    if (options.clientId.length === 0 || options.clientSecret.length === 0) {
      throw new Error('EntraIdp requires clientId and clientSecret.');
    }
    this.configuration = new Configuration(
      options.serverMetadata as never,
      options.clientId,
      options.clientSecret,
    );
  }

  async createLoginFlow(_redirectUri: string): Promise<LoginFlow> {
    throw new EntraIdpNotWiredError('createLoginFlow');
  }

  async exchangeCode(_params: ExchangeCodeParams): Promise<never> {
    throw new EntraIdpNotWiredError('exchangeCode');
  }

  /** Exposed for Part B so the wired implementation reuses this configuration. */
  get clientConfiguration(): Configuration {
    return this.configuration;
  }
}
