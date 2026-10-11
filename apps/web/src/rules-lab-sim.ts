// Tycoon City — Rules Lab headless simulation (spec §5).
//
// The lab drives the same budget-aware bot policy the fuzz harness uses
// (packages/game/src/bot.ts) through the engine as a deterministic step
// loop: seats are polled in fixed id order and the first offered action is
// applied — no driver-side randomness, so the only randomness in a lab game
// is the engine's own seeded PRNG and the same seed replays the same winner
// on any machine (spec §3.9). Everything here is pure: no clocks, no DOM.

import { applyAction, createGame, stateHash } from '@resolveops/game/engine';
import { pickAction } from '@resolveops/game/bot';
import { DISTRICT_GROUPS, getTile } from '@resolveops/game/board';
import { netWorth } from '@resolveops/game/economy';
import type { GameEvent, GameState, PlayerId } from '@resolveops/game/types';
import { tileId } from '@resolveops/game/types';

/** Seat names — shared with the fuzz harness's driver for a consistent story. */
export const SEAT_NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli'] as const;

/**
 * Hard ceiling on applied actions per game — the fuzz harness's own bound
 * (fuzz.test.ts MAX_STEPS). A game that hits it is surfaced as a stalled
 * run, never spun forever.
 */
export const MAX_GAME_STEPS = 5_000;

/** Build a fresh seeded game with the requested seat count (2–5). */
export function createLabGame(seed: string, playerCount: number): GameState {
  return createGame(seed, SEAT_NAMES.slice(0, playerCount));
}

export type StepResult =
  | { readonly kind: 'stepped'; readonly state: GameState; readonly actor: PlayerId }
  | { readonly kind: 'finished'; readonly state: GameState }
  | { readonly kind: 'stalled'; readonly state: GameState; readonly reason: string };

/**
 * One deterministic bot step: poll solvent seats in id order and apply the
 * first action the policy offers. A finished game stays finished; a stall
 * (no seat has a move, or the engine rejects the policy's intent) is
 * returned as a typed outcome rather than swallowed.
 */
export function stepBotGame(state: GameState): StepResult {
  if (state.phase === 'finished') return { kind: 'finished', state };
  for (const seat of state.players) {
    if (seat.bankrupt) continue;
    const action = pickAction(state, seat.id);
    if (action === null) continue;
    const result = applyAction(state, action);
    if (result.ok) return { kind: 'stepped', state: result.state, actor: seat.id };
    return {
      kind: 'stalled',
      state,
      reason: `engine rejected ${action.type} from ${seat.name}: ${result.error.code} — ${result.error.message}`,
    };
  }
  return {
    kind: 'stalled',
    state,
    reason: `no bot has a move in turn state "${state.turn.state}" — the game would stall`,
  };
}

export interface HeadlessRun {
  readonly state: GameState;
  /** Applied actions (not polls) taken before the run ended. */
  readonly steps: number;
  readonly endedBy: 'finished' | 'stalled' | 'step-cap';
  readonly reason: string | null;
}

/** Drive one seeded game to completion — the lab's loop minus the timing. */
export function runHeadlessGame(seed: string, playerCount: number): HeadlessRun {
  let state = createLabGame(seed, playerCount);
  let applied = 0;
  while (state.phase !== 'finished' && applied < MAX_GAME_STEPS) {
    const step = stepBotGame(state);
    if (step.kind === 'stepped') {
      state = step.state;
      applied++;
      continue;
    }
    if (step.kind === 'finished') {
      return { state: step.state, steps: applied, endedBy: 'finished', reason: null };
    }
    return { state: step.state, steps: applied, endedBy: 'stalled', reason: step.reason };
  }
  return state.phase === 'finished'
    ? { state, steps: applied, endedBy: 'finished', reason: null }
    : { state, steps: applied, endedBy: 'step-cap', reason: `no winner within ${MAX_GAME_STEPS} actions` };
}

/** Display label for a turn state (the raw names are engine-internal). */
export const TURN_STATE_LABELS: Record<GameState['turn']['state'], string> = {
  turnStart: 'turn start',
  awaitingRoll: 'awaiting roll',
  moving: 'moving',
  awaitingBuy: 'buy decision',
  auction: 'auction',
  postRoll: 'post-roll',
  debt: 'debt',
};

