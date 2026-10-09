// Development rule module — permits, landmarks, mortgages (spec §3.4).
// STUB: the development+bankruptcy PR replaces these bodies; until then every
// handler rejects atomically with NOT_IMPLEMENTED.

import { notImplemented } from './types';
import type { GameAction, HandlerResult, WorkingState } from './types';

type BuildAction = Extract<GameAction, { type: 'BUILD_LEVEL' }>;
type SellAction = Extract<GameAction, { type: 'SELL_LEVEL' }>;
type MortgageAction = Extract<GameAction, { type: 'MORTGAGE' }>;
type LiftAction = Extract<GameAction, { type: 'LIFT_MORTGAGE' }>;

/** Build one level (permit or landmark) respecting even-build and the pool. */
export function buildLevel(_work: WorkingState, _action: BuildAction): HandlerResult {
  return { ok: false, error: notImplemented('development.buildLevel') };
}

/** Sell one level for a 50% refund of one permit cost. */
export function sellLevel(_work: WorkingState, _action: SellAction): HandlerResult {
  return { ok: false, error: notImplemented('development.sellLevel') };
}

/** Mortgage a property for 50% of its list price. */
export function mortgage(_work: WorkingState, _action: MortgageAction): HandlerResult {
  return { ok: false, error: notImplemented('development.mortgage') };
}

/** Lift a mortgage: principal + 10% fee, rounded up to 10 TD. */
export function liftMortgage(_work: WorkingState, _action: LiftAction): HandlerResult {
  return { ok: false, error: notImplemented('development.liftMortgage') };
}
