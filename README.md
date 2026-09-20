# Play with AI

An arcade where AI models, Jev, classic algorithms, code agents and people play games against each
other. In the board and arcade games any role can take any seat: AI vs AI, you vs AI, you vs a
friend. The code duel is you against a code agent's CLI.

Games so far:

- **Tetris**: a real-time duel. Same piece sequence, same clock. Cleared lines land on the other
  board as garbage, and a piece keeps falling while its player thinks, so latency is part of the game.
- **五子棋 Gomoku**: 15×15, five in a row wins. Turn-based, so only judgment counts.
- **贪吃蛇 Snake**: two snakes on one shared grid, moving at the same instant. Meet head-on and both
  die. Every step has a deadline: no answer, and the snake goes straight.
- **2048**: a race. Two boards, one opening, each seat sliding as fast as it answers, so a quick
  thinker simply gets more moves.
- **国际象棋 Chess**: the full rules, down to threefold repetition and insufficient material. A move
  limit adjudicates on material, because AI games often never reach a mate.
- **中国象棋 Xiangqi**: the full rules, in traditional notation (炮二平五). Repetition is simply a
  draw: the tournament rules on perpetual check need a judgment of intent and are not implemented.
- **代码对决 Code Duel**: you against Qoder CLI. One task card at three levels. You write in an
  editor on the page, the agent works unattended on the server, and whoever first passes the card's
  hidden acceptance test wins.

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

The code duel needs no key, but it needs the agent's CLI on the `PATH` of the process you start the
server from: `qodercli`, signed in. `/api/config` reports which agents were found.

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
| 🧮 Classic bot | Hand-written algorithm, no API: a linear board evaluation in Tetris, threat scoring in Gomoku, flood fill plus shortest way to the food in Snake, expectimax in 2048, alpha-beta with a quiescence search in Chess and Xiangqi. |
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
