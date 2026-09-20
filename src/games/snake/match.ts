// A two-snake duel on a fixed clock. No DOM: the arena draws `state` and forwards key presses to
// `input()`. The loop follows jev-snake's controller: every seat is asked at the start of a tick,
// whatever has arrived when the tick ends is played, and a snake with no answer goes straight.
//
// A question is never thrown away at the deadline: the answer still arrives, is still counted (it
// cost tokens), and is only too late to be played. The seat is asked again once its last question
// has been answered, or after two ticks, whichever comes first.

import type { Decision, DecisionRequest, Player, PlayerStats } from '../../core/types';
import { freshStats, recordDecision, sleep } from '../../core/types';
import { t, type TextKey } from '../../core/i18n';
import {
  type Death,
  type Dir,
  type DuelState,
  type MoveFacts,
  type Point,
  OPPOSITE,
  SNAKE_LEGEND,
  analyze,
  arenaCells,
  botMove,
  createDuel,
  describeMove,
  duelToText,
  fallbackMove,
  fullyClosed,
  shrinkDuel,
  stepDuel,
} from './engine';

export interface SnakeOptions {
  seed: number;
  cols: number;
  rows: number;
  /** ms per step. With `tickAuto` the arena picks it from who is playing. */
  tickMs: number;
  tickAuto: boolean;
  /** A tick also waits for every AI answer, so nobody is ever late. */
  lockstep: boolean;
  /** Halfway through, the walls start closing in, so a match cannot circle forever. */
  suddenDeath: boolean;
  /** 0 = no limit */
  timeLimitSec: number;
}

export const SNAKE_DEFAULTS: SnakeOptions = { seed: 7, cols: 20, rows: 16, tickMs: 600, tickAuto: true, lockstep: false, suddenDeath: true, timeLimitSec: 180 };

/** In lockstep the clock only has to look good: the step waits for the answers, not for this. */
const LOCKSTEP_FLOOR_MS = 320;
/** A question still unanswered after this many ticks is abandoned and asked again. */
const ASK_AGAIN_TICKS = 2;
/** How many states the arena can scrub back through when the match is over. */
const HISTORY_LIMIT = 1500;
/** How long a match with no clock is assumed to run, for pacing the closing walls. */
const UNLIMITED_STEPS = 400;

/**
 * A tick long enough for the slowest seat to usually answer in time. Measured through this proxy:
 * Jev averages 0.3 to 0.4 s on a snake question and DeepSeek V4.1 Flash 1.4 s, but both have slow
 * outliers: at 650 ms Jev was late on 16 of 78 steps, at 1800 ms DeepSeek on 4 of 26.
 */
export function recommendedTickMs(kinds: [string, string], thinking: boolean, models: (string | undefined)[] = []): number {
  // Slower providers, from the same probe: GPT-5.6 Luna took 2.5 to 5.5 s, Gemini 3.7 Flash 3.4 to 5.3 s
  // (it cannot switch thinking off). Thinking adds several seconds to any of them.
  const slowest = Math.max(0, ...models.map((m) => (m?.startsWith('google/') ? 6000 : m?.startsWith('openai/') ? 5000 : 0)));
  if (thinking) return Math.max(8000, slowest);
  if (kinds.includes('llm')) return Math.max(2200, slowest);
  if (kinds.includes('jev')) return 900;
  // A generated algorithm runs in a Worker: milliseconds once warm, but it is given a 1.5 s budget.
  if (kinds.includes('custom')) return 300;
  return kinds.includes('human') ? 170 : 110;
}

export const SNAKE_RULES =
  'You are playing a two-player game of Snake on one shared grid. Choose the direction your snake\'s head moves on the next step. ' +
  'Both snakes move at the same time. A snake dies when its head hits a wall, its own body or the other snake\'s body; if both heads move into the same cell, both die. ' +
  'A snake grows by one when it eats the food. If your opponent dies and you do not, you win. ' +
  'The match also has a clock, and when it runs out THE LONGER SNAKE WINS — the same rule settles it when both snakes die on one step, and equal length is a draw. So staying alive is not enough: eat. ' +
  'Late in the match the walls close in one ring at a time, and a snake caught outside the arena dies. ' +
  'Every listed direction is safe from walls and bodies for this single step; the facts next to each direction were computed by code and are exact.';

