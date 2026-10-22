// Twenty-Eight (28) — rules engine.
//
// Pure functions and plain state, no DOM, so the same module runs in the browser
// and under Node for the tests. Nothing here renders or prompts.
//
// A hand moves through these phases:
//
//   bidding → trump → (second deal) → raise → [trump again] → double → redouble
//           → playing → [concession] → done
//
// and any of them can end in "redeal" when a redeal rule fires.

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
export const MIN_BID = 16; // the default opening minimum; 14 is a house-rule option
export const MAX_BID = 28;
export const PARTNER_OVERCALL = 20; // the least you may bid over your own partner
export const SECOND_ROUND_MIN = 24; // the least a second-round raise may be
export const PAIR_SWING = 4; // a declared Pair moves the bid by this much
export const HAND_SIZE = 8;
export const FIRST_DEAL = 4; // dealt before bidding; the rest after trump is chosen
export const MATCH_TARGET = 6; // game points to win the match

// The Joker house rule. It replaces the 7♣ so the deck stays at 32 cards and 28 points.
export const JOKER_SUIT = "joker";
export const JOKER_RANK = "★";
export const JOKER_REPLACES = { rank: "7", suit: "♣" };

// Core rules are always on. These are the ones tables disagree about.
export const DEFAULT_RULES = Object.freeze({
  minBid: 16, // 14 or 16
  secondRound: true, // bidder or partner may raise to 24+ after seeing eight cards
  double: true, // opponents may double, the bidder may redouble
  pair: true, // K+Q of trump moves the bid by 4
  thani: true, // bidder may undertake to win every trick alone
  cot: true, // all eight tricks scores double; concession allowed
  pointlessRedeal: true, // an eight-card hand with no points forces a redeal
  noJackDiscard: false, // a Jack may not be thrown away when void
  joker: false, // one Joker replaces the 7♣
});

// Seats are listed going round the table clockwise as seen from above: South, West,
// North, East. Play in India runs COUNTER-clockwise, so the next player is the one
// on your right: South → East → North → West. Partners sit opposite: 0+2 against 1+3.
export const SEATS = ["South", "West", "North", "East"];
export const teamOf = (seat) => seat % 2;
export const partnerOf = (seat) => (seat + 2) % 4;
export const nextSeat = (seat) => (seat + 3) % 4;

export const isJoker = (card) => card?.suit === JOKER_SUIT;
export const strength = (rank) => (rank === JOKER_RANK ? 100 : RANKS.length - RANKS.indexOf(rank));
export const cardId = (card) => `${card.rank}${card.suit}`;

export function buildDeck({ joker = false } = {}) {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      if (joker && rank === JOKER_REPLACES.rank && suit === JOKER_REPLACES.suit) continue;
      deck.push({ suit, rank, points: POINTS[rank] });
    }
  }
  if (joker) deck.push({ suit: JOKER_SUIT, rank: JOKER_RANK, points: 0 });
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

// Game points at stake for a contract: [won if made, lost if failed].
export function gamePointValues(bid) {
  if (bid <= 19) return [1, 2];
  if (bid <= 24) return [2, 3]; // "Honours"
  return [3, 4];
}
export const THANI_VALUES = [4, 5];

// ---------------------------------------------------------------- trump & suits

// Is the play at this index in the trick a live trump? Only cards played at or after
// the reveal count — a trump-suit card played earlier was just a discard.
function liveTrump(card, index, trumpSuit, revealIndex) {
  if (!trumpSuit || revealIndex === null || revealIndex === undefined || index < revealIndex) return false;
  return card.suit === trumpSuit || isJoker(card);
}

// The suit others must follow. Normally the first card's suit; a Joker led after the
// reveal leads trumps, and a Joker led while trump is hidden leads nothing, so the
// next real card sets the suit.
export function leadSuit(trick, trumpSuit = null, revealIndex = null) {
  for (const [index, play] of trick.entries()) {
    if (!isJoker(play.card)) return play.card.suit;
    if (liveTrump(play.card, index, trumpSuit, revealIndex)) return trumpSuit;
  }
  return null;
}

const stateLead = (state) =>
  leadSuit(state.trick, state.trumpSuit, state.trumpRevealed ? state.revealIndex : null);

// Does this card count as the given suit for following? A Joker follows trumps once
// they are revealed and nothing before.
function followsSuit(state, card, suit) {
  if (isJoker(card)) return state.trumpRevealed && !!state.trumpSuit && suit === state.trumpSuit;
  return card.suit === suit;
}

