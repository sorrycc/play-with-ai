// Pure Tetris engine. No DOM, no network. Ported from trungdq88/jev-tetris (public/tetris.js).
//
// Code owns everything deterministic here: piece geometry, collision, line clears, enumerating
// every legal placement and describing each outcome. A player only picks between placements.

export const WIDTH = 10;
export const HEIGHT = 20;
export const SPAWN_X = 3;

export type PieceName = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
export type Cell = PieceName | 'G' | null;
export type Board = Cell[][];
type XY = [number, number];

// Each piece: rotation states in clockwise order; each state is [x, y] cells, y growing downwards.
const RAW_PIECES: Record<PieceName, XY[][]> = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
  ],
  O: [[[0, 0], [1, 0], [0, 1], [1, 1]]],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
};

export const PIECE_NAMES = Object.keys(RAW_PIECES) as PieceName[];

export const PIECE_COLORS: Record<PieceName, string> = {
  I: '#38d6f5',
  O: '#ffd23f',
  T: '#b56bff',
  S: '#4ee08a',
  Z: '#ff5d73',
  J: '#5b8cff',
  L: '#ff9f40',
};

export interface PieceState {
  cells: XY[];
  width: number;
  height: number;
}

// Normalise every rotation so its bounding box starts at (0,0) and record its size.
export const PIECES = Object.fromEntries(
  Object.entries(RAW_PIECES).map(([name, states]) => [
    name,
    states.map((cells): PieceState => {
      const minX = Math.min(...cells.map((c) => c[0]));
      const minY = Math.min(...cells.map((c) => c[1]));
      const norm = cells.map(([x, y]): XY => [x - minX, y - minY]);
      return {
        cells: norm,
        width: Math.max(...norm.map((c) => c[0])) + 1,
        height: Math.max(...norm.map((c) => c[1])) + 1,
      };
    }),
  ]),
) as Record<PieceName, PieceState[]>;

