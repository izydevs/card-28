// Twenty-Eight (28) — rules engine.
//
// Pure functions and plain state, no DOM, so the same module runs in the browser
// and under Node for the tests. Nothing here renders or prompts.

export const SUITS = ["♠", "♥", "♦", "♣"];
export const SUIT_NAMES = { "♠": "Spades", "♥": "Hearts", "♦": "Diamonds", "♣": "Clubs" };
export const RED = new Set(["♥", "♦"]);

// Rank order is the game's own, not the usual one: the Jack is the strongest card
// and the Nine beats the Ace. Listed strongest first.
export const RANKS = ["J", "9", "A", "10", "K", "Q", "8", "7"];

// Only four ranks carry points, and they sum to 28 across the four suits —
// (3 + 2 + 1 + 1) × 4 — which is where the game gets its name.
export const POINTS = { J: 3, 9: 2, A: 1, 10: 1, K: 0, Q: 0, 8: 0, 7: 0 };

export const TOTAL_POINTS = 28;
export const MIN_BID = 16; // some tables open at 14; this one opens at 16
export const MAX_BID = 28;
export const HAND_SIZE = 8;
export const FIRST_DEAL = 4; // dealt before bidding; the rest after trump is chosen

// Seats are clockwise. Partners sit opposite: 0+2 against 1+3.
export const SEATS = ["South", "West", "North", "East"];
export const teamOf = (seat) => seat % 2;
export const partnerOf = (seat) => (seat + 2) % 4;
export const nextSeat = (seat) => (seat + 1) % 4;

export const strength = (rank) => RANKS.length - RANKS.indexOf(rank);
export const cardId = (card) => `${card.rank}${card.suit}`;

export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ suit, rank, points: POINTS[rank] });
  }
  return deck;
}

