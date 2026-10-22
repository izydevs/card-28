// Table, hands and interaction. All rules live in game.js; this file only renders
// state, animates the transitions between states, and turns clicks into moves.

import {
  createGame, placeBid, chooseTrump, playCard, revealTrump, legalPlaysFor, mayRequestTrump,
  handPoints, cardId, SEATS, SUIT_NAMES, RED, teamOf, partnerOf, nextSeat, MAX_BID,
  trickWinner, strength, minBidFor, mayPass, mayRequestRedeal, requestRedeal, raiseBid,
  minRaise, mayRaise, mayDeclareThani, declareThani, decideDouble, decideRedouble,
  mayDeclarePair, declarePair, mayConcede, concede, answerConcession, matchWinner,
  isJoker, DEFAULT_RULES, MATCH_TARGET, gamePointValues, THANI_VALUES,
} from "./game.js";
import { aiAct, decidePlay, wantsTrump, wantsPair, wantsConcede } from "./ai.js";

const $ = (id) => document.getElementById(id);
const ME = 0; // South
const PAUSE = { bid: 560, play: 640, trick: 1150, collect: 480 };
const RULES_KEY = "card28.rules";

let game = null;
let busy = false;
let pendingTrump = null; // card the human selected as trump, awaiting confirm
let dealing = false; // stagger the hand's entrance after a deal
const score = [0, 0]; // game points this match
let lastScore = [0, 0];
let dealer = 1; // West deals first, so South opens
let champion = null; // team that has won the match, if any

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
const cardName = (card) => (isJoker(card) ? "Joker" : `${card.rank}${card.suit}`);

// ---------------------------------------------------------------- house rules

// A per-browser convenience only; the game plays fine when storage is unavailable.
function loadRules() {
  try {
    const saved = JSON.parse(localStorage.getItem(RULES_KEY) ?? "{}");
    return { ...DEFAULT_RULES, ...saved };
  } catch {
    return { ...DEFAULT_RULES };
  }
}
let rules = loadRules();

function saveRules() {
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  } catch {
    /* private window or blocked storage: keep the in-memory copy */
  }
}

function bindRuleControls() {
  for (const input of document.querySelectorAll("[data-rule]")) {
    const key = input.dataset.rule;
    if (input.type === "checkbox") input.checked = !!rules[key];
    else input.value = String(rules[key]);
    input.addEventListener("change", () => {
      rules = { ...rules, [key]: input.type === "checkbox" ? input.checked : Number(input.value) };
      saveRules();
      $("rules-note").textContent = "Saved — applies from the next hand.";
    });
  }
}

// ---------------------------------------------------------------- cards

function cardEl(card, { small = false, facedown = false } = {}) {
  const node = el("div", `card${small ? " small" : ""}${facedown ? " facedown" : ""}`);
  if (facedown) return node;
  if (isJoker(card)) {
    node.classList.add("joker");
    node.append(el("div", "idx", "★"), el("div", "pip", "★"), el("div", "joker-word", "JOKER"));
    node.dataset.id = cardId(card);
    return node;
  }
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

function contractLabel() {
  if (!game?.highBid) return null;
  if (game.thani) return `Thani by ${SEATS[game.bidWinner]}`;
  let text = `${game.target}`;
  if (game.pair) text = `${game.pair.from}→${game.target}`;
  text += ` by ${SEATS[game.bidWinner]}`;
  if (game.multiplier === 2) text += " · doubled";
  if (game.multiplier === 4) text += " · redoubled";
  return text;
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
    chip.title = `Game points — first to ${MATCH_TARGET} wins, −${MATCH_TARGET} loses`;
    chip.append(el("span", null, t.label));
    const n = el("b", null, t.n);
    if (t.n !== lastScore[i]) n.classList.add("bump");
    chip.append(n);
    host.append(chip);
  }
  lastScore = [...score];
  const contract = contractLabel();
  if (contract) host.append(el("span", "contract-chip", contract));
  if (game?.thani) {
    host.append(el("span", "trump-chip", "No trump"));
  } else if (game?.trumpCard && !game.trumpRevealed) {
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
    const out = game.thani && seat === partnerOf(game.bidWinner);
    host.classList.toggle("active", game.turn === seat && !["done", "redeal"].includes(game.phase) && !settling);
    host.classList.toggle("sitting-out", out);

    const who = el("div", "who");
    who.append(el("span", "avatar", SEATS[seat][0]));
    who.append(el("span", null, seat === ME ? "You" : SEATS[seat]));
    if (seat === game.dealer) who.append(el("span", "dealer-chip", "D"));
    host.append(who);

    const meta = el("div", "meta");
    if (seat === partnerOf(ME)) meta.append(el("span", null, "partner "));
    if (out) meta.append(el("span", "bid", "sits out"));
    else if (game.phase === "bidding") {
      const mine = [...game.bids].reverse().find((b) => b.seat === seat);
      if (game.passed[seat]) meta.append(el("span", null, "passed"));
      else if (mine) meta.append(el("span", "bid", `bid ${mine.bid}`));
      else meta.append(el("span", null, "—"));
    } else if (game.bidWinner === seat) {
      meta.append(el("span", "bid", game.thani ? "Thani" : `bid ${game.highBid}`));
    }
    if (game.pair?.seat === seat) meta.append(el("span", "bid", " · Pair"));
    host.append(meta);

    if (seat !== ME) {
      const backs = el("div", "backs");
      for (let i = 0; i < game.hands[seat].length; i++) backs.append(el("div", "back"));
      host.append(backs);
    }
  }
}