const hiddenTrumpHeldBy = (state, seat) =>
  !state.thani && !state.trumpRevealed && !!state.trumpCard && seat === state.bidWinner;

// ---------------------------------------------------------------- legality

// Follow suit if you can. The simple, state-free version used by the tests.
export function legalPlays(hand, lead) {
  if (!lead) return [...hand];
  const following = hand.filter((c) => c.suit === lead);
  return following.length ? following : [...hand];
}

export const canFollow = (hand, lead) => hand.some((c) => !isJoker(c) && c.suit === lead);

// The complete, state-aware answer to "what may this seat play right now?". Every
// caller — the engine's own validation, the AI, and the UI — must agree on this list,
// or a rejected play loops forever.
export function legalPlaysFor(state, seat) {
  const hand = state.hands[seat];
  if (!hand.length) return [];
  const jokers = hand.filter(isJoker);
  const plain = hand.filter((c) => !isJoker(c));
  const prefer = (subset, fallback) => (subset.length ? subset : fallback);

  // ---- leading
  if (!state.trick.length) {
    let options = [...hand];
    // The bidder may not lead the concealed trump suit unless nothing else is left.
    if (hiddenTrumpHeldBy(state, seat)) {
      options = prefer(options.filter((c) => c.suit !== state.trumpSuit), options);
    }
    // A Joker led while trump is hidden leads nothing; hold it back if possible.
    if (!state.trumpRevealed || !state.trumpSuit) {
      options = prefer(options.filter((c) => !isJoker(c)), options);
    }
    return options;
  }

  const lead = stateLead(state);
  if (!lead) return [...hand]; // only a hidden-trump Joker has been played: anything goes

  // ---- following: the Joker is wild and may always be played
  const following = plain.filter((c) => followsSuit(state, c, lead));
  if (following.length) return [...following, ...jokers];

  // ---- void in the led suit
  let options = [...hand];

  // Whoever just called for trump must use it if they hold one.
  const mustTrump =
    state.trumpRevealed &&
    state.revealedBy === seat &&
    state.revealIndex === state.trick.length;
  if (mustTrump) {
    options = prefer(options.filter((c) => followsSuit(state, c, state.trumpSuit)), options);
  } else if (hiddenTrumpHeldBy(state, seat)) {
    // The bidder, void and not revealing, must discard from a non-trump suit:
    // throwing a trump-suit card face up would give the secret away.
    options = prefer(options.filter((c) => c.suit !== state.trumpSuit), options);
  }

  if (state.rules.noJackDiscard) {
    // A Jack may not be thrown away — but the Jack of a revealed trump may still trump.
    const keep = (c) =>
      c.rank !== "J" || (state.trumpRevealed && c.suit === state.trumpSuit);
    options = prefer(options.filter(keep), options);
  }
  return options;
}

// A player may ask for the trump to be shown only when they cannot follow the led
// suit — never on a lead, and never while still holding the suit. The bidder may
// reveal it too, but only when a NON-trump suit was led.
export function mayRequestTrump(state, seat) {
  if (state.phase !== "playing" || state.thani) return false;
  if (state.trumpRevealed || !state.trumpCard) return false;
  if (!state.trick.length) return false;
  const lead = stateLead(state);
  if (!lead) return false;
  if (canFollow(state.hands[seat], lead)) return false;
  if (seat === state.bidWinner && lead === state.trumpSuit) return false;
  return true;
}

// ---------------------------------------------------------------- trick resolution

// Highest live trump wins; otherwise the highest card of the suit that was led.
// Cards played before the reveal cannot win as trumps, and a Joker played before
// the reveal cannot win at all.
export function trickWinner(trick, trumpSuit, revealedAtIndex = null) {
  const lead = leadSuit(trick, trumpSuit, revealedAtIndex);
  let best = null;
  for (const [index, play] of trick.entries()) {
    const trump = liveTrump(play.card, index, trumpSuit, revealedAtIndex);
    const follows = !isJoker(play.card) && play.card.suit === lead;
    if (!trump && !follows) continue;
    const rank = strength(play.card.rank);
    if (!best || (trump && !best.trump) || (trump === best.trump && rank > best.rank)) {
      best = { seat: play.seat, trump, rank };
    }
  }
  return best ? best.seat : trick[0].seat;
}

// ---------------------------------------------------------------- game state

