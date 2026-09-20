// Pure two-snake engine. No DOM, no network. The single-snake rules, the move facts and the flood
// fill follow jev-snake (src/game/engine.ts, analysis.ts); the duel on one shared board is new.
//
// Both snakes move at the same instant. A head that leaves the arena, or lands on any body cell
// after the step, dies; two heads landing on one cell both die. A snake that dies never moves: it
// stays exactly where it was, so its whole body — tail included — is still in the way of the other
// head on that same step. As everywhere in this project, code computes exact facts about each legal
// move and a player only picks a direction.
//
// Late in a match the walls close in (`shrinkDuel`), so two careful snakes cannot circle forever.

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
  /** The cell the head was entering when it died, so the arena can draw the crash. */
  deathAt: Point | null;
  eaten: number;
}

export interface DuelState {
  cols: number;
  rows: number;
  snakes: [Snake, Snake];
  /** null once the arena is full. */
  food: Point | null;
  steps: number;
  /** How many rings the walls have closed in by; 0 is the full grid. */
  margin: number;
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

/** The smallest arena the walls may close in to: still room for two snakes to pass each other. */
const MIN_ARENA = 8;

export const samePoint = (a: Point, b: Point) => a.r === b.r && a.c === b.c;
export const inBounds = (p: Point, cols: number, rows: number) => p.r >= 0 && p.r < rows && p.c >= 0 && p.c < cols;
export const move = (p: Point, dir: Dir): Point => ({ r: p.r + DELTA[dir].r, c: p.c + DELTA[dir].c });

/** The playable part of the grid: the full board until the walls start closing in. */
export interface Arena {
  cols: number;
  rows: number;
  margin: number;
}

export const inArena = (p: Point, a: Arena) => p.r >= a.margin && p.r < a.rows - a.margin && p.c >= a.margin && p.c < a.cols - a.margin;
export const arenaCells = (a: Arena) => Math.max(0, a.rows - 2 * a.margin) * Math.max(0, a.cols - 2 * a.margin);
/** True once the arena is as small as it is allowed to get. */
export const fullyClosed = (a: Arena) => a.rows - 2 * (a.margin + 1) < MIN_ARENA || a.cols - 2 * (a.margin + 1) < MIN_ARENA;

/** mulberry32 with explicit state, so a state plus its moves replays exactly. */
export function nextRandom(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) | 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

function placeFood(snakes: Snake[], arena: Arena, rngState: number): [Point | null, number] {
  const taken = new Set<number>();
  for (const s of snakes) for (const p of s.body) taken.add(p.r * arena.cols + p.c);
  const free: Point[] = [];
  for (let r = arena.margin; r < arena.rows - arena.margin; r++)
    for (let c = arena.margin; c < arena.cols - arena.margin; c++) if (!taken.has(r * arena.cols + c)) free.push({ r, c });
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
  const fresh = (body: Point[], heading: Dir): Snake => ({ body, heading, alive: true, death: null, deathAt: null, eaten: 0 });
  const snakes: [Snake, Snake] = [fresh(a, 'right'), fresh(b, 'left')];
  const [food, rngState] = placeFood(snakes, { cols, rows, margin: 0 }, options.seed ?? 1);
  return { cols, rows, snakes, food, steps: 0, margin: 0, rngState };
}

/**
 * Advance one step with both moves applied at once. A 180° turn is ignored (the snake keeps its
 * heading), and a dead snake ignores its move and stays on the board as an obstacle. Pure.
 *
 * Deaths are resolved to a fixed point: a snake that dies never moved, so its tail did not vacate
 * either, which can in turn kill the other snake. Two rounds always settle it — a snake only ever
 * changes from alive to dead — but the loop is written for any number of rounds.
 */
export function stepDuel(state: DuelState, requested: [Dir, Dir]): DuelState {
  const { cols, rows, margin, food } = state;
  const arena = { cols, rows, margin };
  const planned = state.snakes.map((s, i) => {
    if (!s.alive) return { snake: s, head: null as Point | null, eats: false, heading: s.heading };
    const heading = requested[i] === OPPOSITE[s.heading] ? s.heading : requested[i];
    const head = move(s.body[0], heading);
    return { snake: s, head, eats: food !== null && samePoint(head, food), heading };
  });

  // Two heads entering one cell is decided first and on its own: both die wherever they were going.
  const bothHeads = planned[0].head && planned[1].head;
  const headOn = bothHeads && inArena(planned[0].head!, arena) && samePoint(planned[0].head!, planned[1].head!);
  const deaths: [Death | null, Death | null] = headOn ? ['head_on', 'head_on'] : [null, null];

  // Where every body will be after the step; a tail cell is vacated unless that snake grows or dies.
  const project = (i: 0 | 1) => {
    const p = planned[i];
    if (!p.head || deaths[i]) return p.snake.body;
    return [p.head, ...(p.eats ? p.snake.body : p.snake.body.slice(0, -1))];
  };
  let bodies = [project(0), project(1)];
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const i of [0, 1] as const) {
      const head = planned[i].head;
      if (!head || deaths[i]) continue;
      const death: Death | null = !inArena(head, arena)
        ? 'wall'
        : bodies[i].slice(1).some((q) => samePoint(q, head))
          ? 'self'
          : bodies[1 - i].some((q) => samePoint(q, head))
            ? 'other'
            : null;
      if (death) {
        deaths[i] = death;
        changed = true;
      }
    }
    if (!changed) break;
    bodies = [project(0), project(1)];
  }

  const snakes = planned.map((p, i): Snake => {
    if (!p.head) return p.snake;
    // A snake that dies stays where it was: its head never enters the wall or the other body.
    if (deaths[i]) return { ...p.snake, heading: p.heading, alive: false, death: deaths[i], deathAt: p.head };
    return { ...p.snake, body: bodies[i], heading: p.heading, eaten: p.snake.eaten + (p.eats ? 1 : 0) };
  }) as [Snake, Snake];

  const ate = planned.some((p, i) => p.eats && !deaths[i]);
  if (!ate) return { ...state, snakes, steps: state.steps + 1 };
  const [nextFood, rngState] = placeFood(snakes, arena, state.rngState);
  return { ...state, snakes, food: nextFood, rngState, steps: state.steps + 1 };
}

