// FSM transition-table coverage (AC3) + turn-flow behavior tests.
//
// The matrix test walks the FULL cross product of fixture states × action
// types and asserts each pair either transitions (ok) or returns the exact
// expected typed error — no unhandled transition can hide. The expected
// matrix defaults to WRONG_PHASE and overrides the cells with different
// outcomes; stub-era seam actions expect NOT_IMPLEMENTED.
//
// Fixtures mutate a deep-mutable draft (WorkingState) of a real
// createGame state — the same shape rule modules work on.

import { describe, expect, it } from 'vitest';
import { createGame, applyAction, getLegalActions, TRANSITION_TABLE } from './state-machine';
import type { GameAction, GameErrorCode, GameState, TileId, TurnState, WorkingState } from './types';
import { playerId, tileId } from './types';

const NAMES = ['Ada', 'Bo', 'Cy'] as const;

/** A deeply mutable draft of a real state — fixtures edit these. */
function editable(state: GameState): WorkingState {
  return structuredClone(state) as WorkingState;
}

type FixtureName =
  | 'turnStart-free'
  | 'turnStart-held'
  | 'awaitingRoll'
  | 'awaitingBuy'
  | 'auction'
  | 'postRoll'
  | 'debt'
  | 'moving'
  | 'finished';

function fixture(name: FixtureName): GameState {
  const s = editable(createGame('fsm-fixture-seed', [...NAMES]));
  const p0 = s.players[0];
  switch (name) {
    case 'turnStart-free':
      s.turn = { ...s.turn, state: 'turnStart' };
      break;
    case 'turnStart-held':
      s.turn = { ...s.turn, state: 'turnStart' };
      s.players[0] = { ...p0, jailTurnsLeft: 3 };
      break;
    case 'awaitingRoll':
      break; // createGame default for a free active player
    case 'awaitingBuy':
      s.players[0] = { ...p0, position: tileId(1) };
      s.turn = { ...s.turn, state: 'awaitingBuy' };
      break;
    case 'auction':
      s.players[0] = { ...p0, position: tileId(1) };
      s.turn = { ...s.turn, state: 'auction' };
      s.auction = { tile: tileId(1), highBid: null, passed: [playerId(1)] };
      break;
    case 'postRoll':
      s.turn = { ...s.turn, state: 'postRoll' };
      break;
    case 'debt':
      s.turn = { ...s.turn, state: 'debt' };
      s.debt = { debtor: playerId(0), creditor: 'bank', amount: 1_500 };
      break;
    case 'moving':
      s.turn = { ...s.turn, state: 'moving' };
      break;
    case 'finished':
      s.phase = 'finished';
      s.winner = playerId(0);
      break;
  }
  return s;
}

const EMPTY_LEG = { cash: 0, tiles: [] as TileId[] };

const SAMPLE_ACTIONS: Record<GameAction['type'], GameAction> = {
  ROLL_DICE: { type: 'ROLL_DICE', player: playerId(0) },
  BUY_PROPERTY: { type: 'BUY_PROPERTY', player: playerId(0) },
  DECLINE_BUY: { type: 'DECLINE_BUY', player: playerId(0) },
  AUCTION_BID: { type: 'AUCTION_BID', player: playerId(0), amount: 100 },
  AUCTION_PASS: { type: 'AUCTION_PASS', player: playerId(0) },
  PROPOSE_TRADE: { type: 'PROPOSE_TRADE', player: playerId(0), to: playerId(1), give: EMPTY_LEG, want: EMPTY_LEG },
  ACCEPT_TRADE: { type: 'ACCEPT_TRADE', player: playerId(0) },
  DECLINE_TRADE: { type: 'DECLINE_TRADE', player: playerId(0) },
  BUILD_LEVEL: { type: 'BUILD_LEVEL', player: playerId(0), tile: tileId(1) },
  SELL_LEVEL: { type: 'SELL_LEVEL', player: playerId(0), tile: tileId(1) },
  MORTGAGE: { type: 'MORTGAGE', player: playerId(0), tile: tileId(1) },
  LIFT_MORTGAGE: { type: 'LIFT_MORTGAGE', player: playerId(0), tile: tileId(1) },
  PAY_JAIL_FINE: { type: 'PAY_JAIL_FINE', player: playerId(0) },
  DECLARE_BANKRUPTCY: { type: 'DECLARE_BANKRUPTCY', player: playerId(0) },
  END_TURN: { type: 'END_TURN', player: playerId(0) },
};