// `deck` lets the tests stack the cards; normal play shuffles a fresh one.
export function createGame({ random = Math.random, dealer = 1, rules = {}, deck: stacked = null } = {}) {
  const merged = { ...DEFAULT_RULES, ...rules };
  const deck = stacked ? [...stacked] : shuffle(buildDeck({ joker: merged.joker }), random);
  const hands = [[], [], [], []];
  // Four each to start, beginning on the dealer's right; the rest after trump is set.
  let seat = nextSeat(dealer);
  for (let i = 0; i < FIRST_DEAL * 4; i++) {
    hands[seat].push(deck[i]);
    seat = nextSeat(seat);
  }

  return {
    rules: merged,
    phase: "bidding",
    deck,
    dealt: FIRST_DEAL * 4,
    hands,
    dealtHands: null, // full eight-card hands as dealt, for the redeal checks
    dealer,
    turn: nextSeat(dealer), // the player on the dealer's right opens
    bids: [],
    passed: [false, false, false, false],
    highBid: 0, // the contract as bid
    target: 0, // the contract to make, after any Pair
    bidWinner: null,
    trumpSuit: null,
    trumpCard: null,
    trumpRevealed: false,
    revealedBy: null,
    revealIndex: null, // index within the current trick at which trump became live
    raiseStep: 0,
    raisedByPartner: false,
    doubleStep: 0,
    multiplier: 1, // 2 when doubled, 4 when redoubled
    thani: false,
    pair: null,
    wonAfterReveal: [false, false],
    trick: [],
    tricksPlayed: 0,
    tricksWon: [0, 0],
    captured: [[], []], // cards won, by team
    concession: null, // { by: losing team, resumeTurn }
    cotRefused: null, // the team that refused a concession and must now take every trick
    lastWinner: null,
    redealReason: null,
    log: [],
    result: null,
  };
}

export function say(state, text) {
  state.log.push(text);
  if (state.log.length > 200) state.log.shift();
  return state;
}

function redeal(state, reason) {
  state.phase = "redeal";
  state.redealReason = reason;
  say(state, `Redeal: ${reason}`);
  return state;
}

// ---------------------------------------------------------------- bidding

// The lowest bid this seat may make now.
export function minBidFor(state, seat) {
  let floor = Math.max(state.rules.minBid, state.highBid + 1);
  const overPartner =
    state.bidWinner !== null && state.bidWinner !== seat && teamOf(state.bidWinner) === teamOf(seat);
  if (overPartner) floor = Math.max(floor, PARTNER_OVERCALL);
  return floor;
}

// The opener must open; everyone after may pass.
export const mayPass = (state) => state.bids.length > 0;

// The opener may refuse to bid on four pointless cards and demand a redeal.
export function mayRequestRedeal(state, seat) {
  return (
    state.phase === "bidding" &&
    state.turn === seat &&
    state.bids.length === 0 &&
    !state.passed.some(Boolean) &&
    handPoints(state.hands[seat]) === 0
  );
}

export function requestRedeal(state, seat) {
  if (!mayRequestRedeal(state, seat)) return state;
  return redeal(state, `${SEATS[seat]} has no points in the first four cards.`);
}