export function emptyBoard(): Board {
  return Array.from({ length: HEIGHT }, () => new Array<Cell>(WIDTH).fill(null));
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

export function collides(board: Board, cells: XY[], x: number, y: number): boolean {
  for (const [cx, cy] of cells) {
    const bx = x + cx;
    const by = y + cy;
    if (bx < 0 || bx >= WIDTH || by >= HEIGHT) return true;
    if (by >= 0 && board[by][bx]) return true;
  }
  return false;
}

/** The y at which the piece rests when dropped from `y` straight down. */
export function dropY(board: Board, cells: XY[], x: number, y: number): number {
  let cur = y;
  while (!collides(board, cells, x, cur + 1)) cur += 1;
  return cur;
}

export function lockPiece(board: Board, piece: PieceName, rotation: number, x: number, y: number): Board {
  const next = cloneBoard(board);
  for (const [cx, cy] of PIECES[piece][rotation].cells) {
    const by = y + cy;
    if (by >= 0) next[by][x + cx] = piece;
  }
  return next;
}

/** Removes full rows. `rows` are the indexes removed. */
export function clearLines(board: Board): { board: Board; cleared: number; rows: number[] } {
  const rows: number[] = [];
  const kept: Board = [];
  board.forEach((row, i) => {
    if (row.every((c) => c)) rows.push(i);
    else kept.push(row.slice());
  });
  while (kept.length < HEIGHT) kept.unshift(new Array<Cell>(WIDTH).fill(null));
  return { board: kept, cleared: rows.length, rows };
}

export function columnHeights(board: Board): number[] {
  const heights = new Array<number>(WIDTH).fill(0);
  for (let x = 0; x < WIDTH; x++) {
    for (let y = 0; y < HEIGHT; y++) {
      if (board[y][x]) {
        heights[x] = HEIGHT - y;
        break;
      }
    }
  }
  return heights;
}

/** A hole is an empty cell with at least one filled cell above it in its column. */
export function countHoles(board: Board): number {
  let holes = 0;
  for (let x = 0; x < WIDTH; x++) {
    let covered = false;
    for (let y = 0; y < HEIGHT; y++) {
      if (board[y][x]) covered = true;
      else if (covered) holes += 1;
    }
  }
  return holes;
}

export function bumpiness(heights: number[]): number {
  let total = 0;
  for (let x = 0; x < heights.length - 1; x++) total += Math.abs(heights[x] - heights[x + 1]);
  return total;
}

export interface Well {
  column: number;
  depth: number;
}

/** Columns at least `depth` lower than both neighbours (walls count as tall). */
export function wells(heights: number[], depth = 3): Well[] {
  const found: Well[] = [];
  for (let x = 0; x < heights.length; x++) {
    const left = x === 0 ? Infinity : heights[x - 1];
    const right = x === heights.length - 1 ? Infinity : heights[x + 1];
    const d = Math.min(left, right) - heights[x];
    if (d >= depth) found.push({ column: x, depth: d });
  }
  return found;
}

export interface BoardStats {
  heights: number[];
  maxHeight: number;
  aggregateHeight: number;
  holes: number;
  bumpiness: number;
  wells: Well[];
}

export function boardStats(board: Board): BoardStats {
  const heights = columnHeights(board);
  return {
    heights,
    maxHeight: Math.max(...heights),
    aggregateHeight: heights.reduce((a, b) => a + b, 0),
    holes: countHoles(board),
    bumpiness: bumpiness(heights),
    wells: wells(heights),
  };
}

export interface Placement {
  id: string;
  piece: PieceName;
  rotation: number;
  x: number;
  y: number;
  cells: XY[];
  linesCleared: number;
  clearedRows: number[];
  holesCreated: number;
  holesRemoved: number;
  heightDelta: number;
  before: BoardStats;
  after: BoardStats;
  afterBoard: Board;
  /** Classic hand-tuned linear evaluation; the `bot` role plays the highest. */
  heuristic: number;
}

export function heuristicScore(p: Pick<Placement, 'after' | 'linesCleared'>): number {
  const s = p.after;
  return -0.51 * s.aggregateHeight + 0.76 * p.linesCleared - 0.36 * s.holes - 0.18 * s.bumpiness;
}

/**
 * Every reachable (rotation, x) for `piece` on `board`. A placement is reachable when the piece
 * fits at the spawn row and can drop straight down.
 */
export function enumeratePlacements(board: Board, piece: PieceName): Placement[] {
  const before = boardStats(board);
  const seen = new Set<string>();
  const placements: Placement[] = [];
  PIECES[piece].forEach((state, rotation) => {
    for (let x = 0; x <= WIDTH - state.width; x++) {
      if (collides(board, state.cells, x, 0)) continue;
      const y = dropY(board, state.cells, x, 0);
      const locked = lockPiece(board, piece, rotation, x, y);
      const key = locked.map((r) => r.map((c) => (c ? '#' : '.')).join('')).join('/');
      if (seen.has(key)) continue; // identical outcome from another rotation (O, I, S, Z)
      seen.add(key);
      const { board: after, cleared, rows } = clearLines(locked);
      const stats = boardStats(after);
      const outcome: Placement = {
        id: `p${placements.length}`,
        piece,
        rotation,
        x,
        y,
        cells: state.cells.map(([cx, cy]): XY => [x + cx, y + cy]),
        linesCleared: cleared,
        clearedRows: rows,
        holesCreated: Math.max(0, stats.holes - before.holes),
        holesRemoved: Math.max(0, before.holes - stats.holes),
        heightDelta: stats.maxHeight - before.maxHeight,
        before,
        after: stats,
        afterBoard: after,
        heuristic: 0,
      };
      outcome.heuristic = heuristicScore(outcome);
      placements.push(outcome);
    }
  });
  return placements;
}

export function bestByHeuristic(placements: Placement[]): Placement {
  return placements.reduce((best, p) => (p.heuristic > best.heuristic ? p : best));
}

// ---- Descriptions ---------------------------------------------------------------------------
// Models read text better than they do arithmetic. Every feature becomes a short named bucket so
// the model compares situations rather than computing them.

export function describeLines(n: number): string {
  return ['none', 'one line', 'two lines', 'three lines', 'four lines (a Tetris)'][n] ?? `${n} lines`;
}

export function describeHoles(n: number): string {
  if (n === 0) return 'none';
  if (n === 1) return 'one hole';
  if (n === 2) return 'two holes';
  return 'three or more holes';
}

export function describeHeight(maxHeight: number): string {
  if (maxHeight <= 4) return 'very low';
  if (maxHeight <= 8) return 'low';
  if (maxHeight <= 12) return 'medium';
  if (maxHeight <= 15) return 'high';
  return 'dangerously high, close to the top';
}

export function describeSurface(bump: number): string {
  if (bump <= 4) return 'flat';
  if (bump <= 9) return 'slightly uneven';
  if (bump <= 16) return 'bumpy';
  return 'very jagged';
}

export function describeWells(list: Well[]): string {
  if (list.length === 0) return 'no deep wells';
  if (list.length === 1) return `one deep well at column ${list[0].column + 1}`;
  return `${list.length} deep wells`;
}

export function describeWhere(p: Placement): string {
  const xs = p.cells.map((c) => c[0]);
  const left = Math.min(...xs) + 1;
  const right = Math.max(...xs) + 1;
  return left === right ? `column ${left}` : `columns ${left}-${right}`;
}

function describeHeightChange(p: Placement): string {
  const d = p.heightDelta;
  if (p.linesCleared > 0 && d < 0) return 'stack gets lower';
  if (d <= 0) return 'stack does not get taller';
  if (d === 1) return 'stack grows by one row';
  return 'stack grows by several rows';
}

/** Same field names on every option so a model can compare them directly. */
export function describePlacement(p: Placement): Record<string, string> {
  return {
    where: describeWhere(p),
    lines_cleared: describeLines(p.linesCleared),
    holes_created: describeHoles(p.holesCreated),
    holes_uncovered: p.holesRemoved > 0 ? describeHoles(p.holesRemoved) : 'none',
    stack_height_after: describeHeight(p.after.maxHeight),
    height_change: describeHeightChange(p),
    surface_after: describeSurface(p.after.bumpiness),
    wells_after: describeWells(p.after.wells),
  };
}

export function boardToText(board: Board): string[] {
  return board.map((row) => row.map((c) => (c ? '#' : '.')).join(''));
}

// ---- Garbage (versus mode) --------------------------------------------------------------------

export const GARBAGE = 'G' as const;

/**
 * Pushes `count` garbage rows in from the bottom, each full except one gap. `overflow` is true
 * when the shift pushed filled cells out of the top, which ends the receiving player's game.
 */
export function addGarbage(board: Board, count: number, gapColumn: number): { board: Board; overflow: boolean } {
  if (count <= 0) return { board, overflow: false };
  const n = Math.min(count, HEIGHT);
  let overflow = false;
  for (let y = 0; y < n; y++) if (board[y].some((c) => c)) overflow = true;
  const rows = board.slice(n).map((r) => r.slice());
  for (let i = 0; i < n; i++) {
    const row = new Array<Cell>(WIDTH).fill(GARBAGE);
    row[gapColumn] = null;
    rows.push(row);
  }
  return { board: rows, overflow };
}

// ---- Random bag ---------------------------------------------------------------------------------

export function makeBag(random: () => number = Math.random): PieceName[] {
  const bag = PIECE_NAMES.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

export function scoreForLines(lines: number, level: number): number {
  return [0, 100, 300, 500, 800][lines] * level;
}