const ACTION_TYPES = Object.keys(SAMPLE_ACTIONS) as GameAction['type'][];

/**
 * Expected outcome per fixture × action, defaulting to WRONG_PHASE. 'ok'
 * means the action applies; anything else is an expected error code.
 * Stub-era seams expect NOT_IMPLEMENTED — they become real transitions as
 * the rule-module PRs land.
 */
const EXPECTED: Record<FixtureName, Partial<Record<GameAction['type'], 'ok' | GameErrorCode>>> = {
  'turnStart-free': {
    ROLL_DICE: 'ok',
    PAY_JAIL_FINE: 'NOT_HELD', // the table routes the cell; the handler rejects free players
  },
  'turnStart-held': {
    ROLL_DICE: 'ok',
    PAY_JAIL_FINE: 'ok',
  },
  awaitingRoll: {
    ROLL_DICE: 'ok',
    PROPOSE_TRADE: 'NOT_IMPLEMENTED',
  },
  awaitingBuy: {
    BUY_PROPERTY: 'NOT_IMPLEMENTED',
    DECLINE_BUY: 'NOT_IMPLEMENTED',
  },
  auction: {
    AUCTION_BID: 'NOT_IMPLEMENTED',
    AUCTION_PASS: 'NOT_IMPLEMENTED',
  },
  postRoll: {
    END_TURN: 'ok',
    PROPOSE_TRADE: 'NOT_IMPLEMENTED',
    BUILD_LEVEL: 'NOT_IMPLEMENTED',
    SELL_LEVEL: 'NOT_IMPLEMENTED',
    MORTGAGE: 'NOT_IMPLEMENTED',
    LIFT_MORTGAGE: 'NOT_IMPLEMENTED',
  },
  debt: {
    SELL_LEVEL: 'NOT_IMPLEMENTED',
    MORTGAGE: 'NOT_IMPLEMENTED',
    DECLARE_BANKRUPTCY: 'NOT_IMPLEMENTED',
  },
  moving: {}, // transient state — every action is WRONG_PHASE
  finished: {}, // handled specially: every action is GAME_NOT_ACTIVE
};

describe('FSM transition matrix (AC3: every TurnState × GameAction)', () => {
  const FIXTURES = Object.keys(EXPECTED) as FixtureName[];

  it('the table exposes a row for every observable turn state', () => {
    const states: TurnState[] = ['turnStart', 'awaitingRoll', 'moving', 'awaitingBuy', 'auction', 'postRoll', 'debt'];
    for (const ts of states) {
      expect(TRANSITION_TABLE[ts], `missing table row for ${ts}`).toBeDefined();
    }
  });

  for (const fx of FIXTURES) {
    for (const actionType of ACTION_TYPES) {
      it(`${fx} × ${actionType}`, () => {
        const expected =
          fx === 'finished' ? 'GAME_NOT_ACTIVE'
          : actionType === 'ACCEPT_TRADE' || actionType === 'DECLINE_TRADE' ? 'NO_PENDING_TRADE' // universal sender-check guard, any phase
          : (EXPECTED[fx][actionType] ?? 'WRONG_PHASE');
        const result = applyAction(fixture(fx), SAMPLE_ACTIONS[actionType]);
        if (expected === 'ok') {
          expect(result.ok, `${fx} × ${actionType} should apply`).toBe(true);
        } else {
          expect(result.ok, `${fx} × ${actionType} should be rejected`).toBe(false);
          if (!result.ok) expect(result.error.code).toBe(expected);
        }
      });
    }
  }
});

