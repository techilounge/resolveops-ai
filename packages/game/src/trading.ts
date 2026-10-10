// Trading rule module — proposal, response, atomic execution (spec §3.6).
//
// Trades exist only inside the active player's `awaitingRoll`/`postRoll`
// windows: the active player proposes (or revises — a counter is itself a
// new proposal and supersedes the pending one), and the offeree accepts or
// declines while the offering player is still active. An accepted trade
// executes atomically — both legs or neither — after re-validating
// ownership and cash, since rent and other play may have moved funds since
// the proposal. Properties cross in whatever state they are in: the
// development level and mortgage ride along on the ownership entry. A
// pending trade dies with the offering turn: once any other player is
// active, the offer is expired and can be neither accepted nor declined.

import { BOARD_SIZE, getTile } from './board';
import type {
  GameAction,
  GameError,
  GameErrorCode,
  HandlerResult,
  OwnershipEntry,
  PlayerId,
  TileId,
  TradeLeg,
  WorkingState,
} from './types';
import { tileId } from './types';

type ProposeAction = Extract<GameAction, { type: 'PROPOSE_TRADE' }>;
type AcceptAction = Extract<GameAction, { type: 'ACCEPT_TRADE' }>;
type DeclineAction = Extract<GameAction, { type: 'DECLINE_TRADE' }>;

function err(code: GameErrorCode, message: string): GameError {
  return { code, message };
}

interface LegPlan {
  readonly cash: number;
  /** The holder's ownership entry for each requested tile, in request order. */
  readonly entries: readonly OwnershipEntry[];
}

type LegPlanResult =
  | { readonly ok: true; readonly plan: LegPlan }
  | { readonly ok: false; readonly error: GameError };

/**
 * Validate one trade leg against its holder: cash is a non-negative whole
 * amount the holder can pay, and every named tile is a distinct property
 * the holder owns. Returns the plan used to execute the leg, or the typed
 * reason it is illegal. (Error mapping — the taxonomy has no INVALID_ACTION:
 * a malformed or negative amount is an invalid offered amount (INVALID_BID),
 * an unpayable one is INSUFFICIENT_FUNDS, tile problems are INVALID_TILE.)
 */
function planLeg(work: WorkingState, leg: TradeLeg, holder: PlayerId, label: string): LegPlanResult {
  const holderPlayer = work.players[holder];
  if (typeof leg?.cash !== 'number' || !Array.isArray(leg.tiles)) {
    return { ok: false, error: err('INVALID_BID', `The ${label} leg is malformed — it needs a cash amount and a tile list.`) };
  }
  if (!Number.isInteger(leg.cash) || leg.cash < 0) {
    return { ok: false, error: err('INVALID_BID', `The ${label} leg must offer a non-negative whole amount of cash; got ${leg.cash}.`) };
  }
  if (leg.cash > holderPlayer.cash) {
    return { ok: false, error: err('INSUFFICIENT_FUNDS', `The ${label} leg offers ${leg.cash} TD but ${holderPlayer.name} holds only ${holderPlayer.cash}.`) };
  }
  const entries: OwnershipEntry[] = [];
  const seen = new Set<number>();
  for (const raw of leg.tiles) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw >= BOARD_SIZE) {
      return { ok: false, error: err('INVALID_TILE', `The ${label} leg names ${String(raw)}, which is not a board tile.`) };
    }
    const tile = tileId(raw);
    if (seen.has(tile)) {
      return { ok: false, error: err('INVALID_TILE', `The ${label} leg names ${getTile(tile).name} twice.`) };
    }
    seen.add(tile);
    const entry = work.ownership[tile];
    if (!entry || entry.owner !== holder) {
      return { ok: false, error: err('INVALID_TILE', `The ${label} leg includes ${getTile(tile).name}, which ${holderPlayer.name} does not own.`) };
    }
    entries.push(entry);
  }
  return { ok: true, plan: { cash: leg.cash, entries } };
}

/**
 * True when the pending trade can still be acted on. A pending trade
 * expires when the offering turn ends (spec §3.6): the offeror is the only
 * player who is ever active while an offer lives, so an offer whose
 * proposer is not the active player belongs to a turn that has ended.
 */
