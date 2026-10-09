// Tycoon City — Phase 1 turn state machine and engine facade functions
// (spec §3.3, §4).
//
// The single TRANSITION_TABLE maps every observable TurnState × GameAction
// cell either to a handler or to nothing (the facade then rejects the pair
// with a typed WRONG_PHASE error — a cell is never silently ignored).
// Rule modules (economy/auction/trading/development/bankruptcy) receive a
// mutable working copy; a failed handler discards the copy, so failed
// actions are atomic and the caller's state is untouched.

import {
  AUCTION_MIN_BID,
  AUCTION_MIN_INCREMENT,
  getTile,
  JAIL_FINE,
  JAIL_TERM,
  SALARY,
  STARTING_CASH,
} from './board';
import { rentDue } from './board';
import { initialRngState, rollTwoDice, shuffledRange } from './rng';
import * as economy from './economy';
import * as auction from './auction';
import * as trading from './trading';
import * as development from './development';
import * as bankruptcy from './bankruptcy';
import type {
  ActiveAuction,
  ApplyResult,
  GameAction,
  GameError,
  GameErrorCode,
  GameEventInit,
  GameState,
  HandlerResult,
  PlayerId,
  TileId,
  TurnEndReason,
  TurnState,
  WorkingState,
} from './types';
import { playerId, tileId } from './types';

/** Working copy: the structural clone handlers mutate in place. */
type MutableGameState = WorkingState;

function err(code: GameErrorCode, message: string): GameError {
  return { code, message };
}

/** Mutable-log element type: the working log is a mutable array of events. */
type MutableGameEvent = MutableGameState['log'][number];

/** Stamp the next sequence number and append to the log (handlers only). */
function pushEvent(work: MutableGameState, init: GameEventInit): void {
  // GameEventInit is a distributive Omit of a discriminated union; the spread
  // reconstitutes exactly one variant (checked by the log-shape tests). The
  // cast only strips the readonly modifiers the deep-mutable element type
  // lacks — log entries are append-only data, never edited after the push.
  work.log.push({ seq: work.log.length, ...init } as MutableGameEvent);
}

/** Core tile effect: escorted move to The Depot, held for the full term. */
function sendToDepot(work: MutableGameState, player: PlayerId, reason: 'audit' | 'third-doubles'): void {
  work.players[player] = { ...work.players[player], position: tileId(39), jailTurnsLeft: JAIL_TERM };
  pushEvent(work, { type: 'SENT_TO_DEPOT', player, reason, term: JAIL_TERM });
}

/** Enter the debt state naming the creditor; liquidation is the only legal play. */
function enterDebt(work: MutableGameState, debtor: PlayerId, creditor: PlayerId | 'bank', amount: number): void {
  work.debt = { debtor, creditor, amount };
  work.turn = { ...work.turn, state: 'debt' };
  pushEvent(work, { type: 'DEBT_ENTERED', player: debtor, creditor, amount });
}

/**
 * Advance to the next solvent player (or finish the game when one solvent
 * player remains — elimination victory, spec §3.8). Resets the doubles run.
 */
function advanceTurn(work: MutableGameState, reason: TurnEndReason): void {
  pushEvent(work, { type: 'TURN_ENDED', player: work.turn.activePlayer, reason });
  const solvent = work.players.filter(p => !p.bankrupt);
  if (solvent.length <= 1) {
    work.phase = 'finished';
    const winner = solvent.length === 1 ? solvent[0].id : null;
    work.winner = winner;
    if (winner !== null) pushEvent(work, { type: 'GAME_FINISHED', winner });
    work.turn = { ...work.turn, state: 'turnStart', doublesRun: 0 };
    return;
  }
  let next = work.turn.activePlayer;
  do {
    next = playerId((next + 1) % work.players.length);
  } while (work.players[next].bankrupt);
  const held = work.players[next].jailTurnsLeft > 0;
  work.turn = { activePlayer: next, state: held ? 'turnStart' : 'awaitingRoll', doublesRun: 0 };
  pushEvent(work, { type: 'TURN_STARTED', player: next });
}