describe('createGame', () => {
  it('builds a deterministic active game from the seed', () => {
    const a = createGame('setup-seed', [...NAMES]);
    const b = createGame('setup-seed', [...NAMES]);
    expect(a.players.map(p => p.name)).toEqual(b.players.map(p => p.name));
    expect(a.rngState).toBe(b.rngState);
    expect(a.phase).toBe('active');
    expect(a.winner).toBeNull();
    expect(a.auction).toBeNull();
    expect(a.pendingTrade).toBeNull();
    expect(a.debt).toBeNull();
  });

  it('shuffles turn order from the seeded PRNG as a permutation of the input', () => {
    const state = createGame('shuffle-seed', [...NAMES]);
    expect([...state.players.map(p => p.name)].sort()).toEqual([...NAMES].sort());
  });

  it('hands out 12,000 TD at City Hall Plaza with the turn awaiting a roll', () => {
    const state = createGame('cash-seed', [...NAMES]);
    for (const p of state.players) {
      expect(p.cash).toBe(12_000);
      expect(p.position).toBe(tileId(0));
      expect(p.jailTurnsLeft).toBe(0);
      expect(p.bankrupt).toBe(false);
    }
    expect(state.turn.state).toBe('awaitingRoll');
  });

  it('rejects 1 or 6 players and an empty seed', () => {
    expect(() => createGame('s', ['Solo'])).toThrow(RangeError);
    expect(() => createGame('s', ['A', 'B', 'C', 'D', 'E', 'F'])).toThrow(RangeError);
    expect(() => createGame('', ['A', 'B'])).toThrow(RangeError);
  });

  it('opens the log with GAME_STARTED then TURN_STARTED, seq-numbered', () => {
    const state = createGame('log-seed', [...NAMES]);
    expect(state.log.map(e => e.type)).toEqual(['GAME_STARTED', 'TURN_STARTED']);
    expect(state.log.map(e => e.seq)).toEqual([0, 1]);
  });
});

/** The dice sum of the active player's opening roll under a seed, state untouched. */
function peekFirstRollSum(seed: string): number {
  const result = applyAction(createGame(seed, [...NAMES]), { type: 'ROLL_DICE', player: playerId(0) });
  if (!result.ok) throw new Error(`peekFirstRollSum: roll failed: ${result.error.message}`);
  const dice = result.state.log.find(e => e.type === 'DICE_ROLLED');
  if (!dice || dice.type !== 'DICE_ROLLED') throw new Error('peekFirstRollSum: no DICE_ROLLED event');
  return dice.d1 + dice.d2;
}

/** First scanned seed whose opening roll is true doubles with the wanted sum. */
function seedWithTrueDoubles(sum: number): string {
  for (let i = 0; i < 500; i++) {
    const seed = `scan-doubles-${sum}-${i}`;
    const result = applyAction(createGame(seed, [...NAMES]), { type: 'ROLL_DICE', player: playerId(0) });
    if (!result.ok) continue; // landed on the rent seam (stub) — try the next seed
    const dice = result.state.log.find(e => e.type === 'DICE_ROLLED');
    if (dice && dice.type === 'DICE_ROLLED' && dice.doubles && dice.d1 + dice.d2 === sum) return seed;
  }
  throw new Error(`seedWithTrueDoubles: no seed found for sum ${sum}`);
}

/** First scanned seed whose opening roll is not doubles. */
function seedWithoutDoubles(): string {
  for (let i = 0; i < 500; i++) {
    const seed = `scan-free-${i}`;
    const result = applyAction(createGame(seed, [...NAMES]), { type: 'ROLL_DICE', player: playerId(0) });
    if (!result.ok) continue; // landed on the rent seam (stub) — try the next seed
    const dice = result.state.log.find(e => e.type === 'DICE_ROLLED');
    if (dice && dice.type === 'DICE_ROLLED' && !dice.doubles) return seed;
  }
  throw new Error('seedWithoutDoubles: no seed found');
}

function lastEvent(state: GameState): GameState['log'][number] {
  return state.log[state.log.length - 1];
}

function eventsOf(state: GameState): string[] {
  return state.log.map(e => e.type);
}