function offerLives(work: WorkingState): boolean {
  const trade = work.pendingTrade;
  return trade !== null && trade.from === work.turn.activePlayer;
}

/** Propose a cash/property swap during your window (spec §3.6). */
export function proposeTrade(work: WorkingState, action: ProposeAction): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) {
    return { ok: false, error: err('WRONG_PLAYER', `Only the active player may propose a trade; ${action.player} is not active.`) };
  }
  const offeree = work.players[action.to];
  if (action.to === pid || !offeree || offeree.bankrupt) {
    return { ok: false, error: err('WRONG_PLAYER', `A trade needs a solvent counterparty other than the proposer; seat ${String(action.to)} does not qualify.`) };
  }
  const give = planLeg(work, action.give, pid, 'offer');
  if (!give.ok) return give;
  const want = planLeg(work, action.want, action.to, 'request');
  if (!want.ok) return want;
  // Counter semantics (spec §3.6 lifecycle): a counter is a new proposal.
  // Only the active player can propose in v1.0, so proposing supersedes any
  // pending offer — this offeror's revision, or one whose turn has ended.
  // Copy the legs: engine state must never alias the caller's action data.
  work.pendingTrade = {
    from: pid,
    to: action.to,
    give: { cash: action.give.cash, tiles: [...action.give.tiles] as TileId[] },
    want: { cash: action.want.cash, tiles: [...action.want.tiles] as TileId[] },
  };
  return { ok: true };
}

/**
 * Accept the pending trade as the offeree; executes atomically (spec §3.6):
 * ownership and cash are re-validated first, then both legs transfer —
 * there is no partial application.
 */
export function acceptTrade(work: WorkingState, action: AcceptAction): HandlerResult {
  const trade = work.pendingTrade;
  if (!trade || !offerLives(work)) {
    return { ok: false, error: err('NO_PENDING_TRADE', trade ? 'The trade expired when the offering turn ended.' : 'No trade is pending.') };
  }
  if (action.player !== trade.to) {
    return { ok: false, error: err('WRONG_PLAYER', `Only the offeree (${work.players[trade.to].name}) may accept the trade.`) };
  }
  if (work.players[trade.from].bankrupt || work.players[trade.to].bankrupt) {
    return { ok: false, error: err('WRONG_PLAYER', 'Bankrupt players cannot trade.') };
  }
  // Re-validate at execution: the offering player's continued play (rolls,
  // purchases, development) may have moved cash since the proposal.
  const give = planLeg(work, trade.give, trade.from, 'offer');
  if (!give.ok) return give;
  const want = planLeg(work, trade.want, trade.to, 'request');
  if (!want.ok) return want;

  // Execution — validation is complete, so every write below succeeds.
  const from = work.players[trade.from];
  const to = work.players[trade.to];
  work.players[trade.from] = { ...from, cash: from.cash - give.plan.cash + want.plan.cash };
  work.players[trade.to] = { ...to, cash: to.cash - want.plan.cash + give.plan.cash };
  for (let i = 0; i < trade.give.tiles.length; i++) {
    work.ownership[trade.give.tiles[i]] = { ...give.plan.entries[i], owner: trade.to };
  }
  for (let i = 0; i < trade.want.tiles.length; i++) {
    work.ownership[trade.want.tiles[i]] = { ...want.plan.entries[i], owner: trade.from };
  }
  work.pendingTrade = null;
  return { ok: true };
}

/** Decline the pending trade as the offeree; the offer is dropped (spec §3.6). */
export function declineTrade(work: WorkingState, action: DeclineAction): HandlerResult {
  const trade = work.pendingTrade;
  if (!trade || !offerLives(work)) {
    return { ok: false, error: err('NO_PENDING_TRADE', trade ? 'The trade expired when the offering turn ended.' : 'No trade is pending.') };
  }
  if (action.player !== trade.to) {
    return { ok: false, error: err('WRONG_PLAYER', `Only the offeree (${work.players[trade.to].name}) may decline the trade.`) };
  }
  work.pendingTrade = null;
  return { ok: true };
}
