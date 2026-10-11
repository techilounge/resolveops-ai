// End-to-end integration: auctions and trading inside real play (AC5/AC6).
//
// Unlike the colocated lifecycle tests, these drive real seeded movement —
// no fixture surgery on positions or ownership — so the modules are proven
// against the actual roll → buy-offer → auction → resume seam, the
// postRoll → propose → accept/expire seam, and the determinism contract
// over a script that uses both.

import { describe, expect, it } from 'vitest';
import { createGame, applyAction } from './state-machine';
import { stateHash } from './engine';
import type { GameState, WorkingState } from './types';
import { playerId, tileId } from './types';

const NAMES = ['Ada', 'Bo'] as const;

/** First scanned seed whose opening roll lands on an unowned purchasable. */
function seedToBuyWindow(doubles: boolean): string {
  for (let i = 0; i < 500; i++) {
    const seed = `e2e-buy-${doubles ? 'dbl' : 'free'}-${i}`;
    const result = applyAction(createGame(seed, [...NAMES]), { type: 'ROLL_DICE', player: playerId(0) });
    if (!result.ok) continue;
    const rolled = result.state.log.find(e => e.type === 'DICE_ROLLED');
    if (result.state.turn.state === 'awaitingBuy' && rolled?.type === 'DICE_ROLLED' && rolled.doubles === doubles) return seed;
  }
  throw new Error(`no seed found (doubles=${doubles})`);
}

function play(state: GameState, actions: Parameters<typeof applyAction>[1][]): GameState {
  let current = state;
  for (const action of actions) {
    const result = applyAction(current, action);
    if (!result.ok) throw new Error(`play: ${action.type} failed: ${result.error.message}`);
    current = result.state;
  }
  return current;
}

/** Total TD in circulation — the conservation invariant (spec §4). */
function cashInCirculation(state: GameState): number {
  return state.players.reduce((sum, p) => sum + p.cash, 0);
}

/** The log is strictly append-only: seq numbers are 0..n-1 in order. */
function expectAppendOnly(state: GameState): void {
  state.log.forEach((event, i) => {
    expect(event.seq).toBe(i);
  });
}

describe('auctions inside real play (spec §3.5)', () => {
  it('a declined buy offer auctions the landed tile; the winner pays and play resumes', () => {
    const seed = seedToBuyWindow(false);
    const rolled = applyAction(createGame(seed, [...NAMES]), { type: 'ROLL_DICE', player: playerId(0) });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    const landed: number = rolled.state.players[0].position;
    const opened = applyAction(rolled.state, { type: 'DECLINE_BUY', player: playerId(0) });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const final = play(opened.state, [
      { type: 'AUCTION_BID', player: playerId(1), amount: 100 },
      { type: 'AUCTION_PASS', player: playerId(0) },
    ]);
    expect(final.auction).toBeNull();
    expect(final.ownership[tileId(landed)]).toEqual({ owner: playerId(1), level: 0, mortgaged: false });
    expect(final.players[1].cash).toBe(12_000 - 100);
    expect(final.players[0].cash).toBe(12_000);
    expect(cashInCirculation(final)).toBe(24_000 - 100); // the winning bid went to the bank
    expect(final.turn.state).toBe('postRoll');
    expect(final.turn.activePlayer).toBe(playerId(0));
    expectAppendOnly(final);
  });
});

describe('trading inside real play (spec §3.6)', () => {
  it('a live offer is accepted; after the offering turn ends the stale one is refused', () => {
    const seed = seedToBuyWindow(false);
    const rolled = applyAction(createGame(seed, [...NAMES]), { type: 'ROLL_DICE', player: playerId(0) });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    const opened = applyAction(rolled.state, { type: 'DECLINE_BUY', player: playerId(0) });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const afterAuction = play(opened.state, [
      { type: 'AUCTION_BID', player: playerId(1), amount: 100 },
      { type: 'AUCTION_PASS', player: playerId(0) },
    ]);
    // Live offer: P0 (still active, postRoll) proposes; P1 accepts.
    const offered = applyAction(afterAuction, {
      type: 'PROPOSE_TRADE', player: playerId(0), to: playerId(1),
      give: { cash: 200, tiles: [] }, want: { cash: 0, tiles: [] },
    });
    expect(offered.ok).toBe(true);
    if (!offered.ok) return;
    const accepted = applyAction(offered.state, { type: 'ACCEPT_TRADE', player: playerId(1) });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.state.players[0].cash).toBe(12_000 - 200); // the give leg moved once
    // Stale offer: the same proposal made again dies with the turn.
    const reoffered = applyAction(accepted.state, {
      type: 'PROPOSE_TRADE', player: playerId(0), to: playerId(1),
      give: { cash: 200, tiles: [] }, want: { cash: 0, tiles: [] },
    });
    expect(reoffered.ok).toBe(true);
    if (!reoffered.ok) return;
    const ended = play(reoffered.state, [{ type: 'END_TURN', player: playerId(0) }]);
    expect(ended.turn.activePlayer).toBe(playerId(1));
    const stale = applyAction(ended, { type: 'ACCEPT_TRADE', player: playerId(1) });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('NO_PENDING_TRADE');
    expect(cashInCirculation(ended)).toBe(24_000 - 100); // auction payment to the bank only
    expectAppendOnly(ended);
  });
});

describe('determinism across an auction + trade script (spec §3.9)', () => {
  it('the same seed and script reproduce a byte-identical state hash', () => {
    const seed = seedToBuyWindow(false);
    const script: Parameters<typeof applyAction>[1][] = [
      { type: 'ROLL_DICE', player: playerId(0) },
      { type: 'DECLINE_BUY', player: playerId(0) },
      { type: 'AUCTION_BID', player: playerId(1), amount: 100 },
      { type: 'AUCTION_PASS', player: playerId(0) },
      { type: 'PROPOSE_TRADE', player: playerId(0), to: playerId(1), give: { cash: 200, tiles: [] }, want: { cash: 0, tiles: [] } },
      { type: 'ACCEPT_TRADE', player: playerId(1) },
    ];
    const run = (): string => stateHash(play(createGame(seed, [...NAMES]), script));
    expect(run()).toBe(run());
    // The hash is stable under JSON round-trip (canonical-JSON contract).
    const final = play(createGame(seed, [...NAMES]), script);
    const roundTrip = JSON.parse(JSON.stringify(final)) as GameState;
    expect(stateHash(roundTrip)).toBe(stateHash(final));
    expect(cashInCirculation(final)).toBe(24_000 - 100);
  });
});