describe('movement and salary (spec §3.3)', () => {
  it('collects the 1,600 TD salary when passing City Hall Plaza', () => {
    const seed = seedWithoutDoubles();
    const sum = peekFirstRollSum(seed);
    const s = editable(createGame(seed, [...NAMES]));
    s.players[0] = { ...s.players[0], position: tileId(41 - sum) }; // raw = 41: passes tile 0, lands on tile 1

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(eventsOf(result.state)).toContain('SALARY_COLLECTED');
    expect(result.state.players[0].cash).toBe(12_000 + 1_600);
    expect(result.state.players[0].position).toBe(tileId(1));
  });

  it('collects the salary when landing exactly on City Hall Plaza', () => {
    const seed = seedWithoutDoubles();
    const sum = peekFirstRollSum(seed);
    const s = editable(createGame(seed, [...NAMES]));
    s.players[0] = { ...s.players[0], position: tileId(40 - sum) }; // raw = 40: lands on tile 0

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(eventsOf(result.state)).toContain('SALARY_COLLECTED');
    expect(result.state.players[0].position).toBe(tileId(0));
  });

  it('pays no salary for a plain mid-board move', () => {
    const seed = seedWithoutDoubles();
    const sum = peekFirstRollSum(seed);
    const s = editable(createGame(seed, [...NAMES]));
    s.players[0] = { ...s.players[0], position: tileId(20 - sum) }; // raw = 20 < 40

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(eventsOf(result.state)).not.toContain('SALARY_COLLECTED');
    expect(result.state.players[0].cash).toBe(12_000);
  });

  it('grants the mandatory second roll after doubles', () => {
    // Sum 8 from the start lands on Exchange Plaza (a rest tile) so the only
    // state change is the doubled window.
    const seed = seedWithTrueDoubles(8);
    const result = applyAction(createGame(seed, [...NAMES]), { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.turn.doublesRun).toBe(1);
    expect(result.state.turn.state).toBe('awaitingRoll'); // never postRoll after doubles
  });

  it('sends a third consecutive doubles to The Depot and ends the turn', () => {
    const seed = seedWithTrueDoubles(4); // any doubles; the bonus move never happens
    const s = editable(createGame(seed, [...NAMES]));
    s.turn = { ...s.turn, doublesRun: 2 };

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0].position).toBe(tileId(39));
    expect(result.state.players[0].jailTurnsLeft).toBe(3);
    expect(result.state.turn.activePlayer).toBe(playerId(1));
    expect(lastEvent(result.state).type).toBe('TURN_STARTED');
    const sent = result.state.log.find(e => e.type === 'SENT_TO_DEPOT');
    expect(sent && sent.type === 'SENT_TO_DEPOT' ? sent.reason : null).toBe('third-doubles');
  });
});

