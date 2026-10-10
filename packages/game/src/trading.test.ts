// Trading lifecycle tests (spec §3.6, AC6).
//
// Trades exist only inside the active player's `awaitingRoll`/`postRoll`
// windows; the offeree accepts or declines while the offering player is
// still active; an accepted trade executes atomically after re-validating
// ownership and cash. Fixtures craft states the same way the FSM matrix
// tests do (a deep-mutable draft of a real createGame state).

import { describe, expect, it } from 'vitest';
import { createGame, applyAction, getLegalActions } from './state-machine';
import type {
  ApplyResult,
  GameAction,
  GameErrorCode,
  GameState,
  PlayerId,
  TileId,
  TradeLeg,
  WorkingState,
} from './types';
import { playerId, tileId } from './types';

const NAMES2 = ['Ada', 'Bo'] as const;

function editable(state: GameState): WorkingState {
  return structuredClone(state) as WorkingState;
}

/** The active player (P0) has rolled and stands on Grand Plaza (safe, tile 19). */
function postRoll(names: readonly string[] = NAMES2, seed = 'trading-seed'): WorkingState {
  const s = editable(createGame(seed, [...names]));
  s.players[0] = { ...s.players[0], position: tileId(19) };
  s.turn = { ...s.turn, state: 'postRoll' };
  return s;
}

function awaitingRoll(names: readonly string[] = NAMES2, seed = 'trading-seed'): WorkingState {
  const s = postRoll(names, seed);
  s.turn = { ...s.turn, state: 'awaitingRoll' };
  return s;
}

/** Grant an ownership entry exactly as play would have created it. */
function grant(s: WorkingState, tile: TileId, owner: PlayerId, level: 0 | 1 | 2 | 3 | 4 | 5 = 0, mortgaged = false): void {
  s.ownership[tile] = { owner, level, mortgaged };
}

function propose(from: PlayerId, to: PlayerId, give: TradeLeg, want: TradeLeg): GameAction {
  return { type: 'PROPOSE_TRADE', player: from, to, give, want };
}

const LEG_EMPTY: TradeLeg = { cash: 0, tiles: [] };

function expectError(result: ApplyResult, code: GameErrorCode): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

function play(start: WorkingState, actions: GameAction[]): GameState {
  let state: GameState = start;
  for (const action of actions) {
    const result = applyAction(state, action);
    if (!result.ok) throw new Error(`play: ${action.type} by ${action.player} failed: ${result.error.message}`);
    state = result.state;
  }
  return state;
}

describe('PROPOSE_TRADE windows (spec §3.6)', () => {
  it('the active player may propose during postRoll and awaitingRoll', () => {
    for (const fixture of [postRoll(), awaitingRoll()]) {
      const result = applyAction(fixture, propose(playerId(0), playerId(1), { cash: 100, tiles: [] }, LEG_EMPTY));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.state.pendingTrade).toEqual({
        from: playerId(0),
        to: playerId(1),
        give: { cash: 100, tiles: [] },
        want: { cash: 0, tiles: [] },
      });
    }
  });

  it('is rejected outside the trade windows (awaitingBuy has no route)', () => {
    const s = postRoll();
    s.players[0] = { ...s.players[0], position: tileId(1) }; // unowned Midtown Docks I
    s.turn = { ...s.turn, state: 'awaitingBuy' };
    expectError(applyAction(s, propose(playerId(0), playerId(1), LEG_EMPTY, LEG_EMPTY)), 'WRONG_PHASE');
  });

  it('is rejected from a non-active player', () => {
    const s = postRoll();
    expectError(applyAction(s, propose(playerId(1), playerId(0), LEG_EMPTY, LEG_EMPTY)), 'WRONG_PLAYER');
  });

  it('requires a solvent counterparty other than the proposer', () => {
    const s = postRoll();
    expectError(applyAction(s, propose(playerId(0), playerId(0), LEG_EMPTY, LEG_EMPTY)), 'WRONG_PLAYER');
    const dead = postRoll();
    dead.players[1] = { ...dead.players[1], bankrupt: true };
    expectError(applyAction(dead, propose(playerId(0), playerId(1), LEG_EMPTY, LEG_EMPTY)), 'WRONG_PLAYER');
  });
});

