// Table, hands and interaction. All rules live in game.js; this file only renders
// state and turns clicks into moves.

import {
  createGame, placeBid, chooseTrump, playCard, revealTrump, legalPlaysFor,
  mayRequestTrump, handPoints, cardId, SEATS, SUIT_NAMES, RED,
  teamOf, partnerOf, MIN_BID, MAX_BID, trickWinner, strength,
} from "./game.js";
import { decideBid, chooseTrumpSuit, decidePlay, wantsTrump } from "./ai.js";

const $ = (id) => document.getElementById(id);
const ME = 0; // South
const PAUSE = { bid: 520, play: 620, trick: 900 };

let game = null;
let busy = false;
let pendingTrump = null; // card the human has selected as trump, awaiting confirm
const score = [0, 0];
let dealer = 3;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- cards

function cardEl(card, { small = false, facedown = false } = {}) {
  const node = el("div", `card${small ? " small" : ""}${facedown ? " facedown" : ""}`);
  if (facedown) return node;
  if (RED.has(card.suit)) node.classList.add("red");
  node.append(el("div", "corner", `${card.rank}${card.suit}`));
  node.append(el("div", "pip", card.suit));
  node.append(el("div", "corner bottom", `${card.rank}${card.suit}`));
  // Showing the point value turns the scoring rule into something you can see.
  if (card.points > 0) node.append(el("div", "worth", card.points));
  node.dataset.id = cardId(card);
  return node;
}

// ---------------------------------------------------------------- render

function render() {
  renderSeats();
  renderCentre();
  renderHand();
  renderActions();
  renderLog();
  renderScore();
}

function renderScore() {
  const host = $("scoreline");
  host.replaceChildren();
  host.append(el("span", null, "You + North "), el("b", null, score[0]));
  host.append(el("span", null, " · West + East "), el("b", null, score[1]));
  if (game?.highBid) {
    host.append(el("span", null, ` · contract ${game.highBid} by ${SEATS[game.bidWinner]}`));
  }
}

function renderSeats() {
  for (let seat = 0; seat < 4; seat++) {
    const host = $(`seat-${seat}`);
    host.replaceChildren();
    host.classList.toggle("active", game.turn === seat && game.phase !== "done");

    const who = el("div", "who");
    who.append(el("span", seat === ME ? "you" : null, SEATS[seat]));
    if (seat === ME) who.append(el("span", "you", " (you)"));
    else if (seat === partnerOf(ME)) who.append(el("span", null, " — partner"));
    host.append(who);

    const bits = [];
    if (game.phase === "bidding") {
      if (game.passed[seat]) bits.push("passed");
      const mine = [...game.bids].reverse().find((b) => b.seat === seat);
      if (mine) bits.push(`bid ${mine.bid}`);
    }
    if (game.bidWinner === seat && game.phase !== "bidding") bits.push(`bid ${game.highBid}`);
    host.append(el("div", "meta", bits.join(" · ") || " "));

    if (seat !== ME) {
      const backs = el("div", "backs");
      for (let i = 0; i < game.hands[seat].length; i++) backs.append(el("div", "back"));
      host.append(backs);
    }
  }
}

function renderCentre() {
  const slot = $("trump-slot");
  slot.replaceChildren();
  if (game.trumpCard && !game.trumpRevealed) {
    slot.append(el("span", null, "Trump (face down)"));
    slot.append(cardEl(null, { small: true, facedown: true }));
  } else if (game.trumpRevealed) {
    slot.append(el("span", null, "Trump"));
    slot.append(el("b", null, `${SUIT_NAMES[game.trumpSuit]} ${game.trumpSuit}`));
  }

  const trickHost = $("trick");
  trickHost.replaceChildren();
  const leader = game.trick.length
    ? trickWinner(game.trick, game.trumpSuit, game.trumpRevealed ? (game.revealIndex ?? 0) : null)
    : null;
  for (const play of game.trick) {
    const wrap = el("div", `played${play.seat === leader ? " winner" : ""}`);
    wrap.append(el("div", "label", SEATS[play.seat]));
    wrap.append(cardEl(play.card, { small: true }));
    trickHost.append(wrap);
  }

  const banner = $("banner");
  banner.replaceChildren();
  if (game.phase === "done" && game.result) {
    const r = game.result;
    const mine = r.biddingTeam === teamOf(ME);
    banner.textContent = r.made
      ? `${mine ? "Your side" : "They"} made ${r.bid} — took ${r.got} points.`
      : `${mine ? "Your side" : "They"} failed ${r.bid} — took only ${r.got}.`;
  } else if (game.phase === "redeal") {
    banner.textContent = "Everyone passed. Deal again.";
  }
}

function renderHand() {
  const host = $("hand");
  host.replaceChildren();
  const hand = [...game.hands[ME]].sort(
    (a, b) => a.suit.localeCompare(b.suit) || strength(b.rank) - strength(a.rank),
  );
  const lead = game.trick.length ? game.trick[0].card.suit : null;
  const myTurn = game.turn === ME && !busy;
  const legal = game.phase === "playing" && myTurn ? legalPlaysFor(game, ME) : [];
  const legalIds = new Set(legal.map(cardId));

  for (const card of hand) {
    const node = cardEl(card);
    if (game.phase === "trump" && game.bidWinner === ME) {
      node.classList.add("playable");
      if (pendingTrump && cardId(pendingTrump) === cardId(card)) node.classList.add("chosen");
      node.addEventListener("click", () => {
        pendingTrump = card;
        render();
      });
    } else if (game.phase === "playing" && myTurn) {
      if (legalIds.has(cardId(card))) {
        node.classList.add("playable");
        node.addEventListener("click", () => humanPlays(card));
      } else {
        node.classList.add("blocked");
        node.title = `You must follow ${SUIT_NAMES[lead]}`;
      }
    }
    host.append(node);
  }
}

