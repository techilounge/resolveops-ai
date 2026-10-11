# Tycoon City — Complete Rules (v1.0)

> **Normative.** This document is the source of truth for every number and transition in the game. It reproduces §3 of the approved Phase 1 specification (*Tycoon City — Phase 1 Spec: Rules & Engine*, 2026-10-09) verbatim, with its §3.1–§3.9 sections renumbered 1–9. If code and this document disagree, this document wins and the code is fixed.

**Status:** v1.0 · Approved 2026-10-09 · Normative for Phase 1

Original branding throughout: **Tycoon City**, currency **Tycoon Dollars (TD)**, original district names, no card decks, no third-party game assets. Mechanics are genre-standard; expression (names, numbers, curves, art) is our own.

## 1. Players & Setup

- 2–5 players, each starts with **12,000 TD**. Turn order comes from the seeded PRNG at game start.
- Currency is integer TD everywhere; all computations are integer-exact.

## 2. Board — 40 tiles

| # | Tile | Type | Price (TD) |
|---|---|---|---|
| 0 | City Hall Plaza | start (salary) | — |
| 1 | Midtown Docks I | district G1 | 900 |
| 2 | Midtown Docks II | district G1 | 1,100 |
| 3 | Harbor Plaza | rest | — |
| 4 | Lantern Quarter I | district G2 | 1,400 |
| 5 | North Depot | transit | 1,600 |
| 6 | Lantern Quarter II | district G2 | 1,600 |
| 7 | Lantern Quarter III | district G2 | 1,800 |
| 8 | Exchange Plaza | rest | — |
| 9 | Printers Row I | district G3 | 2,000 |
| 10 | Printers Row II | district G3 | 2,000 |
| 11 | Power Grid | utility | 1,400 |
| 12 | Printers Row III | district G3 | 2,200 |
| 13 | Revenue Office | tax (1,200) | — |
| 14 | East Depot | transit | 1,600 |
| 15 | Garden Terraces I | district G4 | 2,400 |
| 16 | Garden Terraces II | district G4 | 2,400 |
| 17 | Meadow Plaza | rest | — |
| 18 | Garden Terraces III | district G4 | 2,600 |
| 19 | Grand Plaza | safe (no effect) | — |
| 20 | Transit Junction I | district G5 | 2,800 |
| 21 | Transit Junction II | district G5 | 2,800 |
| 22 | Luxury Levy | tax (900) | — |
| 23 | Transit Junction III | district G5 | 3,000 |
| 24 | South Depot | transit | 1,600 |
| 25 | Civic Hill I | district G6 | 3,200 |
| 26 | Civic Hill II | district G6 | 3,200 |
| 27 | Summit Plaza | rest | — |
| 28 | Civic Hill III | district G6 | 3,400 |
| 29 | Waterworks | utility | 1,400 |
| 30 | Skyline Core I | district G7 | 3,800 |
| 31 | Skyline Core II | district G7 | 3,800 |
| 32 | Terrace Plaza | rest | — |
| 33 | Skyline Core III | district G7 | 4,200 |
| 34 | West Depot | transit | 1,600 |
| 35 | Audit Office | go-to-Depot | — |
| 36 | Aurora Waterfront I | district G8 | 4,800 |
| 37 | Riverview Plaza | rest | — |
| 38 | Aurora Waterfront II | district G8 | 5,200 |
| 39 | The Depot | jail | — |

## 3. Movement & the Turn