describe('PROPOSE_TRADE validation (spec §3.6)', () => {
  it('rejects legs naming tiles the holder does not own', () => {
    const s = postRoll();
    grant(s, tileId(4), playerId(0));
    expectError(applyAction(s, propose(playerId(0), playerId(1), { cash: 0, tiles: [tileId(6)] }, LEG_EMPTY)), 'INVALID_TILE');
    expectError(applyAction(s, propose(playerId(0), playerId(1), LEG_EMPTY, { cash: 0, tiles: [tileId(4)] })), 'INVALID_TILE');
  });

  it('rejects non-property tiles in a leg', () => {
    const s = postRoll();
    expectError(applyAction(s, propose(playerId(0), playerId(1), { cash: 0, tiles: [tileId(3)] }, LEG_EMPTY)), 'INVALID_TILE'); // Harbor Plaza (rest)
  });

  it('rejects duplicate tiles within one leg', () => {
    const s = postRoll();
    grant(s, tileId(4), playerId(0));
    expectError(
      applyAction(s, propose(playerId(0), playerId(1), { cash: 0, tiles: [tileId(4), tileId(4)] }, LEG_EMPTY)),
      'INVALID_TILE',
    );
  });

  it('rejects negative and fractional cash offers', () => {
    const s = postRoll();
    expectError(applyAction(s, propose(playerId(0), playerId(1), { cash: -1, tiles: [] }, LEG_EMPTY)), 'INVALID_BID');
    expectError(applyAction(s, propose(playerId(0), playerId(1), { cash: 10.5, tiles: [] }, LEG_EMPTY)), 'INVALID_BID');
    expectError(applyAction(s, propose(playerId(0), playerId(1), LEG_EMPTY, { cash: -5, tiles: [] })), 'INVALID_BID');
  });

  it('rejects cash the holder cannot pay', () => {
    const s = postRoll();
    expectError(applyAction(s, propose(playerId(0), playerId(1), { cash: 12_001, tiles: [] }, LEG_EMPTY)), 'INSUFFICIENT_FUNDS');
    expectError(applyAction(s, propose(playerId(0), playerId(1), LEG_EMPTY, { cash: 12_001, tiles: [] })), 'INSUFFICIENT_FUNDS');
  });
});

describe('counters are new proposals (spec §3.6 lifecycle)', () => {
  it('a second proposal supersedes the pending one and acceptance applies the new terms', () => {
    const s = postRoll();
    grant(s, tileId(4), playerId(0));
    grant(s, tileId(6), playerId(1));
    const first = applyAction(s, propose(playerId(0), playerId(1), { cash: 1000, tiles: [tileId(4)] }, LEG_EMPTY));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const revised = applyAction(editable(first.state), propose(playerId(0), playerId(1), { cash: 1200, tiles: [tileId(4)] }, LEG_EMPTY));
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.state.pendingTrade?.give.cash).toBe(1200); // one pending offer at a time
    const accepted = applyAction(editable(revised.state), { type: 'ACCEPT_TRADE', player: playerId(1) });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.state.players[0].cash).toBe(12_000 - 1200); // the revised terms executed
    expect(accepted.state.pendingTrade).toBeNull();
  });
});

describe('ACCEPT_TRADE atomic execution (spec §3.6, AC6)', () => {
  it('swaps cash and properties in one move, levels and mortgages attached', () => {
    const s = postRoll();
    grant(s, tileId(4), playerId(0), 2, true); // Lantern Quarter I: level 2, mortgaged
    grant(s, tileId(6), playerId(1));
    grant(s, tileId(7), playerId(1));
    const final = play(s, [
      propose(playerId(0), playerId(1), { cash: 1000, tiles: [tileId(4)] }, { cash: 500, tiles: [tileId(6), tileId(7)] }),
      { type: 'ACCEPT_TRADE', player: playerId(1) },
    ]);
    // Cash moved exactly once per side; TD conserved.
    expect(final.players[0].cash).toBe(12_000 - 1000 + 500);
    expect(final.players[1].cash).toBe(12_000 - 500 + 1000);
    expect(final.players[0].cash + final.players[1].cash).toBe(24_000);
    // Properties crossed with their development state attached.
    expect(final.ownership[tileId(4)]).toEqual({ owner: playerId(1), level: 2, mortgaged: true });
    expect(final.ownership[tileId(6)]).toEqual({ owner: playerId(0), level: 0, mortgaged: false });
    expect(final.ownership[tileId(7)]).toEqual({ owner: playerId(0), level: 0, mortgaged: false });
    expect(final.pendingTrade).toBeNull();
  });

  it('re-validates the offeror’s cash at acceptance and transfers nothing on failure', () => {
    const s = postRoll();
    grant(s, tileId(4), playerId(0));
    grant(s, tileId(6), playerId(1));
    const proposed = applyAction(s, propose(playerId(0), playerId(1), { cash: 1000, tiles: [tileId(4)] }, LEG_EMPTY));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    // Simulate intervening play that drained the offeror below their offer
    // (rent to a third player, in a real game). Acceptance must re-validate.
    const drained = editable(proposed.state);
    drained.players[0] = { ...drained.players[0], cash: 999 };
    expectError(applyAction(drained, { type: 'ACCEPT_TRADE', player: playerId(1) }), 'INSUFFICIENT_FUNDS');
    // Nothing moved: the failed accept is atomic and the offer stays pending.
    expect(drained.players[0].cash).toBe(999);
    expect(drained.ownership[tileId(4)]?.owner).toBe(playerId(0));
    expect(drained.ownership[tileId(6)]?.owner).toBe(playerId(1));
    expect(drained.pendingTrade?.give.cash).toBe(1000);
  });

  it('re-validates ownership at acceptance and transfers nothing on failure', () => {
    const s = postRoll();
    grant(s, tileId(4), playerId(0));
    grant(s, tileId(6), playerId(1));
    const proposed = applyAction(s, propose(playerId(0), playerId(1), { cash: 1000, tiles: [tileId(4)] }, LEG_EMPTY));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    // The offered property changed hands after the proposal was made.
    const moved = editable(proposed.state);
    moved.ownership[tileId(4)] = { owner: playerId(1), level: 0, mortgaged: false };
    expectError(applyAction(moved, { type: 'ACCEPT_TRADE', player: playerId(1) }), 'INVALID_TILE');
    expect(moved.players[0].cash).toBe(12_000);
    expect(moved.players[1].cash).toBe(12_000);
  });

  it('is rejected for a non-offeree and when nothing is pending', () => {
    const s = postRoll();
    grant(s, tileId(4), playerId(0));
    expectError(applyAction(s, { type: 'ACCEPT_TRADE', player: playerId(1) }), 'NO_PENDING_TRADE');
    const proposed = applyAction(s, propose(playerId(0), playerId(1), LEG_EMPTY, LEG_EMPTY));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expectError(applyAction(editable(proposed.state), { type: 'ACCEPT_TRADE', player: playerId(0) }), 'WRONG_PLAYER');
  });
});

