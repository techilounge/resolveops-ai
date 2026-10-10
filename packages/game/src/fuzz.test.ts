// Fuzz + invariant harness (AC10, spec §3.9): 10,000 random legal-action
// games across deterministically-partitioned seeds.
//
// The driver enumerates every legal action the engine offers in a position —
// the active player's window, every auction participant, a pending trade's
// offeree — fills the skeleton intents with deterministic pseudo-random
// parameters drawn from a dedicated driver PRNG, and applies one per step.
// Rejections are expected and healthy (the driver re-picks); the invariants
// below are checked on every successful transition and at every game end:
//
// 1. No unhandled exceptions — applyAction never throws, and no rejection is
//    ever INTERNAL (a handler crash) or NOT_IMPLEMENTED (an un-built seam).
// 2. Tycoon Dollar conservation — the bank's delta over each action (derived
//    from the action's own log events and state deltas) must exactly equal
//    the negative of the summed player cash delta.
// 3. The log stays strictly append-only — a rolling fingerprint folded over
//    events as they are appended must match a from-scratch recompute over the
//    final log (any mutation, reorder, or deletion of an older event breaks
//    it), with per-step seq contiguity as a belt-and-braces check.
// 4. stateHash is stable under a JSON round-trip at every game end.
// 5. Every game reaches `finished` within a bounded action count, with a
//    non-null winner.
//
// Determinism is total: seeds partition the space (`fuzz-p<count>-<index>`),
// the driver PRNG is seeded per game, and no Math.random / Date.now appears
// anywhere — a failing seed replays exactly.

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, getLegalActions } from './state-machine';
import { canonicalJson, fnv1a64, stateHash } from './engine';
import { drawBelow, initialRngState } from './rng';
import { BOARD_SIZE, DISTRICT_GROUPS, getTile, isBuyableKind, rentDue } from './board';
import { mortgageLiftCost, mortgageValue } from './economy';
import { buildCandidate, isAcceptableTrade, pickAction, tradeLegValue } from './bot';
import type {
  GameAction,
  GameError,
  GameErrorCode,
  GameEvent,
  GameState,
  PlayerId,
  TileId,
  TradeLeg,
} from './types';
import { playerId, tileId } from './types';

/**
 * Games per player-count partition — 4 partitions (spec §3.1: 2–5 players).
 * The in-repo default is a CI-sized smoke; `npm run test:fuzz` runs the full
 * AC10 scale of 2,500 per partition (10,000 games) — see the runtime note in
 * the PR: the engine's clone-per-action cost makes a 60s 10k run impossible
 * on one thread, so the full scale is a named script, not the default suite.
 */
const GAMES_PER_COUNT = Number(process.env.FUZZ_GAMES ?? 15);
/** Player counts exercised across the partitions (spec §3.1: 2–5 players). */
const PLAYER_COUNTS = [2, 3, 4, 5] as const;
/** Hard ceiling on actions per game — a game that hits it fails the suite. */
const MAX_STEPS = 5_000;
/** Rejected (typed-error) attempts per step before the driver forces progress. */
const MAX_CONSECUTIVE_REJECTIONS = 32;
/** Bot-policy games per player count (small: bot games drive the same checks). */
const BOT_GAMES_PER_COUNT = Number(process.env.BOT_GAMES ?? 2);
/** Per-test budget — scaled with the requested run size. */
const PARTITION_TIMEOUT_MS = Number(process.env.FUZZ_TIMEOUT_MS ?? 300_000);

/**
 * Chunked full-scale execution. A full 10,000-game run is one ~90-minute
 * process — impossible where shell commands are capped at 5 minutes — so the
 * run is expressed as a sequence of self-contained vitest invocations, each
 * playing one deterministic slice of one partition's seed list. Chunks
 * replay the exact games the unchunked run would: seed `fuzz-p<count>-<n>`
 * fully determines its game, so summing slices equals running the list.
 * Env unset → the ordinary smoke/full suite, byte-identical behavior.
 */
const CHUNK_PARTITION = Number(process.env.FUZZ_ONLY_PARTITION ?? 0);
const SEED_START = Number(process.env.FUZZ_SEED_START ?? 0);
const CHUNK_GAMES = Number(process.env.FUZZ_SEED_COUNT ?? 0);
const SEAT_NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli'] as const;
const ALL_TILES: readonly TileId[] = Array.from({ length: BOARD_SIZE }, (_, i) => tileId(i));
const VALID_ERROR_CODES = new Set<GameErrorCode>([
  'WRONG_PHASE', 'WRONG_PLAYER', 'GAME_NOT_ACTIVE', 'INSUFFICIENT_FUNDS', 'NOT_HELD',
  'NO_PENDING_TRADE', 'INVALID_BID', 'ALREADY_PASSED', 'INVALID_TILE', 'INTERNAL', 'NOT_IMPLEMENTED',
]);

