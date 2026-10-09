// Auction rule module — open ascending auctions (spec §3.5).
// STUB: the auctions+trading PR replaces these bodies; until then every
// handler rejects atomically with NOT_IMPLEMENTED.

import { notImplemented } from './types';
import type { GameAction, HandlerResult, WorkingState } from './types';

type DeclineAction = Extract<GameAction, { type: 'DECLINE_BUY' }>;
type BidAction = Extract<GameAction, { type: 'AUCTION_BID' }>;
type PassAction = Extract<GameAction, { type: 'AUCTION_PASS' }>;

/** Decline the buy offer: open an auction among solvent players. */
export function declineBuy(_work: WorkingState, _action: DeclineAction): HandlerResult {
  return { ok: false, error: notImplemented('auction.declineBuy') };
}

/** Raise the high bid by at least the minimum increment. */
export function bid(_work: WorkingState, _action: BidAction): HandlerResult {
  return { ok: false, error: notImplemented('auction.bid') };
}

/** Pass permanently on this auction. */
export function pass(_work: WorkingState, _action: PassAction): HandlerResult {
  return { ok: false, error: notImplemented('auction.pass') };
}
