import { buildApp } from './app';

// Start entry — separate from the app factory so tests exercise the app via
// fastify.inject and nothing here runs under vitest or the vite build.
// Binds the loopback interface by default; Phase 0 has no deployment surface.
const HOST = '127.0.0.1';
const PORT = 3000;

export async function start(): Promise<void> {
  const app = buildApp();
  await app.listen({ port: PORT, host: HOST });
}

start().catch((error: unknown) => {
  console.error('[api] failed to start', error);
  throw error;
});
