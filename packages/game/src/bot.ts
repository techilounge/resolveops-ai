// Tycoon City — scripted, budget-aware bot policy (spec §5, §7).
//
// One pure function per seat: `pickAction` returns the action that seat
// would take next, or null when it has no move it wants to make. The same
// policy drives the fuzz harness's bot games (this PR) and the Rules Lab's
// seeded AI-vs-AI simulation (a later Phase 1 PR), so it is deliberately a
// pure function of GameState: no Math.random, no Date.now — the only
// randomness in a bot-driven game is the engine's own seeded PRNG.
//
// Budget-aware means the policy holds reserves instead of maximising a
// single metric: builds wait for a cash cushion, auctions cap bids at a
// fraction of the bankroll, and a deed is only bought when it costs at most
// half the cash on hand. Every returned action is pre-validated against the
// same rules the engine enforces, so a bot-driven game never depends on
// rejected intents.

import {
  AUCTION_MIN_BID,
  AUCTION_MIN_INCREMENT,
  DISTRICT_GROUPS,
  JAIL_FINE,
  getTile,
  isBuyableKind,
  ownsFullGroup,
} from './board';
import { landmarkUnitsRemaining, permitUnitsRemaining } from './development';
import { mortgageLiftCost, mortgageValue } from './economy';
import type {
  ActiveAuction,
  GameAction,
  GameState,
  GroupId,
  PendingTrade,
  PlayerId,
  TileId,
  TradeLeg,
} from './types';
import { tileId } from './types';

/** Cash kept aside for rents and taxes — a permit build waits until the reserve is intact. */
const BUILD_RESERVE = 500;
/** Cash kept aside when buying out of jail: pay only above this remainder. */
const JAIL_RESERVE = 1_000;
/** A deed is sensibly priced when list × 2 fits in cash (≤ half the bankroll). */
const BUY_MAX_CASH_SHARE = 2;
/** Auction ceiling: never bid past a third of available cash. */
const AUCTION_MAX_CASH_SHARE = 3;

/** Every tile `pid` currently owns, in board order. */
function ownedTiles(state: GameState, pid: PlayerId): TileId[] {
  const out: TileId[] = [];
  for (const key of Object.keys(state.ownership)) {
    const tile = tileId(Number(key));
    const deed = state.ownership[tile];
    if (deed && deed.owner === pid) out.push(tile);
  }
  return out;
}

/** Every buyable property `pid` owns, in board order. */
function ownedBuyable(state: GameState, pid: PlayerId): TileId[] {
  return ownedTiles(state, pid).filter(t => isBuyableKind(getTile(t).kind));
}

/**
 * The cheapest whole-portfolio buyout `pid` can afford (spec §3.6): cash for
 * every property the target owns, valued at list price with mortgaged deeds
 * at equity. Buying monopolies is how a tycoon converts a cash pile into
 * completed districts — and in simulation it is what breaks the land-rich,
 * cash-poor stalemate that unbounded boards otherwise settle into. A pending
 * offer blocks a new one (one at a time, spec §3.6); ties break by player id.
 */
function buyoutTarget(state: GameState, pid: PlayerId): GameAction | null {
  // Only a live offer (one made by the active player — the engine's own
  // liveness rule in trading.ts) blocks a new proposal; a stale pendingTrade
  // left over from an ended turn must not freeze the bot's proposing.
  if (state.pendingTrade !== null && state.pendingTrade.from === state.turn.activePlayer) return null;
  const cash = state.players[pid].cash;
  let best: { to: PlayerId; ask: number } | null = null;
  for (const p of state.players) {
    if (p.bankrupt || p.id === pid) continue;
    const portfolio = ownedBuyable(state, p.id);
    if (portfolio.length === 0) continue;
    const ask = tradeLegValue(state, { cash: 0, tiles: portfolio });
    if (ask === 0 || ask > cash) continue;
    if (best === null || ask < best.ask) best = { to: p.id, ask };
  }
  if (best === null) return null;
  return {
    type: 'PROPOSE_TRADE',
    player: pid,
    to: best.to,
    give: { cash: best.ask, tiles: [] },
    want: { cash: 0, tiles: ownedBuyable(state, best.to) },
  };
}

/** Development levels `pid` holds within one colour group (even-build scope). */
function ownedGroupLevels(state: GameState, group: GroupId, pid: PlayerId): number[] {
  const levels: number[] = [];
  for (const t of DISTRICT_GROUPS[group].tiles) {
    const deed = state.ownership[t];
    if (deed && deed.owner === pid) levels.push(deed.level);
  }
  return levels;
}

