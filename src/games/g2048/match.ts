// A 2048 race: two boards, one seed, each seat moving as fast as it answers. When the clock runs
// out, or both boards are stuck, the higher score wins — so a quick thinker simply gets more moves.
// No DOM: the arena renders `sides` and forwards key presses and swipes to `input()`.

import type { Decision, DecisionRequest, Player, PlayerStats } from '../../core/types';
import { freshStats, recordDecision, seededRandom, sleep } from '../../core/types';
import { t } from '../../core/i18n';
import { type Board, type Dir, type MoveFacts, analyze, boardToText, botMove, describeMove, maxTile, spawn, startBoard } from './engine';

export interface Options2048 {
  seed: number;
  /** 0 = no limit */
  timeLimitSec: number;
  /** Shortest time between two moves, so an instant player can still be followed by eye. */
  minMoveMs: number;
}

export const DEFAULTS_2048: Options2048 = { seed: 2048, timeLimitSec: 180, minMoveMs: 160 };

export const RULES_2048 =
  'You are playing 2048 on a 4x4 board. A move slides every tile as far as it goes in one direction; two equal tiles that meet merge into one tile of double the value, which scores that value. ' +
  'After every move a new 2 or 4 appears on a random empty cell. The game ends when no move is possible. The goal is the highest score.';

export const PRIORITIES_2048 = [
  'Keep the largest tile in a corner. Avoid a move that PULLS it OUT of its corner unless nothing else is possible.',
  'Avoid a move that leaves only one direction to move: the board is about to lock.',
  'Keep as many cells empty as you can; prefer moves that merge.',
  'Keep the tiles in descending order away from the corner of the largest tile, so that equal tiles end up next to each other.',
  'Between otherwise equal moves, prefer the one that scores more points.',
];

/** A tile on screen. It keeps its id while it slides, so the arena can animate it. */
export interface Tile {
  id: number;
  value: number;
  index: number;
  /** Just appeared (spawned or made by a merge): pops in. */
  born: boolean;
  /** Slid into a merge: drawn under the new tile until the next move. */
  dying: boolean;
}

export interface Side2048 {
  index: 0 | 1;
  player: Player;
  human: boolean;
  board: Board;
  tiles: Tile[];
  score: number;
  moves: number;
  best: number;
  over: boolean;
  thinking: boolean;
  move: string;
  stats: PlayerStats;
}

export interface Event2048 {
  type: 'slide' | 'merge' | 'milestone' | 'stuck';
  side: 0 | 1;
  /** For 'merge' and 'milestone': the largest tile made. */
  value?: number;
}

export interface Result2048 {
  winner: 0 | 1 | null;
  /** True when the match was stopped rather than decided. */
  stopped: boolean;
  reason: string;
  elapsedMs: number;
}

const ARROW: Record<Dir, string> = { up: '↑', right: '→', down: '↓', left: '←' };
const MILESTONES = new Set([128, 256, 512, 1024, 2048, 4096, 8192]);

/** The flat board as four rows of four numbers (0 = empty), the way code likes it. */
const rowsOf = (board: Board): number[][] => [0, 1, 2, 3].map((r) => board.slice(r * 4, r * 4 + 4));

export function build2048Request(board: Board, score: number, facts: MoveFacts[]): DecisionRequest {
  return {
    game: '2048',
    rules: RULES_2048,
    question: 'Which direction should the tiles slide? Each option states exact facts about the board right after that move, before the new random tile lands.',
    priorities: PRIORITIES_2048,
    state: {
      board_rows_top_to_bottom: boardToText(board),
      legend: 'Numbers are tiles, . is an empty cell.',
      largest_tile: maxTile(board),
      score,
    },
    options: facts.map((f) => ({ id: f.dir, description: describeMove(f) })),
    data: {
      state: { board: rowsOf(board), score, largestTile: maxTile(board) },
      options: facts.map((f) => ({
        id: f.dir,
        facts: {
          pointsGained: f.result.gained,
          merges: f.result.merges,
          emptyAfter: f.emptyAfter,
          largestTileAfter: f.maxAfter,
          largestInCornerBefore: f.cornerBefore,
          largestInCornerAfter: f.cornerAfter,
          orderAfter: Number(f.orderAfter.toFixed(3)),
          equalPairsAfter: f.pairsAfter,
          directionsLeftAfter: f.movesAfter,
          boardAfter: rowsOf(f.result.board),
        },
      })),
    },
    botChoice: () => botMove(board),
    // The clock is a match clock, not a per-move deadline, but it is running.
    realtime: true,
  };
}

