import { defineConfig } from 'vitest/config';

// Baseline tests are pure TypeScript and do not need the React Vite plugin.
// Include is widened over apps/* + packages/* (PROD-003 workspace layout) in
// the same commit as the file moves, so the suite cannot silently shrink.
// P1-5 adds component tests (Testing Library + jsdom), hence .test.tsx.
export default defineConfig({ test: { include: ['apps/**/*.test.ts', 'apps/**/*.test.tsx', 'packages/**/*.test.ts'] } });
