// Pure Gomoku (五子棋) engine. No DOM, no network.
//
// Freestyle rules: 15x15, black moves first, five or more in a row wins. As in Tetris, code owns
// the game: it finds the moves worth considering, names the shape each one makes or blocks, and a
// player only picks one. 225 cells is too many to describe, so the offered list is pruned — but
// every winning move, every forced block and every fork on either side is always in it, so
// pruning never decides a game.

export const SIZE = 15;
export const CELLS = SIZE * SIZE;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export type Stone = typeof BLACK | typeof WHITE;
export type GomokuBoard = Uint8Array;

const DIRECTIONS: [number, number][] = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diagonal ↘
  [1, -1], // diagonal ↙
];

const COLS = 'ABCDEFGHJKLMNOP'; // no I, as on a real board

export const emptyGomokuBoard = (): GomokuBoard => new Uint8Array(CELLS);
export const other = (s: Stone): Stone => (s === BLACK ? WHITE : BLACK);
export const at = (row: number, col: number) => row * SIZE + col;
const inside = (row: number, col: number) => row >= 0 && row < SIZE && col >= 0 && col < SIZE;

/** "H8" is the centre. Columns are letters left to right, rows are numbered from the bottom. */
export function cellId(index: number): string {
  return `${COLS[index % SIZE]}${SIZE - Math.floor(index / SIZE)}`;
}

export function parseCellId(id: string): number | null {
  const m = /^([A-HJ-P])(\d{1,2})$/.exec(id.trim().toUpperCase());
  if (!m) return null;
  const col = COLS.indexOf(m[1]);
  const row = SIZE - Number(m[2]);
  return inside(row, col) ? at(row, col) : null;
}

