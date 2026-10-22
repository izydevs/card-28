# Twenty-Eight (28)

The Indian trick-taking card game, playable in the browser against three opponents.
No dependencies, no build step, no network — open it and play.

```bash
npm start   # http://127.0.0.1:4400
npm test    # rules tests + 600 AI-vs-AI hands
```

You are **South**; **North** is your partner, against West and East.

## The game

**32 cards.** Only eight ranks, and the order is the game's own:

```
J > 9 > A > 10 > K > Q > 8 > 7
```

**28 points.** `J = 3`, `9 = 2`, `A = 1`, `10 = 1`; the rest are worth nothing. Across four
suits that is exactly 28 — which is where the name comes from.

The full rules are in the in-game **Rules** panel. In short:

| Stage | Rule |
| --- | --- |
| Deal | Counter-clockwise. Four cards each, bidding, then four more. |
| Bidding | The player on the dealer's right must open at the minimum (16, or 14). A pass is final. Bidding over your own partner takes 20+. |
| Trump | The winner lays a card of the trump suit **face down**; nobody else knows it. |
| Second round | With eight cards seen, the bidder may raise to 24+, then the partner may raise over it and take the contract with a new trump. |
| Doubling | Opponents may double (×2); the bidder may redouble (×4). |
| Play | Follow suit. When void you may call for trump — then you must play one. A trump played before the reveal is only a discard. |
| Bidder | May not lead the hidden trump suit; may not reveal when trump is led; when void in another suit, discards a non-trump or reveals and trumps. Trump is turned up for the eighth trick if still hidden. |
| Pair | K+Q of trump, shown after the reveal once your side has won a trick: your contract −4, or theirs +4. |
| Thani | The bidder plays alone for all eight tricks, no trump, partner sits out: +4 / −5. |
| Scoring | Only the bidding side moves: 16–19 `+1/−2`, 20–24 `+2/−3`, 25–28 `+3/−4`. First to +6 wins the match; −6 loses it. |
| Cot | All eight tricks scores double. A side with no tricks may concede; the winners accept the single score or play on for double — and lose double if they drop a trick. |
| Redeals | Pointless opening four; one player with all four Jacks; opponents dealt no trumps; (house) a pointless eight-card hand. |

**House rules** are switchable in the Rules panel: opening at 14, second round, doubling, Pair,
Thani, Cot, pointless-hand redeal, *no Jack discard*, and a **Joker** — not traditional: it
replaces the 7♣ (still 32 cards, 28 points), is worth nothing, may be played at any time, is the
highest trump once trump is revealed, and cannot win before that.

## Code

| File | What it holds |
| --- | --- |
| `public/game.js` | the rules — pure functions and plain state, no DOM |
| `public/ai.js` | every decision: bids, trump, raises, doubles, Thani, Pair, concession, card play; never sees hidden information |
| `public/ui.js` | table, hands, animation, interaction |
| `scripts/test.mjs` | rules tests |
| `scripts/selfplay.mjs` | plays complete hands with the AI in all four seats |
| `server.mjs` | static host, so ES modules load over http rather than file:// |

`game.js` has no DOM references, so the same module runs in the browser and under Node —
which is what makes the self-play harness possible.

### Four rules that are easy to get wrong

**Legality lives in one place.** `legalPlaysFor(state, seat)` is the single answer to "what
may this seat play now?" — following suit, the rule that a player who called for trump must
then use it, the bidder's restrictions while trump is hidden, the Joker, and no-Jack-discard. The engine, the AI and the UI all read the same list. When the AI had its
own idea of legality, it kept proposing a card the engine rejected and the hand looped
forever; self-play found this in about a quarter of hands.

**The bidder's face-down card is still one of their eight.** While it is concealed they play
from seven, so if trump is never called they would run out a trick early and the hand would
stall. If it is still hidden after seven tricks, it is turned up for the last one.

**A trump played before the reveal cannot win.** `trickWinner` takes the index at which
trump became live and ignores trump cards played earlier in the same trick.

**The AI's bid estimate is absolute, not anchored to the table minimum.** When it was
written as `MIN_BID + strength`, raising the minimum from 14 to 16 silently raised every
estimate with it and contracts made fell from 47% to 33%. `BID_BASE` in `ai.js` is swept
against the self-play make-rate.

## Testing

`npm test` runs the rules tests — one or more per rule, on stacked decks — and then plays
**600 hands under each of four rule sets** (default, opening at 14, Joker + no-Jack-discard,
core rules only) with the AI in every seat. Each hand is checked for legal play, the bidder's
restrictions, trump being live for the last trick, all 28 points over 32 cards (or the right
shape for Thani and concessions), and a score whose sign matches the verdict. It also fails
if the contract is *always* made or *never* made — a game that runs but is not a contest is
still broken.

Current run: contracts made ~40–50% depending on rules; pairs, doubles, raises, Cots and
concessions all occur.

## Licence

MIT — see [LICENSE](LICENSE).
