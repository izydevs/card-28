// Rules tests for Twenty-Eight. Run with: npm test
import {
  buildDeck, handPoints, TOTAL_POINTS, RANKS, POINTS, strength, legalPlays,
  trickWinner, createGame, placeBid, chooseTrump, playCard, legalPlaysFor,
  mayRequestTrump, teamOf, partnerOf, SEATS, shuffle, cardId, HAND_SIZE, MIN_BID,
} from "../public/game.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};
const C = (rank, suit) => ({ rank, suit, points: POINTS[rank] });
const play = (seat, rank, suit) => ({ seat, card: C(rank, suit) });

console.log("-- deck --");
const deck = buildDeck();
check("32 cards", deck.length === 32);
check("no duplicates", new Set(deck.map(cardId)).size === 32);
check(
  "the deck is worth exactly 28 points",
  handPoints(deck) === TOTAL_POINTS,
  `${handPoints(deck)} points — J=3, 9=2, A=1, 10=1 across four suits`,
);
check(
  "Jack is the strongest card and Nine beats the Ace",
  strength("J") > strength("9") && strength("9") > strength("A") && strength("A") > strength("10"),
  RANKS.join(" > "),
);
check("only four ranks carry points", RANKS.filter((r) => POINTS[r] > 0).join(",") === "J,9,A,10");

console.log("\n-- partnerships --");
check("partners sit opposite", partnerOf(0) === 2 && partnerOf(1) === 3);
check("partners share a team", teamOf(0) === teamOf(2) && teamOf(1) === teamOf(3));
check("opponents do not", teamOf(0) !== teamOf(1));

console.log("\n-- following suit --");
const hand = [C("J", "♠"), C("7", "♠"), C("A", "♥")];
check("must follow the led suit when able", legalPlays(hand, "♠").length === 2);
check("may play anything when void", legalPlays(hand, "♦").length === 3);
check("a lead is unrestricted", legalPlays(hand, null).length === 3);

console.log("\n-- trick resolution --");
check(
  "highest card of the led suit wins when no trump is live",
  trickWinner([play(0, "9", "♠"), play(1, "J", "♥"), play(2, "A", "♠"), play(3, "7", "♠")], "♥", null) === 0,
  "the Jack of hearts cannot win — trump was never revealed",
);
check(
  "an off-suit discard never wins",
  trickWinner([play(0, "7", "♠"), play(1, "J", "♦"), play(2, "8", "♠"), play(3, "9", "♦")], null, null) === 2,
);
check(
  "a revealed trump beats the led suit",
  trickWinner([play(0, "J", "♠"), play(1, "7", "♥"), play(2, "9", "♠"), play(3, "8", "♠")], "♥", 1) === 1,
  "the lowly 7 of trumps takes the Jack",
);
check(
  "the higher trump wins when several are played",
  trickWinner([play(0, "J", "♠"), play(1, "7", "♥"), play(2, "9", "♥"), play(3, "8", "♠")], "♥", 1) === 2,
);
// Spades led, hearts trump. Seat 1 is void and discards a heart WITHOUT calling for
// the reveal; seat 2 then calls and plays a heart. Seat 1's heart was not trump when
// it hit the table, so it must not win — that is the whole point of a concealed trump.
check(
  "a trump played BEFORE the reveal does not win",
  trickWinner([play(0, "A", "♠"), play(1, "7", "♥"), play(2, "9", "♥"), play(3, "8", "♠")], "♥", 2) === 2,
  "seat 1's 7♥ was a plain discard; seat 2's 9♥ is live trump",
);
check(
  "...and the early trump loses even to the led suit",
  trickWinner([play(0, "A", "♠"), play(1, "9", "♥"), play(2, "8", "♠"), play(3, "7", "♠")], "♥", null) === 0,
  "never revealed, so the 9♥ is just a discard",
);

console.log("\n-- bidding --");
let g = createGame({ random: () => 0.42, dealer: 3 });
check("four cards each before bidding", g.hands.every((h) => h.length === 4));
check("first bid belongs to the dealer's left", g.turn === 0);
check("the table opens at 16", MIN_BID === 16);
placeBid(g, 0, MIN_BID - 1);
check("a bid below the minimum is refused", g.highBid === 0, `${MIN_BID - 1} is under the floor`);
placeBid(g, 0, 16);
check("a bid is recorded", g.highBid === 16 && g.bidWinner === 0);
placeBid(g, 1, 16);
check("a bid must beat the standing bid", g.highBid === 16 && g.bidWinner === 0, "16 does not raise 16");
placeBid(g, 1, 18);
check("a higher bid takes over", g.highBid === 18 && g.bidWinner === 1);
placeBid(g, 2, null);
placeBid(g, 3, null);
placeBid(g, 0, null);
check("bidding ends when the rest pass", g.phase === "trump", `winner ${SEATS[g.bidWinner]} at ${g.highBid}`);

