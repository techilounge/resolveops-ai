import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// P1-2 (Phase 1 Blueprint §4.5): typescript-eslint flat config across the
// npm-workspaces monorepo. Non-type-checked recommended rules keep the gate
// fast and free of project-service coupling; type-aware rules are a later
// tightening, not a Phase 1 gate.
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      // scripts/ is PowerShell + fixture data — nothing for ESLint to lint.
      'scripts/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // TypeScript's own checker covers undefined globals (window, process,
      // document); core no-undef cannot see TS types and false-positives on
      // them. Official typescript-eslint guidance: keep it off for TS files.
      'no-undef': 'off',
      // `_`-prefixed declarations are the repo's intentional-unuse convention:
      // compile-time type mirror checks (packages/shared DTOs) and
      // rest-destructure omissions in tests. They carry type information,
      // not dead code, so they stay exempt.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Deterministic fixture blobs (PROD-003 data layer): data, not logic.
    // Excluded so the protected fixture chain stays byte-identical.
    ignores: ['packages/domain/src/data/**', 'apps/web/src/data/**'],
  },
);
