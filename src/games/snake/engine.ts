// Pure two-snake engine. No DOM, no network. The single-snake rules, the move facts and the flood
// fill follow jev-snake (src/game/engine.ts, analysis.ts); the duel on one shared board is new.
//
// Both snakes move at the same instant. A head that leaves the grid, or lands on any body cell
// after the step, dies; two heads landing on one cell both die. As everywhere in this project,
// code computes exact facts about each legal move and a player only picks a direction.

export type Dir = 'up' | 'right' | 'down' | 'left';

export interface Point {
  r: number;
  c: number;
}

export type Death = 'wall' | 'self' | 'other' | 'head_on';

export interface Snake {
  /** Head first, tail last. */
  body: Point[];
  heading: Dir;
  alive: boolean;
  death: Death | null;
  eaten: number;
}

export interface DuelState {
  cols: number;
  rows: number;
  snakes: [Snake, Snake];
  /** null once the board is full. */
  food: Point | null;
  steps: number;
  rngState: number;
}

export const DIRS: readonly Dir[] = ['up', 'right', 'down', 'left'];

export const DELTA: Record<Dir, Point> = {
  up: { r: -1, c: 0 },
  down: { r: 1, c: 0 },
  left: { r: 0, c: -1 },
  right: { r: 0, c: 1 },
};

export const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
const CLOCKWISE: Record<Dir, Dir> = { up: 'right', right: 'down', down: 'left', left: 'up' };

export const samePoint = (a: Point, b: Point) => a.r === b.r && a.c === b.c;
export const inBounds = (p: Point, cols: number, rows: number) => p.r >= 0 && p.r < rows && p.c >= 0 && p.c < cols;
export const move = (p: Point, dir: Dir): Point => ({ r: p.r + DELTA[dir].r, c: p.c + DELTA[dir].c });

/** mulberry32 with explicit state, so a state plus its moves replays exactly. */
export function nextRandom(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) | 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

function placeFood(snakes: Snake[], cols: number, rows: number, rngState: number): [Point | null, number] {
  const taken = new Set<number>();
  for (const s of snakes) for (const p of s.body) taken.add(p.r * cols + p.c);
  const free: Point[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!taken.has(r * cols + c)) free.push({ r, c });
  if (free.length === 0) return [null, rngState];
  const [value, next] = nextRandom(rngState);
  return [free[Math.floor(value * free.length)], next];
}

export interface DuelOptions {
  cols?: number;
  rows?: number;
  seed?: number;
  length?: number;
}

/** Snake 0 starts on the left heading right, snake 1 on the right heading left, on different rows. */
export function createDuel(options: DuelOptions = {}): DuelState {
  const cols = options.cols ?? 20;
  const rows = options.rows ?? 16;
  const length = options.length ?? 3;
  const rowA = Math.floor(rows / 3);
  const rowB = rows - 1 - rowA;
  const a: Point[] = [];
  const b: Point[] = [];
  for (let i = 0; i < length; i++) {
    a.push({ r: rowA, c: length + 1 - i });
    b.push({ r: rowB, c: cols - 2 - length + i });
  }
  const fresh = (body: Point[], heading: Dir): Snake => ({ body, heading, alive: true, death: null, eaten: 0 });
  const snakes: [Snake, Snake] = [fresh(a, 'right'), fresh(b, 'left')];
  const [food, rngState] = placeFood(snakes, cols, rows, options.seed ?? 1);
  return { cols, rows, snakes, food, steps: 0, rngState };
}

/**
 * Advance one step with both moves applied at once. A 180° turn is ignored (the snake keeps its
 * heading), and a dead snake ignores its move and stays on the board as an obstacle. Pure.
 */