export class Match2048 {
  readonly sides: [Side2048, Side2048];
  readonly options: Options2048;
  status: 'idle' | 'running' | 'done' = 'idle';
  result: Result2048 | null = null;
  error: string | null = null;

  private abort = new AbortController();
  private startedAt = 0;
  private endedAt = 0;
  private randoms: (() => number)[];
  private nextTileId = 1;
  private pendingInput: [((dir: Dir) => void) | null, ((dir: Dir) => void) | null] = [null, null];
  private timer: ReturnType<typeof setInterval> | null = null;
  private onChange: () => void;
  private emit: (event: Event2048) => void;

  constructor(players: [Player, Player], options: Options2048, onChange: () => void = () => {}, emit: (event: Event2048) => void = () => {}) {
    this.options = options;
    this.onChange = onChange;
    this.emit = emit;
    // The same seed on both sides: identical starting boards, and the same luck for the same play.
    this.randoms = [seededRandom(options.seed), seededRandom(options.seed)];
    const side = (index: 0 | 1): Side2048 => {
      const board = startBoard(this.randoms[index]);
      return {
        index,
        player: players[index],
        human: players[index].config.kind === 'human',
        board,
        tiles: board.flatMap((value, i) => (value ? [{ id: this.nextTileId++, value, index: i, born: true, dying: false }] : [])),
        score: 0,
        moves: 0,
        best: maxTile(board),
        over: false,
        thinking: false,
        move: t('m.ready'),
        stats: freshStats(),
      };
    };
    this.sides = [side(0), side(1)];
  }

  elapsed(): number {
    if (this.status === 'idle') return 0;
    return (this.status === 'done' ? this.endedAt : performance.now()) - this.startedAt;
  }

  start(): void {
    if (this.status !== 'idle') return;
    this.status = 'running';
    this.startedAt = performance.now();
    for (const side of this.sides) void this.run(side);
    if (this.options.timeLimitSec > 0) {
      this.timer = setInterval(() => {
        if (this.elapsed() >= this.options.timeLimitSec * 1000) this.checkEnd(true);
      }, 250);
    }
    this.onChange();
  }

  stop(): void {
    if (this.status === 'done') return;
    this.finish(null, t('r.stopped'), true);
  }

  /** A key press or swipe from a human seat. A direction that moves nothing is ignored. */
  input(index: 0 | 1, dir: Dir): void {
    const resolve = this.pendingInput[index];
    if (!resolve || this.status !== 'running') return;
    if (!analyze(this.sides[index].board).some((f) => f.dir === dir)) return;
    this.pendingInput[index] = null;
    resolve(dir);
  }

