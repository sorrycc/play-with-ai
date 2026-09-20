// The code duel: a person and a code agent get the same task card on the same small repository,
// and whoever first makes the hidden acceptance test pass wins. Every card is an environment of
// its own, a directory under challenges/:
//
//   card.json        what the page shows, plus `files` (what the person may edit), `publicTest`,
//                    `open`, and `test`: "node" (node --test, nothing to install) or "ava"
//   hidden.test.js   the acceptance test; never sent to the page, never left in a run directory
//   start/           the repository both sides start from
//
// Unlike every other game here, the
// match lives on the server, because both sides' work is files on disk and running tests.
//
//   GET  /api/duel/cards   the task cards (never their hidden tests)
//   POST /api/duel/start   prepare two clean copies of the card's repo; returns the person's files
//   POST /api/duel/go      start the clock and the agent
//   GET  /api/duel/state   the clock, both sides' status, the agent's log from `from` on
//   POST /api/duel/test    save the person's files and run the repo's own tests
//   POST /api/duel/submit  save, stop the person's clock, run the hidden test
//   POST /api/duel/stop    end the run and kill the agent
//
// A side's time runs until it says "done": the person presses Submit, the agent's process exits.
// Verifying is not on the clock. The agent gets one verdict; the person may fix and submit again.
//
// These routes write files and run code, so they answer only a page served from this machine.

import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents.mjs';

const CHALLENGES_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'challenges');
const VERIFY_TIMEOUT_MS = 90_000;
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_FILE_BYTES = 200_000;
const MAX_LOG_ENTRIES = 3000;
const MAX_OUTPUT_CHARS = 12_000;
const KEEP_RUNS = 5;
const LIMITS_SEC = [120, 180, 300, 600];
const HIDDEN_TEST = 'challenge.test.js';
/** What only the server needs: the page gets the rest of card.json. */
const SERVER_ONLY = ['dir', 'files', 'publicTest', 'test'];

/**
 * The task as the agent reads it: the card the person sees, hint included, and nothing more.
 * Built from the card rather than written by hand, so neither side knows more than the other.
 */
export function promptFor(card) {
  return [
    card.intro.zh,
    `要求：\n${card.tasks.zh.map((task) => `- ${task}`).join('\n')}`,
    `例子：\n${card.examples.map((e) => `- ${e.input} 得到 ${e.output}`).join('\n')}`,
    `提示：${card.hint.zh}`,
    '改完跑 npm test 确认通过。',
  ].join('\n\n');
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// eslint-disable-next-line no-control-regex
const plain = (text) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
const tail = (text) => (text.length > MAX_OUTPUT_CHARS ? `…\n${text.slice(-MAX_OUTPUT_CHARS)}` : text);

/** Runs a command to completion; never rejects. Output is stdout and stderr interleaved, colours removed. */
function run(bin, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    const child = spawn(bin, args, { cwd, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      output += `\n(timed out after ${Math.round(timeoutMs / 1000)} s)`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: String(error.message), ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: tail(plain(output).trim()), ms: Date.now() - started });
    });
  });
}

