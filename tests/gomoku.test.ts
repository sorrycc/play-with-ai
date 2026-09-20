import { describe, expect, it } from 'vitest';
import type { Decision, DecisionRequest, Player } from '../src/core/types';
import {
  BLACK,
  OPENING,
  WHITE,
  at,
  bestMove,
  botMove,
  candidates,
  cellId,
  describeCandidate,
  emptyGomokuBoard,
  evaluateCell,
  parseCellId,
  urgencyRank,
  winningLine,
  type Stone,
} from '../src/games/gomoku/engine';
import { GomokuMatch, buildGomokuRequest } from '../src/games/gomoku/match';

function boardWith(stones: [row: number, col: number, stone: Stone][]) {
  const board = emptyGomokuBoard();
  for (const [r, c, s] of stones) board[at(r, c)] = s;
  return board;
}

const run = (cells: number[], row: number, from: number, stone: Stone): [number, number, Stone][] => cells.map((c) => [row, from + c, stone]);

describe('gomoku engine', () => {
  it('names cells like a real board: H8 is the centre, no column I', () => {
    expect(cellId(at(7, 7))).toBe('H8');
    expect(cellId(at(0, 0))).toBe('A15');
    expect(cellId(at(14, 14))).toBe('P1');
    expect(parseCellId('h8')).toBe(at(7, 7));
    expect(parseCellId('I8')).toBeNull();
    expect(parseCellId('A16')).toBeNull();
    for (let i = 0; i < 225; i++) expect(parseCellId(cellId(i))).toBe(i);
  });

  it('detects five in a row in every direction, and not four', () => {
    const row = boardWith([0, 1, 2, 3, 4].map((c) => [7, c, BLACK]));
    expect(winningLine(row, at(7, 2))?.sort()).toEqual([0, 1, 2, 3, 4].map((c) => at(7, c)));
    const diag = boardWith([0, 1, 2, 3, 4].map((k) => [10 - k, 3 + k, WHITE]));
    expect(winningLine(diag, at(10, 3))).toHaveLength(5);
    const four = boardWith([0, 1, 2, 3].map((c) => [7, c, BLACK]));
    expect(winningLine(four, at(7, 0))).toBeNull();
  });

  it('tells an open four from a blocked four, and sees split shapes', () => {
    const open = boardWith([5, 6, 7].map((c) => [7, c, BLACK]));
    expect(evaluateCell(open, at(7, 8), BLACK).best).toBe('open_four');
    const blocked = boardWith([[7, 4, WHITE], ...[5, 6, 7].map((c): [number, number, Stone] => [7, c, BLACK])]);
    expect(evaluateCell(blocked, at(7, 8), BLACK).best).toBe('four');
    // X X _ X X : the middle cell makes five
    const split = boardWith([3, 4, 6, 7].map((c) => [7, c, BLACK]));
    expect(evaluateCell(split, at(7, 5), BLACK).best).toBe('five');
  });

  it('calls a three open only when one more stone would make an open four', () => {
    // _ X X * _ : a live three, one stone away from an open four either side.
    const live = boardWith([5, 6].map((c) => [7, c, BLACK]));
    expect(evaluateCell(live, at(7, 7), BLACK).best).toBe('open_three');
    // Broken but still live: _ X _ X * _
    const broken = boardWith([[7, 4, BLACK], [7, 6, BLACK]] as [number, number, Stone][]);
    expect(evaluateCell(broken, at(7, 7), BLACK).best).toBe('open_three');
    // Two three-windows made by stones that never combine: D8 is four cells away and the row ends
    // at P, so N8 can only ever reach a blocked four. Counting windows called this an open three.
    const phantom = boardWith([[7, 3, BLACK], [7, 9, BLACK], [7, 13, BLACK], [7, 14, BLACK]] as [number, number, Stone][]);
    expect(evaluateCell(phantom, at(7, 12), BLACK).best).toBe('three');
    // Nothing in the whole position gives black an open four, which is what "open" promised.
    const after = boardWith([[7, 3, BLACK], [7, 9, BLACK], [7, 12, BLACK], [7, 13, BLACK], [7, 14, BLACK]] as [number, number, Stone][]);
    for (let i = 0; i < 225; i++) if (!after[i]) expect(evaluateCell(after, i, BLACK).best).not.toBe('open_four');
  });

  it('names a four in two directions at once, which wins as surely as an open four', () => {
    const board = boardWith([
      ...run([0, 1, 2], 7, 4, WHITE),
      [7, 3, BLACK],
      ...[4, 5, 6].map((r): [number, number, Stone] => [r, 7, WHITE]),
      [3, 7, BLACK],
    ]);
    const cell = evaluateCell(board, at(7, 7), WHITE);
    expect(cell.best).toBe('double_four');
    // Two cells give five afterwards, and only one of them can be blocked.
    board[at(7, 7)] = WHITE;
    const fives = [...Array(225).keys()].filter((i) => {
      if (board[i]) return false;
      board[i] = WHITE;
      const win = winningLine(board, i) !== null;
      board[i] = 0;
      return win;
    });
    expect(fives).toEqual([at(7, 8), at(8, 7)]);
  });

  it('the bot wins when it can, and otherwise blocks a five', () => {
    const board = boardWith([
      ...[3, 4, 5, 6].map((c): [number, number, Stone] => [7, c, BLACK]),
      ...[3, 4, 5, 6].map((c): [number, number, Stone] => [9, c, WHITE]),
    ]);
    // Black to move: finishing its own five beats blocking white's.
    expect([at(7, 2), at(7, 7)]).toContain(botMove(candidates(board, BLACK)).index);
    // White has only three: it must block one end of black's four.
    const defend = boardWith([...[3, 4, 5, 6].map((c): [number, number, Stone] => [7, c, BLACK]), [7, 2, WHITE], [9, 4, WHITE], [9, 5, WHITE]]);
    const move = botMove(candidates(defend, WHITE));
    expect(move.index).toBe(at(7, 7));
    expect(describeCandidate(move).urgency).toBe('forced: block or lose');
  });

  it('takes an immediate win over a block, however many fives that block stops', () => {
    // White wins at E15. Black's two fours cross at L10, and has a third four that finishes at E3.
    // Scored as a sum, blocking two fives at once outbid winning, and white lost a won game.
    const board = boardWith([
      ...run([0, 1, 2, 3], 0, 0, WHITE),
      ...run([6, 7, 8, 9], 5, 0, BLACK),
      [5, 5, WHITE],
      ...[6, 7, 8, 9].map((r): [number, number, Stone] => [r, 10, BLACK]),
      [10, 10, WHITE],
      ...run([0, 1, 2, 3], 12, 0, BLACK),
    ]);
    expect(cellId(at(0, 4))).toBe('E15');
    const move = bestMove(board, WHITE, candidates(board, WHITE, 20), () => 0);
    expect(move.index).toBe(at(0, 4));
    board[move.index] = WHITE;
    expect(winningLine(board, move.index)).not.toBeNull();
  });

  it('plays a forced win ahead of a defence it does not owe', () => {
    // H8 is a double four for white, so white wins next turn whatever black does. Blocking black's
    // open three at D3 scored higher, so the bot used to defend instead of winning.
    const board = boardWith([
      ...run([0, 1, 2], 7, 4, WHITE),
      [7, 3, BLACK],
      ...[4, 5, 6].map((r): [number, number, Stone] => [r, 7, WHITE]),
      [3, 7, BLACK],
      ...run([0, 1, 2], 12, 4, BLACK),
    ]);
    expect(bestMove(board, WHITE, candidates(board, WHITE, 20), () => 0).index).toBe(at(7, 7));
  });

  it('finds a win by continuous fours that no single move shows', () => {
    const board = boardWith([
      ...([[1, 10], [2, 12], [3, 10], [5, 14], [6, 9], [7, 10], [7, 12], [11, 0]] as [number, number][]).map(([r, c]): [number, number, Stone] => [r, c, BLACK]),
      ...([[2, 11], [3, 12], [4, 11], [4, 13], [5, 10], [5, 12], [6, 11]] as [number, number][]).map(([r, c]): [number, number, Stone] => [r, c, WHITE]),
    ]);
    // Nothing here wins on its own: the one-ply ranking plays a double threat black can answer.
    const plain = botMove(candidates(board, WHITE, 20), () => 0);
    expect(urgencyRank(plain)).toBeGreaterThanOrEqual(4);
    // Every white move is a four, so black's reply is forced; five arrives before the chain ends.
    let won = false;
    for (let ply = 0; ply < 8 && !won; ply++) {
      const move = bestMove(board, WHITE, candidates(board, WHITE, 20), () => 0);
      board[move.index] = WHITE;
      if (winningLine(board, move.index)) {
        won = true;
        break;
      }
      const blocks = [...Array(225).keys()].filter((i) => {
        if (board[i]) return false;
        board[i] = WHITE;
        const five = winningLine(board, i) !== null;
        board[i] = 0;
        return five;
      });
      // Two ways to five is an open four: black can only stop one, so the win is already there.
      if (blocks.length >= 2) {
        won = true;
        break;
      }
      expect(blocks, 'white must keep black on a single forced reply').toHaveLength(1);
      board[blocks[0]] = BLACK;
    }
    expect(won).toBe(true);
  });

  it('never prunes a winning move, a forced block or a fork out of the offered list', () => {
    // Many stones scattered far apart make a long candidate list; the block sits at the far edge.
    const stones: [number, number, Stone][] = [0, 1, 2, 3].map((c) => [14, c, BLACK]);
    for (let r = 1; r < 12; r += 2) for (let c = 5; c < 15; c += 2) stones.push([r, c, (r + c) % 4 === 0 ? BLACK : WHITE]);
    const board = boardWith(stones);
    const list = candidates(board, WHITE, 8);
    expect(list.some((c) => c.index === at(14, 4))).toBe(true);
    // Every cell where either side wins now or forks is on offer, however short the limit.
    const offered = new Set(list.map((c) => c.index));
    for (let i = 0; i < 225; i++) {
      if (board[i]) continue;
      const mine = evaluateCell(board, i, WHITE);
      const theirs = evaluateCell(board, i, BLACK);
      if (mine.best === 'five' || theirs.best === 'five' || mine.threats >= 2 || theirs.threats >= 2) {
        expect(offered, `${cellId(i)} must be offered`).toContain(i);
      }
    }
  });

  it('offers a choice of openings on an empty board, all of them near the centre', () => {
    const list = candidates(emptyGomokuBoard(), BLACK);
    expect(list).toHaveLength(9);
    expect(list.map((c) => c.index).sort((a, b) => a - b)).toEqual([...OPENING].sort((a, b) => a - b));
    expect(list.map((c) => c.index)).toContain(at(7, 7));
    for (const c of list) expect(Math.max(Math.abs(Math.floor(c.index / 15) - 7), Math.abs((c.index % 15) - 7))).toBeLessThanOrEqual(2);
  });

  it('ranks by what a move forces before it looks at the score', () => {
    const board = boardWith([...run([0, 1, 2, 3], 7, 3, BLACK), [9, 4, WHITE], [9, 5, WHITE]]);
    const list = candidates(board, WHITE);
    const block = list.find((c) => c.index === at(7, 7))!;
    expect(urgencyRank(block)).toBe(1);
    expect(list.every((c) => c.index === at(7, 2) || c.index === at(7, 7) || urgencyRank(c) > 1)).toBe(true);
  });

  it('offers options by board position, not by score, to models and to code alike', () => {
    const board = boardWith([[7, 7, BLACK], [7, 8, WHITE], [8, 8, BLACK]]);
    const list = candidates(board, WHITE);
    const req = buildGomokuRequest(board, WHITE, list, 4, [at(7, 7), at(7, 8), at(8, 8)]);
    const indexes = req.options.map((o) => parseCellId(o.id)!);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes)).toEqual(new Set(list.map((c) => c.index)));
    expect(req.state.you_are).toBe('O (white)');
    // The data a generated algorithm gets is in the same order, so options[0] is not the bot's move.
    const dataIndexes = req.data.options.map((o) => parseCellId(o.id)!);
    expect(dataIndexes).toEqual(indexes);
    expect(req.data.state.lastMove).toBe('J7');
    expect(req.data.state.moveHistory).toEqual(['H8', 'J8', 'J7']);
  });

  it('puts the decisive facts on every option, not only the shape names', () => {
    const board = boardWith([...run([0, 1, 2, 3], 7, 3, BLACK), [9, 4, WHITE], [9, 5, WHITE]]);
    const list = candidates(board, WHITE);
    const req = buildGomokuRequest(board, WHITE, list, 6, [at(7, 3)]);
    const block = req.data.options.find((o) => o.id === cellId(at(7, 7)))!;
    expect(block.facts.opponentWinsHereNext).toBe(true);
    expect(block.facts.winsNow).toBe(false);
    const quiet = req.data.options.find((o) => o.facts.makes === 'none');
    if (quiet) expect(quiet.facts.forcing).toBe(false);
  });
});

