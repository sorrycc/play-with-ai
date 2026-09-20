// A two-sided real-time Tetris match. No DOM: the arena component draws `sides` every frame and
// forwards key presses to `input()`. Ported from jev-tetris (arena.js + play.js), with one
// change: a person is just another seat, so any pairing of roles works.
//
// When a piece spawns the player is asked at once, and gravity pulls the piece down while it
// thinks. If the piece lands before the answer arrives it locks where it is: a missed deadline.
// The answer is still recorded when it turns up, because it was paid for either way.

import type { MoveOption, Player, PlayerStats, DecisionRequest } from '../../core/types';
import { freshStats, recordDecision, seededRandom, sleep, formatClock } from '../../core/types';
import { t } from '../../core/i18n';
import {
  type Board,
  type BoardStats,
  type GarbageTable,
  type PieceName,
  type Placement,
  type Pose,
  GARBAGE_TABLES,
  PIECES,
  SPAWN_X,
  WIDTH,
  addGarbage,
  bestPlacement,
  boardStats,
  boardToText,
  clearLines,
  collides,
  describeGarbage,
  describeHeight,
  describeHoles,
  describePlacement,
  describeSurface,
  describeWells,
  dropY,
  emptyBoard,
  enumeratePlacements,
  lockPiece,
  makeBag,
  pathTo,
  rotatePiece,
  scoreForLines,
  spawnPose,
} from './engine';

export const SPEEDUPS = {
  constant: { factor: 1, everyMs: Infinity },
  gentle: { factor: 0.9, everyMs: 30_000 },
  standard: { factor: 0.85, everyMs: 20_000 },
  brutal: { factor: 0.75, everyMs: 15_000 },
} as const;
export type SpeedupName = keyof typeof SPEEDUPS;

export const MIN_GRAVITY_MS = 40;
const LOCK_DELAY_MS = 500;
const MAX_LOCK_RESETS = 12;
/** How many pieces ahead a player can see. */
export const NEXT_COUNT = 3;
/** A seat whose calls keep failing should not hammer the proxy once per piece. */
const ERROR_BACKOFF_MS = 600;
/** The option id that swaps the current piece with the hold slot instead of placing it. */
export const HOLD_ID = 'hold';

export interface TetrisOptions {
  seed: number;
  /** ms per row at level 1 */
  gravityMs: number;
  speedup: SpeedupName;
  /** Cleared lines become garbage rows for the opponent; first to top out loses. */
  garbage: boolean;
  /** Rows a clear sends: one per line, or the guideline table where a single sends nothing. */
  garbageTable: GarbageTable;
  /** No gravity at all, for any seat: only decision quality is compared. */
  lockstep: boolean;
  /** 0 = no limit */
  timeLimitSec: number;
}

export const TETRIS_DEFAULTS: TetrisOptions = {
  seed: 42,
  gravityMs: 400,
  speedup: 'gentle',
  garbage: true,
  garbageTable: 'linear',
  lockstep: false,
  timeLimitSec: 180,
};

export type TetrisMode = 'versus' | 'race' | 'lockstep';

export function modeOf(options: Pick<TetrisOptions, 'garbage' | 'lockstep'>): TetrisMode {
  return options.lockstep ? 'lockstep' : options.garbage ? 'versus' : 'race';
}

export const TETRIS_RULES =
  'You are playing Tetris. The board is 10 columns wide and 20 rows tall. A full row disappears. The game is lost when the stack reaches the top.';

const GARBAGE_RULES: Record<GarbageTable, string> = {
  linear: ' Every row you clear sends one garbage row to the opponent: a single sends one, and four rows at once (a Tetris) sends four.',
  guideline:
    ' Clearing two rows at once sends one garbage row to the opponent, three rows sends two, and four rows (a Tetris) sends four. A single row sends nothing.',
};

const MODE_RULES: Record<TetrisMode, string> = {
  versus: ' Garbage arriving at your board pushes your whole stack up, and rows you clear cancel garbage waiting for you before it lands.',
  race: ' You and the opponent play separate boards from the same piece sequence; whoever lasts more pieces wins.',
  lockstep: ' There is no clock and no gravity: take the time you need.',
};

