// A two-snake duel on a fixed clock. No DOM: the arena draws `state` and forwards key presses to
// `input()`. The loop follows jev-snake's controller: every seat is asked at the start of a tick,
// whatever has arrived when the tick ends is played, and a snake with no answer goes straight.

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
  botMove,
  createDuel,
  describeMove,
  duelToText,
  fallbackMove,
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
  /** 0 = no limit */
  timeLimitSec: number;
}

export const SNAKE_DEFAULTS: SnakeOptions = { seed: 7, cols: 20, rows: 16, tickMs: 600, tickAuto: true, lockstep: false, timeLimitSec: 180 };

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
  return kinds.includes('human') ? 170 : 110;
}

export const SNAKE_RULES =
  'You are playing a two-player game of Snake on one shared grid. Choose the direction your snake\'s head moves on the next step. ' +
  'Both snakes move at the same time. A snake dies when its head hits a wall, its own body or the other snake\'s body; if both heads move into the same cell, both die. ' +
  'A snake grows by one when it eats the food. If your opponent dies and you do not, you win. ' +
  'Every listed direction is safe from walls and bodies for this single step; the facts next to each direction were computed by code and are exact.';

export const SNAKE_PRIORITIES = [
  'Never choose a move marked DEAD END if another move exists: it almost always loses a few steps later.',
  'Avoid a move marked RISK (head-on collision) unless every other move is a dead end.',
  'Eat the food when it is safe to. Otherwise prefer the move that brings the head closer to the food.',
  'If the opponent is much closer to the food, do not race for it: keep room instead.',
  'With nothing else to separate two moves, keep more empty cells reachable.',
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
  type: 'eat' | 'die' | 'turn';
  seat: 0 | 1;
}

export interface SnakeResult {
  winner: 0 | 1 | null;
  /** True when the match was stopped rather than decided. */
  stopped: boolean;
  reason: string;
  elapsedMs: number;
}

const ARROW: Record<Dir, string> = { up: '↑', right: '→', down: '↓', left: '←' };
const DEATH_KEY: Record<Death, TextKey> = { wall: 's.death.wall', self: 's.death.self', other: 's.death.other', head_on: 's.death.headOn' };

export function buildSnakeRequest(state: DuelState, me: 0 | 1, facts: MoveFacts[], realtime: boolean): DecisionRequest {
  const mine = state.snakes[me];
  const theirs = state.snakes[1 - me];
  const at = (p: Point) => ({ row: p.r, col: p.c });
  const distance = (p: Point) => (state.food ? Math.abs(state.food.r - p.r) + Math.abs(state.food.c - p.c) : null);
  return {
    game: 'snake',
    rules: SNAKE_RULES,
    question: 'Which direction should your snake (A) move on the next step? Each option states exact facts about that move.',
    priorities: SNAKE_PRIORITIES,
    state: {
      board: duelToText(state, me),
      legend: SNAKE_LEGEND,
      grid_size: { rows: state.rows, cols: state.cols },
      your_head: at(mine.body[0]),
      your_heading: mine.heading,
      your_length: mine.body.length,
      opponent_head: at(theirs.body[0]),
      opponent_heading: theirs.heading,
      opponent_length: theirs.body.length,
      food: state.food ? at(state.food) : null,
      your_steps_to_food: distance(mine.body[0]),
      opponent_steps_to_food: distance(theirs.body[0]),
    },
    options: facts.map((f) => ({ id: f.dir, description: describeMove(f) })),
    data: {
      state: {
        board: duelToText(state, me),
        cols: state.cols,
        rows: state.rows,
        yourHead: at(mine.body[0]),
        yourHeading: mine.heading,
        yourLength: mine.body.length,
        opponentHead: at(theirs.body[0]),
        opponentHeading: theirs.heading,
        opponentLength: theirs.body.length,
        food: state.food ? at(state.food) : null,
        yourStepsToFood: distance(mine.body[0]),
        opponentStepsToFood: distance(theirs.body[0]),
      },
      options: facts.map((f) => ({
        id: f.dir,
        facts: {
          turn: f.turn,
          targetRow: f.target.r,
          targetCol: f.target.c,
          eats: f.eats,
          foodDistance: f.foodDistance,
          reachable: f.reachable,
          freeTotal: f.freeTotal,
          deadEnd: f.deadEnd,
          canReachTail: f.canReachTail,
          headOnRisk: f.headOnRisk,
        },
      })),
    },
    botChoice: () => botMove(facts),
    realtime,
  };
}

