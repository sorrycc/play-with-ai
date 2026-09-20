import { describe, expect, it } from 'vitest';
import type { Decision, DecisionRequest, Player } from '../src/core/types';
import {
  BLACK,
  WHITE,
  at,
  botMove,
  candidates,
  cellId,
  describeCandidate,
  emptyGomokuBoard,
  evaluateCell,
  parseCellId,
  winningLine,
  type Stone,
} from '../src/games/gomoku/engine';
import { GomokuMatch, buildGomokuRequest } from '../src/games/gomoku/match';

function boardWith(stones: [row: number, col: number, stone: Stone][]) {
  const board = emptyGomokuBoard();
  for (const [r, c, s] of stones) board[at(r, c)] = s;
  return board;
}

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

  it('never prunes a winning move or a forced block out of the offered list', () => {
    // Many stones scattered far apart make a long candidate list; the block sits at the far edge.
    const stones: [number, number, Stone][] = [0, 1, 2, 3].map((c) => [14, c, BLACK]);
    for (let r = 1; r < 12; r += 2) for (let c = 5; c < 15; c += 2) stones.push([r, c, (r + c) % 4 === 0 ? BLACK : WHITE]);
    const list = candidates(boardWith(stones), WHITE, 8);
    expect(list.some((c) => c.index === at(14, 4))).toBe(true);
  });

  it('offers options by board position, not by score', () => {
    const board = boardWith([[7, 7, BLACK], [7, 8, WHITE], [8, 8, BLACK]]);
    const list = candidates(board, WHITE);
    const req = buildGomokuRequest(board, WHITE, list, 4, 'J7');
    const indexes = req.options.map((o) => parseCellId(o.id)!);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes)).toEqual(new Set(list.map((c) => c.index)));
    expect(req.state.you_are).toBe('O (white)');
  });
});

describe('gomoku match', () => {
  const scripted = (name: string, pick: (req: DecisionRequest) => string | null): Player => ({
    config: { kind: 'bot' },
    name,
    short: name,
    emoji: '',
    color: '',
    decide: async (req): Promise<Decision> => ({ optionId: pick(req), latencyMs: 1, inputTokens: 0, outputTokens: 0, cost: 0, note: 'scripted' }),
  });

  it('plays bot against an always-invalid player to a finish, falling back instead of stalling', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    const broken = scripted('broken', () => 'Z99');
    const match = new GomokuMatch([bot, broken], { candidateLimit: 20, minMoveMs: 0 });
    match.start();
    await expect.poll(() => match.status, { timeout: 10_000, interval: 20 }).toBe('done');
    expect(match.result?.winner).not.toBeUndefined();
    expect(match.seats[1].stats.invalid).toBe(match.seats[1].moves);
    expect(match.history.length).toBeGreaterThanOrEqual(9);
    if (match.result?.winner !== null) expect(match.winLine?.length).toBeGreaterThanOrEqual(5);
  });
});
