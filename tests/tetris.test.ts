import { describe, expect, it } from 'vitest';
import { seededRandom } from '../src/core/types';
import {
  HEIGHT,
  WIDTH,
  addGarbage,
  bestByHeuristic,
  clearLines,
  countHoles,
  describePlacement,
  emptyBoard,
  enumeratePlacements,
  makeBag,
  type Board,
} from '../src/games/tetris/engine';
import { buildTetrisRequest } from '../src/games/tetris/match';

/** Fills the bottom row except the listed columns. */
function bottomRowWithGaps(gaps: number[]): Board {
  const board = emptyBoard();
  for (let x = 0; x < WIDTH; x++) if (!gaps.includes(x)) board[HEIGHT - 1][x] = 'G';
  return board;
}

describe('tetris engine', () => {
  it('enumerates every distinct placement on an empty board', () => {
    expect(enumeratePlacements(emptyBoard(), 'O')).toHaveLength(9);
    expect(enumeratePlacements(emptyBoard(), 'I')).toHaveLength(7 + 10);
    expect(enumeratePlacements(emptyBoard(), 'T')).toHaveLength(8 + 9 + 8 + 9);
    const ids = enumeratePlacements(emptyBoard(), 'T').map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('clears a full row and shifts the stack down', () => {
    const board = bottomRowWithGaps([]);
    board[HEIGHT - 2][0] = 'T';
    const { board: after, cleared, rows } = clearLines(board);
    expect(cleared).toBe(1);
    expect(rows).toEqual([HEIGHT - 1]);
    expect(after[HEIGHT - 1][0]).toBe('T');
    expect(after).toHaveLength(HEIGHT);
  });

  it('finds the placement that completes a line, and the heuristic prefers it', () => {
    const board = bottomRowWithGaps([3, 4, 5, 6]);
    const placements = enumeratePlacements(board, 'I');
    const clearing = placements.filter((p) => p.linesCleared === 1);
    expect(clearing).toHaveLength(1);
    expect(bestByHeuristic(placements).id).toBe(clearing[0].id);
    expect(describePlacement(clearing[0])).toMatchObject({ lines_cleared: 'one line', holes_created: 'none', where: 'columns 4-7' });
  });

  it('counts a covered empty cell as a hole', () => {
    const board = emptyBoard();
    board[HEIGHT - 2][0] = 'T';
    expect(countHoles(board)).toBe(1);
  });

  it('pushes garbage in from the bottom and reports overflow', () => {
    const { board, overflow } = addGarbage(emptyBoard(), 2, 4);
    expect(overflow).toBe(false);
    expect(board[HEIGHT - 1].filter((c) => c === null)).toHaveLength(1);
    expect(board[HEIGHT - 1][4]).toBeNull();
    expect(board[HEIGHT - 3].every((c) => c === null)).toBe(true);

    const tall = emptyBoard();
    tall[0][0] = 'I';
    expect(addGarbage(tall, 1, 0).overflow).toBe(true);
  });

  it('gives both sides the same piece sequence for one seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect(makeBag(a)).toEqual(makeBag(b));
    expect(makeBag(seededRandom(42))).not.toEqual(makeBag(seededRandom(43)));
    expect(makeBag(a).slice().sort()).toEqual(['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
  });

  it('builds a request with one described option per placement', () => {
    const board = bottomRowWithGaps([3, 4, 5, 6]);
    const placements = enumeratePlacements(board, 'I');
    const req = buildTetrisRequest({ board, current: 'I', next: 'T', lines: 0 }, placements, true);
    expect(req.options.map((o) => o.id)).toEqual(placements.map((p) => p.id));
    const fields = Object.keys(req.options[0].description);
    for (const o of req.options) expect(Object.keys(o.description)).toEqual(fields);
    expect(placements.find((p) => p.id === req.botChoice())?.linesCleared).toBe(1);
    expect((req.state.board_rows_top_to_bottom as string[])[HEIGHT - 1]).toBe('###....###');
  });
});
