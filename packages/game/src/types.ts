// Tycoon City — Phase 1 engine core types (spec §4).
//
// Everything here is plain, JSON-round-trippable data. The determinism
// contract (identical stateHash on replay, stable across a JSON round-trip)
// means GameState must never carry Map/Set/Date or explicit `undefined`
// fields — ownership therefore uses Partial<Record<...>> so unpurchased
// tiles are absent keys rather than `undefined` values.

/**
 * Board tile index, 0–39 (spec §3.2). Nominal union so tile arithmetic must
 * pass through the runtime-checked `tileId` lift.
 */
export type TileId =
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
  | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
  | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23
  | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31
  | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39;

/** Player seat, 0–4 (2–5 players). Index into GameState.players = turn order. */
export type PlayerId = 0 | 1 | 2 | 3 | 4;

/** District development level: 0 unbuilt, 1–4 permits, 5 landmark. */
export type DevelopmentLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** One die face. */
export type Die = 1 | 2 | 3 | 4 | 5 | 6;

/** District colour group (spec §3.4 ladder). */
export type GroupId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8';

export type TileKind =
  | 'start'     // City Hall Plaza — salary on pass or land
  | 'district'  // colour-group property, developable
  | 'transit'   // depot; rent by count owned
  | 'utility'   // rent = dice sum × multiplier
  | 'tax'       // pay the bank
  | 'rest'      // no effect
  | 'safe'      // no effect (Grand Plaza)
  | 'audit'     // move to The Depot, held
  | 'jail';     // The Depot — landing here is "just visiting"

export interface Tile {
  readonly id: TileId;
  readonly name: string;
  readonly kind: TileKind;
  /** Colour group — districts only. */
  readonly group: GroupId | null;
  /** List price in TD — districts, depots, utilities; null otherwise. */
  readonly price: number | null;
  /** Amount owed to the bank — tax tiles only. */
  readonly taxAmount: number | null;
}

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  /** Integer Tycoon Dollars; never negative (debt is modelled in GameState.debt). */
  readonly cash: number;
  readonly position: TileId;
  /** > 0 → held at The Depot; counts remaining failed roll attempts before
   *  the fine is forced (spec §3.3). */
  readonly jailTurnsLeft: number;
  readonly bankrupt: boolean;
}

export interface OwnershipEntry {
  readonly owner: PlayerId;
  readonly level: DevelopmentLevel;
  readonly mortgaged: boolean;
}

/**
 * The turn state machine (spec §4). `moving` is transient: movement resolves
 * synchronously inside ROLL_DICE and the state is never persisted.
 */
export type TurnState =
  | 'turnStart'
  | 'awaitingRoll'
  | 'moving'
  | 'awaitingBuy'
  | 'auction'
  | 'postRoll'
  | 'debt';

export interface AuctionBid {
  readonly bidder: PlayerId;
  readonly amount: number;
}

/** Open ascending auction (spec §3.5). The bank never bids; passes are permanent. */
export interface ActiveAuction {
  readonly tile: TileId;
  readonly highBid: AuctionBid | null;
  readonly passed: readonly PlayerId[];
}

/** One side of a trade offer: cash and/or properties. */
export interface TradeLeg {
  readonly cash: number;
  readonly tiles: readonly TileId[];
}

export interface PendingTrade {
  /** Offering player. */
  readonly from: PlayerId;
  /** Offeree — the only player who may accept or decline. */
  readonly to: PlayerId;
  /** What `from` hands over. */
  readonly give: TradeLeg;
  /** What `to` hands over. */
  readonly want: TradeLeg;
}

export interface DebtRecord {
  readonly debtor: PlayerId;
  readonly creditor: PlayerId | 'bank';
  readonly amount: number;
}

export interface TurnContext {
  readonly activePlayer: PlayerId;
  readonly state: TurnState;
  /** Consecutive doubles this turn: 0–2; a third sends the player to The Depot. */
  readonly doublesRun: number;
}

export type TurnEndReason =
  | 'voluntary'
  | 'audit'
  | 'third-doubles'
  | 'jail-attempt-failed'
  | 'jail-forced-move';

/**
 * Append-only, sequence-numbered event log. Events record what happened;
 * the log is part of the hashed state, so replay reproduces it byte-exactly.
 */
