// Pure 2048 engine. No DOM, no network.
//
// A 4x4 board of tile values (0 = empty), row by row. As everywhere in this project, code finds
// the legal moves, plays each one out and describes the result; a player only picks a direction.

export const N = 4;
export const CELLS = N * N;
export type Dir = 'up' | 'right' | 'down' | 'left';
export const DIRS: readonly Dir[] = ['up', 'right', 'down', 'left'];
export type Board = number[];

export const emptyBoard = (): Board => new Array<number>(CELLS).fill(0);

/** The four lines a move slides along, each listed from the wall the tiles slide towards. */
const LINES: Record<Dir, number[][]> = (() => {
  const rows = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => r * N + c));
  const cols = [0, 1, 2, 3].map((c) => [0, 1, 2, 3].map((r) => r * N + c));
  return { left: rows, right: rows.map((l) => [...l].reverse()), up: cols, down: cols.map((l) => [...l].reverse()) };
})();

/** One tile's journey during a move. Two tiles with the same `to` and `merged` fuse there. */
export interface Slide {
  from: number;
  to: number;
  value: number;
  merged: boolean;
}

export interface MoveResult {
  board: Board;
  /** Points scored: the sum of the tiles created by merging. */
  gained: number;
  merges: number;
  /** False when nothing moved: the move is illegal. */
  moved: boolean;
  slides: Slide[];
}

export function slide(board: Board, dir: Dir): MoveResult {
  const next = emptyBoard();
  const slides: Slide[] = [];
  let gained = 0;
  let merges = 0;
  let moved = false;
  for (const line of LINES[dir]) {
    let target = 0; // next free slot in this line
    let last = -1; // slot of the last tile placed, if it may still merge
    for (const from of line) {
      const value = board[from];
      if (!value) continue;
      if (last >= 0 && next[line[last]] === value) {
        const to = line[last];
        next[to] = value * 2;
        gained += value * 2;
        merges += 1;
        // The tile that was already there fuses too.
        const partner = slides.find((s) => s.to === to && !s.merged);
        if (partner) partner.merged = true;
        slides.push({ from, to, value, merged: true });
        last = -1; // a tile merges once per move
        moved = true;
      } else {
        const to = line[target];
        next[to] = value;
        slides.push({ from, to, value, merged: false });
        last = target;
        target += 1;
        if (to !== from) moved = true;
      }
    }
  }
  return { board: next, gained, merges, moved, slides };
}

export const emptyCells = (board: Board): number[] => board.flatMap((v, i) => (v ? [] : [i]));
export const maxTile = (board: Board): number => Math.max(...board);
export const legalDirs = (board: Board): Dir[] => DIRS.filter((d) => slide(board, d).moved);

/** A new tile on a random empty cell: a 2 nine times in ten, otherwise a 4. */
export function spawn(board: Board, random: () => number): { board: Board; index: number; value: number } | null {
  const free = emptyCells(board);
  if (free.length === 0) return null;
  const index = free[Math.floor(random() * free.length)];
  const value = random() < 0.9 ? 2 : 4;
  const next = board.slice();
  next[index] = value;
  return { board: next, index, value };
}

export function startBoard(random: () => number): Board {
  let board = emptyBoard();
  for (let i = 0; i < 2; i++) board = spawn(board, random)!.board;
  return board;
}

// ---- Evaluation -----------------------------------------------------------------------------------

const CORNERS = [0, N - 1, CELLS - N, CELLS - 1];
const log2 = (v: number) => (v ? Math.log2(v) : 0);

/**
 * How well ordered the board is, 0 to 1: the share of neighbouring pairs, along rows and columns,
 * that run in the board's dominant direction. A snake of descending tiles scores high.
 */
export function orderliness(board: Board): number {
  let best = 0;
  for (const horizontal of [LINES.left, LINES.right]) {
    for (const vertical of [LINES.up, LINES.down]) {
      let ordered = 0;
      let pairs = 0;
      for (const line of [...horizontal, ...vertical]) {
        for (let i = 0; i < N - 1; i++) {
          const a = board[line[i]];
          const b = board[line[i + 1]];
          if (!a && !b) continue;
          pairs += 1;
          if (a >= b) ordered += 1;
        }
      }
      best = Math.max(best, pairs ? ordered / pairs : 1);
    }
  }
  return best;
}

/** Neighbouring equal tiles: merges waiting to happen. */
export function mergeablePairs(board: Board): number {
  let pairs = 0;
  for (const line of [...LINES.left, ...LINES.up]) for (let i = 0; i < N - 1; i++) if (board[line[i]] && board[line[i]] === board[line[i + 1]]) pairs += 1;
  return pairs;
}

export const maxInCorner = (board: Board): boolean => CORNERS.some((c) => board[c] === maxTile(board));

/** The hand-tuned score the classic bot searches with. */
export function evaluate(board: Board): number {
  const empty = emptyCells(board).length;
  if (empty === 0 && legalDirs(board).length === 0) return -1e6;
  return empty * 2.7 + orderliness(board) * 10 + mergeablePairs(board) * 1.2 + (maxInCorner(board) ? log2(maxTile(board)) * 1.5 : 0);
}

/**
 * Expectimax: the bot's move maximises, the random tile averages. To stay fast the chance layer
 * looks at up to `width` empty cells (the ones that hurt most tend to be near the big tiles, but
 * any sample is fine at this depth) and weighs a 2 at 0.9 and a 4 at 0.1.
 */