/**
 * Move a player forward by `steps`, collecting the 1,600 TD salary when the
 * move passes or lands on City Hall Plaza (spec §3.3), then resolve the
 * landing tile.
 */
function moveAndResolve(
  work: MutableGameState,
  player: PlayerId,
  steps: number,
  extraRollFromDoubles: boolean,
): HandlerResult {
  const p = work.players[player];
  const raw = p.position + steps;
  const to = tileId(raw % 40);
  const passedStart = raw >= 40;
  work.players[player] = { ...p, position: to };
  pushEvent(work, { type: 'MOVED', player, from: p.position, to, passedStart });
  if (passedStart) {
    const richer = work.players[player];
    work.players[player] = { ...richer, cash: richer.cash + SALARY };
    pushEvent(work, { type: 'SALARY_COLLECTED', player, amount: SALARY });
  }
  return resolveLanding(work, player, to, steps, extraRollFromDoubles);
}

/**
 * Resolve the tile the player landed on (spec §3.3, §3.4, §3.5):
 * no-effect tiles → next turn window; tax → pay the bank or enter debt;
 * Audit Office → The Depot, held, turn ends; unowned property → buy offer;
 * owned property → rent via the economy seam (mortgaged or self-owned → no
 * rent). On doubles the player must roll again, so the next window is
 * `awaitingRoll`, never `postRoll`.
 */
function resolveLanding(
  work: MutableGameState,
  player: PlayerId,
  at: TileId,
  diceSum: number,
  extraRollFromDoubles: boolean,
): HandlerResult {
  const t = getTile(at);
  const next: TurnState = extraRollFromDoubles ? 'awaitingRoll' : 'postRoll';
  const settle = (): void => {
    work.turn = { ...work.turn, state: next };
  };
  switch (t.kind) {
    case 'start':
    case 'rest':
    case 'safe':
    case 'jail': // landing on The Depot is "just visiting"
      settle();
      return { ok: true };
    case 'tax': {
      const amount = t.taxAmount ?? 0;
      const p = work.players[player];
      if (p.cash >= amount) {
        work.players[player] = { ...p, cash: p.cash - amount };
        pushEvent(work, { type: 'TAX_COLLECTED', player, tile: at, amount });
        settle();
        return { ok: true };
      }
      enterDebt(work, player, 'bank', amount);
      return { ok: true };
    }
    case 'audit':
      sendToDepot(work, player, 'audit');
      advanceTurn(work, 'audit');
      return { ok: true };
    case 'district':
    case 'transit':
    case 'utility': {
      const entry = work.ownership[at];
      if (!entry) {
        pushEvent(work, { type: 'BUY_OFFERED', player, tile: at, price: t.price ?? 0 });
        work.turn = { ...work.turn, state: 'awaitingBuy' };
        return { ok: true };
      }
      if (entry.mortgaged || entry.owner === player) {
        settle();
        return { ok: true };
      }
      const amount = rentDue(at, entry.owner, diceSum, work.ownership);
      return economy.collectRent(work, player, entry.owner, at, amount);
    }
  }
}

/** ROLL_DICE for a free player: 2d6, doubles run, movement, landing. */
function rollFree(work: MutableGameState, action: Extract<GameAction, { type: 'ROLL_DICE' }>): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) return { ok: false, error: err('WRONG_PLAYER', `Only the active player may roll; ${action.player} is not active.`) };
  if (work.players[pid].jailTurnsLeft > 0) return rollHeld(work, action);

  const roll = rollTwoDice(work.rngState);
  work.rngState = roll.state;
  const doubles = roll.d1 === roll.d2;
  pushEvent(work, { type: 'DICE_ROLLED', player: pid, d1: roll.d1, d2: roll.d2, doubles });

  if (doubles) {
    const run = work.turn.doublesRun + 1;
    if (run >= 3) {
      // Third consecutive doubles → The Depot, turn ends, no bonus move (spec §3.3).
      sendToDepot(work, pid, 'third-doubles');
      advanceTurn(work, 'third-doubles');
      return { ok: true };
    }
    work.turn = { ...work.turn, doublesRun: run };
    return moveAndResolve(work, pid, roll.d1 + roll.d2, true);
  }
  return moveAndResolve(work, pid, roll.d1 + roll.d2, false);
}

