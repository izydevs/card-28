// Play many complete hands with the AI in every seat, under several rule sets.
// This is where integration bugs surface: a hand that cannot finish, a card played
// out of turn, points that do not add up, or a rule that lets a hand stall.
//
//   node scripts/selfplay.mjs [hands per rule set]
import {
  createGame, playCard, revealTrump, legalPlaysFor, declarePair, concede,
  handPoints, TOTAL_POINTS, HAND_SIZE, cardId, MAX_BID, teamOf, partnerOf, isJoker,
  matchWinner, nextSeat,
} from "../public/game.js";
import { aiAct, decidePlay, wantsTrump, wantsPair, wantsConcede } from "../public/ai.js";

const HANDS = Number(process.argv[2] ?? 400);
let failures = 0;
const fail = (msg) => { failures++; if (failures < 30) console.log("FAIL  " + msg); };

const RULE_SETS = [
  { name: "default", rules: {} },
  { name: "opening at 14", rules: { minBid: 14 } },
  { name: "joker + no-Jack-discard", rules: { joker: true, noJackDiscard: true } },
  { name: "core rules only", rules: { secondRound: false, double: false, pair: false, thani: false, cot: false, pointlessRedeal: false } },
];

for (const { name, rules } of RULE_SETS) {
  const stats = {
    played: 0, made: 0, redeals: {}, raises: 0, partnerTakeovers: 0, doubles: 0, redoubles: 0,
    thani: 0, pairs: 0, cots: 0, conceded: 0, reveals: 0, matches: 0,
  };
  const bidSpread = new Map();
  const match = [0, 0];
  let dealer = 1;

  for (let n = 0; n < HANDS; n++) {
    const game = createGame({ dealer, rules });
    const tag = `[${name}] hand ${n}`;
    let guard = 0;

    // Everything before card play.
    while (!["playing", "done", "redeal"].includes(game.phase) && guard++ < 60) {
      const before = JSON.stringify([game.phase, game.turn, game.log.length]);
      aiAct(game);
      if (JSON.stringify([game.phase, game.turn, game.log.length]) === before) {
        fail(`${tag}: AI action refused in phase ${game.phase}`);
        break;
      }
    }
    if (game.phase === "redeal") {
      const key = game.redealReason.replace(/^\w+ /, "");
      stats.redeals[key] = (stats.redeals[key] ?? 0) + 1;
      continue; // same dealer deals again
    }
    if (game.phase !== "playing") { fail(`${tag}: stuck in ${game.phase}`); continue; }

    if (game.highBid < game.rules.minBid || game.highBid > MAX_BID) fail(`${tag}: bid ${game.highBid} out of range`);
    bidSpread.set(game.highBid, (bidSpread.get(game.highBid) ?? 0) + 1);
    if (game.bids.some((b) => b.round === 2)) stats.raises++;
    if (game.raisedByPartner) stats.partnerTakeovers++;
    if (game.multiplier >= 2) stats.doubles++;
    if (game.multiplier === 4) stats.redoubles++;
    if (game.thani) stats.thani++;

    const ids = new Set([...game.hands.flat(), ...(game.trumpCard ? [game.trumpCard] : [])].map(cardId));
    if (ids.size !== 32) fail(`${tag}: ${ids.size} distinct cards after the deal`);

    guard = 0;
    while (["playing", "concession"].includes(game.phase) && guard++ < 120) {
      if (game.phase === "concession") { aiAct(game); continue; }
      const seat = game.turn;
      if (game.thani && seat === partnerOf(game.bidWinner)) { fail(`${tag}: Thani partner was asked to play`); break; }
      if (wantsPair(game, seat)) { declarePair(game, seat); stats.pairs++; }
      if (wantsConcede(game, seat)) { concede(game, seat); continue; }
      if (wantsTrump(game, seat)) {
        revealTrump(game, seat);
        stats.reveals++;
        if (game.phase === "redeal") break;
      }

      const options = legalPlaysFor(game, seat);
      if (!options.length) { fail(`${tag}: seat ${seat} has no legal play`); break; }
      const choice = decidePlay(game, seat);
      if (!options.some((c) => cardId(c) === cardId(choice))) {
        fail(`${tag}: AI chose an illegal card ${cardId(choice)}`);
        break;
      }

      // Independent checks of the rules the engine is meant to enforce.
      const hand = game.hands[seat];
      const firstReal = game.trick.find((p) => !isJoker(p.card));
      const lead = game.trick.length && !isJoker(game.trick[0].card) ? game.trick[0].card.suit : null;
      if (lead && !isJoker(choice) && hand.some((c) => !isJoker(c) && c.suit === lead) && choice.suit !== lead && !(game.trumpRevealed && firstReal === undefined)) {
        fail(`${tag}: ${seat} failed to follow ${lead}`);
        break;
      }
      const hidden = !game.trumpRevealed && game.trumpCard && seat === game.bidWinner;
      if (hidden && !game.trick.length && choice.suit === game.trumpSuit && hand.some((c) => c.suit !== game.trumpSuit)) {
        fail(`${tag}: bidder led the hidden trump suit with other cards in hand`);
        break;
      }

      playCard(game, seat, choice);
      if (game.hands[seat].some((c) => cardId(c) === cardId(choice))) {
        fail(`${tag}: ${cardId(choice)} was rejected`);
        break;
      }
      if (game.tricksPlayed === HAND_SIZE - 1 && game.phase === "playing" && !game.thani && !game.trumpRevealed) {
        fail(`${tag}: trump still hidden for the last trick`);
      }
    }

    if (game.phase === "redeal") {
      stats.redeals[game.redealReason] = (stats.redeals[game.redealReason] ?? 0) + 1;
      continue;
    }
    if (game.phase !== "done") { fail(`${tag}: stalled in ${game.phase} after ${game.tricksPlayed} tricks`); continue; }

    const r = game.result;
    const complete = !r.thani && r.note !== "conceded";
    if (complete) {
      if (game.tricksPlayed !== HAND_SIZE) fail(`${tag}: ${game.tricksPlayed} tricks`);
      if (game.hands.some((h) => h.length)) fail(`${tag}: cards left in hand`);
      const total = handPoints(game.captured[0]) + handPoints(game.captured[1]);
      if (total !== TOTAL_POINTS) fail(`${tag}: ${total} points captured, expected ${TOTAL_POINTS}`);
      if (game.captured.flat().length !== 32) fail(`${tag}: ${game.captured.flat().length} cards captured`);
      if (r.got + r.opponents !== TOTAL_POINTS) fail(`${tag}: sides sum to ${r.got + r.opponents}`);
      if (!game.cotRefused && r.made !== r.got >= r.target) fail(`${tag}: verdict disagrees with the count`);
    }
    if (r.thani) {
      if (game.hands[partnerOf(game.bidWinner)].length !== HAND_SIZE) fail(`${tag}: Thani partner played cards`);
      if (game.captured.flat().length !== game.tricksPlayed * 3) fail(`${tag}: Thani tricks are not three cards`);
      if (r.made !== (game.tricksWon[teamOf(game.bidWinner)] === HAND_SIZE)) fail(`${tag}: Thani verdict wrong`);
    }
    if (Math.sign(r.delta[r.biddingTeam]) !== (r.made ? 1 : -1)) fail(`${tag}: score sign disagrees with verdict`);
    if (r.delta[1 - r.biddingTeam] !== 0) fail(`${tag}: defenders' score moved`);

    if (r.made) stats.made++;
    if (r.cot !== null) stats.cots++;
    if (r.note === "conceded") stats.conceded++;
    stats.played++;
    match[0] += r.delta[0];
    match[1] += r.delta[1];
    if (matchWinner(match) !== null) { stats.matches++; match[0] = match[1] = 0; }
    dealer = nextSeat(dealer);
  }

  const pct = (x) => `${((x / Math.max(1, stats.played)) * 100).toFixed(0)}%`;
  console.log(`\n== ${name}: ${stats.played} hands played ==`);
  console.log(`  contracts made ${pct(stats.made)}; raised in round two ${stats.raises} (partner took over ${stats.partnerTakeovers})`);
  console.log(`  doubled ${stats.doubles}, redoubled ${stats.redoubles}; Thani ${stats.thani}; Pairs ${stats.pairs}; Cots ${stats.cots}; conceded ${stats.conceded}`);
  console.log(`  trump called ${stats.reveals} times; matches finished ${stats.matches}`);
  console.log(`  redeals: ${Object.entries(stats.redeals).map(([k, v]) => `${v}× ${k}`).join("; ") || "none"}`);
  console.log(`  bids: ${[...bidSpread.entries()].sort((a, b) => a[0] - b[0]).map(([b, k]) => `${b}:${k}`).join(" ")}`);

  // A game where one side always wins, or nobody can finish, is broken even if it runs.
  if (stats.played < HANDS * 0.5) fail(`[${name}] only ${stats.played} of ${HANDS} hands were playable`);
  if (stats.made === 0 || stats.made === stats.played) fail(`[${name}] contracts made ${stats.made}/${stats.played} — not a contest`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
