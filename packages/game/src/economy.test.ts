// Economy rule tests (spec §3.4, §3.2, §3.3, §3.5, §3.8 — AC4).
//
// Every expected number is re-typed here from the spec, so a drift in the
// board tables cannot grade its own homework. Rent, tax, and salary behavior
// is driven through the engine (createGame + applyAction) with the next roll
// peeked from the seeded PRNG, so the fixtures stay deterministic without
// touching shared files.

import { describe, expect, it } from 'vitest';
import { createGame, applyAction } from './state-machine';
import { rollTwoDice } from './rng';
import { getTile, isBuyableKind } from './board';
import { stateHash } from './engine';
import * as economy from './economy';
import type { DevelopmentLevel, Die, GameState, GroupId, PlayerId, TileId, WorkingState } from './types';
import { playerId, tileId } from './types';

const NAMES = ['Ada', 'Bo', 'Cy'] as const;
const P0 = playerId(0);
const P1 = playerId(1);

// Spec constants, re-typed (§3.1, §3.3).
const STARTING_CASH = 12_000;
const SPEC_SALARY = 1_600;
/** Deep pockets for rent sweeps so big landmark rents never hit the debt path. */
const RENT_TEST_CASH = 1_000_000;

/** Spec §3.4 district ladder, verbatim — board.ts must agree with every cell. */
interface SpecGroup {
  readonly group: GroupId;
  readonly base: readonly number[];
  readonly mult: readonly [number, number, number, number, number];
  readonly permit: number;
  readonly tiles: readonly TileId[];
}

const SPEC_GROUPS: readonly SpecGroup[] = [
  { group: 'G1', base: [40, 50], mult: [8, 22, 50, 75, 95], permit: 400, tiles: [1, 2] },
  { group: 'G2', base: [70, 80, 90], mult: [7, 18, 40, 60, 80], permit: 600, tiles: [4, 6, 7] },
  { group: 'G3', base: [120, 120, 140], mult: [6, 15, 32, 50, 68], permit: 800, tiles: [9, 10, 12] },
  { group: 'G4', base: [180, 180, 200], mult: [5, 13, 27, 42, 58], permit: 1_000, tiles: [15, 16, 18] },
  { group: 'G5', base: [250, 250, 280], mult: [5, 12, 24, 37, 50], permit: 1_200, tiles: [20, 21, 23] },
  { group: 'G6', base: [350, 350, 380], mult: [4, 10, 20, 31, 42], permit: 1_500, tiles: [25, 26, 28] },
  { group: 'G7', base: [500, 500, 560], mult: [4, 9, 17, 26, 35], permit: 1_800, tiles: [30, 31, 33] },
  { group: 'G8', base: [800, 850], mult: [3, 8, 15, 23, 30], permit: 2_200, tiles: [36, 38] },
];

/** Spec §3.4 depot rents by count owned. */
const SPEC_DEPOT_RENTS: readonly number[] = [400, 900, 1_800, 3_000];
const SPEC_DEPOTS: readonly TileId[] = [5, 14, 24, 34];
const SPEC_UTILITY_ONE = 40;
const SPEC_UTILITY_BOTH = 100;
const UTILITIES: readonly TileId[] = [11, 29];
const SPEC_TAX_REVENUE_OFFICE = 1_200; // tile 13
const SPEC_TAX_LUXURY_LEVY = 900; // tile 22

// ---------------------------------------------------------------------------
// Deterministic fixtures

type OwnershipDraft = WorkingState['ownership'];

/** A deeply mutable draft of a real state — fixtures edit these. */
function editable(state: GameState): WorkingState {
  return structuredClone(state) as WorkingState;
}

/** Peek: the 2d6 the state's next ROLL_DICE will produce (does not consume RNG). */
function nextRoll(state: GameState | WorkingState): { d1: Die; d2: Die; sum: number } {
  const roll = rollTwoDice(state.rngState);
  return { d1: roll.d1, d2: roll.d2, sum: roll.d1 + roll.d2 };
}

/** Scan (deterministically) for a seed whose first roll matches `predicate`. */
function firstSeedWhere(predicate: (roll: { d1: Die; d2: Die }) => boolean): string {
  for (let i = 0; i < 500; i++) {
    const seed = `economy-spec-${i}`;
    if (predicate(nextRoll(createGame(seed, [...NAMES])))) return seed;
  }
  throw new Error('no qualifying seed in 500 candidates');
}

const isPlain = (r: { d1: Die; d2: Die }): boolean => r.d1 !== r.d2;
const isDoubles = (r: { d1: Die; d2: Die }): boolean => r.d1 === r.d2;