describe('gomoku match', () => {
  const scripted = (name: string, pick: (req: DecisionRequest) => string | null, delayMs = 0): Player => ({
    config: { kind: 'bot' },
    name,
    short: name,
    emoji: '',
    color: '',
    decide: async (req): Promise<Decision> => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { optionId: pick(req), latencyMs: 1, inputTokens: 0, outputTokens: 0, cost: 0, note: 'scripted' };
    },
  });
  const human = (): Player => ({
    config: { kind: 'human' },
    name: 'you',
    short: 'you',
    emoji: '',
    color: '',
    decide: () => Promise.reject(new Error('a human seat reads input from the game')),
  });
  const options = { candidateLimit: 20, minMoveMs: 0, moveLimitMs: 0 };
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it('plays bot against an always-invalid player to a finish, falling back instead of stalling', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    const broken = scripted('broken', () => 'Z99');
    const match = new GomokuMatch([bot, broken], options);
    match.start();
    await expect.poll(() => match.status, { timeout: 10_000, interval: 20 }).toBe('done');
    expect(match.result?.winner).not.toBeUndefined();
    expect(match.seats[1].stats.invalid).toBe(match.seats[1].moves);
    expect(match.history.length).toBeGreaterThanOrEqual(9);
    if (match.result?.winner !== null) expect(match.winLine?.length).toBeGreaterThanOrEqual(5);
  });

  it('gives up on a seat that never answers and lets the bot play for it', async () => {
    const slow = scripted('slow', (req) => req.botChoice(), 5_000);
    const bot = scripted('bot', (req) => req.botChoice());
    const match = new GomokuMatch([slow, bot], { ...options, moveLimitMs: 30 });
    match.start();
    await expect.poll(() => match.history.length >= 2, { timeout: 5_000, interval: 10 }).toBe(true);
    match.stop();
    expect(match.seats[0].stats.missed).toBeGreaterThan(0);
    // A missed deadline is not an invalid answer: nothing was answered at all.
    expect(match.seats[0].stats.invalid).toBe(0);
    expect(match.seats[0].moves).toBeGreaterThan(0);
  });

  it('does not place a stone once the match is over', async () => {
    const match = new GomokuMatch([human(), scripted('bot', (req) => req.botChoice())], options);
    for (const c of [3, 4, 5, 6]) match.board[at(7, c)] = BLACK;
    match.start();
    await settle();
    expect(match.awaitingHuman).toBe(true);
    // A click and a Stop landing in the same tick: the click must not outlive the match.
    match.click(at(7, 7));
    match.stop();
    await settle();
    await settle();
    expect(match.history).toEqual([]);
    expect(match.board[at(7, 7)]).toBe(0);
    expect(match.winLine).toBeNull();
    expect(match.result?.stopped).toBe(true);
  });

  it('takes back a person\'s move together with the machine reply that followed it', async () => {
    const match = new GomokuMatch([human(), scripted('bot', (req) => req.botChoice())], options);
    match.start();
    await settle();
    expect(match.canUndo).toBe(false);
    match.click(at(7, 7));
    await expect.poll(() => match.history.length, { timeout: 5_000, interval: 10 }).toBe(2);
    expect(match.canUndo).toBe(true);
    match.undo();
    await settle();
    expect(match.history).toEqual([]);
    expect(match.board[at(7, 7)]).toBe(0);
    expect(match.seats[0].moves).toBe(0);
    expect(match.seats[1].moves).toBe(0);
    expect(match.canUndo).toBe(false);
    // Still the person's turn, and a new stone still lands.
    expect(match.awaitingHuman).toBe(true);
    match.click(at(6, 6));
    await expect.poll(() => match.history.length, { timeout: 5_000, interval: 10 }).toBe(2);
    expect(match.history[0]).toBe(at(6, 6));
    match.stop();
  });

  it('does not spend a model call on a turn with nothing to choose', async () => {
    let calls = 0;
    const counted = scripted('counted', (req) => {
      calls += 1;
      return req.botChoice();
    });
    const match = new GomokuMatch([counted, scripted('bot', (req) => req.botChoice())], { ...options, candidateLimit: 20 });
    // One empty cell left, so the seat to move has exactly one option.
    for (let i = 0; i < 225; i++) match.board[i] = i === at(7, 7) ? 0 : i % 2 === 0 ? BLACK : WHITE;
    match.history = Array.from({ length: 224 }, (_, i) => (i < at(7, 7) ? i : i + 1));
    match.start();
    await expect.poll(() => match.status, { timeout: 5_000, interval: 10 }).toBe('done');
    expect(calls).toBe(0);
    expect(match.board[at(7, 7)]).not.toBe(0);
  });
});
