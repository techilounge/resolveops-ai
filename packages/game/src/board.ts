// Tycoon City — Phase 1 board and economy tables (spec §3.2, §3.4) as typed
// data. Every number in the rules lives here; the turn FSM and the rule
// modules read from these tables rather than embedding literals.

import type { DevelopmentLevel, GroupId, OwnershipView, PlayerId, Tile, TileId, TileKind } from './types';

export const BOARD_SIZE = 40;

/** Player economics (spec §3.1, §3.3, §3.4). */
export const STARTING_CASH = 12_000;
export const SALARY = 1_600;
export const JAIL_FINE = 500;
/** Failed roll attempts allowed before the fine is forced (spec §3.3). */
export const JAIL_TERM = 3;

/** Open ascending auction (spec §3.5). */
export const AUCTION_MIN_BID = 100;
export const AUCTION_MIN_INCREMENT = 100;

/** Mortgage economics (spec §3.4): receive 50% of list; lift = principal +10%, rounded up to 10 TD. */
export const MORTGAGE_LTV = 0.5;
export const MORTGAGE_LIFT_MULTIPLIER = 1.1;
export const MORTGAGE_LIFT_ROUND_TO = 10;

/** Scarcity pool (spec §3.4): bank starts with 40 permit and 8 landmark units. */
export const SCARCITY = { permitUnits: 40, landmarkUnits: 8 } as const;
export const PERMIT_UNITS_PER_LEVEL = 1;
export const PERMIT_UNITS_RETURNED_BY_LANDMARK = 4;

export interface DistrictGroup {
  readonly id: GroupId;
  readonly name: string;
  /** Base rent per district tile, in the same order as `tiles`. */
  readonly baseRents: readonly number[];
  /** Rent multipliers for levels 1–4 (permits) and 5 (landmark), in order. */
  readonly levelMultipliers: readonly [number, number, number, number, number];
  readonly permitCost: number;
  readonly tiles: readonly TileId[];
}

/** The eight district colour groups and their rent ladders (spec §3.4). */
export const DISTRICT_GROUPS: Readonly<Record<GroupId, DistrictGroup>> = {
  G1: { id: 'G1', name: 'Midtown Docks', baseRents: [40, 50], levelMultipliers: [8, 22, 50, 75, 95], permitCost: 400, tiles: [1, 2] },
  G2: { id: 'G2', name: 'Lantern Quarter', baseRents: [70, 80, 90], levelMultipliers: [7, 18, 40, 60, 80], permitCost: 600, tiles: [4, 6, 7] },
  G3: { id: 'G3', name: 'Printers Row', baseRents: [120, 120, 140], levelMultipliers: [6, 15, 32, 50, 68], permitCost: 800, tiles: [9, 10, 12] },
  G4: { id: 'G4', name: 'Garden Terraces', baseRents: [180, 180, 200], levelMultipliers: [5, 13, 27, 42, 58], permitCost: 1_000, tiles: [15, 16, 18] },
  G5: { id: 'G5', name: 'Transit Junction', baseRents: [250, 250, 280], levelMultipliers: [5, 12, 24, 37, 50], permitCost: 1_200, tiles: [20, 21, 23] },
  G6: { id: 'G6', name: 'Civic Hill', baseRents: [350, 350, 380], levelMultipliers: [4, 10, 20, 31, 42], permitCost: 1_500, tiles: [25, 26, 28] },
  G7: { id: 'G7', name: 'Skyline Core', baseRents: [500, 500, 560], levelMultipliers: [4, 9, 17, 26, 35], permitCost: 1_800, tiles: [30, 31, 33] },
  G8: { id: 'G8', name: 'Aurora Waterfront', baseRents: [800, 850], levelMultipliers: [3, 8, 15, 23, 30], permitCost: 2_200, tiles: [36, 38] },
};

/** Depot (transit) rent by number of depots owned, in order (spec §3.4). */
export const DEPOT_RENTS: readonly [number, number, number, number] = [400, 900, 1_800, 3_000];

/** Utility rent = dice sum × multiplier: one utility → 40, both → 100 (spec §3.4). */
export const UTILITY_MULTIPLIERS: readonly [number, number] = [40, 100];

/** District rent ×2 when the owner holds the full colour set unbuilt (spec §3.4). */
export const FULL_SET_UNBUILT_MULTIPLIER = 2;