/**
 * Close the walls in by one ring. A snake caught outside the new arena dies where it stands, and
 * food left outside is put back inside. Pure; the match decides when this happens.
 */
export function shrinkDuel(state: DuelState): DuelState {
  if (fullyClosed(state)) return state;
  const arena = { cols: state.cols, rows: state.rows, margin: state.margin + 1 };
  const snakes = state.snakes.map((s): Snake => {
    if (!s.alive || s.body.every((p) => inArena(p, arena))) return s;
    return { ...s, alive: false, death: 'wall', deathAt: s.body[0] };
  }) as [Snake, Snake];
  const next = { ...state, snakes, margin: arena.margin };
  if (state.food && inArena(state.food, arena)) return next;
  const [food, rngState] = placeFood(snakes, arena, state.rngState);
  return { ...next, food, rngState };
}

// ---- Facts about each move --------------------------------------------------------------------

export type Turn = 'straight' | 'left turn' | 'right turn';

export interface MoveFacts {
  dir: Dir;
  turn: Turn;
  target: Point;
  eats: boolean;
  /** Steps along the shortest open path from the new head to the food; null when there is none. */
  foodDistance: number | null;
  /** False when no open path to the food is left after this move (or there is no food). */
  foodReachable: boolean;
  /** Empty cells reachable from the new head after the move. */
  reachable: number;
  /** All empty cells in the arena after the move. */
  freeTotal: number;
  /** Empty cells this snake reaches before the opponent could: the room it owns. */
  territory: number;
  /** Less room than the snake is long, and no way to follow its own tail out. */
  deadEnd: boolean;
  canReachTail: boolean;
  /** The opponent's head could move into the same cell this step, which kills both. */
  headOnRisk: boolean;
  /** That head-on would still be won, because this snake would be the longer one. */
  headOnWins: boolean;
}

export function turnOf(heading: Dir, dir: Dir): Turn {
  if (dir === heading) return 'straight';
  return CLOCKWISE[heading] === dir ? 'right turn' : 'left turn';
}

/** Steps from `start` to every empty cell reachable from it; `blocked` holds r*cols+c keys. */
export function distancesFrom(start: Point, blocked: ReadonlySet<number>, arena: Arena): Map<number, number> {
  const seen = new Map<number, number>();
  let edge: Point[] = [start];
  for (let d = 1; edge.length > 0; d++) {
    const next: Point[] = [];
    for (const p of edge) {
      for (const dir of DIRS) {
        const n = move(p, dir);
        if (!inArena(n, arena)) continue;
        const key = n.r * arena.cols + n.c;
        if (blocked.has(key) || seen.has(key)) continue;
        seen.set(key, d);
        next.push(n);
      }
    }
    edge = next;
  }
  return seen;
}

