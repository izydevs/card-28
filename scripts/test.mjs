// Rules tests for Twenty-Eight. Run with: npm test
import {
  buildDeck, handPoints, TOTAL_POINTS, RANKS, POINTS, strength, legalPlays, trickWinner,
  createGame, placeBid, chooseTrump, playCard, legalPlaysFor, mayRequestTrump, revealTrump,
  teamOf, partnerOf, nextSeat, SEATS, shuffle, cardId, HAND_SIZE, MIN_BID, minBidFor,
  mayPass, requestRedeal, raiseBid, declareThani, decideDouble, decideRedouble,
  declarePair, mayDeclarePair, concede, answerConcession, gamePointValues, matchWinner,
  isJoker, JOKER_SUIT, JOKER_RANK, leadSuit,
} from "../public/game.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};
const section = (name) => console.log(`\n-- ${name} --`);
const C = (rank, suit) => ({ rank, suit, points: POINTS[rank] ?? 0 });
const JOKER = { rank: JOKER_RANK, suit: JOKER_SUIT, points: 0 };
const parse = (s) => (s === "JK" ? JOKER : C(s.slice(0, -1), s.slice(-1)));
const play = (seat, s) => ({ seat, card: parse(s) });
const ids = (cards) => cards.map(cardId).sort().join(",");

// Stack a deck so each seat is dealt exactly the eight cards given (first four in
// the first deal). Seats left short are filled from what remains.
// Filler cards can easily leave a seat pointless, which is itself a redeal; rigged
// deals switch that rule off unless a test asks for it.
function rig({ dealer = 1, rules: given = {}, hands }) {
  const rules = { pointlessRedeal: false, ...given };
  const pool = buildDeck({ joker: !!rules.joker });
  const take = (s) => {
    const card = parse(s);
    const i = pool.findIndex((c) => cardId(c) === cardId(card));
    if (i < 0) throw new Error(`card ${s} not in deck`);
    return pool.splice(i, 1)[0];
  };
  const full = [0, 1, 2, 3].map((seat) => (hands[seat] ?? []).map(take));
  for (const h of full) while (h.length < 8) h.push(pool.shift());
  const order = [];
  let seat = nextSeat(dealer);
  for (let i = 0; i < 4; i++) { order.push(seat); seat = nextSeat(seat); }
  const deck = [];
  for (const round of [0, 1, 2, 3]) for (const s of order) deck.push(full[s][round]);
  for (const round of [4, 5, 6, 7]) for (const s of order) deck.push(full[s][round]);
  return createGame({ dealer, rules, deck });
}

// Bid, pick trump, decline everything optional — straight to play.
function toPlay(game, { bidder = 0, bid = 16, trump, rules } = {}) {
  void rules;
  while (game.phase === "bidding") {
    if (game.turn === bidder) placeBid(game, bidder, Math.max(bid, minBidFor(game, bidder)));
    else placeBid(game, game.turn, null);
  }
  chooseTrump(game, parse(trump));
  while (game.phase === "raise") raiseBid(game, game.turn, null);
  while (game.phase === "double") decideDouble(game, game.turn, false);
  return game;
}

section("deck");
const deck = buildDeck();
check("32 cards", deck.length === 32);
check("no duplicates", new Set(deck.map(cardId)).size === 32);
check("the deck is worth exactly 28 points", handPoints(deck) === TOTAL_POINTS);
check("J > 9 > A > 10 > K > Q > 8 > 7", RANKS.every((r, i) => i === 0 || strength(RANKS[i - 1]) > strength(r)));
check("only four ranks carry points", RANKS.filter((r) => POINTS[r] > 0).join(",") === "J,9,A,10");
const jdeck = buildDeck({ joker: true });
check("Joker deck: still 32 cards and 28 points", jdeck.length === 32 && handPoints(jdeck) === 28);
check("Joker deck: the Joker replaces the 7♣", jdeck.some(isJoker) && !jdeck.some((c) => cardId(c) === "7♣"));

section("seats and turn order");
check("partners sit opposite", partnerOf(0) === 2 && partnerOf(1) === 3);
check("partners share a team", teamOf(0) === teamOf(2) && teamOf(1) === teamOf(3));
check("play runs counter-clockwise: South → East → North → West", [nextSeat(0), nextSeat(3), nextSeat(2), nextSeat(1)].join() === "3,2,1,0");
let g = createGame({ dealer: 1 });
check("the player on the dealer's right opens", g.turn === 0, "West deals, South opens");
check("four cards each before bidding", g.hands.every((h) => h.length === 4));

