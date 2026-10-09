# Tycoon City

An original city-based property-trading strategy game for 2–5 players: buy districts, transit depots, and utilities; develop from permits up to landmarks; collect rent; trade; and drive opponents into bankruptcy. The last solvent player is the **Tycoon**. All names, numbers, and art are our own — genre-standard mechanics, original expression, no third-party game assets.

> **Status: Phase 1 — Rules & Engine, in development** on `release/tycoon-city-phase-1-rules-plan-20261009-231020` (child PRs, one concern each). This docs PR is the first child; the engine and Rules Lab child PRs follow it onto the same release branch.

## Phase 1 deliverables

1. **The complete rule set, authored in-repo** — [`docs/PRODUCT.md`](docs/PRODUCT.md) (product brief, branding principles, non-goals), [`docs/RULES.md`](docs/RULES.md) (the normative v1.0 rules: 40-tile board, full economy tables, turn state machine, auctions, trading, development, mortgages, debt & bankruptcy, victory, determinism contract), and [`docs/ROADMAP.md`](docs/ROADMAP.md) (Phases 1–6).
2. **A pure, deterministic TypeScript rules engine** — zero runtime dependencies, fully unit-tested; the same seed plus the ordered action log reproduces a byte-identical state hash.
3. **A minimal Rules Lab view** in the existing app shell — a seeded AI-vs-AI simulation with live state and the event log; visible proof of determinism, not a playable board.

Board rendering and hot-seat play are Phase 2; server-authoritative multiplayer is Phase 3. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Start locally

```bash
npm ci --no-audit --no-fund && npm run check   # Vitest + strict typecheck + production build
npm run dev                                    # http://localhost:5173
```

The committed lockfile is the reproducibility pin; CI runs the same commands on Node 22 (`.github/workflows/ci.yml`).

## Verification status

- `npm run check` green on the Phase 1 release branch baseline: **77/77 Vitest** across **13 test files** (workspace suites: `apps/api`, `apps/web`, `packages/domain`, `packages/shared`), strict `tsc -b`, production build **165.53 kB JS / 6.73 kB CSS**.
- Phase 1 adds engine unit tests as its child PRs land — economy ladders, auctions, trading, development, debt & bankruptcy, determinism/replay, and a 10,000-game fuzz harness. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Repository layout

npm-workspaces monorepo:

- `apps/web` — React 18 + Vite app shell (incident-ops views remain; Phase 1 adds the Rules Lab view and the `src/game/` engine module set)
- `apps/api`, `apps/worker`, `packages/shared`, `packages/domain` — pre-existing workspaces (unchanged in Phase 1)
- `docs/` — Tycoon City product docs (PRODUCT, RULES, ROADMAP) alongside archived ResolveOps-era records (`BUILD-PLAN.md`, `EVIDENCE-LOG.md`, `adr/`)
- `scripts/` — ResolveOps-era read-only diagnostic toolkit (unchanged in Phase 1)
- `.github/workflows/ci.yml` — verify job (`npm ci --no-audit --no-fund` + `npm run check`, Node 22)

## History

This repo began as **ResolveOps AI**, a synthetic BitLocker incident-operations demo (delivered PRs #1–#3, production work PROD-001..006). Tycoon City is now the active mission and the repo keeps its name for continuity; ResolveOps-era docs stay in place for provenance.

## Safety boundaries

No production credentials, API keys, telemetry, or personal data — the game is entirely fictitious with original assets. [`AGENTS.md`](AGENTS.md) holds the binding boundaries for autonomous agents. Child PRs to the Phase 1 release branch are internal coordination; promoting the release to `main` is gated on human approval via the draft release PR.

## Branch protection

`main` is the integration branch: changes land only via squash-merged PRs; never force-push or rewrite history. Per-PR rollback procedures: [`docs/ROLLBACK.md`](docs/ROLLBACK.md).