/** ROLL_DICE while held at The Depot (spec §3.3): doubles → release + move. */
function rollHeld(work: MutableGameState, _action: Extract<GameAction, { type: 'ROLL_DICE' }>): HandlerResult {
  const pid = work.turn.activePlayer;
  const player = work.players[pid];

  const roll = rollTwoDice(work.rngState);
  work.rngState = roll.state;
  const doubles = roll.d1 === roll.d2;
  pushEvent(work, { type: 'DICE_ROLLED', player: pid, d1: roll.d1, d2: roll.d2, doubles });

  if (doubles) {
    // Released by doubles; the jail roll grants no extra roll.
    work.players[pid] = { ...player, jailTurnsLeft: 0 };
    pushEvent(work, { type: 'RELEASED_FROM_JAIL', player: pid, by: 'doubles' });
    return moveAndResolve(work, pid, roll.d1 + roll.d2, false);
  }

  const attemptsLeft = player.jailTurnsLeft - 1;
  if (attemptsLeft > 0) {
    work.players[pid] = { ...player, jailTurnsLeft: attemptsLeft };
    pushEvent(work, { type: 'JAIL_ROLL_FAILED', player: pid, attemptsLeft });
    advanceTurn(work, 'jail-attempt-failed');
    return { ok: true };
  }

  // Third failed attempt: the fine is forced and the player moves by that roll.
  const fine = Math.min(player.cash, JAIL_FINE);
  work.players[pid] = { ...player, jailTurnsLeft: 0, cash: player.cash - fine };
  pushEvent(work, { type: 'JAIL_FINE_PAID', player: pid, amount: fine, kind: 'forced' });
  pushEvent(work, { type: 'RELEASED_FROM_JAIL', player: pid, by: 'forced' });
  return moveAndResolve(work, pid, roll.d1 + roll.d2, false);
}

/** PAY_JAIL_FINE while held: 500 TD, then the player still rolls this turn. */
function payJailFine(work: MutableGameState, action: Extract<GameAction, { type: 'PAY_JAIL_FINE' }>): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) return { ok: false, error: err('WRONG_PLAYER', `Only the active player may pay the fine; ${action.player} is not active.`) };
  const player = work.players[pid];
  if (player.jailTurnsLeft === 0) return { ok: false, error: err('NOT_HELD', `${player.name} is not held at The Depot.`) };
  if (player.cash < JAIL_FINE) {
    return { ok: false, error: err('INSUFFICIENT_FUNDS', `Paying the ${JAIL_FINE} TD fine needs more cash than ${player.name} holds; roll for doubles instead.`) };
  }
  work.players[pid] = { ...player, cash: player.cash - JAIL_FINE, jailTurnsLeft: 0 };
  pushEvent(work, { type: 'JAIL_FINE_PAID', player: pid, amount: JAIL_FINE, kind: 'voluntary' });
  pushEvent(work, { type: 'RELEASED_FROM_JAIL', player: pid, by: 'fine' });
  work.turn = { ...work.turn, state: 'awaitingRoll' };
  return { ok: true };
}

function endTurn(work: MutableGameState, action: Extract<GameAction, { type: 'END_TURN' }>): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) return { ok: false, error: err('WRONG_PLAYER', `Only the active player may end the turn; ${action.player} is not active.`) };
  advanceTurn(work, 'voluntary');
  return { ok: true };
}

/**
 * The single source of truth for turn flow (spec §4): observable turn state ×
 * action type → handler. A missing cell means the facade rejects the pair
 * with WRONG_PHASE — the FSM table test (AC3) walks this table directly.
 * `moving` is transient and never observable: movement resolves synchronously
 * inside ROLL_DICE.
 */
