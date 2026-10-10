// Economy rule module — property purchase and rent collection (spec §3.4,
// §3.5, §3.7). Mortgage math and net worth join in later commits.
//
// Seam contract (from the core FSM): the turn state machine computes the rent
// amount (board.rentDue) and routes BUY_PROPERTY and rent outcomes here, but
// it does NOT settle the post-landing turn window — this module does (the
// FSM's resolveLanding returns the rent path directly and leaves the window
// to the seam). Handlers mutate the working copy in place and report success;
// a typed failure discards the copy, so failed actions are atomic.

import {
  DISTRICT_GROUPS,
  MORTGAGE_LIFT_ROUND_TO,
  MORTGAGE_LTV,
  getTile,
  isBuyableKind,
} from './board';
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

/**
 * Mortgage value of `tile`: 50% of list price (spec §3.4) — the cash a
 * mortgage hands over and the principal a lift repays. Tiles that cannot be
 * owned have no mortgage value. Prices are multiples of 100 TD, so the
 * halving is exact; the floor keeps the engine total for any future table.
 * Used by the development module's MORTGAGE / LIFT_MORTGAGE handlers and by
 * netWorth.
 */
export function mortgageValue(tile: TileId): number {
  const price = getTile(tile).price;
  return price === null ? 0 : Math.floor(price * MORTGAGE_LTV);
}

/**
 * Cost to lift the mortgage on `tile`: the principal plus a 10% fee, rounded
 * up to the nearest 10 TD (spec §3.4). Used by the development module's
 * LIFT_MORTGAGE handler.
 *
 * Integer-exact end to end. The fee is the exact ratio 11/10, so the rounded
 * lift is ceil(principal × 11 / 100) × 10. A float path (`principal * 1.1`)
 * collects IEEE dust — 800 × 1.1 is 880.0000000000001 — and the ceil turns
 * an exact 880 lift into 890. A canary test pins the ratio to the board
 * constants so the two cannot drift apart silently.
 */
const LIFT_FEE_NUMERATOR = 11; // 10% fee scaled ×10
const LIFT_FEE_DENOMINATOR = 10;
export function mortgageLiftCost(tile: TileId): number {
  const principal = mortgageValue(tile);
  return Math.ceil((principal * LIFT_FEE_NUMERATOR) / (LIFT_FEE_DENOMINATOR * MORTGAGE_LIFT_ROUND_TO)) * MORTGAGE_LIFT_ROUND_TO;
}

/**
 * Canonical net worth (spec §3.8, the elimination tiebreak): cash, plus the
 * list price of every unmortgaged property, mortgaged properties at equity
 * (list price minus the mortgage principal — the principal is already in the
 * owner's cash, so this keeps net worth conserved across mortgaging), plus
 * 50% of development investment. Single-sourced here for the victory checks
 * and the fuzz harness.
 *
 * Development investment counts what the owner paid the bank: one permit
 * cost per built level. A landmark's construction price is unspecified in
 * the rules and the board data, so a landmark counts its four priced
 * permits — an approximation applied identically to every player (reported
 * spec gap: docs/RULES.md §3.4 defines no landmark cost).
 */
export function netWorth(player: PlayerId, state: GameState): number {
  const p = state.players[player]; // Index === PlayerId (types.ts invariant)
  let worth = p.cash;
  let investment = 0;
  for (const [key, deed] of Object.entries(state.ownership)) {
    if (!deed || deed.owner !== player) continue;
    const tile = Number(key) as TileId;
    const info = getTile(tile);
    const price = info.price ?? 0;
    worth += deed.mortgaged ? price - mortgageValue(tile) : price;
    if (info.group !== null) {
      investment += Math.min(deed.level, 4) * DISTRICT_GROUPS[info.group].permitCost;
    }
  }
  return worth + Math.floor(investment / 2); // investment is even for every current table
}