async function findOnPath(bin, pathVar = process.env.PATH || '') {
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    const full = join(dir, bin);
    try {
      await access(full, constants.X_OK);
      return full;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Who has won, if anyone yet. Pure, so the rules can be tested without a process in sight.
 *
 * A pass wins unless the other side said "done" earlier and is still being verified: verifying is
 * off the clock, so a slow test run must not cost the faster side the match.
 */
export function adjudicate(sides, elapsedMs, limitMs) {
  const entries = Object.entries(sides);
  const passed = entries.filter(([, s]) => s.status === 'pass').sort((a, b) => a[1].doneMs - b[1].doneMs);
  const verifying = entries.filter(([, s]) => s.status === 'verifying');
  if (passed.length > 0) {
    const [name, best] = passed[0];
    if (verifying.some(([, s]) => s.doneMs < best.doneMs)) return null;
    return { winner: name, reason: 'pass' };
  }
  if (elapsedMs >= limitMs && verifying.length === 0) return { winner: null, reason: 'timeout' };
  return null;
}

/** Only a page this machine serves may use these routes: they write files and run what was written. */
export function isLocalRequest(headers) {
  const local = (host) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host || '');
  if (!local(headers.host)) return false;
  if (!headers.origin) return true;
  try {
    return new URL(headers.origin).host === headers.host;
  } catch {
    return false;
  }
}

export function createDuel({ challengesDir = CHALLENGES_DIR, agents = AGENTS, runsDir = join(tmpdir(), 'play-with-ai-duel') } = {}) {
  const runs = new Map();
  const installing = new Map();

  /** Every directory with a card.json, in name order; the directory's name is the card's id. */
  async function cards() {
    const names = (await readdir(challengesDir)).filter((n) => existsSync(join(challengesDir, n, 'card.json'))).sort();
    return Promise.all(names.map(async (id) => ({ ...JSON.parse(await readFile(join(challengesDir, id, 'card.json'), 'utf8')), id, dir: join(challengesDir, id) })));
  }

  async function availableAgents() {
    const found = await Promise.all(agents.map(async (a) => ((await findOnPath(a.bin)) ? a.id : null)));
    return found.filter(Boolean);
  }

  /** A card whose tests need packages has them installed once, the first time anyone plays it. */
  function ensureInstalled(card) {
    const startDir = join(card.dir, 'start');
    if (card.test !== 'ava' || existsSync(join(startDir, 'node_modules', '.bin', 'ava'))) return Promise.resolve();
    if (!installing.has(card.id)) {
      installing.set(
        card.id,
        run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: startDir, timeoutMs: INSTALL_TIMEOUT_MS }).then((r) => {
          installing.delete(card.id);
          if (!r.ok) throw fail(500, `npm ci failed in challenges/${card.id}/start:\n${r.output.slice(-600)}`);
        }),
      );
    }
    return installing.get(card.id);
  }

  async function freshCopy(card, dir) {
    // Clone where the file system can (APFS): thousands of small files in node_modules.
    await cp(join(card.dir, 'start'), dir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n');
    const git = (...args) => run('git', ['-c', 'user.name=duel', '-c', 'user.email=duel@local', ...args], { cwd: dir, timeoutMs: 20_000 });
    await git('init', '-q');
    await git('add', '-A');
    await git('commit', '-qm', 'start');
  }

  async function changedFiles(dir) {
    const r = await run('git', ['status', '--short', '--', '.', `:!${HIDDEN_TEST}`], { cwd: dir, timeoutMs: 10_000 });
    // "XY name": the status letters, then the path.
    return r.ok ? r.output.split('\n').map((l) => l.trim().replace(/^\S+\s+/, '')).filter(Boolean) : [];
  }

  const runTests = (card, dir, files) =>
    card.test === 'ava'
      ? run(join(dir, 'node_modules', '.bin', 'ava'), files, { cwd: dir, timeoutMs: VERIFY_TIMEOUT_MS })
      : run(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: dir, timeoutMs: VERIFY_TIMEOUT_MS });

  /** The repo's own tests plus the card's hidden one, which is in the directory only while this runs. */
  async function verify(match, dir) {
    const card = match.card;
    await cp(join(card.dir, 'hidden.test.js'), join(dir, HIDDEN_TEST));
    try {
      return await runTests(card, dir, [...card.publicTest, HIDDEN_TEST]);
    } finally {
      await rm(join(dir, HIDDEN_TEST), { force: true });
    }
  }

  const elapsed = (match) => (match.startedAt ? (match.endedAt ?? Date.now()) - match.startedAt : 0);

  function killAgent(match) {
    const child = match.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Its own process group: a CLI's helpers and the tests it started must go with it.
    const signal = (s) => {
      try {
        process.kill(-child.pid, s);
      } catch {
        /* already gone */
      }
    };
    signal('SIGTERM');
    setTimeout(() => signal('SIGKILL'), 2000).unref();
  }

  function settle(match, forced) {
    if (match.result) return;
    const result = forced ?? adjudicate(match.sides, elapsed(match), match.limitMs);
    if (!result) return;
    match.result = result;
    match.endedAt = Date.now();
    clearTimeout(match.timer);
    const agent = match.sides.agent;
    if (agent.status === 'working') {
      agent.status = 'killed';
      agent.doneMs ??= elapsed(match);
    }
    killAgent(match);
    // What it had touched when it was cut off is still worth showing.
    if (agent.status === 'killed') void changedFiles(join(match.dir, 'agent')).then((files) => (agent.changed = files));
  }

  function log(match, entry) {
    const entries = match.sides.agent.log;
    if (entries.length < MAX_LOG_ENTRIES) entries.push({ ...entry, at: elapsed(match) });
  }

  function launchAgent(match) {
    const side = match.sides.agent;
    const agent = agents.find((a) => a.id === match.agent);
    side.status = 'working';
    const child = spawn(match.agentBin, agent.args({ prompt: match.prompt, model: match.model }), { cwd: join(match.dir, 'agent'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    match.child = child;

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const read = agent.readLine(line);
        read.entries.forEach((e) => log(match, e));
        if (read.usage) side.usage = read.usage;
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = plain(String(chunk)).trim();
      if (text) log(match, { kind: 'info', text: text.slice(0, 400) });
    });
    child.on('error', (error) => {
      side.status = 'error';
      side.doneMs = elapsed(match);
      log(match, { kind: 'info', text: String(error.message) });
      settle(match);
    });
    child.on('close', async (code) => {
      if (match.result || side.status !== 'working') return;
      side.doneMs = elapsed(match);
      side.exitCode = code;
      side.status = 'verifying';
      const dir = join(match.dir, 'agent');
      side.changed = await changedFiles(dir);
      const verdict = await verify(match, dir);
      side.output = verdict.output;
      side.status = verdict.ok ? 'pass' : 'fail';
      settle(match);
    });
  }

  async function savePersonFiles(match, files) {
    const allowed = match.card.files;
    if (!files || typeof files !== 'object') throw fail(400, 'files must be an object of name: content');
    for (const [name, content] of Object.entries(files)) {
      if (!allowed.includes(name)) throw fail(400, `${name} is not one of this challenge's files`);
      if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) throw fail(400, `${name} is too large`);
    }
    for (const [name, content] of Object.entries(files)) await writeFile(join(match.dir, 'human', name), content);
  }

  /** One test run at a time per directory: two would fight over the same files. */
  function queued(side, job) {
    const next = side.queue.then(job, job);
    side.queue = next.catch(() => {});
    return next;
  }

  const get = (id) => {
    const match = runs.get(id);
    if (!match) throw fail(404, 'no such run; it may have been replaced by a newer one');
    return match;
  };

  function stopAll() {
    for (const match of runs.values()) settle(match, { winner: null, reason: 'stopped' });
  }

  const api = {
    async cards() {
      return { cards: (await cards()).map((card) => Object.fromEntries(Object.entries(card).filter(([key]) => !SERVER_ONLY.includes(key)))) };
    },

    async start(body) {
      const card = (await cards()).find((c) => c.id === body.card);
      if (!card) throw fail(400, 'unknown card');
      const agent = agents.find((a) => a.id === body.agent);
      if (!agent) throw fail(400, 'unknown agent');
      const model = agent.models.includes(body.model) ? body.model : agent.models[0];
      const limitSec = LIMITS_SEC.includes(body.limitSec) ? body.limitSec : 180;
      const agentBin = await findOnPath(agent.bin);
      if (!agentBin) throw fail(503, `${agent.bin} is not on the server's PATH`);

      // One duel at a time: a reloaded page must not leave an agent working for nobody.
      stopAll();
      await ensureInstalled(card);
      await mkdir(runsDir, { recursive: true });
      const old = (await readdir(runsDir)).filter((n) => n.startsWith('run-')).sort().reverse().slice(KEEP_RUNS - 1);
      await Promise.all(old.map((n) => rm(join(runsDir, n), { recursive: true, force: true })));

      const id = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
      const dir = join(runsDir, id);
      await mkdir(dir, { recursive: true });
      await Promise.all([freshCopy(card, join(dir, 'human')), freshCopy(card, join(dir, 'agent'))]);

      const files = Object.fromEntries(await Promise.all(card.files.map(async (n) => [n, await readFile(join(dir, 'human', n), 'utf8')])));
      runs.set(id, {
        id,
        dir,
        card,
        prompt: promptFor(card),
        agent: agent.id,
        agentBin,
        model,
        limitMs: limitSec * 1000,
        startedAt: null,
        endedAt: null,
        result: null,
        child: null,
        timer: null,
        sides: {
          human: { status: 'idle', doneMs: null, attempts: 0, queue: Promise.resolve() },
          agent: { status: 'idle', doneMs: null, exitCode: null, usage: null, changed: [], output: '', log: [] },
        },
      });
      return { id, files, limitSec, model };
    },

    async go(body) {
      const match = get(body.id);
      if (match.startedAt) return { ok: true };
      match.startedAt = Date.now();
      match.sides.human.status = 'working';
      match.timer = setTimeout(() => {
        // Time is up for the agent whatever it is doing; a verdict already under way still counts.
        if (match.sides.agent.status === 'working') {
          match.sides.agent.status = 'killed';
          match.sides.agent.doneMs = match.limitMs;
        }
        killAgent(match);
        settle(match);
      }, match.limitMs);
      match.timer.unref();
      launchAgent(match);
      return { ok: true };
    },

    state(query) {
      const match = get(query.get('id'));
      const from = Math.max(0, Number(query.get('from')) || 0);
      const { human, agent } = match.sides;
      return {
        elapsedMs: elapsed(match),
        limitMs: match.limitMs,
        human: { status: human.status, doneMs: human.doneMs, attempts: human.attempts },
        agent: { status: agent.status, doneMs: agent.doneMs, exitCode: agent.exitCode, usage: agent.usage, changed: agent.changed, output: match.result ? agent.output : '', log: agent.log.slice(from), logTotal: agent.log.length },
        result: match.result,
      };
    },

    async test(body) {
      const match = get(body.id);
      if (match.result) throw fail(409, 'the duel is over');
      return queued(match.sides.human, async () => {
        await savePersonFiles(match, body.files);
        const r = await runTests(match.card, join(match.dir, 'human'), match.card.publicTest);
        return { ok: r.ok, output: r.output, ms: r.ms };
      });
    },

    async submit(body) {
      const match = get(body.id);
      const side = match.sides.human;
      if (!match.startedAt) throw fail(409, 'the duel has not started');
      if (match.result) throw fail(409, 'the duel is over');
      if (side.status === 'verifying') throw fail(409, 'already verifying');
      if (elapsed(match) >= match.limitMs) throw fail(409, 'time is up');
      // The clock stops here, when the person says "done", not when the verdict arrives.
      side.doneMs = elapsed(match);
      side.status = 'verifying';
      side.attempts += 1;
      return queued(side, async () => {
        try {
          await savePersonFiles(match, body.files);
          const verdict = await verify(match, join(match.dir, 'human'));
          side.status = verdict.ok ? 'pass' : 'working';
          return { pass: verdict.ok, output: verdict.output, doneMs: side.doneMs };
        } catch (error) {
          side.status = 'working';
          throw error;
        } finally {
          settle(match);
        }
      });
    },

    stop(body) {
      const match = runs.get(body.id);
      if (match) settle(match, { winner: null, reason: 'stopped' });
      return { ok: true };
    },
  };

  // The agent runs in its own process group, so Ctrl-C on the server does not reach it by itself.
  process.once('exit', stopAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      stopAll();
      process.exit();
    });
  }

  return { ...api, availableAgents, stopAll };
}
