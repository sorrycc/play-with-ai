import { describe, expect, it } from 'vitest';
import type { Decision, DecisionRequest, Player } from '../src/core/types';
import {
  type DuelState,
  type Point,
  type Snake,
  analyze,
  analyzeMove,
  botMove,
  createDuel,
  describeMove,
  duelToText,
  fallbackMove,
  legalMoves,
  stepDuel,
} from '../src/games/snake/engine';
import { SnakeMatch, buildSnakeRequest, recommendedTickMs } from '../src/games/snake/match';

const snake = (body: [number, number][], heading: Snake['heading']): Snake => ({
  body: body.map(([r, c]): Point => ({ r, c })),
  heading,
  alive: true,
  death: null,
  eaten: 0,
});

/** A 10x10 duel with hand-placed snakes; food far away unless given. */
function duel(a: Snake, b: Snake, food: [number, number] | null = [9, 9]): DuelState {
  return { cols: 10, rows: 10, snakes: [a, b], food: food && { r: food[0], c: food[1] }, steps: 0, rngState: 1 };
}

const far = snake([[8, 2], [8, 1], [8, 0]], 'right');

describe('snake engine', () => {
  it('starts two snakes facing each other on different rows, with food off both', () => {
    const s = createDuel({ seed: 3 });
    expect(s.snakes[0].heading).toBe('right');
    expect(s.snakes[1].heading).toBe('left');
    expect(s.snakes[0].body[0].r).not.toBe(s.snakes[1].body[0].r);
    const cells = s.snakes.flatMap((k) => k.body);
    expect(cells.some((p) => p.r === s.food!.r && p.c === s.food!.c)).toBe(false);
    expect(createDuel({ seed: 3 }).food).toEqual(s.food);
  });

  it('moves both snakes at once and ignores a 180° turn', () => {
    const s = stepDuel(duel(snake([[2, 2], [2, 1], [2, 0]], 'right'), far), ['left', 'up']);
    expect(s.snakes[0].body[0]).toEqual({ r: 2, c: 3 });
    expect(s.snakes[0].heading).toBe('right');
    expect(s.snakes[1].body[0]).toEqual({ r: 7, c: 2 });
    expect(s.snakes[0].body).toHaveLength(3);
  });

  it('grows the snake that eats and places new food', () => {
    const s = stepDuel(duel(snake([[2, 2], [2, 1], [2, 0]], 'right'), far, [2, 3]), ['right', 'right']);
    expect(s.snakes[0].body).toHaveLength(4);
    expect(s.snakes[0].eaten).toBe(1);
    expect(s.food).not.toEqual({ r: 2, c: 3 });
  });

  it('kills on a wall, on itself, on the other body, and kills both on a head-on', () => {
    expect(stepDuel(duel(snake([[0, 5], [1, 5], [2, 5]], 'up'), far), ['up', 'right']).snakes[0].death).toBe('wall');

    const coiled = snake([[2, 2], [2, 3], [3, 3], [3, 2], [3, 1], [2, 1]], 'left');
    expect(stepDuel(duel(coiled, far), ['down', 'right']).snakes[0].death).toBe('self');

    // Long enough that its body still covers (3,5) two steps later.
    const wall = snake([[5, 5], [4, 5], [3, 5], [2, 5], [1, 5], [0, 5]], 'down');
    const rammer = snake([[3, 3], [3, 2], [3, 1]], 'right');
    const rammed = stepDuel(stepDuel(duel(rammer, wall), ['right', 'down']), ['right', 'down']);
    expect(rammed.snakes[0].death).toBe('other');
    expect(rammed.snakes[1].alive).toBe(true);

    const headOn = stepDuel(duel(snake([[4, 3], [4, 2], [4, 1]], 'right'), snake([[4, 5], [4, 6], [4, 7]], 'left')), ['right', 'left']);
    expect(headOn.snakes.map((k) => k.death)).toEqual(['head_on', 'head_on']);
  });

  it('lets a head enter the cell a tail is leaving on the same step', () => {
    // b's tail sits at (4,4); a moves into it while b moves on.
    const a = snake([[4, 3], [4, 2], [4, 1]], 'right');
    const b = snake([[2, 4], [3, 4], [4, 4]], 'up');
    const s = stepDuel(duel(a, b), ['right', 'up']);
    expect(s.snakes[0].alive).toBe(true);
    // But the facts do not bet on it: the opponent might eat and keep its tail.
    expect(legalMoves(duel(a, b), 0)).not.toContain('right');
  });

  it('offers only moves that are safe this step, and flags dead ends and head-on risks', () => {
    const cornered = snake([[0, 0], [0, 1], [0, 2]], 'left');
    expect(legalMoves(duel(cornered, far), 0)).toEqual(['down']);

    // The top-left corner, closed off by the opponent at (0,2) and along row 2: three cells of
    // room for a snake five long, with its own tail out of reach.
    const me = snake([[1, 2], [1, 3], [1, 4], [1, 5], [1, 6]], 'left');
    const fence = snake([[0, 2], [2, 2], [2, 1], [2, 0]], 'right');
    const pocket = analyzeMove(duel(me, fence), 0, 'left');
    expect(pocket.reachable).toBe(3);
    expect(pocket.deadEnd).toBe(true);
    expect(describeMove(pocket).escape).toMatch(/^DEAD END/);

    const facing = duel(snake([[4, 3], [4, 2], [4, 1]], 'right'), snake([[4, 5], [4, 6], [4, 7]], 'left'));
    const facts = analyze(facing, 0);
    expect(facts.find((f) => f.dir === 'right')?.headOnRisk).toBe(true);
    expect(facts.find((f) => f.dir === 'up')?.headOnRisk).toBe(false);
    expect(botMove(facts)).not.toBe('right');
    expect(describeMove(facts.find((f) => f.dir === 'right')!).opponent).toMatch(/^RISK/);
  });

  it('the bot heads for the food, and the fallback goes straight when it can', () => {
    const s = duel(snake([[5, 2], [5, 1], [5, 0]], 'right'), far, [2, 2]);
    expect(botMove(analyze(s, 0))).toBe('up');
    expect(fallbackMove(s, 0)).toBe('right');
    const atWall = duel(snake([[5, 9], [5, 8], [5, 7]], 'right'), far);
    expect(fallbackMove(atWall, 0)).not.toBe('right');
  });

  it('shows each snake the board from its own side', () => {
    const s = duel(snake([[0, 1], [0, 0]], 'right'), snake([[9, 8], [9, 9]], 'left'), [5, 5]);
    expect(duelToText(s, 0)[0].slice(0, 2)).toBe('aA');
    expect(duelToText(s, 1)[0].slice(0, 2)).toBe('bB');
    expect(duelToText(s, 1)[9].slice(8)).toBe('Aa');
    const req = buildSnakeRequest(s, 0, analyze(s, 0), true);
    expect(req.options.map((o) => o.id).sort()).toEqual(['down', 'right']);
    const fields = Object.keys(req.options[0].description);
    for (const o of req.options) expect(Object.keys(o.description)).toEqual(fields);
  });
});

