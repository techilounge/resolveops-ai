// Economy rule module — property purchase and rent collection (spec §3.4).
// STUB: the economy PR (next child PR in the release plan) replaces these
// bodies; until then every handler rejects atomically with NOT_IMPLEMENTED.

import { notImplemented } from './types';
import type { GameAction, HandlerResult, PlayerId, TileId, WorkingState } from './types';

type BuyAction = Extract<GameAction, { type: 'BUY_PROPERTY' }>;

/** Buy the property the active player stands on at list price. */
export function buyProperty(_work: WorkingState, _action: BuyAction): HandlerResult {
  return { ok: false, error: notImplemented('economy.buyProperty') };
}

/** Collect rent from `payer` on behalf of `payee`; may drive the payer into debt. */
export function collectRent(
  _work: WorkingState,
  _payer: PlayerId,
  _payee: PlayerId,
  _tile: TileId,
  _amount: number,
): HandlerResult {
  return { ok: false, error: notImplemented('economy.collectRent') };
}