/** The 40-tile board, verbatim from spec §3.2. */
export const TILES: readonly Tile[] = [
  { id: 0, name: 'City Hall Plaza', kind: 'start', group: null, price: null, taxAmount: null },
  { id: 1, name: 'Midtown Docks I', kind: 'district', group: 'G1', price: 900, taxAmount: null },
  { id: 2, name: 'Midtown Docks II', kind: 'district', group: 'G1', price: 1_100, taxAmount: null },
  { id: 3, name: 'Harbor Plaza', kind: 'rest', group: null, price: null, taxAmount: null },
  { id: 4, name: 'Lantern Quarter I', kind: 'district', group: 'G2', price: 1_400, taxAmount: null },
  { id: 5, name: 'North Depot', kind: 'transit', group: null, price: 1_600, taxAmount: null },
  { id: 6, name: 'Lantern Quarter II', kind: 'district', group: 'G2', price: 1_600, taxAmount: null },
  { id: 7, name: 'Lantern Quarter III', kind: 'district', group: 'G2', price: 1_800, taxAmount: null },
  { id: 8, name: 'Exchange Plaza', kind: 'rest', group: null, price: null, taxAmount: null },
  { id: 9, name: 'Printers Row I', kind: 'district', group: 'G3', price: 2_000, taxAmount: null },
  { id: 10, name: 'Printers Row II', kind: 'district', group: 'G3', price: 2_000, taxAmount: null },
  { id: 11, name: 'Power Grid', kind: 'utility', group: null, price: 1_400, taxAmount: null },
  { id: 12, name: 'Printers Row III', kind: 'district', group: 'G3', price: 2_200, taxAmount: null },
  { id: 13, name: 'Revenue Office', kind: 'tax', group: null, price: null, taxAmount: 1_200 },
  { id: 14, name: 'East Depot', kind: 'transit', group: null, price: 1_600, taxAmount: null },
  { id: 15, name: 'Garden Terraces I', kind: 'district', group: 'G4', price: 2_400, taxAmount: null },
  { id: 16, name: 'Garden Terraces II', kind: 'district', group: 'G4', price: 2_400, taxAmount: null },
  { id: 17, name: 'Meadow Plaza', kind: 'rest', group: null, price: null, taxAmount: null },
  { id: 18, name: 'Garden Terraces III', kind: 'district', group: 'G4', price: 2_600, taxAmount: null },
  { id: 19, name: 'Grand Plaza', kind: 'safe', group: null, price: null, taxAmount: null },
  { id: 20, name: 'Transit Junction I', kind: 'district', group: 'G5', price: 2_800, taxAmount: null },
  { id: 21, name: 'Transit Junction II', kind: 'district', group: 'G5', price: 2_800, taxAmount: null },
  { id: 22, name: 'Luxury Levy', kind: 'tax', group: null, price: null, taxAmount: 900 },
  { id: 23, name: 'Transit Junction III', kind: 'district', group: 'G5', price: 3_000, taxAmount: null },
  { id: 24, name: 'South Depot', kind: 'transit', group: null, price: 1_600, taxAmount: null },
  { id: 25, name: 'Civic Hill I', kind: 'district', group: 'G6', price: 3_200, taxAmount: null },
  { id: 26, name: 'Civic Hill II', kind: 'district', group: 'G6', price: 3_200, taxAmount: null },
  { id: 27, name: 'Summit Plaza', kind: 'rest', group: null, price: null, taxAmount: null },
  { id: 28, name: 'Civic Hill III', kind: 'district', group: 'G6', price: 3_400, taxAmount: null },
  { id: 29, name: 'Waterworks', kind: 'utility', group: null, price: 1_400, taxAmount: null },
  { id: 30, name: 'Skyline Core I', kind: 'district', group: 'G7', price: 3_800, taxAmount: null },
  { id: 31, name: 'Skyline Core II', kind: 'district', group: 'G7', price: 3_800, taxAmount: null },
  { id: 32, name: 'Terrace Plaza', kind: 'rest', group: null, price: null, taxAmount: null },
  { id: 33, name: 'Skyline Core III', kind: 'district', group: 'G7', price: 4_200, taxAmount: null },
  { id: 34, name: 'West Depot', kind: 'transit', group: null, price: 1_600, taxAmount: null },
  { id: 35, name: 'Audit Office', kind: 'audit', group: null, price: null, taxAmount: null },
  { id: 36, name: 'Aurora Waterfront I', kind: 'district', group: 'G8', price: 4_800, taxAmount: null },
  { id: 37, name: 'Riverview Plaza', kind: 'rest', group: null, price: null, taxAmount: null },
  { id: 38, name: 'Aurora Waterfront II', kind: 'district', group: 'G8', price: 5_200, taxAmount: null },
  { id: 39, name: 'The Depot', kind: 'jail', group: null, price: null, taxAmount: null },
];

export function getTile(id: TileId): Tile {
  return TILES[id];
}

/** Tiles that can be owned and yield rent: districts, depots, utilities. */
export function isBuyableKind(kind: TileKind): boolean {
  return kind === 'district' || kind === 'transit' || kind === 'utility';
}

export function groupTiles(group: GroupId): readonly TileId[] {
  return DISTRICT_GROUPS[group].tiles;
}

function countOwned(ownership: OwnershipView, kind: TileKind, owner: PlayerId): number {
  return TILES.filter(t => t.kind === kind && ownership[t.id]?.owner === owner).length;
}

/** Whether `owner` holds every district of the colour group (spec §3.4). */
export function ownsFullGroup(ownership: OwnershipView, group: GroupId, owner: PlayerId): boolean {
  return DISTRICT_GROUPS[group].tiles.every(t => ownership[t]?.owner === owner);
}

/**
 * Rent due to `owner` on `tile` after a dice sum of `diceSum` — a pure
 * projection of the §3.4 tables: district ladder (level 0 solo vs full-set
 * ×2, permit levels 1–4, landmark 5), depot tiers by count owned, utility
 * formula by dice sum. Mortgaged properties collect 0.
 */
export function rentDue(tile: TileId, owner: PlayerId, diceSum: number, ownership: OwnershipView): number {
  const entry = ownership[tile];
  if (!entry || entry.owner !== owner || entry.mortgaged) return 0;
  const t = getTile(tile);
  if (t.kind === 'transit') {
    const n = countOwned(ownership, 'transit', owner);
    return DEPOT_RENTS[n - 1] ?? 0;
  }
  if (t.kind === 'utility') {
    const n = countOwned(ownership, 'utility', owner);
    const multiplier = UTILITY_MULTIPLIERS[n - 1] ?? 0;
    return diceSum * multiplier;
  }
  if (t.kind === 'district') {
    const groupId = t.group;
    if (groupId === null) return 0;
    const group = DISTRICT_GROUPS[groupId];
    const base = group.baseRents[group.tiles.indexOf(tile)] ?? 0;
    const level: DevelopmentLevel = entry.level;
    if (level === 0) {
      return ownsFullGroup(ownership, groupId, owner) ? base * FULL_SET_UNBUILT_MULTIPLIER : base;
    }
    return base * (group.levelMultipliers[level - 1] ?? 0);
  }
  return 0;
}
