// Opponents and partner. Deliberately simple and readable: it plays a sound
// social game rather than a strong one, and never looks at hidden information.

import {
  SUITS, RANKS, strength, legalPlaysFor, trickWinner, teamOf, MAX_BID,
  handPoints, mayRequestTrump, minBidFor, mayPass, mayRequestRedeal, minRaise,
  mayRaise, mayDeclareThani, mayDeclarePair, mayConcede, isJoker, HAND_SIZE,
  placeBid, requestRedeal, chooseTrump, raiseBid, declareThani, decideDouble,
  decideRedouble, answerConcession,
} from "./game.js";

// Rough worth of a set of cards, scaled to the 28 available points. A Jack is both
// the highest card and the biggest prize, so it counts twice over.
function handStrength(cards) {
  let score = 0;
  for (const card of cards) {
    score += card.points * 1.6;
    if (card.rank === "J") score += 2.2;
    else if (card.rank === "9") score += 1.4;
    else if (card.rank === "A") score += 0.8;
    else if (isJoker(card)) score += 2.5; // the top trump once trump is out
  }
  // Length in a suit matters: it is what lets a trump holder keep control.
  for (const suit of SUITS) {
    const n = cards.filter((c) => c.suit === suit).length;
    if (n >= 3) score += (n - 2) * 1.5;
  }
  return score;
}

// The bidder's full eight cards, including the one lying face down.
const fullHand = (state, seat) =>
  seat === state.bidWinner && state.trumpCard && !state.trumpRevealed
    ? [...state.hands[seat], state.trumpCard]
    : state.hands[seat];

// Swept against the self-play make-rate. Lower bids more freely and makes more;
// higher passes more.
const BID_BASE = Number(globalThis.process?.env?.BID_BASE ?? 8);

export const wantsRedeal = (state, seat) => mayRequestRedeal(state, seat);

export function decideBid(state, seat) {
  const hand = state.hands[seat];
  // An absolute read of the hand, NOT anchored to the table minimum.
  const estimate = BID_BASE + Math.round(handStrength(hand));
  const floor = minBidFor(state, seat);
  const ceiling = Math.min(MAX_BID, estimate);

  // The opener has to open, however thin the hand.
  if (!mayPass(state)) return floor;

  // A four-card view of an eight-card hand is a guess, not a count: if the hand
  // cannot justify the going rate, pass rather than buy a contract it will miss.
  if (floor > ceiling) return null;

  // Supporting a partner's bid is cheaper than outbidding them (which costs 20+).
  const partnerLeads = state.bidWinner !== null && teamOf(state.bidWinner) === teamOf(seat);
  if (partnerLeads && state.highBid >= ceiling - 1) return null;

  return floor;
}

