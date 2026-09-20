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
  shrinkDuel,
  stepDuel,
} from '../src/games/snake/engine';
import { SnakeMatch, buildSnakeRequest, recommendedTickMs } from '../src/games/snake/match';

const snake = (body: [number, number][], heading: Snake['heading']): Snake => ({
  body: body.map(([r, c]): Point => ({ r, c })),
  heading,
  alive: true,
  death: null,
  deathAt: null,
  eaten: 0,
});

/** A 10x10 duel with hand-placed snakes; food far away unless given. */
function duel(a: Snake, b: Snake, food: [number, number] | null = [9, 9], size: [number, number] = [10, 10]): DuelState {
  return { cols: size[0], rows: size[1], snakes: [a, b], food: food && { r: food[0], c: food[1] }, steps: 0, margin: 0, rngState: 1 };
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
    // The cell each head was entering is kept, so the arena can draw the crash.
    expect(headOn.snakes[0].deathAt).toEqual({ r: 4, c: 4 });
  });

  it('lets a head enter the cell a tail is leaving on the same step', () => {
    // b's tail sits at (4,4); a moves into it while b moves on.
    const a = snake([[4, 3], [4, 2], [4, 1]], 'right');
    const b = snake([[2, 4], [3, 4], [4, 4]], 'up');
    const s = stepDuel(duel(a, b), ['right', 'up']);
    expect(s.snakes[0].alive).toBe(true);
    // And the facts say so too, because b is nowhere near the food and so must move on.
    expect(legalMoves(duel(a, b), 0)).toContain('right');
    // With the food next to b's head it could eat and keep its tail, so that cell is not offered.
    expect(legalMoves(duel(a, b, [1, 4]), 0)).not.toContain('right');
  });

  it('a snake that dies does not move, so its tail is still in the way', () => {
    // a enters b's tail cell (4,4) on the very step b drives into the wall: b freezes, a hits it.
    const a = snake([[4, 3], [4, 2], [4, 1]], 'right');
    const b = snake([[0, 4], [1, 4], [4, 4]], 'up');
    const s = stepDuel(duel(a, b, null), ['right', 'up']);
    expect(s.snakes[1].death).toBe('wall');
    expect(s.snakes[0].death).toBe('other');
    const overlap = s.snakes[0].body.some((p) => s.snakes[1].body.some((q) => p.r === q.r && p.c === q.c));
    expect(overlap).toBe(false);
  });

  it('offers only moves that are safe this step, and flags dead ends and head-on risks', () => {
    const cornered = snake([[0, 0], [0, 1], [0, 2]], 'left');
    expect(legalMoves(duel(cornered, far), 0)).toEqual(['down']);

    // The top-left corner, closed off by the opponent at (0,2) and along row 2: three cells of
    // room for a snake five long, with its own tail out of reach. The fence ends at (3,0), the one
    // cell of it that is about to be vacated, so the corner stays shut either way.
    const me = snake([[1, 2], [1, 3], [1, 4], [1, 5], [1, 6]], 'left');
    const fence = snake([[0, 2], [2, 2], [2, 1], [2, 0], [3, 0]], 'right');
    const pocket = analyzeMove(duel(me, fence), 0, 'left');
    expect(pocket.reachable).toBe(3);
    expect(pocket.deadEnd).toBe(true);
    expect(describeMove(pocket).escape).toMatch(/^DEAD END/);

    const facing = duel(snake([[4, 3], [4, 2], [4, 1]], 'right'), snake([[4, 5], [4, 6], [4, 7]], 'left'));
    const facts = analyze(facing, 0);
    expect(facts.find((f) => f.dir === 'right')?.headOnRisk).toBe(true);
    expect(facts.find((f) => f.dir === 'up')?.headOnRisk).toBe(false);
    expect(botMove(facing, 0, facts)).not.toBe('right');
    expect(describeMove(facts.find((f) => f.dir === 'right')!).opponent).toMatch(/^RISK/);
  });

  it('a head-on that would be won on length is not called a risk', () => {
    const longer = duel(snake([[4, 3], [4, 2], [4, 1], [5, 1], [6, 1]], 'right'), snake([[4, 5], [4, 6], [4, 7]], 'left'));
    const right = analyze(longer, 0).find((f) => f.dir === 'right')!;
    expect(right.headOnRisk).toBe(true);
    expect(right.headOnWins).toBe(true);
    expect(describeMove(right).opponent).toMatch(/win on length/);
  });

  it('counts the way out of a pocket without wrapping around the edge of the grid', () => {
    // The snake lies along row 4 with its tail ending on the right edge; the only room left is a
    // two-cell pocket. The tail's neighbour "one step right" is off the grid, not (5,0).
    const me = snake([[4, 1], [4, 2], [4, 3], [4, 4], [4, 5], [4, 6], [4, 7], [3, 7]], 'left');
    const fence = snake([[5, 2], [6, 2], [6, 1], [6, 0], [3, 0], [2, 0]], 'up');
    const state = duel(me, fence, [0, 0], [8, 8]);
    for (const dir of ['left', 'down'] as const) {
      const facts = analyzeMove(state, 0, dir);
      expect(facts.reachable).toBe(2);
      expect(facts.canReachTail).toBe(false);
      expect(facts.deadEnd).toBe(true);
    }
  });

  it('measures the way to the food along an open path, not as the crow flies', () => {
    // A wall of opponent body between the head and the food: four cells apart, eight steps around.
    const me = snake([[5, 0], [6, 0], [7, 0]], 'up');
    const fence = snake([[0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2]], 'up');
    const open = analyzeMove(duel(me, fence, [5, 4], [10, 10]), 0, 'up');
    expect(open.foodReachable).toBe(true);
    expect(open.foodDistance).toBeGreaterThan(Math.abs(5 - 4) + Math.abs(4 - 0));
    expect(describeMove(open).food).toMatch(/shortest open path/);

    // Sealed off completely: there is no path at all, and the fact says so.
    const sealed = snake([[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1]], 'up');
    const walled = analyzeMove(duel(snake([[5, 0], [6, 0], [7, 0]], 'up'), sealed, [5, 5], [10, 10]), 0, 'up');
    expect(walled.foodReachable).toBe(false);
    expect(walled.foodDistance).toBeNull();
    expect(describeMove(walled).food).toMatch(/no open path/);
  });

  it('counts the room it owns before the opponent could take it', () => {
    const mine = analyzeMove(duel(snake([[5, 1], [5, 0], [6, 0]], 'right'), snake([[5, 8], [5, 9], [6, 9]], 'left')), 0, 'right');
    expect(mine.territory).toBeGreaterThan(0);
    expect(mine.territory).toBeLessThan(mine.reachable);
    expect(describeMove(mine).room).toMatch(/before the opponent/);
  });

  it('closes the walls in, kills what is caught outside and moves the food back in', () => {
    const middle = snake([[5, 5], [5, 4], [5, 3]], 'right');
    const edge = snake([[0, 0], [0, 1], [0, 2]], 'right');
    const closed = shrinkDuel(duel(middle, edge, [0, 9]));
    expect(closed.margin).toBe(1);
    expect(closed.snakes[0].alive).toBe(true);
    expect(closed.snakes[1].death).toBe('wall');
    expect(closed.food!.r).toBeGreaterThan(0);
    expect(duelToText(closed, 0)[9]).toBe('##########');
    // The wall is real: a head that walks into the closed ring dies.
    expect(stepDuel({ ...closed, snakes: [snake([[1, 5], [2, 5], [3, 5]], 'up'), middle] }, ['up', 'right']).snakes[0].death).toBe('wall');
    // And it stops closing in before the arena disappears.
    let small = duel(middle, far);
    for (let n = 0; n < 10; n++) small = shrinkDuel(small);
    expect(small.rows - 2 * small.margin).toBeGreaterThanOrEqual(5);
  });

  it('the bot heads for the food, and the fallback goes straight when it can', () => {
    const s = duel(snake([[5, 2], [5, 1], [5, 0]], 'right'), far, [2, 2]);
    expect(botMove(s, 0)).toBe('up');
    expect(fallbackMove(s, 0)).toBe('right');
    const atWall = duel(snake([[5, 9], [5, 8], [5, 7]], 'right'), far);
    expect(fallbackMove(atWall, 0)).not.toBe('right');
  });

  it('the bot does not walk into a pocket to reach the food', () => {
    // Food in a three-cell dead end, for a snake six long: tempting, and fatal.
    const me = snake([[4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4]], 'up');
    const fence = snake([[3, 3], [2, 3], [1, 3], [0, 3], [0, 4], [0, 5], [1, 5], [2, 5], [3, 5]], 'up');
    const trap = duel(me, fence, [1, 4], [10, 10]);
    expect(analyze(trap, 0).find((f) => f.dir === 'up')?.foodDistance).toBe(2);
    expect(botMove(trap, 0)).not.toBe('up');
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

  it('tells a player what actually decides the match', () => {
    const s = duel(snake([[0, 1], [0, 0]], 'right'), snake([[9, 8], [9, 9]], 'left'), [5, 5]);
    const req = buildSnakeRequest(s, 0, analyze(s, 0), true, { secondsLeft: 42, stepsToShrink: 7 });
    expect(req.rules).toMatch(/THE LONGER SNAKE WINS/);
    expect(req.state.seconds_left).toBe(42);
    expect(req.state.steps_until_the_walls_close_in).toBe(7);
    expect(req.state.your_food_eaten).toBe(0);
    expect(req.data.state.secondsLeft).toBe(42);
    expect(req.data.state.stepsToShrink).toBe(7);
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
        const done = () => resolve({ optionId: pick(req), latencyMs: delayMs, inputTokens: 7, outputTokens: 3, cost: 0.001, note: 'scripted' });
        if (!delayMs) return done();
        const timer = setTimeout(done, delayMs);
        signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true });
      }),
  });
  const options = { seed: 5, cols: 12, rows: 10, tickMs: 5, tickAuto: false, lockstep: false, suddenDeath: false, timeLimitSec: 0 };

  it('picks a slower tick the slower the seats are', () => {
    expect(recommendedTickMs(['bot', 'random'], false)).toBeLessThan(recommendedTickMs(['human', 'bot'], false));
    expect(recommendedTickMs(['human', 'jev'], false)).toBeLessThan(recommendedTickMs(['jev', 'llm'], false));
    expect(recommendedTickMs(['llm', 'bot'], true)).toBeGreaterThan(recommendedTickMs(['llm', 'bot'], false));
    // A generated algorithm runs locally, but its Worker needs more than a bot's tick.
    expect(recommendedTickMs(['custom', 'bot'], false)).toBeGreaterThan(recommendedTickMs(['bot', 'bot'], false));
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
    expect(match.state.snakes[1].alive).toBe(false);
    expect(match.seats[1].late).toBeGreaterThan(0);
    // Nothing ever came back, so nothing was counted.
    expect(match.seats[1].stats.calls).toBe(0);
  });

  it('counts an answer that arrives after the deadline, without playing it', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    // Slower than a tick, quicker than the two ticks after which the question is abandoned.
    const late = scripted('late', (req) => req.botChoice(), 12);
    const match = new SnakeMatch([bot, late], { ...options, tickMs: 8 });
    match.start();
    await expect.poll(() => match.seats[1].stats.calls, { timeout: 10_000, interval: 5 }).toBeGreaterThanOrEqual(3);
    match.stop();
    expect(match.seats[1].late).toBeGreaterThan(0);
    // The tokens and the cost of those answers are on the bill, so they are on the panel too.
    expect(match.seats[1].stats.inputTokens).toBeGreaterThan(0);
    expect(match.seats[1].stats.cost).toBeGreaterThan(0);
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

  it('keeps two turns from one person, and never a 180° one', () => {
    const human: Player = { config: { kind: 'human' }, name: 'you', short: 'you', emoji: '', color: '', decide: () => Promise.reject(new Error('no')) };
    const bot = scripted('bot', (req) => req.botChoice());
    const match = new SnakeMatch([human, bot], options);
    match.start();
    // Snake 0 heads right: up then left is a corner, and both turns are kept.
    match.input(0, 'up');
    match.input(0, 'left');
    expect(match['queued'][0]).toEqual(['up', 'left']);
    // A third is one too many, and a reversal of what is queued is dropped.
    match.input(0, 'down');
    expect(match['queued'][0]).toEqual(['up', 'left']);
    match.stop();
  });

  it('the walls close in on the second half of a match', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    const room = { ...options, cols: 20, rows: 16, tickMs: 25, timeLimitSec: 1 };
    expect(new SnakeMatch([bot, bot], { ...room, suddenDeath: false }).stepsToShrink()).toBeNull();
    const match = new SnakeMatch([bot, bot], { ...room, suddenDeath: true });
    // Halfway through the 40 steps this clock allows, the first ring closes.
    expect(match.stepsToShrink()).toBe(20);
    match.start();
    await expect.poll(() => match.status, { timeout: 20_000, interval: 20 }).toBe('done');
    expect(match.state.margin).toBeGreaterThan(0);
    expect(match.state.rows - 2 * match.state.margin).toBeGreaterThanOrEqual(5);
  });
});