section("following suit");
const hand = [C("J", "♠"), C("7", "♠"), C("A", "♥")];
check("must follow the led suit when able", legalPlays(hand, "♠").length === 2);
check("may play anything when void", legalPlays(hand, "♦").length === 3);

section("trick resolution");
check("highest of the led suit wins with no trump live",
  trickWinner([play(0, "9♠"), play(1, "J♥"), play(2, "A♠"), play(3, "7♠")], "♥", null) === 0);
check("a revealed trump beats the led suit",
  trickWinner([play(0, "J♠"), play(1, "7♥"), play(2, "9♠"), play(3, "8♠")], "♥", 1) === 1);
check("the higher trump wins",
  trickWinner([play(0, "J♠"), play(1, "7♥"), play(2, "9♥"), play(3, "8♠")], "♥", 1) === 2);
check("a trump played BEFORE the reveal does not win",
  trickWinner([play(0, "A♠"), play(1, "7♥"), play(2, "9♥"), play(3, "8♠")], "♥", 2) === 2);

section("bidding");
g = createGame({ dealer: 1 });
check("the table opens at 16 by default", MIN_BID === 16 && minBidFor(g, 0) === 16);
check("the opener may not pass", mayPass(g) === false);
placeBid(g, 0, null);
check("...and a pass from the opener is refused", g.turn === 0 && !g.passed[0]);
placeBid(g, 0, 15);
check("a bid below the minimum is refused", g.highBid === 0);
placeBid(g, 0, 16);
check("a bid is recorded", g.highBid === 16 && g.bidWinner === 0);
placeBid(g, 3, 16);
check("a bid must beat the standing bid", g.bidWinner === 0);
placeBid(g, 3, null);
check("bidding over your partner needs 20", minBidFor(g, 2) === 20);
placeBid(g, 2, 19);
check("...so 19 over partner is refused", g.bidWinner === 0);
placeBid(g, 2, 20);
check("...and 20 is accepted", g.bidWinner === 2 && g.highBid === 20);
placeBid(g, 1, null);
placeBid(g, 0, null);
check("bidding ends when the rest pass", g.phase === "trump" && g.bidWinner === 2);
check("the table can open at 14 as a house rule", minBidFor(createGame({ rules: { minBid: 14 } }), 0) === 14);

section("redeals");
g = rig({ hands: { 0: ["K♠", "Q♠", "8♥", "7♦"] } });
requestRedeal(g, 0);
check("an opener with four pointless cards may demand a redeal", g.phase === "redeal");
g = rig({ hands: { 0: ["J♠", "Q♠", "8♥", "7♦"] } });
requestRedeal(g, 0);
check("...but not with a point in hand", g.phase === "bidding");
g = rig({ hands: { 3: ["7♠", "8♠", "K♥", "Q♥", "J♠", "J♥", "J♦", "J♣"] } });
toPlay(g, { trump: g.hands[0][0].rank + g.hands[0][0].suit });
check("all four Jacks in one hand forces a redeal", g.phase === "redeal", g.redealReason);
g = rig({ rules: { pointlessRedeal: true }, hands: { 3: ["7♠", "8♠", "K♥", "Q♥", "K♠", "Q♠", "7♥", "8♥"] } });
toPlay(g, { trump: g.hands[0][0].rank + g.hands[0][0].suit });
check("an eight-card hand without points forces a redeal", g.phase === "redeal", g.redealReason);
g = rig({ rules: { pointlessRedeal: false }, hands: { 3: ["7♠", "8♠", "K♥", "Q♥", "K♠", "Q♠", "7♥", "8♥"] } });
toPlay(g, { trump: g.hands[0][0].rank + g.hands[0][0].suit });
check("...unless that house rule is off", g.phase === "playing");

section("the face-down trump and the second deal");
g = rig({ hands: { 0: ["J♠", "9♠", "A♠", "10♥", "K♠", "Q♦", "8♣", "7♥"] } });
placeBid(g, 0, 16); placeBid(g, 3, null); placeBid(g, 2, null); placeBid(g, 1, null);
chooseTrump(g, C("A", "♠"));
check("the trump card leaves the hand face down", g.trumpSuit === "♠" && !g.trumpRevealed && g.hands[0].length === 7);
check("everyone else holds eight", [1, 2, 3].every((s) => g.hands[s].length === 8));
check("the second round follows", g.phase === "raise" && g.turn === 0);

