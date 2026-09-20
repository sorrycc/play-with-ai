import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENTS, readStreamJson } from '../server/agents.mjs';
// @ts-expect-error plain .mjs module, the server side of the duel
import { adjudicate, createDuel, isLocalRequest, promptFor } from '../server/duel.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE = join(ROOT, 'tests/fixtures/fake-agent.mjs');
const CARDS = ['01-range', '02-price', '03-palindrome', '04-emoji', '05-versions', '06-group-by', '07-intervals', '08-lru'];
/** Each card's fix, as an edit of the file it opens on: a line or two at level 1, a function body at level 3. */
const SOLUTIONS: Record<string, (source: string) => string> = {
  '01-range': (s) => s.replace('(start, end)', '(start, end, step = 1)').replace('i += 1', 'i += step'),
  '02-price': (s) => s.replace('String(cents % 100)', "String(cents % 100).padStart(2, '0')"),
  '03-palindrome': (s) => s.replace('const clean = text;', "const clean = text.toLowerCase().replaceAll(' ', '');"),
  '04-emoji': (s) => s.replace("['♥', ' love '],", "['♥', ' love '],\n\t['🚀', ' rocket '],\n\t['🔥', ' fire '],"),
  '05-versions': (s) =>
    s.replace(/\tif \(a === b\)[\s\S]*\? -1 : 1;\n/, "\tconst pa = a.split('.').map(Number);\n\tconst pb = b.split('.').map(Number);\n\tfor (let i = 0; i < Math.max(pa.length, pb.length); i++) {\n\t\tconst d = (pa[i] ?? 0) - (pb[i] ?? 0);\n\t\tif (d !== 0) return d < 0 ? -1 : 1;\n\t}\n\n\treturn 0;\n"),
  '06-group-by': (s) => s.replace('\treturn groups;', "\tfor (const item of items) {\n\t\tconst name = typeof key === 'function' ? key(item) : item[key];\n\t\t(groups[name] ??= []).push(item);\n\t}\n\n\treturn groups;"),
  '07-intervals': (s) =>
    s.replace('\treturn intervals;', "\tconst merged = [];\n\tfor (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {\n\t\tconst last = merged.at(-1);\n\t\tif (last && start <= last[1]) last[1] = Math.max(last[1], end);\n\t\telse merged.push([start, end]);\n\t}\n\n\treturn merged;"),
  '08-lru': (s) =>
    s
      .replace('\t\treturn this.map.get(key);', "\t\tif (!this.map.has(key)) return undefined;\n\t\tconst value = this.map.get(key);\n\t\tthis.map.delete(key);\n\t\tthis.map.set(key, value);\n\t\treturn value;")
      .replace('\t\tthis.map.set(key, value);\n\t\treturn this;', "\t\tthis.map.delete(key);\n\t\tthis.map.set(key, value);\n\t\tif (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);\n\t\treturn this;"),
};

const side = (status: string, doneMs: number | null = null) => ({ status, doneMs });

describe('who wins a code duel', () => {
  it('is the side that passes, and nobody while both still work', () => {
    expect(adjudicate({ human: side('working'), agent: side('working') }, 10_000, 180_000)).toBeNull();
    expect(adjudicate({ human: side('pass', 60_000), agent: side('working') }, 61_000, 180_000)).toEqual({ winner: 'human', reason: 'pass' });
    expect(adjudicate({ human: side('working'), agent: side('pass', 90_000) }, 95_000, 180_000)).toEqual({ winner: 'agent', reason: 'pass' });
  });

  it('waits for a verdict on the side that said "done" first: verifying is off the clock', () => {
    const sides = { human: side('verifying', 80_000), agent: side('pass', 82_000) };
    expect(adjudicate(sides, 85_000, 180_000)).toBeNull();
    expect(adjudicate({ ...sides, human: side('pass', 80_000) }, 88_000, 180_000)).toEqual({ winner: 'human', reason: 'pass' });
    expect(adjudicate({ ...sides, human: side('working', 80_000) }, 88_000, 180_000)).toEqual({ winner: 'agent', reason: 'pass' });
    // Done later than the pass: no reason to wait for it.
    expect(adjudicate({ human: side('verifying', 90_000), agent: side('pass', 82_000) }, 91_000, 180_000)).toEqual({ winner: 'agent', reason: 'pass' });
  });

  it('ends without a winner when time runs out, but not while a verdict is pending', () => {
    expect(adjudicate({ human: side('working'), agent: side('fail', 50_000) }, 179_000, 180_000)).toBeNull();
    expect(adjudicate({ human: side('working'), agent: side('killed', 180_000) }, 180_000, 180_000)).toEqual({ winner: null, reason: 'timeout' });
    expect(adjudicate({ human: side('verifying', 179_000), agent: side('killed', 180_000) }, 181_000, 180_000)).toBeNull();
  });
});

