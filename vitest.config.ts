import { defineConfig } from 'vitest/config';

// Baseline tests are pure TypeScript and do not need the React Vite plugin.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
