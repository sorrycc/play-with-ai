import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENTS, readStreamJson } from '../server/agents.mjs';
// @ts-expect-error plain .mjs module, the server side of the duel
import { adjudicate, createDuel, editableFiles, findOnPath, isLocalRequest, judge, promptFor, readTap, shimTarget } from '../server/duel.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE = join(ROOT, 'tests/fixtures/fake-agent.mjs');
const CARDS = ['01-range', '02-price', '03-palindrome', '04-emoji', '05-versions', '06-group-by', '07-intervals', '08-lru', '09-csv', '10-template'];
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
  '09-csv': (s) =>
    s.replace(
      "\treturn line.split(',');",
      "\tconst fields = [];\n\tlet field = '';\n\tlet quoted = false;\n\tfor (let i = 0; i < line.length; i++) {\n\t\tconst c = line[i];\n\t\tif (quoted && c === '\"' && line[i + 1] === '\"') {\n\t\t\tfield += '\"';\n\t\t\ti++;\n\t\t} else if (c === '\"') {\n\t\t\tquoted = !quoted;\n\t\t} else if (c === ',' && !quoted) {\n\t\t\tfields.push(field);\n\t\t\tfield = '';\n\t\t} else {\n\t\t\tfield += c;\n\t\t}\n\t}\n\n\tfields.push(field);\n\treturn fields;",
    ),
  '10-template': (s) =>
    s.replace(
      '\treturn template.replaceAll(/{(\\w+)}/g, (whole, name) => values[name]);',
      "\treturn template.replaceAll(/{{|}}|{([^{}]*)}/g, (whole, path) => {\n\t\tif (whole === '{{') return '{';\n\t\tif (whole === '}}') return '}';\n\t\tlet value = values;\n\t\tfor (const part of path.split('.')) value = value?.[part];\n\t\treturn value === undefined || value === null ? whole : String(value);\n\t});",
    ),
};

const side = (status: string, doneMs: number | null = null) => ({ status, doneMs });
const at = (human: number, agent: number) => ({ human, agent });

describe('who wins a code duel', () => {
  it('is the side that passes, and nobody while both still work', () => {
    expect(adjudicate({ human: side('working'), agent: side('working') }, at(10_000, 10_000), 180_000)).toBeNull();
    expect(adjudicate({ human: side('pass', 60_000), agent: side('working') }, at(61_000, 61_000), 180_000)).toEqual({ winner: 'human', reason: 'pass' });
    expect(adjudicate({ human: side('working'), agent: side('pass', 90_000) }, at(95_000, 95_000), 180_000)).toEqual({ winner: 'agent', reason: 'pass' });
  });

  it('waits for a verdict on the side that said "done" first: verifying is off the clock', () => {
    const sides = { human: side('verifying', 80_000), agent: side('pass', 82_000) };
    expect(adjudicate(sides, at(85_000, 85_000), 180_000)).toBeNull();
    expect(adjudicate({ ...sides, human: side('pass', 80_000) }, at(88_000, 88_000), 180_000)).toEqual({ winner: 'human', reason: 'pass' });
    expect(adjudicate({ ...sides, human: side('working', 80_000) }, at(88_000, 88_000), 180_000)).toEqual({ winner: 'agent', reason: 'pass' });
    // Done later than the pass: no reason to wait for it.
    expect(adjudicate({ human: side('verifying', 90_000), agent: side('pass', 82_000) }, at(91_000, 91_000), 180_000)).toEqual({ winner: 'agent', reason: 'pass' });
  });

  it('ends without a winner when time runs out, but not while a verdict is pending', () => {
    expect(adjudicate({ human: side('working'), agent: side('fail', 50_000) }, at(179_000, 179_000), 180_000)).toBeNull();
    expect(adjudicate({ human: side('working'), agent: side('killed', 180_000) }, at(180_000, 180_000), 180_000)).toEqual({ winner: null, reason: 'timeout' });
    expect(adjudicate({ human: side('verifying', 179_000), agent: side('killed', 180_000) }, at(181_000, 181_000), 180_000)).toBeNull();
  });

  it('gives each side its own clock, so a verdict does not spend the other side time', () => {
    // The wall clock is past the limit, but the person spent 40 s of it waiting for a verdict.
    const sides = { human: side('working', 140_000), agent: side('killed', 180_000) };
    expect(adjudicate(sides, at(150_000, 190_000), 180_000)).toBeNull();
    expect(adjudicate(sides, at(180_000, 220_000), 180_000)).toEqual({ winner: null, reason: 'timeout' });
  });

  it('needs nobody on the other side: practice is the same rules with one seat', () => {
    expect(adjudicate({ human: side('working') }, { human: 10_000 }, 120_000)).toBeNull();
    expect(adjudicate({ human: side('pass', 44_000) }, { human: 45_000 }, 120_000)).toEqual({ winner: 'human', reason: 'pass' });
    expect(adjudicate({ human: side('working') }, { human: 120_000 }, 120_000)).toEqual({ winner: null, reason: 'timeout' });
  });
});

