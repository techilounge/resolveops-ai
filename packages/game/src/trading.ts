// Trading rule module — proposal, response, atomic execution (spec §3.6).
// STUB: the auctions+trading PR replaces these bodies; until then every
// handler rejects atomically with NOT_IMPLEMENTED.

import { notImplemented } from './types';
import type { GameAction, HandlerResult, WorkingState } from './types';

type ProposeAction = Extract<GameAction, { type: 'PROPOSE_TRADE' }>;
type AcceptAction = Extract<GameAction, { type: 'ACCEPT_TRADE' }>;
type DeclineAction = Extract<GameAction, { type: 'DECLINE_TRADE' }>;

/** Propose a cash/property swap to another player during your window. */
export function proposeTrade(_work: WorkingState, _action: ProposeAction): HandlerResult {
  return { ok: false, error: notImplemented('trading.proposeTrade') };
}

/** Accept a pending trade as the offeree; executes atomically. */
export function acceptTrade(_work: WorkingState, _action: AcceptAction): HandlerResult {
  return { ok: false, error: notImplemented('trading.acceptTrade') };
}

/** Decline a pending trade as the offeree. */
export function declineTrade(_work: WorkingState, _action: DeclineAction): HandlerResult {
  return { ok: false, error: notImplemented('trading.declineTrade') };
}