export const TETRIS_PRIORITIES = [
  'Clearing lines is good. Clearing more lines at once is better.',
  'Do not create holes. A placement with holes_created of none beats one that creates holes, unless the one with holes clears far more lines or the stack is dangerously high.',
  'Keep the stack low. Prefer a lower stack_height_after and a height_change that does not grow the stack.',
  'Keep the surface flat. Prefer surface_after of flat over slightly uneven, bumpy, or very jagged.',
  'One deep well is acceptable because the next I piece can fill it. Several deep wells are bad.',
  'When the stack is dangerously high, survival matters more than a clean surface.',
  'When incoming_garbage is not none, your stack is about to be pushed up by that many rows: clear a line now, because clearing cancels garbage before it lands.',
  'Holding costs you this turn, so hold only when no placement is decent and the held piece would fit much better.',
];

export type TetrisAction = 'left' | 'right' | 'rotateCw' | 'rotateCcw' | 'soft' | 'hard' | 'hold';

export interface Active extends Pose {
  piece: PieceName;
}

export interface TetrisSide {
  index: 0 | 1;
  player: Player;
  human: boolean;
  board: Board;
  pendingGarbage: number;
  current: PieceName;
  /** The next `NEXT_COUNT` pieces, soonest first. */
  queue: PieceName[];
  hold: PieceName | null;
  /** Hold is one swap per piece, so it cannot be used to stall. */
  holdUsed: boolean;
  active: Active | null;
  /** Cells of the chosen placement, outlined while the piece slides there. */
  target: [number, number][] | null;
  flash: number[];
  lines: number;
  pieces: number;
  score: number;
  sent: number;
  received: number;
  /** Incoming garbage wiped out by this side's own clears. */
  cancelled: number;
  holds: number;
  clears: number[];
  /** Tallest the stack ever got. */
  peak: number;
  /** Requests issued, answers that arrived after the piece had locked, slowest answer. */
  asked: number;
  late: number;
  slowestMs: number;
  over: boolean;
  lostAt: number | null;
  lostTo: 'stack' | 'garbage' | null;
  thinking: boolean;
  /** performance.now() of the last garbage hit, for the shake animation. */
  hitAt: number;
  move: string;
  stats: PlayerStats;
}

/** Something audible or visible happened. The match stays DOM-free; the arena decides what to do with it. */
export interface TetrisEvent {
  type: 'move' | 'rotate' | 'drop' | 'lock' | 'clear' | 'garbage' | 'miss' | 'topout' | 'hold';
  side: 0 | 1;
  /** For 'clear': how many lines. */
  lines?: number;
}

export interface TetrisResult {
  winner: 0 | 1 | null;
  /** True when the match was stopped rather than decided. */
  stopped: boolean;
  reason: string;
  elapsedMs: number;
}

/** Where a placement sits, for a person to read (the model-facing wording lives in engine.ts). */
function whereText(p: Placement): string {
  const xs = p.cells.map((c) => c[0]);
  const a = Math.min(...xs) + 1;
  const b = Math.max(...xs) + 1;
  return a === b ? t('m.column', { a }) : t('m.columns', { a, b });
}

interface Control {
  lockNow(): void;
  hold(): void;
  restartGravity(): void;
  touchLock(): void;
}

/** Everything a request needs from a side, so tests and samples can build one without a match. */
export interface RequestSide {
  board: Board;
  current: PieceName;
  queue: PieceName[];
  hold: PieceName | null;
  holdUsed: boolean;
  pendingGarbage: number;
  lines: number;
}

export interface OpponentView {
  maxHeight: number;
  lines: number;
  pendingGarbage: number;
}

export interface RequestContext {
  /** True when a clock is running while the player thinks. */
  realtime: boolean;
  mode: TetrisMode;
  /** Which table `garbageSent` was counted with; only read in versus mode. */
  garbageTable?: GarbageTable;
  /** Null in a solitaire position, such as the samples a generated algorithm is tried on. */
  opponent: OpponentView | null;
}

/**
 * The option that swaps instead of placing. It carries the same field names as every placement —
 * a model compares like with like — with `action` saying what actually happens.
 */