export const SNAKE_PRIORITIES = [
  'Never choose a move marked DEAD END if another move exists: it almost always loses a few steps later.',
  'Avoid a move marked RISK (head-on collision) unless every other move is a dead end. If the fact says you would win that head-on on length, it is not a risk but a way to win.',
  'Eat the food when it is safe to: length is what decides the match when the clock runs out.',
  'Do not race for food the opponent will clearly reach first, and never chase it into a space smaller than your own length.',
  'With nothing else to separate two moves, keep more reachable cells, and prefer the cells the opponent cannot reach first.',
];

export interface SnakeSeat {
  index: 0 | 1;
  player: Player;
  human: boolean;
  thinking: boolean;
  move: string;
  /** Ticks where no answer arrived in time and the snake went straight. */
  late: number;
  stats: PlayerStats;
}

export interface SnakeEvent {
  type: 'eat' | 'die' | 'turn' | 'shrink';
  seat: 0 | 1;
}

export interface SnakeResult {
  winner: 0 | 1 | null;
  /** True when the match was stopped rather than decided. */
  stopped: boolean;
  reason: string;
  elapsedMs: number;
}

/** What a player cannot read off the board: how long the match still has to run. */
export interface SnakeContext {
  secondsLeft: number | null;
  stepsToShrink: number | null;
}

const NO_CONTEXT: SnakeContext = { secondsLeft: null, stepsToShrink: null };

const ARROW: Record<Dir, string> = { up: '↑', right: '→', down: '↓', left: '←' };
const DEATH_KEY: Record<Death, TextKey> = { wall: 's.death.wall', self: 's.death.self', other: 's.death.other', head_on: 's.death.headOn' };

export function buildSnakeRequest(state: DuelState, me: 0 | 1, facts: MoveFacts[], realtime: boolean, context: SnakeContext = NO_CONTEXT): DecisionRequest {
  const mine = state.snakes[me];
  const theirs = state.snakes[1 - me];
  const at = (p: Point) => ({ row: p.r, col: p.c });
  const arena = { top: state.margin, left: state.margin, bottom: state.rows - 1 - state.margin, right: state.cols - 1 - state.margin };
  return {
    game: 'snake',
    rules: SNAKE_RULES,
    question: 'Which direction should your snake (A) move on the next step? Each option states exact facts about that move.',
    priorities: SNAKE_PRIORITIES,
    state: {
      board: duelToText(state, me),
      legend: SNAKE_LEGEND,
      grid_size: { rows: state.rows, cols: state.cols },
      arena_inside_the_walls: arena,
      your_head: at(mine.body[0]),
      your_heading: mine.heading,
      your_length: mine.body.length,
      your_food_eaten: mine.eaten,
      opponent_head: at(theirs.body[0]),
      opponent_heading: theirs.heading,
      opponent_length: theirs.body.length,
      opponent_food_eaten: theirs.eaten,
      food: state.food ? at(state.food) : null,
      step: state.steps,
      seconds_left: context.secondsLeft,
      steps_until_the_walls_close_in: context.stepsToShrink,
      who_is_winning_on_length: mine.body.length === theirs.body.length ? 'a draw at this length' : mine.body.length > theirs.body.length ? 'you are' : 'the opponent is',
    },
    options: facts.map((f) => ({ id: f.dir, description: describeMove(f) })),
    data: {
      state: {
        board: duelToText(state, me),
        cols: state.cols,
        rows: state.rows,
        margin: state.margin,
        yourHead: at(mine.body[0]),
        yourHeading: mine.heading,
        yourLength: mine.body.length,
        yourEaten: mine.eaten,
        opponentHead: at(theirs.body[0]),
        opponentHeading: theirs.heading,
        opponentLength: theirs.body.length,
        opponentEaten: theirs.eaten,
        food: state.food ? at(state.food) : null,
        step: state.steps,
        secondsLeft: context.secondsLeft,
        stepsToShrink: context.stepsToShrink,
      },
      options: facts.map((f) => ({
        id: f.dir,
        facts: {
          turn: f.turn,
          targetRow: f.target.r,
          targetCol: f.target.c,
          eats: f.eats,
          foodDistance: f.foodDistance,
          foodReachable: f.foodReachable,
          reachable: f.reachable,
          freeTotal: f.freeTotal,
          territory: f.territory,
          deadEnd: f.deadEnd,
          canReachTail: f.canReachTail,
          headOnRisk: f.headOnRisk,
          headOnWins: f.headOnWins,
        },
      })),
    },
    botChoice: () => botMove(state, me, facts),
    realtime,
  };
}

