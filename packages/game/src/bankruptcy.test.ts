// Debt & bankruptcy (AC8, spec §3.7) and victory (AC9, spec §3.8): to-player
// vs to-bank settlement flows, elimination, next-solvent turn advance, and
// the deterministic net-worth tiebreak for a simultaneous mutual bankruptcy.
//
// The tiebreak branch is unreachable through applyAction (elimination is one
// player at a time, so the solvent count cannot hit zero), so
// bankruptcy.victorByNetWorth is exercised directly for AC9's edge case.

import { describe, expect, it } from 'vitest';

import * as bankruptcy from './bankruptcy';
import { createGame, applyAction, getLegalActions } from './state-machine';
import type { GameState, PlayerId, WorkingState } from './types';
import { playerId, tileId } from './types';

const NAMES = ['Ada', 'Bo', 'Cy'] as const;

function editable(state: GameState): WorkingState {
  return structuredClone(state) as WorkingState;
}

/**
 * A debt state: `debtor` owes `creditor` `amount`, and may hold assets. The
 * working copy is returned as a plain state so applyAction runs the real
 * production path (FSM debt row → bankruptcy handler).
 */
function debtState(
  debtor: PlayerId,
  creditor: PlayerId | 'bank',
  mutate?: (work: WorkingState) => void,
): GameState {
  const work = editable(createGame('bankruptcy-fixture-seed', [...NAMES]));
  work.turn = { activePlayer: debtor, state: 'debt', doublesRun: 0 };
  work.debt = { debtor, creditor, amount: 5_000 };
  mutate?.(work);
  return work as GameState;
}

const declare = (pid: PlayerId) => ({ type: 'DECLARE_BANKRUPTCY', player: pid }) as const;