/** A handler narrowed to one action variant; the table's key guarantees the
 *  variant matches, so dispatch narrows with a single checked cast. */
type AnyActionHandler = (work: MutableGameState, action: never) => HandlerResult;
type ActionRow = Partial<Record<GameAction['type'], AnyActionHandler>>;

export const TRANSITION_TABLE: Readonly<Record<TurnState, ActionRow>> = {
  turnStart: {
    ROLL_DICE: rollFree, // dispatches to the held path when the player is held
    PAY_JAIL_FINE: payJailFine,
  },
  awaitingRoll: {
    ROLL_DICE: rollFree,
    PROPOSE_TRADE: trading.proposeTrade,
    ACCEPT_TRADE: trading.acceptTrade,
    DECLINE_TRADE: trading.declineTrade,
  },
  moving: {}, // transient — movement resolves synchronously inside ROLL_DICE
  awaitingBuy: {
    BUY_PROPERTY: economy.buyProperty,
    DECLINE_BUY: auction.declineBuy,
  },
  auction: {
    AUCTION_BID: auction.bid,
    AUCTION_PASS: auction.pass,
  },
  postRoll: {
    END_TURN: endTurn,
    PROPOSE_TRADE: trading.proposeTrade,
    ACCEPT_TRADE: trading.acceptTrade,
    DECLINE_TRADE: trading.declineTrade,
    BUILD_LEVEL: development.buildLevel,
    SELL_LEVEL: development.sellLevel,
    MORTGAGE: development.mortgage,
    LIFT_MORTGAGE: development.liftMortgage,
  },
  debt: {
    // Liquidation is the only legal play under debt (spec §3.7).
    SELL_LEVEL: development.sellLevel,
    MORTGAGE: development.mortgage,
    DECLARE_BANKRUPTCY: bankruptcy.declareBankruptcy,
  },
};

/** Sender rule: auction bids come from any solvent player, trade responses
 *  from the offeree, everything else from the active player. */
function checkSender(work: MutableGameState, action: GameAction): GameError | null {
  const sender = work.players[action.player];
  if (!sender) return err('WRONG_PLAYER', `No player seat ${action.player}.`);
  if (sender.bankrupt) return err('WRONG_PLAYER', `${sender.name} is bankrupt and cannot act.`);
  if (action.type === 'AUCTION_BID' || action.type === 'AUCTION_PASS') return null;
  if (action.type === 'ACCEPT_TRADE' || action.type === 'DECLINE_TRADE') {
    const trade = work.pendingTrade;
    if (!trade) return err('NO_PENDING_TRADE', 'No trade is pending.');
    if (action.player !== trade.to) return err('WRONG_PLAYER', `Only the offeree (${work.players[trade.to].name}) may respond to the trade.`);
    return null;
  }
  if (action.player !== work.turn.activePlayer) {
    return err('WRONG_PLAYER', `${sender.name} acted out of turn; active player is ${work.players[work.turn.activePlayer].name}.`);
  }
  return null;
}

/** Tycoon City needs 2–5 players (spec §3.1). Throws only on constructor misuse. */
export function createGame(seed: string, playerNames: readonly string[]): GameState {
  if (seed.length === 0) throw new RangeError('seed must be a non-empty string');
  if (playerNames.length < 2 || playerNames.length > 5) {
    throw new RangeError(`Tycoon City needs 2–5 players, got ${playerNames.length}`);
  }
  if (playerNames.some(n => n.trim().length === 0)) {
    throw new RangeError('player names must be non-empty');
  }
  const shuffled = shuffledRange(initialRngState(seed), playerNames.length);
  const players = shuffled.order.map((seat, i) => ({
    id: playerId(i),
    name: playerNames[seat],
    cash: STARTING_CASH,
    position: tileId(0),
    jailTurnsLeft: 0,
    bankrupt: false,
  }));
  const work: MutableGameState = {
    seed,
    rngState: shuffled.state,
    players,
    ownership: {},
    phase: 'active',
    turn: { activePlayer: playerId(0), state: 'awaitingRoll', doublesRun: 0 },
    auction: null,
    pendingTrade: null,
    debt: null,
    log: [],
    winner: null,
  };
  pushEvent(work, { type: 'GAME_STARTED', seed, playerOrder: players.map(p => p.name) });
  pushEvent(work, { type: 'TURN_STARTED', player: playerId(0) });
  return work as GameState;
}