// ---------------------------------------------------------------------------
// Driver randomness — the engine's own xoshiro128** under a dedicated seed
// domain, so driver draws never disturb the game's internal generator.
// ---------------------------------------------------------------------------

interface DriverRng {
  state: string;
}

function driverRng(seed: string): DriverRng {
  return { state: initialRngState(`${seed}|driver`) };
}

/** Draw uniformly from [0, n) — callers guarantee n ≥ 1. */
function draw(rng: DriverRng, n: number): number {
  const r = drawBelow(rng.state, n);
  rng.state = r.state;
  return r.value;
}

// ---------------------------------------------------------------------------
// Candidate enumeration and skeleton fills.
// ---------------------------------------------------------------------------

/** Every (seat, skeleton) pair the engine would accept a move from right now. */
function candidates(state: GameState): { pid: PlayerId; skeleton: GameAction }[] {
  const out: { pid: PlayerId; skeleton: GameAction }[] = [];
  for (const p of state.players) {
    if (p.bankrupt) continue;
    for (const skeleton of getLegalActions(state, p.id)) {
      // Harness-side mirror of the engine's own offer-liveness rule
      // (trading.ts `offerLives`): an offer expires when the offering turn
      // ends, but getLegalActions keeps handing the offeree response
      // skeletons for a dead offer (PR #14 known seam), and every response
      // then rejects with NO_PENDING_TRADE — thousands of wasted applies
      // per game. Only respond while the offeror is still the active
      // player; proposal and execution semantics stay the engine's.
      if (
        (skeleton.type === 'ACCEPT_TRADE' || skeleton.type === 'DECLINE_TRADE') &&
        (state.pendingTrade === null || state.pendingTrade.from !== state.turn.activePlayer)
      ) {
        continue;
      }
      // Tile-targeted skeletons are filtered to tiles the engine will
      // actually accept (same rules as development.ts). A rejected apply
      // costs a full engine clone per retry, so wild fills that mostly
      // exercise rejection paths quadruple the run time for coverage the
      // typed-rejection sweep below already provides deterministically.
      if (skeleton.type === 'BUILD_LEVEL' && buildCandidate(state, p.id) === null) continue;
      if (skeleton.type === 'SELL_LEVEL' && ownedDistricts(state, p.id, true).length === 0) continue;
      if (skeleton.type === 'MORTGAGE' && ownedBuyable(state, p.id).some(t => state.ownership[t]?.mortgaged === false) === false) continue;
      if (skeleton.type === 'LIFT_MORTGAGE' && ownedBuyable(state, p.id).some(t => state.ownership[t]?.mortgaged === true) === false) continue;
      out.push({ pid: p.id, skeleton });
    }
  }
  // Dead-offer shadowing (PR #14 seam): when the active player is the
  // offeree of a stale offer, getLegalActions offers ONLY the dead
  // ACCEPT/DECLINE pair and the filtered set above comes up empty — even
  // though the router still accepts the player's normal turn actions. Fall
  // back to the always-legal progress action so the game can continue.
  if (out.length === 0) out.push({ pid: state.turn.activePlayer, skeleton: forcedProgress(state) });
  return out;
}

/** Tiles of a buyable kind `holder` owns, in board order. */
function ownedBuyable(state: GameState, holder: PlayerId): TileId[] {
  const out: TileId[] = [];
  for (const key of Object.keys(state.ownership)) {
    const tile = tileId(Number(key));
    const deed = state.ownership[tile];
    if (deed && deed.owner === holder && isBuyableKind(getTile(tile).kind)) out.push(tile);
  }
  return out;
}

/** Owned districts of `holder` — optionally only those with a level to sell. */
function ownedDistricts(state: GameState, holder: PlayerId, builtOnly: boolean): TileId[] {
  const out: TileId[] = [];
  for (const key of Object.keys(state.ownership)) {
    const tile = tileId(Number(key));
    const deed = state.ownership[tile];
    if (deed && deed.owner === holder && getTile(tile).kind === 'district') {
      if (!builtOnly || deed.level > 0) out.push(tile);
    }
  }
  return out;
}

/** A random trade leg: 0–2 distinct owned tiles plus up to the holder's cash, in 100s. */
function randomLeg(state: GameState, holder: PlayerId, rng: DriverRng): TradeLeg {
  const pool = ownedBuyable(state, holder);
  const tiles: TileId[] = [];
  const count = Math.min(draw(rng, 3), pool.length);
  const bag = [...pool];
  for (let i = 0; i < count; i++) {
    const idx = draw(rng, bag.length);
    tiles.push(bag[idx]);
    bag.splice(idx, 1);
  }
  return { cash: 100 * draw(rng, Math.floor(state.players[holder].cash / 100) + 1), tiles };
}

