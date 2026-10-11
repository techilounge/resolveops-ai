import { buildApp } from './app';

// Start entry — separate from the app factory so tests exercise the app via
// fastify.inject and nothing here runs under vitest or the vite build.
// Binds the loopback interface by default.
const HOST = '127.0.0.1';
const PORT = 3000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function start(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  // Part A (Phase 1 Blueprint §4.2): the stub IdP, zero network. Part B swaps
  // in EntraIdp behind the same OidcAdapter interface once the real tenant
  // exists — no other wiring changes.
  const [{ StubIdp }, { Pool }] = await Promise.all([
    import('@resolveops/auth'),
    import('pg'),
  ]);
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const app = buildApp({
    auth: {
      pool,
      adapter: new StubIdp({
        issuer: process.env.STUB_IDP_ISSUER ?? 'https://stub-idp.resolveops.test',
        clientId: process.env.STUB_IDP_CLIENT_ID ?? 'resolveops-api-dev',
      }),
      // Dev-only bootstrap secrets for Part A; Part B provisions real secrets
      // via the secrets manager (never in env files committed to the repo).
      cookieSecret: requireEnv('COOKIE_SECRET'),
      csrfSecret: process.env.CSRF_SECRET ?? requireEnv('COOKIE_SECRET'),
      allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:3000')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
      cookieSecure: process.env.COOKIE_SECURE !== 'false',
      // Required: the OIDC redirect_uri is always absolute, and a silent
      // localhost default would break real logins at deploy time.
      publicBaseUrl: requireEnv('PUBLIC_BASE_URL'),
    },
  });
  await app.listen({ port: PORT, host: HOST });
}

start().catch((error: unknown) => {
  console.error('[api] failed to start', error);
  throw error;
});
