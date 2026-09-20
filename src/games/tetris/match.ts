// A two-sided real-time Tetris match. No DOM: the arena component draws `sides` every frame and
// forwards key presses to `input()`. Ported from jev-tetris (arena.js + play.js), with one
// change: a person is just another seat, so any pairing of roles works.
//
// When a piece spawns the player is asked at once, and gravity pulls the piece down while it
// thinks. If the piece lands before the answer arrives it locks where it is: a missed deadline.

import type { Player, PlayerStats, DecisionRequest } from '../../core/types';
import { freshStats, recordDecision, seededRandom, sleep, formatClock } from '../../core/types';
import { t } from '../../core/i18n';
import {
  type Board,
  type PieceName,
  type Placement,
  PIECES,
  SPAWN_X,
  WIDTH,
  addGarbage,
  bestByHeuristic,
  boardStats,
  boardToText,
  clearLines,
  collides,
  describeHeight,
  describeHoles,
  describePlacement,
  describeSurface,
  dropY,
  emptyBoard,
  enumeratePlacements,
  lockPiece,
  makeBag,
  scoreForLines,
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
const KICKS = [0, -1, 1, -2, 2];

export interface TetrisOptions {
  seed: number;
  /** ms per row at level 1 */
  gravityMs: number;
  speedup: SpeedupName;
  /** Cleared lines become garbage rows for the opponent; first to top out loses. */
  garbage: boolean;
  /** No gravity for model seats: only decision quality is compared. */
  lockstep: boolean;
  /** 0 = no limit */
  timeLimitSec: number;
}

export const TETRIS_DEFAULTS: TetrisOptions = {
  seed: 42,
  gravityMs: 400,
  speedup: 'gentle',
  garbage: true,
  lockstep: false,
  timeLimitSec: 180,
};

export const TETRIS_RULES =
  'You are playing Tetris. The board is 10 columns wide and 20 rows tall. A full row disappears. The game is lost when the stack reaches the top.';

export const TETRIS_PRIORITIES = [
  'Clearing lines is good. Clearing more lines at once is better.',
  'Do not create holes. A placement with holes_created of none beats one that creates holes, unless the one with holes clears far more lines or the stack is dangerously high.',
  'Keep the stack low. Prefer a lower stack_height_after and a height_change that does not grow the stack.',
  'Keep the surface flat. Prefer surface_after of flat over slightly uneven, bumpy, or very jagged.',
  'One deep well is acceptable because the next I piece can fill it. Several deep wells are bad.',
  'When the stack is dangerously high, survival matters more than a clean surface.',
];

export type TetrisAction = 'left' | 'right' | 'rotateCw' | 'rotateCcw' | 'soft' | 'hard';

export interface Active {
  piece: PieceName;
  rotation: number;
  x: number;
  y: number;
}

export interface TetrisSide {
  index: 0 | 1;
  player: Player;
  human: boolean;
  board: Board;
  pendingGarbage: number;
  current: PieceName;
  next: PieceName;
  active: Active | null;
  /** Cells of the chosen placement, outlined while the piece slides there. */
  target: [number, number][] | null;
  flash: number[];
  lines: number;
  pieces: number;
  score: number;
  sent: number;
  received: number;
  clears: number[];
  over: boolean;
  lostAt: number | null;
  thinking: boolean;
  /** performance.now() of the last garbage hit, for the shake animation. */
  hitAt: number;
  move: string;
  stats: PlayerStats;
}

/** Something audible or visible happened. The match stays DOM-free; the arena decides what to do with it. */
export interface TetrisEvent {
  type: 'move' | 'rotate' | 'drop' | 'lock' | 'clear' | 'garbage' | 'miss' | 'topout';
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
  restartGravity(): void;
  touchLock(): void;
}

export function buildTetrisRequest(side: Pick<TetrisSide, 'board' | 'current' | 'next' | 'lines'>, placements: Placement[], realtime: boolean): DecisionRequest {
  const stats = boardStats(side.board);
  return {
    game: 'tetris',
    rules: TETRIS_RULES,
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
      next_piece: side.next,
      lines_cleared_so_far: side.lines,
    },
    options: placements.map((p) => ({ id: p.id, description: describePlacement(p) })),
    data: {
      state: {
        board: boardToText(side.board),
        columnHeights: stats.heights,
        maxHeight: stats.maxHeight,
        holes: stats.holes,
        bumpiness: stats.bumpiness,
        currentPiece: side.current,
        nextPiece: side.next,
        linesClearedSoFar: side.lines,
      },
      options: placements.map((p) => ({
        id: p.id,
        facts: {
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
        },
      })),
    },
    botChoice: () => bestByHeuristic(placements).id,
    realtime,
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
      next: this.nextPiece(index),
      active: null,
      target: null,
      flash: [],
      lines: 0,
      pieces: 0,
      score: 0,
      sent: 0,
      received: 0,
      clears: [0, 0, 0, 0, 0],
      over: false,
      lostAt: null,
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

  elapsed(): number {
    if (this.status === 'idle') return 0;
    return (this.status === 'done' ? this.endedAt : performance.now()) - this.startedAt;
  }

  level(): number {
    const { everyMs } = SPEEDUPS[this.options.speedup];
    return Number.isFinite(everyMs) ? Math.floor(this.elapsed() / everyMs) + 1 : 1;
  }

  gravityNow(): number {
    const { factor } = SPEEDUPS[this.options.speedup];
    return Math.max(MIN_GRAVITY_MS, Math.round(this.options.gravityMs * Math.pow(factor, this.level() - 1)));
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

  private sendGarbage(from: TetrisSide, count: number): void {
    const to = this.sides[from.index === 0 ? 1 : 0];
    if (to.over || count <= 0) return;
    to.pendingGarbage += count;
    from.sent += count;
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
  private async settlePiece(side: TetrisSide, landed: { rotation: number; x: number; y: number }): Promise<void> {
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
    side.lines += cleared;
    side.clears[cleared] += 1;
    if (this.options.garbage && cleared > 0) this.sendGarbage(side, cleared);
    side.score += scoreForLines(cleared, Math.floor(side.lines / 10) + 1);
    side.pieces += 1;
    side.current = side.next;
    side.next = this.nextPiece(side.index);
    this.onChange();
    // Without garbage the survivor wins by outlasting the loser's piece count.
    if (!this.options.garbage) this.checkEnd();
  }

  private topOut(side: TetrisSide): void {
    side.over = true;
    side.lostAt = this.elapsed();
    side.active = null;
    side.target = null;
    side.thinking = false;
    side.move = t('m.toppedOutAt', { clock: formatClock(side.lostAt) });
    this.emit({ type: 'topout', side: side.index });
    this.checkEnd();
    this.onChange();
  }

  // ---- Model / bot seat ---------------------------------------------------------------------------

  private async runModelSide(side: TetrisSide): Promise<void> {
    const signal = this.abort.signal;
    const lockstep = this.options.lockstep;
    while (!side.over && !signal.aborted) {
      if (this.applyGarbage(side)) return this.topOut(side);
      const piece = side.current;
      if (collides(side.board, PIECES[piece][0].cells, SPAWN_X, 0)) return this.topOut(side);
      const placements = enumeratePlacements(side.board, piece);
      if (placements.length === 0) return this.topOut(side);
      side.active = { piece, rotation: 0, x: SPAWN_X, y: 0 };
      side.target = null;

      // Ask right away; the piece falls while we wait.
      const askedAt = performance.now();
      let decision: Awaited<ReturnType<Player['decide']>> | null = null;
      let settled = false;
      let failed = false;
      side.thinking = true;
      const pending = side.player
        .decide(buildTetrisRequest(side, placements, !lockstep), signal)
        .then((d) => {
          decision = d;
        })
        .catch((err: Error & { status?: number }) => {
          if (signal.aborted) return;
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
          side.thinking = false;
        });

      let answered = false;
      if (lockstep) {
        await pending;
        answered = decision !== null;
        // An error in lockstep would otherwise spin without a pause.
        if (failed) await sleep(600);
      } else {
        while (!signal.aborted) {
          if (settled) {
            answered = decision !== null;
            break;
          }
          await sleep(this.gravityNow());
          if (signal.aborted) return;
          if (settled) {
            answered = decision !== null;
            break;
          }
          const a = side.active;
          if (!collides(side.board, PIECES[a.piece][a.rotation].cells, a.x, a.y + 1)) a.y += 1;
          else break; // landed before the answer: a missed deadline
        }
      }
      if (signal.aborted) return;

      const a = side.active;
      const lockInPlace = () => ({ rotation: a.rotation, x: a.x, y: dropY(side.board, PIECES[piece][a.rotation].cells, a.x, a.y) });
      let landed: { rotation: number; x: number; y: number };
      const d = decision as Awaited<ReturnType<Player['decide']>> | null;
      if (answered && d) {
        recordDecision(side.stats, d);
        const chosen = d.optionId ? placements.find((p) => p.id === d.optionId) : undefined;
        if (!chosen) {
          side.stats.invalid += 1;
          side.move = t('m.invalidDropped', { piece, note: d.note });
          landed = lockInPlace();
        } else if (collides(side.board, PIECES[piece][chosen.rotation].cells, chosen.x, a.y)) {
          // The answer came too late for the rotation to fit at this height.
          side.stats.missed += 1;
          this.emit({ type: 'miss', side: side.index });
          side.move = t('m.tooLate', { piece, ms: Math.round(d.latencyMs) });
          landed = lockInPlace();
        } else {
          side.target = chosen.cells;
          a.rotation = chosen.rotation;
          while (a.x !== chosen.x && !signal.aborted) {
            a.x += Math.sign(chosen.x - a.x);
            await sleep(18);
          }
          const restY = dropY(side.board, PIECES[piece][chosen.rotation].cells, chosen.x, a.y);
          while (a.y < restY && !signal.aborted) {
            a.y += 1;
            await sleep(10);
          }
          landed = { rotation: chosen.rotation, x: chosen.x, y: restY };
          const took = d.latencyMs > 0 ? t('m.took', { ms: Math.round(d.latencyMs) }) : '';
          side.move = t('m.placed', { piece, where: whereText(chosen), took });
        }
      } else {
        side.stats.missed += 1;
        this.emit({ type: 'miss', side: side.index });
        if (!failed) side.move = t('m.noAnswer', { piece, ms: Math.round(performance.now() - askedAt) });
        landed = lockInPlace();
      }
      if (signal.aborted) return;
      await this.settlePiece(side, landed);
      // Local players answer instantly; without a pause they would finish a game in a blink.
      if (d && d.latencyMs === 0) await sleep(lockstep ? 60 : 140);
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
    const states = PIECES[a.piece].length;
    const rotation = (a.rotation + dir + states) % states;
    const cells = PIECES[a.piece][rotation].cells;
    for (const kick of KICKS) {
      if (!collides(side.board, cells, a.x + kick, a.y)) {
        a.rotation = rotation;
        a.x += kick;
        return true;
      }
    }
    return false;
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
        if (this.tryMove(side, 0, 1)) {
          side.score += 1;
          control.restartGravity();
        }
        break;
      case 'hard': {
        const a = side.active;
        const y = dropY(side.board, PIECES[a.piece][a.rotation].cells, a.x, a.y);
        side.score += 2 * (y - a.y);
        a.y = y;
        this.emit({ type: 'drop', side: side.index });
        control.lockNow();
        return;
      }
    }
    if (moved) this.emit({ type: action === 'rotateCw' || action === 'rotateCcw' ? 'rotate' : 'move', side: side.index });
    const a = side.active;
    if (moved && collides(side.board, PIECES[a.piece][a.rotation].cells, a.x, a.y + 1)) control.touchLock();
  }

  /** One piece: gravity ticks, a lock delay when resting, and the controls above. */
  private playPiece(side: TetrisSide): Promise<{ rotation: number; x: number; y: number }> {
    const signal = this.abort.signal;
    return new Promise((resolve) => {
      let gravityTimer: ReturnType<typeof setTimeout> | undefined;
      let lockTimer: ReturnType<typeof setTimeout> | undefined;
      let resets = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(gravityTimer);
        clearTimeout(lockTimer);
        this.controls[side.index] = null;
        const a = side.active!;
        resolve({ rotation: a.rotation, x: a.x, y: a.y });
      };
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
        restartGravity: () => {
          clearTimeout(gravityTimer);
          gravityTimer = setTimeout(tick, this.gravityNow());
        },
        // A successful move or rotation while resting restarts the lock delay, a few times.
        touchLock: () => {
          if (resets < MAX_LOCK_RESETS) {
            resets += 1;
            armLock();
          }
        },
      };
      signal.addEventListener('abort', finish, { once: true });
      gravityTimer = setTimeout(tick, this.gravityNow());
    });
  }

  private async runHumanSide(side: TetrisSide): Promise<void> {
    const signal = this.abort.signal;
    side.move = t('m.yourMove');
    while (!side.over && !signal.aborted) {
      if (this.applyGarbage(side)) return this.topOut(side);
      const piece = side.current;
      if (collides(side.board, PIECES[piece][0].cells, SPAWN_X, 0)) return this.topOut(side);
      side.active = { piece, rotation: 0, x: SPAWN_X, y: 0 };
      const landed = await this.playPiece(side);
      if (signal.aborted) return;
      await this.settlePiece(side, landed);
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