/**
 * Complete a skeleton intent with deterministic random parameters. Fills lean
 * toward validity (owned tiles, affordable cash) so successes dominate, while
 * occasionally-wild fills keep the rejection paths exercised too.
 */
function fillAction(state: GameState, pid: PlayerId, skeleton: GameAction, rng: DriverRng): GameAction {
  switch (skeleton.type) {
    case 'PROPOSE_TRADE': {
      const others = state.players.filter(p => !p.bankrupt && p.id !== pid);
      if (others.length === 0) return skeleton; // no counterparty — the engine rejects the skeleton
      const to = others[draw(rng, others.length)].id;
      // Half the proposals are whole-portfolio buyouts at list price (the
      // acceptance predicate is value-neutral): the concentration move that
      // breaks the land-rich/cash-poor stalemate and lets games finish.
      const portfolio = ownedBuyable(state, to);
      const ask = portfolio.length === 0 ? 0 : tradeLegValue(state, { cash: 0, tiles: portfolio });
      if (ask > 0 && ask <= state.players[pid].cash && draw(rng, 10) < 5) {
        return { type: 'PROPOSE_TRADE', player: pid, to, give: { cash: ask, tiles: [] }, want: { cash: 0, tiles: portfolio } };
      }
      return { type: 'PROPOSE_TRADE', player: pid, to, give: randomLeg(state, pid, rng), want: randomLeg(state, to, rng) };
    }
    case 'BUILD_LEVEL': {
      // candidates() only offers the skeleton when a legal build exists.
      const legal = buildCandidate(state, pid);
      if (legal !== null) return { type: 'BUILD_LEVEL', player: pid, tile: legal };
      const pool = ownedDistricts(state, pid, false);
      return { type: 'BUILD_LEVEL', player: pid, tile: pool.length > 0 ? pool[draw(rng, pool.length)] : ALL_TILES[draw(rng, BOARD_SIZE)] };
    }
    case 'SELL_LEVEL': {
      const pool = ownedDistricts(state, pid, true);
      return { type: 'SELL_LEVEL', player: pid, tile: pool.length > 0 ? pool[draw(rng, pool.length)] : ALL_TILES[draw(rng, BOARD_SIZE)] };
    }
    case 'MORTGAGE': {
      const pool = ownedBuyable(state, pid).filter(t => state.ownership[t]?.mortgaged === false);
      return { type: 'MORTGAGE', player: pid, tile: pool.length > 0 ? pool[draw(rng, pool.length)] : ALL_TILES[draw(rng, BOARD_SIZE)] };
    }
    case 'LIFT_MORTGAGE': {
      const pool = ownedBuyable(state, pid).filter(t => state.ownership[t]?.mortgaged === true);
      const affordable = pool.filter(t => state.players[pid].cash >= mortgageLiftCost(t));
      if (affordable.length > 0) return { type: 'LIFT_MORTGAGE', player: pid, tile: affordable[draw(rng, affordable.length)] };
      return { type: 'LIFT_MORTGAGE', player: pid, tile: pool.length > 0 ? pool[draw(rng, pool.length)] : ALL_TILES[draw(rng, BOARD_SIZE)] };
    }
    case 'AUCTION_BID': {
      // Above-minimum overbids exercise the increment rule; capped at cash
      // so bids land instead of burning attempts on INSUFFICIENT_FUNDS.
      const cash = state.players[pid].cash;
      if (skeleton.amount > cash) return skeleton;
      return { ...skeleton, amount: Math.min(skeleton.amount + 100 * draw(rng, 3), cash) };
    }
    default:
      return skeleton;
  }
}

/**
 * The action that always makes progress from any turn state — used only when
 * random fills have been rejected too many times in one step. Each branch is
 * legal-by-construction in its state (per the transition table).
 */
function forcedProgress(state: GameState): GameAction {
  const pid = state.turn.activePlayer;
  switch (state.turn.state) {
    case 'turnStart':
    case 'awaitingRoll':
      return { type: 'ROLL_DICE', player: pid };
    case 'awaitingBuy':
      return { type: 'DECLINE_BUY', player: pid };
    case 'auction': {
      const open = state.auction;
      if (open === null) throw new Error('fuzz: auction state without an open auction');
      const participant = state.players.find(p => !p.bankrupt && !open.passed.includes(p.id));
      if (participant === undefined) throw new Error('fuzz: auction state with no participant left to pass');
      return { type: 'AUCTION_PASS', player: participant.id };
    }
    case 'postRoll':
      return { type: 'END_TURN', player: pid };
    case 'debt':
      return { type: 'DECLARE_BANKRUPTCY', player: pid };
    default:
      throw new Error(`fuzz: no forced progress from turn state ${state.turn.state}`);
  }
}

