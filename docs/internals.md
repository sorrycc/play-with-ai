# Internals

How each game turns a position into options, and how each kind of player is asked.

## Building the options

Code owns the game; a player only picks. Each game enumerates its legal moves, simulates them and
describes every outcome in words with the same fields on every option (`lines_cleared: "two lines"`,
`holes_created: "none"`, or in Gomoku `makes: "an open four"`, `blocks: "opponent's five"`). Every
player gets the same `DecisionRequest` and returns one option id, so an illegal move cannot happen
and every role is interchangeable.

In Tetris the options are not the straight drops but every distinct board the piece can leave
behind, found by breadth-first search over moves and turns from the spawn, so a placement tucked
under an overhang is on offer too (`tuck` says which). Because the option carries the pose it was
found at, the match locks the piece on exactly that pose: the board a player is promised is the
board it gets. An answer that arrives after the piece has fallen past its placement cannot be
played, and is counted as a missed deadline rather than dropped somewhere else. Alongside the
board, a player is told what it is about to be hit with — `incoming_garbage`, the opponent's stack
and lines, what each option would send — plus the next three pieces and the hold slot, which is one
more option id rather than a second kind of answer.

In Gomoku 225 cells is too many to describe, so code offers the ~20 most relevant cells. Every
winning move and every forced block is always in the list, so the pruning never decides a game.
Options are listed by board position, not by score, so the order does not leak the bot's ranking.

In Snake a player picks one of at most three directions, each with exact facts: steps to the food
along the shortest open path (not as the crow flies, and `null` when there is no path), how many
empty cells stay reachable (flood fill), how many of those it would reach before the opponent could,
whether it is a dead end, and whether the opponent's head could enter the same cell — with whether
that head-on would still be won on length. A player is also told what actually decides the match:
the clock, that the longer snake wins when it runs out, and how many steps are left before the walls
close in again. The automatic tick is 0.9 s with Jev and 2.2 s with a model, because both have slow
outliers well above their average; lockstep waits for every answer instead. A question is never
thrown away at the deadline: the answer still arrives and is still counted, because it was paid for,
and only the move is too late to play.

In Chess every legal move is offered (there is no pruning to bias the choice), each with what it
captures, whether it checks or mates, and the most material the opponent could win with one capture
in reply. That last fact is a one-move look, not a search: it catches hanging pieces, not tactics.
Both move generators are verified by perft against the published counts (`tests/chess.test.ts`,
`tests/xiangqi.test.ts`). Xiangqi offers its moves the same way.

## How a model is asked

How a model is asked matters. Probed through this proxy: in JSON mode Claude Haiku ignored the
format and wrote 400 tokens of prose (4.4 s); with a forced function call it answers in 1.5 s.
DeepSeek and Qwen reject a forced call while thinking, so thinking uses JSON mode, which is also
the retry when a model rejects the call. A plain-text reply counts only if it names exactly one
option: prose that weighs several is ambiguous, and a fallback to the classic bot beats a guess.

## Which models are offered

The model picker offers `deepseek/deepseek-v4.1-flash`, `qwen/qwen3.8-flash` and
`anthropic/claude-haiku-4.5`; "Custom…" takes any other ZenMux model id.

## Custom algorithms

Every game hands a player the same decision twice: as words for a model, and as plain data for code
(`DecisionRequest.data`: the position, plus numbers and flags about every legal move, such as
`holesCreated`, `reachable`, `opponentCanWinNext`, `evalAfter`). A generated algorithm gets that data
and returns one option id. It is tried on real positions (and sent back for one repair if it
fails), then saved in the browser. `src/players/algoGames.ts` documents the fields of each game for the
model that writes the code, and a test fails if a field is sent but not documented.

The code is written by a language model, so it is treated as untrusted. It runs in its own Web
Worker with `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts` and the rest removed from the
global object and its prototypes before it starts, so it cannot reach the network or the `/api`
proxy; it has no DOM and no access to the page's storage; and a move that takes longer than 1.5 s
kills the worker, so an endless loop costs one move rather than the page. A throw, a timeout or an
id that is not on offer falls back to the classic bot for that move and is counted. This is
containment for careless code on a local site, not a hardened sandbox, and the code is shown to you
before you use it.

## Measured latencies

Measured on 2026-09-19 through this proxy: DeepSeek V4.1 Flash answers in 1.4 to 3.5 s with
reasoning off (about 12 s with it on), Jev in 0.3 to 0.8 s. That is why AI Tetris defaults to a
gentle 400 ms per row, and why lockstep mode exists: it removes gravity for every seat, a person's
included, so only decision quality is compared. A seat never has more than one unanswered request
in flight — the older one is cut off — and an answer that turns up after its piece locked is still
recorded, so a slow model's bill is visible instead of showing as $0.