section("second round (24+)");
raiseBid(g, 0, 23);
check("a raise below 24 is refused", g.highBid === 16);
raiseBid(g, 0, 24);
check("the bidder may raise to 24", g.highBid === 24 && g.bidWinner === 0 && g.turn === 2);
raiseBid(g, 2, 25);
check("the partner may raise over it and take the contract", g.bidWinner === 2 && g.phase === "trump");
check("...the old face-down card returns to its owner", g.hands[0].length === 8 && g.trumpCard === null);
chooseTrump(g, g.hands[2][0]);
check("...and the partner sets a new trump", g.trumpSuit === g.trumpCard.suit && g.phase === "double");
check("no further cards are dealt", g.hands.flat().length + 1 === 32);

section("double and redouble");
check("the opponent on the bidder's right decides first", g.turn === nextSeat(2));
decideDouble(g, g.turn, false);
check("then the other opponent", g.turn === partnerOf(nextSeat(2)));
decideDouble(g, g.turn, true);
check("a double hands the choice to the bidder", g.phase === "redouble" && g.turn === 2 && g.multiplier === 2);
decideRedouble(g, 2, true);
check("a redouble makes it ×4 and play starts", g.multiplier === 4 && g.phase === "playing");
check("the player on the dealer's right leads", g.turn === nextSeat(g.dealer));

section("game points");
check("bid 16–19: +1 / −2", gamePointValues(16).join() === "1,2" && gamePointValues(19).join() === "1,2");
check("bid 20–24: +2 / −3", gamePointValues(20).join() === "2,3" && gamePointValues(24).join() === "2,3");
check("bid 25–28: +3 / −4", gamePointValues(25).join() === "3,4" && gamePointValues(28).join() === "3,4");
check("first to +6 wins the match", matchWinner([6, 2]) === 0 && matchWinner([3, 5]) === null);
check("sinking to −6 loses it", matchWinner([-6, 1]) === 1);

section("bidder restrictions while trump is hidden");
// South bids with spades trump (A♠ face down). South also holds K♠ and some hearts.
g = rig({
  hands: {
    0: ["A♠", "K♠", "J♥", "9♥", "Q♠", "8♠", "7♠", "10♠"],
    3: ["J♦", "9♦", "A♦", "10♦", "K♦", "Q♦", "8♦", "7♦"],
  },
});
toPlay(g, { trump: "A♠" });
check("South (on the dealer's right) leads", g.turn === 0);
const leads = legalPlaysFor(g, 0);
check("the bidder may not lead the hidden trump suit", leads.every((c) => c.suit !== "♠"), ids(leads));
playCard(g, 0, C("J", "♥"));
check("East is void in hearts and may call for trump", mayRequestTrump(g, 3));
// Diamonds led by East later: South is void and holds non-trump hearts.
g.trick = [play(3, "J♦")];
g.turn = 0;
g.hands[0] = [C("9", "♥"), C("K", "♠"), C("Q", "♠")];
check("void bidder may reveal on a non-trump lead", mayRequestTrump(g, 0));
check("void bidder not revealing must discard a non-trump", ids(legalPlaysFor(g, 0)) === "9♥");
g.trick = [play(3, "J♠")];
check("when trump is led, the bidder may not reveal", !mayRequestTrump(g, 0));
g.trick = [play(3, "J♦")];
revealTrump(g, 0);
check("after the bidder reveals, they must play a trump", legalPlaysFor(g, 0).every((c) => c.suit === "♠"));

section("the last trick is never played with trump hidden");
g = rig({ hands: { 0: ["J♠", "9♠", "A♠", "10♠", "J♥", "9♥", "A♥", "10♥"], 1: ["J♦", "9♦", "A♦", "10♦", "K♦", "Q♦", "8♦", "7♦"], 2: ["J♣", "9♣", "A♣", "10♣", "K♣", "Q♣", "8♣", "7♣"] } });
toPlay(g, { trump: "10♠" });
let guard = 0;
while (g.phase === "playing" && g.tricksPlayed < 7 && guard++ < 50) {
  const seat = g.turn;
  const opts = legalPlaysFor(g, seat);
  playCard(g, seat, opts[0]);
}
check("trump is turned up before the eighth trick", g.tricksPlayed === 7 && g.trumpRevealed && g.revealIndex === 0, `${g.tricksPlayed} tricks, revealed ${g.trumpRevealed}`);