/** Probability the driver buys when a buy offer is on the table. */
const BUY_BIAS = 0.8;
/** Probability a debtor declares bankruptcy instead of liquidating this step. */
const BANKRUPTCY_BIAS = 0.25;
/** Cash above which the driver treats mortgage lifts as near-free moves. */
const LIFT_WHEN_CASH_ABOVE = 8000;

/**
 * Termination-biased candidate pick. Uniform play on an open board rarely
 * concentrates ownership, so rents stay small, debts never arise, and games
 * would not finish (AC10 requires `finished` within a bounded action count).
 * Two biases fix termination without leaving the legal-action space: buying
 * is strongly preferred when an offer is on the table (ownership
 * concentrates, districts develop, rents grow), and a debtor has a fixed
 * chance of declaring bankruptcy each step (debt episodes end; liquidation
 * keeps the majority of steps, and an exhausted ladder still ends in
 * DECLARE_BANKRUPTCY — its only remaining legal action).
 */
function biasedPick(state: GameState, options: { pid: PlayerId; skeleton: GameAction }[], rng: DriverRng): number {
  // A value-neutral-or-better offer on the table: the offeree almost always
  // responds (leaving it pending stalls the window until the turn ends).
  const accept = options.findIndex(o => o.skeleton.type === 'ACCEPT_TRADE');
  if (
    accept >= 0 && state.pendingTrade !== null && isAcceptableTrade(state, state.pendingTrade) &&
    draw(rng, 100) < 90
  ) {
    return accept;
  }
  const buy = options.findIndex(o => o.skeleton.type === 'BUY_PROPERTY');
  if (buy >= 0 && draw(rng, 100) < BUY_BIAS * 100) return buy;
  // Builds outrank lifts: development is what grows rents and ends games,
  // and a lift that pushes cash under the build reserve would freeze the
  // portfolio at base rents forever (observed as 5,000-action stalls).
  const build = options.findIndex(o => o.skeleton.type === 'BUILD_LEVEL');
  if (build >= 0 && buildCandidate(state, state.turn.activePlayer) !== null && draw(rng, 100) < 70) {
    return build;
  }
  // Then lifts: mortgaged groups collect no rent and block development
  // (spec §3.4), so pledged portfolios also freeze the economy — but only
  // from a cash cushion that keeps the build reserve intact.
  const lift = options.find(o => o.skeleton.type === 'LIFT_MORTGAGE');
  if (lift !== undefined && state.players[state.turn.activePlayer].cash >= LIFT_WHEN_CASH_ABOVE && draw(rng, 100) < 70) {
    return options.indexOf(lift);
  }
  const quit = options.findIndex(o => o.skeleton.type === 'DECLARE_BANKRUPTCY');
  if (quit >= 0 && draw(rng, 100) < BANKRUPTCY_BIAS * 100) return quit;
  return draw(rng, options.length);
}

// ---------------------------------------------------------------------------
// Invariant checks.
// ---------------------------------------------------------------------------

/** Rolling fingerprint of the log: folds each event as it is observed. */
function foldFingerprint(fp: string, events: readonly GameEvent[]): string {
  let out = fp;
  for (const e of events) out = fnv1a64(out + canonicalJson(e));
  return out;
}

const GENESIS_FINGERPRINT = '0'.repeat(16);

/** Bank and per-player cash flows visible in the event log itself. */
function eventFlows(suffix: readonly GameEvent[]): { bank: number; byPlayer: Map<PlayerId, number> } {
  let bank = 0;
  const byPlayer = new Map<PlayerId, number>();
  const record = (pid: PlayerId, amount: number): void => {
    byPlayer.set(pid, (byPlayer.get(pid) ?? 0) + amount);
  };
  for (const e of suffix) {
    switch (e.type) {
      case 'SALARY_COLLECTED':
        bank -= e.amount;
        record(e.player, e.amount);
        break;
      case 'TAX_COLLECTED':
        bank += e.amount;
        record(e.player, -e.amount);
        break;
      case 'JAIL_FINE_PAID':
        bank += e.amount;
        record(e.player, -e.amount);
        break;
      default:
        break;
    }
  }
  return { bank, byPlayer };
}

/**
 * Cash the bank receives when `pid`'s liquidation action settles a to-bank
 * debt inside the same step (development.ts settleDebtIfCovered): the
 * mortgage/sell proceeds flow in and the debt payment flows straight back
 * out. Player creditors net out inside the player sum; only the bank leg
 * needs modelling.
 */
function bankDebtSettlement(prev: GameState, next: GameState, pid: PlayerId): number {
  const debt = prev.debt;
  if (debt === null || next.debt !== null || debt.debtor !== pid) return 0;
  return debt.creditor === 'bank' ? debt.amount : 0;
}

