# Tycoon City — Product Brief

Tycoon City is an original, city-based property-trading strategy game for 2–5 players. Players buy districts, transit depots, and utilities; develop districts from permits up to landmarks; collect rent; trade; and drive opponents into bankruptcy. The last solvent player is the **Tycoon** — the winner.

This document states what the product is and, just as deliberately, what it is not. The complete rule set lives in [`docs/RULES.md`](./RULES.md) — the source of truth for every number and transition. Sequencing across releases lives in [`docs/ROADMAP.md`](./ROADMAP.md).

## Identity & branding principles

- **Original expression.** All names (districts, plazas, depots), numbers, curves, and art are our own. The mechanics are genre-standard property trading; the expression is Tycoon City's. No third-party game assets.
- **Tycoon Dollars (TD).** The currency is integer TD everywhere; all computations are integer-exact.
- **No card decks in v1.0.** The board is fully deterministic without Chance/Chest-equivalent decks. If event cards are ever wanted for texture, that is a Phase 2 addition — the tile schema already types deck tiles.
- **Premium presentation.** The existing app shell's visual language is preserved; Phase 1 adds one view (the Rules Lab) and touches the navigation minimally. No new palette, no new dependencies.

## Product pillars

1. **Deterministic to the byte.** One seeded PRNG lives inside game state; every dice roll and shuffle draws from it. The same seed plus the same ordered action log reproduces a byte-identical state hash on any machine. No `Math.random`, no `Date.now`, no ambient clocks inside the engine.
2. **Engine first.** Phase 1 ships a pure, zero-dependency TypeScript rules engine — the full turn state machine, property economics, auctions, trading, development, mortgages, bankruptcy, and victory. Its action API is exactly the intent set a future network client may send: server authority in Phase 3 means "the server runs `applyAction`; clients only send intents."
3. **Proof over promises.** The Phase 1 UI is a minimal Rules Lab that runs a seeded AI-vs-AI simulation and shows live state plus the event log — visible proof of determinism (same seed → same winner) and a manual QA surface, not a playable board.

## Phase 1 — what we are building now

Three deliverables, nothing more:

1. **The complete rule set, authored in-repo** — `docs/PRODUCT.md`, `docs/RULES.md`, `docs/ROADMAP.md`, plus a mission refresh of `AGENTS.md` / `README.md`.
2. **A pure, deterministic TypeScript rules engine** — the `src/game/` module set in the app workspace: types, seeded PRNG, board data, state machine, economy, auctions, trading, development, bankruptcy, engine facade — each with colocated tests.
3. **A minimal "Rules Lab" view** inside the existing shell — seed input, player count, speed; a scripted, budget-aware bot policy plays a full seeded game headless; the lab displays live state and the scrolling event log.

Board rendering, tokens, and animations are Phase 2. Server-authoritative multiplayer is architected now but built in Phase 3.

## Non-goals (Phase 1)

Not in Phase 1: WebSocket server / rooms / lobbies; board rendering & tokens; hot-seat or human play; accounts & persistence; brand art production (logo, board art); deployment infrastructure; card decks; trading-with-bank nuance (bank auctions on bankruptcy). These are sequenced in [`docs/ROADMAP.md`](./ROADMAP.md).

No paid services are introduced; CI runs on the GitHub Actions free tier.