section("Pair (K+Q of trump)");
g = rig({ hands: { 0: ["7♥", "K♥", "Q♥", "J♠", "9♠", "A♠", "10♠", "K♠"] } });
toPlay(g, { bid: 20, trump: "7♥" });
g.trumpRevealed = true; g.revealIndex = 0; g.hands[0].push(g.trumpCard);
g.turn = 0; g.trick = [];
check("no Pair until your side has won a trick after the reveal", !mayDeclarePair(g, 0));
g.wonAfterReveal[0] = true;
declarePair(g, 0);
check("the bidders' Pair lowers their contract by 4", g.target === 16 && g.highBid === 20);
check("only one Pair per hand", !mayDeclarePair(g, 0));
g = rig({ hands: { 3: ["K♥", "Q♥", "8♥", "8♠", "8♦", "8♣", "7♠", "7♦"], 0: ["7♥", "J♠", "9♠", "A♠", "10♠", "J♦", "9♦", "A♦"] } });
toPlay(g, { bid: 20, trump: "7♥" });
g.trumpRevealed = true; g.revealIndex = 0; g.hands[0].push(g.trumpCard);
g.turn = 3; g.trick = []; g.wonAfterReveal[1] = true;
declarePair(g, 3);
check("the opponents' Pair raises the contract by 4", g.target === 24);

section("Thani");
g = rig({ hands: { 0: ["J♠", "9♠", "A♠", "10♠", "J♥", "9♥", "A♥", "10♥"] } });
placeBid(g, 0, 16); placeBid(g, 3, null); placeBid(g, 2, null); placeBid(g, 1, null);
chooseTrump(g, C("10♠".slice(0, 2), "♠"));
declareThani(g, 0);
check("Thani: no trump, the bidder leads with all eight", g.thani && g.trumpSuit === null && g.turn === 0 && g.hands[0].length === 8);
guard = 0;
while (g.phase === "playing" && guard++ < 50) {
  if (g.turn === 2) { check("Thani: the partner never plays", false); break; }
  playCard(g, g.turn, legalPlaysFor(g, g.turn).sort((a, b) => strength(b.rank) - strength(a.rank))[0]);
}
check("Thani: tricks have three cards", g.captured.flat().length === g.tricksPlayed * 3);
check("Thani made with every trick scores +4", g.result.made && g.result.delta[0] === 4, JSON.stringify(g.result.delta));
g = rig({ hands: { 0: ["J♠", "9♠", "A♠", "10♠", "7♥", "9♥", "A♥", "10♥"], 3: ["J♥"] } });
placeBid(g, 0, 16); placeBid(g, 3, null); placeBid(g, 2, null); placeBid(g, 1, null);
chooseTrump(g, C("10", "♠"));
declareThani(g, 0);
playCard(g, 0, C("7", "♥"));
while (g.phase === "playing") playCard(g, g.turn, legalPlaysFor(g, g.turn).sort((a, b) => strength(b.rank) - strength(a.rank))[0]);
check("Thani ends the moment a trick is lost, −5", !g.result.made && g.tricksPlayed === 1 && g.result.delta[0] === -5);

section("Cot and concession");
const sweep = (rules = {}) => {
  const game = rig({ rules, hands: { 0: ["J♠", "9♠", "A♠", "10♠", "J♥", "9♥", "A♥", "10♥"], 2: ["J♦", "9♦", "A♦", "10♦", "J♣", "9♣", "A♣", "10♣"] } });
  toPlay(game, { trump: "10♠" });
  return game;
};
g = sweep();
while (g.phase === "playing") {
  const opts = legalPlaysFor(g, g.turn).sort((a, b) => strength(b.rank) - strength(a.rank));
  playCard(g, g.turn, opts[0]);
}
check("winning all eight tricks is a Cot, scored double", g.result.cot === 0 && g.result.delta[0] === 2, JSON.stringify(g.result));
g = sweep();
playCard(g, g.turn, legalPlaysFor(g, g.turn).sort((a, b) => strength(b.rank) - strength(a.rank))[0]);
while (g.trick.length) playCard(g, g.turn, legalPlaysFor(g, g.turn)[0]);
if (g.tricksWon[0] === 1) {
  const resume = g.turn;
  concede(g, 1);
  check("the side with no tricks may concede", g.phase === "concession");
  answerConcession(g, 0, true);
  check("an accepted concession scores single", g.phase === "done" && g.result.delta[0] === 1 && g.result.note === "conceded");
  g = sweep();
  playCard(g, g.turn, legalPlaysFor(g, g.turn).sort((a, b) => strength(b.rank) - strength(a.rank))[0]);
  while (g.trick.length) playCard(g, g.turn, legalPlaysFor(g, g.turn)[0]);
  concede(g, 1);
  answerConcession(g, 2, false);
  check("refusing resumes play", g.phase === "playing" && g.cotRefused === 0 && g.turn === resume);
} else {
  check("the side with no tricks may concede", false, "setup did not sweep the first trick");
}