function holdOption(side: RequestSide, stats: BoardStats, versus: boolean): MoveOption {
  const taken = side.hold ?? side.queue[0];
  const description: Record<string, string> = {
    action: side.hold
      ? `swap the ${side.current} for the ${side.hold} you are holding, then choose again with the ${taken}`
      : `put the ${side.current} in the empty hold slot and choose again with the ${taken}`,
    where: 'nothing lands this turn',
    lines_cleared: 'none',
    holes_created: 'none',
    holes_uncovered: 'none',
    stack_height_after: describeHeight(stats.maxHeight),
    height_change: 'stack does not get taller',
    surface_after: describeSurface(stats.bumpiness),
    wells_after: describeWells(stats.wells),
    slid_into_place: 'no, nothing is placed',
  };
  if (versus) description.garbage_sent = 'none';
  return { id: HOLD_ID, description };
}

function holdFacts(stats: BoardStats): Record<string, unknown> {
  return {
    action: 'hold',
    column: -1,
    rotation: -1,
    landingRow: -1,
    linesCleared: 0,
    holesCreated: 0,
    holesRemoved: 0,
    holesAfter: stats.holes,
    maxHeightAfter: stats.maxHeight,
    heightDelta: 0,
    aggregateHeightAfter: stats.aggregateHeight,
    bumpinessAfter: stats.bumpiness,
    deepWellsAfter: stats.wells.length,
    columnHeightsAfter: stats.heights,
    tuck: false,
    garbageSent: 0,
  };
}

export function buildTetrisRequest(side: RequestSide, placements: Placement[], ctx: RequestContext): DecisionRequest {
  const stats = boardStats(side.board);
  const versus = ctx.mode === 'versus';
  const canHold = !side.holdUsed && (side.hold !== null || side.queue.length > 0);
  const options: MoveOption[] = placements.map((p) => ({
    id: p.id,
    description: { action: `place the ${p.piece}`, ...describePlacement(p, versus) },
  }));
  const facts = placements.map((p) => ({
    id: p.id,
    facts: {
      action: 'place',
      column: p.x,
      rotation: p.rotation,
      landingRow: p.y,
      linesCleared: p.linesCleared,
      holesCreated: p.holesCreated,
      holesRemoved: p.holesRemoved,
      holesAfter: p.after.holes,
      maxHeightAfter: p.after.maxHeight,
      heightDelta: p.heightDelta,
      aggregateHeightAfter: p.after.aggregateHeight,
      bumpinessAfter: p.after.bumpiness,
      deepWellsAfter: p.after.wells.length,
      columnHeightsAfter: p.after.heights,
      tuck: p.tuck,
      garbageSent: p.garbageSent,
    } as Record<string, unknown>,
  }));
  if (canHold) {
    options.push(holdOption(side, stats, versus));
    facts.push({ id: HOLD_ID, facts: holdFacts(stats) });
  }
  return {
    game: 'tetris',
    rules: TETRIS_RULES + (versus ? GARBAGE_RULES[ctx.garbageTable ?? 'linear'] : '') + MODE_RULES[ctx.mode],
    question: 'Which placement of `current_piece` should the player choose? Each option describes the board after that placement.',
    priorities: TETRIS_PRIORITIES,
    state: {
      board_rows_top_to_bottom: boardToText(side.board),
      legend: '# is a filled cell, . is an empty cell. The first row is the top of the board.',
      column_heights_left_to_right: stats.heights,
      stack_height: describeHeight(stats.maxHeight),
      holes_in_stack: describeHoles(stats.holes),
      surface: describeSurface(stats.bumpiness),
      current_piece: side.current,
      next_pieces: side.queue.slice(),
      hold_piece: side.hold ?? 'empty',
      hold_available: canHold ? 'yes' : 'no, already used for this piece',
      incoming_garbage: describeGarbage(side.pendingGarbage),
      incoming_garbage_note: 'Garbage rows waiting to be pushed in under your stack when the current piece locks.',
      mode: ctx.mode,
      lines_cleared_so_far: side.lines,
      opponent_stack_height: ctx.opponent ? describeHeight(ctx.opponent.maxHeight) : 'no opponent',
      opponent_lines_cleared: ctx.opponent ? ctx.opponent.lines : 0,
      opponent_incoming_garbage: ctx.opponent ? describeGarbage(ctx.opponent.pendingGarbage) : 'none',
    },
    options,
    data: {
      state: {
        board: boardToText(side.board),
        columnHeights: stats.heights,
        maxHeight: stats.maxHeight,
        holes: stats.holes,
        bumpiness: stats.bumpiness,
        currentPiece: side.current,
        nextPieces: side.queue.slice(),
        holdPiece: side.hold,
        holdAvailable: canHold,
        pendingGarbage: side.pendingGarbage,
        mode: ctx.mode,
        linesClearedSoFar: side.lines,
        opponentMaxHeight: ctx.opponent ? ctx.opponent.maxHeight : null,
        opponentLines: ctx.opponent ? ctx.opponent.lines : null,
        opponentPendingGarbage: ctx.opponent ? ctx.opponent.pendingGarbage : null,
      },
      options: facts,
    },
    botChoice: () => bestPlacement(placements, side.queue[0] ?? null).id,
    realtime: ctx.realtime,
  };
}