export function chooseTrumpSuit(state, seat) {
  const hand = state.hands[seat].filter((c) => !isJoker(c));
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

// ---------------------------------------------------------------- second round

// Every card is the top of its suit in sequence (J, then 9, then A…), so each lead
// wins by force. Only then is Thani a safe promise.
function allMasters(cards) {
  if (cards.some(isJoker)) return false;
  for (const suit of SUITS) {
    const inSuit = cards.filter((c) => c.suit === suit).map((c) => c.rank);
    if (!RANKS.slice(0, inSuit.length).every((rank) => inSuit.includes(rank))) return false;
  }
  return cards.length === HAND_SIZE;
}

export function wantsThani(state, seat) {
  return mayDeclareThani(state, seat) && allMasters(fullHand(state, seat));
}

// Returns a bid to raise to, or null to decline.
export function decideRaise(state, seat) {
  if (!mayRaise(state, seat)) return null;
  const cards = fullHand(state, seat);
  const points = handPoints(cards);
  const bid = minRaise(state);
  if (seat === state.bidWinner) {
    const trumps = cards.filter((c) => c.suit === state.trumpSuit).length;
    return points >= 13 && trumps >= 4 && bid <= MAX_BID ? bid : null;
  }
  // The partner takes over only with a big hand and a long suit of their own.
  const longest = Math.max(...SUITS.map((s) => cards.filter((c) => c.suit === s).length));
  return points >= 14 && longest >= 4 && bid <= MAX_BID ? bid : null;
}

export function wantsDouble(state, seat) {
  return handPoints(state.hands[seat]) >= 11;
}

export function wantsRedouble(state, seat) {
  return handPoints(fullHand(state, seat)) >= 12;
}

// ---------------------------------------------------------------- play

const liveReveal = (state) => (state.trumpRevealed ? (state.revealIndex ?? 0) : null);

// Would this card take the trick as things stand?
function wouldWin(state, seat, card) {
  const hypothetical = [...state.trick, { seat, card }];
  return trickWinner(hypothetical, state.trumpSuit, liveReveal(state)) === seat;
}

const lastToPlay = (state) => state.trick.length === (state.thani ? 2 : 3);

export function decidePlay(state, seat) {
  const hand = state.hands[seat];
  const options = legalPlaysFor(state, seat);
  const byRank = (a, b) => strength(a.rank) - strength(b.rank);
  const cheap = (a, b) => a.points - b.points || byRank(a, b);
  const low = [...options].sort(byRank);
  const high = [...low].reverse();

  // Leading: push a high card from a long suit, keeping the Jack back early on.
  if (!state.trick.length) {
    const early = state.tricksPlayed < 3 && !state.thani;
    const candidates = early ? options.filter((c) => c.rank !== "J" && !isJoker(c)) : options;
    const pool = candidates.length ? candidates : options;
    return [...pool].sort((a, b) => {
      const lenA = hand.filter((c) => c.suit === a.suit).length;
      const lenB = hand.filter((c) => c.suit === b.suit).length;
      if (lenA !== lenB) return lenB - lenA;
      return strength(b.rank) - strength(a.rank);
    })[0];
  }

  const pot = handPoints(state.trick.map((p) => p.card));
  const winningSeat = trickWinner(state.trick, state.trumpSuit, liveReveal(state));
  const partnerWinning = teamOf(winningSeat) === teamOf(seat) && winningSeat !== seat;

  // Partner already holds the trick: feed them points instead of overtaking.
  if (partnerWinning && lastToPlay(state)) {
    const givers = options.filter((c) => !isJoker(c));
    return [...(givers.length ? givers : options)].sort((a, b) => b.points - a.points || byRank(a, b))[0];
  }
  if (partnerWinning) return [...options].sort(cheap)[0];

  // Otherwise take it if the trick is worth taking — and in Thani always try.
  const winners = high.filter((c) => wouldWin(state, seat, c));
  if (winners.length) {
    const worthIt = pot > 0 || lastToPlay(state) || state.thani || state.cotRefused !== null;
    if (worthIt) return [...winners].sort(byRank)[0]; // cheapest card that still wins
  }

  // Cannot or should not win: throw the least valuable card, keeping any Joker.
  const throwable = options.filter((c) => !isJoker(c));
  return [...(throwable.length ? throwable : options)].sort(cheap)[0];
}

// Call for trump when void and the trick is worth contesting.
export function wantsTrump(state, seat) {
  if (!mayRequestTrump(state, seat)) return false;
  const pot = handPoints(state.trick.map((p) => p.card));
  const winningSeat = trickWinner(state.trick, state.trumpSuit, liveReveal(state));
  const opponentWinning = teamOf(winningSeat) !== teamOf(seat);
  return opponentWinning && (pot >= 2 || lastToPlay(state));
}

// Showing the Pair never hurts the side that holds it.
export const wantsPair = (state, seat) => mayDeclarePair(state, seat);

// Give up the rest only late, when the other side has swept everything so far.
export const wantsConcede = (state, seat) => mayConcede(state, seat) && state.tricksPlayed >= 6;

// Accept a concession: playing on risks losing double for very little.
export const acceptsConcession = () => true;


// One decision for whoever's turn it is, in every phase except card play — which
// the UI animates step by step and so drives itself.
export function aiAct(state) {
  const seat = state.turn;
  switch (state.phase) {
    case "bidding":
      if (wantsRedeal(state, seat)) return requestRedeal(state, seat);
      return placeBid(state, seat, decideBid(state, seat));
    case "trump":
      return chooseTrump(state, chooseTrumpSuit(state, seat));
    case "raise":
      if (wantsThani(state, seat)) return declareThani(state, seat);
      return raiseBid(state, seat, decideRaise(state, seat));
    case "double":
      return decideDouble(state, seat, wantsDouble(state, seat));
    case "redouble":
      return decideRedouble(state, seat, wantsRedouble(state, seat));
    case "concession":
      return answerConcession(state, seat, acceptsConcession(state, seat));
    default:
      return state;
  }
}