function resultText(r) {
  const mine = r.biddingTeam === teamOf(ME);
  const side = mine ? "Your side" : "They";
  const pts = r.delta[r.biddingTeam];
  const gp = `${pts > 0 ? "+" : "−"}${Math.abs(pts)} game point${Math.abs(pts) === 1 ? "" : "s"}`;
  if (r.thani) return `${side} ${r.made ? "made" : "lost"} Thani — ${gp}.`;
  if (r.note === "conceded") return `Conceded. ${side} ${r.made ? "made" : "failed"} ${r.target} — ${gp}.`;
  const extra = r.note ? ` (${r.note})` : "";
  return r.made
    ? `${side} made ${r.target} with ${r.got} of 28${extra} — ${gp}.`
    : `${side} failed ${r.target} with only ${r.got}${extra} — ${gp}.`;
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
    banner.textContent = resultText(game.result);
    if (champion !== null) {
      banner.append(el("div", "match", champion === teamOf(ME) ? "You and North win the match!" : "West and East win the match."));
    }
  } else if (game.phase === "redeal") {
    banner.textContent = `Redeal — ${game.redealReason}`;
  }
}

function renderHand() {
  const host = $("hand");
  host.replaceChildren();
  const hand = [...game.hands[ME]].sort(
    (a, b) => a.suit.localeCompare(b.suit) || strength(b.rank) - strength(a.rank),
  );
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

    if (game.phase === "trump" && game.bidWinner === ME && !busy) {
      if (isJoker(card)) {
        node.classList.add("blocked");
        node.title = "The Joker cannot be the trump card";
      } else {
        node.classList.add("playable");
        if (pendingTrump && cardId(pendingTrump) === cardId(card)) node.classList.add("chosen");
        node.addEventListener("click", () => {
          pendingTrump = card;
          render();
        });
      }
    } else if (game.phase === "playing" && myTurn) {
      if (legalIds.has(cardId(card))) {
        node.classList.add("playable");
        node.addEventListener("click", () => humanPlays(card));
      } else {
        node.classList.add("blocked");
        node.title = blockedReason(card);
      }
    }
    host.append(node);
  }

  // The bidder's face-down card sits beside the hand until trump is revealed.
  if (game.bidWinner === ME && game.trumpCard && !game.trumpRevealed && !game.thani) {
    const slot = el("div", "facedown-slot");
    slot.append(cardEl(game.trumpCard, { small: true }));
    slot.append(el("span", null, "face down"));
    host.append(slot);
  }
}

function blockedReason(card) {
  const lead = game.trick.find((p) => !isJoker(p.card))?.card.suit;
  if (!game.trick.length) return "The bidder may not lead the hidden trump suit";
  if (lead && game.hands[ME].some((c) => c.suit === lead && !isJoker(c))) return `You must follow ${SUIT_NAMES[lead]}`;
  if (game.trumpRevealed && game.revealedBy === ME) return "You called for trump, so you must play one";
  if (card.rank === "J" && rules.noJackDiscard) return "A Jack may not be thrown away";
  return "You may not discard the hidden trump suit";
}

