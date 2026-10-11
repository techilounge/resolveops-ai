// Development rule module — permits, landmarks, mortgages (spec §3.4).
//
// Seam contract (from the core FSM): BUILD_LEVEL / SELL_LEVEL / MORTGAGE /
// LIFT_MORTGAGE arrive here from the postRoll window, and the two
// liquidation moves also from the debt state, which the FSM gates to
// SELL_LEVEL, MORTGAGE and DECLARE_BANKRUPTCY (spec §3.7). Handlers mutate
// the working copy in place and report success; a typed failure discards
// the copy, so failed actions are atomic.
//
// Scarcity accounting is derived, never stored: the bank's remaining units
// are SCARCITY minus the units embodied in built districts. The §3.4 flows
// then fall out of the arithmetic — a landmark build (level 4 → 5) stops
// the deed holding its four permit units, which is exactly "returns the
// property's 4 permit units to the bank", and selling a level drops the
// deed's embodied count, returning its unit. Deriving the pool keeps
// GameState free of another field and the determinism contract untouched.
//
// Interpretations pinned where docs/RULES.md is silent (each test-backed):
// - A landmark build costs no additional cash — the four permits already
//   embody the investment, matching economy.netWorth's landmark valuation.
// - Mortgaging a developed district is legal (the doc names no
//   sell-the-buildings-first rule); a mortgaged group member still blocks
//   development.
// - Even-build scopes to the tiles the OWNER holds in the group: trades can
//   split a group across owners with divergent levels.

import {
  DISTRICT_GROUPS,
  PERMIT_UNITS_RETURNED_BY_LANDMARK,
  SCARCITY,
  getTile,
  isBuyableKind,
  ownsFullGroup,
} from './board';
import { mortgageLiftCost, mortgageValue } from './economy';
import type {
  DevelopmentLevel,
  GameAction,
  GameError,
  GameErrorCode,
  GroupId,
  HandlerResult,
  OwnershipView,
  PlayerId,
  TileId,
  TurnState,
  WorkingState,
} from './types';
import { tileId } from './types';

type BuildAction = Extract<GameAction, { type: 'BUILD_LEVEL' }>;
type SellAction = Extract<GameAction, { type: 'SELL_LEVEL' }>;
type MortgageAction = Extract<GameAction, { type: 'MORTGAGE' }>;
type LiftAction = Extract<GameAction, { type: 'LIFT_MORTGAGE' }>;

/** Share of one permit cost refunded per level sold (spec §3.4: "50%"). */
const LEVEL_SELL_REFUND = 0.5;
/** Top of the ladder: levels 1–4 are permits, 5 is the landmark. */
const MAX_LEVEL: DevelopmentLevel = 5;

function err(code: GameErrorCode, message: string): GameError {
  return { code, message };
}

/** Permit units embodied in one deed's level; a landmark embodies the four the bank took back. */
function deedPermitUnits(level: DevelopmentLevel): number {
  return level === MAX_LEVEL ? PERMIT_UNITS_RETURNED_BY_LANDMARK : level;
}

/** Permit units currently embodied in built districts — the bank's spent stock (spec §3.4). */
export function permitUnitsInCirculation(ownership: OwnershipView): number {
  let units = 0;
  for (const key of Object.keys(ownership)) {
    const tile = tileId(Number(key));
    const deed = ownership[tile];
    if (!deed || getTile(tile).group === null) continue;
    units += deedPermitUnits(deed.level);
  }
  return units;
}

/** Landmark units currently standing on districts (spec §3.4). */
export function landmarkUnitsInCirculation(ownership: OwnershipView): number {
  let units = 0;
  for (const key of Object.keys(ownership)) {
    const tile = tileId(Number(key));
    const deed = ownership[tile];
    if (!deed || getTile(tile).group === null) continue;
    if (deed.level === MAX_LEVEL) units += 1;
  }
  return units;
}

/** Bank stock left: 40 minus embodied permit units (spec §3.4). */
export function permitUnitsRemaining(ownership: OwnershipView): number {
  return SCARCITY.permitUnits - permitUnitsInCirculation(ownership);
}

/** Bank stock left: 8 minus standing landmarks (spec §3.4). */
export function landmarkUnitsRemaining(ownership: OwnershipView): number {
  return SCARCITY.landmarkUnits - landmarkUnitsInCirculation(ownership);
}