/**
 * The bank flow a successful action's state delta implies, per action type:
 * purchases and auction settlements pay the list/bid price to the bank,
 * builds pay the permit cost (landmarks are free), sells refund half a
 * permit, mortgages draw 50% of list, lifts repay principal + 10% fee, and a
 * to-bank bankruptcy leaves the estate's cash with the bank.
 */
function structuralBankFlow(prev: GameState, next: GameState, action: GameAction): number {
  switch (action.type) {
    case 'BUY_PROPERTY': {
      const tile = prev.players[prev.turn.activePlayer].position;
      return getTile(tile).price ?? 0;
    }
    case 'AUCTION_BID':
    case 'AUCTION_PASS': {
      const open = prev.auction;
      if (open === null || next.auction !== null) return 0; // still open — bids are commitments, not payments
      // The winner pays at settlement (auction.ts: bid() replaces highBid,
      // then settleIfOver charges it): a settling BID pays its own new
      // amount; a settling PASS pays the standing bid; zero bids pay nothing.
      return action.type === 'AUCTION_BID' ? action.amount : open.highBid === null ? 0 : open.highBid.amount;
    }
    case 'BUILD_LEVEL': {
      const deed = prev.ownership[action.tile];
      const nextDeed = next.ownership[action.tile];
      const group = getTile(action.tile).group;
      if (deed === undefined || nextDeed === undefined || group === null) return 0;
      if (nextDeed.level !== deed.level + 1) return 0; // engine bug — the conservation check fires
      return deed.level === 4 ? 0 : DISTRICT_GROUPS[group].permitCost;
    }
    case 'SELL_LEVEL': {
      const group = getTile(action.tile).group;
      const refund = group === null ? 0 : -Math.floor(DISTRICT_GROUPS[group].permitCost / 2);
      return refund + bankDebtSettlement(prev, next, action.player);
    }
    case 'MORTGAGE':
      return -mortgageValue(action.tile) + bankDebtSettlement(prev, next, action.player);
    case 'LIFT_MORTGAGE':
      return mortgageLiftCost(action.tile);
    case 'DECLARE_BANKRUPTCY': {
      const debt = prev.debt;
      return debt !== null && debt.creditor === 'bank' ? prev.players[debt.debtor].cash : 0;
    }
    default:
      // Rolls settle rents player-to-player (net zero); trades net zero; the
      // salary/tax/fine legs arrive through the event log, not the state.
      return 0;
  }
}

/**
 * Rent precision on a landing (spec §3.4): when the roll's move lands on an
 * owned, unmortgaged, rentable tile, the payer's non-event cash delta must be
 * exactly −rent and the owner's exactly +rent — or a debt record naming the
 * exact rent must have been entered instead.
 */
function checkRent(prev: GameState, next: GameState, suffix: readonly GameEvent[], byPlayer: Map<PlayerId, number>): void {
  const moved = suffix.find(e => e.type === 'MOVED');
  if (moved === undefined) return; // jail failure, third doubles, audit — no landing to settle
  const info = getTile(moved.to);
  const entry = prev.ownership[moved.to];
  if (!isBuyableKind(info.kind) || entry === undefined || entry.mortgaged || entry.owner === moved.player) return;

  const rolled = suffix.find(e => e.type === 'DICE_ROLLED');
  const diceSum = rolled === undefined ? 0 : rolled.d1 + rolled.d2;
  const rent = rentDue(moved.to, entry.owner, diceSum, prev.ownership);
  if (rent === 0) return;

  const nonEventDelta = (pid: PlayerId): number =>
    next.players[pid].cash - prev.players[pid].cash - (byPlayer.get(pid) ?? 0);

  const debtEntered = prev.debt === null && next.debt !== null && next.debt.debtor === moved.player;
  if (debtEntered) {
    if (next.debt?.amount !== rent) throw new Error(`fuzz: debt ${next.debt?.amount} !== rent ${rent} on tile ${moved.to}`);
    if (nonEventDelta(moved.player) !== 0) throw new Error(`fuzz: debtor cash moved outside events on tile ${moved.to}`);
    if (nonEventDelta(entry.owner) !== 0) throw new Error(`fuzz: landlord cash moved outside events on tile ${moved.to}`);
  } else {
    if (nonEventDelta(moved.player) !== -rent) throw new Error(`fuzz: rent ${rent} on tile ${moved.to} not paid exactly by ${moved.player}`);
    if (nonEventDelta(entry.owner) !== rent) throw new Error(`fuzz: rent ${rent} on tile ${moved.to} not received exactly by owner ${entry.owner}`);
  }
}

