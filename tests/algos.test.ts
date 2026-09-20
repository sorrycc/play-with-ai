import { describe, expect, it } from 'vitest';
import type { DecisionGameId } from '../src/core/types';
import { ALGO_GAMES } from '../src/players/algoGames';
import { GenerationError, buildGenerationMessages, extractCode, extractName, generateAlgorithm, staticProblems, validate, type ChatMessage } from '../src/players/generate';
import { createInlineRunner, workerSource } from '../src/players/sandbox';

const GAMES = Object.keys(ALGO_GAMES) as DecisionGameId[];
const FIRST = '// name: first\nfunction choose(game) { return game.options[0].id; }';
const fenced = (code: string) => '```js\n' + code + '\n```';

describe('algorithm inputs', () => {
  it.each(GAMES)('%s: gives several real positions, as plain JSON, with the documented facts', (game) => {
    const samples = ALGO_GAMES[game].samples();
    expect(samples.length).toBeGreaterThanOrEqual(3);
    for (const sample of samples) {
      expect(sample.options.length).toBeGreaterThan(0);
      // It has to survive postMessage into a worker.
      expect(JSON.parse(JSON.stringify(sample))).toEqual(sample);
      expect(new Set(sample.options.map((o) => o.id)).size).toBe(sample.options.length);
      // Every fact a sample carries is described to the model, and nothing described is missing.
      const described = ALGO_GAMES[game].facts;
      for (const key of Object.keys(sample.options[0].facts)) expect(described, `${game}: facts.${key} is not documented`).toContain(key);
      for (const key of Object.keys(sample.state)) expect(ALGO_GAMES[game].state, `${game}: state.${key} is not documented`).toContain(key);
    }
  }, 60_000);
});

describe('reading a model reply', () => {
  it('takes the code out of a fence, with or without prose around it', () => {
    expect(extractCode('Here you go:\n```js\nfunction choose(g) { return 1; }\n```\nEnjoy.')).toBe('function choose(g) { return 1; }');
    expect(extractCode('```javascript\nlet a = 1;\n```')).toBe('let a = 1;');
    expect(extractCode('function choose(g) { return g.options[0].id; }')).toBe('function choose(g) { return g.options[0].id; }');
    // Cut off before the closing fence.
    expect(extractCode('```js\nfunction choose(g) {')).toBe('function choose(g) {');
  });

  it('reads the name from the first comment, in any language, and caps its length', () => {
    expect(extractName('// name: 稳健消行\nfunction choose() {}', 'x')).toBe('稳健消行');
    expect(extractName('// Name：中炮急攻\nfunction choose() {}', 'x')).toBe('中炮急攻');
    expect(extractName('function choose() {}', 'fallback')).toBe('fallback');
    expect([...extractName('// name: ' + 'a'.repeat(80), 'x')]).toHaveLength(24);
  });

  it('rejects code that breaks the contract before running it', () => {
    expect(staticProblems(FIRST)).toBeNull();
    expect(staticProblems('const choose = (g) => g.options[0].id;')).toBeNull();
    expect(staticProblems('')).toMatch(/no code/);
    expect(staticProblems('function pick(g) { return 1; }')).toMatch(/choose/);
    expect(staticProblems('function choose(g) { fetch("/api/llm"); return g.options[0].id; }')).toMatch(/fetch/);
    expect(staticProblems('import x from "y";\nfunction choose(g) {}')).toMatch(/import/);
    expect(staticProblems('function choose(g) { return eval("1"); }')).toMatch(/eval/);
  });

  it('tells the model about the game, the contract and the wish', () => {
    const sample = ALGO_GAMES.tetris.samples()[0];
    const [system, user] = buildGenerationMessages('tetris', '绝不留洞', sample);
    expect(system.content).toContain('function choose(game)');
    expect(system.content).toContain('holesCreated');
    expect(system.content).toContain('// name:');
    expect(user.content).toContain('绝不留洞');
    expect(JSON.parse(user.content.slice(user.content.indexOf('{'))).options).toHaveLength(3);
  });
});