/** Levels `pid` holds in `group` — the even-build rule scopes to the owner's holding. */
function ownedGroupLevels(ownership: OwnershipView, group: GroupId, pid: PlayerId): number[] {
  const levels: number[] = [];
  for (const t of DISTRICT_GROUPS[group].tiles) {
    const deed = ownership[t];
    if (deed && deed.owner === pid) levels.push(deed.level);
  }
  return levels;
}

/**
 * Build one level (permit or landmark) respecting even-build and the pools
 * (spec §3.4). Precedence: board legality → pool stock → cash.
 */
export function buildLevel(work: WorkingState, action: BuildAction): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) {
    return { ok: false, error: err('WRONG_PLAYER', `Only the active player may build; ${action.player} is not active.`) };
  }
  const tile = action.tile;
  const info = getTile(tile);
  const deed = work.ownership[tile];
  if (info.kind !== 'district' || !deed) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} is not a district the player owns, so it cannot be developed.`) };
  }
  if (deed.owner !== pid) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} is owned by ${work.players[deed.owner].name}, not the active player.`) };
  }
  const groupId = info.group;
  if (groupId === null) {
    return { ok: false, error: err('INTERNAL', `${info.name} is a district without a colour group.`) };
  }
  const group = DISTRICT_GROUPS[groupId];
  if (!ownsFullGroup(work.ownership, groupId, pid)) {
    return { ok: false, error: err('INVALID_TILE', `Developing ${info.name} requires holding every district of ${group.name}.`) };
  }
  if (group.tiles.some(t => work.ownership[t]?.mortgaged === true)) {
    return { ok: false, error: err('INVALID_TILE', `A mortgaged district in ${group.name} blocks development until the mortgage is lifted.`) };
  }
  const levels = ownedGroupLevels(work.ownership, groupId, pid);
  if (deed.level !== Math.min(...levels)) {
    return { ok: false, error: err('INVALID_TILE', `Even-build rule: only a ${group.name} district at the group's lowest level (${Math.min(...levels)}) may be built on.`) };
  }
  if (deed.level >= MAX_LEVEL) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} already stands at the landmark level.`) };
  }
  const landmark = deed.level === MAX_LEVEL - 1;
  if (landmark ? landmarkUnitsRemaining(work.ownership) < 1 : permitUnitsRemaining(work.ownership) < 1) {
    return {
      ok: false,
      error: err('INVALID_TILE', landmark ? 'The bank has no landmark units left (spec §3.4 pool of 8).' : 'The bank has no permit units left (spec §3.4 pool of 40).'),
    };
  }
  // A landmark build spends no additional cash: the four permits already
  // embody the investment (economy.netWorth values a landmark the same way).
  const cost = landmark ? 0 : group.permitCost;
  const player = work.players[pid];
  if (player.cash < cost) {
    return { ok: false, error: err('INSUFFICIENT_FUNDS', `Building on ${info.name} costs ${cost} TD; ${player.name} holds ${player.cash} TD.`) };
  }
  work.players[pid] = { ...player, cash: player.cash - cost };
  // Guarded by the level < MAX_LEVEL check above: the new level is 1–5.
  work.ownership[tile] = { ...deed, level: (deed.level + 1) as DevelopmentLevel };
  return { ok: true };
}

/**
 * Sell one level for a 50% refund of one permit cost (spec §3.4) — one
 * permit cost's half even when selling the landmark itself. The sold
 * level's scarcity unit returns to the bank automatically; the pool is
 * derived from embodied units (module header).
 */
export function sellLevel(work: WorkingState, action: SellAction): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) {
    return { ok: false, error: err('WRONG_PLAYER', `Only the active player may sell a level; ${action.player} is not active.`) };
  }
  const tile = action.tile;
  const info = getTile(tile);
  const deed = work.ownership[tile];
  if (info.kind !== 'district' || !deed) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} is not a district the player owns, so it has no level to sell.`) };
  }
  if (deed.owner !== pid) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} is owned by ${work.players[deed.owner].name}, not the active player.`) };
  }
  if (deed.level === 0) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} has no development level to sell.`) };
  }
  const groupId = info.group;
  if (groupId === null) {
    return { ok: false, error: err('INTERNAL', `${info.name} is a district without a colour group.`) };
  }
  const group = DISTRICT_GROUPS[groupId];
  const levels = ownedGroupLevels(work.ownership, groupId, pid);
  if (deed.level !== Math.max(...levels)) {
    return { ok: false, error: err('INVALID_TILE', `Even-build rule: only a ${group.name} district at the group's highest level (${Math.max(...levels)}) may be sold down.`) };
  }
  const refund = Math.floor(group.permitCost * LEVEL_SELL_REFUND);
  const player = work.players[pid];
  work.players[pid] = { ...player, cash: player.cash + refund };
  // Guarded by the level > 0 check above: the new level is 0–4.
  work.ownership[tile] = { ...deed, level: (deed.level - 1) as DevelopmentLevel };
  settleDebtIfCovered(work, pid);
  return { ok: true };
}