/** One question in flight for one seat. It outlives the tick that asked it. */
interface Ask {
  control: AbortController;
  startedAt: number;
}

export class SnakeMatch {
  readonly seats: [SnakeSeat, SnakeSeat];
  readonly options: SnakeOptions;
  readonly tickMs: number;
  /** Every state the match has been in, for the replay slider once it is over. */
  readonly history: DuelState[] = [];
  state: DuelState;
  /** Bodies before the last step, and when it happened: the arena slides between the two. */
  previous: [Point[], Point[]] | null = null;
  steppedAt = 0;
  status: 'idle' | 'running' | 'done' = 'idle';
  result: SnakeResult | null = null;
  error: string | null = null;

  private abort = new AbortController();
  private startedAt = 0;
  private endedAt = 0;
  /** Up to two turns ahead, so a quick double tap around a corner is not lost. */
  private queued: [Dir[], Dir[]] = [[], []];
  private pending: [Ask | null, Ask | null] = [null, null];
  private rings = 0;
  private onChange: () => void;
  private emit: (event: SnakeEvent) => void;

  constructor(players: [Player, Player], options: SnakeOptions, onChange: () => void = () => {}, emit: (event: SnakeEvent) => void = () => {}) {
    this.options = options;
    this.onChange = onChange;
    this.emit = emit;
    const kinds = players.map((p) => p.config.kind) as [string, string];
    const llms = players.filter((p) => p.config.kind === 'llm');
    this.tickMs = options.tickAuto ? recommendedTickMs(kinds, llms.some((p) => p.config.thinking === true), llms.map((p) => p.config.model)) : options.tickMs;
    this.state = createDuel({ cols: options.cols, rows: options.rows, seed: options.seed });
    this.history.push(this.state);
    this.planShrink();
    const seat = (index: 0 | 1): SnakeSeat => ({
      index,
      player: players[index],
      human: players[index].config.kind === 'human',
      thinking: false,
      move: t('m.ready'),
      late: 0,
      stats: freshStats(),
    });
    this.seats = [seat(0), seat(1)];
  }

  /** How many rings can close in at all on this grid. */
  private planShrink(): void {
    if (!this.options.suddenDeath) return;
    for (let margin = this.state.margin; !fullyClosed({ cols: this.state.cols, rows: this.state.rows, margin }); margin++) this.rings += 1;
  }

  /** How far through the match we are: by the clock, or by a nominal length when there is none. */
  private progress(state: DuelState): number {
    if (this.options.timeLimitSec > 0) return this.elapsed() / (this.options.timeLimitSec * 1000);
    return state.steps / UNLIMITED_STEPS;
  }

  /** Ring `k` (1-based) is due this far into the match: the first at halfway, then evenly. */
  private ringDue(k: number): number {
    return 0.5 + (0.5 * (k - 1)) / this.rings;
  }

  /** How long one step lasts on screen. In lockstep the answers set the pace, not the clock. */
  get stepBudgetMs(): number {
    return this.options.lockstep ? Math.min(this.tickMs, LOCKSTEP_FLOOR_MS) : this.tickMs;
  }

  /** Steps until the walls close in again, or null when they never will. */
  stepsToShrink(): number | null {
    if (this.rings === 0 || fullyClosed(this.state)) return null;
    const due = this.ringDue(this.state.margin + 1);
    if (this.options.timeLimitSec <= 0) return Math.max(0, Math.round(due * UNLIMITED_STEPS) - this.state.steps);
    return Math.max(0, Math.round((due * this.options.timeLimitSec * 1000 - this.elapsed()) / this.stepBudgetMs));
  }

  secondsLeft(): number | null {
    if (this.options.timeLimitSec <= 0) return null;
    return Math.max(0, Math.round((this.options.timeLimitSec * 1000 - this.elapsed()) / 1000));
  }

  elapsed(): number {
    if (this.status === 'idle') return 0;
    return (this.status === 'done' ? this.endedAt : performance.now()) - this.startedAt;
  }