/** The five (or more) cells of a win through `index`, or null. */
export function winningLine(board: GomokuBoard, index: number): number[] | null {
  const stone = board[index];
  if (!stone) return null;
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  for (const [dr, dc] of DIRECTIONS) {
    const line = [index];
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (inside(r, c) && board[at(r, c)] === stone) {
        line.push(at(r, c));
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

// ---- Shapes -------------------------------------------------------------------------------------

export type Shape = 'five' | 'open_four' | 'double_four' | 'four' | 'open_three' | 'three' | 'open_two' | 'two' | 'none';

const SHAPE_VALUE: Record<Shape, number> = {
  five: 1_000_000,
  open_four: 100_000,
  // Two fours at once: only one of them can be blocked, so it wins exactly as an open four does.
  double_four: 100_000,
  four: 10_000,
  open_three: 5_000,
  three: 500,
  open_two: 200,
  two: 40,
  none: 0,
};

const SHAPE_RANK: Shape[] = ['five', 'open_four', 'double_four', 'four', 'open_three', 'three', 'open_two', 'two', 'none'];

/** Shapes that force an answer: leave one alone and the game is decided. */
export const FORCING: Shape[] = ['five', 'open_four', 'double_four', 'four', 'open_three'];
export const isForcing = (shape: Shape): boolean => FORCING.includes(shape);

/** Distinct empty cells of `line` that would complete a five through its middle. */
function countFinishers(line: number[]): number {
  const seen = new Set<number>();
  for (let start = 0; start <= 4; start++) {
    let own = 0;
    let gap = -1;
    let blocked = false;
    for (let k = start; k < start + 5; k++) {
      if (line[k] === -1) {
        blocked = true;
        break;
      }
      if (line[k] === 1) own += 1;
      else gap = k;
    }
    if (!blocked && own === 4) seen.add(gap);
  }
  return seen.size;
}

/**
 * The shape `stone` would have along one direction after playing at (row, col).
 *
 * Looks at every five-cell window through the cell that holds no enemy stone: a window with all
 * five is a win; the number of distinct empty cells that would complete a window of four says
 * whether a four is open (two ways to finish, cannot be blocked) or simple (one way). Counting
 * windows rather than runs means split shapes such as XX_X are seen too.
 *
 * Below a four the question is instead "what does one more stone here buy?", because two
 * three-windows made by stones that never combine look like a live three but can only ever reach
 * a blocked four.
 */
function shapeAlong(board: GomokuBoard, row: number, col: number, dr: number, dc: number, stone: Stone): Shape {
  // line[4] is the cell itself. -1 = off board or enemy, 1 = own, 0 = empty.
  const line: number[] = [];
  for (let k = -4; k <= 4; k++) {
    const r = row + dr * k;
    const c = col + dc * k;
    if (k === 0) line.push(1);
    else if (!inside(r, c)) line.push(-1);
    else {
      const v = board[at(r, c)];
      line.push(v === stone ? 1 : v === EMPTY ? 0 : -1);
    }
  }
  const finishers = new Set<number>();
  let threes = 0;
  let twos = 0;
  for (let start = 0; start <= 4; start++) {
    let own = 0;
    let blocked = false;
    let gap = -1;
    for (let k = start; k < start + 5; k++) {
      if (line[k] === -1) blocked = true;
      else if (line[k] === 1) own += 1;
      else gap = k;
    }
    if (blocked) continue;
    if (own === 5) return 'five';
    if (own === 4) finishers.add(gap);
    else if (own === 3) threes += 1;
    else if (own === 2) twos += 1;
  }
  if (finishers.size >= 2) return 'open_four';
  if (finishers.size === 1) return 'four';
  if (threes >= 1) {
    let best: Shape = 'none';
    for (let q = 0; q < line.length; q++) {
      if (line[q] !== 0) continue;
      line[q] = 1;
      const ways = countFinishers(line);
      line[q] = 0;
      // Two ways to finish after one more stone is an open four, so the three is live.
      if (ways >= 2) return 'open_three';
      if (ways === 1) best = 'three';
    }
    if (best !== 'none') return best;
  }
  if (twos >= 3) return 'open_two';
  if (twos >= 1) return 'two';
  return 'none';
}

export interface CellEval {
  /** Best shape across the four directions. */
  best: Shape;
  /** Sum of all four directions, so a double threat outranks a single one. */
  score: number;
  /** Directions that make a four or an open three: two or more is a fork. */
  threats: number;
}

export function evaluateCell(board: GomokuBoard, index: number, stone: Stone): CellEval {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  let best: Shape = 'none';
  let score = 0;
  let threats = 0;
  let fours = 0;
  for (const [dr, dc] of DIRECTIONS) {
    const shape = shapeAlong(board, row, col, dr, dc, stone);
    score += SHAPE_VALUE[shape];
    if (SHAPE_RANK.indexOf(shape) < SHAPE_RANK.indexOf(best)) best = shape;
    if (shape === 'open_four' || shape === 'four') fours += 1;
    if (shape === 'open_four' || shape === 'four' || shape === 'open_three') threats += 1;
  }
  if (best === 'four' && fours >= 2) {
    // A four in two directions wins next turn: the opponent can only block one of them.
    best = 'double_four';
    score += SHAPE_VALUE.double_four - SHAPE_VALUE.four * 2;
  } else if (threats >= 2 && best !== 'five' && best !== 'open_four') {
    // Two forcing lines at once cannot both be answered.
    score += SHAPE_VALUE.open_four / 2;
  }
  return { best, score, threats };
}

// ---- Candidates ---------------------------------------------------------------------------------

export interface Candidate {
  index: number;
  id: string;
  attack: CellEval;
  defense: CellEval;
  /** What the classic bot maximises. */
  score: number;
}

/**
 * Black's first move: the centre, or one of the eight points two steps from it. All nine are
 * sound openings, and offering them is what keeps two matches from starting the same way.
 */
export const OPENING: number[] = [];
for (let dr = -2; dr <= 2; dr += 2) for (let dc = -2; dc <= 2; dc += 2) OPENING.push(at(7 + dr, 7 + dc));

/** Empty cells within two steps of any stone; the opening points on an empty board. */
function neighbourhood(board: GomokuBoard): number[] {
  const near = new Set<number>();
  let stones = 0;
  for (let i = 0; i < CELLS; i++) {
    if (!board[i]) continue;
    stones += 1;
    const row = Math.floor(i / SIZE);
    const col = i % SIZE;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (inside(r, c) && !board[at(r, c)]) near.add(at(r, c));
      }
    }
  }
  if (stones === 0) return [...OPENING];
  return [...near];
}

const FORCED: Shape[] = ['five', 'open_four', 'double_four', 'four'];

/** Never pruned: it wins, it stops a loss, or it makes or stops a fork. */
function mustOffer(c: Candidate): boolean {
  return FORCED.includes(c.attack.best) || FORCED.includes(c.defense.best) || c.attack.threats >= 2 || c.defense.threats >= 2;
}

/**
 * The moves worth offering, best first. Attack counts slightly more than defense so that with
 * equal shapes the mover presses its own advantage. Anything that wins, that stops the opponent
 * from winning, or that makes or stops a fork is kept no matter how long the list gets.
 */
export function candidates(board: GomokuBoard, stone: Stone, limit = 20): Candidate[] {
  const all = neighbourhood(board).map((index): Candidate => {
    const attack = evaluateCell(board, index, stone);
    const defense = evaluateCell(board, index, other(stone));
    return { index, id: cellId(index), attack, defense, score: attack.score + defense.score * 0.9 };
  });
  all.sort((a, b) => b.score - a.score || a.index - b.index);
  const kept = all.slice(0, limit);
  for (const c of all.slice(limit)) {
    if (mustOffer(c)) kept.push(c);
  }
  return kept;
}

// ---- The bot ---------------------------------------------------------------------------------

/**
 * How urgent a move is, lowest first: win now, stop an immediate loss, make a four that cannot be
 * blocked, stop theirs, fork, stop theirs. Below that, score decides. Ranking before scoring is
 * what stops a big sum of small shapes from outbidding a move that simply wins.
 */
export function urgencyRank(c: Candidate): number {
  const unstoppable = (s: Shape) => s === 'open_four' || s === 'double_four';
  if (c.attack.best === 'five') return 0;
  if (c.defense.best === 'five') return 1;
  if (unstoppable(c.attack.best)) return 2;
  if (unstoppable(c.defense.best)) return 3;
  if (c.attack.threats >= 2) return 4;
  if (c.defense.threats >= 2) return 5;
  return 6;
}

/** The classic bot's ranking: the forcing ladder first, then score. `random` breaks exact ties. */
export function botMove(list: Candidate[], random: () => number = Math.random): Candidate {
  let rank = urgencyRank(list[0]);
  let score = list[0].score;
  for (const c of list) {
    const r = urgencyRank(c);
    if (r < rank || (r === rank && c.score > score)) {
      rank = r;
      score = c.score;
    }
  }
  const ties = list.filter((c) => urgencyRank(c) === rank && c.score === score);
  return ties[Math.floor(random() * ties.length)];
}

/** How far the forced-win search looks, in plies, and how long it may take. */
const VCF_DEPTH = 8;
const VCF_MS = 80;

/** Cheaper than `evaluateCell` when all the search needs to know is "does this make five?". */
function makesFive(board: GomokuBoard, index: number, stone: Stone): boolean {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  for (const [dr, dc] of DIRECTIONS) {
    let run = 1;
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (inside(r, c) && board[at(r, c)] === stone) {
        run += 1;
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (run >= 5) return true;
  }
  return false;
}

const fiveCells = (board: GomokuBoard, cells: number[], stone: Stone): number[] => cells.filter((i) => makesFive(board, i, stone));

/**
 * Victory by continuous fours: every move in the chain makes a four, so the reply is forced and
 * there is nothing to search wide. Returns the first move of a forced win, or null. `board` is a
 * scratch copy and is left as it was found; `deadline` keeps the whole search off the frame budget.
 */
function vcf(board: GomokuBoard, stone: Stone, depth: number, deadline: number): number | null {
  if (depth <= 0 || performance.now() > deadline) return null;
  const cells = neighbourhood(board);
  const mine = fiveCells(board, cells, stone);
  if (mine.length) return mine[0];
  // With a five of their own on the board they can ignore our four, so nothing is forced any more.
  if (fiveCells(board, cells, other(stone)).length) return null;
  const fours: number[] = [];
  for (const i of cells) {
    const shape = evaluateCell(board, i, stone).best;
    if (shape === 'open_four' || shape === 'double_four') return i;
    if (shape === 'four') fours.push(i);
  }
  for (const i of fours) {
    if (performance.now() > deadline) return null;
    board[i] = stone;
    const reply = fiveCells(board, neighbourhood(board), stone)[0];
    let won = false;
    if (reply !== undefined) {
      board[reply] = other(stone);
      // Their only move is the block; it must not happen to be a five for them.
      won = winningLine(board, reply) === null && vcf(board, stone, depth - 1, deadline) !== null;
      board[reply] = EMPTY;
    }
    board[i] = EMPTY;
    if (won) return i;
  }
  return null;
}

/**
 * The classic bot: a forced win when the short search finds one, otherwise the best-ranked move.
 * Nothing is searched when the move at hand is already forced either way, so the common case is
 * as fast as it ever was.
 */
export function bestMove(board: GomokuBoard, stone: Stone, list: Candidate[], random: () => number = Math.random, budgetMs = VCF_MS): Candidate {
  const pick = botMove(list, random);
  if (budgetMs <= 0 || urgencyRank(pick) <= 2) return pick;
  const found = vcf(board.slice(), stone, VCF_DEPTH, performance.now() + budgetMs);
  return (found !== null && list.find((c) => c.index === found)) || pick;
}

// ---- Descriptions ---------------------------------------------------------------------------------

const MAKES: Record<Shape, string> = {
  five: 'five in a row: wins the game now',
  open_four: 'an open four: cannot be blocked, wins next turn',
  double_four: 'a four in two directions at once: only one can be blocked, wins next turn',
  four: 'a four: opponent must block it next turn',
  open_three: 'an open three: becomes an open four unless blocked',
  three: 'a three with one end blocked',
  open_two: 'an open two',
  two: 'a two',
  none: 'nothing yet',
};

const BLOCKS: Record<Shape, string> = {
  five: "opponent's five: opponent wins next turn unless you play here",
  open_four: "opponent's open four in the making: they are about to get an unstoppable four",
  double_four: "opponent's double four in the making: two fours at once, only one can be blocked",
  four: "opponent's four in the making",
  open_three: "opponent's open three in the making",
  three: "a minor opponent three",
  open_two: "a minor opponent two",
  two: 'nothing important',
  none: 'nothing',
};

function urgency(c: Candidate): string {
  const rank = urgencyRank(c);
  if (rank === 0) return 'winning move';
  if (rank === 1) return 'forced: block or lose';
  if (rank === 2) return 'decisive attack';
  if (rank === 3) return 'urgent defense';
  if (rank === 4) return 'double threat: opponent cannot block both';
  if (rank === 5) return "stops opponent's double threat";
  if (c.attack.best === 'four' || c.attack.best === 'open_three') return 'forcing attack';
  if (c.defense.best === 'four' || c.defense.best === 'open_three') return 'useful defense';
  return 'quiet move';
}

/** Same field names on every option so a model can compare them directly. */
export function describeCandidate(c: Candidate): Record<string, string> {
  return { makes: MAKES[c.attack.best], blocks: BLOCKS[c.defense.best], urgency: urgency(c) };
}

/** Rows top (15) to bottom (1), with coordinates, as a model reads it. */
export function gomokuBoardToText(board: GomokuBoard): string[] {
  const rows = [`   ${COLS.split('').join(' ')}`];
  for (let r = 0; r < SIZE; r++) {
    const cells: string[] = [];
    for (let c = 0; c < SIZE; c++) cells.push(board[at(r, c)] === BLACK ? 'X' : board[at(r, c)] === WHITE ? 'O' : '.');
    rows.push(`${String(SIZE - r).padStart(2, ' ')} ${cells.join(' ')}`);
  }
  return rows;
}