export class TetrisMatch {
  readonly sides: [TetrisSide, TetrisSide];
  readonly options: TetrisOptions;
  status: 'idle' | 'running' | 'done' = 'idle';
  result: TetrisResult | null = null;
  error: string | null = null;

  private abort = new AbortController();
  private startedAt = 0;
  private endedAt = 0;
  private bags: PieceName[][] = [[], []];
  private randoms: (() => number)[] = [];
  private garbageRandoms: (() => number)[] = [];
  private controls: (Control | null)[] = [null, null];
  /** At most one answer per seat may still be on its way after its piece locked; older ones are cut off. */
  private stale: (AbortController | null)[] = [null, null];
  private timer: ReturnType<typeof setInterval> | null = null;
  private onChange: () => void;
  private emit: (event: TetrisEvent) => void;

  constructor(players: [Player, Player], options: TetrisOptions, onChange: () => void = () => {}, emit: (event: TetrisEvent) => void = () => {}) {
    this.options = options;
    this.onChange = onChange;
    this.emit = emit;
    this.sides = [this.makeSide(0, players[0]), this.makeSide(1, players[1])];
  }

  private makeSide(index: 0 | 1, player: Player): TetrisSide {
    // Both sides draw from the same seed, so they see the same piece sequence.
    this.randoms[index] = seededRandom(this.options.seed);
    this.garbageRandoms[index] = seededRandom(this.options.seed * 7919 + index + 1);
    this.bags[index] = [];
    return {
      index,
      player,
      human: player.config.kind === 'human',
      board: emptyBoard(),
      pendingGarbage: 0,
      current: this.nextPiece(index),
      queue: Array.from({ length: NEXT_COUNT }, () => this.nextPiece(index)),
      hold: null,
      holdUsed: false,
      active: null,
      target: null,
      flash: [],
      lines: 0,
      pieces: 0,
      score: 0,
      sent: 0,
      received: 0,
      cancelled: 0,
      holds: 0,
      clears: [0, 0, 0, 0, 0],
      peak: 0,
      asked: 0,
      late: 0,
      slowestMs: 0,
      over: false,
      lostAt: null,
      lostTo: null,
      thinking: false,
      hitAt: 0,
      move: t('m.ready'),
      stats: freshStats(),
    };
  }

  private nextPiece(index: number): PieceName {
    if (this.bags[index].length === 0) this.bags[index] = makeBag(this.randoms[index]);
    return this.bags[index].pop()!;
  }

  /** Takes the next piece off the queue and refills it. */
  private advance(side: TetrisSide): void {
    side.current = side.queue.shift()!;
    side.queue.push(this.nextPiece(side.index));
  }

  elapsed(): number {
    if (this.status === 'idle') return 0;
    return (this.status === 'done' ? this.endedAt : performance.now()) - this.startedAt;
  }

  level(): number {
    const { everyMs } = SPEEDUPS[this.options.speedup];
    if (this.options.lockstep || !Number.isFinite(everyMs)) return 1;
    return Math.floor(this.elapsed() / everyMs) + 1;
  }

  gravityNow(): number {
    const { factor } = SPEEDUPS[this.options.speedup];
    return Math.max(MIN_GRAVITY_MS, Math.round(this.options.gravityMs * Math.pow(factor, this.level() - 1)));
  }

  mode(): TetrisMode {
    return modeOf(this.options);
  }

  start(): void {
    if (this.status !== 'idle') return;
    this.status = 'running';
    this.startedAt = performance.now();
    for (const side of this.sides) void (side.human ? this.runHumanSide(side) : this.runModelSide(side));
    if (this.options.timeLimitSec > 0) {
      this.timer = setInterval(() => {
        if (this.elapsed() >= this.options.timeLimitSec * 1000) this.checkEnd(true);
      }, 250);
    }
    this.onChange();
  }

