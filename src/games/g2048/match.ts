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
  /** Both boards play move N together: the quick seat waits for the slow one, so only judgement counts. */
  lockstep: boolean;
  /** 0 = no deadline. A seat that has not answered by then plays the classic bot's move instead. */
  moveDeadlineSec: number;
}

export const DEFAULTS_2048: Options2048 = { seed: 2048, timeLimitSec: 180, minMoveMs: 160, lockstep: false, moveDeadlineSec: 20 };

export const RULES_2048 =
  'You are playing 2048 on a 4x4 board. A move slides every tile as far as it goes in one direction; two equal tiles that meet merge into one tile of double the value, which scores that value. ' +
  'After every move a new 2 or 4 appears on a random empty cell. The game ends when no move is possible. ' +
  'You are racing an opponent who started from the same position on a second board: when the clock runs out, or both boards are stuck, the higher score wins.';

export const PRIORITIES_2048 = [
  'Keep the largest tile in a corner. Avoid a move that PULLS it OUT of its corner unless nothing else is possible.',
  'Avoid a move that leaves only one direction to move: the board is about to lock.',
  'Keep as many cells empty as you can; prefer moves that merge.',
  'Keep the tiles in descending order away from the corner of the largest tile, so that equal tiles end up next to each other.',
  'Between otherwise equal moves, prefer the one that scores more points.',
  'Both boards share one clock. Far behind with little time left, take the risky merge; ahead, keep the board safe.',
];

/** A tile on screen. It keeps its id while it slides, so the arena can animate it. */
export interface Tile {
  id: number;
  value: number;
  index: number;
  /** Just appeared (spawned or made by a merge): pops in. */
  born: boolean;
  /** Made by a merge: it waits for its two halves to finish sliding before it pops. */
  fused: boolean;
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
  /** The move on which this seat first made a 2048 tile, if it ever did. */
  reached2048: number | null;
  /** Three hard API errors in a row: the algorithm plays this seat for the rest of the match. */
  demoted: boolean;
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

/** How the race stands, so a player can tell whether to press for points or keep the board safe. */
export interface Race2048 {
  opponentScore: number;
  /** Positive when this seat is ahead. */
  scoreGap: number;
  /** Null when the match has no clock. */
  secondsLeft: number | null;
  movesMade: number;
}

export function build2048Request(board: Board, score: number, facts: MoveFacts[], race: Race2048): DecisionRequest {
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
      opponent_score: race.opponentScore,
      you_are: race.scoreGap > 0 ? `${race.scoreGap} points ahead` : race.scoreGap < 0 ? `${-race.scoreGap} points behind` : 'level',
      time_left: race.secondsLeft === null ? 'no clock' : `${race.secondsLeft} seconds`,
      moves_made: race.movesMade,
    },
    options: facts.map((f) => ({ id: f.dir, description: describeMove(f) })),
    data: {
      state: { board: rowsOf(board), score, largestTile: maxTile(board), opponentScore: race.opponentScore, scoreGap: race.scoreGap, secondsLeft: race.secondsLeft, movesMade: race.movesMade },
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

/** What decides a finished race: how far apart two seats are, and on what. */
export type Verdict2048 = { leader: Side2048 | null; by: 'score' | 'tile' | 'moves' };

/**
 * Who won. The higher score decides. Two seats that share one seed, one pace and one way of playing
 * otherwise draw every single time, so an equal score goes to the largest tile, and an equal tile to
 * whoever needed fewer moves for it.
 */
export function verdict2048(a: Side2048, b: Side2048): Verdict2048 {
  if (a.score !== b.score) return { leader: a.score > b.score ? a : b, by: 'score' };
  if (a.best !== b.best) return { leader: a.best > b.best ? a : b, by: 'tile' };
  if (a.moves !== b.moves) return { leader: a.moves < b.moves ? a : b, by: 'moves' };
  return { leader: null, by: 'score' };
}

export class Match2048 {
  readonly sides: [Side2048, Side2048];
  readonly options: Options2048;
  status: 'idle' | 'running' | 'done' = 'idle';
  result: Result2048 | null = null;
  error: string | null = null;
  /** Which seat made a 2048 tile first, whatever the final score says. */
  first2048: 0 | 1 | null = null;

  private abort = new AbortController();
  private hardErrors: [number, number] = [0, 0];
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
        tiles: board.flatMap((value, i) => (value ? [{ id: this.nextTileId++, value, index: i, born: true, fused: false, dying: false }] : [])),
        score: 0,
        moves: 0,
        best: maxTile(board),
        over: false,
        thinking: false,
        move: t('m.ready'),
        reached2048: null,
        demoted: false,
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

  /** A person gives up. The arena only offers it once the other board is stuck, so a live race is safe. */
  concede(index: 0 | 1): void {
    if (this.status !== 'running') return;
    const loser = this.sides[index];
    const winner = this.sides[index === 0 ? 1 : 0];
    this.finish(winner.index, t('t.r.conceded', { winner: winner.player.name, loser: loser.player.name }));
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
      // The listener goes as soon as the move is made: one per move would otherwise pile up all game.
      const onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingInput[index] = (dir) => {
        signal.removeEventListener('abort', onAbort);
        resolve(dir);
      };
    });
  }

