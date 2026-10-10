// Auction lifecycle tests (spec §3.5, AC5).
//
// Every test drives the public applyAction API — table routing, sender
// checks, and the auction handlers exactly as a client would. Fixtures
// craft a state at the buy window the same way the FSM matrix tests do
// (a deep-mutable draft of a real createGame state).

import { describe, expect, it } from 'vitest';
import { createGame, applyAction, getLegalActions } from './state-machine';
import type { ApplyResult, GameAction, GameErrorCode, GameState, PlayerId, TileId, WorkingState } from './types';
import { playerId, tileId } from './types';

const NAMES3 = ['Ada', 'Bo', 'Cy'] as const;
const NAMES2 = ['Ada', 'Bo'] as const;

function editable(state: GameState): WorkingState {
  return structuredClone(state) as WorkingState;
}

/** P0 stands on unowned Midtown Docks I (tile 1, list 900 TD) at the buy window. */
function buyWindow(names: readonly string[] = NAMES3, seed = 'auction-seed'): WorkingState {
  const s = editable(createGame(seed, [...names]));
  s.players[0] = { ...s.players[0], position: tileId(1) };
  s.turn = { ...s.turn, state: 'awaitingBuy' };
  return s;
}

/** The buy window already declined: an open auction for tile 1. */
function openAuction(names: readonly string[] = NAMES3, seed = 'auction-seed'): WorkingState {
  const s = buyWindow(names, seed);
  const declined = applyAction(s, { type: 'DECLINE_BUY', player: playerId(0) });
  if (!declined.ok) throw new Error(`fixture: decline failed: ${declined.error.message}`);
  return editable(declined.state);
}

/** Apply a sequence through applyAction, returning the final state. */
function play(start: WorkingState, actions: GameAction[]): GameState {
  let state: GameState = start;
  for (const action of actions) {
    const result = applyAction(state, action);
    if (!result.ok) throw new Error(`play: ${action.type} by ${action.player} failed: ${result.error.message}`);
    state = result.state;
  }
  return state;
}

function bid(player: PlayerId, amount: number): GameAction {
  return { type: 'AUCTION_BID', player, amount };
}

function pass(player: PlayerId): GameAction {
  return { type: 'AUCTION_PASS', player };
}