  /** Ends the match without a verdict (the person pressed stop or left the page). */
  stop(): void {
    if (this.status === 'done') return;
    this.finish(null, t('r.stopped'), true);
  }

  // ---- Garbage ---------------------------------------------------------------------------------

  /** Rows a clear sends after cancelling whatever is already waiting for the clearing side. */
  private resolveAttack(side: TetrisSide, cleared: number): void {
    const attack = GARBAGE_TABLES[this.options.garbageTable][cleared] ?? 0;
    if (attack <= 0) return;
    const cancelled = Math.min(side.pendingGarbage, attack);
    side.pendingGarbage -= cancelled;
    side.cancelled += cancelled;
    const left = attack - cancelled;
    if (left <= 0) return;
    side.sent += left; // counted even when the opponent has already topped out
    const to = this.sides[side.index === 0 ? 1 : 0];
    if (!to.over) to.pendingGarbage += left;
  }

  /** Incoming garbage lands when the receiver's piece has locked, before the next spawn. */
  private applyGarbage(side: TetrisSide): boolean {
    const n = side.pendingGarbage;
    if (n <= 0) return false;
    side.pendingGarbage = 0;
    const gap = Math.floor(this.garbageRandoms[side.index]() * WIDTH);
    const { board, overflow } = addGarbage(side.board, n, gap);
    side.board = board;
    side.received += n;
    side.hitAt = performance.now();
    this.emit({ type: 'garbage', side: side.index });
    this.onChange();
    return overflow;
  }

  /** Locks a piece, clears lines (with a flash), sends garbage, advances the queue. */
  private async settlePiece(side: TetrisSide, landed: Pose): Promise<void> {
    const piece = side.active!.piece;
    side.active = null;
    side.target = null;
    const locked = lockPiece(side.board, piece, landed.rotation, landed.x, landed.y);
    const { board, cleared, rows } = clearLines(locked);
    this.emit(cleared > 0 ? { type: 'clear', side: side.index, lines: cleared } : { type: 'lock', side: side.index });
    if (cleared > 0) {
      side.board = locked;
      side.flash = rows;
      await sleep(110);
      side.flash = [];
    }
    side.board = board;
    // The flash is the only pause in a piece: a stop during it must not score after the verdict.
    if (this.abort.signal.aborted) return;
    side.lines += cleared;
    side.clears[cleared] += 1;
    side.peak = Math.max(side.peak, boardStats(board).maxHeight);
    if (this.options.garbage && cleared > 0) this.resolveAttack(side, cleared);
    side.score += scoreForLines(cleared, Math.floor(side.lines / 10) + 1);
    side.pieces += 1;
    this.advance(side);
    this.onChange();
    // Without garbage the survivor wins by outlasting the loser's piece count.
    if (!this.options.garbage) this.checkEnd();
  }

  /** Swaps the current piece with the hold slot. One swap per piece, so it cannot be used to stall. */
  private swapHold(side: TetrisSide): void {
    const held = side.hold;
    side.hold = side.current;
    if (held) side.current = held;
    else this.advance(side);
    side.holdUsed = true;
    side.holds += 1;
    side.active = null;
    side.target = null;
    this.emit({ type: 'hold', side: side.index });
    this.onChange();
  }

  private topOut(side: TetrisSide, cause: 'stack' | 'garbage'): void {
    side.over = true;
    side.lostAt = this.elapsed();
    side.lostTo = cause;
    side.active = null;
    side.target = null;
    side.thinking = false;
    side.move = t('m.toppedOutAt', { clock: formatClock(side.lostAt) });
    this.emit({ type: 'topout', side: side.index });
    this.checkEnd();
    this.onChange();
  }

  private opponentView(side: TetrisSide): OpponentView {
    const other = this.sides[side.index === 0 ? 1 : 0];
    return { maxHeight: boardStats(other.board).maxHeight, lines: other.lines, pendingGarbage: other.pendingGarbage };
  }

  // ---- Model / bot seat ---------------------------------------------------------------------------

  /** Cuts off an answer that is still on its way from an earlier piece of this seat. */
  private dropStale(side: TetrisSide): void {
    this.stale[side.index]?.abort();
    this.stale[side.index] = null;
  }

