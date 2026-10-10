// Auction rule module — open ascending auctions (spec §3.5).
//
// An auction opens when the active player declines an unowned purchasable
// (`declineBuy`, routed from the `awaitingBuy` window). Every solvent player
// — the decliner included — may bid; the bank never bids. Bids open at
// AUCTION_MIN_BID and rise by at least AUCTION_MIN_INCREMENT; a pass is
// permanent for that auction. While it is open the board is fully blocked:
// the turn state stays `auction` and the transition table routes nothing
// else. It settles the moment at most one player can still act — the
// standing high bid wins at its amount, or with no bid at all the property
// stays with the bank — and play resumes where the roll left it.

import { AUCTION_MIN_BID, AUCTION_MIN_INCREMENT, getTile } from './board';
import type {
  ActiveAuction,
  GameAction,
  GameError,
  GameErrorCode,
  HandlerResult,
  PlayerId,
  TurnState,
  WorkingState,
} from './types';

type DeclineAction = Extract<GameAction, { type: 'DECLINE_BUY' }>;
type BidAction = Extract<GameAction, { type: 'AUCTION_BID' }>;
type PassAction = Extract<GameAction, { type: 'AUCTION_PASS' }>;

function err(code: GameErrorCode, message: string): GameError {
  return { code, message };
}

/**
 * Players who may still act in the open auction: solvent and not passed.
 * The bank never bids (spec §3.5). Bankruptcy cannot change while an
 * auction is open — only AUCTION_BID/AUCTION_PASS are routable and neither
 * moves cash except at settlement.
 */
function activeParticipants(work: WorkingState, auction: ActiveAuction): PlayerId[] {
  return work.players
    .filter(p => !p.bankrupt && !auction.passed.includes(p.id))
    .map(p => p.id);
}

/**
 * Where the decliner's turn resumes after the auction resolves (spec §3.5:
 * "auctions … resolve fully before play resumes"). The roll that produced
 * the buy offer is the most recent DICE_ROLLED event — nothing else can act
 * between it and the decline — so a doubles roll means the mandatory
 * re-roll is still owed (spec §3.3); otherwise the turn continues at
 * `postRoll`.
 */
function resumeWindow(work: WorkingState): TurnState {
  for (let i = work.log.length - 1; i >= 0; i--) {
    const event = work.log[i];
    if (event.type === 'DICE_ROLLED') return event.doubles ? 'awaitingRoll' : 'postRoll';
  }
  // An auction only opens after a roll, so the log always has one; fall
  // back conservatively rather than guess a bonus roll.
  return 'postRoll';
}

/**
 * Settle the auction when it is over. The auction keeps every player with a
 * decision to make: two or more non-passed players, or exactly one who has
 * not placed the standing high bid. Once nobody can outbid it, the standing
 * high bid wins at its amount — a bid is a commitment; the high bidder's
 * own later pass does not retract it, it only stops them bidding further —
 * and the winner pays the bank and takes the tile at level 0, unmortgaged.
 * With no bid ever placed, the property stays with the bank (spec §3.5).
 */
function settleIfOver(work: WorkingState): HandlerResult {
  const open = work.auction;
  if (!open) return { ok: false, error: err('INTERNAL', 'auction settlement: no auction is open') };
  const active = activeParticipants(work, open);
  const stillDeciding =
    active.length > 1 ||
    (active.length === 1 && (open.highBid === null || open.highBid.bidder !== active[0]));
  if (stillDeciding) return { ok: true };

  if (open.highBid !== null) {
    const winner = work.players[open.highBid.bidder];
    // Bids are cash-capped when placed and cash cannot move during an
    // auction, so a shortfall here is an engine bug — surfaced, never swallowed.
    if (winner.bankrupt || winner.cash < open.highBid.amount) {
      return { ok: false, error: err('INTERNAL', `auction settlement: ${winner.name} cannot cover their own winning bid`) };
    }
    work.players[open.highBid.bidder] = { ...winner, cash: winner.cash - open.highBid.amount };
    work.ownership[open.tile] = { owner: open.highBid.bidder, level: 0, mortgaged: false };
  }
  work.auction = null;
  work.turn = { ...work.turn, state: resumeWindow(work) };
  return { ok: true };
}

/** Decline the buy offer: open an auction among solvent players (spec §3.5). */
export function declineBuy(work: WorkingState, action: DeclineAction): HandlerResult {
  const pid = work.turn.activePlayer;
  if (action.player !== pid) {
    return { ok: false, error: err('WRONG_PLAYER', `Only the active player may decline the buy; ${action.player} is not active.`) };
  }
  // The offer is always for the tile the active player just landed on, and
  // nothing can change ownership between offer and decline — the FSM routes
  // no other action from `awaitingBuy`.
  const tile = work.players[pid].position;
  const t = getTile(tile);
  if (t.price === null || work.ownership[tile]) {
    return { ok: false, error: err('INVALID_TILE', `${t.name} is not an unowned purchasable property, so there is no offer to decline.`) };
  }
  work.auction = { tile, highBid: null, passed: [] };
  work.turn = { ...work.turn, state: 'auction' };
  return { ok: true };
}

/** Raise the high bid by at least the minimum increment (spec §3.5). */
export function bid(work: WorkingState, action: BidAction): HandlerResult {
  const open = work.auction;
  if (!open) return { ok: false, error: err('INTERNAL', 'auction bid: no auction is open') };
  if (open.passed.includes(action.player)) {
    return { ok: false, error: err('ALREADY_PASSED', `${work.players[action.player].name} already passed on this auction.`) };
  }
  const minNext = open.highBid === null ? AUCTION_MIN_BID : open.highBid.amount + AUCTION_MIN_INCREMENT;
  if (!Number.isInteger(action.amount) || action.amount < minNext) {
    return { ok: false, error: err('INVALID_BID', `The next legal bid is ${minNext} TD; got ${action.amount}.`) };
  }
  const bidder = work.players[action.player];
  // Bids are capped at cash on hand: the winner pays the bank in full at
  // settlement, and the debt flow (spec §3.7) can only service the ACTIVE
  // player — an out-of-turn winner with a shortfall would strand a debt no
  // turn state can liquidate.
  if (action.amount > bidder.cash) {
    return { ok: false, error: err('INSUFFICIENT_FUNDS', `${bidder.name} holds ${bidder.cash} TD and cannot bid ${action.amount}.`) };
  }
  work.auction = { ...open, highBid: { bidder: action.player, amount: action.amount } };
  return settleIfOver(work);
}

/** Pass permanently on this auction (spec §3.5). */
export function pass(work: WorkingState, action: PassAction): HandlerResult {
  const open = work.auction;
  if (!open) return { ok: false, error: err('INTERNAL', 'auction pass: no auction is open') };
  if (open.passed.includes(action.player)) {
    return { ok: false, error: err('ALREADY_PASSED', `${work.players[action.player].name} already passed on this auction.`) };
  }
  work.auction = { ...open, passed: [...open.passed, action.player] };
  return settleIfOver(work);
}