function expectError(result: ApplyResult, code: GameErrorCode): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe('DECLINE_BUY opens the auction (spec §3.5)', () => {
  it('opens an auction on the offered tile with no bids and no passes', () => {
    const result = applyAction(buyWindow(), { type: 'DECLINE_BUY', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.turn.state).toBe('auction');
    expect(result.state.auction).toEqual({ tile: tileId(1), highBid: null, passed: [] });
    expect(result.state.ownership[tileId(1)]).toBeUndefined();
  });

  it('blocks the board while the auction is open', () => {
    const s = openAuction();
    expectError(applyAction(s, { type: 'END_TURN', player: playerId(0) }), 'WRONG_PHASE');
    expectError(applyAction(s, { type: 'ROLL_DICE', player: playerId(0) }), 'WRONG_PHASE');
    expectError(
      applyAction(s, { type: 'PROPOSE_TRADE', player: playerId(0), to: playerId(1), give: { cash: 0, tiles: [] }, want: { cash: 0, tiles: [] } }),
      'WRONG_PHASE',
    );
    expectError(applyAction(s, { type: 'BUY_PROPERTY', player: playerId(0) }), 'WRONG_PHASE');
  });

  it('offers bid/pass skeletons to every non-passed solvent player', () => {
    const s = openAuction();
    expect(getLegalActions(s, playerId(0))).toEqual([
      { type: 'AUCTION_BID', player: playerId(0), amount: 100 },
      { type: 'AUCTION_PASS', player: playerId(0) },
    ]);
    expect(getLegalActions(s, playerId(2))).toEqual([
      { type: 'AUCTION_BID', player: playerId(2), amount: 100 },
      { type: 'AUCTION_PASS', player: playerId(2) },
    ]);
  });
});

describe('bid rules (spec §3.5)', () => {
  it('enforces the 100 TD opening minimum and rejects non-integer bids', () => {
    const s = openAuction();
    expectError(applyAction(s, bid(playerId(1), 99)), 'INVALID_BID');
    expectError(applyAction(s, bid(playerId(1), 0)), 'INVALID_BID');
    expectError(applyAction(s, bid(playerId(1), 100.5)), 'INVALID_BID');
    expect(applyAction(s, bid(playerId(1), 100)).ok).toBe(true);
  });

  it('requires at least a 100 TD increment over the high bid', () => {
    const s = openAuction();
    const first = applyAction(s, bid(playerId(1), 100));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = editable(first.state);
    expectError(applyAction(second, bid(playerId(2), 100)), 'INVALID_BID'); // must beat the high bid
    expectError(applyAction(second, bid(playerId(2), 150)), 'INVALID_BID'); // increment below the minimum
    expectError(applyAction(second, bid(playerId(2), 199)), 'INVALID_BID'); // one short of a legal raise
    expect(applyAction(second, bid(playerId(2), 200)).ok).toBe(true); // exactly the minimum increment
  });

  it('caps bids at the bidder’s cash on hand', () => {
    const s = openAuction();
    s.players[1] = { ...s.players[1], cash: 150 };
    expectError(applyAction(s, bid(playerId(1), 200)), 'INSUFFICIENT_FUNDS');
    expect(applyAction(s, bid(playerId(1), 150)).ok).toBe(true);
  });

  it('rejects bids from players who already passed and from bankrupt players', () => {
    const s = openAuction();
    const passed = applyAction(s, pass(playerId(1)));
    expect(passed.ok).toBe(true);
    if (!passed.ok) return;
    expectError(applyAction(editable(passed.state), bid(playerId(1), 100)), 'ALREADY_PASSED');

    const dead = openAuction();
    dead.players[2] = { ...dead.players[2], bankrupt: true };
    expectError(applyAction(dead, bid(playerId(2), 100)), 'WRONG_PLAYER');
  });
});

describe('a pass is permanent (spec §3.5)', () => {
  it('records the pass and locks the player out for the rest of the auction', () => {
    const s = openAuction();
    const first = applyAction(s, pass(playerId(1)));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.auction?.passed).toEqual([playerId(1)]);
    expect(getLegalActions(first.state, playerId(1))).toEqual([]);
    expectError(applyAction(editable(first.state), pass(playerId(1))), 'ALREADY_PASSED');
    expectError(applyAction(editable(first.state), bid(playerId(1), 100)), 'ALREADY_PASSED');
  });
});

describe('settlement (spec §3.5, AC5)', () => {
  it('the last remaining bidder wins at their last bid and pays the bank', () => {
    const final = play(openAuction(), [bid(playerId(1), 100), pass(playerId(0)), pass(playerId(2))]);
    expect(final.auction).toBeNull();
    expect(final.ownership[tileId(1)]).toEqual({ owner: playerId(1), level: 0, mortgaged: false });
    expect(final.players[1].cash).toBe(12_000 - 100);
    expect(final.players[0].cash).toBe(12_000); // no salary: the auction never moved the player
    expect(final.turn.state).toBe('postRoll');
    expect(final.turn.activePlayer).toBe(playerId(0)); // the decliner's turn resumes
  });

  it('the decliner may win the auction', () => {
    const final = play(openAuction(NAMES2), [bid(playerId(1), 100), bid(playerId(0), 200), pass(playerId(1))]);
    expect(final.auction).toBeNull();
    expect(final.ownership[tileId(1)]).toEqual({ owner: playerId(0), level: 0, mortgaged: false });
    expect(final.players[0].cash).toBe(12_000 - 200);
    expect(final.turn.state).toBe('postRoll');
  });

  it('the decliner may take the property at the opening minimum once everyone else passes', () => {
    const final = play(openAuction(NAMES2), [pass(playerId(1)), bid(playerId(0), 100)]);
    expect(final.ownership[tileId(1)]).toEqual({ owner: playerId(0), level: 0, mortgaged: false });
    expect(final.players[0].cash).toBe(12_000 - 100);
  });

  it('zero bids leaves the property with the bank', () => {
    const final = play(openAuction(NAMES2), [pass(playerId(1)), pass(playerId(0))]);
    expect(final.auction).toBeNull();
    expect(final.ownership[tileId(1)]).toBeUndefined();
    expect(final.players[0].cash).toBe(12_000);
    expect(final.players[1].cash).toBe(12_000);
    expect(final.turn.state).toBe('postRoll');
  });

  it('the standing high bid wins even if the high bidder later passes', () => {
    // A bid is a commitment: passing stops further bidding, it does not
    // retract the standing bid. Nobody outbid Bo, so Bo wins at 100.
    const final = play(openAuction(), [bid(playerId(1), 100), pass(playerId(1)), pass(playerId(0)), pass(playerId(2))]);
    expect(final.ownership[tileId(1)]).toEqual({ owner: playerId(1), level: 0, mortgaged: false });
    expect(final.players[1].cash).toBe(12_000 - 100);
  });

  it('a sole remaining non-bidder still gets to open or pass', () => {
    // Bo passed; only Cy can act, and Cy has not bid — the auction continues.
    const s = openAuction(NAMES2);
    const afterPass = applyAction(s, pass(playerId(1)));
    expect(afterPass.ok).toBe(true);
    if (!afterPass.ok) return;
    expect(afterPass.state.auction).not.toBeNull();
    expect(afterPass.state.turn.state).toBe('auction');
    const won = play(editable(afterPass.state), [bid(playerId(0), 100)]);
    expect(won.ownership[tileId(1)]).toEqual({ owner: playerId(0), level: 0, mortgaged: false });
  });

  it('bankrupt players are excluded from the settlement count', () => {
    const s = openAuction();
    s.players[2] = { ...s.players[2], bankrupt: true };
    const final = play(s, [bid(playerId(1), 100), pass(playerId(0))]);
    expect(final.ownership[tileId(1)]).toEqual({ owner: playerId(1), level: 0, mortgaged: false });
    expect(final.players[1].cash).toBe(12_000 - 100);
  });
});