describe('The Depot — jail flow (spec §3.3)', () => {
  function held(seed: string, turnsLeft: number): WorkingState {
    const s = editable(createGame(seed, [...NAMES]));
    s.turn = { activePlayer: playerId(0), state: 'turnStart', doublesRun: 0 };
    s.players[0] = { ...s.players[0], position: tileId(39), jailTurnsLeft: turnsLeft };
    return s;
  }

  it('a failed attempt burns one held turn and passes play on', () => {
    const seed = seedWithoutDoubles();
    const result = applyAction(held(seed, 3), { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0].jailTurnsLeft).toBe(2);
    expect(result.state.turn.activePlayer).toBe(playerId(1));
    expect(eventsOf(result.state)).toContain('JAIL_ROLL_FAILED');
  });

  it('the third failed attempt forces the 500 TD fine and moves by that roll', () => {
    const seed = seedWithoutDoubles();
    const sum = peekFirstRollSum(seed);
    const result = applyAction(held(seed, 1), { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0].cash).toBe(12_000 - 500 + 1_600); // the forced move passes City Hall
    expect(result.state.players[0].jailTurnsLeft).toBe(0);
    expect(result.state.players[0].position).toBe(tileId((39 + sum) % 40));
    const paid = result.state.log.find(e => e.type === 'JAIL_FINE_PAID');
    expect(paid && paid.type === 'JAIL_FINE_PAID' ? paid.kind : null).toBe('forced');
  });

  it('doubles release the player, who then moves with no extra roll', () => {
    const seed = seedWithTrueDoubles(4); // released by 2+2; (39+4)%40 lands on Harbor Plaza (rest)
    const result = applyAction(held(seed, 3), { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0].jailTurnsLeft).toBe(0);
    expect(result.state.players[0].position).toBe(tileId(3));
    expect(result.state.turn.state).toBe('postRoll'); // the jail roll grants no extra roll
    expect(eventsOf(result.state)).toContain('RELEASED_FROM_JAIL');
  });

  it('PAY_JAIL_FINE releases the player for 500 TD and keeps their roll', () => {
    const result = applyAction(held('fine-seed', 3), { type: 'PAY_JAIL_FINE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0].cash).toBe(12_000 - 500);
    expect(result.state.players[0].jailTurnsLeft).toBe(0);
    expect(result.state.turn.state).toBe('awaitingRoll');
    const paid = result.state.log.find(e => e.type === 'JAIL_FINE_PAID');
    expect(paid && paid.type === 'JAIL_FINE_PAID' ? paid.kind : null).toBe('voluntary');
  });

  it('PAY_JAIL_FINE without the cash is rejected with INSUFFICIENT_FUNDS', () => {
    const s = held('fine-poor-seed', 3);
    s.players[0] = { ...s.players[0], cash: 400 };
    const result = applyAction(s, { type: 'PAY_JAIL_FINE', player: playerId(0) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('PAY_JAIL_FINE for a free player is NOT_HELD', () => {
    const result = applyAction(held('fine-free-seed', 0), { type: 'PAY_JAIL_FINE', player: playerId(0) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_HELD');
  });
});

describe('taxes and debt entry (spec §3.4, §3.7)', () => {
  it('charges the Revenue Office 1,200 TD to the bank', () => {
    const seed = seedWithoutDoubles();
    const sum = peekFirstRollSum(seed);
    const s = editable(createGame(seed, [...NAMES]));
    s.players[0] = { ...s.players[0], position: tileId(13 - sum) }; // raw = 13: land on tile 13

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0].cash).toBe(12_000 - 1_200);
    expect(result.state.turn.state).toBe('postRoll');
  });

  it('a tax larger than cash enters the debt state naming the bank', () => {
    const seed = seedWithoutDoubles();
    const sum = peekFirstRollSum(seed);
    const s = editable(createGame(seed, [...NAMES]));
    s.players[0] = { ...s.players[0], position: tileId(13 - sum), cash: 1_000 };

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.debt).toEqual({ debtor: playerId(0), creditor: 'bank', amount: 1_200 });
    expect(result.state.turn.state).toBe('debt');
    expect(result.state.players[0].cash).toBe(1_000); // cash never goes negative outside debt settlement
    expect(eventsOf(result.state)).toContain('DEBT_ENTERED');
  });
});

describe('The Audit Office (spec §3.3)', () => {
  it('transfers the player to The Depot, held, and ends the turn', () => {
    const seed = seedWithTrueDoubles(2); // 1+1 from tile 33 lands on tile 35
    const s = editable(createGame(seed, [...NAMES]));
    s.players[0] = { ...s.players[0], position: tileId(33) };

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0].position).toBe(tileId(39));
    expect(result.state.players[0].jailTurnsLeft).toBe(3);
    expect(result.state.turn.activePlayer).toBe(playerId(1));
    const sent = result.state.log.find(e => e.type === 'SENT_TO_DEPOT');
    expect(sent && sent.type === 'SENT_TO_DEPOT' ? sent.reason : null).toBe('audit');
  });
});

describe('rent seam and atomicity (spec §4)', () => {
  it('a failing seam rejects the whole action and leaves the input state untouched', () => {
    const seed = seedWithTrueDoubles(2); // 1+1 from tile 39 lands on tile 1, owned by Bo
    const s = editable(createGame(seed, [...NAMES]));
    s.players[0] = { ...s.players[0], position: tileId(39) };
    s.ownership[tileId(1)] = { owner: playerId(1), level: 0, mortgaged: false };
    const before = structuredClone(s);

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_IMPLEMENTED'); // the economy rent seam is a stub
    expect(s).toEqual(before); // failed actions are atomic — no partial application
  });

  it('landing on a mortgaged property collects no rent', () => {
    const seed = seedWithTrueDoubles(2);
    const s = editable(createGame(seed, [...NAMES]));
    s.players[0] = { ...s.players[0], position: tileId(39) };
    s.ownership[tileId(1)] = { owner: playerId(1), level: 0, mortgaged: true };

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0].cash).toBe(13_600); // 12,000 + 1,600 salary passing City Hall
    expect(result.state.turn.state).toBe('awaitingRoll'); // doubles grant the follow-up roll
  });

  it('landing on your own property collects no rent', () => {
    const seed = seedWithTrueDoubles(2);
    const s = editable(createGame(seed, [...NAMES]));
    s.players[0] = { ...s.players[0], position: tileId(39) };
    s.ownership[tileId(1)] = { owner: playerId(0), level: 0, mortgaged: false };

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0].cash).toBe(13_600); // 12,000 + 1,600 salary; rent is owed by nobody
    expect(result.state.turn.state).toBe('awaitingRoll'); // doubles grant the follow-up roll
  });

  it('landing on an unowned property opens the buy window', () => {
    const seed = seedWithTrueDoubles(2);
    const s = editable(createGame(seed, [...NAMES]));
    s.players[0] = { ...s.players[0], position: tileId(39) };

    const result = applyAction(s, { type: 'ROLL_DICE', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.turn.state).toBe('awaitingBuy');
    expect(eventsOf(result.state)).toContain('BUY_OFFERED');
  });
});