// Fisher-Yates. The caller supplies the random source so a game can be replayed.
export function shuffle(deck, random = Math.random) {
  const out = [...deck];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const handPoints = (cards) => cards.reduce((sum, c) => sum + c.points, 0);

// ---------------------------------------------------------------- legality

// Follow suit if you can. That is the only restriction while the trump is still
// face down — and the reason a concealed trump is worth anything.
export function legalPlays(hand, lead) {
  if (!lead) return [...hand];
  const following = hand.filter((c) => c.suit === lead);
  return following.length ? following : [...hand];
}

export const canFollow = (hand, lead) => hand.some((c) => c.suit === lead);

// The complete, state-aware answer to "what may this seat play right now?".
// legalPlays() only knows about following suit; the extra rule is that a player
// who just called for trump must actually use it if they hold one. Every caller —
// the engine's own validation, the AI, and the UI — must agree on this list, or a
// rejected play loops forever.
export function legalPlaysFor(state, seat) {
  const hand = state.hands[seat];
  const lead = state.trick.length ? state.trick[0].card.suit : null;
  const base = legalPlays(hand, lead);

  const mustTrump =
    state.trumpRevealed &&
    state.revealedBy === seat &&
    state.revealIndex === state.trick.length &&
    hand.some((c) => c.suit === state.trumpSuit);

  if (!mustTrump) return base;
  const trumps = base.filter((c) => c.suit === state.trumpSuit);
  return trumps.length ? trumps : base;
}

// A player may ask for the trump to be shown only when they cannot follow the
// led suit — never on a lead, and never while still holding the suit.
export function mayRequestTrump(state, seat) {
  const trick = state.trick;
  if (!trick.length) return false;
  if (state.trumpRevealed) return false;
  if (seat === state.bidWinner && state.trumpCard) return false; // they already know it
  return !canFollow(state.hands[seat], trick[0].card.suit);
}

// ---------------------------------------------------------------- trick resolution

// Highest trump wins if any trump was played after the reveal; otherwise the
// highest card of the suit that was led. Cards played before the reveal cannot
// win as trumps — the suit was not yet trump when they hit the table.
export function trickWinner(trick, trumpSuit, revealedAtIndex = null) {
  const lead = trick[0].card.suit;
  let best = null;
  for (const [index, play] of trick.entries()) {
    const isTrump =
      trumpSuit &&
      play.card.suit === trumpSuit &&
      revealedAtIndex !== null &&
      index >= revealedAtIndex;
    const candidate = { ...play, index, isTrump, rank: strength(play.card.rank) };
    if (!best) {
      best = candidate.card.suit === lead || candidate.isTrump ? candidate : { ...candidate, rank: -1 };
      continue;
    }
    if (candidate.isTrump && !best.isTrump) best = candidate;
    else if (candidate.isTrump === best.isTrump) {
      const comparable = candidate.isTrump || candidate.card.suit === lead;
      if (comparable && candidate.rank > best.rank) best = candidate;
    }
  }
  return best.seat;
}

// ---------------------------------------------------------------- game state

export function createGame({ random = Math.random, dealer = 3 } = {}) {
  const deck = shuffle(buildDeck(), random);
  const hands = [[], [], [], []];
  // Four each to start; the remaining four are dealt once trump is set.
  for (let i = 0; i < FIRST_DEAL * 4; i++) hands[i % 4].push(deck[i]);

  return {
    phase: "bidding",
    deck,
    dealt: FIRST_DEAL * 4,
    hands,
    dealer,
    turn: nextSeat(dealer),
    bids: [],
    passed: [false, false, false, false],
    highBid: 0,
    bidWinner: null,
    trumpSuit: null,
    trumpCard: null,
    trumpRevealed: false,
    revealedBy: null,
    revealIndex: null, // index within the current trick at which trump became live
    trick: [],
    tricksPlayed: 0,
    captured: [[], []], // cards won, by team
    log: [],
    result: null,
  };
}

export function say(state, text) {
  state.log.push(text);
  if (state.log.length > 200) state.log.shift();
  return state;
}

// ---------------------------------------------------------------- bidding

export function placeBid(state, seat, bid) {
  if (state.phase !== "bidding" || state.turn !== seat) return state;

  if (bid === null) {
    state.passed[seat] = true;
    say(state, `${SEATS[seat]} passes.`);
  } else {
    const floor = Math.max(MIN_BID, state.highBid + 1);
    if (bid < floor || bid > MAX_BID) return state;
    state.highBid = bid;
    state.bidWinner = seat;
    state.bids.push({ seat, bid });
    say(state, `${SEATS[seat]} bids ${bid}.`);
  }

  const active = state.passed.filter((p) => !p).length;
  // Bidding ends when everyone but the high bidder has passed.
  if (active <= 1 && state.bidWinner !== null) {
    state.phase = "trump";
    state.turn = state.bidWinner;
    say(state, `${SEATS[state.bidWinner]} won the bid at ${state.highBid} and picks a trump.`);
    return state;
  }
  // Nobody bid at all — redeal rather than play a hand with no contract.
  if (active === 0 && state.bidWinner === null) {
    state.phase = "redeal";
    say(state, "All four passed — redeal.");
    return state;
  }

  do {
    state.turn = nextSeat(state.turn);
  } while (state.passed[state.turn]);
  return state;
}

// ---------------------------------------------------------------- trump & deal

export function chooseTrump(state, card) {
  if (state.phase !== "trump") return state;
  const hand = state.hands[state.bidWinner];
  const index = hand.findIndex((c) => cardId(c) === cardId(card));
  if (index < 0) return state;

  // The chosen card is set aside face down; it rejoins the hand when revealed.
  state.trumpCard = hand.splice(index, 1)[0];
  state.trumpSuit = state.trumpCard.suit;

  // Deal the rest of the hand now that the contract exists.
  for (let i = 0; i < FIRST_DEAL * 4; i++) {
    state.hands[i % 4].push(state.deck[state.dealt + i]);
  }
  state.dealt += FIRST_DEAL * 4;

  state.phase = "playing";
  setTurn(state, nextSeat(state.dealer));
  say(state, `Trump is set face down. ${SEATS[state.turn]} leads.`);
  return state;
}

// The bidder's face-down card is still one of their eight. While it is concealed they
// play from seven, so if the trump is never called they would run out a trick early
// and the hand would stall. When it is all they have left, it comes back up.
function setTurn(state, seat) {
  state.turn = seat;
  if (
    state.phase === "playing" &&
    seat === state.bidWinner &&
    state.trumpCard &&
    !state.trumpRevealed &&
    state.hands[seat].length === 0
  ) {
    state.trumpRevealed = true;
    state.revealedBy = seat;
    state.revealIndex = state.trick.length;
    state.hands[seat].push(state.trumpCard);
    say(
      state,
      `${SEATS[seat]} has only the hidden card left — trump is ${SUIT_NAMES[state.trumpSuit]} ${state.trumpSuit}.`,
    );
  }
}

export function revealTrump(state, seat) {
  if (!mayRequestTrump(state, seat)) return state;
  state.trumpRevealed = true;
  state.revealedBy = seat;
  state.revealIndex = state.trick.length; // live from this play onward
  // The face-down card returns to its owner's hand.
  state.hands[state.bidWinner].push(state.trumpCard);
  say(state, `${SEATS[seat]} calls for trump — it is ${SUIT_NAMES[state.trumpSuit]} ${state.trumpSuit}.`);
  return state;
}

// ---------------------------------------------------------------- play

export function playCard(state, seat, card) {
  if (state.phase !== "playing" || state.turn !== seat) return state;
  const hand = state.hands[seat];
  const index = hand.findIndex((c) => cardId(c) === cardId(card));
  if (index < 0) return state;

  // One source of truth for legality, shared with the AI and the UI.
  if (!legalPlaysFor(state, seat).some((c) => cardId(c) === cardId(card))) return state;

  hand.splice(index, 1);
  state.trick.push({ seat, card });
  say(state, `${SEATS[seat]} plays ${card.rank}${card.suit}.`);

  if (state.trick.length < 4) {
    setTurn(state, nextSeat(seat));
    return state;
  }
  return resolveTrick(state);
}

export function resolveTrick(state) {
  const winner = trickWinner(state.trick, state.trumpSuit, state.revealIndex);
  const team = teamOf(winner);
  const cards = state.trick.map((p) => p.card);
  state.captured[team].push(...cards);
  const won = handPoints(cards);
  say(state, `${SEATS[winner]} takes the trick${won ? ` (${won} point${won > 1 ? "s" : ""})` : ""}.`);

  state.trick = [];
  state.revealIndex = state.trumpRevealed ? 0 : null; // trump stays live for later tricks
  state.tricksPlayed++;
  state.lastWinner = winner;

  if (state.tricksPlayed === HAND_SIZE) return score(state);
  setTurn(state, winner);
  return state;
}

export function score(state) {
  const biddingTeam = teamOf(state.bidWinner);
  const got = handPoints(state.captured[biddingTeam]);
  const made = got >= state.highBid;
  state.phase = "done";
  state.result = {
    biddingTeam,
    bid: state.highBid,
    got,
    opponents: handPoints(state.captured[1 - biddingTeam]),
    made,
  };
  say(
    state,
    made
      ? `Contract made: ${got} of ${state.highBid}.`
      : `Contract failed: ${got} of ${state.highBid}.`,
  );
  return state;
}
