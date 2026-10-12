import { buildApp } from './app';
import type { OidcAdapter } from '@resolveops/auth';

// Start entry — separate from the app factory so tests exercise the app via
// fastify.inject and nothing here runs under vitest or the vite build.
// Binds the loopback interface by default; staging/prod set HOST/PORT
// explicitly in the deploy environment.
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3000);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Identity-provider selection (Phase 1 Blueprint §4.2/§4.6):
 * - `stub` (default): the offline dev/test provider, zero network — CI and
 *   local dev never touch an external resource.
 * - `entra`: the real tenant via boot-time discovery. The tenant id, client
 *   id, and client secret arrive ONLY as environment/secret references
 *   (GitHub Environments `staging` in Part B) — never literals in this repo.
 */
async function createOidcAdapter(): Promise<OidcAdapter> {
  const { StubIdp, EntraIdp } = await import('@resolveops/auth');
  const provider = process.env.AUTH_PROVIDER ?? 'stub';
  switch (provider) {
    case 'stub':
      return new StubIdp({
        issuer: process.env.STUB_IDP_ISSUER ?? 'https://stub-idp.resolveops.test',
        clientId: process.env.STUB_IDP_CLIENT_ID ?? 'resolveops-api-dev',
      });
    case 'entra':
      return EntraIdp.discover({
        issuer: `https://login.microsoftonline.com/${requireEnv('ENTRA_TENANT_ID')}/v2.0`,
        clientId: requireEnv('ENTRA_CLIENT_ID'),
        clientSecret: requireEnv('ENTRA_CLIENT_SECRET'),
      });
    default:
      throw new Error(`Unsupported AUTH_PROVIDER: ${provider} (expected 'stub' or 'entra')`);
  }
}

export async function start(): Promise<void> {
  // Supabase connection split (Blueprint §4.6): DATABASE_URL is the direct
  // connection the migrator uses; APP_DATABASE_URL (transaction-pooler) is
  // the app runtime path — RLS context is SET LOCAL per transaction, so
  // transaction-mode pooling is safe by construction. Either alone works in
  // local dev; on managed Postgres both are set.
  const databaseUrl = process.env.APP_DATABASE_URL ?? requireEnv('DATABASE_URL');
  const [{ Pool }] = await Promise.all([import('pg')]);
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const adapter = await createOidcAdapter();
  const app = buildApp({
    auth: {
      pool,
      adapter,
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