export function stepDuel(state: DuelState, requested: [Dir, Dir]): DuelState {
  const { cols, rows, food } = state;
  const planned = state.snakes.map((s, i) => {
    if (!s.alive) return { snake: s, head: null as Point | null, eats: false, heading: s.heading };
    const heading = requested[i] === OPPOSITE[s.heading] ? s.heading : requested[i];
    const head = move(s.body[0], heading);
    return { snake: s, head, eats: food !== null && samePoint(head, food), heading };
  });

  // Where every body will be after the step; a tail cell is vacated unless that snake grows.
  const bodies = planned.map((p) => (p.head ? [p.head, ...(p.eats ? p.snake.body : p.snake.body.slice(0, -1))] : p.snake.body));

  const deaths = planned.map((p, i): Death | null => {
    if (!p.head) return null;
    if (!inBounds(p.head, cols, rows)) return 'wall';
    const other = bodies[1 - i];
    if (planned[1 - i].head && samePoint(other[0], p.head)) return 'head_on';
    if (bodies[i].slice(1).some((q) => samePoint(q, p.head!))) return 'self';
    if (other.some((q) => samePoint(q, p.head!))) return 'other';
    return null;
  });

  const snakes = planned.map((p, i): Snake => {
    if (!p.head) return p.snake;
    // A snake that dies stays where it was: its head never enters the wall or the other body.
    if (deaths[i]) return { ...p.snake, heading: p.heading, alive: false, death: deaths[i] };
    return { ...p.snake, body: bodies[i], heading: p.heading, eaten: p.snake.eaten + (p.eats ? 1 : 0) };
  }) as [Snake, Snake];

  const ate = planned.some((p, i) => p.eats && !deaths[i]);
  if (!ate) return { ...state, snakes, steps: state.steps + 1 };
  const [nextFood, rngState] = placeFood(snakes, cols, rows, state.rngState);
  return { ...state, snakes, food: nextFood, rngState, steps: state.steps + 1 };
}

// ---- Facts about each move --------------------------------------------------------------------

export type Turn = 'straight' | 'left turn' | 'right turn';

export interface MoveFacts {
  dir: Dir;
  turn: Turn;
  target: Point;
  eats: boolean;
  /** Manhattan distance from the new head to the food; null when there is no food. */
  foodDistance: number | null;
  /** Empty cells reachable from the new head after the move. */
  reachable: number;
  /** All empty cells on the board after the move. */
  freeTotal: number;
  /** Less room than the snake is long, and no way to follow its own tail out. */
  deadEnd: boolean;
  canReachTail: boolean;
  /** The opponent's head could move into the same cell this step, which kills both. */
  headOnRisk: boolean;
}

export function turnOf(heading: Dir, dir: Dir): Turn {
  if (dir === heading) return 'straight';
  return CLOCKWISE[heading] === dir ? 'right turn' : 'left turn';
}

/** Flood fill over empty cells from `start`; `blocked` holds r*cols+c keys. */
export function floodFill(start: Point, blocked: ReadonlySet<number>, cols: number, rows: number): Set<number> {
  const seen = new Set<number>();
  const stack: Point[] = [start];
  while (stack.length > 0) {
    const p = stack.pop()!;
    for (const dir of DIRS) {
      const n = move(p, dir);
      if (!inBounds(n, cols, rows)) continue;
      const key = n.r * cols + n.c;
      if (blocked.has(key) || seen.has(key)) continue;
      seen.add(key);
      stack.push(n);
    }
  }
  return seen;
}

/**
 * What the opponent's body will certainly still occupy after this step. Its tail cell is kept:
 * it is vacated only if the opponent does not eat, and a move must not bet on that.
 */
function opponentCells(state: DuelState, me: 0 | 1): Point[] {
  return state.snakes[1 - me].body;
}

/** Would moving in `dir` certainly kill snake `me` on this step? (A head-on is a risk, not a certainty.) */
export function isFatal(state: DuelState, me: 0 | 1, dir: Dir): boolean {
  const snake = state.snakes[me];
  const target = move(snake.body[0], dir);
  if (!inBounds(target, state.cols, state.rows)) return true;
  const eats = state.food !== null && samePoint(target, state.food);
  const own = eats ? snake.body : snake.body.slice(0, -1);
  return own.some((p) => samePoint(p, target)) || opponentCells(state, me).some((p) => samePoint(p, target));
}

/** Directions that do not certainly kill the snake on this step (no 180° turns). */
export function legalMoves(state: DuelState, me: 0 | 1): Dir[] {
  const snake = state.snakes[me];
  return DIRS.filter((dir) => dir !== OPPOSITE[snake.heading] && !isFatal(state, me, dir));
}