- Roll 2d6 from the game's seeded PRNG. Move forward; **passing or landing on City Hall Plaza collects 1,600 TD**.
- **Doubles:** roll again immediately (doubles do not re-trigger salary beyond the landing rule). A **third consecutive doubles** sends the player to The Depot (audit), turn ends.
- **The Depot (jail):** a held player at turn start chooses: pay **500 TD**, or roll for doubles (counts as the turn's roll; on failure with no doubles they stay, and after the **3rd failed attempt** they must pay 500 and move by that roll). Held players collect rent normally.
- **Audit Office:** move directly to The Depot (held, not just visiting). Audit fine **500 TD** applies only via cards/legacy rules — v1.0 has no cards, so landing there is a clean transfer.

## 4. Property Economics

**District rent ladder** — base rent × multiplier by development level (levels 1–4 = permits, level 5 = landmark):

| Group | Base rents (TD) | ×L1 | ×L2 | ×L3 | ×L4 | ×Landmark | Permit cost |
|---|---|---|---|---|---|---|---|
| G1 Midtown Docks | 40 / 50 | 8 | 22 | 50 | 75 | 95 | 400 |
| G2 Lantern Quarter | 70 / 80 / 90 | 7 | 18 | 40 | 60 | 80 | 600 |
| G3 Printers Row | 120 / 120 / 140 | 6 | 15 | 32 | 50 | 68 | 800 |
| G4 Garden Terraces | 180 / 180 / 200 | 5 | 13 | 27 | 42 | 58 | 1,000 |
| G5 Transit Junction | 250 / 250 / 280 | 5 | 12 | 24 | 37 | 50 | 1,200 |
| G6 Civic Hill | 350 / 350 / 380 | 4 | 10 | 20 | 31 | 42 | 1,500 |
| G7 Skyline Core | 500 / 500 / 560 | 4 | 9 | 17 | 26 | 35 | 1,800 |
| G8 Aurora Waterfront | 800 / 850 | 3 | 8 | 15 | 23 | 30 | 2,200 |

- **Full color set, unbuilt:** base rent × 2.
- **Scarcity pool:** bank holds **40 permit units** and **8 landmark units**. Levels 1–4 each consume 1 permit unit; building a landmark consumes 1 landmark unit and returns the property's 4 permit units to the bank. Selling a level refunds **50%** of one permit cost and returns the unit to the bank.
- **Even-build rule:** levels within a color group may differ by at most 1; a group may only be developed when the owner holds **all** its districts and **none** in the group is mortgaged.
- **Mortgage:** receive **50%** of price; lifting costs principal **+10% fee** (rounded up to 10 TD). A mortgaged property collects **0 rent**. Selling levels/mortgages is the liquidation toolkit under debt.
- **Transit depots (4):** rent by count owned: **400 / 900 / 1,800 / 3,000**.
- **Utilities (2):** rent = dice sum × **40** (one owned) or × **100** (both owned).
- **Taxes:** Revenue Office **1,200**; Luxury Levy **900** — paid to the bank.

## 5. Unowned Property & Auctions

- Landing on an unowned district/transit/utility: active player may **buy at list price** or **decline**.
- On decline, an **open ascending auction** starts: all solvent players (including the decliner) may bid; minimum opening bid 100 TD; minimum increment 100 TD; a pass is permanent for that auction; the last remaining bidder wins at their last bid; **zero bids → the property stays with the bank**. The bank never bids. Auctions interrupt any other board action and resolve fully before play resumes.

## 6. Trading

- Trades are only proposed/accepted during the **active player's** `awaitingRoll` or `postRoll` windows (deterministic; no mid-everyone trading in v1.0).
- An offer exchanges **cash and/or properties** between two players; properties transfer in any mortgage state (the mortgage stays attached; the new owner later pays the lift fee as normal).
- Lifecycle: `proposed → countered (new proposal) → accepted | declined | expired`. A pending trade **expires when the offering turn ends**. Accepted trades execute **atomically** — both legs or neither; server validates ownership and cash before applying.

## 7. Debt & Bankruptcy

- When a payment due (rent, tax, fine, purchase shortfall) exceeds cash, the payer enters the **`debt`** state naming the creditor (bank or player). In `debt` the only legal actions are liquidation: sell levels (50%), mortgage (50%), then `declareBankruptcy`.
- **To a player-creditor:** all cash, properties (mortgages attached), and development levels transfer as-is.
- **To the bank:** properties return to the bank **unowned and undeveloped** (levels sold to the bank at 50% during liquidation). *(Simplification vs. classic bank-auction flow — flagged as a v1.0 simplification; revisitable later.)*
- A bankrupt player is eliminated; their turn ends and play continues to the next solvent player.

## 8. Victory

- **Elimination:** the game ends when one solvent player remains — the **Tycoon** (winner).
- Edge case — simultaneous mutual bankruptcy: winner is the survivor with the highest net worth (cash + property price + 50% × development investment), tie-broken by lowest player index. Fully deterministic.

## 9. Determinism Contract

- One **seeded PRNG** (xoshiro128\*\* family) whose state lives **inside `GameState`**; every dice roll and shuffle draws from it. No `Math.random`, no `Date.now`, no ambient clocks inside the engine.
- **Replay:** `createGame(seed, players)` + the ordered action log **must reproduce a byte-identical state hash** on any machine.
- Canonical JSON (sorted keys) + 64-bit FNV-1a → `stateHash(state)`.