describe('bankruptcy settlement (AC8, spec §3.7)', () => {
  it('to a player-creditor: cash, properties, mortgages and levels transfer as-is', () => {
    const s = debtState(playerId(0), playerId(1), (work) => {
      work.players[0] = { ...work.players[0], cash: 300 };
      work.ownership[tileId(1)] = { owner: playerId(0), level: 2, mortgaged: true };
      work.ownership[tileId(5)] = { owner: playerId(0), level: 0, mortgaged: false };
    });

    const result = applyAction(s, declare(playerId(0)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = result.state;

    expect(after.players[0]).toMatchObject({ cash: 0, bankrupt: true });
    expect(after.players[1].cash).toBe(12_300); // 12,000 + the 300 estate
    // As-is: the mortgage stays attached, the level rides along.
    expect(after.ownership[tileId(1)]).toEqual({ owner: playerId(1), level: 2, mortgaged: true });
    expect(after.ownership[tileId(5)]).toEqual({ owner: playerId(1), level: 0, mortgaged: false });
    expect(after.debt).toBeNull();
  });

  it('to the bank: properties return unowned and undeveloped', () => {
    const s = debtState(playerId(0), 'bank', (work) => {
      work.players[0] = { ...work.players[0], cash: 300 };
      work.ownership[tileId(1)] = { owner: playerId(0), level: 3, mortgaged: true };
      work.ownership[tileId(5)] = { owner: playerId(0), level: 0, mortgaged: false };
    });

    const result = applyAction(s, declare(playerId(0)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = result.state;

    expect(after.players[0]).toMatchObject({ cash: 0, bankrupt: true });
    expect(after.ownership[tileId(1)]).toBeUndefined(); // unowned, level gone
    expect(after.ownership[tileId(5)]).toBeUndefined();
    expect(after.players[1].cash).toBe(12_000); // the estate went to the bank
    expect(after.debt).toBeNull();
  });

  it('elimination ends the turn and advances to the next solvent player', () => {
    const s = debtState(playerId(0), 'bank');
    const result = applyAction(s, declare(playerId(0)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = result.state;

    expect(after.turn.activePlayer).toBe(playerId(1));
    expect(after.turn.state).toBe('awaitingRoll');
    expect(after.turn.doublesRun).toBe(0);
    expect(after.phase).toBe('active'); // two solvent players remain
    const events = after.log.map(e => e.type);
    expect(events).toContain('TURN_ENDED');
    expect(events).toContain('TURN_STARTED');
    expect(events).not.toContain('GAME_FINISHED');
  });

  it('eliminating a middle player skips forward to the next solvent seat', () => {
    const s = debtState(playerId(1), 'bank');
    const result = applyAction(s, declare(playerId(1)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.turn.activePlayer).toBe(playerId(2));
    expect(result.state.players[1].bankrupt).toBe(true);
  });

  it('a held successor starts their turn at turnStart (the jail window)', () => {
    const s = debtState(playerId(1), 'bank', (work) => {
      work.players[2] = { ...work.players[2], jailTurnsLeft: 2 };
    });
    const result = applyAction(s, declare(playerId(1)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.turn.activePlayer).toBe(playerId(2));
    expect(result.state.turn.state).toBe('turnStart');
  });

  it('rejects a declaration from a player who is not active, leaving state untouched', () => {
    const s = debtState(playerId(0), 'bank');
    const before = structuredClone(s);
    const result = applyAction(s, declare(playerId(1)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('WRONG_PLAYER');
    expect(s).toEqual(before);
  });

  it('guards against a debt window with no outstanding record (engine-invariant)', () => {
    const work = editable(createGame('no-debt-seed', [...NAMES]));
    work.turn = { ...work.turn, state: 'debt' };
    work.debt = null;
    const result = bankruptcy.declareBankruptcy(work, { type: 'DECLARE_BANKRUPTCY', player: playerId(0) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERNAL');
  });

  it('the debt-restricted action set stays exactly the liquidation toolkit', () => {
    // The FSM gates debt to SELL_LEVEL, MORTGAGE, DECLARE_BANKRUPTCY —
    // already asserted by the matrix; here the bridge case: the action set
    // the debtor sees matches the routing so a settlement is always
    // reachable without leaving the debt state.
    const s = debtState(playerId(0), 'bank');
    expect(getLegalActions(s, playerId(0)).map(a => a.type)).toEqual([
      'SELL_LEVEL',
      'MORTGAGE',
      'DECLARE_BANKRUPTCY',
    ]);
  });
});

describe('victory (AC9, spec §3.8)', () => {
  it('a two-player elimination finishes the game and crowns the survivor', () => {
    const work = editable(createGame('duel-seed', ['Ada', 'Bo']));
    work.turn = { activePlayer: playerId(0), state: 'debt', doublesRun: 0 };
    work.debt = { debtor: playerId(0), creditor: 'bank', amount: 5_000 };

    const result = applyAction(work as GameState, declare(playerId(0)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = result.state;

    expect(after.phase).toBe('finished');
    expect(after.winner).toBe(playerId(1));
    const finished = after.log.find(e => e.type === 'GAME_FINISHED');
    expect(finished && finished.type === 'GAME_FINISHED' ? finished.winner : null).toBe(playerId(1));
    expect(getLegalActions(after, playerId(1))).toEqual([]);
  });

  it('a two-player estate transfer crowns the player-creditor', () => {
    const work = editable(createGame('duel-estate-seed', ['Ada', 'Bo']));
    work.turn = { activePlayer: playerId(0), state: 'debt', doublesRun: 0 };
    work.debt = { debtor: playerId(0), creditor: playerId(1), amount: 9_000 };
    work.ownership[tileId(1)] = { owner: playerId(0), level: 2, mortgaged: false };

    const result = applyAction(work as GameState, declare(playerId(0)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phase).toBe('finished');
    expect(result.state.winner).toBe(playerId(1));
    expect(result.state.ownership[tileId(1)]?.owner).toBe(playerId(1)); // the estate landed first
  });

  it('the §3.8 tiebreak: highest net worth wins, ties break to the lowest index', () => {
    const work = editable(createGame('tiebreak-seed', [...NAMES]));
    work.players[0] = { ...work.players[0], cash: 100, bankrupt: true };
    work.players[1] = { ...work.players[1], cash: 500, bankrupt: true };
    work.players[2] = { ...work.players[2], cash: 100, bankrupt: true };
    expect(bankruptcy.victorByNetWorth(work)).toBe(playerId(1));

    work.players[1] = { ...work.players[1], cash: 100 }; // three-way tie
    expect(bankruptcy.victorByNetWorth(work)).toBe(playerId(0)); // lowest index

    // Property out-weighs cash: a 900 TD deed beats 500 TD.
    work.players[2] = { ...work.players[2], cash: 0 };
    work.ownership[tileId(1)] = { owner: playerId(2), level: 0, mortgaged: false };
    expect(bankruptcy.victorByNetWorth(work)).toBe(playerId(2));
  });
});