/**
 * The cheapest affordable build across every complete, unmortgaged group the
 * player owns — the same even-build, pool and cash rules the engine applies
 * (spec §3.4). Cheapest-first keeps the reserve intact; ties break by tile id.
 * Exported for the fuzz harness, whose BUILD fills use it as a
 * legal-by-construction candidate.
 */
export function buildCandidate(state: GameState, pid: PlayerId): TileId | null {
  const cash = state.players[pid].cash;
  let best: { tile: TileId; cost: number } | null = null;
  for (const group of Object.values(DISTRICT_GROUPS)) {
    if (!ownsFullGroup(state.ownership, group.id, pid)) continue;
    if (group.tiles.some(t => state.ownership[t]?.mortgaged === true)) continue;
    const levels = ownedGroupLevels(state, group.id, pid);
    const minLevel = Math.min(...levels);
    if (minLevel >= 5) continue;
    const landmark = minLevel === 4;
    const poolHasRoom = landmark
      ? landmarkUnitsRemaining(state.ownership) >= 1
      : permitUnitsRemaining(state.ownership) >= 1;
    if (!poolHasRoom) continue;
    const cost = landmark ? 0 : group.permitCost;
    if (cash < cost + (landmark ? 0 : BUILD_RESERVE)) continue;
    const tile = group.tiles.find(t => state.ownership[t]?.level === minLevel);
    if (tile === undefined) continue; // unreachable: the group minimum guarantees a tile
    if (best === null || cost < best.cost || (cost === best.cost && tile < best.tile)) {
      best = { tile, cost };
    }
  }
  return best?.tile ?? null;
}

/**
 * Debt ladder (spec §3.7): sell the priciest permit (a max-level tile of its
 * group, 50% refund), then mortgage the most valuable unmortgaged deed, and
 * only when neither move exists — declare bankruptcy.
 */
function liquidationAction(state: GameState, pid: PlayerId): GameAction {
  let sell: { tile: TileId; refund: number } | null = null;
  let pledge: { tile: TileId; value: number } | null = null;
  for (const tile of ownedTiles(state, pid)) {
    const info = getTile(tile);
    const deed = state.ownership[tile];
    if (!deed) continue;
    if (info.kind === 'district' && deed.level > 0 && info.group !== null) {
      const levels = ownedGroupLevels(state, info.group, pid);
      if (deed.level === Math.max(...levels)) {
        const refund = Math.floor(DISTRICT_GROUPS[info.group].permitCost / 2);
        if (sell === null || refund > sell.refund || (refund === sell.refund && tile < sell.tile)) {
          sell = { tile, refund };
        }
      }
    }
    if (!deed.mortgaged && isBuyableKind(info.kind)) {
      const value = mortgageValue(tile);
      if (pledge === null || value > pledge.value || (value === pledge.value && tile < pledge.tile)) {
        pledge = { tile, value };
      }
    }
  }
  if (sell !== null) return { type: 'SELL_LEVEL', player: pid, tile: sell.tile };
  if (pledge !== null) return { type: 'MORTGAGE', player: pid, tile: pledge.tile };
  return { type: 'DECLARE_BANKRUPTCY', player: pid };
}

/**
 * Auction stance (spec §3.5): raise the standing bid while it stays under a
 * third of cash; stop when already the high bidder (bidding against oneself
 * is never right — passing lets the auction settle on the standing bid).
 */
function auctionAction(state: GameState, pid: PlayerId, open: ActiveAuction): GameAction | null {
  if (open.passed.includes(pid)) return null;
  if (open.highBid !== null && open.highBid.bidder === pid) {
    return { type: 'AUCTION_PASS', player: pid };
  }
  const minNext = open.highBid === null ? AUCTION_MIN_BID : open.highBid.amount + AUCTION_MIN_INCREMENT;
  if (minNext <= Math.floor(state.players[pid].cash / AUCTION_MAX_CASH_SHARE)) {
    return { type: 'AUCTION_BID', player: pid, amount: minNext };
  }
  return { type: 'AUCTION_PASS', player: pid };
}

/** List-price value of a leg; a mortgaged deed counts at its equity (list − principal). */
export function tradeLegValue(state: GameState, leg: TradeLeg): number {
  let value = leg.cash;
  for (const t of leg.tiles) {
    const price = getTile(t).price ?? 0;
    value += state.ownership[t]?.mortgaged === true ? price - mortgageValue(t) : price;
  }
  return value;
}

/** Whether `holder` can actually deliver `leg`: whole affordable cash, distinct owned tiles. */
function legIsDeliverable(state: GameState, leg: TradeLeg, holder: PlayerId): boolean {
  if (!Number.isInteger(leg.cash) || leg.cash < 0 || leg.cash > state.players[holder].cash) return false;
  const seen = new Set<number>();
  for (const t of leg.tiles) {
    if (seen.has(t)) return false;
    seen.add(t);
    const deed = state.ownership[t];
    if (!deed || deed.owner !== holder) return false;
  }
  return true;
}

