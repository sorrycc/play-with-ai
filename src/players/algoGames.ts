// What a generated algorithm needs to know about each game: a description of the data it receives
// (the `data` every game puts on its DecisionRequest), and real positions to try new code on.
//
// The descriptions are written for the model that writes the code, so they are in English whatever
// the page language is.

import type { AlgoInput, DecisionGameId } from '../core/types';
import { seededRandom } from '../core/types';
import * as chess from '../games/chess/engine';
import { buildChessRequest } from '../games/chess/match';
import * as g2048 from '../games/g2048/engine';
import { build2048Request } from '../games/g2048/match';
import * as gomoku from '../games/gomoku/engine';
import { buildGomokuRequest } from '../games/gomoku/match';
import * as snake from '../games/snake/engine';
import { buildSnakeRequest } from '../games/snake/match';
import * as tetris from '../games/tetris/engine';
import { buildTetrisRequest } from '../games/tetris/match';
import * as xiangqi from '../games/xiangqi/engine';
import { buildXiangqiRequest } from '../games/xiangqi/match';

export interface AlgoGame {
  /** The game and the goal, in a sentence or two. */
  goal: string;
  /** `game.state`, field by field. */
  state: string;
  /** `option.facts`, field by field. */
  facts: string;
  /** A few real positions, early and later in a game. */
  samples(): AlgoInput[];
}

function tetrisSamples(): AlgoInput[] {
  const random = seededRandom(7);
  const pieces = tetris.makeBag(random).concat(tetris.makeBag(random), tetris.makeBag(random));
  let board = tetris.emptyBoard();
  const out: AlgoInput[] = [];
  pieces.forEach((piece, i) => {
    const placements = tetris.enumeratePlacements(board, piece);
    if (placements.length === 0) return;
    if (i === 0 || i === 7 || i === 15 || i === 20) out.push(buildTetrisRequest({ board, current: piece, next: pieces[i + 1] ?? 'T', lines: 0 }, placements, true).data);
    // A deliberately clumsy player, so later samples have holes and an uneven surface.
    board = placements[(i * 5) % placements.length].afterBoard;
  });
  return out;
}

function gomokuSamples(): AlgoInput[] {
  const random = seededRandom(3);
  const board = gomoku.emptyGomokuBoard();
  const out: AlgoInput[] = [];
  let stone: gomoku.Stone = gomoku.BLACK;
  for (let move = 1; move <= 17; move++) {
    const list = gomoku.candidates(board, stone);
    if ([1, 4, 9, 16].includes(move)) out.push(buildGomokuRequest(board, stone, list, move, null).data);
    // Not always the best move, so that threats appear on the board.
    const pick = move % 3 === 0 ? list[Math.floor(random() * Math.min(6, list.length))] : gomoku.botMove(list, random);
    board[pick.index] = stone;
    if (gomoku.winningLine(board, pick.index)) break;
    stone = gomoku.other(stone);
  }
  return out;
}

function snakeSamples(): AlgoInput[] {
  let state = snake.createDuel({ seed: 11 });
  const out: AlgoInput[] = [];
  for (let step = 0; step < 60; step++) {
    const facts = [snake.analyze(state, 0), snake.analyze(state, 1)];
    if ([0, 12, 30, 55].includes(step) && facts[step % 2].length) out.push(buildSnakeRequest(state, (step % 2) as 0 | 1, facts[step % 2], true).data);
    const dirs = facts.map((f, i) => (f.length ? snake.botMove(f) : state.snakes[i].heading)) as [snake.Dir, snake.Dir];
    state = snake.stepDuel(state, dirs);
    if (!state.snakes[0].alive || !state.snakes[1].alive) break;
  }
  return out;
}

function samples2048(): AlgoInput[] {
  const random = seededRandom(5);
  let board = g2048.startBoard(random);
  let score = 0;
  const out: AlgoInput[] = [];
  for (let move = 0; move < 140; move++) {
    const facts = g2048.analyze(board);
    if (facts.length === 0) break;
    if ([0, 20, 70, 139].includes(move)) out.push(build2048Request(board, score, facts).data);
    // Mostly sound play so the game lasts, with a careless slide now and then so the board gets messy,
    // which is when choices matter.
    const fact = move % 5 === 4 ? facts[move % facts.length] : facts.find((f) => f.dir === g2048.botMove(board))!;
    score += fact.result.gained;
    board = g2048.spawn(fact.result.board, random)!.board;
  }
  return out;
}