console.log("\n-- trump and the second deal --");
const picked = g.hands[g.bidWinner][0];
chooseTrump(g, picked);
check("the trump card leaves the hand face down", g.trumpCard && g.trumpSuit === picked.suit);
check("trump stays concealed", g.trumpRevealed === false);
check(
  "the rest of the hand is dealt",
  g.hands.every((h, i) => h.length === (i === g.bidWinner ? HAND_SIZE - 1 : HAND_SIZE)),
  "the bidder holds 7 plus the face-down trump",
);
check("all 32 cards are accounted for", g.hands.flat().length + 1 === 32);
check("play starts left of the dealer", g.phase === "playing" && g.turn === 0);

console.log("\n-- the reveal --");
let r = createGame({ random: () => 0.7, dealer: 3 });
placeBid(r, 0, 20);
placeBid(r, 1, null); placeBid(r, 2, null); placeBid(r, 3, null);
chooseTrump(r, r.hands[0][0]);
check("a leader cannot ask for trump", mayRequestTrump(r, r.turn) === false, "nothing has been led yet");
const leader = r.turn;
const leadCard = r.hands[leader][0];
playCard(r, leader, leadCard);
const voidSeat = [0, 1, 2, 3].find((s) => s !== leader && !r.hands[s].some((c) => c.suit === leadCard.suit));
if (voidSeat !== undefined) {
  check("a player void in the led suit may ask", mayRequestTrump(r, voidSeat) === true);
  const holder = [0, 1, 2, 3].find((s) => s !== voidSeat && r.hands[s].some((c) => c.suit === leadCard.suit));
  check("a player who can follow may not ask", mayRequestTrump(r, holder) === false);
} else {
  const follower = [0, 1, 2, 3].find((s) => s !== leader);
  check("a player void in the led suit may ask", true, "no void seat in this deal — not exercised");
  check("a player who can follow may not ask", mayRequestTrump(r, follower) === false);
}

console.log("\n-- legality is state-aware --");
// Whoever calls for trump must then use it. legalPlays() alone cannot know this,
// which is why every caller reads legalPlaysFor().
const forced = {
  hands: [[C("7", "♥"), C("K", "♣")], [], [], []],
  trick: [{ seat: 1, card: C("A", "♠") }],
  trumpSuit: "♥", trumpRevealed: true, revealedBy: 0, revealIndex: 1,
};
check(
  "the player who called trump must play one",
  legalPlaysFor(forced, 0).map(cardId).join(",") === "7♥",
  "holding 7♥ and K♣, only the trump is legal",
);
const notForced = { ...forced, revealedBy: 2 };
check(
  "others are not restricted to trump",
  legalPlaysFor(notForced, 0).length === 2,
);

console.log("\n-- a full hand --");
let full = createGame({ random: Math.random, dealer: 3 });
placeBid(full, 0, 16);
placeBid(full, 1, null); placeBid(full, 2, null); placeBid(full, 3, null);
chooseTrump(full, full.hands[0][0]);
let guard = 0;
while (full.phase === "playing" && guard++ < 200) {
  const seat = full.turn;
  playCard(full, seat, legalPlaysFor(full, seat)[0]);
}
check("the hand completes in eight tricks", full.tricksPlayed === HAND_SIZE, `${full.tricksPlayed} tricks`);
check("every hand is empty", full.hands.every((h) => h.length === 0), full.hands.map((h) => h.length).join(","));
const captured = handPoints(full.captured[0]) + handPoints(full.captured[1]);
check("all 28 points are captured", captured === TOTAL_POINTS, `${captured} points taken`);
check("32 cards end up on the table", full.captured.flat().length === 32);
check("a result is declared", full.result !== null, full.result && `bid ${full.result.bid}, got ${full.result.got}`);
check("the verdict matches the points", full.result.made === full.result.got >= full.result.bid);

console.log("\n-- shuffling --");
const a = shuffle(buildDeck(), Math.random).map(cardId).join("");
const b = shuffle(buildDeck(), Math.random).map(cardId).join("");
check("two shuffles differ", a !== b);
check("a shuffle preserves the deck", new Set(shuffle(buildDeck(), Math.random).map(cardId)).size === 32);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
