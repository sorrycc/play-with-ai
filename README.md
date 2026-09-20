# Play with AI

An arcade where AI models, Jev, classic algorithms, code agents and people play games against each
other. In the board and arcade games any role can take any seat: AI vs AI, you vs AI, you vs a
friend. The code duel is you against a code agent's CLI.

Games so far:

- **Tetris**: a real-time duel. Same piece sequence, same clock. Cleared lines land on the other
  board as garbage, and a piece keeps falling while its player thinks, so latency is part of the game.
  When a person sits down, the keys are explained before the count (Space drops a piece all the
  way, which nobody guesses), and the clock waits until they say go.
- **五子棋 Gomoku**: 15×15, five in a row wins. Turn-based, so only judgment counts.
- **贪吃蛇 Snake**: two snakes on one shared grid, moving at the same instant. Hit a wall, yourself
  or the other snake and you lose; meet head-on and both die. Every step has a deadline: no answer,
  and the snake goes straight.
- **2048**: a race. Two boards, one opening, each seat sliding as fast as it answers. When time is
  up, or both are stuck, the higher score wins, so a quick thinker simply gets more moves.
- **国际象棋 Chess**: the full rules (castling, en passant, promotion, checkmate, stalemate,
  threefold repetition, fifty moves, insufficient material). A move limit adjudicates on material,
  because AI games often never reach a mate.
- **中国象棋 Xiangqi**: the full rules (blocked horses and elephants, cannons that capture over a
  screen, soldiers crossing the river, generals that may never face each other, no legal move
  loses), in traditional notation (炮二平五). Repetition is simply a draw: the tournament rules on
  perpetual check need a judgment of intent and are not implemented.