/** Every invariant checked after one successful action (prev → next). Hot path — raw throws, no expect machinery. */
function checkStep(prev: GameState, next: GameState, action: GameAction, suffix: readonly GameEvent[]): void {
  // Log: strictly append-only — seq numbers stay contiguous and old events
  // are byte-identical (the fingerprint at game end proves the full history).
  if (next.log.length < prev.log.length) throw new Error('fuzz: log shrank — append-only violated');
  for (let i = prev.log.length; i < next.log.length; i++) {
    if (next.log[i].seq !== i) throw new Error(`fuzz: log seq ${next.log[i].seq} at index ${i} — append-only violated`);
  }

  // TD conservation (spec §3.9): bank delta === −(sum of player deltas).
  // Summed rather than sign-flipped: Object.is distinguishes +0 from −0,
  // and a cash-neutral action would otherwise compare +0 to −0.
  const flows = eventFlows(suffix);
  const bankDelta = flows.bank + structuralBankFlow(prev, next, action);
  const playerDelta = next.players.reduce((sum, p) => sum + p.cash, 0) -
    prev.players.reduce((sum, p) => sum + p.cash, 0);
  if (bankDelta + playerDelta !== 0) {
    throw new Error(`fuzz: TD conservation broken after ${action.type} — bank ${bankDelta}, players ${playerDelta}, events ${suffix.map(e => e.type).join(',')}`);
  }

  if (action.type === 'ROLL_DICE') checkRent(prev, next, suffix, flows.byPlayer);

  // Cash is never negative, and the auxiliary records match the turn state.
  for (const p of next.players) {
    if (p.cash < 0) throw new Error(`fuzz: ${p.name} holds ${p.cash} TD after ${action.type}`);
  }
  if ((next.debt !== null) !== (next.turn.state === 'debt')) {
    throw new Error(`fuzz: debt record vs turn state mismatch after ${action.type}`);
  }
  if ((next.auction !== null) !== (next.turn.state === 'auction')) {
    throw new Error(`fuzz: auction record vs turn state mismatch after ${action.type}`);
  }
  for (const key of Object.keys(next.ownership)) {
    const deed = next.ownership[tileId(Number(key))];
    if (deed !== undefined && next.players[deed.owner].bankrupt) {
      throw new Error(`fuzz: bankrupt player ${deed.owner} owns tile ${key} after ${action.type}`);
    }
  }
  if (next.phase === 'finished' && next.winner === null) {
    throw new Error('fuzz: game finished without a winner');
  }
}

/** Every invariant checked once a game reaches `finished`. */
function checkFinished(state: GameState, seed: string, fingerprint: string): void {
  expect(state.winner).not.toBeNull();
  expect(state.log[state.log.length - 1]?.type).toBe('GAME_FINISHED');
  expect(stateHash(JSON.parse(JSON.stringify(state)) as GameState)).toBe(stateHash(state));
  // Append-only proof: the fingerprint folded step-by-step as events appeared
  // must match a from-scratch recompute over the final log.
  expect(foldFingerprint(GENESIS_FINGERPRINT, state.log)).toBe(fingerprint);
}

