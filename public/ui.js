// Table, hands and interaction. All rules live in game.js; this file only renders
// state, animates the transitions between states, and turns clicks into moves.

import {
  createGame, placeBid, chooseTrump, playCard, revealTrump, legalPlaysFor,
  mayRequestTrump, handPoints, cardId, SEATS, SUIT_NAMES, RED,
  teamOf, partnerOf, MIN_BID, MAX_BID, trickWinner, strength,
} from "./game.js";
import { decideBid, chooseTrumpSuit, decidePlay, wantsTrump } from "./ai.js";

const $ = (id) => document.getElementById(id);
const ME = 0; // South
const PAUSE = { bid: 560, play: 640, trick: 1150, collect: 480 };

let game = null;
let busy = false;
let pendingTrump = null; // card the human selected as trump, awaiting confirm
let dealing = false; // stagger the hand's entrance after a deal
const score = [0, 0];
let lastScore = [0, 0];
let dealer = 3;

// A finished trick is cleared by the engine immediately, but a reader needs a beat
// to see it. The UI keeps the completed trick on the table, then sweeps it to the
// winner before moving on.
let settling = null; // { plays, winner }
const flown = new Set(); // plays already animated onto the table

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- cards

function cardEl(card, { small = false, facedown = false } = {}) {
  const node = el("div", `card${small ? " small" : ""}${facedown ? " facedown" : ""}`);
  if (facedown) return node;
  if (RED.has(card.suit)) node.classList.add("red");

  const idx = el("div", "idx");
  idx.append(document.createTextNode(card.rank));
  idx.append(el("small", null, card.suit));
  const idxB = el("div", "idx bottom");
  idxB.append(document.createTextNode(card.rank));
  idxB.append(el("small", null, card.suit));

  node.append(idx, el("div", "pip", card.suit), idxB);
  if (card.points > 0) node.append(el("div", "worth", card.points));
  node.dataset.id = cardId(card);
  return node;
}

// Fly a freshly played card in from its owner's seat, so a card visibly comes
// *from* the player rather than appearing on the felt.
function flyIn(node, seat) {
  if (reduced) return;
  const from = $(`seat-${seat}`)?.getBoundingClientRect();
  const to = node.getBoundingClientRect();
  if (!from || !to.width) return;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  node.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(0.6) rotate(${seat === 1 ? -18 : seat === 3 ? 18 : 0}deg)`, opacity: 0 },
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
    ],
    { duration: 300, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" },
  );
}

// Sweep the completed trick to whoever won it.
async function sweepTo(winner) {
  const cards = [...$("trick").querySelectorAll(".played")];
  const seat = $(`seat-${winner}`)?.getBoundingClientRect();
  if (reduced || !cards.length || !seat) return;
  const anims = cards.map((node, i) => {
    const box = node.getBoundingClientRect();
    const dx = seat.left + seat.width / 2 - (box.left + box.width / 2);
    const dy = seat.top + seat.height / 2 - (box.top + box.height / 2);
    return node.animate(
      [
        { transform: "translate(0,0) scale(1)", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.45)`, opacity: 0 },
      ],
      { duration: PAUSE.collect, delay: i * 45, easing: "cubic-bezier(0.55, 0, 0.55, 1)", fill: "forwards" },
    );
  });
  await Promise.all(anims.map((a) => a.finished.catch(() => {})));
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
  const teams = [
    { label: "You + North", n: score[0], ours: true },
    { label: "West + East", n: score[1], ours: false },
  ];
  for (const [i, t] of teams.entries()) {
    const chip = el("span", `team-chip${t.ours ? " ours" : ""}`);
    chip.append(el("span", null, t.label));
    const n = el("b", null, t.n);
    if (t.n !== lastScore[i]) n.classList.add("bump");
    chip.append(n);
    host.append(chip);
  }
  lastScore = [...score];
  if (game?.highBid) {
    host.append(el("span", "contract-chip", `${game.highBid} by ${SEATS[game.bidWinner]}`));
  }
  if (game?.trumpCard && !game.trumpRevealed) {
    const chip = el("span", "trump-chip hidden-trump");
    chip.append(el("span", null, "Trump"));
    chip.append(el("span", "mini-back"));
    host.append(chip);
  } else if (game?.trumpRevealed) {
    const chip = el("span", `trump-chip${RED.has(game.trumpSuit) ? " red" : ""}`);
    chip.append(el("span", null, "Trump"));
    const suit = el("b", null, `${game.trumpSuit} ${SUIT_NAMES[game.trumpSuit]}`);
    if (!flown.has("trump-reveal")) {
      flown.add("trump-reveal");
      suit.classList.add("flip");
    }
    chip.append(suit);
    host.append(chip);
  }
}