section("all trumps with the bidding side");
g = rig({ hands: { 0: ["J♠", "9♠", "A♠", "10♠", "J♥", "9♥", "A♥", "10♥"], 2: ["K♠", "Q♠", "8♠", "7♠", "J♣", "9♣", "A♣", "10♣"] } });
toPlay(g, { trump: "10♠" });
g.trick = [play(0, "J♥")];
g.turn = 3;
g.hands[3] = g.hands[3].filter((c) => c.suit !== "♥");
if (!g.hands[3].length) g.hands[3] = [C("7", "♦")];
revealTrump(g, 3);
check("revealing a trump the opponents were never dealt voids the hand", g.phase === "redeal", g.redealReason);

section("Joker (house rule)");
check("a Joker led after the reveal leads trumps", leadSuit([play(0, "JK")], "♥", 0) === "♥");
check("a Joker led while hidden leads nothing", leadSuit([play(0, "JK"), play(1, "9♠")], "♥", null) === "♠");
check("after the reveal the Joker is the top trump",
  trickWinner([play(0, "A♠"), play(1, "J♥"), play(2, "JK"), play(3, "8♠")], "♥", 0) === 2);
check("before the reveal the Joker cannot win",
  trickWinner([play(0, "7♠"), play(1, "JK"), play(2, "8♠"), play(3, "K♦")], "♥", null) === 2);
g = rig({ rules: { joker: true }, hands: { 3: ["JK", "J♠", "7♠", "8♥"] } });
toPlay(g, { bidder: 0, trump: g.hands[0].find((c) => !isJoker(c)).rank + g.hands[0].find((c) => !isJoker(c)).suit });
g.trick = [play(0, "9♠")];
g.turn = 3;
const jopts = legalPlaysFor(g, 3);
check("the Joker may be played even when you can follow", jopts.some(isJoker) && jopts.filter((c) => !isJoker(c)).every((c) => c.suit === "♠"), ids(jopts));
g = rig({ rules: { joker: true }, hands: { 0: ["JK", "J♠", "9♠", "A♠"] } });
placeBid(g, 0, 16); placeBid(g, 3, null); placeBid(g, 2, null); placeBid(g, 1, null);
chooseTrump(g, JOKER);
check("the Joker cannot be the face-down trump", g.phase === "trump" && g.trumpCard === null);

section("no Jack discard (house rule)");
g = rig({ rules: { noJackDiscard: true }, hands: { 3: ["J♦", "7♣", "8♣", "9♣"] } });
toPlay(g, { trump: g.hands[0][0].rank + g.hands[0][0].suit });
g.trick = [play(0, "A♥")];
g.turn = 3;
g.hands[3] = [C("J", "♦"), C("7", "♣")];
check("a Jack may not be thrown away when void", ids(legalPlaysFor(g, 3)) === "7♣");
g.hands[3] = [C("J", "♦")];
check("...unless it is the only card", ids(legalPlaysFor(g, 3)) === "J♦");

section("a full hand");
let full = createGame({ dealer: 1 });
toPlay(full, { trump: full.hands[0][0].rank + full.hands[0][0].suit });
guard = 0;
while (full.phase === "playing" && guard++ < 200) playCard(full, full.turn, legalPlaysFor(full, full.turn)[0]);
if (full.phase === "done") {
  check("the hand completes in eight tricks", full.tricksPlayed === HAND_SIZE);
  check("all 28 points are captured", handPoints(full.captured.flat()) === TOTAL_POINTS);
  check("the verdict matches the points", full.result.made === full.result.got >= full.result.target);
} else {
  check("the hand ends", full.phase === "redeal", full.phase);
}

section("shuffling");
check("two shuffles differ", shuffle(buildDeck()).map(cardId).join() !== shuffle(buildDeck()).map(cardId).join());
void SEATS;

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