/**
 * What the engine would accept from `pid` right now — skeleton actions the
 * caller fills (bid amounts at/above the minimum, trade legs, target tiles).
 * Stub-era note: cells whose rule module is not yet implemented are listed
 * per the rules but applyAction rejects them with NOT_IMPLEMENTED.
 */
export function getLegalActions(state: GameState, pid: PlayerId): GameAction[] {
  if (state.phase !== 'active') return [];
  const me = state.players[pid];
  if (!me || me.bankrupt) return [];

  if (state.turn.state === 'auction' && state.auction !== null) {
    const open: ActiveAuction = state.auction;
    if (open.passed.includes(pid)) return [];
    const minNext = open.highBid === null ? AUCTION_MIN_BID : open.highBid.amount + AUCTION_MIN_INCREMENT;
    return [
      { type: 'AUCTION_BID', player: pid, amount: minNext },
      { type: 'AUCTION_PASS', player: pid },
    ];
  }
  if (
    state.pendingTrade !== null && state.pendingTrade.to === pid &&
    (state.turn.state === 'awaitingRoll' || state.turn.state === 'postRoll')
  ) {
    return [{ type: 'ACCEPT_TRADE', player: pid }, { type: 'DECLINE_TRADE', player: pid }];
  }
  if (pid !== state.turn.activePlayer) return [];
  const a = (type: GameAction['type']): GameAction => ({ type, player: pid } as GameAction);
  switch (state.turn.state) {
    case 'turnStart':
      return me.jailTurnsLeft > 0 ? [a('ROLL_DICE'), a('PAY_JAIL_FINE')] : [a('ROLL_DICE')];
    case 'awaitingRoll':
      return [a('ROLL_DICE'), a('PROPOSE_TRADE')];
    case 'awaitingBuy':
      return [a('BUY_PROPERTY'), a('DECLINE_BUY')];
    case 'postRoll':
      return [a('END_TURN'), a('PROPOSE_TRADE'), a('BUILD_LEVEL'), a('SELL_LEVEL'), a('MORTGAGE'), a('LIFT_MORTGAGE')];
    case 'debt':
      return [a('SELL_LEVEL'), a('MORTGAGE'), a('DECLARE_BANKRUPTCY')];
    default:
      return [];
  }
}

/**
 * Apply an action atomically: the handler runs on a structural clone; a
 * failure discards the clone so the caller's state is untouched. Never
 * throws — every failure is a typed GameError.
 */
export function applyAction(state: GameState, action: GameAction): ApplyResult {
  if (state.phase !== 'active') {
    return { ok: false, error: err('GAME_NOT_ACTIVE', `The game is ${state.phase}; no actions are accepted.`) };
  }
  const work = structuredClone(state) as MutableGameState;
  try {
    const senderError = checkSender(work, action);
    if (senderError !== null) return { ok: false, error: senderError };
    const row = TRANSITION_TABLE[work.turn.state];
    const handler = row[action.type];
    if (!handler) {
      return { ok: false, error: err('WRONG_PHASE', `${action.type} is not legal while the turn is in state ${work.turn.state}.`) };
    }
    const result = handler(work, action as never);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, state: work as GameState };
  } catch (e) {
    // Surfaced, never swallowed: the caller sees a typed error and keeps its state.
    return {
      ok: false,
      error: err('INTERNAL', e instanceof Error ? e.message : `engine failure: ${String(e)}`),
    };
  }
}
