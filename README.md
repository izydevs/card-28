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

The Jack is the strongest card and the Nine beats the Ace.

**28 points.** `J = 3`, `9 = 2`, `A = 1`, `10 = 1`; the rest are worth nothing. Across four
suits that is exactly 28 — which is where the name comes from, and the whole game is a
fight over those points. The value is printed in gold on each card that has one.

**Bidding.** You see four cards and bid how many of the 28 your side will take, from 16 up.
The winner picks a trump suit and lays that card **face down**; the remaining four cards are
then dealt.

**The concealed trump** is what separates this from other trick-takers. Nobody knows the
suit — not even the bidder's partner. Follow the led suit if you can. When you *cannot*, you
may **call for trump** to have it turned up, and from that card onward trump beats
everything. A trump played *before* the reveal is just a discard, which is the whole point
of keeping it hidden.

## Code

| File | What it holds |
| --- | --- |
| `public/game.js` | the rules — pure functions and plain state, no DOM |
| `public/ai.js` | bidding, trump choice, card play; never sees hidden information |
| `public/ui.js` | table, hands, animation, interaction |
| `scripts/test.mjs` | rules tests |
| `scripts/selfplay.mjs` | plays complete hands with the AI in all four seats |
| `server.mjs` | static host, so ES modules load over http rather than file:// |

`game.js` has no DOM references, so the same module runs in the browser and under Node —
which is what makes the self-play harness possible.

### Four rules that are easy to get wrong

**Legality lives in one place.** `legalPlaysFor(state, seat)` is the single answer to "what
may this seat play now?" — following suit, plus the rule that a player who called for trump
must then use it. The engine, the AI and the UI all read the same list. When the AI had its
own idea of legality, it kept proposing a card the engine rejected and the hand looped
forever; self-play found this in about a quarter of hands.

**The bidder's face-down card is still one of their eight.** While it is concealed they play
from seven, so if trump is never called they run out a trick early and the hand stalls. It
comes back up when it is the only card they hold.

**A trump played before the reveal cannot win.** `trickWinner` takes the index at which
trump became live and ignores trump cards played earlier in the same trick.

**The AI's bid estimate is absolute, not anchored to the table minimum.** When it was
written as `MIN_BID + strength`, raising the minimum from 14 to 16 silently raised every
estimate with it and contracts made fell from 47% to 33%. `BID_BASE` in `ai.js` is swept
against the self-play make-rate.

## Testing

`npm test` runs the rules tests and then plays **600 complete hands** with the AI in every
seat, asserting on each that it finishes in eight tricks, that every hand empties, that all
28 points are captured across 32 cards, and that the verdict matches the count. It also
fails if the contract is *always* made or *never* made — a game that runs but is not a
contest is still broken.

Current run: ~4% of deals passed out, contracts made ~47%, bids opening at 16.

## Licence

MIT — see [LICENSE](LICENSE).
