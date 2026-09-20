# Play with AI

An arcade where AI models, Jev, classic algorithms, code agents and people play games against each
other. In the board and arcade games any role can take any seat: AI vs AI, you vs AI, you vs a
friend. The code duel is you against a code agent's CLI.

Games so far:

- **Tetris**: a real-time duel. Same piece sequence, same clock. Clearing rows lands garbage
  on the other board (one row per line by default; the guideline table, where a single sends
  nothing and a Tetris sends four, is a setting), and rows you clear cancel garbage waiting for you, so attacking and defending are the same
  move. Both sides see three pieces ahead and can hold one; a piece can be slid or turned under an
  overhang, so every legal placement is on offer, not only the straight drops. A piece keeps falling
  while its player thinks, so latency is part of the game — and an answer that arrives after the
  piece has locked is still counted and still billed.
- **五子棋 Gomoku**: 15×15, five in a row wins. Turn-based, so only judgment counts. 225 cells is
  too many to describe, so code offers about twenty; every winning move, every forced block and
  every fork on either side is always among them, so the pruning never decides a game. Black opens
  on one of nine points rather than always the centre, a rematch swaps the colours, and a person
  gets the move list and a take-back.
- **贪吃蛇 Snake**: two snakes on one shared grid, moving at the same instant. Meet head-on and both
  die — and then the longer one wins, which is also how the clock settles it, so length is the
  score. Halfway through, the walls start closing in. Every step has a deadline: no answer, and the
  snake goes straight.
- **2048**: a race. Two boards, one opening, each seat sliding as fast as it answers, so a quick
  thinker simply gets more moves. Each side sees the other's score, the gap and the seconds left, so
  it can tell when to gamble. When the clock runs out the higher score wins; an equal score goes to
  the bigger tile, and an equal tile to whoever needed fewer moves, because one seed and one pace
  otherwise make a mirror match a guaranteed draw. Same-moves mode drops the race and compares
  judgement alone, the way lockstep does in Tetris and Snake.
- **国际象棋 Chess**: the full rules, down to threefold repetition and dead positions. A person can
  resign or offer a draw, the position copies out as a FEN and the game as a PGN, and a move limit
  adjudicates on the evaluation, because AI games often never reach a mate. The classic bot deepens
  under a time budget and mates with a lone queen or rook rather than shuffling into the fifty-move
  rule.
- **中国象棋 Xiangqi**: the full rules, in traditional notation (炮二平五, 前车进一, 三兵平四).
  A repetition is a draw, except when one side gave check on every move of it: that is 长将, and it
  loses. The classic bot opens from a book and then deepens under a time budget; the move list is
  clickable, so any position in the game goes back on the board.
- **代码对决 Code Duel**: you against Qoder CLI. Ten task cards at three levels. You write in an
  editor on the page, the agent works unattended on the server, and whoever first passes the card's
  hidden acceptance test wins. Give it a head start if that is too easy, or take the card on your
  own in practice mode, which needs no agent installed.

In both chess games the last move is never a mystery: the piece slides to its square, an arrow
stays until the next move, and a line above the board spells it out.

The UI is Chinese by default, with English one click away (the 中/EN button). What a model reads
stays English either way, so the page language never changes how a model plays. Sound effects are
synthesized in the browser; 🔊 mutes them. ⚙️ chooses which games appear on the home page and in
what order. All of these preferences are saved in the browser.

The idea and the Tetris engine come from [trungdq88/jev-tetris](https://github.com/trungdq88/jev-tetris);
Snake's move facts, flood fill and tick loop follow jev-snake, turned into a two-player duel.

## Run it

Requires Node.js 20.6 or newer.

```sh
cp .env.example .env      # then fill in the keys
npm install
npm run dev               # http://127.0.0.1:5173
```

| Variable | Used by |
| --- | --- |
| `ZENMUX_API_KEY` | The "AI model" role: any chat model on [ZenMux](https://zenmux.ai) |
| `TYPESAFE_API_KEY` | The "Jev" role: [TypeSafe](https://docs.typesafe.ai) System One |

The code duel needs no key, but to play against an agent it needs that agent's CLI on the `PATH` of
the process you start the server from: `qodercli`, signed in. `/api/config` reports which agents
were found. Practice mode needs neither.

A role whose key is missing is greyed out; everything else still works. Keys are read only by the
proxy (`server/api.mjs`) and never reach the browser. `.env` is git-ignored.

`npm run build && npm start` serves the built site and the same proxy from one Node process.

This is set up for local use. Before putting it on a public URL, add rate limiting or an invite
code to the proxy: as it stands, anyone who can reach `/api/llm` spends your ZenMux credit.

## Roles

| Role | How it decides |
| --- | --- |
| 🤖 AI model | Gets the state and the described options, and answers through a forced function call whose argument is an enum of the legal option ids. Any ZenMux model id works; "Thinking" lets a reasoning model think first: smarter, and several times slower. |
| ⚡ Jev | One typed Choice question over the same options; returns calibrated probabilities. |
| 🧑‍🚀 You | Keyboard or touch in Tetris, Snake and 2048 (swipe works too), clicks in Gomoku, Chess and Xiangqi. Two people can share a keyboard: WASD and arrows. |
| 🧮 Classic bot | Hand-written algorithm, no API: a linear board evaluation in Tetris, played out one piece deeper over the piece it already knows is coming (which roughly doubles how long it lasts under garbage), threat scoring plus a win-by-continuous-fours search in Gomoku, flood fill plus the shortest open way to the food in Snake, over a one-step look at every answer the other snake could give, expectimax in 2048, a second ply deep once the board is crowded enough to afford it (a sixth more score, and 2048 in seven games out of twelve rather than five), alpha-beta with a quiescence search in Chess and Xiangqi, deepened one ply at a time under a time budget. |
| ✨ Custom algorithm | You describe how it should play, a model writes a `choose(game)` function once, and from then on it plays locally: no API call, no latency, no cost during a match. |
| 🐒 Chaos monkey | A random legal move. A baseline. |
| 👾 Code agent | Only in the code duel. The server runs a code agent's CLI headless in a copy of the repository. |

## How it works

Code owns the game; a player only picks. Each game enumerates its legal moves, simulates them and
describes every outcome in words with the same fields on every option (`lines_cleared: "two lines"`,
`holes_created: "none"`, or in Gomoku `makes: "an open four"`, `blocks: "opponent's five"`). Every
player gets the same `DecisionRequest` and returns one option id, so an illegal move cannot happen
and every role is interchangeable.

The same decision also goes out as plain data — numbers and flags about every legal move — which is
what a custom algorithm reads. That code is written by a language model, so it is treated as
untrusted: it runs in its own Web Worker with the network removed, a move over 1.5 s kills the
worker, and the code is shown to you before you use it.

## Docs

- [Internals](docs/internals.md) — what each game puts on an option, how models are asked, custom
  algorithms, measured latencies
- [Code duel](docs/code-duel.md) — cards, levels, how a duel runs, adding an agent or a card
- [Contributing](docs/contributing.md) — the file map, adding a game, adding a role

## Tests

```sh
npm test                  # engines, builders, parsers: no network
npm run typecheck

# Opt-in check against the real providers (spends a fraction of a cent):
npm run dev
LIVE_BASE=http://127.0.0.1:5173 npm run test:live
```
