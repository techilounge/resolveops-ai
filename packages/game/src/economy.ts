// Economy rule module — property purchase and rent collection (spec §3.4,
// §3.5, §3.7). Mortgage math and net worth join in later commits.
//
// Seam contract (from the core FSM): the turn state machine computes the rent
// amount (board.rentDue) and routes BUY_PROPERTY and rent outcomes here, but
// it does NOT settle the post-landing turn window — this module does (the
// FSM's resolveLanding returns the rent path directly and leaves the window
// to the seam). Handlers mutate the working copy in place and report success;
// a typed failure discards the copy, so failed actions are atomic.

import { getTile, isBuyableKind } from './board';
import type {
  GameAction,
  GameError,
  GameErrorCode,
  GameEventInit,
  GameState,
  HandlerResult,
  OwnershipView,
  PlayerId,
  TileId,
  WorkingState,
} from './types';

type BuyAction = Extract<GameAction, { type: 'BUY_PROPERTY' }>;

/** Mutable-log element type: the working log is a mutable array of events. */
type WorkingEvent = WorkingState['log'][number];

function err(code: GameErrorCode, message: string): GameError {
  return { code, message };
}

/** Stamp the next sequence number and append to the working log (handlers only). */
function pushEvent(work: WorkingState, init: GameEventInit): void {
  // Same stamping shape as the FSM's pushEvent; the cast only strips the
  // deep-mutable element type's missing readonly modifiers — log entries are
  // append-only data, never edited after the push.
  work.log.push({ seq: work.log.length, ...init } as WorkingEvent);
}

/**
 * Whether the roll that produced the current landing earns another roll
 * (spec §3.3): only a free roll of doubles does. Two state signals are
 * needed because neither alone is sufficient:
 *
 * - `doublesRun > 0` persists after a doubles roll even once a later plain
 *   roll resolves the landing, so it alone would wrongly re-roll a turn
 *   whose landing roll was plain.
 * - The landing roll's own doubles flag is the most recent DICE_ROLLED
 *   event (the log is append-only and rolls precede every landing), but a
 *   jail-release roll of doubles grants no extra roll — and it never
 *   increments `doublesRun` (the run is zeroed when the held turn began).
 *
 * Both signals together are exact for every reachable landing.
 */
function landingRollEarnsAnother(work: WorkingState): boolean {
  if (work.turn.doublesRun === 0) return false;
  for (let i = work.log.length - 1; i >= 0; i--) {
    const event = work.log[i];
    if (event.type === 'DICE_ROLLED') return event.doubles;
  }
  // Unreachable via applyAction: a landing is always preceded by its roll.
  return false;
}

/** Settle the post-landing turn window: a doubles roll must roll again. */
function settleAfterLanding(work: WorkingState): void {
  work.turn = { ...work.turn, state: landingRollEarnsAnother(work) ? 'awaitingRoll' : 'postRoll' };
}

/** Buy the property the active player stands on, at list price (spec §3.5). */
export function buyProperty(work: WorkingState, action: BuyAction): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) {
    return { ok: false, error: err('WRONG_PLAYER', `Only the active player may buy; ${action.player} is not active.`) };
  }
  const at = work.players[pid].position;
  const tile = getTile(at);
  if (!isBuyableKind(tile.kind) || tile.price === null) {
    return { ok: false, error: err('INVALID_TILE', `${tile.name} is not a purchaseable property.`) };
  }
  if (work.ownership[at]) {
    return { ok: false, error: err('INTERNAL', `${tile.name} is already owned; no buy offer can be pending.`) };
  }
  const buyer = work.players[pid];
  if (buyer.cash < tile.price) {
    return {
      ok: false,
      error: err(
        'INSUFFICIENT_FUNDS',
        `Buying ${tile.name} costs ${tile.price} TD; ${buyer.name} holds ${buyer.cash} TD. Decline to open the auction instead.`,
      ),
    };
  }
  work.players[pid] = { ...buyer, cash: buyer.cash - tile.price };
  work.ownership[at] = { owner: pid, level: 0, mortgaged: false };
  settleAfterLanding(work);
  return { ok: true };
}

/**
 * Collect `amount` from `payer` on behalf of `payee` (spec §3.4, §3.7): a
 * payer with sufficient cash transfers exactly `amount`; a shortfall drives
 * the payer into the debt state naming `payee`, where liquidation is the
 * only legal play. The amount arrives pre-computed (board.rentDue);
 * mortgaged and self-owned tiles never reach this seam.
 */
export function collectRent(
  work: WorkingState,
  payer: PlayerId,
  payee: PlayerId,
  tile: TileId,
  amount: number,
): HandlerResult {
  if (amount <= 0) {
    settleAfterLanding(work);
    return { ok: true };
  }
  const entry = work.ownership[tile];
  if (!entry || entry.owner !== payee) {
    return { ok: false, error: err('INTERNAL', `Rent on tile ${tile} is owed to a non-owner.`) };
  }
  const from = work.players[payer];
  if (from.cash >= amount) {
    work.players[payer] = { ...from, cash: from.cash - amount };
    const to = work.players[payee];
    work.players[payee] = { ...to, cash: to.cash + amount };
    settleAfterLanding(work);
    return { ok: true };
  }
  work.debt = { debtor: payer, creditor: payee, amount };
  work.turn = { ...work.turn, state: 'debt' };
  pushEvent(work, { type: 'DEBT_ENTERED', player: payer, creditor: payee, amount });
  return { ok: true };
}