describe('DECLINE_TRADE (spec §3.6)', () => {
  it('drops the offer without moving anything', () => {
    const s = postRoll();
    grant(s, tileId(4), playerId(0));
    grant(s, tileId(6), playerId(1));
    const final = play(s, [
      propose(playerId(0), playerId(1), { cash: 1000, tiles: [tileId(4)] }, { cash: 0, tiles: [tileId(6)] }),
      { type: 'DECLINE_TRADE', player: playerId(1) },
    ]);
    expect(final.pendingTrade).toBeNull();
    expect(final.ownership[tileId(4)]).toEqual({ owner: playerId(0), level: 0, mortgaged: false });
    expect(final.ownership[tileId(6)]).toEqual({ owner: playerId(1), level: 0, mortgaged: false });
    expect(final.players[0].cash).toBe(12_000);
    expect(final.players[1].cash).toBe(12_000);
  });

  it('is rejected from a non-offeree', () => {
    const s = postRoll();
    const proposed = applyAction(s, propose(playerId(0), playerId(1), LEG_EMPTY, LEG_EMPTY));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expectError(applyAction(editable(proposed.state), { type: 'DECLINE_TRADE', player: playerId(0) }), 'WRONG_PLAYER');
  });
});

describe('expiry — a pending trade dies with the offering turn (spec §3.6)', () => {
  it('neither accept nor decline works once the offering turn has ended', () => {
    const s = postRoll();
    grant(s, tileId(4), playerId(0));
    grant(s, tileId(6), playerId(1));
    const proposed = applyAction(s, propose(playerId(0), playerId(1), { cash: 1000, tiles: [tileId(4)] }, { cash: 0, tiles: [tileId(6)] }));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const ended = play(editable(proposed.state), [{ type: 'END_TURN', player: playerId(0) }]);
    expect(ended.turn.activePlayer).toBe(playerId(1)); // the offer is stale: its offeror is no longer active
    expectError(applyAction(editable(ended), { type: 'ACCEPT_TRADE', player: playerId(1) }), 'NO_PENDING_TRADE');
    expectError(applyAction(editable(ended), { type: 'DECLINE_TRADE', player: playerId(1) }), 'NO_PENDING_TRADE');
    // Nothing executed: the properties did not cross.
    expect(ended.ownership[tileId(4)]).toEqual({ owner: playerId(0), level: 0, mortgaged: false });
    expect(ended.players[0].cash).toBe(12_000);
  });
});

describe('getLegalActions for trades (spec §3.6)', () => {
  it('the offeree sees accept/decline skeletons while the offeror is active', () => {
    const s = postRoll();
    expect(getLegalActions(s, playerId(1))).toEqual([]); // nothing pending yet
    const proposed = applyAction(s, propose(playerId(0), playerId(1), LEG_EMPTY, LEG_EMPTY));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(getLegalActions(proposed.state, playerId(1))).toEqual([
      { type: 'ACCEPT_TRADE', player: playerId(1) },
      { type: 'DECLINE_TRADE', player: playerId(1) },
    ]);
    expect(getLegalActions(proposed.state, playerId(0))).not.toContainEqual({ type: 'ACCEPT_TRADE', player: playerId(0) });
  });

  // Seam note (reported, not patched — shared file): the core's
  // getLegalActions offers accept/decline skeletons whenever pendingTrade
  // is set and the turn is in a trade window. advanceTurn never clears the
  // offer at turn end, so right after expiry it still advertises skeletons
  // for an offer applyAction (correctly) rejects with NO_PENDING_TRADE.
  // When the core clears pendingTrade on turn end — the follow-up recorded
  // in /home/user/reasoning/todo_PvnI1sj0.md — that false positive
  // disappears and an assertion like
  //   getLegalActions(ended, offeree)).toEqual([])
  // becomes true without any change here.
});