export function analyzeMove(state: DuelState, me: 0 | 1, dir: Dir): MoveFacts {
  const { cols, rows, food } = state;
  const snake = state.snakes[me];
  const opponent = state.snakes[1 - me];
  const target = move(snake.body[0], dir);
  const eats = food !== null && samePoint(target, food);
  const after = [target, ...(eats ? snake.body : snake.body.slice(0, -1))];
  const blocked = new Set([...after, ...opponent.body].map((p) => p.r * cols + p.c));
  const region = floodFill(target, blocked, cols, rows);
  const tail = after[after.length - 1];
  const canReachTail = DIRS.some((d) => {
    const n = move(tail, d);
    return samePoint(n, target) || region.has(n.r * cols + n.c);
  });
  const headOnRisk =
    opponent.alive && DIRS.some((d) => d !== OPPOSITE[opponent.heading] && samePoint(move(opponent.body[0], d), target));
  return {
    dir,
    turn: turnOf(snake.heading, dir),
    target,
    eats,
    foodDistance: food ? Math.abs(food.r - target.r) + Math.abs(food.c - target.c) : null,
    reachable: region.size,
    freeTotal: cols * rows - blocked.size,
    deadEnd: region.size < after.length && !canReachTail,
    canReachTail,
    headOnRisk,
  };
}

export function analyze(state: DuelState, me: 0 | 1): MoveFacts[] {
  return legalMoves(state, me).map((dir) => analyzeMove(state, me, dir));
}

/** Played when no answer arrived in time: keep going straight if that is legal. */
export function fallbackMove(state: DuelState, me: 0 | 1): Dir {
  const legal = legalMoves(state, me);
  const heading = state.snakes[me].heading;
  if (legal.length === 0 || legal.includes(heading)) return heading;
  return legal[0];
}

/**
 * The classic bot: never a dead end or a head-on if there is another way, then the shortest way
 * to the food, then the most room.
 */
export function botMove(facts: MoveFacts[]): Dir {
  const danger = (f: MoveFacts) => (f.deadEnd ? 2 : 0) + (f.headOnRisk ? 1 : 0);
  const ranked = [...facts].sort(
    (a, b) =>
      danger(a) - danger(b) ||
      (a.deadEnd ? b.reachable - a.reachable : 0) ||
      (a.foodDistance ?? 0) - (b.foodDistance ?? 0) ||
      b.reachable - a.reachable,
  );
  return ranked[0].dir;
}

// ---- Descriptions -------------------------------------------------------------------------------

/** Same field names on every option so a model can compare them directly. */
export function describeMove(f: MoveFacts): Record<string, string> {
  return {
    move: `${f.turn}, head moves to row ${f.target.r} col ${f.target.c}`,
    food: f.eats ? 'EATS THE FOOD now' : `food is ${f.foodDistance ?? '?'} steps away after this move`,
    room: `${f.reachable} of ${f.freeTotal} empty cells stay reachable`,
    escape: f.deadEnd
      ? 'DEAD END: less room than the snake is long and no way to follow the tail out'
      : f.canReachTail
        ? 'can still follow its own tail out'
        : 'open space',
    opponent: f.headOnRisk ? "RISK: the opponent's head can move into this same cell, and a head-on collision kills both" : 'the opponent cannot reach this cell on this step',
  };
}

export const SNAKE_LEGEND =
  'A = your head, a = your body, B = opponent head, b = opponent body, F = food, . = empty. ' +
  'Row 0 is the top row, column 0 is the leftmost column. Leaving the grid hits a wall.';

/** The board as snake `me` sees it: it is always "A", whichever seat it has. */
export function duelToText(state: DuelState, me: 0 | 1): string[] {
  const grid = Array.from({ length: state.rows }, () => Array<string>(state.cols).fill('.'));
  if (state.food) grid[state.food.r][state.food.c] = 'F';
  ([1 - me, me] as const).forEach((i) => {
    const mine = i === me;
    state.snakes[i].body.forEach((p, k) => {
      grid[p.r][p.c] = k === 0 ? (mine ? 'A' : 'B') : mine ? 'a' : 'b';
    });
  });
  return grid.map((row) => row.join(''));
}