function expectimax(board: Board, depth: number, width: number): number {
  if (depth === 0) return evaluate(board);
  let best = -Infinity;
  for (const dir of DIRS) {
    const result = slide(board, dir);
    if (!result.moved) continue;
    const free = emptyCells(result.board);
    const sample = free.length <= width ? free : free.filter((_, i) => i % Math.ceil(free.length / width) === 0);
    let total = 0;
    for (const index of sample) {
      for (const [value, weight] of [[2, 0.9], [4, 0.1]] as const) {
        const after = result.board.slice();
        after[index] = value;
        total += weight * expectimax(after, depth - 1, width);
      }
    }
    best = Math.max(best, result.gained * 0.05 + (sample.length ? total / sample.length : evaluate(result.board)));
  }
  return best === -Infinity ? evaluate(board) : best;
}

/** How wide the chance layer inside the search is. */
const WIDTH = 4;

/**
 * How deep to search, by how much room is left. A new tile can land on any empty cell, so an open
 * board branches far too widely to go deep, while a crowded one — which is where the game is
 * actually decided — is cheap. Over twelve games this second ply is worth about a sixth more score
 * and takes the bot to 2048 seven times out of twelve rather than five, for 4 ms a move.
 *
 * The depth comes off the position and never off a clock, so the bot stays a pure function of the
 * board: one seed is one game, however busy the page happens to be.
 */
export function searchDepth(free: number): number {
  return free >= 5 ? 1 : 2;
}

/** The best direction with the inner search at `depth`. The first chance layer sees every empty cell. */
function bestAtDepth(board: Board, depth: number): Dir {
  let bestDir: Dir = legalDirs(board)[0] ?? 'left';
  let best = -Infinity;
  for (const dir of DIRS) {
    const result = slide(board, dir);
    if (!result.moved) continue;
    const free = emptyCells(result.board);
    let total = 0;
    for (const index of free) {
      for (const [value, weight] of [[2, 0.9], [4, 0.1]] as const) {
        const after = result.board.slice();
        after[index] = value;
        total += weight * expectimax(after, depth, WIDTH);
      }
    }
    const score = result.gained * 0.05 + (free.length ? total / free.length : evaluate(result.board));
    if (score > best) {
      best = score;
      bestDir = dir;
    }
  }
  return bestDir;
}

/** The classic bot: expectimax over the hand-tuned evaluation, as deep as the board allows. */
export function botMove(board: Board, depth = searchDepth(emptyCells(board).length)): Dir {
  return bestAtDepth(board, depth);
}

// ---- Descriptions ---------------------------------------------------------------------------------

export interface MoveFacts {
  dir: Dir;
  result: MoveResult;
  emptyAfter: number;
  maxAfter: number;
  cornerBefore: boolean;
  cornerAfter: boolean;
  orderAfter: number;
  pairsAfter: number;
  /** Directions still playable after this move, before the new tile lands. */
  movesAfter: number;
}

export function analyze(board: Board): MoveFacts[] {
  const cornerBefore = maxInCorner(board);
  return DIRS.flatMap((dir): MoveFacts[] => {
    const result = slide(board, dir);
    if (!result.moved) return [];
    return [
      {
        dir,
        result,
        emptyAfter: emptyCells(result.board).length,
        maxAfter: maxTile(result.board),
        cornerBefore,
        cornerAfter: maxInCorner(result.board),
        orderAfter: orderliness(result.board),
        pairsAfter: mergeablePairs(result.board),
        movesAfter: legalDirs(result.board).length,
      },
    ];
  });
}

function describeOrder(order: number): string {
  if (order >= 0.9) return 'tiles run in neat descending order';
  if (order >= 0.75) return 'mostly ordered';
  if (order >= 0.6) return 'somewhat scrambled';
  return 'scrambled: big and small tiles are mixed';
}

/** Same field names on every option so a model can compare them directly. */
export function describeMove(f: MoveFacts): Record<string, string> {
  const corner = f.cornerAfter ? `${f.maxAfter} sits in a corner` : f.cornerBefore ? `PULLS the largest tile (${f.maxAfter}) OUT of its corner` : `${f.maxAfter} is not in a corner`;
  return {
    merges: f.result.merges === 0 ? 'no merges' : `${f.result.merges} merge${f.result.merges > 1 ? 's' : ''}, scores ${f.result.gained} points`,
    empty_cells_after: `${f.emptyAfter} of 16`,
    largest_tile: corner,
    order_after: describeOrder(f.orderAfter),
    merges_available_next: f.pairsAfter === 0 ? 'none lined up' : `${f.pairsAfter} equal pair${f.pairsAfter > 1 ? 's' : ''} lined up`,
    room_to_move_after: f.movesAfter <= 1 ? `only ${f.movesAfter} direction left: DANGER` : `${f.movesAfter} directions`,
  };
}

/** Rows top to bottom, tiles padded so the columns line up; "." is an empty cell. */
export function boardToText(board: Board): string[] {
  const rows: string[] = [];
  for (let r = 0; r < N; r++) rows.push(board.slice(r * N, r * N + N).map((v) => String(v || '.').padStart(5, ' ')).join(''));
  return rows;
}