  private waitForInput(index: 0 | 1): Promise<Dir | null> {
    const signal = this.abort.signal;
    return new Promise((resolve) => {
      this.pendingInput[index] = resolve;
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }

  private async run(side: Side2048): Promise<void> {
    const signal = this.abort.signal;
    if (side.human) side.move = t('t.swipe');
    while (!signal.aborted) {
      const facts = analyze(side.board);
      if (facts.length === 0) {
        side.over = true;
        side.thinking = false;
        side.move = t('t.stuck', { score: side.score });
        this.emit({ type: 'stuck', side: side.index });
        this.checkEnd();
        this.onChange();
        return;
      }
      const started = performance.now();
      let dir: Dir | null = null;

      if (side.human) {
        dir = await this.waitForInput(side.index);
        if (dir === null) return;
      } else {
        const request = build2048Request(side.board, side.score, facts);
        side.thinking = true;
        this.onChange();
        let decision: Decision | null = null;
        try {
          decision = await side.player.decide(request, signal);
        } catch (err) {
          if (signal.aborted) return;
          const e = err as Error & { status?: number };
          side.stats.errors += 1;
          side.move = t('m.error', { msg: e.message });
          if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 503) this.error = `${side.player.name}: ${e.message}`;
        }
        side.thinking = false;
        if (signal.aborted) return;
        if (decision) recordDecision(side.stats, decision);
        const chosen = facts.find((f) => f.dir === decision?.optionId);
        if (chosen) {
          dir = chosen.dir;
          const took = decision!.latencyMs > 0 ? t('m.took', { ms: Math.round(decision!.latencyMs) }) : '';
          side.move = t('s.moved', { dir: ARROW[dir], took });
        } else {
          // A move cannot be skipped, so an error or an invalid answer falls back to the classic bot.
          if (decision) side.stats.invalid += 1;
          dir = request.botChoice() as Dir;
          side.move = t('s.fallback', { note: decision ? decision.note : side.move, dir: ARROW[dir] });
          // Without a pause a failing key would spin through a whole game in a blink.
          if (!decision) await sleep(500);
        }
      }

      this.apply(side, facts.find((f) => f.dir === dir)!);
      // Always a real timer, even at zero: two instant players would otherwise loop in microtasks
      // and starve the clock, the other side and the page.
      await sleep(Math.max(0, this.options.minMoveMs - (performance.now() - started)));
    }
  }

  private apply(side: Side2048, fact: MoveFacts): void {
    const { result } = fact;
    // Tiles that fused on the previous move have had their moment.
    const live = side.tiles.filter((tile) => !tile.dying);
    const byIndex = new Map(live.map((tile) => [tile.index, tile]));
    const merged = new Map<number, number>(); // cell -> new value
    const next: Tile[] = [];
    for (const s of result.slides) {
      const tile = byIndex.get(s.from);
      if (!tile) continue;
      next.push({ ...tile, index: s.to, born: false, dying: s.merged });
      if (s.merged) merged.set(s.to, s.value * 2);
    }
    for (const [index, value] of merged) next.push({ id: this.nextTileId++, value, index, born: true, dying: false });

    let board = result.board;
    const spawned = spawn(board, this.randoms[side.index]);
    if (spawned) {
      board = spawned.board;
      next.push({ id: this.nextTileId++, value: spawned.value, index: spawned.index, born: true, dying: false });
    }
    side.board = board;
    side.tiles = next;
    side.score += result.gained;
    side.moves += 1;

    const biggest = merged.size ? Math.max(...merged.values()) : 0;
    this.emit(result.merges > 0 ? { type: 'merge', side: side.index, value: biggest } : { type: 'slide', side: side.index });
    if (biggest > side.best) {
      side.best = biggest;
      if (MILESTONES.has(biggest)) this.emit({ type: 'milestone', side: side.index, value: biggest });
    }
    this.checkEnd();
    this.onChange();
  }

  /** The higher score wins. A seat left playing alone wins the moment it passes the stuck one. */
  private checkEnd(timeUp = false): void {
    if (this.status !== 'running') return;
    const [a, b] = this.sides;
    const name = (s: Side2048) => s.player.name;
    const leader = a.score === b.score ? null : a.score > b.score ? a : b;
    const bothOver = a.over && b.over;
    if (!bothOver && !timeUp) {
      const stuck = a.over ? a : b.over ? b : null;
      const playing = stuck === a ? b : a;
      if (stuck && playing.score > stuck.score) this.finish(playing.index, t('t.r.passed', { winner: name(playing), loser: name(stuck), a: playing.score, b: stuck.score }));
      return;
    }
    if (!leader) return this.finish(null, t(timeUp ? 'r.drawAtLimit' : 'r.draw'));
    const trailer = leader === a ? b : a;
    this.finish(leader.index, t(timeUp ? 't.r.time' : 't.r.score', { winner: name(leader), a: leader.score, b: trailer.score }));
  }

  private finish(winner: 0 | 1 | null, reason: string, stopped = false): void {
    if (this.status === 'done') return;
    this.endedAt = performance.now();
    if (this.status === 'idle') this.startedAt = this.endedAt;
    this.status = 'done';
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    this.pendingInput = [null, null];
    for (const side of this.sides) side.thinking = false;
    this.result = { winner, stopped, reason, elapsedMs: this.endedAt - this.startedAt };
    this.onChange();
  }
}