/** First roll plain — keeps settle/window assertions unambiguous. */
const SEED_PLAIN = firstSeedWhere(isPlain);
const ROLL_SUM = nextRoll(createGame(SEED_PLAIN, [...NAMES])).sum;
/** First roll doubles — for doubles-settle and jail-release fixtures. */
const SEED_DOUBLES = firstSeedWhere(isDoubles);

/** First seed whose first roll is doubles with a clean landing (window stays
 *  awaitingRoll) and whose second roll is plain. */
function doublesThenPlainSeed(): string {
  for (let i = 0; i < 500; i++) {
    const seed = `economy-spec-${i}`;
    const first = applyAction(createGame(seed, [...NAMES]), { type: 'ROLL_DICE', player: P0 });
    if (!first.ok) continue;
    if (first.state.turn.state !== 'awaitingRoll' || first.state.turn.doublesRun !== 1) continue;
    if (isPlain(nextRoll(first.state))) return seed;
  }
  throw new Error('no doubles-then-plain seed in 500 candidates');
}

/** Position `pid` so their next roll lands on `target` (peeked from the PRNG). */
function positionToLand(s: WorkingState, pid: PlayerId, target: TileId): void {
  const { sum } = nextRoll(s);
  s.players[pid] = { ...s.players[pid], position: tileId((((target - sum) % 40) + 40) % 40) };
}

/** Salary applies to a crafted landing exactly when the move wraps past tile 0. */
function salaryTerm(target: TileId): number {
  return target < ROLL_SUM ? SPEC_SALARY : 0;
}

function soloOwner(tile: TileId, level: DevelopmentLevel, mortgaged = false, owner: PlayerId = P1): OwnershipDraft {
  const draft = {} as OwnershipDraft;
  draft[tile] = { owner, level, mortgaged };
  return draft;
}

function fullGroupOwner(g: SpecGroup, level: DevelopmentLevel): OwnershipDraft {
  const draft = {} as OwnershipDraft;
  for (const t of g.tiles) draft[t] = { owner: P1, level, mortgaged: false };
  return draft;
}

/** Level-0 solo rent for any buyable tile, from the spec tables in this file. */
function specSoloRent(tile: TileId, diceSum: number): number {
  const g = SPEC_GROUPS.find(g => g.tiles.includes(tile));
  if (g) return g.base[g.tiles.indexOf(tile)];
  if (SPEC_DEPOTS.includes(tile)) return SPEC_DEPOT_RENTS[0];
  if (UTILITIES.includes(tile)) return diceSum * SPEC_UTILITY_ONE;
  throw new Error(`tile ${tile} has no spec rent`);
}

/** Land player 0 on `target` against the crafted ownership; returns the new state. */
function landOn(ownership: OwnershipDraft, target: TileId, payerCash = RENT_TEST_CASH): GameState {
  const work = editable(createGame(SEED_PLAIN, [...NAMES]));
  work.ownership = ownership;
  work.players[0] = { ...work.players[0], cash: payerCash };
  positionToLand(work, P0, target);
  const result = applyAction(work, { type: 'ROLL_DICE', player: P0 });
  if (!result.ok) throw new Error(`fixture roll failed: ${result.error.code} — ${result.error.message}`);
  return result.state;
}

// ---------------------------------------------------------------------------
// District rent ladders — every group, every level, solo and full set (AC4)

describe('district rent ladders (spec §3.4, AC4)', () => {
  for (const g of SPEC_GROUPS) {
    describe(g.group, () => {
      g.tiles.forEach((tile, i) => {
        const base = g.base[i];

        it(`tile ${tile} level 0 solo pays base rent ${base}`, () => {
          const after = landOn(soloOwner(tile, 0), tile);
          expect(after.players[P0].cash).toBe(RENT_TEST_CASH + salaryTerm(tile) - base);
          expect(after.players[P1].cash).toBe(STARTING_CASH + base);
          expect(after.turn.state).toBe('postRoll');
        });

        it(`tile ${tile} level 0 full set pays ${base * 2} (×2 rule)`, () => {
          const after = landOn(fullGroupOwner(g, 0), tile);
          expect(after.players[P0].cash).toBe(RENT_TEST_CASH + salaryTerm(tile) - base * 2);
          expect(after.players[P1].cash).toBe(STARTING_CASH + base * 2);
        });

        g.mult.forEach((mult, l) => {
          const level = (l + 1) as DevelopmentLevel;
          const rent = base * mult;
          it(`tile ${tile} level ${level} pays ${rent} (base ${base} × ${mult})`, () => {
            const after = landOn(fullGroupOwner(g, level), tile);
            expect(after.players[P0].cash).toBe(RENT_TEST_CASH + salaryTerm(tile) - rent);
            expect(after.players[P1].cash).toBe(STARTING_CASH + rent);
          });
        });
      });
    });
  }

  it('rent transfers conserve TD exactly (payer − rent, owner + rent)', () => {
    const after = landOn(soloOwner(tileId(15), 0), tileId(15));
    const delta0 = after.players[P0].cash - RENT_TEST_CASH;
    const delta1 = after.players[P1].cash - STARTING_CASH;
    expect(delta0).toBe(-delta1);
  });
});