describe('trying code on real positions', () => {
  it('accepts code that always returns an offered id, for every game', async () => {
    for (const game of GAMES) expect(await validate(createInlineRunner(FIRST), ALGO_GAMES[game].samples()), game).toBeNull();
  }, 60_000);

  it('says what went wrong: a throw, nothing returned, or an id that is not on offer', async () => {
    const samples = ALGO_GAMES.snake.samples();
    expect(await validate(createInlineRunner('function choose(g) { return g.nope.id; }'), samples)).toMatch(/test position 1 it failed/);
    expect(await validate(createInlineRunner('function choose(g) {}'), samples)).toMatch(/returned nothing/);
    expect(await validate(createInlineRunner('function choose(g) { return "sideways"; }'), samples)).toMatch(/"sideways", which is not one of the option ids/);
  });

  it('a real strategy works on the numbers it is given', async () => {
    const noHoles = 'function choose(game) { return [...game.options].sort((a, b) => a.facts.holesCreated - b.facts.holesCreated || b.facts.linesCleared - a.facts.linesCleared || a.facts.maxHeightAfter - b.facts.maxHeightAfter)[0].id; }';
    const samples = ALGO_GAMES.tetris.samples();
    const runner = createInlineRunner(noHoles);
    for (const sample of samples) {
      const id = await runner.run(sample);
      const chosen = sample.options.find((o) => o.id === id)!;
      const fewest = Math.min(...sample.options.map((o) => o.facts.holesCreated as number));
      expect(chosen.facts.holesCreated).toBe(fewest);
    }
  });
});

describe('generating an algorithm', () => {
  const deps = (replies: string[], seen: ChatMessage[][] = []) => ({
    complete: async (messages: ChatMessage[]) => {
      seen.push(messages.map((m) => ({ ...m })));
      return { content: replies.shift() ?? '', inputTokens: 100, outputTokens: 50 };
    },
    createRunner: createInlineRunner,
  });

  it('returns the code and its name when the first attempt passes', async () => {
    const result = await generateAlgorithm('2048', '死守角落', deps([fenced('// name: 守角\nfunction choose(game) { return game.options[0].id; }')]));
    expect(result).toMatchObject({ name: '守角', attempts: 1, inputTokens: 100, outputTokens: 50 });
    expect(result.code).toContain('function choose');
  });

  it('shows the model its failure and accepts the repaired code', async () => {
    const seen: ChatMessage[][] = [];
    const result = await generateAlgorithm('gomoku', 'attack', deps([fenced('// name: bad\nfunction choose(game) { return "Z99"; }'), fenced(FIRST)], seen));
    expect(result.attempts).toBe(2);
    expect(result.name).toBe('first');
    expect(result.inputTokens).toBe(200);
    const repair = seen[1];
    expect(repair).toHaveLength(4);
    expect(repair[2]).toMatchObject({ role: 'assistant' });
    expect(repair[3].content).toMatch(/rejected: on test position 1 it returned "Z99"/);
  });

  it('gives up after one repair, with the reason', async () => {
    const bad = fenced('function choose(game) { throw new Error("boom"); }');
    await expect(generateAlgorithm('snake', 'x', deps([bad, bad]))).rejects.toThrow(GenerationError);
    await expect(generateAlgorithm('snake', 'x', deps([bad, bad]))).rejects.toThrow(/boom/);
  });
});

describe('the worker wrapper', () => {
  it('removes every way onto the network before the generated code runs', () => {
    const source = workerSource('function choose(g) { return g.options[0].id; }');
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'EventSource']) expect(source).toContain(`"${name}"`);
    expect(source.indexOf('delete o[name]')).toBeLessThan(source.indexOf('function choose'));
    expect(source).toContain('Object.getPrototypeOf(o)');
  });
});