  private async runModelSide(side: TetrisSide): Promise<void> {
    const signal = this.abort.signal;
    const lockstep = this.options.lockstep;
    while (!side.over && !signal.aborted) {
      if (this.applyGarbage(side)) return this.topOut(side, 'garbage');
      side.holdUsed = false;
      // One turn per piece, plus one more each time the player decides to hold instead of place.
      for (let turn = 0; turn <= 1 && !side.over && !signal.aborted; turn++) {
        const piece = side.current;
        if (collides(side.board, PIECES[piece][0].cells, SPAWN_X, 0)) return this.topOut(side, 'stack');
        const placements = enumeratePlacements(side.board, piece, this.options.garbageTable);
        if (placements.length === 0) return this.topOut(side, 'stack');
        side.active = { piece, ...spawnPose() };
        side.target = null;

        // Ask right away; the piece falls while we wait.
        const askedAt = performance.now();
        const request = buildTetrisRequest(side, placements, { realtime: !lockstep, mode: this.mode(), garbageTable: this.options.garbageTable, opponent: this.opponentView(side) });
        let decision: Awaited<ReturnType<Player['decide']>> | null = null;
        let settled = false;
        let failed = false;
        let deadline = false; // the piece locked before this answer arrived
        side.thinking = true;
        side.asked += 1;
        // One controller per piece, chained to the match, so a superseded request can be cut off.
        const turnAbort = new AbortController();
        const relay = () => turnAbort.abort();
        signal.addEventListener('abort', relay, { once: true });
        const pending = side.player
          .decide(request, turnAbort.signal)
          .then((d) => {
            // Late or not, the call was made and paid for, so it is counted either way.
            recordDecision(side.stats, d);
            side.slowestMs = Math.max(side.slowestMs, d.latencyMs);
            if (deadline) side.late += 1;
            else decision = d;
          })
          .catch((err: Error & { status?: number }) => {
            if (signal.aborted || turnAbort.signal.aborted) return;
            failed = true;
            side.stats.errors += 1;
            side.move = t('m.error', { msg: err.message });
            // A bad key or an unknown model will fail every move: say so once, loudly.
            if (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 503) {
              this.error = `${side.player.name}: ${err.message}`;
            }
          })
          .finally(() => {
            settled = true;
            if (!deadline) side.thinking = false;
            signal.removeEventListener('abort', relay);
            if (this.stale[side.index] === turnAbort) this.stale[side.index] = null;
          });

        let answered = false;
        if (lockstep) {
          await pending;
          answered = decision !== null;
        } else {
          while (!signal.aborted) {
            if (settled) break;
            await sleep(this.gravityNow());
            if (signal.aborted) return;
            if (settled) break;
            const a = side.active;
            if (!collides(side.board, PIECES[a.piece][a.rotation].cells, a.x, a.y + 1)) a.y += 1;
            else break; // landed before the answer: a missed deadline
          }
          answered = decision !== null;
        }
        if (signal.aborted) return;
        if (!settled) {
          // The piece is locking now. Keep this answer alive long enough to be counted, but never
          // let a seat accumulate more than one unanswered request.
          deadline = true;
          side.thinking = false;
          this.dropStale(side);
          this.stale[side.index] = turnAbort;
        }

        const a = side.active;
        const lockInPlace = (): Pose => ({ rotation: a.rotation, x: a.x, y: dropY(side.board, PIECES[piece][a.rotation].cells, a.x, a.y) });
        let landed: Pose;
        const d = decision as Awaited<ReturnType<Player['decide']>> | null;
        if (answered && d) {
          if (d.optionId === HOLD_ID && !side.holdUsed) {
            side.move = t('m.held', { piece });
            this.swapHold(side);
            continue; // same falling piece slot, new piece in hand
          }
          const chosen = d.optionId ? placements.find((p) => p.id === d.optionId) : undefined;
          if (!chosen) {
            side.stats.invalid += 1;
            side.move = t('m.invalidDropped', { piece, note: d.note });
            landed = lockInPlace();
          } else {
            // The piece has fallen while the answer travelled. Ask the engine whether the chosen
            // placement can still be reached from here; if it cannot, the answer came too late.
            const steps = pathTo(side.board, piece, a, chosen);
            if (!steps) {
              side.stats.missed += 1;
              this.emit({ type: 'miss', side: side.index });
              side.move = t('m.tooLate', { piece, ms: Math.round(d.latencyMs) });
              landed = lockInPlace();
            } else {
              side.target = chosen.cells;
              for (const move of steps) {
                if (signal.aborted) return;
                if (move === 'left') a.x -= 1;
                else if (move === 'right') a.x += 1;
                else if (move === 'down') a.y += 1;
                else {
                  const turned = rotatePiece(side.board, piece, a, move === 'cw' ? 1 : -1)!;
                  a.rotation = turned.rotation;
                  a.x = turned.x;
                  a.y = turned.y;
                }
                await sleep(move === 'down' ? 10 : 18);
              }
              // Exactly the placement the player was shown, so the board it was promised is the board it gets.
              landed = { rotation: chosen.rotation, x: chosen.x, y: chosen.y };
              const took = d.latencyMs > 0 ? t('m.took', { ms: Math.round(d.latencyMs) }) : '';
              side.move = t('m.placed', { piece, where: whereText(chosen), took });
            }
          }
        } else if (failed) {
          // An error is an error, not a missed deadline: counting it as both doubled every failure.
          landed = lockInPlace();
        } else {
          side.stats.missed += 1;
          this.emit({ type: 'miss', side: side.index });
          side.move = t('m.noAnswer', { piece, ms: Math.round(performance.now() - askedAt) });
          landed = lockInPlace();
        }
        if (signal.aborted) return;
        await this.settlePiece(side, landed);
        if (failed) await sleep(ERROR_BACKOFF_MS); // do not hammer a proxy that is refusing us
        // Local players answer instantly; without a pause they would finish a game in a blink.
        else if (d && d.latencyMs === 0) await sleep(lockstep ? 60 : 140);
        break;
      }
    }
  }

