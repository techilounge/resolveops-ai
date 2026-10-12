import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntraIdp } from './entra-idp';
import type { ExchangeCodeParams } from './types';

const FAKE_ISSUER = 'https://login.microsoftonline.com/fake-tenant-id/v2.0';
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'https://staging.example.test/auth/callback';
const KID = 'test-signing-key-1';

interface TokenRequestBody {
  grantType: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
}

interface CapturedRequest {
  body: TokenRequestBody | null;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function publicJwkFor(publicKey: KeyObject): Record<string, unknown> {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid: KID, alg: 'RS256', use: 'sig' };
}

function signIdToken(privateKey: KeyObject, payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  const signature = signer.sign(privateKey);
  return `${header}.${body}.${signature.toString('base64url')}`;
}

function baseClaims(nonce: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: FAKE_ISSUER,
    sub: 'entra-subject-1',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    nonce,
    email: 'ada@example.test',
    preferred_username: 'ada@example.test',
    name: 'Ada Lovelace',
    ...overrides,
  };
}

/**
 * Minimal fake of a tenant's token endpoint + JWKS. Exists only to exercise
 * openid-client's strict validation paths offline (PKCE, client auth, ID
 * token signature/issuer/nonce/expiry). Never connects to a real tenant.
 */
class FakeTenant {
  readonly requests: CapturedRequest[] = [];

  private readonly server: Server;

  private readonly primary: { privateKey: KeyObject; publicKey: KeyObject };

  private readonly foreign: { privateKey: KeyObject; publicKey: KeyObject };

  /** Challenge the fake token endpoint demands (mirrors the authorization request). */
  expectedChallenge: string | null = null;

  /** The claims the token endpoint signs. Each test sets exactly one. */
  tokenPayload: Record<string, unknown> | null = null;

  /** When true, the token endpoint signs with the key the JWKS does NOT serve. */
  respondWithForeignSignature = false;

  private readonly portReady: Promise<number>;

  constructor() {
    this.primary = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let settled: (port: number) => void;
    this.portReady = new Promise<number>((resolve) => { settled = resolve; });
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.listen(0, '127.0.0.1', () => {
      settled((this.server.address() as AddressInfo).port);
    });
  }

  get port(): number {
    // Resolved before any test runs (beforeAll awaits portReady).
    return (this.server.address() as AddressInfo).port;
  }

  async ready(): Promise<void> {
    await this.portReady;
  }

  /** Signs with the JWKS-served key. */
  signWithServedKey(payload: Record<string, unknown>): string {
    return signIdToken(this.primary.privateKey, payload);
  }

  /** Signs with a key the JWKS does NOT serve (signature-mismatch test). */
  signWithForeignRsaKey(payload: Record<string, unknown>): string {
    return signIdToken(this.foreign.privateKey, payload);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url?.startsWith('/jwks')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwkFor(this.primary.publicKey)] }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/token')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const captured: CapturedRequest = {
        body: {
          grantType: form.get('grant_type') ?? '',
          code: form.get('code') ?? '',
          redirectUri: form.get('redirect_uri') ?? '',
          codeVerifier: form.get('code_verifier') ?? '',
          clientId: form.get('client_id') ?? '',
          clientSecret: form.get('client_secret') ?? '',
        },
      };
      this.requests.push(captured);
      if (this.expectedChallenge !== null) {
        const observed = createHash('sha256').update(captured.body?.codeVerifier ?? '', 'ascii').digest('base64url');
        if (observed !== this.expectedChallenge) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
      }
      if (this.tokenPayload === null) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'test_error', error_description: 'tokenPayload not set' }));
        return;
      }
      const idToken = this.respondWithForeignSignature
        ? this.signWithForeignRsaKey(this.tokenPayload)
        : this.signWithServedKey(this.tokenPayload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'at-1',
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid profile email',
        id_token: idToken,
      }));
      return;
    }
    res.writeHead(404).end();
  }
}

function buildAdapter(tenant: FakeTenant): EntraIdp {
  return EntraIdp.fromMetadata({
    issuer: FAKE_ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    allowInsecureRequests: true,
    serverMetadata: {
      issuer: FAKE_ISSUER,
      authorization_endpoint: `${FAKE_ISSUER}/authorize`,
      token_endpoint: `http://127.0.0.1:${tenant.port}/token`,
      jwks_uri: `http://127.0.0.1:${tenant.port}/jwks`,
    },
  });
}

