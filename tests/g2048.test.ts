import { describe, expect, it } from 'vitest';
import type { Decision, DecisionRequest, Player } from '../src/core/types';
import { seededRandom } from '../src/core/types';
import { analyze, boardToText, botMove, describeMove, emptyCells, legalDirs, maxInCorner, orderliness, slide, spawn, startBoard, type Board } from '../src/games/g2048/engine';
import { Match2048, build2048Request } from '../src/games/g2048/match';

const rows = (...r: number[][]): Board => r.flat();

describe('2048 engine', () => {
  it('slides and merges each tile at most once per move', () => {
    expect(slide(rows([2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), 'left').board.slice(0, 4)).toEqual([4, 4, 0, 0]);
    expect(slide(rows([2, 2, 4, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), 'left').board.slice(0, 4)).toEqual([4, 4, 0, 0]);
    expect(slide(rows([4, 2, 2, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), 'right').board.slice(0, 4)).toEqual([0, 0, 4, 4]);
    const up = slide(rows([2, 0, 0, 0], [2, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]), 'up');
    expect([up.board[0], up.board[4], up.board[8]]).toEqual([4, 8, 0]);
    expect(up.gained).toBe(12);
    expect(up.merges).toBe(2);
  });

  it('reports every tile\'s journey, with both halves of a merge marked', () => {
    const { slides } = slide(rows([2, 0, 2, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), 'left');
    expect(slides).toEqual([
      { from: 0, to: 0, value: 2, merged: true },
      { from: 2, to: 0, value: 2, merged: true },
      { from: 3, to: 1, value: 4, merged: false },
    ]);
  });

  it('calls a move that changes nothing illegal', () => {
    const board = rows([2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
    expect(slide(board, 'left').moved).toBe(false);
    // A full row of different tiles cannot slide sideways at all.
    expect(legalDirs(board)).toEqual(['down']);
    const locked = rows([2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]);
    expect(legalDirs(locked)).toEqual([]);
    expect(analyze(locked)).toEqual([]);
  });

  it('spawns on an empty cell, the same way for the same seed', () => {
    const a = startBoard(seededRandom(9));
    expect(a.filter(Boolean)).toHaveLength(2);
    expect(startBoard(seededRandom(9))).toEqual(a);
    const full = rows([2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]);
    expect(spawn(full, seededRandom(1))).toBeNull();
    const next = spawn(a, seededRandom(3))!;
    expect(a[next.index]).toBe(0);
    expect([2, 4]).toContain(next.value);
  });

  it('describes what a move does to the corner, the order and the room left', () => {
    const board = rows([0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0], [512, 64, 8, 2]);
    expect(maxInCorner(board)).toBe(true);
    expect(orderliness(board)).toBeGreaterThan(0.9);
    const facts = analyze(board);
    const up = describeMove(facts.find((f) => f.dir === 'up')!);
    expect(up.largest_tile).toMatch(/^PULLS the largest tile \(512\) OUT/);
    const right = facts.find((f) => f.dir === 'right')!;
    expect(describeMove(right).largest_tile).toBe('512 sits in a corner');
    expect(botMove(board)).not.toBe('up');
    const fields = Object.keys(up);
    for (const f of facts) expect(Object.keys(describeMove(f))).toEqual(fields);
    expect(boardToText(board)[3]).toBe('  512   64    8    2');
  });

  it('builds a request whose options are exactly the legal directions', () => {
    const board = rows([2, 4, 8, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
    const req = build2048Request(board, 0, analyze(board));
    expect(req.options.map((o) => o.id).sort()).toEqual(['down', 'right']);
    expect(['down', 'right']).toContain(req.botChoice());
  });

  it('the bot plays a whole game to a respectable tile', () => {
    const random = seededRandom(11);
    let board = startBoard(random);
    let moves = 0;
    while (legalDirs(board).length && moves < 3000) {
      board = spawn(slide(board, botMove(board)).board, random)!.board;
      moves += 1;
    }
    expect(Math.max(...board)).toBeGreaterThanOrEqual(512);
    expect(emptyCells(board).length).toBeLessThan(16);
  }, 60_000);
});

describe('2048 match', () => {
  const scripted = (name: string, pick: (req: DecisionRequest) => string | null): Player => ({
    config: { kind: 'bot' },
    name,
    short: name,
    emoji: '',
    color: '',
    decide: async (req): Promise<Decision> => ({ optionId: pick(req), latencyMs: 1, inputTokens: 0, outputTokens: 0, cost: 0, note: 'scripted' }),
  });

  it('both sides start from the same board, and the better player wins once both are stuck', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    // Always the first legal direction: it locks up early.
    const naive = scripted('naive', (req) => req.options[0].id);
    const match = new Match2048([naive, bot], { seed: 5, timeLimitSec: 0, minMoveMs: 0 });
    expect(match.sides[0].board).toEqual(match.sides[1].board);
    match.start();
    await expect.poll(() => match.status, { timeout: 60_000, interval: 25 }).toBe('done');
    expect(match.result?.winner).toBe(1);
    expect(match.sides[1].score).toBeGreaterThan(match.sides[0].score);
    expect(match.sides[0].over).toBe(true);
    // Tiles on screen always match the board.
    for (const side of match.sides) {
      const live = side.tiles.filter((tile) => !tile.dying);
      expect(live).toHaveLength(side.board.filter(Boolean).length);
      for (const tile of live) expect(side.board[tile.index]).toBe(tile.value);
    }
  }, 90_000);

  it('an invalid answer falls back to the bot instead of stalling', async () => {
    const broken = scripted('broken', () => 'diagonal');
    const bot = scripted('bot', (req) => req.botChoice());
    const match = new Match2048([broken, bot], { seed: 5, timeLimitSec: 0, minMoveMs: 0 });
    match.start();
    await expect.poll(() => match.sides[0].moves, { timeout: 30_000, interval: 10 }).toBeGreaterThanOrEqual(20);
    match.stop();
    expect(match.sides[0].stats.invalid).toBe(match.sides[0].stats.calls);
    expect(match.result?.stopped).toBe(true);
  }, 60_000);
});