export type GameEvent =
  | { readonly seq: number; readonly type: 'GAME_STARTED'; readonly seed: string; readonly playerOrder: readonly string[] }
  | { readonly seq: number; readonly type: 'TURN_STARTED'; readonly player: PlayerId }
  | { readonly seq: number; readonly type: 'TURN_ENDED'; readonly player: PlayerId; readonly reason: TurnEndReason }
  | { readonly seq: number; readonly type: 'DICE_ROLLED'; readonly player: PlayerId; readonly d1: Die; readonly d2: Die; readonly doubles: boolean }
  | { readonly seq: number; readonly type: 'MOVED'; readonly player: PlayerId; readonly from: TileId; readonly to: TileId; readonly passedStart: boolean }
  | { readonly seq: number; readonly type: 'SALARY_COLLECTED'; readonly player: PlayerId; readonly amount: number }
  | { readonly seq: number; readonly type: 'BUY_OFFERED'; readonly player: PlayerId; readonly tile: TileId; readonly price: number }
  | { readonly seq: number; readonly type: 'SENT_TO_DEPOT'; readonly player: PlayerId; readonly reason: 'audit' | 'third-doubles'; readonly term: number }
  | { readonly seq: number; readonly type: 'JAIL_FINE_PAID'; readonly player: PlayerId; readonly amount: number; readonly kind: 'voluntary' | 'forced' }
  | { readonly seq: number; readonly type: 'JAIL_ROLL_FAILED'; readonly player: PlayerId; readonly attemptsLeft: number }
  | { readonly seq: number; readonly type: 'RELEASED_FROM_JAIL'; readonly player: PlayerId; readonly by: 'fine' | 'doubles' | 'forced' };

/** Distributive Omit: keeps unions intact where plain Omit would collapse them. */
export type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A GameEvent payload before it is stamped with its sequence number. */
export type GameEventInit = DistributedOmit<GameEvent, 'seq'>;

export type GameErrorCode =
  | 'WRONG_PHASE'        // action type is not routable from the current turn state
  | 'WRONG_PLAYER'       // sender is not the player this action belongs to
  | 'GAME_NOT_ACTIVE'    // phase is lobby/finished
  | 'INSUFFICIENT_FUNDS' // payment exceeds available cash
  | 'NOT_HELD'           // jail action attempted while not held
  | 'NO_PENDING_TRADE'   // accept/decline with no pending trade
  | 'INVALID_BID'        // bid below minimum or increment
  | 'ALREADY_PASSED'     // auction participant bid/pass after passing
  | 'INVALID_TILE'       // tile argument outside a legal set
  | 'NOT_IMPLEMENTED';   // rule-module seam not yet built (later Phase 1 PR)

export interface GameError {
  readonly code: GameErrorCode;
  readonly message: string;
}

export type ApplyResult =
  | { readonly ok: true; readonly state: GameState }
  | { readonly ok: false; readonly error: GameError };

/**
 * Rule-module handler contract (economy/auction/trading/development/
 * bankruptcy): mutate the passed working copy in place and report success,
 * or return a typed error — the caller then discards the working copy, so
 * failed actions are atomic (caller state untouched).
 */
export type HandlerResult = { readonly ok: true } | { readonly ok: false; readonly error: GameError };

/** Stub-era helper: the typed rejection every rule-module seam returns until its PR lands. */
export function notImplemented(handler: string): GameError {
  return {
    code: 'NOT_IMPLEMENTED',
    message: `${handler} is a rule-module seam — implemented by a later Phase 1 engine PR (economy/auction/trading/development/bankruptcy).`,
  };
}

export interface GameState {
  readonly seed: string;
  /** xoshiro128** state as 32 hex chars; advanced only by engine code (spec §3.9). */
  readonly rngState: string;
  /** Turn order. Index === PlayerId. */
  readonly players: readonly Player[];
  /** Unpurchased tiles are absent keys (never explicit undefined). */
  readonly ownership: Readonly<Partial<Record<TileId, OwnershipEntry>>>;
  readonly phase: 'lobby' | 'active' | 'finished';
  readonly turn: TurnContext;
  readonly auction: ActiveAuction | null;
  readonly pendingTrade: PendingTrade | null;
  readonly debt: DebtRecord | null;
  /** Append-only; seq numbers are contiguous from 0. */
  readonly log: readonly GameEvent[];
  readonly winner: PlayerId | null;
}

/** View of an ownership map — board helpers take this so they never depend on full GameState. */
export type OwnershipView = GameState['ownership'];

/** Runtime-checked lift from number to TileId (single guarded cast for movement arithmetic). */
export function tileId(n: number): TileId {
  if (!Number.isInteger(n) || n < 0 || n > 39) throw new RangeError(`Invalid tile id: ${n}`);
  return n as TileId;
}

/** Runtime-checked lift from number to PlayerId. */
export function playerId(n: number): PlayerId {
  if (!Number.isInteger(n) || n < 0 || n > 4) throw new RangeError(`Invalid player id: ${n}`);
  return n as PlayerId;
}