/** Flood fill over empty cells from `start`; `blocked` holds r*cols+c keys. */
export function floodFill(start: Point, blocked: ReadonlySet<number>, arena: Arena): Set<number> {
  return new Set(distancesFrom(start, blocked, arena).keys());
}

/** Could this snake eat on this very step? Used to know whether its tail is about to vacate. */
export function canEatNow(state: DuelState, who: 0 | 1): boolean {
  const s = state.snakes[who];
  if (!s.alive || !state.food) return false;
  return DIRS.some((d) => d !== OPPOSITE[s.heading] && samePoint(move(s.body[0], d), state.food!));
}

/**
 * What the opponent's body will still occupy after this step. Its tail cell counts as free when the
 * opponent cannot possibly eat on this step, because then it must move on. The one case this misses
 * is the opponent dying on this very step, which freezes its whole body: rare, and it hands the
 * match to the length rule rather than to the opponent.
 */
function opponentCells(state: DuelState, me: 0 | 1): Point[] {
  const other = state.snakes[1 - me];
  if (!other.alive || other.body.length < 2 || canEatNow(state, (1 - me) as 0 | 1)) return other.body;
  return other.body.slice(0, -1);
}

/** Would moving in `dir` certainly kill snake `me` on this step? (A head-on is a risk, not a certainty.) */
export function isFatal(state: DuelState, me: 0 | 1, dir: Dir): boolean {
  const snake = state.snakes[me];
  const target = move(snake.body[0], dir);
  if (!inArena(target, state)) return true;
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
  const { cols, rows, margin, food } = state;
  const arena = { cols, rows, margin };
  const snake = state.snakes[me];
  const opponent = state.snakes[1 - me];
  const target = move(snake.body[0], dir);
  const eats = food !== null && samePoint(target, food);
  const after = [target, ...(eats ? snake.body : snake.body.slice(0, -1))];
  const theirs = opponentCells(state, me);
  const blocked = new Set([...after, ...theirs].map((p) => p.r * cols + p.c));
  const mine = distancesFrom(target, blocked, arena);
  const foodKey = food ? food.r * cols + food.c : -1;
  const foodDistance = !food ? null : eats ? 0 : (mine.get(foodKey) ?? null);
  const tail = after[after.length - 1];
  const canReachTail = DIRS.some((d) => {
    const n = move(tail, d);
    return inArena(n, arena) && (samePoint(n, target) || mine.has(n.r * cols + n.c));
  });
  // Room this snake owns: cells it would reach before the opponent, both starting where they are.
  const hunt = opponent.alive ? distancesFrom(opponent.body[0], blocked, arena) : new Map<number, number>();
  let territory = 0;
  for (const [key, steps] of mine) if (steps < (hunt.get(key) ?? Infinity)) territory += 1;
  const headOnRisk =
    opponent.alive && DIRS.some((d) => d !== OPPOSITE[opponent.heading] && samePoint(move(opponent.body[0], d), target));
  return {
    dir,
    turn: turnOf(snake.heading, dir),
    target,
    eats,
    foodDistance,
    foodReachable: foodDistance !== null,
    reachable: mine.size,
    freeTotal: arenaCells(arena) - blocked.size,
    territory,
    deadEnd: mine.size < after.length && !canReachTail,
    canReachTail,
    headOnRisk,
    headOnWins: headOnRisk && after.length > opponent.body.length + (canEatNow(state, (1 - me) as 0 | 1) ? 1 : 0),
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
 * How a finished step turned out for snake `me`, best to worst. The length rule decides a match in
 * which both snakes die, so crashing head-on into a shorter snake is a win, not something to avoid.
 */
function outcomeFor(after: DuelState, me: 0 | 1): number {
  const mine = after.snakes[me];
  const theirs = after.snakes[1 - me];
  if (mine.alive && theirs.alive) return legalMoves(after, me).length === 0 ? -2 : 0;
  if (mine.alive) return 3;
  if (theirs.alive) return -3;
  return mine.body.length > theirs.body.length ? 2 : mine.body.length === theirs.body.length ? -1 : -3;
}

/**
 * The classic bot. It looks one step ahead for both snakes (every answer the opponent could give),
 * then goes by the facts: never a dead end, keep the room it owns, follow its own tail when the
 * food is walled off, and take the shortest way to the food only while there is room to spare.
 */
export function botMove(state: DuelState, me: 0 | 1, facts: MoveFacts[] = analyze(state, me)): Dir {
  const snake = state.snakes[me];
  if (facts.length === 0) return snake.heading;
  const other = state.snakes[1 - me];
  const replies = other.alive ? legalMoves(state, (1 - me) as 0 | 1) : [];
  const answers = replies.length > 0 ? replies : [other.heading];
  /** Far enough that no shortest way to the food can beat it. */
  const NO_FOOD = 1e6;
  const rank = (f: MoveFacts) => {
    let worst = 3;
    let total = 0;
    for (const reply of answers) {
      const pair: [Dir, Dir] = me === 0 ? [f.dir, reply] : [reply, f.dir];
      const value = outcomeFor(stepDuel(state, pair), me);
      worst = Math.min(worst, value);
      total += value;
    }
    const length = snake.body.length + (f.eats ? 1 : 0);
    // Length is what wins at the clock, so the food comes first — but never into a tight space.
    const chase = f.foodReachable && !f.deadEnd && f.reachable >= length + 2;
    return {
      // Every answer the opponent has leaves this snake alive and the other one not: simply take it.
      win: worst >= 2 ? 1 : 0,
      danger: (worst <= -2 ? 4 : 0) + (f.deadEnd ? 2 : 0) + (f.headOnRisk && !f.headOnWins ? 1 : 0),
      food: chase ? (f.foodDistance ?? 0) : NO_FOOD,
      territory: f.territory,
      reachable: f.reachable,
      worst,
      average: total / answers.length,
      dir: f.dir,
    };
  };
  const ranked = facts.map(rank).sort(
    (a, b) =>
      b.win - a.win ||
      a.danger - b.danger ||
      a.food - b.food ||
      b.territory - a.territory ||
      b.reachable - a.reachable ||
      b.worst - a.worst ||
      b.average - a.average,
  );
  return ranked[0].dir;
}

// ---- Descriptions -------------------------------------------------------------------------------

/** Same field names on every option so a model can compare them directly. */
export function describeMove(f: MoveFacts): Record<string, string> {
  return {
    move: `${f.turn}, head moves to row ${f.target.r} col ${f.target.c}`,
    food: f.eats ? 'EATS THE FOOD now' : f.foodReachable ? `the food is ${f.foodDistance} steps away along the shortest open path` : 'no open path to the food from there',
    room: `${f.reachable} of ${f.freeTotal} empty cells stay reachable, ${f.territory} of them before the opponent could get there`,
    escape: f.deadEnd
      ? 'DEAD END: less room than the snake is long and no way to follow the tail out'
      : f.canReachTail
        ? 'can still follow its own tail out'
        : 'open space',
    opponent: f.headOnWins
      ? "the opponent's head can move into this same cell; both would die, and you would win on length"
      : f.headOnRisk
        ? "RISK: the opponent's head can move into this same cell, and a head-on collision kills both"
        : 'the opponent cannot reach this cell on this step',
  };
}

export const SNAKE_LEGEND =
  'A = your head, a = your body, B = opponent head, b = opponent body, F = food, . = empty, # = wall. ' +
  'Row 0 is the top row, column 0 is the leftmost column. Leaving the arena hits a wall.';

/** The board as snake `me` sees it: it is always "A", whichever seat it has. */
export function duelToText(state: DuelState, me: 0 | 1): string[] {
  const grid: string[][] = Array.from({ length: state.rows }, (_row, r) =>
    Array.from({ length: state.cols }, (_cell, c) => (inArena({ r, c }, state) ? '.' : '#')),
  );
  if (state.food) grid[state.food.r][state.food.c] = 'F';
  ([1 - me, me] as const).forEach((i) => {
    const mine = i === me;
    state.snakes[i].body.forEach((p, k) => {
      grid[p.r][p.c] = k === 0 ? (mine ? 'A' : 'B') : mine ? 'a' : 'b';
    });
  });
  return grid.map((row) => row.join(''));
}