export class SnakeMatch {
  readonly seats: [SnakeSeat, SnakeSeat];
  readonly options: SnakeOptions;
  readonly tickMs: number;
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
  private queued: [Dir | null, Dir | null] = [null, null];
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

  elapsed(): number {
    if (this.status === 'idle') return 0;
    return (this.status === 'done' ? this.endedAt : performance.now()) - this.startedAt;
  }

  start(): void {
    if (this.status !== 'idle') return;
    this.status = 'running';
    this.startedAt = performance.now();
    for (const seat of this.seats) if (seat.human) seat.move = t('s.steer');
    void this.run();
    this.onChange();
  }

  stop(): void {
    if (this.status === 'done') return;
    this.finish(null, t('r.stopped'), true);
  }

  /** A person steers: the direction is played at the next step. A 180° turn is ignored. */
  input(index: 0 | 1, dir: Dir): void {
    const seat = this.seats[index];
    const snake = this.state.snakes[index];
    if (!seat.human || this.status !== 'running' || !snake.alive || dir === OPPOSITE[snake.heading]) return;
    if (this.queued[index] !== dir && dir !== snake.heading) this.emit({ type: 'turn', seat: index });
    this.queued[index] = dir;
  }

  private async run(): Promise<void> {
    const matchSignal = this.abort.signal;
    while (!matchSignal.aborted) {
      const tick = new AbortController();
      const onMatchAbort = () => tick.abort();
      matchSignal.addEventListener('abort', onMatchAbort, { once: true });
      const tickStarted = performance.now();
      const state = this.state;
      const chosen: [Dir | null, Dir | null] = [null, null];
      const notes: [string, string] = ['', ''];
      const asked: Promise<void>[] = [];

      for (const seat of this.seats) {
        const i = seat.index;
        if (seat.human || !state.snakes[i].alive) continue;
        const facts = analyze(state, i);
        if (facts.length < 2) {
          // Nothing to decide: one way out, or none at all.
          chosen[i] = facts[0]?.dir ?? state.snakes[i].heading;
          notes[i] = t('s.forced', { dir: ARROW[chosen[i]!] });
          continue;
        }
        seat.thinking = true;
        asked.push(
          seat.player.decide(buildSnakeRequest(state, i, facts, !this.options.lockstep), tick.signal).then(
            (decision: Decision) => {
              if (tick.signal.aborted) return; // arrived after the step was played
              seat.thinking = false;
              recordDecision(seat.stats, decision);
              const fact = facts.find((f) => f.dir === decision.optionId);
              if (!fact) {
                seat.stats.invalid += 1;
                chosen[i] = botMove(facts);
                notes[i] = t('s.fallback', { note: decision.note, dir: ARROW[chosen[i]!] });
                return;
              }
              chosen[i] = fact.dir;
              const took = decision.latencyMs > 0 ? t('m.took', { ms: Math.round(decision.latencyMs) }) : '';
              notes[i] = t(fact.eats ? 's.ate' : 's.moved', { dir: ARROW[fact.dir], took });
              this.onChange();
            },
            (err: Error & { status?: number }) => {
              if (tick.signal.aborted) return;
              seat.thinking = false;
              seat.stats.errors += 1;
              chosen[i] = botMove(facts);
              notes[i] = t('m.error', { msg: err.message });
              if (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 503) this.error = `${seat.player.name}: ${err.message}`;
            },
          ),
        );
      }
      this.onChange();

      // The clock decides when the step happens; lockstep also waits for every answer.
      const clock = sleep(this.tickMs);
      await (this.options.lockstep ? Promise.all([clock, ...asked]) : clock);
      tick.abort();
      matchSignal.removeEventListener('abort', onMatchAbort);
      if (matchSignal.aborted) return;

      const dirs = this.seats.map((seat): Dir => {
        const i = seat.index;
        seat.thinking = false;
        if (!state.snakes[i].alive) return state.snakes[i].heading;
        if (seat.human) {
          const dir = this.queued[i] ?? state.snakes[i].heading;
          this.queued[i] = null;
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

      const next = stepDuel(state, dirs);
      this.previous = [state.snakes[0].body, state.snakes[1].body];
      this.steppedAt = performance.now();
      this.state = next;
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
    for (const seat of this.seats) seat.thinking = false;
    this.result = { winner, stopped, reason, elapsedMs: this.endedAt - this.startedAt };
    this.onChange();
  }
}