describe('post-auction resume (spec §3.3 + §3.5)', () => {
  /** First scanned seed whose opening roll is true doubles landing on an unowned purchasable. */
  function seedToBuyWindow(doubles: boolean): string {
    for (let i = 0; i < 500; i++) {
      const seed = `auction-resume-${doubles ? 'dbl' : 'free'}-${i}`;
      const result = applyAction(createGame(seed, [...NAMES2]), { type: 'ROLL_DICE', player: playerId(0) });
      if (!result.ok) continue;
      const rolled = result.state.log.find(e => e.type === 'DICE_ROLLED');
      if (result.state.turn.state === 'awaitingBuy' && rolled?.type === 'DICE_ROLLED' && rolled.doubles === doubles) return seed;
    }
    throw new Error(`no seed found (doubles=${doubles})`);
  }

  function declinedToAuction(seed: string): WorkingState {
    const rolled = applyAction(createGame(seed, [...NAMES2]), { type: 'ROLL_DICE', player: playerId(0) });
    if (!rolled.ok) throw new Error('fixture roll failed');
    const opened = applyAction(rolled.state, { type: 'DECLINE_BUY', player: playerId(0) });
    if (!opened.ok) throw new Error(`fixture decline failed: ${opened.error.message}`);
    return editable(opened.state);
  }

  it('resumes with the mandatory re-roll when the offered roll was doubles', () => {
    const final = play(declinedToAuction(seedToBuyWindow(true)), [bid(playerId(1), 100), pass(playerId(0))]);
    expect(final.auction).toBeNull();
    expect(final.turn.state).toBe('awaitingRoll'); // the doubles re-roll is still owed
    expect(final.turn.doublesRun).toBe(1);
  });

  it('resumes at postRoll when the offered roll was not doubles', () => {
    const final = play(declinedToAuction(seedToBuyWindow(false)), [bid(playerId(1), 100), pass(playerId(0))]);
    expect(final.auction).toBeNull();
    expect(final.turn.state).toBe('postRoll');
    expect(final.turn.doublesRun).toBe(0);
  });

  it('auctions the tile the player actually landed on', () => {
    const seed = seedToBuyWindow(false);
    const rolled = applyAction(createGame(seed, [...NAMES2]), { type: 'ROLL_DICE', player: playerId(0) });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    const landed: TileId = rolled.state.players[0].position;
    const opened = applyAction(rolled.state, { type: 'DECLINE_BUY', player: playerId(0) });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.state.auction?.tile).toBe(landed);
  });
});