  // ---- Human seat -----------------------------------------------------------------------------------

  private tryMove(side: TetrisSide, dx: number, dy: number): boolean {
    const a = side.active!;
    if (collides(side.board, PIECES[a.piece][a.rotation].cells, a.x + dx, a.y + dy)) return false;
    a.x += dx;
    a.y += dy;
    return true;
  }

  private tryRotate(side: TetrisSide, dir: number): boolean {
    const a = side.active!;
    const turned = rotatePiece(side.board, a.piece, a, dir);
    if (!turned) return false;
    a.rotation = turned.rotation;
    a.x = turned.x;
    a.y = turned.y;
    return true;
  }

  /** A key press or touch button for a human seat. Ignored for any other seat. */
  input(index: 0 | 1, action: TetrisAction): void {
    const side = this.sides[index];
    const control = this.controls[index];
    if (!side.human || !control || !side.active || this.status !== 'running') return;
    let moved = false;
    switch (action) {
      case 'left':
        moved = this.tryMove(side, -1, 0);
        break;
      case 'right':
        moved = this.tryMove(side, 1, 0);
        break;
      case 'rotateCw':
        moved = this.tryRotate(side, 1);
        break;
      case 'rotateCcw':
        moved = this.tryRotate(side, -1);
        break;
      case 'soft':
        if (this.tryMove(side, 0, 1)) control.restartGravity();
        break;
      case 'hold':
        if (!side.holdUsed) control.hold();
        return;
      case 'hard': {
        const a = side.active;
        a.y = dropY(side.board, PIECES[a.piece][a.rotation].cells, a.x, a.y);
        this.emit({ type: 'drop', side: side.index });
        control.lockNow();
        return;
      }
    }
    if (moved) this.emit({ type: action === 'rotateCw' || action === 'rotateCcw' ? 'rotate' : 'move', side: side.index });
    const a = side.active;
    if (moved && collides(side.board, PIECES[a.piece][a.rotation].cells, a.x, a.y + 1)) control.touchLock();
  }