describe('EntraIdp (offline protocol, loopback tenant)', () => {
  let tenant: FakeTenant;

  beforeAll(async () => {
    tenant = new FakeTenant();
    await tenant.ready();
  });

  afterAll(async () => {
    await tenant.close();
  });

  it('exchanges a code with PKCE S256 and client auth, then returns strictly validated mapped claims', async () => {
    const adapter = buildAdapter(tenant);
    const flow = await adapter.createLoginFlow(REDIRECT_URI);
    tenant.expectedChallenge = new URL(flow.authorizationUrl).searchParams.get('code_challenge');
    tenant.tokenPayload = baseClaims(flow.nonce);
    tenant.requests.length = 0;

    const params: ExchangeCodeParams = {
      code: 'one-time-code',
      codeVerifier: flow.codeVerifier,
      redirectUri: REDIRECT_URI,
      expectedNonce: flow.nonce,
    };
    const claims = await adapter.exchangeCode(params);
    expect(claims.subject).toBe('entra-subject-1');
    expect(claims.issuer).toBe(FAKE_ISSUER);
    expect(claims.audience).toBe(CLIENT_ID);
    expect(claims.email).toBe('ada@example.test');
    expect(claims.displayName).toBe('Ada Lovelace');
    expect(claims.nonce).toBe(flow.nonce);
    const request = tenant.requests.at(-1);
    expect(request?.body?.grantType).toBe('authorization_code');
    expect(request?.body?.code).toBe('one-time-code');
    expect(request?.body?.redirectUri).toBe(REDIRECT_URI);
    // openid-client v6 defaults a confidential client to client_secret_post
    // (Configuration constructor) regardless of the server's advertised
    // methods — assert the credentials actually travel with the token request.
    expect(request?.body?.clientId).toBe(CLIENT_ID);
    expect(request?.body?.clientSecret).toBe(CLIENT_SECRET);
  });

  it('rejects an exchange whose verifier does not match the authorization challenge', async () => {
    const adapter = buildAdapter(tenant);
    const flow = await adapter.createLoginFlow(REDIRECT_URI);
    tenant.expectedChallenge = new URL(flow.authorizationUrl).searchParams.get('code_challenge');
    tenant.tokenPayload = baseClaims(flow.nonce);
    tenant.requests.length = 0;
    await expect(adapter.exchangeCode({
      code: 'code-2',
      codeVerifier: 'wrong-verifier-wrong-verifier-wrong-verifier-wrong',
      redirectUri: REDIRECT_URI,
      expectedNonce: flow.nonce,
    })).rejects.toThrow();
    expect(tenant.requests.at(-1)?.body?.codeVerifier).toBe('wrong-verifier-wrong-verifier-wrong-verifier-wrong');
  });

  it('rejects when the expected nonce does not match the returned ID token', async () => {
    const adapter = buildAdapter(tenant);
    const flow = await adapter.createLoginFlow(REDIRECT_URI);
    tenant.expectedChallenge = new URL(flow.authorizationUrl).searchParams.get('code_challenge');
    tenant.tokenPayload = baseClaims(flow.nonce);
    tenant.requests.length = 0;
    await expect(adapter.exchangeCode({
      code: 'code-3',
      codeVerifier: flow.codeVerifier,
      redirectUri: REDIRECT_URI,
      expectedNonce: 'not-the-flow-nonce',
    })).rejects.toThrow('unexpected JWT claim value encountered');
  });

  it('rejects an ID token signed by a key the tenant JWKS does not serve', async () => {
    const adapter = buildAdapter(tenant);
    const flow = await adapter.createLoginFlow(REDIRECT_URI);
    tenant.expectedChallenge = new URL(flow.authorizationUrl).searchParams.get('code_challenge');
    tenant.tokenPayload = baseClaims(flow.nonce);
    // Claims are valid (nonce matches) but the token is signed with a key the
    // JWKS does not serve — signature validation must reject regardless.
    tenant.respondWithForeignSignature = true;
    tenant.requests.length = 0;
    await expect(adapter.exchangeCode({
      code: 'code-4',
      codeVerifier: flow.codeVerifier,
      redirectUri: REDIRECT_URI,
      expectedNonce: flow.nonce,
    })).rejects.toThrow();
    tenant.respondWithForeignSignature = false;
  });

  it('rejects an ID token whose issuer is not the configured tenant authority', async () => {
    const adapter = buildAdapter(tenant);
    const flow = await adapter.createLoginFlow(REDIRECT_URI);
    tenant.expectedChallenge = new URL(flow.authorizationUrl).searchParams.get('code_challenge');
    tenant.tokenPayload = baseClaims(flow.nonce, { iss: 'https://evil.example/idp' });
    tenant.requests.length = 0;
    await expect(adapter.exchangeCode({
      code: 'code-5',
      codeVerifier: flow.codeVerifier,
      redirectUri: REDIRECT_URI,
      expectedNonce: flow.nonce,
    })).rejects.toThrow();
  });

  it('rejects an expired ID token', async () => {
    const adapter = buildAdapter(tenant);
    const flow = await adapter.createLoginFlow(REDIRECT_URI);
    tenant.expectedChallenge = new URL(flow.authorizationUrl).searchParams.get('code_challenge');
    tenant.tokenPayload = baseClaims(flow.nonce, { exp: Math.floor(Date.now() / 1000) - 3600 });
    tenant.requests.length = 0;
    await expect(adapter.exchangeCode({
      code: 'code-6',
      codeVerifier: flow.codeVerifier,
      redirectUri: REDIRECT_URI,
      expectedNonce: flow.nonce,
    })).rejects.toThrow();
  });
});