  /** Lockstep: hold this seat until the other board has played as many moves, or cannot play at all. */
  private async waitForPartner(side: Side2048): Promise<void> {
    const other = this.sides[side.index === 0 ? 1 : 0];
    while (!this.abort.signal.aborted && !other.over && other.moves < side.moves) await sleep(25);
  }

  /** How the race stands from this seat's point of view. */
  private race(side: Side2048): Race2048 {
    const other = this.sides[side.index === 0 ? 1 : 0];
    const limit = this.options.timeLimitSec;
    return {
      opponentScore: other.score,
      scoreGap: side.score - other.score,
      secondsLeft: limit > 0 ? Math.max(0, Math.round(limit - this.elapsed() / 1000)) : null,
      movesMade: side.moves,
    };
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
      } else if (side.demoted) {
        dir = botMove(side.board);
        side.move = t('t.demoted', { dir: ARROW[dir] });
      } else {
        const request = build2048Request(side.board, side.score, facts, this.race(side));
        side.thinking = true;
        this.onChange();
        // A deadline of its own, so one request that never comes back cannot freeze the seat for good.
        const move = new AbortController();
        const onMatchAbort = () => move.abort();
        signal.addEventListener('abort', onMatchAbort, { once: true });
        const deadline = this.options.moveDeadlineSec > 0 ? setTimeout(() => move.abort(), this.options.moveDeadlineSec * 1000) : null;
        let decision: Decision | null = null;
        let late = false;
        try {
          decision = await side.player.decide(request, move.signal);
        } catch (err) {
          if (signal.aborted) return;
          if (move.signal.aborted) {
            late = true;
            side.stats.missed += 1;
          } else {
            const e = err as Error & { status?: number };
            side.stats.errors += 1;
            // A call that failed is still a call: leaving it out would flatter the seat's averages.
            recordDecision(side.stats, { optionId: null, latencyMs: performance.now() - started, inputTokens: 0, outputTokens: 0, cost: 0, note: e.message });
            side.move = t('m.error', { msg: e.message });
            if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 503) {
              this.error = `${side.player.name}: ${e.message}`;
              // A key that is not there will not mend itself: stop paying for the same error every move.
              if ((this.hardErrors[side.index] += 1) >= 3) side.demoted = true;
            }
          }
        } finally {
          if (deadline !== null) clearTimeout(deadline);
          signal.removeEventListener('abort', onMatchAbort);
        }
        side.thinking = false;
        if (signal.aborted) return;
        if (decision) {
          recordDecision(side.stats, decision);
          this.hardErrors[side.index] = 0;
        }
        const chosen = facts.find((f) => f.dir === decision?.optionId);
        if (chosen) {
          dir = chosen.dir;
          const took = decision!.latencyMs > 0 ? t('m.took', { ms: Math.round(decision!.latencyMs) }) : '';
          side.move = t('s.moved', { dir: ARROW[dir], took });
        } else {
          // A move cannot be skipped, so a late answer, an error or an invalid one falls back to the bot.
          if (decision) side.stats.invalid += 1;
          dir = request.botChoice() as Dir;
          side.move = late ? t('t.late', { dir: ARROW[dir] }) : t('s.fallback', { note: decision ? decision.note : side.move, dir: ARROW[dir] });
          // Without a pause a failing key would spin through a whole game in a blink.
          if (!decision && !late) await sleep(500);
          // The match can end during that pause, and a move played after the result is written
          // would leave the final scores disagreeing with the sentence that announced them.
          if (signal.aborted) return;
        }
      }

      this.apply(side, facts.find((f) => f.dir === dir)!);
      // Always a real timer, even at zero: two instant players would otherwise loop in microtasks
      // and starve the clock, the other side and the page.
      await sleep(Math.max(0, this.options.minMoveMs - (performance.now() - started)));
      if (this.options.lockstep) await this.waitForPartner(side);
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
      next.push({ ...tile, index: s.to, born: false, fused: false, dying: s.merged });
      if (s.merged) merged.set(s.to, s.value * 2);
    }
    for (const [index, value] of merged) next.push({ id: this.nextTileId++, value, index, born: true, fused: true, dying: false });

    let board = result.board;
    const spawned = spawn(board, this.randoms[side.index]);
    if (spawned) {
      board = spawned.board;
      next.push({ id: this.nextTileId++, value: spawned.value, index: spawned.index, born: true, fused: false, dying: false });
    }
    side.board = board;
    side.tiles = next;
    side.score += result.gained;
    side.moves += 1;

    const biggest = merged.size ? Math.max(...merged.values()) : 0;
    this.emit(result.merges > 0 ? { type: 'merge', side: side.index, value: biggest } : { type: 'slide', side: side.index });
    if (biggest > side.best && MILESTONES.has(biggest)) this.emit({ type: 'milestone', side: side.index, value: biggest });
    if (biggest >= 2048 && side.reached2048 === null) {
      side.reached2048 = side.moves;
      if (this.first2048 === null) this.first2048 = side.index;
    }
    // A tile can also arrive by spawning, so the largest one comes from the board, not from the merges.
    side.best = Math.max(side.best, maxTile(board));
    this.checkEnd();
    this.onChange();
  }

  /** The higher score wins. A seat left playing alone wins the moment it passes the stuck one. */
  private checkEnd(timeUp = false): void {
    if (this.status !== 'running') return;
    const [a, b] = this.sides;
    const name = (s: Side2048) => s.player.name;
    const bothOver = a.over && b.over;
    if (!bothOver && !timeUp) {
      const stuck = a.over ? a : b.over ? b : null;
      const playing = stuck === a ? b : a;
      // Only a lead on points ends it early: a tiebreak can still turn over while one board plays on.
      if (stuck && playing.score > stuck.score) this.finish(playing.index, t('t.r.passed', { winner: name(playing), loser: name(stuck), a: playing.score, b: stuck.score }));
      return;
    }
    const { leader, by } = verdict2048(a, b);
    if (!leader) return this.finish(null, t(timeUp ? 'r.drawAtLimit' : 'r.draw'));
    const trailer = leader === a ? b : a;
    const reason =
      by === 'tile'
        ? t('t.r.tile', { winner: name(leader), score: leader.score, tile: leader.best })
        : by === 'moves'
          ? t('t.r.fewer', { winner: name(leader), a: leader.moves, b: trailer.moves })
          : t(timeUp ? 't.r.time' : 't.r.score', { winner: name(leader), a: leader.score, b: trailer.score });
    this.finish(leader.index, reason);
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