function chessSamples(): AlgoInput[] {
  const random = seededRandom(2);
  let state = chess.startState();
  const out: AlgoInput[] = [];
  for (let ply = 0; ply < 25; ply++) {
    const legal = chess.legalMoves(state);
    if (chess.outcome(state, legal)) break;
    if ([0, 7, 16, 24].includes(ply)) out.push(buildChessRequest(state, chess.analyze(state, legal), []).data);
    state = chess.makeMove(state, ply % 4 === 3 ? legal[Math.floor(random() * legal.length)] : chess.botMove(state, 1, random));
  }
  return out;
}

function xiangqiSamples(): AlgoInput[] {
  const random = seededRandom(2);
  let state = xiangqi.startState();
  const out: AlgoInput[] = [];
  for (let ply = 0; ply < 25; ply++) {
    const legal = xiangqi.legalMoves(state);
    if (xiangqi.outcome(state, legal)) break;
    if ([0, 7, 16, 24].includes(ply)) out.push(buildXiangqiRequest(state, xiangqi.analyze(state, legal), []).data);
    state = xiangqi.makeMove(state, ply % 4 === 3 ? legal[Math.floor(random() * legal.length)] : xiangqi.botMove(state, 1, random));
  }
  return out;
}

export const ALGO_GAMES: Record<DecisionGameId, AlgoGame> = {
  tetris: {
    goal: 'Tetris on a 10-wide, 20-tall board. Each call places one falling piece. Full rows clear; the game is lost when the stack reaches the top. In versus mode every cleared line also sends a garbage row to the opponent. Survive, and clear lines.',
    state:
      'board: 20 strings of 10 chars, top row first, "#" filled and "." empty. columnHeights: 10 numbers. maxHeight, holes (empty cells with a filled cell above), bumpiness (sum of height differences between neighbouring columns): numbers. currentPiece, nextPiece: one of I O T S Z J L. linesClearedSoFar: number.',
    facts:
      'One option per distinct place the current piece can land. column (0-9, leftmost cell), rotation (0-3), landingRow. linesCleared (0-4) by this placement. holesCreated, holesRemoved, holesAfter. maxHeightAfter, heightDelta (change in the tallest column; negative is good), aggregateHeightAfter (sum of column heights), bumpinessAfter, deepWellsAfter (columns 3+ lower than both neighbours), columnHeightsAfter (10 numbers).',
    samples: tetrisSamples,
  },
  gomoku: {
    goal: 'Gomoku (five in a row) on a 15x15 board; players alternate placing stones, and five or more in a row, column or diagonal wins.',
    state: 'board: 15 strings of 15 chars, top row first, "X" black, "O" white, "." empty. size: 15. you, opponent: "X" or "O". moveNumber.',
    facts:
      'The options are the ~20 most relevant empty cells; every winning move and every forced block is always among them. row, col (0-14). makes: the best shape this stone makes for you, one of "five", "open_four", "four", "open_three", "three", "open_two", "two", "none". blocks: the best shape the opponent would make by playing here instead, same vocabulary. attackScore, defenseScore: numeric value of those shapes summed over the four directions (five 1000000, open_four 100000, four 10000, open_three 5000, three 500, open_two 200, two 40). attackThreats, defenseThreats: how many directions make a four or open three (2+ is a fork). distanceToCentre: 0-7.',
    samples: gomokuSamples,
  },
  snake: {
    goal: 'Two snakes on one grid, moving at the same instant. A snake dies on a wall, on its own body or on the other snake; if both heads enter the same cell both die. Eating food grows the snake. If the opponent dies and you do not, you win; otherwise the longer snake wins at the time limit.',
    state:
      'board: strings, top row first: "A" your head, "a" your body, "B" opponent head, "b" opponent body, "F" food, "." empty. cols, rows. yourHead, opponentHead, food: {row, col} (food may be null). yourHeading, opponentHeading: "up" "right" "down" "left". yourLength, opponentLength. yourStepsToFood, opponentStepsToFood: Manhattan distance or null.',
    facts:
      'One option per direction that is not immediately fatal (1 to 3 options; ids are "up" "right" "down" "left"). turn: "straight", "left turn" or "right turn". targetRow, targetCol. eats: boolean. foodDistance after the move (or null). reachable: empty cells reachable from the new head by flood fill; freeTotal: all empty cells. deadEnd: true when reachable is less than your length and your tail cannot be followed out (almost always fatal). canReachTail: boolean. headOnRisk: true when the opponent head could enter the same cell this step.',
    samples: snakeSamples,
  },
  '2048': {
    goal: '2048 on a 4x4 board. A move slides all tiles one way; equal tiles that meet merge and score their sum; then a 2 or 4 appears on a random empty cell. The game ends when nothing can move. Highest score wins, and the match has a clock, so there is no benefit to being slow.',
    state: 'board: 4 rows of 4 numbers, 0 is empty. score. largestTile.',
    facts:
      'One option per direction that changes the board (ids "up" "right" "down" "left"). pointsGained, merges. emptyAfter (0-16). largestTileAfter. largestInCornerBefore, largestInCornerAfter: booleans. orderAfter: 0-1, how monotonic rows and columns are (1 is a perfect snake). equalPairsAfter: neighbouring equal tiles, i.e. merges available next. directionsLeftAfter: 0-4 directions still possible before the random tile lands (1 or less is dangerous). boardAfter: the 4x4 board after the slide, before the random tile, so you can evaluate it yourself.',
    samples: samples2048,
  },
  chess: {
    goal: 'Standard chess. You are given every legal move with facts about it; there is no engine to call, so play well from the facts: material, safety, checks, and the static evaluation after each move.',
    state:
      'board: 8 strings of 8 chars, rank 8 first, FEN letters (upper case White, lower case Black), "." empty. youAre: "w" or "b". moveNumber. inCheck: boolean. materialBalance: in pawns, positive when you are ahead.',
    facts:
      'san (e.g. "Nf3"), piece ("p" "n" "b" "r" "q" "k"), from, to (e.g. "e2"). captures: piece letter or null; captureValue in pawns (p1 n3.2 b3.3 r5 q9). givesCheck, checkmate, stalemate: booleans. opponentCanWinNext: pawns of material the opponent can win with its best single capture in reply (0 means nothing hangs); this is a one-move look, not a search. castles: boolean. promotesTo: "q" "r" "b" "n" or null. evalAfter: static evaluation after the move in pawns from your point of view (material plus piece placement); it does not see the opponent reply, so combine it with opponentCanWinNext.',
    samples: chessSamples,
  },
  xiangqi: {
    goal: 'Chinese chess (xiangqi). Red moves first from the bottom. A player with no legal move loses. You are given every legal move with facts about it; there is no engine to call.',
    state:
      'board: 10 strings of 9 chars, Black back rank first: K general, A advisor, B elephant, N horse, R chariot, C cannon, P soldier; upper case Red, lower case Black, "." empty. youAre: "red" or "black". moveNumber. inCheck. materialBalance: in soldiers, positive when you are ahead.',
    facts:
      'notation (traditional, e.g. "炮二平五"), piece ("general" "advisor" "elephant" "horse" "chariot" "cannon" "soldier"), from, to (files a-i, ranks 0-9 from Red\'s side, e.g. "h2"). captures: piece name or null; captureValue (chariot 9, cannon 4.5, horse 4, advisor 2, elephant 2, soldier 1). givesCheck: boolean. winsTheGame: true when the opponent has no legal reply. opponentCanWinNext: material the opponent can win with its best single capture in reply (0 means nothing hangs); a one-move look, not a search. evalAfter: static evaluation after the move in soldiers from your point of view; it does not see the opponent reply.',
    samples: xiangqiSamples,
  },
};
