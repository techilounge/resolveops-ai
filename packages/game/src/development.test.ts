// Development rules (AC7, spec §3.4): even-build enforcement, full-set and
// no-mortgage preconditions, scarcity pools with unit return, 50% sell-back,
// mortgage economics — plus the debt liquidation settlement (spec §3.7),
// which rides on the two cash-raising moves.
//
// Expected numbers are re-typed from docs/RULES.md §3.2/§3.4 (and the
// mortgage worked examples from the economy tests) so the board tables
// cannot grade their own homework.

import { describe, expect, it } from 'vitest';

import { DISTRICT_GROUPS } from './board';
import { mortgageLiftCost, mortgageValue } from './economy';
import * as development from './development';
import { createGame } from './state-machine';
import type { DevelopmentLevel, GameState, GroupId, WorkingState } from './types';
import { playerId, tileId } from './types';

const NAMES = ['Ada', 'Bo', 'Cy'] as const;

function editable(state: GameState): WorkingState {
  return structuredClone(state) as WorkingState;
}

type GroupFixtureOptions = {
  /** Level per group tile, in board.ts order. */
  levels?: number[];
  /** Mortgaged flag per group tile, in board.ts order. */
  mortgaged?: boolean[];
  /** p0's cash (default: starting 12,000). */
  cash?: number;
};

/**
 * A postRoll state where p0 owns every district of `groupId` (cash and
 * levels configurable). Handlers run on the working copy directly — the
 * FSM's routing of these cells is covered by the matrix test.
 */
function ownedGroup(groupId: GroupId, opts: GroupFixtureOptions = {}): WorkingState {
  const work = editable(createGame('development-fixture-seed', [...NAMES]));
  work.turn = { ...work.turn, state: 'postRoll' };
  DISTRICT_GROUPS[groupId].tiles.forEach((t, i) => {
    work.ownership[t] = {
      owner: playerId(0),
      level: (opts.levels?.[i] ?? 0) as DevelopmentLevel,
      mortgaged: opts.mortgaged?.[i] ?? false,
    };
  });
  if (opts.cash !== undefined) work.players[0] = { ...work.players[0], cash: opts.cash };
  return work;
}

/** Districts spread across G1–G4 embodying exactly the 40-unit permit stock. */
function permitPoolDrained(): WorkingState {
  const work = editable(createGame('pool-fixture-seed', [...NAMES]));
  work.turn = { ...work.turn, state: 'postRoll' };
  const layout: ReadonlyArray<readonly [GroupId, readonly number[]]> = [
    ['G1', [4, 4]], // 8 units
    ['G2', [4, 4, 4]], // 12
    ['G3', [4, 4, 4]], // 12
    ['G4', [3, 3, 2]], // 8  → 40 total
  ];
  for (const [groupId, levels] of layout) {
    DISTRICT_GROUPS[groupId].tiles.forEach((t, i) => {
      work.ownership[t] = { owner: playerId(0), level: levels[i] as DevelopmentLevel, mortgaged: false };
    });
  }
  work.players[0] = { ...work.players[0], cash: 50_000 };
  return work;
}

/** Eight standing landmarks with the permit stock exactly at 40 again. */
function landmarkPoolDrained(): WorkingState {
  const work = editable(createGame('landmark-pool-fixture-seed', [...NAMES]));
  work.turn = { ...work.turn, state: 'postRoll' };
  const landmarkTiles: ReadonlyArray<readonly number[]> = [
    [1, 2], // G1 both
    [4, 6, 7], // G2 all three
    [9], // G3 first
    [15], // G4 first
    [20], // G5 first
  ];
  for (const tiles of landmarkTiles) {
    for (const t of tiles) {
      work.ownership[tileId(t)] = { owner: playerId(0), level: 5, mortgaged: false };
    }
  }
  // G8 stands at [4,4]: even-build legal, landmark attempt pending.
  work.ownership[tileId(36)] = { owner: playerId(0), level: 4, mortgaged: false };
  work.ownership[tileId(38)] = { owner: playerId(0), level: 4, mortgaged: false };
  work.players[0] = { ...work.players[0], cash: 50_000 };
  return work;
}