function renderSeats() {
  for (let seat = 0; seat < 4; seat++) {
    const host = $(`seat-${seat}`);
    host.replaceChildren();
    host.classList.toggle("active", game.turn === seat && game.phase !== "done" && !settling);

    const who = el("div", "who");
    who.append(el("span", "avatar", SEATS[seat][0]));
    who.append(el("span", null, seat === ME ? "You" : SEATS[seat]));
    host.append(who);

    const meta = el("div", "meta");
    if (seat === partnerOf(ME)) meta.append(el("span", null, "partner "));
    if (game.phase === "bidding") {
      const mine = [...game.bids].reverse().find((b) => b.seat === seat);
      if (game.passed[seat]) meta.append(el("span", null, "passed"));
      else if (mine) meta.append(el("span", "bid", `bid ${mine.bid}`));
      else meta.append(el("span", null, "—"));
    } else if (game.bidWinner === seat) {
      meta.append(el("span", "bid", `bid ${game.highBid}`));
    }
    host.append(meta);

    if (seat !== ME) {
      const backs = el("div", "backs");
      for (let i = 0; i < game.hands[seat].length; i++) backs.append(el("div", "back"));
      host.append(backs);
    }
  }
}

function renderCentre() {
  // While a trick is settling, keep showing it instead of an empty table.
  const plays = settling ? settling.plays : game.trick;
  const trickHost = $("trick");
  trickHost.replaceChildren();
  const leader = plays.length
    ? settling
      ? settling.winner
      : trickWinner(plays, game.trumpSuit, game.trumpRevealed ? (game.revealIndex ?? 0) : null)
    : null;

  for (const play of plays) {
    const wrap = el("div", `played${play.seat === leader ? " winner" : ""}`);
    wrap.dataset.seat = play.seat;
    wrap.append(cardEl(play.card, { small: true }));
    wrap.append(el("div", "tag", SEATS[play.seat]));
    trickHost.append(wrap);

    const key = `${game.tricksPlayed}:${play.seat}:${cardId(play.card)}`;
    if (!flown.has(key)) {
      flown.add(key);
      flyIn(wrap, play.seat);
    }
  }

  const banner = $("banner");
  banner.replaceChildren();
  if (game.phase === "done" && game.result) {
    const r = game.result;
    const mine = r.biddingTeam === teamOf(ME);
    banner.textContent = r.made
      ? `${mine ? "Your side" : "They"} made ${r.bid} — took ${r.got} of 28.`
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
  const myTurn = game.turn === ME && !busy && !settling;
  const legal = game.phase === "playing" && myTurn ? legalPlaysFor(game, ME) : [];
  const legalIds = new Set(legal.map(cardId));

  const mid = (hand.length - 1) / 2;
  for (const [i, card] of hand.entries()) {
    const node = cardEl(card);
    // Fan the hand: a small arc, lifted slightly toward the middle.
    const offset = i - mid;
    node.style.transform = `rotate(${offset * 2.6}deg) translateY(${Math.abs(offset) * 2.4}px)`;
    node.style.zIndex = String(i);
    if (dealing) {
      node.classList.add("dealing");
      node.style.animationDelay = `${i * 55}ms`;
    }

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
  if (busy || settling) return;

  if (game.phase === "bidding" && game.turn === ME) {
    host.append(
      el("span", "prompt", `These four are worth ${handPoints(game.hands[ME])}. Your bid?`),
    );
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
    const confirm = el(
      "button",
      "btn gold",
      pendingTrump ? `Set ${cardId(pendingTrump)} as trump` : "Choose a card",
    );
    confirm.disabled = !pendingTrump;
    confirm.addEventListener("click", () => {
      const card = pendingTrump;
      pendingTrump = null;
      chooseTrump(game, card);
      dealHand();
      advance();
    });
    host.append(confirm);
    return;
  }

  if (game.phase === "playing" && game.turn === ME) {
    const lead = game.trick.length ? game.trick[0].card.suit : null;
    if (mayRequestTrump(game, ME)) {
      host.append(el("span", "prompt", `No ${SUIT_NAMES[lead]} in hand.`));
      const call = el("button", "btn gold", "Call for trump");
      call.addEventListener("click", () => {
        revealTrump(game, ME);
        render();
      });
      host.append(call);
      host.append(el("span", null, "or discard anything"));
    } else if (lead) {
      host.append(el("span", null, `${SUIT_NAMES[lead]} ${lead} led — follow if you can.`));
    } else {
      host.append(el("span", "prompt", "Your lead."));
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
    const cls = line.startsWith("South")
      ? "me"
      : /trump|bid|trick|Contract|redeal/i.test(line)
        ? "event"
        : "";
    host.append(el("p", cls, line));
  }
  host.scrollTop = host.scrollHeight;
}

// ---------------------------------------------------------------- flow

// Run the deal animation once, then settle back to a static hand.
function dealHand() {
  dealing = true;
  render();
  setTimeout(() => {
    dealing = false;
    render();
  }, 700);
}

function humanBids(bid) {
  placeBid(game, ME, bid);
  render();
  advance();
}

async function humanPlays(card) {
  const before = game.hands[ME].length;
  const trickBefore = [...game.trick];
  const tricksBefore = game.tricksPlayed;
  playCard(game, ME, card);
  if (game.hands[ME].length === before) return; // rejected
  noteCompletedTrick(trickBefore, { seat: ME, card }, tricksBefore);
  render();
  await settleTrick();
  applyResult();
  advance();
}

// The engine clears a trick the moment it resolves, so capture the four cards and
// the winner for the UI to show during the pause.
function noteCompletedTrick(trickBefore, lastPlay, tricksBefore) {
  if (game.tricksPlayed > tricksBefore) {
    settling = { plays: [...trickBefore, lastPlay], winner: game.lastWinner };
  }
}

async function settleTrick() {
  if (!settling) return;
  render();
  await wait(PAUSE.trick);
  await sweepTo(settling.winner);
  settling = null;
  render();
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
        dealHand();
      } else if (game.phase === "playing") {
        const seat = game.turn;
        if (wantsTrump(game, seat)) {
          revealTrump(game, seat);
          render();
          await wait(PAUSE.bid);
        }
        const trickBefore = [...game.trick];
        const tricksBefore = game.tricksPlayed;
        const choice = decidePlay(game, seat);
        playCard(game, seat, choice);
        noteCompletedTrick(trickBefore, { seat, card: choice }, tricksBefore);
        render();
        if (settling) await settleTrick();
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
  // The bidding side scores its bid when it makes it; the opponents take it when it fails.
  if (r.made) score[r.biddingTeam] += r.bid;
  else score[1 - r.biddingTeam] += r.bid;
  dealer = (dealer + 1) % 4;
  render();
}

function newHand() {
  pendingTrump = null;
  settling = null;
  flown.clear();
  game = createGame({ dealer });
  dealHand();
  advance();
}

$("new-hand").addEventListener("click", newHand);
$("rules-btn").addEventListener("click", () => $("rules-dialog").showModal());

newHand();