describe('a verdict is what the tests said, not what the exit code said', () => {
  const card = { hiddenTests: [{ title: 'card 01: counts by step' }, { title: 'card 01: without step it still counts by 1' }] };

  it('reads TAP from both runners, failures and counts', () => {
    const tap = readTap(['TAP version 13', 'ok 1 - alpha', 'not ok 2 - beta', '  ---', "  error: |-", '    1 !== 2', "  code: 'ERR_ASSERTION'", '  ...', '1..2', '# tests 2', '# pass 1', '# fail 1'].join('\n'));
    expect(tap.cases).toEqual([
      { ok: true, title: 'alpha', detail: '' },
      { ok: false, title: 'beta', detail: '1 !== 2' },
    ]);
    expect(tap).toMatchObject({ tests: 2, pass: 1, fail: 1 });
    // ava puts the file in front of the title.
    expect(readTap('ok 1 - challenge › card 01: counts by step').cases[0].title).toBe('challenge › card 01: counts by step');
  });

  it('counts a hidden test that never ran as a failure, whatever the runner exited with', () => {
    // What `process.exit(0)` at the top of the source file looks like: a green run with no tests in it.
    const ducked = judge(card, { ok: true, output: 'TAP version 13\nok 1 - range.test.js\n1..1\n# tests 1\n# pass 1\n# fail 0' });
    expect(ducked.ok).toBe(false);
    expect(ducked.failures).toContain('card 01: counts by step');
    expect(ducked.output).toContain('never ran');

    const real = judge(card, { ok: true, output: 'ok 1 - card 01: counts by step\nok 2 - card 01: without step it still counts by 1\n# pass 2\n# fail 0' });
    expect(real).toMatchObject({ ok: true, passed: 2, failed: 0 });

    const red = judge(card, { ok: false, output: 'ok 1 - card 01: counts by step\nnot ok 2 - card 01: without step it still counts by 1\n# pass 1\n# fail 1' });
    expect(red).toMatchObject({ ok: false, failed: 1, failures: ['card 01: without step it still counts by 1'] });
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

  it('answer a host the deployment listed in DUEL_HOSTS, and still not another site posting to it', () => {
    const hosts = ['play.example.com'];
    expect(isLocalRequest({ host: 'play.example.com', origin: 'https://play.example.com' }, hosts)).toBe(true);
    expect(isLocalRequest({ host: 'Play.Example.com' }, hosts)).toBe(true);
    expect(isLocalRequest({ host: 'play.example.com', origin: 'https://evil.example' }, hosts)).toBe(false);
    expect(isLocalRequest({ host: 'other.example.com', origin: 'https://other.example.com' }, hosts)).toBe(false);
  });
});

describe('on Windows', () => {
  it('finds a bare name by PATHEXT, the .exe before the .cmd, never the shell script beside them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'duel-path-'));
    try {
      for (const name of ['tool', 'tool.cmd', 'other', 'other.cmd', 'other.exe']) await writeFile(join(dir, name), '', { mode: 0o755 });
      const find = (bin: string) => findOnPath(bin, { pathVar: dir, win: true, pathExt: '.COM;.EXE;.BAT;.CMD' });
      expect(await find('tool')).toBe(join(dir, 'tool.cmd'));
      expect(await find('other')).toBe(join(dir, 'other.exe'));
      expect(await find('missing')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads what an npm .cmd shim would start, so the prompt never goes through cmd.exe', () => {
    const shim = '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@qoder-ai\\qodercli\\bin\\cli.js" %*\r\n';
    expect(shimTarget(shim)).toBe('node_modules\\@qoder-ai\\qodercli\\bin\\cli.js');
    expect(shimTarget('@"%~dp0\\vendor\\tool.exe" %*')).toBe('vendor\\tool.exe');
    expect(shimTarget('@echo hello')).toBeNull();
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
  /** Only what the person may write goes to the server: the repository's own tests are the card's. */
  const mine = (files: Record<string, string>, editable: string[]) => Object.fromEntries(editable.map((n) => [n, files[n]]));

  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it('never sends a hidden test with the cards', async () => {
    const { duel } = await duelWith('idle');
    const { cards } = await duel.cards();
    expect(cards.map((c: any) => c.id)).toEqual(CARDS);
    // Three levels, more than one card at each, easiest first.
    const levels = cards.map((c: any) => c.level);
    expect(levels).toEqual([...levels].sort());
    for (const level of [1, 2, 3]) expect(levels.filter((l: number) => l === level).length).toBeGreaterThan(1);
    for (const card of cards) expect(Object.keys(card)).not.toEqual(expect.arrayContaining(['dir', 'hiddenTests']));
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

  it('every hidden test is named on its card, and says which task or example asks for it', async () => {
    for (const id of CARDS) {
      const card = JSON.parse(await readFile(join(ROOT, 'challenges', id, 'card.json'), 'utf8'));
      const hidden = await readFile(join(ROOT, 'challenges', id, 'hidden.test.js'), 'utf8');
      // As many declared as there are, each by the name the runner will print.
      const titles = [...hidden.matchAll(/^test\('([^']+)'/gm)].map((m) => m[1]);
      expect(titles.sort()).toEqual(card.hiddenTests.map((h: any) => h.title).sort());
      for (const { covers } of card.hiddenTests) {
        // Nothing hidden may ask for something the card never showed.
        const [kind, index] = covers.split(':');
        expect(['intro', 'task', 'example']).toContain(kind);
        if (kind === 'task') expect(card.tasks.zh[Number(index)]).toBeTypeOf('string');
        if (kind === 'example') expect(card.examples[Number(index)]).toBeTypeOf('object');
      }
    }
  });

  it.each(CARDS)('%s has its own repository: the start fails both tests, a few lines pass them', async (cardId) => {
    if (cardId === '04-emoji' && !installed) return;
    const { duel } = await duelWith('hang');
    const { cards } = await duel.cards();
    const card = cards.find((c: any) => c.id === cardId);
    const { id, files, editable } = await duel.start({ card: cardId, agent: 'fake', limitSec: 120 });
    expect(Object.keys(files)).toContain(card.open);
    expect(editable).toEqual(card.editable);
    // The repository's own tests are shown to both sides, and are nobody's to rewrite.
    const raw = JSON.parse(await readFile(join(ROOT, 'challenges', cardId, 'card.json'), 'utf8'));
    expect(editable).toEqual(raw.files.filter((f: string) => !raw.publicTest.includes(f)));
    expect(editableFiles(raw)).toEqual(editable);
    for (const other of cards) if (other.id !== cardId) expect(Object.keys(files)).not.toContain(other.open);
    await duel.go({ id });

    // The repository's own tests are red on the start too: pressing Run has something to say.
    const before = await duel.test({ id, files: mine(files, editable) });
    expect(before.ok).toBe(false);
    expect(before.failed).toBeGreaterThan(0);
    expect((await duel.submit({ id, files: mine(files, editable) })).pass).toBe(false);

    const solved: Record<string, string> = { ...mine(files, editable), [card.open]: SOLUTIONS[cardId](files[card.open]) };
    expect(solved[card.open]).not.toBe(files[card.open]);
    expect((await duel.test({ id, files: solved })).ok).toBe(true);
    expect((await duel.submit({ id, files: solved })).pass).toBe(true);
    expect(stateOf(duel, id).result).toEqual({ winner: 'human', reason: 'pass' });
  }, 120_000);

  it('an agent that solves the card wins, with its log, usage, changed files and patch reported', async () => {
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
    // What it wrote, for the result screen.
    await until(() => stateOf(duel, id).agent.diff !== '');
    expect(stateOf(duel, id).agent.diff).toContain('i += step');
  }, 60_000);

  it('a person may fail, fix and submit again; the agent gets one verdict; the hidden test leaves no trace', async () => {
    const { duel, runsDir } = await duelWith('idle');
    const { id, files, editable } = await duel.start({ card: '01-range', agent: 'fake', model: 'm2', limitSec: 120 });
    await duel.go({ id });
    await until(() => stateOf(duel, id).agent.status === 'fail');
    expect(stateOf(duel, id).result).toBeNull();

    const first = await duel.submit({ id, files: mine(files, editable) });
    expect(first.pass).toBe(false);
    expect(first.output).toContain('card 01');
    expect(first.failures.length).toBeGreaterThan(0);
    expect(stateOf(duel, id).human).toMatchObject({ status: 'working', attempts: 1 });

    await expect(duel.test({ id, files: { '../escape.js': 'x' } })).rejects.toThrow(/not one of/);
    // The repository's own tests are shown, not the person's to rewrite.
    await expect(duel.submit({ id, files: { 'range.test.js': 'nothing to see' } })).rejects.toThrow(/not one of/);

    const second = await duel.submit({ id, files: { 'range.js': SOLUTIONS['01-range'](files['range.js']) } });
    expect(second.pass).toBe(true);
    expect(second.passed).toBeGreaterThan(0);
    expect(stateOf(duel, id).result).toEqual({ winner: 'human', reason: 'pass' });
    // The run directory goes with the result, hidden test and all.
    await until(() => !existsSync(join(runsDir, id)));
    await expect(duel.submit({ id, files })).rejects.toThrow(/over/);
  }, 90_000);

  it('a green exit code is not a pass: the card\'s hidden tests have to have run', async () => {
    const { duel } = await duelWith('idle');
    const { id, files, editable } = await duel.start({ card: '01-range', agent: 'fake', limitSec: 120 });
    await duel.go({ id });
    // `process.exit(0)` before the tests load makes the runner exit 0 with nothing red in it.
    const ducked = await duel.submit({ id, files: { ...mine(files, editable), 'range.js': `process.exit(0);\n${files['range.js']}` } });
    expect(ducked.pass).toBe(false);
    expect(ducked.output).toContain('never ran');
    expect(stateOf(duel, id).result).toBeNull();
  }, 60_000);

  it('survives a test that prints without stopping, and says the output was cut', async () => {
    const { duel } = await duelWith('idle');
    const { id, files, editable } = await duel.start({ card: '01-range', agent: 'fake', limitSec: 120 });
    await duel.go({ id });
    // Eight megabytes of noise. Kept whole, this used to grow a string until V8 threw inside a
    // stream listener, which took the server with it.
    const noisy = `const line = 'x'.repeat(1024);\nfor (let i = 0; i < 8192; i++) console.log(line);\n${SOLUTIONS['01-range'](files['range.js'])}`;
    const verdict = await duel.test({ id, files: { ...mine(files, editable), 'range.js': noisy } });
    expect(typeof verdict.output).toBe('string');
    expect(verdict.output.length).toBeLessThan(20_000);
    // Still answering afterwards: the process is the point of this test.
    expect((await duel.test({ id, files: { 'range.js': SOLUTIONS['01-range'](files['range.js']) } })).ok).toBe(true);
  }, 120_000);

  it('gives the person their time back when a verdict takes a while', async () => {
    const { duel } = await duelWith('idle');
    const { id, files, editable } = await duel.start({ card: '01-range', agent: 'fake', limitSec: 120 });
    const wallFrom = Date.now();
    await duel.go({ id });
    // One failing verdict, which takes as long as `node --test` takes to start.
    const before = stateOf(duel, id).elapsedMs;
    await duel.submit({ id, files: mine(files, editable) });
    const state = stateOf(duel, id);
    const wall = Date.now() - wallFrom;
    expect(state.human.status).toBe('working');
    // The wall clock ran through the verdict; the person's clock did not.
    expect(wall - state.elapsedMs).toBeGreaterThan(200);
    expect(state.elapsedMs).toBeGreaterThanOrEqual(before);
  }, 60_000);

  it('practice is the same card with nobody on the other side', async () => {
    const { duel } = await duelWith('idle');
    const { id, files, editable, practice } = await duel.start({ card: '01-range', agent: 'practice', limitSec: 120 });
    expect(practice).toBe(true);
    await duel.go({ id });
    expect(stateOf(duel, id).agent).toBeFalsy();
    expect((await duel.submit({ id, files: { 'range.js': SOLUTIONS['01-range'](files['range.js']) } })).pass).toBe(true);
    expect(stateOf(duel, id).result).toEqual({ winner: 'human', reason: 'pass' });
    expect(editable).toEqual(['range.js']);
  }, 60_000);

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

  it('checks an agent for Settings: its version for free, one real run when asked', async () => {
    const { duel, runsDir } = await duelWith('say');
    expect(await duel.check({ agent: 'fake' })).toMatchObject({ ok: true, detail: process.version });
    expect(await duel.check({ agent: 'fake', deep: true, model: 'm2' })).toMatchObject({ ok: true, model: 'm2', detail: 'OK' });
    // Nothing of a check is left for the next one to find.
    expect(existsSync(runsDir) ? (await readdir(runsDir)).filter((n) => n.startsWith('check-')) : []).toEqual([]);
    await expect(duel.check({ agent: 'nobody' })).rejects.toMatchObject({ status: 400 });

    // A failure is an answer, not an error: the page shows why.
    const refusing = await duelWith('refuse');
    expect(await refusing.duel.check({ agent: 'fake', deep: true })).toMatchObject({ ok: false, detail: 'not logged in' });
    // Starting, and then saying nothing, is not working.
    const silent = await duelWith('idle');
    expect((await silent.duel.check({ agent: 'fake', deep: true })).ok).toBe(false);
    const missing = createDuel({ agents: [{ id: 'gone', bin: 'no-such-cli-anywhere', models: ['m'], args: () => [], readLine: readStreamJson }], runsDir });
    expect(await missing.check({ agent: 'gone', deep: true })).toMatchObject({ ok: false, detail: expect.stringContaining('PATH') });
  }, 60_000);

  it('takes the agent\'s whole process group with it, helpers of its own included', async () => {
    const { duel, runsDir } = await duelWith('spawn');
    const { id } = await duel.start({ card: '01-range', agent: 'fake', limitSec: 120 });
    await duel.go({ id });
    const pidFile = join(runsDir, id, 'agent', 'helper.pid');
    await until(() => existsSync(pidFile));
    const helper = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(helper, 0)).not.toThrow();

    duel.stop({ id });
    // SIGTERM, then SIGKILL for whatever ignored it.
    await until(() => {
      try {
        process.kill(helper, 0);
        return false;
      } catch {
        return true;
      }
    });
  }, 60_000);
});