  /**
   * One piece: gravity ticks, a lock delay when resting, and the controls above. Resolves with the
   * pose to lock, or 'hold' when the person put the piece away instead. In lockstep there is no
   * gravity for anyone, so the piece waits for a hard drop.
   */
  private playPiece(side: TetrisSide): Promise<Pose | 'hold'> {
    const signal = this.abort.signal;
    const gravity = !this.options.lockstep;
    return new Promise((resolve) => {
      let gravityTimer: ReturnType<typeof setTimeout> | undefined;
      let lockTimer: ReturnType<typeof setTimeout> | undefined;
      let resets = 0;
      let done = false;
      const end = (value: Pose | 'hold') => {
        if (done) return;
        done = true;
        clearTimeout(gravityTimer);
        clearTimeout(lockTimer);
        this.controls[side.index] = null;
        // One listener per piece would otherwise pile up on the match signal for the whole game.
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const finish = () => {
        const a = side.active!;
        end({ rotation: a.rotation, x: a.x, y: a.y });
      };
      const onAbort = () => finish();
      const armLock = () => {
        clearTimeout(lockTimer);
        lockTimer = setTimeout(finish, LOCK_DELAY_MS);
      };
      const tick = () => {
        if (done || signal.aborted) return;
        if (this.tryMove(side, 0, 1)) {
          clearTimeout(lockTimer);
          lockTimer = undefined;
        } else if (!lockTimer) {
          armLock();
        }
        gravityTimer = setTimeout(tick, this.gravityNow());
      };
      this.controls[side.index] = {
        lockNow: finish,
        hold: () => end('hold'),
        restartGravity: () => {
          if (!gravity) return;
          clearTimeout(gravityTimer);
          gravityTimer = setTimeout(tick, this.gravityNow());
        },
        // A successful move or rotation while resting restarts the lock delay, a few times.
        touchLock: () => {
          if (gravity && resets < MAX_LOCK_RESETS) {
            resets += 1;
            armLock();
          }
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (gravity) gravityTimer = setTimeout(tick, this.gravityNow());
    });
  }

  private async runHumanSide(side: TetrisSide): Promise<void> {
    const signal = this.abort.signal;
    side.move = t('m.yourMove');
    while (!side.over && !signal.aborted) {
      if (this.applyGarbage(side)) return this.topOut(side, 'garbage');
      side.holdUsed = false;
      for (let turn = 0; turn <= 1 && !side.over && !signal.aborted; turn++) {
        const piece = side.current;
        if (collides(side.board, PIECES[piece][0].cells, SPAWN_X, 0)) return this.topOut(side, 'stack');
        side.active = { piece, ...spawnPose() };
        const landed = await this.playPiece(side);
        if (signal.aborted) return;
        if (landed === 'hold') {
          this.swapHold(side);
          continue;
        }
        await this.settlePiece(side, landed);
        break;
      }
    }
  }

  // ---- Verdict ------------------------------------------------------------------------------------------

  private checkEnd(timeUp = false): void {
    if (this.status !== 'running') return;
    const [L, R] = this.sides;
    const bothOver = L.over && R.over;
    const oneOver = L.over || R.over;
    if (!oneOver && !timeUp) return;
    const name = (s: TetrisSide) => s.player.name;
    if (oneOver && !bothOver && !timeUp) {
      const loser = L.over ? L : R;
      const survivor = loser === L ? R : L;
      if (this.options.garbage) return this.finish(survivor.index, t('r.toppedFirst', { winner: name(survivor), loser: name(loser) }));
      if (survivor.pieces > loser.pieces) return this.finish(survivor.index, t('r.survived', { winner: name(survivor), n: loser.pieces }));
      loser.move = t('m.outAfter', { n: loser.pieces, name: name(survivor) });
      return;
    }
    if (bothOver && L.pieces !== R.pieces) {
      const winner = L.pieces > R.pieces ? L : R;
      return this.finish(winner.index, t('r.morePieces', { winner: name(winner) }));
    }
    if (L.lines !== R.lines) {
      const winner = L.lines > R.lines ? L : R;
      return this.finish(winner.index, t(timeUp ? 'r.onLinesAtLimit' : 'r.onLines', { winner: name(winner) }));
    }
    this.finish(null, t(timeUp ? 'r.drawAtLimit' : 'r.draw'));
  }

  private finish(winner: 0 | 1 | null, reason: string, stopped = false): void {
    if (this.status === 'done') return;
    this.endedAt = performance.now();
    if (this.status === 'idle') this.startedAt = this.endedAt;
    this.status = 'done';
    this.abort.abort();
    for (const side of this.sides) this.dropStale(side);
    if (this.timer) clearInterval(this.timer);
    this.controls = [null, null];
    for (const side of this.sides) {
      side.thinking = false;
      side.target = null;
    }
    this.result = { winner, stopped, reason, elapsedMs: this.endedAt - this.startedAt };
    this.onChange();
  }
}
