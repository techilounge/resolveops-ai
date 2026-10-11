import { describe, expect, it } from 'vitest';
import { StubIdp } from './oidc/stub-idp';

const REDIRECT = 'http://api.test/api/v1/auth/callback';
const ISSUER = 'https://stub-idp.resolveops.test';

function makeIdp(overrides: Partial<ConstructorParameters<typeof StubIdp>[0]> = {}): StubIdp {
  return new StubIdp({
    issuer: ISSUER,
    clientId: 'client-under-test',
    ...overrides,
  });
}

function codeFrom(callbackUrl: string): string {
  return new URL(callbackUrl).searchParams.get('code') as string;
}

describe('StubIdp login flows', () => {
  it('issues a unique state, nonce, and PKCE verifier per flow with S256 on the authorize URL', async () => {
    const idp = makeIdp();
    const first = await idp.createLoginFlow(REDIRECT);
    const second = await idp.createLoginFlow(REDIRECT);
    expect(first.state).not.toEqual(second.state);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(first.codeVerifier).not.toEqual(second.codeVerifier);
    expect(first.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(first.redirectUri).toBe(REDIRECT);
    const url = new URL(first.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('client-under-test');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBe(first.nonce);
    expect(url.searchParams.get('state')).toBe(first.state);
  });

  it('exchanges a code for claims bound to the authorization request (nonce echo, audience, profile)', async () => {
    const idp = makeIdp();
    const flow = await idp.createLoginFlow(REDIRECT);
    const callbackUrl = await idp.authorizeFromUrl(flow.authorizationUrl, {
      subject: 'user-1',
      email: 'user-1@example.com',
      displayName: 'User One',
    });
    // The callback URL carries the code and echoes the flow state.
    expect(new URL(callbackUrl).searchParams.get('state')).toBe(flow.state);
    const claims = await idp.exchangeCode({
      code: codeFrom(callbackUrl),
      codeVerifier: flow.codeVerifier,
      redirectUri: REDIRECT,
    });
    expect(claims.issuer).toBe(ISSUER);
    expect(claims.subject).toBe('user-1');
    expect(claims.email).toBe('user-1@example.com');
    expect(claims.displayName).toBe('User One');
    expect(claims.nonce).toBe(flow.nonce);
    expect(claims.audience).toBe('client-under-test');
    expect(claims.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('defaults the subject when authorizeFromUrl is called without authentication', async () => {
    const idp = makeIdp();
    const flow = await idp.createLoginFlow(REDIRECT);
    const callbackUrl = await idp.authorizeFromUrl(flow.authorizationUrl);
    const claims = await idp.exchangeCode({ code: codeFrom(callbackUrl), codeVerifier: flow.codeVerifier, redirectUri: REDIRECT });
    expect(claims.subject).toBe('stub-user');
    expect(claims.email).toBeNull();
  });

  it('rejects URLs that are not the authorization endpoint', async () => {
    const idp = makeIdp();
    await expect(idp.authorizeFromUrl(REDIRECT, { subject: 'user-1' })).rejects.toThrow(/expects the authorization endpoint/i);
  });

  it('rejects authorization requests missing required parameters', async () => {
    const idp = makeIdp();
    await expect(idp.authorizeFromUrl(`${ISSUER}/authorize?response_type=code`, { subject: 'user-1' })).rejects.toThrow(/missing required parameters/i);
  });

  it('rejects an unknown client_id at the authorization endpoint', async () => {
    const idp = makeIdp();
    const other = makeIdp({ clientId: 'other-client' });
    const foreignFlow = await other.createLoginFlow(REDIRECT);
    await expect(idp.authorizeFromUrl(foreignFlow.authorizationUrl, { subject: 'user-1' })).rejects.toThrow(/unknown client_id/i);
  });

  it('rejects an expired authorization code at exchange', async () => {
    const idp = makeIdp({ codeTtlMs: -1000 });
    const flow = await idp.createLoginFlow(REDIRECT);
    const callbackUrl = await idp.authorizeFromUrl(flow.authorizationUrl, { subject: 'user-1' });
    await expect(
      idp.exchangeCode({ code: codeFrom(callbackUrl), codeVerifier: flow.codeVerifier, redirectUri: REDIRECT }),
    ).rejects.toThrow(/expired/i);
  });

  it('rejects the wrong code_verifier at exchange (PKCE binding)', async () => {
    const idp = makeIdp();
    const flow = await idp.createLoginFlow(REDIRECT);
    const callbackUrl = await idp.authorizeFromUrl(flow.authorizationUrl, { subject: 'user-1' });
    await expect(
      idp.exchangeCode({ code: codeFrom(callbackUrl), codeVerifier: 'wrong-verifier-value', redirectUri: REDIRECT }),
    ).rejects.toThrow(/PKCE verification failed/i);
  });

  it('rejects a redirect_uri mismatch at exchange', async () => {
    const idp = makeIdp();
    const flow = await idp.createLoginFlow(REDIRECT);
    const callbackUrl = await idp.authorizeFromUrl(flow.authorizationUrl, { subject: 'user-1' });
    await expect(
      idp.exchangeCode({ code: codeFrom(callbackUrl), codeVerifier: flow.codeVerifier, redirectUri: 'http://evil.test/cb' }),
    ).rejects.toThrow(/redirect_uri mismatch/i);
  });

  it('rejects malformed and tampered codes (signature verification)', async () => {
    const idp = makeIdp();
    await expect(
      idp.exchangeCode({ code: 'garbage', codeVerifier: 'v', redirectUri: REDIRECT }),
    ).rejects.toThrow(/malformed/i);

    const flow = await idp.createLoginFlow(REDIRECT);
    const callbackUrl = await idp.authorizeFromUrl(flow.authorizationUrl, { subject: 'user-1' });
    const code = codeFrom(callbackUrl);
    const separatorIndex = code.lastIndexOf('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: 'attacker', nonce: 'n', challenge: 'c', redirectUri: REDIRECT, email: null, name: null, exp: 9999999999 }),
      'utf8',
    ).toString('base64url');
    await expect(
      idp.exchangeCode({ code: `${tamperedPayload}.${code.slice(separatorIndex + 1)}`, codeVerifier: flow.codeVerifier, redirectUri: REDIRECT }),
    ).rejects.toThrow(/signature verification failed/i);
  });
});