describe('sender validation', () => {
  it('rejects actions from a player who is not active', () => {
    const result = applyAction(createGame('sender-seed', [...NAMES]), { type: 'ROLL_DICE', player: playerId(1) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WRONG_PLAYER');
  });

  it('rejects auction actions from a bankrupt player', () => {
    const s = editable(fixture('auction'));
    s.players[0] = { ...s.players[0], bankrupt: true };
    const result = applyAction(s, { type: 'AUCTION_BID', player: playerId(0), amount: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WRONG_PLAYER');
  });

  it('rejects trade responses from anyone but the offeree', () => {
    const s = editable(fixture('postRoll'));
    s.pendingTrade = { from: playerId(0), to: playerId(1), give: EMPTY_LEG, want: EMPTY_LEG };
    const result = applyAction(s, { type: 'ACCEPT_TRADE', player: playerId(2) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WRONG_PLAYER');
  });
});

describe('victory (spec §3.8)', () => {
  it('the last solvent player wins by elimination', () => {
    const s = editable(fixture('postRoll'));
    s.players[1] = { ...s.players[1], bankrupt: true };
    s.players[2] = { ...s.players[2], bankrupt: true };

    const result = applyAction(s, { type: 'END_TURN', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phase).toBe('finished');
    expect(result.state.winner).toBe(playerId(0));
    expect(lastEvent(result.state).type).toBe('GAME_FINISHED');
    expect(getLegalActions(result.state, playerId(0))).toEqual([]);
  });

  it('play skips bankrupt players', () => {
    const s = editable(fixture('postRoll'));
    s.players[1] = { ...s.players[1], bankrupt: true };

    const result = applyAction(s, { type: 'END_TURN', player: playerId(0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.turn.activePlayer).toBe(playerId(2));
    expect(result.state.phase).toBe('active');
  });
});

describe('getLegalActions', () => {
  it('a free active player awaiting the roll can roll (and propose skeleton trades)', () => {
    const state = createGame('legal-seed', [...NAMES]);
    const types = getLegalActions(state, playerId(0)).map(a => a.type);
    expect(types).toContain('ROLL_DICE');
    expect(types).toContain('PROPOSE_TRADE');
    expect(types).not.toContain('END_TURN');
  });

  it('a held player at turn start may roll for doubles or pay the fine', () => {
    const types = getLegalActions(fixture('turnStart-held'), playerId(0)).map(a => a.type);
    expect(types).toEqual(['ROLL_DICE', 'PAY_JAIL_FINE']);
  });

  it('post-roll offers end-turn and development skeletons', () => {
    const types = getLegalActions(fixture('postRoll'), playerId(0)).map(a => a.type);
    expect(types).toEqual(['END_TURN', 'PROPOSE_TRADE', 'BUILD_LEVEL', 'SELL_LEVEL', 'MORTGAGE', 'LIFT_MORTGAGE']);
  });

  it('debt restricts the active player to liquidation actions', () => {
    const types = getLegalActions(fixture('debt'), playerId(0)).map(a => a.type);
    expect(types).toEqual(['SELL_LEVEL', 'MORTGAGE', 'DECLARE_BANKRUPTCY']);
  });

  it('auction bidders see the minimum next bid; passed players see nothing', () => {
    const open = fixture('auction');
    expect(getLegalActions(open, playerId(0))).toEqual([
      { type: 'AUCTION_BID', player: playerId(0), amount: 100 }, // opening minimum
      { type: 'AUCTION_PASS', player: playerId(0) },
    ]);

    const raised = fixture('auction');
    (raised as WorkingState).auction = {
      tile: tileId(1),
      highBid: { bidder: playerId(2), amount: 100 },
      passed: [playerId(1)],
    };
    expect(getLegalActions(raised, playerId(0))).toEqual([
      { type: 'AUCTION_BID', player: playerId(0), amount: 200 },
      { type: 'AUCTION_PASS', player: playerId(0) },
    ]);

    expect(getLegalActions(open, playerId(1))).toEqual([]); // already passed
  });

  it('returns nothing for finished games and bankrupt players', () => {
    expect(getLegalActions(fixture('finished'), playerId(0))).toEqual([]);
    const s = editable(createGame('bankrupt-legal-seed', [...NAMES]));
    s.players[0] = { ...s.players[0], bankrupt: true };
    expect(getLegalActions(s, playerId(0))).toEqual([]);
  });
});