function renderActions() {
  const host = $("actions");
  host.replaceChildren();
  if (busy) return;

  if (game.phase === "bidding" && game.turn === ME) {
    host.append(el("span", "prompt", `Your hand is worth ${handPoints(game.hands[ME])} in these 4 cards. Bid?`));
    const floor = Math.max(MIN_BID, game.highBid + 1);
    for (const bid of [floor, floor + 1, floor + 2, floor + 4]) {
      if (bid > MAX_BID) break;
      const b = el("button", "btn", String(bid));
      b.addEventListener("click", () => humanBids(bid));
      host.append(b);
    }
    const pass = el("button", "btn ghost", "Pass");
    pass.addEventListener("click", () => humanBids(null));
    host.append(pass);
    return;
  }

  if (game.phase === "trump" && game.bidWinner === ME) {
    host.append(el("span", "prompt", "Pick a card — its suit becomes trump, face down."));
    const confirm = el("button", "btn gold", pendingTrump ? `Set ${cardId(pendingTrump)} as trump` : "Choose a card");
    confirm.disabled = !pendingTrump;
    confirm.addEventListener("click", () => {
      const card = pendingTrump;
      pendingTrump = null;
      chooseTrump(game, card);
      render();
      advance();
    });
    host.append(confirm);
    return;
  }

  if (game.phase === "playing" && game.turn === ME) {
    const lead = game.trick.length ? game.trick[0].card.suit : null;
    if (mayRequestTrump(game, ME)) {
      host.append(el("span", "prompt", `You have no ${SUIT_NAMES[lead]}.`));
      const call = el("button", "btn gold", "Call for trump");
      call.addEventListener("click", () => {
        revealTrump(game, ME);
        render();
      });
      host.append(call);
      host.append(el("span", null, "or discard anything"));
    } else if (lead) {
      host.append(el("span", null, `${SUIT_NAMES[lead]} led — play a card.`));
    } else {
      host.append(el("span", null, "Your lead."));
    }
    return;
  }

  if (game.phase === "done") {
    const again = el("button", "btn", "Next hand");
    again.addEventListener("click", newHand);
    host.append(again);
    return;
  }
  if (game.phase === "redeal") {
    const again = el("button", "btn", "Redeal");
    again.addEventListener("click", newHand);
    host.append(again);
  }
}

function renderLog() {
  const host = $("log");
  host.replaceChildren();
  for (const line of game.log.slice(-60)) {
    const cls = line.startsWith("South") ? "me" : /trump|bid|trick|Contract|redeal/i.test(line) ? "event" : "";
    host.append(el("p", cls, line));
  }
  host.scrollTop = host.scrollHeight;
}

// ---------------------------------------------------------------- flow

function humanBids(bid) {
  placeBid(game, ME, bid);
  render();
  advance();
}

async function humanPlays(card) {
  const before = game.hands[ME].length;
  playCard(game, ME, card);
  // playCard rejects illegal moves silently; do not advance if nothing happened.
  if (game.hands[ME].length === before) return;
  render();
  await settleTrick();
  applyResult();
  advance();
}

// After the fourth card the trick stays up briefly so it can be read.
async function settleTrick() {
  if (game.trick.length === 0 && game.tricksPlayed > 0) {
    await wait(PAUSE.trick);
    render();
  }
}

async function advance() {
  if (busy) return;
  busy = true;
  render();
  try {
    let guard = 0;
    while (guard++ < 80) {
      if (game.phase === "done" || game.phase === "redeal") break;
      if (game.turn === ME && game.phase !== "trump") break;
      if (game.phase === "trump" && game.bidWinner === ME) break;

      await wait(game.phase === "bidding" ? PAUSE.bid : PAUSE.play);

      if (game.phase === "bidding") {
        placeBid(game, game.turn, decideBid(game, game.turn));
      } else if (game.phase === "trump") {
        chooseTrump(game, chooseTrumpSuit(game, game.bidWinner));
      } else if (game.phase === "playing") {
        const seat = game.turn;
        if (wantsTrump(game, seat)) {
          revealTrump(game, seat);
          render();
          await wait(PAUSE.bid);
        }
        playCard(game, seat, decidePlay(game, seat));
        render();
        // A completed trick pauses before the next lead.
        if (game.trick.length === 0 && game.phase === "playing") await wait(PAUSE.trick);
      }
      render();
    }
  } finally {
    busy = false;
    render();
  }

  applyResult();
}

// Called wherever a hand can end. The `scored` flag keeps it idempotent: advance()
// returns early when another advance is already running, so relying on a single
// call site meant some hands were never scored at all.
function applyResult() {
  if (game.phase !== "done" || !game.result || game.scored) return;
  game.scored = true;
  const r = game.result;
  // The bidding side scores its bid when it makes it, and the opponents take it when it fails.
  if (r.made) score[r.biddingTeam] += r.bid;
  else score[1 - r.biddingTeam] += r.bid;
  dealer = (dealer + 1) % 4;
  render();
}

function newHand() {
  pendingTrump = null;
  game = createGame({ dealer });
  render();
  advance();
}

$("new-hand").addEventListener("click", newHand);
$("rules-btn").addEventListener("click", () => $("rules-dialog").showModal());

newHand();
