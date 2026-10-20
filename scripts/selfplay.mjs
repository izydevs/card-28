// Play many complete hands with the AI in every seat. This is where integration
// bugs surface: a hand that cannot finish, a card played out of turn, points that
// do not add up, or a rule that lets a hand stall.
import {
  createGame, placeBid, chooseTrump, playCard, revealTrump, legalPlaysFor,
  handPoints, TOTAL_POINTS, HAND_SIZE, cardId, MIN_BID, MAX_BID,
} from "../public/game.js";
import { decideBid, chooseTrumpSuit, decidePlay, wantsTrump } from "../public/ai.js";

const HANDS = Number(process.argv[2] ?? 400);
let failures = 0;
const fail = (msg) => { failures++; console.log("FAIL  " + msg); };

let played = 0, redeals = 0, made = 0, reveals = 0, autoReveals = 0;
const bidSpread = new Map();

for (let n = 0; n < HANDS; n++) {
  const game = createGame({ dealer: n % 4 });
  let guard = 0;

  while (game.phase === "bidding" && guard++ < 40) {
    placeBid(game, game.turn, decideBid(game, game.turn));
  }
  if (game.phase === "redeal") { redeals++; continue; }
  if (game.phase !== "trump") { fail(`hand ${n}: bidding ended in ${game.phase}`); continue; }

  if (game.highBid < MIN_BID || game.highBid > MAX_BID) fail(`hand ${n}: bid ${game.highBid} out of range`);
  bidSpread.set(game.highBid, (bidSpread.get(game.highBid) ?? 0) + 1);

  chooseTrump(game, chooseTrumpSuit(game, game.bidWinner));
  if (!game.trumpSuit) { fail(`hand ${n}: no trump chosen`); continue; }

  const dealtIds = new Set([...game.hands.flat().map(cardId), cardId(game.trumpCard)]);
  if (dealtIds.size !== 32) fail(`hand ${n}: ${dealtIds.size} distinct cards after the deal`);

  guard = 0;
  while (game.phase === "playing" && guard++ < 100) {
    const seat = game.turn;
    if (wantsTrump(game, seat)) { revealTrump(game, seat); reveals++; }

    const lead = game.trick.length ? game.trick[0].card.suit : null;
    const options = legalPlaysFor(game, seat);
    if (!options.length) { fail(`hand ${n}: ${seat} has no legal play`); break; }

    const choice = decidePlay(game, seat);
    if (!options.some((c) => cardId(c) === cardId(choice))) {
      fail(`hand ${n}: AI chose an illegal card ${cardId(choice)}`);
      break;
    }
    // Following suit is the one hard restriction; verify the engine enforced it.
    if (lead && game.hands[seat].some((c) => c.suit === lead) && choice.suit !== lead) {
      fail(`hand ${n}: ${seat} failed to follow ${lead}`);
      break;
    }
    playCard(game, seat, choice);
    // Check the card left the hand, not the hand's size: when the bidder plays their
    // last card and wins the trick, the face-down trump returns in the same call, so
    // the count is unchanged even though the play was perfectly legal.
    if (game.hands[seat].some((c) => cardId(c) === cardId(choice))) {
      fail(`hand ${n}: ${cardId(choice)} was rejected`);
      break;
    }
  }

  if (game.phase !== "done") { fail(`hand ${n}: stalled in ${game.phase} after ${game.tricksPlayed} tricks`); continue; }
  if (game.tricksPlayed !== HAND_SIZE) fail(`hand ${n}: ${game.tricksPlayed} tricks`);
  if (game.hands.some((h) => h.length)) fail(`hand ${n}: cards left in hand`);

  const total = handPoints(game.captured[0]) + handPoints(game.captured[1]);
  if (total !== TOTAL_POINTS) fail(`hand ${n}: ${total} points captured, expected ${TOTAL_POINTS}`);
  if (game.captured.flat().length !== 32) fail(`hand ${n}: ${game.captured.flat().length} cards captured`);

  const r = game.result;
  if (r.made !== r.got >= r.bid) fail(`hand ${n}: verdict disagrees with the count`);
  if (r.got + r.opponents !== TOTAL_POINTS) fail(`hand ${n}: sides sum to ${r.got + r.opponents}`);
  if (r.made) made++;
  if (game.trumpRevealed) autoReveals++;
  played++;
}

console.log(`\nPlayed ${played} hands (${redeals} redeals, all four passed).`);
console.log(`  contracts made: ${made}/${played} (${((made / played) * 100).toFixed(0)}%)`);
console.log(`  trump revealed in ${autoReveals}/${played} hands; ${reveals} were called by a player`);
const spread = [...bidSpread.entries()].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${b}:${n}`).join(" ");
console.log(`  bids: ${spread}`);

// A game where one side always wins, or nobody ever bids, is broken even if it runs.
if (played < HANDS * 0.5) fail(`only ${played} of ${HANDS} hands were playable`);
if (made === 0 || made === played) fail(`contracts made ${made}/${played} — the game is not a contest`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