// ---------------------------------------------------------------------------
// Post-landing window settlement — the economy seam owns it, doubles rules

describe('post-landing window settlement (spec §3.3)', () => {
  it('plain landing rent settles to postRoll', () => {
    const after = landOn(soloOwner(tileId(15), 0), tileId(15));
    expect(after.turn.state).toBe('postRoll');
  });

  it('a free roll of doubles settles rent to awaitingRoll (roll again)', () => {
    const base = createGame(SEED_DOUBLES, [...NAMES]);
    const work = editable(base);
    work.ownership = soloOwner(tileId(15), 0);
    positionToLand(work, P0, tileId(15));
    const result = applyAction(work, { type: 'ROLL_DICE', player: P0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.turn.doublesRun).toBe(1);
    expect(result.state.turn.state).toBe('awaitingRoll');
    expect(result.state.players[P1].cash).toBe(STARTING_CASH + specSoloRent(tileId(15), ROLL_SUM));
  });

  it('doubles then a plain roll settles a buy to postRoll (stale doublesRun)', () => {
    const seed = doublesThenPlainSeed();
    const first = applyAction(createGame(seed, [...NAMES]), { type: 'ROLL_DICE', player: P0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const work = editable(first.state);
    positionToLand(work, P0, tileId(1)); // unowned → awaitingBuy
    const second = applyAction(work, { type: 'ROLL_DICE', player: P0 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.turn.state).toBe('awaitingBuy');
    expect(second.state.turn.doublesRun).toBe(1); // stale from roll 1

    const bought = applyAction(second.state, { type: 'BUY_PROPERTY', player: P0 });
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;
    expect(bought.state.turn.state).toBe('postRoll');
  });

  it('a jail-release roll of doubles settles rent to postRoll (no extra roll)', () => {
    // Held at The Depot (39); the release roll moves to (39 + sum) % 40.
    const seed = firstSeedWhere(r => {
      if (!isDoubles(r)) return false;
      const landing = tileId((39 + r.d1 + r.d2) % 40);
      return isBuyableKind(getTile(landing).kind);
    });
    const base = createGame(seed, [...NAMES]);
    const landing = tileId((39 + nextRoll(base).sum) % 40);

    const work = editable(base);
    work.players[0] = { ...work.players[0], position: tileId(39), jailTurnsLeft: 3 };
    work.ownership = soloOwner(landing, 0);
    work.turn = { ...work.turn, state: 'turnStart' };

    const result = applyAction(work, { type: 'ROLL_DICE', player: P0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0].jailTurnsLeft).toBe(0);
    expect(result.state.turn.state).toBe('postRoll');
    const rent = specSoloRent(landing, nextRoll(base).sum);
    // The move from 39 always wraps past City Hall Plaza.
    expect(result.state.players[P0].cash).toBe(STARTING_CASH + SPEC_SALARY - rent);
    expect(result.state.players[P1].cash).toBe(STARTING_CASH + rent);
  });
});

// ---------------------------------------------------------------------------
// Purchase at list price (spec §3.5)

describe('buyProperty (spec §3.5)', () => {
  function workInAwaitingBuy(position: TileId, cash = STARTING_CASH): WorkingState {
    const work = editable(createGame(SEED_PLAIN, [...NAMES]));
    work.players[0] = { ...work.players[0], position, cash };
    work.turn = { ...work.turn, state: 'awaitingBuy' };
    return work;
  }

  it('buys the stood-on tile at list price and settles to postRoll', () => {
    const work = workInAwaitingBuy(tileId(1));
    const result = applyAction(work, { type: 'BUY_PROPERTY', player: P0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.state;
    expect(s.players[P0].cash).toBe(STARTING_CASH - 900);
    expect(s.ownership[1]).toEqual({ owner: P0, level: 0, mortgaged: false });
    expect(s.turn.state).toBe('postRoll');
  });

  it('buys with exact cash (price == cash → 0 TD left, no debt)', () => {
    const work = workInAwaitingBuy(tileId(1), 900);
    const result = applyAction(work, { type: 'BUY_PROPERTY', player: P0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[P0].cash).toBe(0);
    expect(result.state.debt).toBeNull();
  });

  it('rejects a shortfall with INSUFFICIENT_FUNDS and leaves state untouched', () => {
    const state = workInAwaitingBuy(tileId(1), 899);
    const before = stateHash(state);
    const result = applyAction(state, { type: 'BUY_PROPERTY', player: P0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(stateHash(state)).toBe(before);
    expect(state.ownership[1]).toBeUndefined();
    expect(state.players[P0].cash).toBe(899);
  });

  it('rejects buying a non-purchaseable tile with INVALID_TILE', () => {
    const work = workInAwaitingBuy(tileId(3)); // Harbor Plaza, rest
    const result = economy.buyProperty(work, { type: 'BUY_PROPERTY', player: P0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_TILE');
  });

  it('rejects a non-active buyer with WRONG_PLAYER', () => {
    const work = workInAwaitingBuy(tileId(1));
    const result = economy.buyProperty(work, { type: 'BUY_PROPERTY', player: P1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WRONG_PLAYER');
  });
});

// ---------------------------------------------------------------------------
// Rent collection through the debt path (spec §3.7)

describe('collectRent debt path (spec §3.7)', () => {
  it('a shortfall enters debt naming the payee, cash untouched', () => {
    const after = landOn(soloOwner(tileId(15), 0), tileId(15), 100);
    expect(after.debt).toEqual({ debtor: P0, creditor: P1, amount: 180 });
    expect(after.turn.state).toBe('debt');
    expect(after.players[P0].cash).toBe(100);
    expect(after.players[P1].cash).toBe(STARTING_CASH);
    const debtEvents = after.log.filter(e => e.type === 'DEBT_ENTERED');
    expect(debtEvents).toHaveLength(1);
  });

  it('exact cash pays in full — no debt at the boundary', () => {
    const after = landOn(soloOwner(tileId(15), 0), tileId(15), 180);
    expect(after.debt).toBeNull();
    expect(after.turn.state).toBe('postRoll');
    expect(after.players[P0].cash).toBe(0);
    expect(after.players[P1].cash).toBe(STARTING_CASH + 180);
  });

  it('a zero amount is a no-op that still settles the window', () => {
    const work = editable(createGame(SEED_PLAIN, [...NAMES]));
    const result = economy.collectRent(work, P0, P1, tileId(15), 0);
    expect(result.ok).toBe(true);
    expect(work.debt).toBeNull();
    expect(work.players[P0].cash).toBe(STARTING_CASH);
    expect(work.turn.state).toBe('postRoll');
  });
});

// ---------------------------------------------------------------------------
// Depot and utility rents (spec §3.4)

describe('depot rents (spec §3.4, AC4)', () => {
  SPEC_DEPOT_RENTS.forEach((rent, k) => {
    const held = k + 1;
    it(`${held} depot${held > 1 ? 's' : ''} owned pay ${rent}`, () => {
      const draft = {} as OwnershipDraft;
      for (const t of SPEC_DEPOTS.slice(0, held)) draft[t] = { owner: P1, level: 0, mortgaged: false };
      const target = SPEC_DEPOTS[0];
      const after = landOn(draft, target);
      expect(after.players[P0].cash).toBe(RENT_TEST_CASH + salaryTerm(target) - rent);
      expect(after.players[P1].cash).toBe(STARTING_CASH + rent);
    });
  });
});

describe('utility rents (spec §3.4, AC4)', () => {
  it('one utility pays dice sum × 40', () => {
    const target = UTILITIES[0];
    const after = landOn(soloOwner(target, 0), target);
    const rent = ROLL_SUM * SPEC_UTILITY_ONE;
    expect(after.players[P0].cash).toBe(RENT_TEST_CASH + salaryTerm(target) - rent);
    expect(after.players[P1].cash).toBe(STARTING_CASH + rent);
  });

  it('both utilities pay dice sum × 100', () => {
    const draft = {} as OwnershipDraft;
    draft[UTILITIES[0]] = { owner: P1, level: 0, mortgaged: false };
    draft[UTILITIES[1]] = { owner: P1, level: 0, mortgaged: false };
    const target = UTILITIES[0];
    const after = landOn(draft, target);
    const rent = ROLL_SUM * SPEC_UTILITY_BOTH;
    expect(after.players[P0].cash).toBe(RENT_TEST_CASH + salaryTerm(target) - rent);
    expect(after.players[P1].cash).toBe(STARTING_CASH + rent);
  });
});

// ---------------------------------------------------------------------------
// Taxes (spec §3.4) — paid to the bank, debt on shortfall

describe('taxes (spec §3.4, AC4)', () => {
  it('Revenue Office takes 1,200 TD to the bank', () => {
    const after = landOn({} as OwnershipDraft, tileId(13), STARTING_CASH);
    expect(after.players[P0].cash).toBe(STARTING_CASH - SPEC_TAX_REVENUE_OFFICE);
    const taxEvents = after.log.filter(e => e.type === 'TAX_COLLECTED');
    expect(taxEvents).toHaveLength(1);
    if (taxEvents[0].type !== 'TAX_COLLECTED') return;
    expect(taxEvents[0].amount).toBe(SPEC_TAX_REVENUE_OFFICE);
    expect(taxEvents[0].tile).toBe(tileId(13));
    expect(after.debt).toBeNull();
    expect(after.turn.state).toBe('postRoll');
  });

  it('Luxury Levy takes 900 TD to the bank', () => {
    const after = landOn({} as OwnershipDraft, tileId(22), STARTING_CASH);
    expect(after.players[P0].cash).toBe(STARTING_CASH - SPEC_TAX_LUXURY_LEVY);
    const taxEvents = after.log.filter(e => e.type === 'TAX_COLLECTED');
    expect(taxEvents).toHaveLength(1);
    if (taxEvents[0].type !== 'TAX_COLLECTED') return;
    expect(taxEvents[0].amount).toBe(SPEC_TAX_LUXURY_LEVY);
    expect(taxEvents[0].tile).toBe(tileId(22));
  });

  it('tax equal to cash pays down to 0 without debt', () => {
    const after = landOn({} as OwnershipDraft, tileId(13), SPEC_TAX_REVENUE_OFFICE);
    expect(after.players[P0].cash).toBe(0);
    expect(after.debt).toBeNull();
    expect(after.turn.state).toBe('postRoll');
  });

  it('tax above cash enters bank debt, cash untouched', () => {
    const after = landOn({} as OwnershipDraft, tileId(13), SPEC_TAX_REVENUE_OFFICE - 1);
    expect(after.debt).toEqual({ debtor: P0, creditor: 'bank', amount: SPEC_TAX_REVENUE_OFFICE });
    expect(after.turn.state).toBe('debt');
    expect(after.players[P0].cash).toBe(SPEC_TAX_REVENUE_OFFICE - 1);
    expect(after.log.filter(e => e.type === 'DEBT_ENTERED')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Salary (spec §3.3) — collected on passing AND landing on City Hall Plaza

describe('salary (spec §3.3, AC4)', () => {
  it('passing City Hall Plaza collects 1,600 TD once', () => {
    // Positioned to wrap: raw index 43 → lands on tile 3 (Harbor Plaza, no effect).
    const after = landOn({} as OwnershipDraft, tileId(3), STARTING_CASH);
    expect(after.players[P0].cash).toBe(STARTING_CASH + SPEC_SALARY);
    const salaryEvents = after.log.filter(e => e.type === 'SALARY_COLLECTED');
    expect(salaryEvents).toHaveLength(1);
    if (salaryEvents[0].type !== 'SALARY_COLLECTED') return;
    expect(salaryEvents[0].amount).toBe(SPEC_SALARY);
    expect(after.turn.state).toBe('postRoll');
  });

  it('landing on City Hall Plaza collects 1,600 TD once, with no buy offer', () => {
    const after = landOn({} as OwnershipDraft, tileId(0), STARTING_CASH);
    expect(after.players[P0].cash).toBe(STARTING_CASH + SPEC_SALARY);
    const salaryEvents = after.log.filter(e => e.type === 'SALARY_COLLECTED');
    expect(salaryEvents).toHaveLength(1);
    expect(after.log.filter(e => e.type === 'BUY_OFFERED')).toHaveLength(0);
    expect(after.turn.state).toBe('postRoll');
  });
});

// ---------------------------------------------------------------------------
// Mortgaged properties collect no rent (spec §3.4)

describe('mortgaged rent block (spec §3.4, AC4)', () => {
  it('a developed but mortgaged property collects 0 rent', () => {
    const target = tileId(15);
    const after = landOn(soloOwner(target, 2, true), target, STARTING_CASH);
    expect(after.players[P0].cash).toBe(STARTING_CASH + salaryTerm(target));
    expect(after.players[P1].cash).toBe(STARTING_CASH);
    expect(after.turn.state).toBe('postRoll');
  });
});
