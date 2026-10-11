# Tycoon City — Roadmap

Sequencing principle: **engine before visuals, determinism before network.** Phase 1 is committed and specified; later phases are directional and get their own specs when they start.

## Phase 1 — Rules & Engine (in flight)

Ships three deliverables: the in-repo rule set (this `docs/` set), a pure deterministic TypeScript rules engine, and a minimal Rules Lab view. Full scope and acceptance criteria live in the approved Phase 1 specification (2026-10-09).

Release strategy — child PRs, one concern each, targeting the Phase 1 release branch (`release/tycoon-city-phase-1-rules-plan-20261009-231020`), collected by a draft release PR that promotes the integrated phase to `main`:

1. **docs** ∥ **engine core** (types, seeded PRNG, board data, turn state machine)
2. **economy** ∥ **auctions + trading**
3. **development + bankruptcy** (after economy — liquidation reuses economy helpers, incl. `netWorth`)
4. **fuzz harness** — 10,000 random legal-action games across seeds; no throw, TD conserved, log append-only, hash stable
5. **Rules Lab** (after fuzz — shares the bot policy)
6. **human acceptance review**

Every PR is green in CI before merge; the UI task ships screenshot evidence; conventional commits throughout.

## Phase 2 — Board & hot-seat play

*Directional.* Board rendering, tokens, and animations in the existing shell; hot-seat local play for humans. Candidate: event-card decks for texture — the tile schema already types deck tiles, and Phase 1 ships cardless by design.

## Phase 3 — Server-authoritative multiplayer

*Directional.* WebSocket server, rooms, lobbies. The server runs `applyAction` and owns game state; clients only send intents — the Phase 1 engine's action API is the client intent set by design.

## Phase 4 — Polish

*Directional.* Balance passes on the tunable constants (every economic number is data in the board module — pacing changes do not touch the state machine or the tests' structure), UX refinement, accessibility audits.

## Phase 5 — Accounts & persistence

*Directional.* Player accounts, saved games, persisted match history.

## Phase 6 — Launch

*Directional.* Brand art production (logo, board art), deployment infrastructure, launch.

## Explicitly parked variants

- **Wealth-target victory** — Phase 1 ships elimination victory (last solvent player wins); the variant is deferred.
- **Bank auctions on bankruptcy** — v1.0 sends bankrupted properties to the bank unowned and undeveloped; the classic bank-auction flow is a flagged simplification, revisitable later.
- **Card decks** — see Phase 2.