/** Integer TD with thousands separators — locale-independent on purpose. */
export function formatTd(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}${Math.abs(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} TD`;
}

export interface PlayerSummary {
  readonly id: PlayerId;
  readonly name: string;
  readonly cash: number;
  readonly worth: number;
  readonly tileName: string;
  readonly atDepot: boolean;
  readonly bankrupt: boolean;
}

/** Live per-seat metrics for the lab (cash, net worth, position, jail). */
export function summarizePlayers(state: GameState): PlayerSummary[] {
  return state.players.map(p => ({
    id: p.id,
    name: p.name,
    cash: p.cash,
    worth: netWorth(p.id, state),
    tileName: getTile(p.position).name,
    atDepot: p.jailTurnsLeft > 0,
    bankrupt: p.bankrupt,
  }));
}

export interface GroupRow {
  readonly id: string;
  readonly name: string;
  /** Set only when one player owns every district in the group. */
  readonly owner: PlayerId | null;
  /** Development level per tile in board order; 5 renders as a landmark. */
  readonly levels: readonly number[];
  readonly landmarks: number;
  readonly mortgaged: number;
}

/** Ownership-by-district-group rows for the lab table. */
export function summarizeGroups(state: GameState): GroupRow[] {
  return Object.values(DISTRICT_GROUPS).map(group => {
    const deeds = group.tiles.map(t => state.ownership[t]);
    const complete = deeds.every(d => d !== undefined);
    const owner = complete && deeds[0] !== undefined ? deeds[0].owner : null;
    return {
      id: group.id,
      name: group.name,
      owner,
      levels: deeds.map(d => d?.level ?? 0),
      landmarks: deeds.filter(d => d?.level === 5).length,
      mortgaged: deeds.filter(d => d?.mortgaged === true).length,
    };
  });
}

export interface SpecialDeedCount {
  readonly player: PlayerId;
  readonly depots: number;
  readonly utilities: number;
}

/** Transit-depot and utility ownership per seat, in seat order. */
export function specialDeedCounts(state: GameState): SpecialDeedCount[] {
  const rows = state.players.map(p => ({ player: p.id, depots: 0, utilities: 0 }));
  for (const [key, deed] of Object.entries(state.ownership)) {
    if (deed === undefined) continue;
    const tile = getTile(tileId(Number(key)));
    if (tile.kind === 'transit') rows[deed.owner].depots++;
    if (tile.kind === 'utility') rows[deed.owner].utilities++;
  }
  return rows;
}

/** One-line human text for an engine event, resolved against its own state. */
export function describeEvent(ev: GameEvent, state: GameState): string {
  const name = (pid: PlayerId) => state.players[pid]?.name ?? `seat ${pid}`;
  switch (ev.type) {
    case 'GAME_STARTED':
      return `new game — seed "${ev.seed}" · seats ${ev.playerOrder.join(', ')}`;
    case 'TURN_STARTED':
      return `${name(ev.player)}'s turn`;
    case 'TURN_ENDED':
      return `${name(ev.player)}'s turn ended (${ev.reason})`;
    case 'DICE_ROLLED':
      return `${name(ev.player)} rolled ${ev.d1} + ${ev.d2} = ${ev.d1 + ev.d2}${ev.doubles ? ' — doubles' : ''}`;
    case 'MOVED':
      return `${name(ev.player)} moved to ${getTile(ev.to).name}`;
    case 'SALARY_COLLECTED':
      return `${name(ev.player)} collected ${formatTd(ev.amount)} salary`;
    case 'BUY_OFFERED':
      return `${name(ev.player)} may buy ${getTile(ev.tile).name} for ${formatTd(ev.price)}`;
    case 'SENT_TO_DEPOT':
      return `${name(ev.player)} was sent to The Depot (${ev.reason}) — term ${ev.term}`;
    case 'JAIL_FINE_PAID':
      return `${name(ev.player)} paid a ${formatTd(ev.amount)} fine (${ev.kind})`;
    case 'JAIL_ROLL_FAILED':
      return `${name(ev.player)} failed the jail roll — ${ev.attemptsLeft} attempts left`;
    case 'RELEASED_FROM_JAIL':
      return `${name(ev.player)} left The Depot by ${ev.by}`;
    case 'TAX_COLLECTED':
      return `${name(ev.player)} paid ${formatTd(ev.amount)} at ${getTile(ev.tile).name}`;
    case 'DEBT_ENTERED':
      return `${name(ev.player)} owes ${formatTd(ev.amount)} to ${ev.creditor === 'bank' ? 'the bank' : name(ev.creditor)}`;
    case 'GAME_FINISHED':
      return `${name(ev.winner)} wins the game`;
  }
}