- **代码对决 Code Duel**: you against Qoder CLI. One task card, each with a small repository of its
  own, at three levels: a line or two for anyone, a small piece of logic for someone who codes,
  and edge cases to think through for an old hand. Most are one-file repositories a visitor can
  read in twenty seconds; one is cut from real open source
  ([sindresorhus/slugify](https://github.com/sindresorhus/slugify)). You write in an editor on the
  page, a code agent (Qoder CLI) works unattended on the server, and whoever first passes the
  card's hidden acceptance test wins. See [Code duel](#code-duel).

In both chess games the last move is never a mystery: the piece slides to its square, an arrow and
markers stay until the next move, and a line above the board spells it out.

The UI is Chinese by default, with English one click away (the 中/EN button; remembered per
browser). What a model reads stays English either way, so the page language never changes how a
model plays. Sound effects are synthesized in the browser (no audio files); 🔊 mutes them. ⚙️ opens
the settings page, where you choose which games appear on the home page and in what order (drag a
row, or use its arrows). All of these preferences are saved in the browser.

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

`.npmrc` pins `registry.npmjs.org`, here and in the duel's slugify repository, so an install does
not depend on whatever registry the machine defaults to.

This is set up for local use. Before putting it on a public URL, add rate limiting or an invite
code to the proxy: as it stands, anyone who can reach `/api/llm` spends your ZenMux credit.

## Roles

| Role | How it decides |
| --- | --- |
| 🤖 AI model | Gets the state and the described options, and answers through a forced function call whose argument is an enum of the legal option ids. The picker offers `deepseek/deepseek-v4.1-flash`, `qwen/qwen3.8-flash` and `anthropic/claude-haiku-4.5`; "Custom…" takes any other ZenMux model id. "Thinking" lets a reasoning model think first: smarter, and several times slower. |
| ⚡ Jev | One typed Choice question over the same options; returns calibrated probabilities. |
| 🧑‍🚀 You | Keyboard or touch in Tetris, Snake and 2048 (swipe works too), clicks in Gomoku, Chess and Xiangqi. Two people can share a keyboard: WASD and arrows. |
| 🧮 Classic bot | Hand-written algorithm, no API: a linear board evaluation in Tetris, threat scoring in Gomoku, flood fill plus shortest way to the food in Snake, expectimax in 2048, alpha-beta with a quiescence search in Chess and Xiangqi. |
| ✨ Custom algorithm | You describe how it should play, pick a model, and the model writes a `choose(game)` function once. It is tried on real positions (and sent back for one repair if it fails), saved in the browser, and from then on plays locally: no API call, no latency, no cost during a match. |
| 🐒 Chaos monkey | A random legal move. A baseline. |
| 👾 Code agent | Only in the code duel. The server runs a code agent's CLI headless in a copy of the repository. Today that is Qoder CLI, on `Qwen3.8-Max` by default or `Qwen3.8-Flash`, `Kimi-K3`, `DeepSeek-Flash`. |

## How it works

Code owns the game; a player only picks. Each game enumerates its legal moves, simulates them and
describes every outcome in words with the same fields on every option (`lines_cleared: "two lines"`,
`holes_created: "none"`, or in Gomoku `makes: "an open four"`, `blocks: "opponent's five"`). Every
player gets the same `DecisionRequest` and returns one option id, so an illegal move cannot happen
and every role is interchangeable.

In Gomoku 225 cells is too many to describe, so code offers the ~20 most relevant cells. Every
winning move and every forced block is always in the list, so the pruning never decides a game.
Options are listed by board position, not by score, so the order does not leak the bot's ranking.

In Snake a player picks one of at most three directions, each with exact facts: steps to the food,
how many empty cells stay reachable (flood fill), whether it is a dead end, and whether the
opponent's head could enter the same cell. The automatic tick is 0.9 s with Jev and 2.2 s with a
model, because both have slow outliers well above their average; lockstep waits for every answer
instead.

In Chess every legal move is offered (there is no pruning to bias the choice), each with what it
captures, whether it checks or mates, and the most material the opponent could win with one capture
in reply. That last fact is a one-move look, not a search: it catches hanging pieces, not tactics.
Both move generators are verified by perft against the published counts (`tests/chess.test.ts`,
`tests/xiangqi.test.ts`). Xiangqi offers its moves the same way.

How a model is asked matters. Probed through this proxy: in JSON mode Claude Haiku ignored the
format and wrote 400 tokens of prose (4.4 s); with a forced function call it answers in 1.5 s.
DeepSeek and Qwen reject a forced call while thinking, so thinking uses JSON mode, which is also
the retry when a model rejects the call. A plain-text reply counts only if it names exactly one
option: prose that weighs several is ambiguous, and a fallback to the classic bot beats a guess.

### Custom algorithms

Every game hands a player the same decision twice: as words for a model, and as plain data for code
(`DecisionRequest.data`: the position, plus numbers and flags about every legal move, such as
`holesCreated`, `reachable`, `opponentCanWinNext`, `evalAfter`). A generated algorithm gets that data
and returns one option id. `src/players/algoGames.ts` documents the fields of each game for the
model that writes the code, and a test fails if a field is sent but not documented.

The code is written by a language model, so it is treated as untrusted. It runs in its own Web
Worker with `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts` and the rest removed from the
global object and its prototypes before it starts, so it cannot reach the network or the `/api`
proxy; it has no DOM and no access to the page's storage; and a move that takes longer than 1.5 s
kills the worker, so an endless loop costs one move rather than the page. A throw, a timeout or an
id that is not on offer falls back to the classic bot for that move and is counted. This is
containment for careless code on a local site, not a hardened sandbox, and the code is shown to you
before you use it.

### Code duel

Every other game hands each player a `DecisionRequest`; this one has no moves to pick, so models, Jev
and the bots cannot sit down. It is a person against a code agent, and the match lives on the server
(`server/duel.mjs`), because both sides' work is files on disk and running tests.

- Every card is an environment of its own, a directory under `challenges/` whose name is the
  card's id. `card.json` is what the page shows, plus what the server needs: `files` (what the
  person may edit), `publicTest`, `open`, and `test`, which is `node` (`node --test`, nothing to
  install) or `ava`. `hidden.test.js` is the acceptance test. `start/` is the repository both sides
  start from. All but one are one source file and one test file with no dependencies; `04-emoji`
  is a snapshot of slugify with lint removed, so `npm test` is ava
  alone, about 3 s, and its dependencies are installed the first time anyone plays it.
- A card has a `level`, shown as a badge wherever the card is and used to group the setup page.
  Level 1 (`01`–`03`) is a fix of a line or two with a hint that names the edit, 2 minutes.
  Level 2 (`04`–`06`) is a small piece of logic, 3 minutes. Level 3 (`07-intervals`, `08-lru`) is
  a function body whose edge cases are the work, 5 minutes. Picking a card sets its level's time
  limit, and from level 2 up the hint is folded away until asked for. Every card has a
  `TODO(card)` comment where the work goes. The hidden test asks only for
  what the card's tasks and examples show (`tests/duel.test.ts` checks that every example is in
  it), and the agent's prompt is built from the same card, hint included, so neither side knows
  more than the other.
- Starting a duel makes two clean copies in the system temp directory, one per side. The person's
  copy is edited through the page (CodeMirror; ⌘/Ctrl+S runs the repository's own tests,
  ⌘/Ctrl+Enter submits). The agent's CLI is started in the other copy when the countdown ends, and
  its thoughts, words and tool calls stream to the page as it works.