describe('duel routes', () => {
  it('answer only a page served from this machine', () => {
    expect(isLocalRequest({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' })).toBe(true);
    expect(isLocalRequest({ host: 'localhost:3000' })).toBe(true);
    // Another site posting to the local server, and a name that was rebound to 127.0.0.1.
    expect(isLocalRequest({ host: '127.0.0.1:5173', origin: 'https://evil.example' })).toBe(false);
    expect(isLocalRequest({ host: 'evil.example:5173', origin: 'http://evil.example:5173' })).toBe(false);
  });
});

describe('code agents', () => {
  it('each offer models, the first being the default, and headless arguments that carry the task and the model', () => {
    for (const agent of AGENTS) {
      expect(agent.models.length).toBeGreaterThan(0);
      const args = agent.args({ prompt: 'DO THIS', model: agent.models[0] });
      expect(args.some((a) => a.includes('DO THIS'))).toBe(true);
      expect(args).toContain(agent.models[0]);
    }
    expect(AGENTS.find((a) => a.id === 'qodercli')?.models).toEqual(['Qwen3.8-Max', 'Qwen3.8-Flash', 'Kimi-K3', 'DeepSeek-Flash']);
  });

  it('turns stream-json into a log a visitor can follow', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'look   at\nthe table' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/private/tmp/run-1/agent/index.js' } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }, { type: 'text', text: 'Done.' }] } });
    expect(readStreamJson(line).entries).toEqual([
      { kind: 'think', text: 'look at the table' },
      { kind: 'tool', text: 'Edit index.js' },
      { kind: 'tool', text: 'Bash npm test' },
      { kind: 'say', text: 'Done.' },
    ]);
    expect(readStreamJson(JSON.stringify({ type: 'system', subtype: 'hook_started' })).entries).toEqual([]);
    expect(readStreamJson('Skill command was renamed').entries).toEqual([{ kind: 'info', text: 'Skill command was renamed' }]);
    expect(readStreamJson(JSON.stringify({ type: 'result', num_turns: 5, usage: { input_tokens: 100, output_tokens: 9 }, total_credits: 0.3 })).usage).toEqual({ turns: 5, inputTokens: 100, outputTokens: 9, credits: 0.3 });
  });
});

// The real thing, with a script in place of a CLI. Only the slugify card has dependencies, which
// the server installs on first play; without them that card is skipped rather than slow.
const installed = existsSync(join(ROOT, 'challenges/04-emoji/start/node_modules/.bin/ava'));

describe('a duel on disk', () => {
  const dirs: string[] = [];
  const duelWith = async (mode: string) => {
    const runsDir = await mkdtemp(join(tmpdir(), 'duel-test-'));
    dirs.push(runsDir);
    const agents = [{ id: 'fake', name: 'Fake', bin: 'node', models: ['m1', 'm2'], args: () => [FAKE, mode], readLine: readStreamJson }];
    return { duel: createDuel({ agents, runsDir }), runsDir };
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(check()).toBe(true);
  };
  const stateOf = (duel: any, id: string) => duel.state(new URLSearchParams({ id }));

  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it('never sends a hidden test with the cards', async () => {
    const { duel } = await duelWith('idle');
    const { cards } = await duel.cards();
    expect(cards.map((c: any) => c.id)).toEqual(CARDS);
    // Three levels, more than one card at each, easiest first.
    const levels = cards.map((c: any) => c.level);
    expect(levels).toEqual([...levels].sort());
    for (const level of [1, 2, 3]) expect(levels.filter((l: number) => l === level).length).toBeGreaterThan(1);
    for (const card of cards) expect(Object.keys(card)).not.toEqual(expect.arrayContaining(['dir']));
    expect(JSON.stringify(cards)).not.toContain('card 0');
    expect(JSON.stringify(cards)).not.toContain(ROOT);
  });

  it('a hidden test asks for what its card shows, and the agent is told what the person is told', async () => {
    const { duel } = await duelWith('idle');
    for (const card of (await duel.cards()).cards) {
      const hidden = await readFile(join(ROOT, 'challenges', card.id, 'hidden.test.js'), 'utf8');
      const prompt = promptFor(card);
      for (const example of card.examples) {
        // An example of several statements is in the test statement by statement.
        for (const statement of example.input.split('; ')) expect(hidden).toContain(statement);
        expect(hidden).toContain(example.output);
        expect(prompt).toContain(example.input);
      }
      expect(prompt).toContain(card.hint.zh);
    }
  });

  it.each(CARDS)('%s has its own repository: the start passes its tests and fails the card, a few lines pass it', async (cardId) => {
    if (cardId === '04-emoji' && !installed) return;
    const { duel } = await duelWith('hang');
    const { cards } = await duel.cards();
    const card = cards.find((c: any) => c.id === cardId);
    const { id, files } = await duel.start({ card: cardId, agent: 'fake', limitSec: 120 });
    expect(Object.keys(files)).toContain(card.open);
    for (const other of cards) if (other.id !== cardId) expect(Object.keys(files)).not.toContain(other.open);
    await duel.go({ id });
    expect((await duel.test({ id, files })).ok).toBe(true);
    expect((await duel.submit({ id, files })).pass).toBe(false);
    const solved = { ...files, [card.open]: SOLUTIONS[cardId](files[card.open]) };
    expect(solved[card.open]).not.toBe(files[card.open]);
    expect((await duel.submit({ id, files: solved })).pass).toBe(true);
    expect(stateOf(duel, id).result).toEqual({ winner: 'human', reason: 'pass' });
  }, 90_000);

  it('an agent that solves the card wins, with its log, usage and changed files reported', async () => {
    const { duel } = await duelWith('solve');
    const { id, files, model } = await duel.start({ card: '01-range', agent: 'fake', model: 'nope', limitSec: 120 });
    expect(model).toBe('m1');
    expect(Object.keys(files)).toEqual(['range.js', 'range.test.js']);
    await duel.go({ id });
    await until(() => stateOf(duel, id).result !== null);
    const state = stateOf(duel, id);
    expect(state.result).toEqual({ winner: 'agent', reason: 'pass' });
    expect(state.agent.changed).toEqual(['range.js']);
    expect(state.agent.usage.credits).toBe(0.5);
    expect(state.agent.log.map((e: any) => e.text)).toEqual(['mode solve', 'Edit range.js']);
    expect(stateOf(duel, id).agent.log.length).toBe(2);
    expect(duel.state(new URLSearchParams({ id, from: '1' })).agent.log.length).toBe(1);
  }, 60_000);

  it('a person may fail, fix and submit again; the agent gets one verdict; the hidden test leaves no trace', async () => {
    const { duel, runsDir } = await duelWith('idle');
    const { id, files } = await duel.start({ card: '01-range', agent: 'fake', model: 'm2', limitSec: 120 });
    await duel.go({ id });
    await until(() => stateOf(duel, id).agent.status === 'fail');
    expect(stateOf(duel, id).result).toBeNull();

    const tests = await duel.test({ id, files });
    expect(tests.ok).toBe(true);
    const first = await duel.submit({ id, files });
    expect(first.pass).toBe(false);
    expect(first.output).toContain('card 01');
    expect(stateOf(duel, id).human).toMatchObject({ status: 'working', attempts: 1 });

    await expect(duel.test({ id, files: { '../escape.js': 'x' } })).rejects.toThrow(/not one of/);

    const second = await duel.submit({ id, files: { ...files, 'range.js': SOLUTIONS['01-range'](files['range.js']) } });
    expect(second.pass).toBe(true);
    expect(stateOf(duel, id).result).toEqual({ winner: 'human', reason: 'pass' });
    expect(await readdir(join(runsDir, id, 'human'))).not.toContain('challenge.test.js');
    await expect(duel.submit({ id, files })).rejects.toThrow(/over/);
  }, 90_000);

  it('stopping kills an agent that is still working, and so does starting the next duel', async () => {
    const { duel } = await duelWith('hang');
    const a = await duel.start({ card: '01-range', agent: 'fake', limitSec: 120 });
    await duel.go({ id: a.id });
    await until(() => stateOf(duel, a.id).agent.log.length > 0);
    const b = await duel.start({ card: '01-range', agent: 'fake', limitSec: 120 });
    expect(stateOf(duel, a.id)).toMatchObject({ result: { winner: null, reason: 'stopped' }, agent: { status: 'killed' } });
    await duel.go({ id: b.id });
    duel.stop({ id: b.id });
    expect(stateOf(duel, b.id).result).toEqual({ winner: null, reason: 'stopped' });
  }, 60_000);
});
