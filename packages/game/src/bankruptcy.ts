// Bankruptcy rule module — debt settlement and elimination (spec §3.7).
// STUB: the development+bankruptcy PR replaces these bodies; until then every
// handler rejects atomically with NOT_IMPLEMENTED.

import { notImplemented } from './types';
import type { GameAction, HandlerResult, WorkingState } from './types';

type BankruptcyAction = Extract<GameAction, { type: 'DECLARE_BANKRUPTCY' }>;

/** Declare bankruptcy from the debt state; settle the creditor and eliminate. */
export function declareBankruptcy(_work: WorkingState, _action: BankruptcyAction): HandlerResult {
  return { ok: false, error: notImplemented('bankruptcy.declareBankruptcy') };
}
