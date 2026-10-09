# Tycoon City — instructions for autonomous coding agents

## Mission

Build **Tycoon City**, an original property-trading strategy game, phase by phase. Phase 1 delivers the complete rule set (`docs/PRODUCT.md`, `docs/RULES.md`, `docs/ROADMAP.md`), a pure deterministic TypeScript rules engine with zero runtime dependencies and full unit tests, and a minimal Rules Lab view in the existing app shell. Obvious is the autonomous coding factory; the engine's action API is the intent set a future multiplayer client may send.

## Source of truth

- `docs/RULES.md` — every number and transition. If code and the doc disagree, the doc wins and the code is fixed.
- `docs/PRODUCT.md` — product scope, branding principles, Phase 1 non-goals.
- `docs/ROADMAP.md` — phase sequencing. Do not pull future-phase work into current tasks.

## Hard safety boundaries

- Never add production credentials, API keys, telemetry, personal data, or real endpoint inventory.
- Never claim generated artifacts were tested without showing commands and results.
- Don't forge PR links, test counts, merged statuses, or agent autonomy.
- Before any Git commit or push, inspect the branch, remote, and status. Child PRs to the Phase 1 release branch are internal coordination; promoting the release to `main` and any publishing beyond the repo is gated on human approval.

## Local setup

`npm ci --no-audit --no-fund && npm run check && npm run dev`

## Engineering conventions

- TypeScript strict, small pure functions, no backend/cloud credentials.
- Deterministic I/O: the game engine contains no ambient clocks, no `Math.random`, no `Date.now` — all randomness flows from the seeded PRNG inside game state (see `docs/RULES.md`, Determinism Contract).
- Mobile responsive UI; no horizontal page overflow.
- Remain accessible (semantic headings, labels, keyboard controls, useful status text).
- Zero new runtime dependencies in Phase 1; avoid new dependencies unless justified.
- Colocated `*.test.ts` beside the code they cover — the pattern used by the existing `lib` code and the game engine modules.

## Phase 1 working agreements

- The engine is pure, isomorphic TypeScript: `applyAction` returns typed results and never throws; the same seed plus the ordered action log reproduces a byte-identical state hash.
- One concern per PR; conventional commits (`docs:`, `feat:`, `fix:`, `test:`, `chore:`); `npm run check` green before every push.
- Work targets the Phase 1 release branch via child PRs; `main` receives the integrated phase through the draft release PR.
- Keep change sets small; add meaningful automated tests for each behavior; run all existing checks.

## Repository history

This repo began as **ResolveOps AI**, a synthetic BitLocker incident-operations demo. That era's records remain in place for provenance — `docs/BUILD-PLAN.md`, `docs/EVIDENCE-LOG.md`, `docs/adr/`, and the read-only diagnostic toolkit under `scripts/` — and the incident-ops views remain in `apps/web` as the app shell. Tycoon City is now the active mission; the ResolveOps-era BitLocker boundaries no longer govern new work, while the general safety boundaries above carry forward.