/**
 * Offeree stance (spec §3.6): accept when the bundle received is worth at
 * least the bundle given (list-price valuation) and both legs are
 * deliverable; otherwise decline. Offers only live inside the offering
 * turn — `pickAction` never routes a stale offer here, where every response
 * would be rejected. Exported for the fuzz harness's offeree bias.
 */
export function isAcceptableTrade(state: GameState, trade: PendingTrade): boolean {
  return (
    legIsDeliverable(state, trade.give, trade.from) &&
    legIsDeliverable(state, trade.want, trade.to) &&
    tradeLegValue(state, trade.give) >= tradeLegValue(state, trade.want)
  );
}

function tradeResponse(state: GameState, trade: PendingTrade, pid: PlayerId): GameAction {
  return isAcceptableTrade(state, trade)
    ? { type: 'ACCEPT_TRADE', player: pid }
    : { type: 'DECLINE_TRADE', player: pid };
}

/**
 * The cheapest affordable mortgage lift across the player's pledged deeds —
 * the enabler for future builds (a mortgaged member blocks group
 * development). Ties break by tile id.
 */
function liftCandidate(state: GameState, pid: PlayerId): GameAction | null {
  const cash = state.players[pid].cash;
  let best: { tile: TileId; cost: number } | null = null;
  for (const tile of ownedBuyable(state, pid)) {
    if (state.ownership[tile]?.mortgaged !== true) continue;
    const cost = mortgageLiftCost(tile);
    if (cash < cost) continue;
    if (best === null || cost < best.cost || (cost === best.cost && tile < best.tile)) best = { tile, cost };
  }
  return best === null ? null : { type: 'LIFT_MORTGAGE', player: pid, tile: best.tile };
}

/**
 * The action seat `pid` would take next, or null when it has none: not
 * enrolled in an open auction, not an offer's offeree, and not the active
 * player in a decidable window. Pure and deterministic (spec §3.9).
 */
export function pickAction(state: GameState, pid: PlayerId): GameAction | null {
  if (state.phase !== 'active') return null;
  const me = state.players[pid];
  if (me === undefined || me.bankrupt) return null;

  if (state.turn.state === 'auction' && state.auction !== null) {
    return auctionAction(state, pid, state.auction);
  }

  const trade = state.pendingTrade;
  // Responses are legal only inside the offeror's roll/postRoll windows
  // (spec §3.6): while the offeror is, say, in awaitingBuy the engine
  // rejects them — the offer stays live and the window reopens after the
  // buy decision. Not my move yet → null.
  if (
    trade !== null && trade.to === pid && trade.from === state.turn.activePlayer &&
    (state.turn.state === 'awaitingRoll' || state.turn.state === 'postRoll')
  ) {
    return tradeResponse(state, trade, pid);
  }

  if (pid !== state.turn.activePlayer) return null;
  switch (state.turn.state) {
    case 'turnStart':
      if (me.jailTurnsLeft > 0 && me.cash - JAIL_FINE >= JAIL_RESERVE) {
        return { type: 'PAY_JAIL_FINE', player: pid };
      }
      return { type: 'ROLL_DICE', player: pid };
    case 'awaitingRoll':
      return { type: 'ROLL_DICE', player: pid };
    case 'awaitingBuy': {
      const offer = getTile(me.position);
      // awaitingBuy always carries a live offer for the tile under the player
      // (spec §3.5); if that invariant were ever broken, declining surfaces
      // it as a typed engine rejection rather than a silent stall.
      if (!isBuyableKind(offer.kind) || offer.price === null) {
        return { type: 'DECLINE_BUY', player: pid };
      }
      return offer.price * BUY_MAX_CASH_SHARE <= me.cash
        ? { type: 'BUY_PROPERTY', player: pid }
        : { type: 'DECLINE_BUY', player: pid };
    }
    case 'postRoll': {
      const buyout = buyoutTarget(state, pid);
      if (buyout !== null) return buyout;
      const tile = buildCandidate(state, pid);
      if (tile !== null) return { type: 'BUILD_LEVEL', player: pid, tile };
      // No build available: unblock future ones by lifting the cheapest
      // affordable mortgage — mortgaged groups collect no rent and block
      // development, so a portfolio left pledged freezes the bot's engine.
      const lift = liftCandidate(state, pid);
      return lift !== null ? lift : { type: 'END_TURN', player: pid };
    }
    case 'debt':
      return liquidationAction(state, pid);
    default:
      return null; // 'moving' is transient — movement resolves inside ROLL_DICE
  }
}