- A side's time runs until it says "done": the person presses Submit, the agent's process exits.
  Verifying copies the hidden test in, runs it with the repository's own tests, and removes it
  again; that time is off the clock, and a pass does not win while the other side said "done"
  earlier and is still being verified. A person who fails may fix and submit again; the agent gets
  one verdict. When the limit is reached the agent is killed, and with no pass nobody wins.
- One duel at a time: starting one, stopping, leaving the page or stopping the server kills the
  agent of the previous one (its whole process group).

To add a code agent, add one entry to `server/agents.mjs`: its binary, the models it offers (the
first is the default), the arguments that run it headless on a prompt, and a function that turns a
line of its output into log entries. `readStreamJson` already reads Claude-Code-style `stream-json`.
The setup page, the player and the server pick it up from there. To add a card, add a directory
with those three things.

The duel routes write files and run what was written, and the agent runs with its permission
prompts off, so they answer only requests whose `Host` is this machine and whose `Origin`, if any,
matches it. That stops another website, or a rebound DNS name, from driving them. It is still a
local tool: do not expose it.

Measured on 2026-09-20 with the emoji card (a two-line fix), when its prompt also asked for readme
and test updates: `Qwen3.8-Max` had the fix in after 77 s but was still on the readme and tests
when the 3-minute limit killed it; each of its turns took about 10 s. A person who knows where to
look passes in under a minute. The prompt no longer asks for more than the card does.

Measured on 2026-09-19 through this proxy: DeepSeek V4.1 Flash answers in 1.4 to 3.5 s with
reasoning off (about 12 s with it on), Jev in 0.3 to 0.8 s. That is why AI Tetris defaults to a
gentle 400 ms per row, and why lockstep mode exists: it removes gravity so only decision quality is
compared.

```
server/api.mjs           the proxy: /api/config, /api/models, /api/llm, /api/generate, /api/jev
server/index.mjs         standalone server for a built site
vite.config.ts           mounts the same proxy inside the dev server
src/core/types.ts        Player, DecisionRequest, Decision, stats, seeded RNG
src/core/i18n.ts         every UI string, in zh (default) and en
src/core/sound.ts        synthesized sound effects and the mute setting
src/core/settings.ts     per-browser preferences: which games the home page shows, and their order
src/players/             llm (ZenMux), jev (TypeSafe), and the registry with bot / random / human
                         custom algorithms: algos (library), generate (prompt, trial, repair),
                         algoGames (per-game data docs and test positions), sandbox (the Worker)
src/games/tetris/        engine, real-time match, canvas drawing, arena
src/games/gomoku/        engine (shapes, candidates, bot), turn-based match, arena
src/games/snake/         two-snake engine (move facts, bot), fixed-tick match, canvas drawing, arena
src/games/g2048/         engine (slides, facts, expectimax bot), race match, arena with sliding tiles
src/games/chess/         full-rules engine (perft-verified), SAN, move facts, alpha-beta bot, match, arena
src/games/xiangqi/       full-rules engine (perft-verified), traditional notation, facts, bot, match, arena
src/ui/                  lobby, settings, seat setup, shared pieces, match lifecycle hook
tests/                   engines, request builders, answer parsing, a full scripted match
```

## Adding a game

1. `src/games/<name>/engine.ts`: pure rules, legal moves, a word description of each move, a bot.
2. `src/games/<name>/match.ts`: a class with `start()` / `stop()` that builds a `DecisionRequest`
   each turn (words for models in `options`, numbers for code in `data`) and applies the chosen
   option id. Describe the `data` fields in `src/players/algoGames.ts` so custom algorithms work.
3. `src/games/<name>/<Name>Arena.tsx`: renders the match; `useMatch` handles countdown and cleanup.
4. Add it to `GAMES` in `src/ui/Lobby.tsx`, its options to `src/ui/Setup.tsx`, and the arena to the
   switch in `src/App.tsx`.
5. Put its text in both dictionaries in `src/core/i18n.ts` (the `en` one is type-checked against
   `zh`, so a missing key fails `npm run typecheck`). Matches emit plain events; the arena maps them
   to sounds.

No player needs to change. Adding a role is the mirror image: one entry in `ROLES` and one case in
`createPlayer` (`src/players/index.ts`), and no game needs to change.

## Tests

```sh
npm test                  # engines, builders, parsers: no network
npm run typecheck

# Opt-in check against the real providers (spends a fraction of a cent):
npm run dev
LIVE_BASE=http://127.0.0.1:5173 npm run test:live
```