/**
 * Mortgage a property for 50% of its list price (spec §3.4). Rules-as-
 * written: docs/RULES.md names no sell-the-buildings-first rule, so a
 * developed district mortgages at 50% of its LIST price with levels intact;
 * a mortgaged member still blocks group development.
 */
export function mortgage(work: WorkingState, action: MortgageAction): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) {
    return { ok: false, error: err('WRONG_PLAYER', `Only the active player may mortgage; ${action.player} is not active.`) };
  }
  const tile = action.tile;
  const info = getTile(tile);
  const deed = work.ownership[tile];
  if (!isBuyableKind(info.kind) || !deed) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} is not a property the player owns, so it cannot be mortgaged.`) };
  }
  if (deed.owner !== pid) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} is owned by ${work.players[deed.owner].name}, not the active player.`) };
  }
  if (deed.mortgaged) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} is already mortgaged.`) };
  }
  const value = mortgageValue(tile);
  const player = work.players[pid];
  work.players[pid] = { ...player, cash: player.cash + value };
  work.ownership[tile] = { ...deed, mortgaged: true };
  settleDebtIfCovered(work, pid);
  return { ok: true };
}

/** Lift a mortgage: principal + 10% fee, rounded up to 10 TD (spec §3.4). */
export function liftMortgage(work: WorkingState, action: LiftAction): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) {
    return { ok: false, error: err('WRONG_PLAYER', `Only the active player may lift a mortgage; ${action.player} is not active.`) };
  }
  const tile = action.tile;
  const info = getTile(tile);
  const deed = work.ownership[tile];
  if (!isBuyableKind(info.kind) || !deed) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} is not a property the player owns, so there is no mortgage to lift.`) };
  }
  if (deed.owner !== pid) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} is owned by ${work.players[deed.owner].name}, not the active player.`) };
  }
  if (!deed.mortgaged) {
    return { ok: false, error: err('INVALID_TILE', `${info.name} is not mortgaged.`) };
  }
  const cost = mortgageLiftCost(tile);
  const player = work.players[pid];
  if (player.cash < cost) {
    return { ok: false, error: err('INSUFFICIENT_FUNDS', `Lifting the mortgage on ${info.name} costs ${cost} TD; ${player.name} holds ${player.cash} TD.`) };
  }
  work.players[pid] = { ...player, cash: player.cash - cost };
  work.ownership[tile] = { ...deed, mortgaged: false };
  return { ok: true };
}

/**
 * Settle the outstanding debt once liquidation has raised the debtor's cash
 * to cover it (spec §3.7: liquidation exists to service the debt, and the
 * action union has no separate settle action). Payment is exact — any
 * remainder stays with the debtor — and the turn resumes the post-landing
 * window the debt had suspended.
 */
function settleDebtIfCovered(work: WorkingState, pid: PlayerId): void {
  const debt = work.debt;
  if (!debt || debt.debtor !== pid) return;
  const debtor = work.players[pid];
  if (debtor.cash < debt.amount) return;
  work.players[pid] = { ...debtor, cash: debtor.cash - debt.amount };
  if (debt.creditor !== 'bank') {
    const payee = work.players[debt.creditor];
    work.players[debt.creditor] = { ...payee, cash: payee.cash + debt.amount };
  }
  work.debt = null;
  work.turn = { ...work.turn, state: resumeAfterDebt(work) };
}

/**
 * The window a settled debt resumes: the landing roll earns another roll
 * only when it was a free roll of doubles — doublesRun AND the most recent
 * DICE_ROLLED event, since neither signal alone disambiguates (the same
 * settlement rule economy.collectRent defers by entering debt instead of
 * settling the window).
 */
function resumeAfterDebt(work: WorkingState): TurnState {
  if (work.turn.doublesRun === 0) return 'postRoll';
  for (let i = work.log.length - 1; i >= 0; i--) {
    const event = work.log[i];
    if (event.type === 'DICE_ROLLED') return event.doubles ? 'awaitingRoll' : 'postRoll';
  }
  // Unreachable via applyAction: a debt only follows a landing, which is
  // always preceded by its roll. Fall back conservatively.
  return 'postRoll';
}