function build(tile: number) {
  return { type: 'BUILD_LEVEL', player: playerId(0), tile: tileId(tile) } as const;
}
function sell(tile: number) {
  return { type: 'SELL_LEVEL', player: playerId(0), tile: tileId(tile) } as const;
}
function mortgage(tile: number) {
  return { type: 'MORTGAGE', player: playerId(0), tile: tileId(tile) } as const;
}
function lift(tile: number) {
  return { type: 'LIFT_MORTGAGE', player: playerId(0), tile: tileId(tile) } as const;
}

describe('BUILD_LEVEL (spec §3.4)', () => {
  it('builds a permit for the group permit cost and spends the bank stock', () => {
    const work = ownedGroup('G1');
    const result = development.buildLevel(work, build(1));
    expect(result.ok).toBe(true);
    expect(work.players[0].cash).toBe(11_600); // 12,000 − 400
    expect(work.ownership[tileId(1)]?.level).toBe(1);
    expect(development.permitUnitsInCirculation(work.ownership)).toBe(1);
    expect(development.permitUnitsRemaining(work.ownership)).toBe(39);
  });

  it('even-build: the group minimum may rise, and only it', () => {
    const work = ownedGroup('G2', { levels: [1, 2, 2] }); // tiles 4, 6, 7
    const reject = development.buildLevel(work, build(6)); // level 2 ≠ min 1
    expect(reject.ok).toBe(false);
    if (!reject.ok) expect(reject.error.code).toBe('INVALID_TILE');

    const raised = development.buildLevel(work, build(4)); // level 1 = min
    expect(raised.ok).toBe(true);
    expect(work.ownership[tileId(4)]?.level).toBe(2); // group now [2, 2, 2]
  });

  it('requires holding every district of the colour group', () => {
    const work = ownedGroup('G1');
    delete work.ownership[tileId(2)]; // p0 keeps only tile 1
    const result = development.buildLevel(work, build(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
  });

  it('a mortgaged district in the group blocks development', () => {
    const work = ownedGroup('G1', { mortgaged: [false, true] });
    const result = development.buildLevel(work, build(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
  });

  it('rejects a second landmark on a fully-built district', () => {
    const work = ownedGroup('G1', { levels: [5, 5] });
    const result = development.buildLevel(work, build(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
  });

  it('rejects building when cash cannot cover the permit cost', () => {
    const work = ownedGroup('G1', { cash: 399 });
    const result = development.buildLevel(work, build(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(work.ownership[tileId(1)]?.level).toBe(0); // untouched on failure
  });

  it('rejects building on a tile the active player does not own', () => {
    const work = ownedGroup('G1');
    work.ownership[tileId(1)] = { owner: playerId(1), level: 0, mortgaged: false };
    const result = development.buildLevel(work, build(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
  });

  it('rejects building on a non-district property', () => {
    const work = ownedGroup('G1');
    const result = development.buildLevel(work, build(5)); // North Depot, transit
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
  });

  it('rejects actions from a player who is not active', () => {
    const work = ownedGroup('G1');
    const result = development.buildLevel(work, { type: 'BUILD_LEVEL', player: playerId(1), tile: tileId(1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('WRONG_PLAYER');
  });
});

describe('landmark builds and the scarcity pools (spec §3.4)', () => {
  it('a landmark build costs no cash, consumes a landmark unit, and returns the four permits', () => {
    const work = ownedGroup('G1', { levels: [4, 4] });
    expect(development.permitUnitsInCirculation(work.ownership)).toBe(8);
    const result = development.buildLevel(work, build(1));
    expect(result.ok).toBe(true);
    expect(work.ownership[tileId(1)]?.level).toBe(5);
    expect(work.players[0].cash).toBe(12_000); // the four permits already embody the investment
    expect(development.landmarkUnitsInCirculation(work.ownership)).toBe(1);
    expect(development.landmarkUnitsRemaining(work.ownership)).toBe(7);
    expect(development.permitUnitsInCirculation(work.ownership)).toBe(8); // unchanged
  });

  it('a landmark build succeeds even with the permit stock at zero', () => {
    const work = permitPoolDrained(); // exactly 40 permits embodied
    expect(development.permitUnitsRemaining(work.ownership)).toBe(0);
    const result = development.buildLevel(work, build(1)); // G1 at [4,4] → landmark
    expect(result.ok).toBe(true);
    expect(work.ownership[tileId(1)]?.level).toBe(5);
  });

  it('permit pool exhaustion blocks the next permit build', () => {
    const work = permitPoolDrained();
    const result = development.buildLevel(work, build(18)); // G4 minimum at [3,3,2]
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
    expect(work.ownership[tileId(18)]?.level).toBe(2);
  });

  it('landmark pool exhaustion (8 standing) blocks the ninth landmark', () => {
    const work = landmarkPoolDrained();
    expect(development.landmarkUnitsRemaining(work.ownership)).toBe(0);
    const result = development.buildLevel(work, build(36)); // G8 at [4,4] → would be the ninth
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
    expect(work.ownership[tileId(36)]?.level).toBe(4);
  });
});

describe('SELL_LEVEL (spec §3.4)', () => {
  it('sells the group maximum for half of one permit cost; the unit returns to the bank', () => {
    const work = ownedGroup('G1', { levels: [1, 0] });
    const result = development.sellLevel(work, sell(1));
    expect(result.ok).toBe(true);
    expect(work.players[0].cash).toBe(12_200); // 12,000 + 200
    expect(work.ownership[tileId(1)]?.level).toBe(0);
    expect(development.permitUnitsRemaining(work.ownership)).toBe(40);
  });

  it('even-build on sell: only the group maximum may come down', () => {
    const work = ownedGroup('G2', { levels: [2, 1, 1] }); // tiles 4, 6, 7
    const reject = development.sellLevel(work, sell(6)); // level 1 ≠ max 2
    expect(reject.ok).toBe(false);
    if (!reject.ok) expect(reject.error.code).toBe('INVALID_TILE');

    const lowered = development.sellLevel(work, sell(4));
    expect(lowered.ok).toBe(true);
    expect(work.ownership[tileId(4)]?.level).toBe(1); // group now [1, 1, 1]
  });

  it('selling the landmark refunds one permit cost half and frees the landmark unit', () => {
    const work = ownedGroup('G1', { levels: [5, 4] });
    const result = development.sellLevel(work, sell(1));
    expect(result.ok).toBe(true);
    expect(work.players[0].cash).toBe(12_200); // one permit cost's half, not four
    expect(work.ownership[tileId(1)]?.level).toBe(4);
    expect(development.landmarkUnitsRemaining(work.ownership)).toBe(8); // the unit returned
    expect(development.permitUnitsInCirculation(work.ownership)).toBe(8); // the deed re-holds its four
  });

  it('rejects selling an unbuilt district', () => {
    const work = ownedGroup('G1');
    const result = development.sellLevel(work, sell(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
  });

  it('rejects selling a tile the active player does not own', () => {
    const work = ownedGroup('G1', { levels: [3, 0] });
    work.ownership[tileId(1)] = { owner: playerId(2), level: 3, mortgaged: false };
    const result = development.sellLevel(work, sell(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
  });
});

describe('MORTGAGE and LIFT_MORTGAGE (spec §3.4)', () => {
  it('mortgages an unbuilt district for half its list price', () => {
    const work = ownedGroup('G1');
    const result = development.mortgage(work, mortgage(1)); // Midtown Docks I, list 900
    expect(result.ok).toBe(true);
    expect(work.players[0].cash).toBe(12_450); // 12,000 + 450
    expect(work.ownership[tileId(1)]?.mortgaged).toBe(true);
  });

  it('mortgaging a developed district is legal at half the LIST price (rules-as-written pin)', () => {
    const work = ownedGroup('G1', { levels: [3, 0] });
    const result = development.mortgage(work, mortgage(1));
    expect(result.ok).toBe(true);
    expect(work.players[0].cash).toBe(12_450);
    expect(work.ownership[tileId(1)]?.level).toBe(3); // levels stay attached
    expect(work.ownership[tileId(1)]?.mortgaged).toBe(true);
    // And the mortgaged member now blocks further development of the group.
    const blocked = development.buildLevel(work, build(2));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('INVALID_TILE');
  });

  it('mortgages depots and utilities too', () => {
    const work = editable(createGame('mortgage-kinds-seed', [...NAMES]));
    work.turn = { ...work.turn, state: 'postRoll' };
    work.ownership[tileId(5)] = { owner: playerId(0), level: 0, mortgaged: false }; // North Depot, 1,600
    work.ownership[tileId(11)] = { owner: playerId(0), level: 0, mortgaged: false }; // Power Grid, 1,400
    expect(mortgageValue(tileId(5))).toBe(800);
    expect(mortgageValue(tileId(11))).toBe(700);
    expect(development.mortgage(work, mortgage(5)).ok).toBe(true);
    expect(development.mortgage(work, mortgage(11)).ok).toBe(true);
    expect(work.players[0].cash).toBe(13_500); // 12,000 + 800 + 700
  });

  it('rejects a second mortgage', () => {
    const work = ownedGroup('G1', { mortgaged: [true, false] });
    const result = development.mortgage(work, mortgage(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
  });

  it('lifts a mortgage for the principal plus the rounded fee', () => {
    const work = ownedGroup('G1', { mortgaged: [true, false] });
    expect(mortgageLiftCost(tileId(1))).toBe(500); // 450 principal + 10% fee, rounded up to 10 TD
    const result = development.liftMortgage(work, lift(1));
    expect(result.ok).toBe(true);
    expect(work.players[0].cash).toBe(11_500); // 12,000 − 500
    expect(work.ownership[tileId(1)]?.mortgaged).toBe(false);
  });

  it('lifts at the exact-cash boundary and rejects one TD short', () => {
    const boundary = ownedGroup('G1', { cash: 500, mortgaged: [true, false] });
    expect(development.liftMortgage(boundary, lift(1)).ok).toBe(true);
    expect(boundary.players[0].cash).toBe(0);

    const short = ownedGroup('G1', { cash: 499, mortgaged: [true, false] });
    const result = development.liftMortgage(short, lift(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('rejects lifting an unmortgaged property', () => {
    const work = ownedGroup('G1');
    const result = development.liftMortgage(work, lift(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TILE');
  });

  it('mortgage then lift round-trips to unmortgaged, net the fee', () => {
    const work = ownedGroup('G1');
    expect(development.mortgage(work, mortgage(1)).ok).toBe(true); // +450
    expect(development.liftMortgage(work, lift(1)).ok).toBe(true); // −500
    expect(work.players[0].cash).toBe(11_950); // net −50: the lift fee
    expect(work.ownership[tileId(1)]?.mortgaged).toBe(false);
  });
});

describe('liquidation settles debt (spec §3.7)', () => {
  /** Debt state for p0 owing `amount`, holding North Depot (mortgage value 800). */
  function debtWork(creditor: 1 | 'bank', amount: number): WorkingState {
    const work = editable(createGame('liquidation-fixture-seed', [...NAMES]));
    work.turn = { activePlayer: playerId(0), state: 'debt', doublesRun: 0 };
    work.debt = { debtor: playerId(0), creditor: creditor === 'bank' ? 'bank' : playerId(creditor), amount };
    work.ownership[tileId(5)] = { owner: playerId(0), level: 0, mortgaged: false };
    work.players[0] = { ...work.players[0], cash: 100 };
    work.players[1] = { ...work.players[1], cash: 2_000 };
    return work;
  }

  it('a mortgage that covers the debt pays exactly that and resumes the turn', () => {
    const work = debtWork(1, 600);
    const result = development.mortgage(work, mortgage(5)); // +800 → 900 ≥ 600
    expect(result.ok).toBe(true);
    expect(work.debt).toBeNull();
    expect(work.players[0].cash).toBe(300); // 100 + 800 − 600
    expect(work.players[1].cash).toBe(2_600); // the exact debt
    expect(work.turn.state).toBe('postRoll');
    expect(work.ownership[tileId(5)]?.mortgaged).toBe(true);
  });

  it('a shortfall keeps the debt open and the player liquidating', () => {
    const work = debtWork(1, 1_500);
    const result = development.mortgage(work, mortgage(5)); // +800 → 900 < 1,500
    expect(result.ok).toBe(true);
    expect(work.debt).toEqual({ debtor: playerId(0), creditor: playerId(1), amount: 1_500 });
    expect(work.players[0].cash).toBe(900);
    expect(work.turn.state).toBe('debt');
  });

  it('bank-creditor settlement destroys the payment (the bank keeps no cash)', () => {
    const work = debtWork('bank', 600);
    const result = development.mortgage(work, mortgage(5));
    expect(result.ok).toBe(true);
    expect(work.debt).toBeNull();
    expect(work.players[0].cash).toBe(300);
    expect(work.players[1].cash).toBe(2_000); // untouched
    expect(work.turn.state).toBe('postRoll');
  });

  it('a settled debt resumes the mandatory re-roll after a doubles landing', () => {
    const work = debtWork(1, 600);
    work.turn = { ...work.turn, doublesRun: 1 };
    work.log.push({ seq: work.log.length, type: 'DICE_ROLLED', player: playerId(0), d1: 3, d2: 3, doubles: true });
    const result = development.mortgage(work, mortgage(5));
    expect(result.ok).toBe(true);
    expect(work.debt).toBeNull();
    expect(work.turn.state).toBe('awaitingRoll');
  });

  it('a doubles event alone resumes nothing — doublesRun must agree', () => {
    const work = debtWork(1, 600); // doublesRun 0
    work.log.push({ seq: work.log.length, type: 'DICE_ROLLED', player: playerId(0), d1: 3, d2: 3, doubles: true });
    const result = development.mortgage(work, mortgage(5));
    expect(result.ok).toBe(true);
    expect(work.turn.state).toBe('postRoll');
  });

  it('a level sale can be the settling move', () => {
    const work = editable(createGame('sell-settle-seed', [...NAMES]));
    work.turn = { activePlayer: playerId(0), state: 'debt', doublesRun: 0 };
    work.debt = { debtor: playerId(0), creditor: playerId(1), amount: 500 };
    work.ownership[tileId(1)] = { owner: playerId(0), level: 2, mortgaged: false };
    work.ownership[tileId(2)] = { owner: playerId(0), level: 1, mortgaged: false };
    work.players[0] = { ...work.players[0], cash: 100 };
    work.players[1] = { ...work.players[1], cash: 2_000 };

    const first = development.sellLevel(work, sell(1)); // level 2 → 1, +200 → 300 < 500
    expect(first.ok).toBe(true);
    expect(work.debt).toEqual({ debtor: playerId(0), creditor: playerId(1), amount: 500 });

    const second = development.mortgage(work, mortgage(1)); // +450 → 750 ≥ 500
    expect(second.ok).toBe(true);
    expect(work.debt).toBeNull();
    expect(work.players[0].cash).toBe(250); // 100 + 200 + 450 − 500
    expect(work.players[1].cash).toBe(2_500);
    expect(work.turn.state).toBe('postRoll');
  });
});