  start(): void {
    if (this.status !== 'idle') return;
    this.status = 'running';
    this.startedAt = performance.now();
    for (const seat of this.seats) if (seat.human) seat.move = t('s.steer');
    // A generated algorithm's Worker boots on its first call; ask it one throw-away question now so
    // that the first tick meets a warm one. Nothing is recorded, and only local players are warmed.
    for (const seat of this.seats) {
      if (seat.player.config.kind !== 'custom') continue;
      void seat.player.decide(buildSnakeRequest(this.state, seat.index, analyze(this.state, seat.index), false), this.abort.signal).catch(() => {});
    }
    void this.run();
    this.onChange();
  }

  stop(): void {
    if (this.status === 'done') return;
    this.finish(null, t('r.stopped'), true);
  }

  /**
   * A person steers: the direction is played at the next step. Up to two turns are kept, so tapping
   * up then left around a corner works; a 180° turn on what is already queued is ignored.
   */
  input(index: 0 | 1, dir: Dir): void {
    const seat = this.seats[index];
    const snake = this.state.snakes[index];
    if (!seat.human || this.status !== 'running' || !snake.alive) return;
    const queue = this.queued[index];
    const last = queue.length > 0 ? queue[queue.length - 1] : snake.heading;
    if (dir === last || dir === OPPOSITE[last] || queue.length >= 2) return;
    queue.push(dir);
    this.emit({ type: 'turn', seat: index });
  }

  private async run(): Promise<void> {
    const matchSignal = this.abort.signal;
    while (!matchSignal.aborted) {
      const tickStarted = performance.now();
      const state = this.state;
      const chosen: [Dir | null, Dir | null] = [null, null];
      const notes: [string, string] = ['', ''];
      const deadline = { passed: false };
      const asked: Promise<void>[] = [];

      for (const seat of this.seats) {
        const i = seat.index;
        if (seat.human || !state.snakes[i].alive) continue;
        const waiting = this.pending[i];
        if (waiting) {
          // Still thinking about the last position. Give it one more tick before starting over.
          if (tickStarted - waiting.startedAt < ASK_AGAIN_TICKS * this.tickMs) continue;
          waiting.control.abort();
          this.pending[i] = null;
        }
        const facts = analyze(state, i);
        if (facts.length < 2) {
          // Nothing to decide: one way out, or none at all.
          chosen[i] = facts[0]?.dir ?? state.snakes[i].heading;
          notes[i] = t('s.forced', { dir: ARROW[chosen[i]!] });
          continue;
        }
        const ask: Ask = { control: new AbortController(), startedAt: tickStarted };
        this.pending[i] = ask;
        seat.thinking = true;
        const request = buildSnakeRequest(state, i, facts, !this.options.lockstep, { secondsLeft: this.secondsLeft(), stepsToShrink: this.stepsToShrink() });
        asked.push(
          seat.player.decide(request, ask.control.signal).then(
            (decision: Decision) => {
              if (ask.control.signal.aborted) return; // abandoned, or the match is over
              this.pending[i] = null;
              seat.thinking = false;
              // It was answered, so it is counted, even when it comes too late to be played.
              recordDecision(seat.stats, decision);
              const fact = facts.find((f) => f.dir === decision.optionId);
              if (!fact) seat.stats.invalid += 1;
              if (deadline.passed) {
                seat.move = t('s.lateAnswer', { ms: Math.round(decision.latencyMs) });
                this.onChange();
                return;
              }
              if (!fact) {
                chosen[i] = botMove(state, i, facts);
                notes[i] = t('s.fallback', { note: decision.note, dir: ARROW[chosen[i]!] });
                return;
              }
              chosen[i] = fact.dir;
              const took = decision.latencyMs > 0 ? t('m.took', { ms: Math.round(decision.latencyMs) }) : '';
              notes[i] = t(fact.eats ? 's.ate' : 's.moved', { dir: ARROW[fact.dir], took });
              this.onChange();
            },
            (err: Error & { status?: number }) => {
              if (ask.control.signal.aborted) return;
              this.pending[i] = null;
              seat.thinking = false;
              seat.stats.errors += 1;
              if (!deadline.passed) {
                chosen[i] = botMove(state, i, facts);
                notes[i] = t('m.error', { msg: err.message });
              }
              if (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 503) this.error = `${seat.player.name}: ${err.message}`;
              this.onChange();
            },
          ),
        );
      }
      this.onChange();

      // The clock decides when the step happens; lockstep also waits for every answer.
      const left = this.options.timeLimitSec > 0 ? this.options.timeLimitSec * 1000 - this.elapsed() : Infinity;
      const clock = sleep(Math.max(0, Math.min(this.stepBudgetMs, left)));
      await (this.options.lockstep ? Promise.all([clock, ...asked]) : clock);
      deadline.passed = true;
      if (matchSignal.aborted) return;

      const dirs = this.seats.map((seat): Dir => {
        const i = seat.index;
        // A question that outlived its tick is still being thought about.
        seat.thinking = this.pending[i] !== null;
        if (!state.snakes[i].alive) return state.snakes[i].heading;
        if (seat.human) {
          const dir = this.queued[i].shift() ?? state.snakes[i].heading;
          seat.move = t('s.steered', { dir: ARROW[dir] });
          return dir;
        }
        if (chosen[i]) {
          seat.move = notes[i];
          return chosen[i]!;
        }
        seat.late += 1;
        seat.stats.missed += 1;
        const dir = fallbackMove(state, i);
        seat.move = t('s.late', { ms: Math.round(performance.now() - tickStarted), dir: ARROW[dir] });
        return dir;
      }) as [Dir, Dir];

      let next = stepDuel(state, dirs);
      if (this.rings > 0 && !fullyClosed(next) && this.progress(next) >= this.ringDue(next.margin + 1)) {
        const closed = shrinkDuel(next);
        if (closed !== next) {
          next = closed;
          this.emit({ type: 'shrink', seat: 0 });
        }
      }
      this.previous = [state.snakes[0].body, state.snakes[1].body];
      this.steppedAt = performance.now();
      this.state = next;
      if (this.history.length < HISTORY_LIMIT) this.history.push(next);
      for (const i of [0, 1] as const) {
        if (next.snakes[i].eaten > state.snakes[i].eaten) this.emit({ type: 'eat', seat: i });
        if (state.snakes[i].alive && !next.snakes[i].alive) {
          this.emit({ type: 'die', seat: i });
          this.seats[i].move = t(DEATH_KEY[next.snakes[i].death!]);
        }
      }
      if (this.checkEnd()) return;
      this.onChange();
    }
  }