function assertTypedRejection(error: GameError, seed: string, step: number, action: GameAction): void {
  expect(VALID_ERROR_CODES.has(error.code)).toBe(true);
  expect(typeof error.message).toBe('string');
  if (error.code === 'INTERNAL' || error.code === 'NOT_IMPLEMENTED') {
    throw new Error(
      `fuzz: seed ${seed} step ${step} action ${action.type} produced ${error.code}: ${error.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Game drivers.
// ---------------------------------------------------------------------------

interface GameSummary {
  readonly steps: number;
  readonly winner: PlayerId;
}

/** Play one random legal-action game to completion, checking every invariant. */
function fuzzGame(seed: string, playerCount: number): GameSummary {
  let state = createGame(seed, SEAT_NAMES.slice(0, playerCount));
  const rng = driverRng(seed);
  // Seed the fingerprint with the initial log (GAME_STARTED and the first
  // TURN_STARTED) so the step-by-step fold and the final recompute cover the
  // exact same event sequence.
  let fingerprint = foldFingerprint(GENESIS_FINGERPRINT, state.log);
  let steps = 0;
  while (state.phase === 'active') {
    steps++;
    if (steps > MAX_STEPS) {
      // Diagnostic dump for a stall: per-seat cash/holdings, the ownership
      // map (owner + mortgage + level), and the last 30 events.
      for (const p of state.players) {
        const owned = Object.keys(state.ownership).filter(k => state.ownership[Number(k) as TileId]?.owner === p.id);
        const built = owned.filter(k => (state.ownership[Number(k) as TileId]?.level ?? 0) > 0).length;
        console.log(`DUMP ${seed} p${p.id} cash=${p.cash} bankrupt=${p.bankrupt} props=${owned.length} built=${built}`);
      }
      const groups = Object.values(DISTRICT_GROUPS).map(g => `${g.id}:${g.tiles.map(t => {
        const deed = state.ownership[t];
        if (!deed) return '-';
        return `${deed.owner}${deed.mortgaged ? 'm' : ''}${deed.level > 0 ? `L${deed.level}` : ''}`;
      }).join('')}`).join(' ');
      console.log(`DUMP ${seed} ownership: ${groups}`);
      const tail = state.log.slice(-30).map(e => JSON.stringify(e)).join('\n  ');
      console.log(`DUMP ${seed} log tail:\n  ${tail}`);
      const counts: Record<string, number> = {};
      for (const e of state.log) counts[e.type] = (counts[e.type] ?? 0) + 1;
      console.log(`DUMP ${seed} event counts: ${JSON.stringify(counts)}`);
      throw new Error(`fuzz: seed ${seed} did not finish within ${MAX_STEPS} actions (turn ${state.turn.state}, player ${state.turn.activePlayer})`);
    }
    const options = candidates(state);
    if (options.length === 0) throw new Error(`fuzz: seed ${seed} step ${steps} offers no legal actions while active`);

    let pick = biasedPick(state, options, rng);
    let chosen = fillAction(state, options[pick].pid, options[pick].skeleton, rng);
    let result = applyAction(state, chosen);
    let rejections = 0;
    while (!result.ok) {
      assertTypedRejection(result.error, seed, steps, chosen);
      rejections++;
      if (rejections > MAX_CONSECUTIVE_REJECTIONS) {
        chosen = forcedProgress(state);
        result = applyAction(state, chosen);
        if (!result.ok) {
          throw new Error(`fuzz: seed ${seed} step ${steps} forced progress ${chosen.type} rejected: ${result.error.code} ${result.error.message}`);
        }
      } else {
        pick = biasedPick(state, options, rng);
        chosen = fillAction(state, options[pick].pid, options[pick].skeleton, rng);
        result = applyAction(state, chosen);
      }
    }
    const suffix = result.state.log.slice(state.log.length);
    fingerprint = foldFingerprint(fingerprint, suffix);
    checkStep(state, result.state, chosen, suffix);
    state = result.state;
  }
  checkFinished(state, seed, fingerprint);
  if (state.winner === null) throw new Error(`fuzz: seed ${seed} finished without a winner`);
  return { steps, winner: state.winner };
}

/** Play one bot-policy game (the Rules Lab's future driver) with the same checks. */
function botGame(seed: string, playerCount: number): GameSummary {
  let state = createGame(seed, SEAT_NAMES.slice(0, playerCount));
  const rng = driverRng(seed);
  let fingerprint = foldFingerprint(GENESIS_FINGERPRINT, state.log);
  let steps = 0;
  while (state.phase === 'active') {
    steps++;
    if (steps > MAX_STEPS) {
      throw new Error(`bot: seed ${seed} did not finish within ${MAX_STEPS} actions (turn ${state.turn.state})`);
    }
    const options: GameAction[] = [];
    for (const p of state.players) {
      if (p.bankrupt) continue;
      const action = pickAction(state, p.id);
      if (action !== null) options.push(action);
    }
    if (options.length === 0) throw new Error(`bot: seed ${seed} step ${steps} stalled — no bot has a move`);
    const chosen = options[draw(rng, options.length)];
    const result = applyAction(state, chosen);
    if (!result.ok) {
      throw new Error(
        `bot: seed ${seed} step ${steps} produced an illegal ${chosen.type}: ${result.error.code} ${result.error.message}`,
      );
    }
    const suffix = result.state.log.slice(state.log.length);
    fingerprint = foldFingerprint(fingerprint, suffix);
    checkStep(state, result.state, chosen, suffix);
    state = result.state;
  }
  checkFinished(state, seed, fingerprint);
  if (state.winner === null) throw new Error(`bot: seed ${seed} finished without a winner`);
  return { steps, winner: state.winner };
}

// ---------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------

describe('random legal-action fuzz (AC10)', () => {
  for (const count of PLAYER_COUNTS) {
    if (CHUNK_PARTITION !== 0 && count !== CHUNK_PARTITION) continue;
    const games = CHUNK_GAMES !== 0 ? CHUNK_GAMES : GAMES_PER_COUNT;
    const first = CHUNK_GAMES !== 0 ? SEED_START : 0;
    it(`conserves TD, never throws, and finishes ${games} ${count}-player games` +
      (CHUNK_GAMES !== 0 ? ` (chunk seeds ${first}–${first + games - 1})` : ''), () => {
      for (let i = 0; i < games; i++) {
        fuzzGame(`fuzz-p${count}-${String(first + i).padStart(4, '0')}`, count);
      }
    }, PARTITION_TIMEOUT_MS);
  }
});

// Chunk mode runs exactly one partition slice per invocation — the cold
// suites (sweep, bot, determinism replays) run separately at full scale.
const itFull: (name: string, fn: () => void, timeout?: number) => void =
  CHUNK_PARTITION !== 0 ? it.skip : it;

describe('typed rejection sweep (AC10: every rejection is a typed GameError)', () => {
  itFull('answers misplaced actions with typed errors from every reachable turn state', () => {
    // Walk one short random game and capture the first state seen in each
    // turn state; from each, fire the full action deck from both the active
    // player and a bystander. Nothing may throw, nothing may surface
    // INTERNAL/NOT_IMPLEMENTED, and every rejection must carry a typed code.
    const states = new Map<string, GameState>();
    let state = createGame('rejection-sweep', SEAT_NAMES.slice(0, 3));
    const rng = driverRng('rejection-sweep');
    for (let i = 0; i < 400 && states.size < 5; i++) {
      if (!states.has(state.turn.state)) states.set(state.turn.state, state);
      const options = candidates(state);
      const pick = biasedPick(state, options, rng);
      let result = applyAction(state, fillAction(state, options[pick].pid, options[pick].skeleton, rng));
      let tries = 0;
      while (!result.ok && tries < MAX_CONSECUTIVE_REJECTIONS) {
        const retry = biasedPick(state, options, rng);
        result = applyAction(state, fillAction(state, options[retry].pid, options[retry].skeleton, rng));
        tries++;
      }
      if (!result.ok) result = applyAction(state, forcedProgress(state));
      if (!result.ok) throw new Error(`rejection sweep: driver action rejected: ${result.error.code}`);
      state = result.state;
      if (state.phase !== 'active') break;
    }
    expect(states.size).toBeGreaterThanOrEqual(3);

    const deck: GameAction[] = [
      { type: 'ROLL_DICE', player: playerId(1) },
      { type: 'BUY_PROPERTY', player: playerId(1) },
      { type: 'DECLINE_BUY', player: playerId(1) },
      { type: 'PAY_JAIL_FINE', player: playerId(1) },
      { type: 'END_TURN', player: playerId(1) },
      { type: 'BUILD_LEVEL', player: playerId(1), tile: tileId(0) },
      { type: 'SELL_LEVEL', player: playerId(1), tile: tileId(0) },
      { type: 'MORTGAGE', player: playerId(1), tile: tileId(0) },
      { type: 'LIFT_MORTGAGE', player: playerId(1), tile: tileId(0) },
      { type: 'DECLARE_BANKRUPTCY', player: playerId(1) },
      { type: 'PROPOSE_TRADE', player: playerId(1), to: playerId(2), give: { cash: 100, tiles: [] }, want: { cash: 0, tiles: [] } },
      { type: 'ACCEPT_TRADE', player: playerId(1) },
      { type: 'DECLINE_TRADE', player: playerId(1) },
      { type: 'AUCTION_BID', player: playerId(1), amount: 100 },
      { type: 'AUCTION_PASS', player: playerId(1) },
    ];
    let checked = 0;
    for (const snapshot of states.values()) {
      for (const action of deck) {
        const result = applyAction(snapshot, action);
        checked++;
        if (result.ok) continue; // legal in this state — a transition, not a rejection
        expect(VALID_ERROR_CODES.has(result.error.code)).toBe(true);
        expect(result.error.code === 'INTERNAL' || result.error.code === 'NOT_IMPLEMENTED').toBe(false);
        expect(typeof result.error.message).toBe('string');
      }
      // Fire the same deck from the actual active seat so legal-by-state
      // actions (not just WRONG_PLAYER ones) are exercised too.
      const active = snapshot.turn.activePlayer;
      for (const action of deck) {
        const fromActive = { ...action, player: playerId(active) } as GameAction;
        const result = applyAction(snapshot, fromActive);
        checked++;
        if (result.ok) continue;
        expect(VALID_ERROR_CODES.has(result.error.code)).toBe(true);
        expect(result.error.code === 'INTERNAL' || result.error.code === 'NOT_IMPLEMENTED').toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('bot policy games (spec §5 driver, AC10 invariants)', () => {
  itFull('plays bot-vs-bot games to completion with every invariant intact', () => {
    for (const count of PLAYER_COUNTS) {
      for (let i = 0; i < BOT_GAMES_PER_COUNT; i++) {
        botGame(`bot-p${count}-${String(i).padStart(3, '0')}`, count);
      }
    }
  }, PARTITION_TIMEOUT_MS);

  itFull('is deterministic: the same seed replays the same winner in every run', () => {
    const replays = Math.min(BOT_GAMES_PER_COUNT, 3);
    for (const count of PLAYER_COUNTS) {
      for (let i = 0; i < replays; i++) {
        const seed = `bot-p${count}-${String(i).padStart(3, '0')}`;
        const first = botGame(seed, count);
        const second = botGame(seed, count);
        expect(second.winner).toBe(first.winner);
        expect(second.steps).toBe(first.steps);
      }
    }
  }, PARTITION_TIMEOUT_MS);
});