const button = (label, cls, onClick, title) => {
  const b = el("button", `btn${cls ? " " + cls : ""}`, label);
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
};

function renderActions() {
  const host = $("actions");
  host.replaceChildren();
  if (busy || settling) return;

  if (game.phase === "bidding" && game.turn === ME) {
    const floor = minBidFor(game, ME);
    const overPartner = game.bidWinner === partnerOf(ME);
    host.append(
      el("span", "prompt", `These four are worth ${handPoints(game.hands[ME])}. ${mayPass(game) ? "Your bid?" : "You open — bid at least " + floor + "."}`),
    );
    if (overPartner) host.append(el("span", null, "(over your partner: 20+)"));
    for (const bid of [floor, floor + 1, floor + 2, floor + 4]) {
      if (bid > MAX_BID) break;
      host.append(button(String(bid), "", () => humanBids(bid)));
    }
    if (mayPass(game)) host.append(button("Pass", "ghost", () => humanBids(null)));
    if (mayRequestRedeal(game, ME)) {
      host.append(button("No points — redeal", "gold", () => { requestRedeal(game, ME); render(); }));
    }
    return;
  }

  if (game.phase === "trump" && game.bidWinner === ME) {
    host.append(el("span", "prompt", "Pick a card — its suit becomes trump, face down."));
    const confirm = button(pendingTrump ? `Set ${cardName(pendingTrump)} as trump` : "Choose a card", "gold", () => {
      const card = pendingTrump;
      pendingTrump = null;
      const firstChoice = game.dealt < game.deck.length;
      chooseTrump(game, card);
      if (firstChoice) dealHand();
      advance();
    });
    confirm.disabled = !pendingTrump;
    host.append(confirm);
    return;
  }

  if (game.phase === "raise" && game.turn === ME) {
    const isBidder = game.bidWinner === ME;
    const points = handPoints(game.hands[ME]) + (isBidder && game.trumpCard ? game.trumpCard.points : 0);
    host.append(el("span", "prompt", `All eight dealt — worth ${points}. ${isBidder ? "Raise, go Thani, or keep the contract?" : `Raise over your partner's ${game.highBid}?`}`));
    if (mayRaise(game, ME)) {
      const floor = minRaise(game);
      for (const bid of [floor, floor + 1, floor + 2]) {
        if (bid > MAX_BID) break;
        host.append(button(`Raise to ${bid}`, "", () => act(() => raiseBid(game, ME, bid)), isBidder ? "" : "You take the contract and set a new trump"));
      }
    }
    if (mayDeclareThani(game, ME)) {
      host.append(button("Thani", "gold", () => act(() => declareThani(game, ME)), `Win all eight tricks alone, no trump: +${THANI_VALUES[0]} / −${THANI_VALUES[1]}`));
    }
    host.append(button(isBidder ? "Keep" : "No raise", "ghost", () => act(() => raiseBid(game, ME, null))));
    return;
  }

  if (game.phase === "double" && game.turn === ME) {
    const [w, l] = gamePointValues(game.target);
    host.append(el("span", "prompt", `${SEATS[game.bidWinner]} plays ${game.target} (+${w} / −${l}). Double it?`));
    host.append(button("Double", "gold", () => act(() => decideDouble(game, ME, true))));
    host.append(button("No", "ghost", () => act(() => decideDouble(game, ME, false))));
    return;
  }

  if (game.phase === "redouble" && game.turn === ME) {
    host.append(el("span", "prompt", "You've been doubled. Redouble?"));
    host.append(button("Redouble", "gold", () => act(() => decideRedouble(game, ME, true))));
    host.append(button("No", "ghost", () => act(() => decideRedouble(game, ME, false))));
    return;
  }

  if (game.phase === "concession" && game.concession.by !== teamOf(ME)) {
    host.append(el("span", "prompt", "They concede. Accept the single score, or play on for double (and lose double if you drop a trick)?"));
    host.append(button("Accept", "", () => act(() => answerConcession(game, ME, true))));
    host.append(button("Play on for Cot", "gold", () => act(() => answerConcession(game, ME, false))));
    return;
  }

  if (game.phase === "playing" && game.turn === ME) {
    const lead = game.trick.find((p) => !isJoker(p.card))?.card.suit;
    if (mayDeclarePair(game, ME)) {
      host.append(button("Show Pair (K+Q)", "gold", () => { declarePair(game, ME); render(); },
        game.bidWinner !== null && teamOf(game.bidWinner) === teamOf(ME) ? "Lowers your contract by 4" : "Raises their contract by 4"));
    }
    if (mayRequestTrump(game, ME)) {
      host.append(el("span", "prompt", `No ${SUIT_NAMES[lead]} in hand.`));
      host.append(button("Call for trump", "gold", () => {
        revealTrump(game, ME);
        render();
        if (game.phase === "redeal") return;
      }));
      host.append(el("span", null, game.bidWinner === ME ? "or discard a non-trump" : "or discard anything"));
    } else if (lead) {
      host.append(el("span", null, `${SUIT_NAMES[lead]} ${lead} led — follow if you can.`));
    } else {
      host.append(el("span", "prompt", "Your lead."));
    }
    if (mayConcede(game, ME)) host.append(button("Concede", "ghost", () => act(() => concede(game, ME))));
    return;
  }

  if (game.phase === "done") {
    if (champion !== null) host.append(button("New match", "", newMatch));
    else host.append(button("Next hand", "", newHand));
    return;
  }
  if (game.phase === "redeal") {
    host.append(button("Redeal", "", newHand));
  }
}

function renderLog() {
  const host = $("log");
  host.replaceChildren();
  for (const line of game.log.slice(-60)) {
    const cls = line.startsWith("South")
      ? "me"
      : /trump|bid|trick|Contract|Redeal|Thani|Pair|double|raise|concede|Cot/i.test(line)
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

function act(move) {
  move();
  render();
  advance();
}

function humanBids(bid) {
  act(() => placeBid(game, ME, bid));
}

async function humanPlays(card) {
  const trickBefore = [...game.trick];
  const tricksBefore = game.tricksPlayed;
  playCard(game, ME, card);
  if (game.trick.length === trickBefore.length && game.tricksPlayed === tricksBefore) return; // rejected
  noteCompletedTrick(trickBefore, { seat: ME, card }, tricksBefore);
  render();
  await settleTrick();
  applyResult();
  advance();
}

// The engine clears a trick the moment it resolves, so capture the cards and the
// winner for the UI to show during the pause.
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

// Is the human the one who must act now?
function humanToAct() {
  switch (game.phase) {
    case "trump":
      return game.bidWinner === ME;
    case "concession":
      return game.concession.by !== teamOf(ME);
    case "done":
    case "redeal":
      return true;
    default:
      return game.turn === ME;
  }
}

async function advance() {
  if (busy) return;
  busy = true;
  render();
  try {
    let guard = 0;
    while (guard++ < 120 && !humanToAct()) {
      const seat = game.turn;
      await wait(game.phase === "playing" ? PAUSE.play : PAUSE.bid);

      if (game.phase !== "playing") {
        const firstChoice = game.phase === "trump" && game.dealt < game.deck.length;
        aiAct(game);
        if (firstChoice) dealHand();
        render();
        continue;
      }

      if (wantsPair(game, seat)) {
        declarePair(game, seat);
        render();
        await wait(PAUSE.bid);
      }
      if (wantsConcede(game, seat)) {
        concede(game, seat);
        render();
        continue;
      }
      if (wantsTrump(game, seat)) {
        revealTrump(game, seat);
        render();
        if (game.phase === "redeal") break;
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
  } finally {
    busy = false;
    render();
  }
  applyResult();
}

// Called wherever a hand can end. The `scored` flag keeps it idempotent.
function applyResult() {
  if (game.phase !== "done" || !game.result || game.scored) return;
  game.scored = true;
  score[0] += game.result.delta[0];
  score[1] += game.result.delta[1];
  champion = matchWinner(score);
  dealer = nextSeat(dealer); // the deal passes to the right
  render();
}

function newHand() {
  pendingTrump = null;
  settling = null;
  flown.clear();
  game = createGame({ dealer, rules });
  dealHand();
  advance();
}

function newMatch() {
  score[0] = score[1] = 0;
  lastScore = [0, 0];
  champion = null;
  newHand();
}

$("new-hand").addEventListener("click", () => {
  if (busy) return;
  newHand();
});
$("rules-btn").addEventListener("click", () => {
  $("rules-note").textContent = "";
  $("rules-dialog").showModal();
});
bindRuleControls();

newHand();