  /** One snake left alive wins. If both die on the same step, or the clock runs out, the longer one does. */
  private checkEnd(): boolean {
    const [a, b] = this.state.snakes;
    const name = (i: 0 | 1) => this.seats[i].player.name;
    const byLength = (key: TextKey, drawKey: TextKey) => {
      if (a.body.length === b.body.length) return this.finish(null, t(drawKey));
      const winner = a.body.length > b.body.length ? 0 : 1;
      this.finish(winner, t(key, { winner: name(winner), a: this.state.snakes[winner].body.length, b: this.state.snakes[1 - winner].body.length }));
    };
    if (!a.alive && !b.alive) {
      byLength('s.r.bothLonger', a.death === 'head_on' ? 's.r.headOnDraw' : 's.r.bothDraw');
      return true;
    }
    if (!a.alive || !b.alive) {
      const loser = a.alive ? 1 : 0;
      this.finish(loser === 0 ? 1 : 0, t('s.r.crashed', { winner: name(loser === 0 ? 1 : 0), loser: name(loser), how: t(DEATH_KEY[this.state.snakes[loser].death!]) }));
      return true;
    }
    if (this.state.food === null) {
      byLength('s.r.fullLonger', 's.r.fullDraw');
      return true;
    }
    if (this.options.timeLimitSec > 0 && this.elapsed() >= this.options.timeLimitSec * 1000) {
      byLength('s.r.timeLonger', 'r.drawAtLimit');
      return true;
    }
    return false;
  }

  private finish(winner: 0 | 1 | null, reason: string, stopped = false): void {
    if (this.status === 'done') return;
    this.endedAt = performance.now();
    if (this.status === 'idle') this.startedAt = this.endedAt;
    this.status = 'done';
    this.abort.abort();
    for (const ask of this.pending) ask?.control.abort();
    this.pending = [null, null];
    for (const seat of this.seats) seat.thinking = false;
    this.result = { winner, stopped, reason, elapsedMs: this.endedAt - this.startedAt };
    this.onChange();
  }
}

/** How much of the grid is still inside the walls, as a percentage, for the arena's badge. */
export function arenaPercent(state: DuelState): number {
  return Math.round((arenaCells(state) / (state.cols * state.rows)) * 100);
}