describe('snake match', () => {
  const scripted = (name: string, pick: (req: DecisionRequest) => string | null, delayMs = 0): Player => ({
    config: { kind: 'bot' },
    name,
    short: name,
    emoji: '',
    color: '',
    decide: (req, signal): Promise<Decision> =>
      new Promise((resolve, reject) => {
        const done = () => resolve({ optionId: pick(req), latencyMs: delayMs, inputTokens: 0, outputTokens: 0, cost: 0, note: 'scripted' });
        if (!delayMs) return done();
        const timer = setTimeout(done, delayMs);
        signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true });
      }),
  });
  const options = { seed: 5, cols: 12, rows: 10, tickMs: 5, tickAuto: false, lockstep: false, timeLimitSec: 0 };

  it('picks a slower tick the slower the seats are', () => {
    expect(recommendedTickMs(['bot', 'random'], false)).toBeLessThan(recommendedTickMs(['human', 'bot'], false));
    expect(recommendedTickMs(['human', 'jev'], false)).toBeLessThan(recommendedTickMs(['jev', 'llm'], false));
    expect(recommendedTickMs(['llm', 'bot'], true)).toBeGreaterThan(recommendedTickMs(['llm', 'bot'], false));
    // A slow provider (reachable through the custom model field) stretches the tick.
    expect(recommendedTickMs(['llm', 'bot'], false, ['google/gemini-3.7-flash'])).toBeGreaterThan(recommendedTickMs(['llm', 'bot'], false, ['qwen/qwen3.8-flash']));
    expect(recommendedTickMs(['llm', 'llm'], false, ['qwen/qwen3.8-flash', 'openai/gpt-5.6-luna'])).toBe(5000);
  });

  it('a player that never answers in time goes straight into the wall, and the bot wins', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    const sleeper = scripted('sleeper', (req) => req.botChoice(), 10_000);
    const match = new SnakeMatch([bot, sleeper], options);
    match.start();
    await expect.poll(() => match.status, { timeout: 10_000, interval: 10 }).toBe('done');
    expect(match.result?.winner).toBe(0);
    expect(match.state.snakes[1].death).toBe('wall');
    expect(match.seats[1].late).toBeGreaterThan(0);
    expect(match.seats[1].stats.calls).toBe(0);
  });

  it('lockstep waits for a slow player, so it is never late', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    const slow = scripted('slow', (req) => req.botChoice(), 25);
    const match = new SnakeMatch([bot, slow], { ...options, lockstep: true });
    match.start();
    await expect.poll(() => match.state.steps, { timeout: 10_000, interval: 10 }).toBeGreaterThanOrEqual(8);
    match.stop();
    expect(match.seats[1].late).toBe(0);
    expect(match.seats[1].stats.calls).toBeGreaterThanOrEqual(8);
    expect(match.result?.stopped).toBe(true);
  });

  it('an invalid answer falls back to the bot instead of crashing the snake', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    const broken = scripted('broken', () => 'sideways');
    const match = new SnakeMatch([bot, broken], options);
    match.start();
    await expect.poll(() => match.state.steps, { timeout: 10_000, interval: 10 }).toBeGreaterThanOrEqual(30);
    match.stop();
    expect(match.seats[1].stats.invalid).toBeGreaterThan(0);
    expect(match.state.snakes[1].eaten + match.state.snakes[0].eaten).toBeGreaterThan(0);
  });
});
