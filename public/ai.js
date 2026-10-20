// Opponents and partner. Deliberately simple and readable: it plays a sound
// social game rather than a strong one, and never looks at hidden information.

import {
  SUITS, strength, legalPlaysFor, trickWinner,
  teamOf, MIN_BID, MAX_BID, handPoints, mayRequestTrump,
} from "./game.js";

// Rough worth of four cards, scaled to the 28 available points. A Jack is both the
// highest card and the biggest prize, so it counts twice over.
function handStrength(cards) {
  let score = 0;
  for (const card of cards) {
    score += card.points * 1.6;
    if (card.rank === "J") score += 2.2;
    else if (card.rank === "9") score += 1.4;
    else if (card.rank === "A") score += 0.8;
  }
  // Length in a suit matters: it is what lets a trump holder keep control.
  for (const suit of SUITS) {
    const n = cards.filter((c) => c.suit === suit).length;
    if (n >= 3) score += (n - 2) * 1.5;
  }
  return score;
}

// Swept against the self-play make-rate: 8 lands near an even contest (~47% of
// contracts made) while leaving only ~4% of deals passed out. Lower bids more
// freely and makes more; higher passes more and redeals more often.
const BID_BASE = Number(globalThis.process?.env?.BID_BASE ?? 8);

export function decideBid(state, seat) {
  const hand = state.hands[seat];
  // An absolute read of the hand, NOT anchored to the table minimum. Anchoring it
  // meant raising the minimum silently raised every estimate with it, and clamping
  // the ceiling up to the minimum forced a bid on hands that should pass.
  const estimate = BID_BASE + Math.round(handStrength(hand));
  const floor = Math.max(MIN_BID, state.highBid + 1);

  // A four-card view of an eight-card hand is a guess, not a count: if the hand
  // cannot justify the going rate, pass rather than buy a contract it will miss.
  const ceiling = Math.min(MAX_BID, estimate);
  if (floor > ceiling) return null;

  // Supporting a partner's bid is cheaper than outbidding an opponent.
  const partnerLeads = state.bidWinner !== null && teamOf(state.bidWinner) === teamOf(seat);
  if (partnerLeads && state.highBid >= ceiling - 1) return null;

  return floor;
}

export function chooseTrumpSuit(state, seat) {
  const hand = state.hands[seat];
  let best = null;
  for (const suit of SUITS) {
    const inSuit = hand.filter((c) => c.suit === suit);
    if (!inSuit.length) continue;
    // Prefer length first, then high cards — a long trump suit wins more tricks
    // than a short strong one.
    const value = inSuit.length * 2 + handStrength(inSuit) * 0.5;
    if (!best || value > best.value) best = { suit, value, cards: inSuit };
  }
  if (!best) best = { cards: hand };
  // Set aside the lowest card of the chosen suit: it is face down for most of the
  // hand, so spending a Jack on it would be a waste.
  const keep = [...best.cards].sort((a, b) => strength(a.rank) - strength(b.rank));
  return keep[0];
}

// Would this card take the trick as things stand?
function wouldWin(state, seat, card) {
  const hypothetical = [...state.trick, { seat, card }];
  const revealIndex = state.trumpRevealed ? (state.revealIndex ?? 0) : null;
  return trickWinner(hypothetical, state.trumpSuit, revealIndex) === seat;
}

export function decidePlay(state, seat) {
  const hand = state.hands[seat];
  const lead = state.trick.length ? state.trick[0].card.suit : null;
  const options = legalPlaysFor(state, seat);
  const byRank = (a, b) => strength(a.rank) - strength(b.rank);
  const low = [...options].sort(byRank);
  const high = [...low].reverse();

  // Leading: push a high card from a long suit, keeping the Jack back early on.
  if (!lead) {
    const early = state.tricksPlayed < 3;
    const candidates = early ? options.filter((c) => c.rank !== "J") : options;
    const pool = candidates.length ? candidates : options;
    return [...pool].sort((a, b) => {
      const lenA = hand.filter((c) => c.suit === a.suit).length;
      const lenB = hand.filter((c) => c.suit === b.suit).length;
      if (lenA !== lenB) return lenB - lenA;
      return strength(b.rank) - strength(a.rank);
    })[0];
  }

  const pot = handPoints(state.trick.map((p) => p.card));
  const winningSeat = state.trick.length
    ? trickWinner(state.trick, state.trumpSuit, state.trumpRevealed ? (state.revealIndex ?? 0) : null)
    : null;
  const partnerWinning = winningSeat !== null && teamOf(winningSeat) === teamOf(seat) && winningSeat !== seat;

  // Partner already holds the trick: feed them points instead of overtaking.
  if (partnerWinning && state.trick.length === 3) {
    const givers = [...options].sort((a, b) => b.points - a.points || strength(a.rank) - strength(b.rank));
    return givers[0];
  }
  if (partnerWinning) return low[0];

  // Otherwise take it if the trick is worth taking.
  const winners = high.filter((c) => wouldWin(state, seat, c));
  if (winners.length) {
    const worthIt = pot > 0 || state.trick.length === 3;
    if (worthIt) {
      // Use the cheapest card that still wins, not the strongest in hand.
      return [...winners].sort(byRank)[0];
    }
  }

  // Cannot or should not win: throw the least valuable card.
  return [...options].sort((a, b) => a.points - b.points || strength(a.rank) - strength(b.rank))[0];
}

// Call for trump when void and the trick is worth contesting — but not on the very
// first card played, where there is nothing to win yet.
export function wantsTrump(state, seat) {
  if (!mayRequestTrump(state, seat)) return false;
  const pot = handPoints(state.trick.map((p) => p.card));
  const winningSeat = trickWinner(
    state.trick,
    state.trumpSuit,
    state.trumpRevealed ? (state.revealIndex ?? 0) : null,
  );
  const opponentWinning = teamOf(winningSeat) !== teamOf(seat);
  return opponentWinning && (pot >= 2 || state.trick.length === 3);
}