export function placeBid(state, seat, bid) {
  if (state.phase !== "bidding" || state.turn !== seat) return state;

  if (bid === null) {
    if (!mayPass(state)) return state;
    state.passed[seat] = true;
    say(state, `${SEATS[seat]} passes.`);
  } else {
    if (bid < minBidFor(state, seat) || bid > MAX_BID) return state;
    state.highBid = bid;
    state.target = bid;
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

  do {
    state.turn = nextSeat(state.turn);
  } while (state.passed[state.turn]);
  return state;
}

// ---------------------------------------------------------------- trump & deal

export function chooseTrump(state, card) {
  if (state.phase !== "trump" || isJoker(card)) return state;
  const hand = state.hands[state.bidWinner];
  const index = hand.findIndex((c) => cardId(c) === cardId(card));
  if (index < 0) return state;

  // The chosen card is set aside face down; it rejoins the hand when revealed.
  state.trumpCard = hand.splice(index, 1)[0];
  state.trumpSuit = state.trumpCard.suit;

  if (state.dealt < state.deck.length) {
    dealRest(state);
    return afterDeal(state);
  }
  // A partner who took over in the second round has just set a new trump.
  say(state, `${SEATS[state.bidWinner]} sets a new trump face down.`);
  return enterDouble(state);
}

function dealRest(state) {
  let seat = nextSeat(state.dealer);
  for (let i = 0; i < FIRST_DEAL * 4; i++) {
    state.hands[seat].push(state.deck[state.dealt + i]);
    seat = nextSeat(seat);
  }
  state.dealt += FIRST_DEAL * 4;
  state.dealtHands = state.hands.map((h, s) =>
    s === state.bidWinner ? [...h, state.trumpCard] : [...h],
  );
  say(state, "Trump is set face down. The rest of the cards are dealt.");
}

// Checks that can only be made once everyone holds eight cards.
function afterDeal(state) {
  for (let seat = 0; seat < 4; seat++) {
    const cards = state.dealtHands[seat];
    if (cards.filter((c) => c.rank === "J").length === 4) {
      return redeal(state, `${SEATS[seat]} holds all four Jacks.`);
    }
    if (state.rules.pointlessRedeal && handPoints(cards) === 0) {
      return redeal(state, `${SEATS[seat]} has no points in all eight cards.`);
    }
  }
  return enterRaise(state);
}

// ---------------------------------------------------------------- second round

function enterRaise(state) {
  if (!state.rules.secondRound && !state.rules.thani) return enterDouble(state);
  state.phase = "raise";
  state.raiseStep = 0;
  state.turn = state.bidWinner;
  return state;
}

export const minRaise = (state) => Math.max(SECOND_ROUND_MIN, state.highBid + 1);

export function mayRaise(state, seat) {
  return (
    state.phase === "raise" &&
    state.turn === seat &&
    state.rules.secondRound &&
    !state.raisedByPartner &&
    minRaise(state) <= MAX_BID
  );
}

export const mayDeclareThani = (state, seat) =>
  state.phase === "raise" && state.raiseStep === 0 && seat === state.bidWinner && state.rules.thani;

// bid === null declines. The bidder speaks first, then the partner. A partner who
// raises takes the contract over and sets a new trump.
export function raiseBid(state, seat, bid) {
  if (state.phase !== "raise" || state.turn !== seat) return state;

  if (bid !== null) {
    if (!mayRaise(state, seat) || bid < minRaise(state) || bid > MAX_BID) return state;
    state.highBid = bid;
    state.target = bid;
    state.bids.push({ seat, bid, round: 2 });
    if (seat !== state.bidWinner) {
      // The old bidder's face-down card goes back to them; the partner now chooses.
      state.hands[state.bidWinner].push(state.trumpCard);
      state.trumpCard = null;
      state.trumpSuit = null;
      state.bidWinner = seat;
      state.raisedByPartner = true;
      state.phase = "trump";
      state.turn = seat;
      say(state, `${SEATS[seat]} raises the contract to ${bid} and will set a new trump.`);
      return state;
    }
    say(state, `${SEATS[seat]} raises the contract to ${bid}.`);
  } else {
    say(state, `${SEATS[seat]} ${state.raiseStep === 0 ? "keeps the contract" : "does not raise"}.`);
  }

  if (state.raiseStep === 0 && state.rules.secondRound) {
    state.raiseStep = 1;
    state.turn = partnerOf(state.bidWinner);
    return state;
  }
  return enterDouble(state);
}

// Thani: the bidder will win all eight tricks alone. There is no trump; the bidder
// leads and the partner sits out.
export function declareThani(state, seat) {
  if (!mayDeclareThani(state, seat)) return state;
  state.thani = true;
  state.hands[seat].push(state.trumpCard);
  state.trumpCard = null;
  state.trumpSuit = null;
  say(state, `${SEATS[seat]} declares Thani — to win every trick alone, with no trump.`);
  return startPlay(state);
}

// ---------------------------------------------------------------- doubling

function enterDouble(state) {
  if (!state.rules.double) return startPlay(state);
  state.phase = "double";
  state.doubleStep = 0;
  state.turn = nextSeat(state.bidWinner); // the opponent on the bidder's right speaks first
  return state;
}

export function decideDouble(state, seat, yes) {
  if (state.phase !== "double" || state.turn !== seat) return state;
  if (yes) {
    state.multiplier = 2;
    say(state, `${SEATS[seat]} doubles.`);
    state.phase = "redouble";
    state.turn = state.bidWinner;
    return state;
  }
  say(state, `${SEATS[seat]} does not double.`);
  if (state.doubleStep === 0) {
    state.doubleStep = 1;
    state.turn = partnerOf(seat);
    return state;
  }
  return startPlay(state);
}

export function decideRedouble(state, seat, yes) {
  if (state.phase !== "redouble" || state.turn !== seat) return state;
  if (yes) {
    state.multiplier = 4;
    say(state, `${SEATS[seat]} redoubles.`);
  } else {
    say(state, `${SEATS[seat]} does not redouble.`);
  }
  return startPlay(state);
}

// ---------------------------------------------------------------- play

function startPlay(state) {
  state.phase = "playing";
  state.turn = state.thani ? state.bidWinner : nextSeat(state.dealer);
  say(state, `${SEATS[state.turn]} leads.`);
  return state;
}

const sitsOut = (state, seat) => state.thani && seat === partnerOf(state.bidWinner);
export const playersInTrick = (state) => (state.thani ? 3 : 4);

function nextInPlay(state, seat) {
  let next = nextSeat(seat);
  if (sitsOut(state, next)) next = nextSeat(next);
  return next;
}

function doReveal(state, seat) {
  state.trumpRevealed = true;
  state.revealedBy = seat;
  state.revealIndex = seat === null ? 0 : state.trick.length; // live from this play onward
  state.hands[state.bidWinner].push(state.trumpCard); // the face-down card comes back
  const name = `${SUIT_NAMES[state.trumpSuit]} ${state.trumpSuit}`;
  say(
    state,
    seat === null
      ? `Trump is still hidden for the last trick, so it is turned up: ${name}.`
      : `${SEATS[seat]} calls for trump — it is ${name}.`,
  );

  // The hand is void if the opponents were dealt no trumps at all.
  const opponents = [nextSeat(state.bidWinner), partnerOf(nextSeat(state.bidWinner))];
  const oppTrumps = opponents.some((s) => state.dealtHands[s].some((c) => c.suit === state.trumpSuit));
  if (!oppTrumps) return redeal(state, "the bidding side was dealt every trump.");
  return state;
}

export function revealTrump(state, seat) {
  if (!mayRequestTrump(state, seat)) return state;
  return doReveal(state, seat);
}

// Pair: the King and Queen of trump in one hand. Shown on your own turn, after trump
// is revealed and after your side has won a trick since. It lowers your own side's
// contract by 4, or raises the opponents' by 4.
export function mayDeclarePair(state, seat) {
  if (!state.rules.pair || state.thani || state.pair) return false;
  if (state.phase !== "playing" || state.turn !== seat || !state.trumpRevealed) return false;
  if (!state.wonAfterReveal[teamOf(seat)]) return false;
  const hand = state.hands[seat];
  return ["K", "Q"].every((rank) => hand.some((c) => c.rank === rank && c.suit === state.trumpSuit));
}

export function declarePair(state, seat) {
  if (!mayDeclarePair(state, seat)) return state;
  const from = state.target;
  const forBidders = teamOf(seat) === teamOf(state.bidWinner);
  state.target = forBidders
    ? Math.max(state.rules.minBid, from - PAIR_SWING)
    : Math.min(MAX_BID, from + PAIR_SWING);
  state.pair = { seat, team: teamOf(seat), from, to: state.target };
  say(state, `${SEATS[seat]} shows the Pair (K+Q of trump): the contract goes from ${from} to ${state.target}.`);
  return state;
}

export function playCard(state, seat, card) {
  if (state.phase !== "playing" || state.turn !== seat) return state;
  const hand = state.hands[seat];
  const index = hand.findIndex((c) => cardId(c) === cardId(card));
  if (index < 0) return state;

  // One source of truth for legality, shared with the AI and the UI.
  if (!legalPlaysFor(state, seat).some((c) => cardId(c) === cardId(card))) return state;

  hand.splice(index, 1);
  state.trick.push({ seat, card });
  say(state, `${SEATS[seat]} plays ${isJoker(card) ? "the Joker" : card.rank + card.suit}.`);

  if (state.trick.length < playersInTrick(state)) {
    state.turn = nextInPlay(state, seat);
    return state;
  }
  return resolveTrick(state);
}

export function resolveTrick(state) {
  const winner = trickWinner(state.trick, state.trumpSuit, state.trumpRevealed ? state.revealIndex : null);
  const team = teamOf(winner);
  const cards = state.trick.map((p) => p.card);
  state.captured[team].push(...cards);
  state.tricksWon[team]++;
  if (state.trumpRevealed) state.wonAfterReveal[team] = true;
  const won = handPoints(cards);
  say(state, `${SEATS[winner]} takes the trick${won ? ` (${won} point${won > 1 ? "s" : ""})` : ""}.`);

  state.trick = [];
  state.revealIndex = state.trumpRevealed ? 0 : null; // trump stays live for later tricks
  state.tricksPlayed++;
  state.lastWinner = winner;
  state.turn = winner;

  // Thani is lost the moment the declarer loses a trick.
  if (state.thani && winner !== state.bidWinner) return score(state);
  if (state.tricksPlayed === HAND_SIZE) return score(state);

  // Still hidden with one trick to go: turn it up so the last trick has a trump.
  if (state.tricksPlayed === HAND_SIZE - 1 && !state.trumpRevealed && state.trumpCard && !state.thani) {
    doReveal(state, null);
  }
  return state;
}

// ---------------------------------------------------------------- Cot & concession

// The side that has lost every trick so far may concede the rest.
export function mayConcede(state, seat) {
  if (!state.rules.cot || state.thani || state.phase !== "playing") return false;
  if (state.cotRefused !== null || state.tricksPlayed === 0) return false;
  const team = teamOf(seat);
  return state.tricksWon[team] === 0 && state.tricksWon[1 - team] === state.tricksPlayed;
}

export function concede(state, seat) {
  if (!mayConcede(state, seat)) return state;
  state.concession = { by: teamOf(seat), resumeTurn: state.turn };
  state.phase = "concession";
  state.turn = [0, 1, 2, 3].find((s) => teamOf(s) !== teamOf(seat) && s === state.lastWinner) ?? nextSeat(seat);
  say(state, `${SEATS[seat]} concedes the remaining tricks.`);
  return state;
}

// The winning side accepts (single score, hand over) or plays on for double — and
// then loses double if they drop a single trick.
export function answerConcession(state, seat, accept) {
  if (state.phase !== "concession" || teamOf(seat) === state.concession.by) return state;
  const winners = 1 - state.concession.by;
  if (accept) {
    say(state, `${SEATS[seat]} accepts.`);
    return score(state, { concededTo: winners });
  }
  say(state, `${SEATS[seat]} plays on — every remaining trick for double, or lose double.`);
  state.cotRefused = winners;
  state.phase = "playing";
  state.turn = state.concession.resumeTurn;
  state.concession = null;
  return state;
}

// ---------------------------------------------------------------- scoring

export function score(state, { concededTo = null } = {}) {
  const biddingTeam = teamOf(state.bidWinner);
  const got = handPoints(state.captured[biddingTeam]);
  const opponents = handPoints(state.captured[1 - biddingTeam]);
  const [win, lose] = state.thani ? THANI_VALUES : gamePointValues(state.target);
  const multiplier = state.thani ? 1 : state.multiplier;

  let made;
  let factor = 1;
  let cot = null;
  let note = "";

  if (state.thani) {
    made = state.tricksPlayed === HAND_SIZE && state.tricksWon[biddingTeam] === HAND_SIZE;
  } else if (concededTo !== null) {
    made = concededTo === biddingTeam;
    note = "conceded";
  } else {
    made = got >= state.target;
    if (state.tricksWon[0] === HAND_SIZE) cot = 0;
    if (state.tricksWon[1] === HAND_SIZE) cot = 1;
    if (state.rules.cot && state.cotRefused !== null) {
      factor = 2;
      made = cot === state.cotRefused ? state.cotRefused === biddingTeam : state.cotRefused !== biddingTeam;
      note = cot === state.cotRefused ? "cot after playing on" : "played on and lost a trick";
    } else if (state.rules.cot && cot !== null) {
      factor = 2;
      note = "cot";
    }
  }

  const amount = (made ? win : lose) * multiplier * factor;
  const delta = [0, 0];
  delta[biddingTeam] = made ? amount : -amount;

  state.phase = "done";
  state.result = {
    biddingTeam,
    bid: state.highBid,
    target: state.target,
    got,
    opponents,
    made,
    thani: state.thani,
    multiplier,
    cot,
    factor,
    note,
    pair: state.pair,
    delta,
  };
  const what = state.thani ? "Thani" : `Contract ${state.target}`;
  say(
    state,
    `${what} ${made ? "made" : "failed"}${note ? ` (${note})` : ""}: ${made ? "+" : "−"}${amount} game point${amount === 1 ? "" : "s"} to ${biddingTeam === 0 ? "South–North" : "West–East"}.`,
  );
  return state;
}

// Match standing: first side to +6 wins; a side that sinks to −6 loses.
export function matchWinner(gameScore) {
  for (const team of [0, 1]) {
    if (gameScore[team] >= MATCH_TARGET) return team;
    if (gameScore[team] <= -MATCH_TARGET) return 1 - team;
  }
  return null;
}
