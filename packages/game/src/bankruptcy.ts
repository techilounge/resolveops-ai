// Bankruptcy rule module — debt settlement, elimination, and victory
// (spec §3.7, §3.8).
//
// Seam contract: DECLARE_BANKRUPTCY reaches this module only from the debt
// state, which the core FSM gates to SELL_LEVEL, MORTGAGE and this action
// (spec §3.7). The FSM's private advanceTurn does not cover bankruptcy, so
// the handler owns the elimination path end to end: settle the creditor,
// eliminate the debtor, then either finish the game (§3.8 elimination
// victory, with the net-worth tiebreak for a simultaneous mutual
// bankruptcy) or advance play to the next solvent player — mirroring
// advanceTurn's turn-state semantics.
//
// Seam gaps in shared files this PR must not edit (reported, not silently
// worked around): TurnEndReason has no 'bankruptcy' variant, so the
// TURN_ENDED recorded at elimination carries 'voluntary' — the declaration
// is the player's own choice; and the GameEvent union has no development or
// debt-settlement events, so liquidation and settlement are visible in
// state (cash, ownership, debt) but not in the log.

import { netWorth } from './economy';
import type {
  GameAction,
  GameError,
  GameErrorCode,
  GameEventInit,
  GameState,
  HandlerResult,
  PlayerId,
  WorkingState,
} from './types';
import { playerId, tileId } from './types';

type BankruptcyAction = Extract<GameAction, { type: 'DECLARE_BANKRUPTCY' }>;

/** Mutable-log element type: the working log is a mutable array of events. */
type WorkingEvent = WorkingState['log'][number];

function err(code: GameErrorCode, message: string): GameError {
  return { code, message };
}

/** Stamp the next sequence number and append to the working log (handlers only). */
function pushEvent(work: WorkingState, init: GameEventInit): void {
  work.log.push({ seq: work.log.length, ...init } as WorkingEvent);
}

/**
 * Declare bankruptcy from the debt state (spec §3.7): the estate settles
 * with the creditor, the debtor is eliminated, and their turn ends — play
 * continues to the next solvent player, or the game finishes under §3.8.
 */
export function declareBankruptcy(work: WorkingState, action: BankruptcyAction): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) {
    return { ok: false, error: err('WRONG_PLAYER', `Only the active player may declare bankruptcy; ${action.player} is not active.`) };
  }
  const debt = work.debt;
  if (!debt || debt.debtor !== pid) {
    // Unreachable via applyAction — the debt window only opens with a record
    // naming the active player. Surfaced rather than guessed at if engine
    // data is ever inconsistent.
    return { ok: false, error: err('INTERNAL', `bankruptcy: ${work.players[pid].name} has no outstanding debt to settle.`) };
  }

  settleWithCreditor(work, pid, debt.creditor);
  work.players[pid] = { ...work.players[pid], cash: 0, bankrupt: true };
  work.debt = null;

  finishOrAdvance(work, pid);
  return { ok: true };
}

/**
 * Settle the estate with the creditor (spec §3.7): to a player-creditor,
 * all cash, properties (mortgages attached) and development levels
 * transfer as-is; to the bank, properties return to the bank unowned and
 * undeveloped. The estate's cash always leaves the debtor.
 */
function settleWithCreditor(work: WorkingState, debtor: PlayerId, creditor: PlayerId | 'bank'): void {
  const estate = work.players[debtor].cash;
  if (creditor !== 'bank') {
    const payee = work.players[creditor];
    work.players[creditor] = { ...payee, cash: payee.cash + estate };
  }
  for (const key of Object.keys(work.ownership)) {
    const tile = tileId(Number(key));
    const deed = work.ownership[tile];
    if (!deed || deed.owner !== debtor) continue;
    if (creditor === 'bank') {
      delete work.ownership[tile]; // absent key again — unowned and undeveloped
    } else {
      work.ownership[tile] = { ...deed, owner: creditor };
    }
  }
}

/**
 * End the eliminated player's turn: finish the game when at most one
 * solvent player remains (§3.8 elimination victory; the net-worth tiebreak
 * resolves a simultaneous mutual bankruptcy), otherwise advance to the
 * next solvent player. Mirrors the core FSM's private advanceTurn.
 */
function finishOrAdvance(work: WorkingState, eliminated: PlayerId): void {
  // See module header: 'voluntary' stands in for a bankruptcy end reason.
  pushEvent(work, { type: 'TURN_ENDED', player: eliminated, reason: 'voluntary' });
  const solvent = work.players.filter(p => !p.bankrupt);
  if (solvent.length <= 1) {
    work.phase = 'finished';
    const winner = solvent.length === 1 ? solvent[0].id : victorByNetWorth(work);
    work.winner = winner;
    if (winner !== null) pushEvent(work, { type: 'GAME_FINISHED', winner });
    work.turn = { ...work.turn, state: 'turnStart', doublesRun: 0 };
    return;
  }
  let next = eliminated;
  do {
    next = playerId((next + 1) % work.players.length);
  } while (work.players[next].bankrupt);
  const held = work.players[next].jailTurnsLeft > 0;
  work.turn = { activePlayer: next, state: held ? 'turnStart' : 'awaitingRoll', doublesRun: 0 };
  pushEvent(work, { type: 'TURN_STARTED', player: next });
}

/**
 * §3.8 tiebreak: the highest net worth wins, ties broken by the lowest
 * player index — fully deterministic. Exported for direct coverage of the
 * simultaneous-mutual-bankruptcy edge case, which one-at-a-time elimination
 * cannot reach through applyAction.
 */
export function victorByNetWorth(state: GameState): PlayerId | null {
  let best: PlayerId | null = null;
  let bestWorth = Number.NEGATIVE_INFINITY;
  for (const p of state.players) {
    const worth = netWorth(p.id, state);
    if (worth > bestWorth) {
      bestWorth = worth;
      best = p.id;
    }
  }
  return best;
}
