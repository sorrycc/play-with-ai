// The code duel: a person and a code agent get the same task card on the same small repository,
// and whoever first makes the hidden acceptance test pass wins. Every card is an environment of
// its own, a directory under challenges/:
//
//   card.json        what the page shows, plus `files` (what the person sees), `publicTest` (the
//                    repository's own tests: shown, never editable), `open`, `hiddenTests` (the
//                    title of every hidden test and what on the card asks for it), and `test`:
//                    "node" (node --test, nothing to install) or "ava"
//   hidden.test.js   the acceptance test; never sent to the page, never left in a run directory
//   start/           the repository both sides start from
//
// Unlike every other game here, the
// match lives on the server, because both sides' work is files on disk and running tests.
//
//   GET  /api/duel/cards   the task cards (never their hidden tests)
//   POST /api/duel/start   prepare the copies of the card's repo; returns the person's files
//   POST /api/duel/go      start the clock and the agent
//   GET  /api/duel/state   the clock, both sides' status, the agent's log from `from` on
//   POST /api/duel/test    save the person's files and run the repo's own tests
//   POST /api/duel/submit  save, stop the person's clock, run the hidden test
//   POST /api/duel/stop    end the run and kill the agent
//
// A side's time runs until it says "done": the person presses Submit, the agent's process exits.
// Verifying is off that side's own clock, limit included, so a failed verdict hands the person the
// rest of their time back. The agent gets one verdict; the person may fix and submit again.
//
// A pass is not an exit code: the runner speaks TAP, and every hidden test the card names must be
// there by name and green. An exit code alone would hand the match to `process.exit(0)`.
//
// These routes write files and run code, so they answer only a page served from this machine.

import { spawn, spawnSync } from 'node:child_process';
import { constants, existsSync, rmSync } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents.mjs';

const WIN = process.platform === 'win32';
const CHALLENGES_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'challenges');
const VERIFY_TIMEOUT_MS = 90_000;
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_FILE_BYTES = 200_000;
const MAX_LOG_ENTRIES = 3000;
const MAX_OUTPUT_CHARS = 12_000;
/** What a single run may hold in memory. Without it a test that prints in a loop ends the server. */
const MAX_CAPTURE_BYTES = 256_000;
/** One line of an agent's stdout. A CLI that never writes a newline must not grow without end. */
const MAX_AGENT_LINE_BYTES = 64_000;
const MAX_DIFF_CHARS = 40_000;
/** Finished runs kept in memory, for the result screen; their directories go at once. */
const KEEP_RUNS = 5;
/**
 * A page that has stopped asking is a page that is gone: its agent must not work for nobody. The
 * backstop is generous because a background tab's timers are throttled to about one a minute;
 * a tab that closes properly says so with a beacon long before this.
 */
const HEARTBEAT_MS = 90_000;
const WATCHDOG_MS = 5_000;
const LIMITS_SEC = [120, 180, 300, 600];
const HEAD_STARTS_SEC = [0, 15, 30, 60];
/** The "no agent" seat: the same card and clock, nobody on the other side. */
export const PRACTICE = 'practice';
const HIDDEN_TEST = 'challenge.test.js';
/** Git for Windows rewrites line endings by default, and warns about it into the diff. */
const NO_CRLF = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
/** Retries: on Windows a directory a just-killed process had open stays EBUSY for a moment. */
const RM_DIR = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
/** Started with node rather than through node_modules/.bin, where Windows has a .cmd. */
const AVA_CLI = join('node_modules', 'ava', 'entrypoints', 'cli.mjs');
/** What only the server needs: the page gets the rest of card.json. */
const SERVER_ONLY = ['dir', 'files', 'publicTest', 'test', 'hiddenTests'];

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

/** What the person may write: the source, never the repository's own tests. Both sides are shown both. */
export const editableFiles = (card) => card.files.filter((name) => !card.publicTest.includes(name));

const fail = (status, message) => Object.assign(new Error(message), { status });

// eslint-disable-next-line no-control-regex
const plain = (text) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r\n/g, '\n');
const tail = (text) => (text.length > MAX_OUTPUT_CHARS ? `…\n${text.slice(-MAX_OUTPUT_CHARS)}` : text);

/**
 * Its own process group, so a runner's workers and whatever they started go with it.
 * Windows has neither groups nor signals: taskkill /T walks the tree from a parent that is still
 * alive, and /F is the only kind of kill there is. Synchronous, because shutdown() has to be.
 */
function killGroup(child, signal) {
  try {
    if (!WIN) return void process.kill(-child.pid, signal);
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* already gone, or never had a group */
  }
}

/** A child in its own group where there are groups; on Windows that would be a console window of its own. */
const SPAWN = { stdio: ['ignore', 'pipe', 'pipe'], detached: !WIN, windowsHide: true };

/**
 * Runs a command to completion; never rejects. Output is stdout and stderr interleaved, colours removed.
 * `shell` is for npm, which on Windows is a .cmd that only cmd.exe can start; its arguments are ours.
 */
function run(bin, args, { cwd, timeoutMs, env, shell = false }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let flooded = false;
    let child;
    try {
      // Detached: `node --test` and ava run a process per file, and a timeout must reach them too.
      const options = { ...SPAWN, cwd, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env } };
      child = shell ? spawn([bin, ...args].join(' '), { ...options, shell: true }) : spawn(bin, args, options);
    } catch (error) {
      return resolve({ ok: false, output: String(error.message), ms: Date.now() - started });
    }
    // Only ever the last MAX_CAPTURE_BYTES: a test printing in a loop used to grow this string
    // until V8 refused, and the throw came out of a stream listener and took the server with it.
    const take = (chunk) => {
      output += chunk;
      if (output.length > MAX_CAPTURE_BYTES) {
        output = output.slice(-MAX_CAPTURE_BYTES);
        flooded = true;
      }
    };
    const timer = setTimeout(() => {
      take(`\n(timed out after ${Math.round(timeoutMs / 1000)} s)`);
      killGroup(child, 'SIGKILL');
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: String(error.message), ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Whatever the runner left behind in its group has no one to report to.
      killGroup(child, 'SIGKILL');
      const text = tail(plain(output).trim());
      resolve({ ok: code === 0, output: flooded ? `(output was cut: the run printed more than ${Math.round(MAX_CAPTURE_BYTES / 1000)} kB)\n${text}` : text, ms: Date.now() - started });
    });
  });
}

/**
 * On Windows a bare name is not a file: PATHEXT says what it may be, in order, so an .exe wins over
 * the .cmd npm leaves beside it. The extensionless file npm also leaves there is a shell script.
 */
export async function findOnPath(bin, { pathVar = process.env.PATH || '', win = WIN, pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD' } = {}) {
  const names = win && !extname(bin) ? pathExt.split(';').filter(Boolean).map((ext) => bin + ext.toLowerCase()) : [bin];
  for (const dir of pathVar.split(win ? ';' : delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = join(dir, name);
      try {
        await access(full, constants.X_OK);
        return full;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** What an npm .cmd shim starts: the last line is `"%_prog%" "%dp0%\node_modules\…\cli.js" %*`. */
export function shimTarget(text) {
  const found = /"%(?:~dp0|dp0%)\\?([^"%]+)"\s+%\*/.exec(text);
  return found ? found[1] : null;
}

/**
 * How to start `bin` without a shell. A .cmd needs cmd.exe, and cmd.exe cannot carry a prompt: it
 * ends an argument at the first newline. So a shim is read for the script or .exe it would start.
 */
async function commandFor(bin, args) {
  if (!/\.(cmd|bat)$/i.test(bin)) return [bin, args];
  const target = shimTarget(await readFile(bin, 'utf8').catch(() => ''));
  if (!target) throw fail(503, `${bin} is a batch file this server cannot start; install the agent's .exe instead`);
  const full = join(dirname(bin), target);
  return /\.exe$/i.test(full) ? [full, args] : [process.execPath, [full, ...args]];
}

/** Diagnostic keys that say where a failure happened, not what it was. */
const TAP_NOISE = /^(duration_ms|type|location|failureType|code|name|stack|at|operator|expected|actual|assertion|diff|values):/;

/**
 * Both runners speak TAP 13: `ok 1 - title`, `not ok 2 - title`, then an indented YAML block.
 * Reading it, rather than trusting the exit code, is what makes a verdict mean something.
 */
export function readTap(text) {
  const cases = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(not ok|ok) (\d+) - (.*)$/.exec(lines[i]);
    if (!match) continue;
    const [, indent, verdict, , rawTitle] = match;
    const title = rawTitle.replace(/\s+#\s+(SKIP|TODO).*$/i, '').trim();
    const detail = [];
    if (verdict === 'not ok') {
      // The YAML block that follows, minus the keys that only say where it happened.
      for (let j = i + 1; j < lines.length && detail.length < 6; j++) {
        const line = lines[j].slice(indent.length + 2);
        if (!lines[j].startsWith(`${indent}  `)) break;
        if (line.trim() === '---') continue;
        if (line.trim() === '...') break;
        if (TAP_NOISE.test(line.trim())) continue;
        if (line.trim()) detail.push(line.trim().replace(/^(error|message|details):\s*\|?-?\s*/, ''));
      }
    }
    cases.push({ ok: verdict === 'ok', title, detail: detail.filter(Boolean).join('\n') });
  }
  const count = (key) => {
    const found = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(text);
    return found ? Number(found[1]) : null;
  };
  return { cases, pass: count('pass'), fail: count('fail'), tests: count('tests') };
}

/**
 * Did the card's hidden tests really run and pass? Every title the card names must be there and
 * green, and nothing may be red. ava prefixes a title with its file (`challenge › card 01: …`).
 */
export function judge(card, result) {
  const tap = readTap(result.output);
  const named = (title) => (test) => test === title || test.endsWith(`› ${title}`);
  const green = tap.cases.filter((c) => c.ok).map((c) => c.title);
  const failed = tap.cases.filter((c) => !c.ok);
  // A hidden test the runner never mentioned is not a pass, whatever the exit code said: this is
  // what `process.exit(0)` at the top of the source file looks like from out here.
  const missing = card.hiddenTests.map((h) => h.title).filter((title) => !tap.cases.some((c) => named(title)(c.title)));
  const report = [];
  for (const one of failed) report.push(`✖ ${one.title}${one.detail ? `\n${one.detail.replace(/^/gm, '   ')}` : ''}`);
  for (const title of missing) report.push(`✖ ${title}\n   (never ran)`);
  if (tap.cases.length === 0) report.push(result.output || '(the runner said nothing)');
  const ok = failed.length === 0 && missing.length === 0 && tap.cases.length > 0;
  return {
    ok,
    passed: green.length,
    failed: failed.length + missing.length,
    /** The titles the person is allowed to see: their own card's, not the numbers behind them. */
    failures: [...failed.map((f) => f.title), ...missing].slice(0, 12),
    output: ok ? `${green.length} tests passed.` : tail(report.join('\n\n')),
  };
}

/** Who has won, if anyone yet. Pure, so the rules can be tested without a process in sight. */
export function adjudicate(sides, clocks, limitMs) {
  const entries = Object.entries(sides);
  const passed = entries.filter(([, s]) => s.status === 'pass').sort((a, b) => a[1].doneMs - b[1].doneMs);
  const verifying = entries.filter(([, s]) => s.status === 'verifying');
  if (passed.length > 0) {
    const [name, best] = passed[0];
    // A pass does not win while the other side said "done" earlier and is still being verified:
    // verifying is off the clock, so a slow test run must not cost the faster side the match.
    if (verifying.some(([, s]) => s.doneMs < best.doneMs)) return null;
    return { winner: name, reason: 'pass' };
  }
  // Each side runs on its own clock, so the limit is reached separately.
  if (verifying.length === 0 && entries.every(([name]) => (clocks[name] ?? 0) >= limitMs)) return { winner: null, reason: 'timeout' };
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

// One set of signal handlers for the process, however many duels it builds: a handler per duel
// was eleven listeners on `exit` by the end of one test file.
const liveDuels = new Set();
let hooked = false;
function hookProcess() {
  if (hooked) return;
  hooked = true;
  // Synchronous: a timer scheduled here would never get to run, and the agent would outlive us.
  const shutdown = () => {
    for (const duel of liveDuels) duel.shutdown();
  };
  process.on('exit', shutdown);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      shutdown();
      process.exit();
    });
  }
}

export function createDuel({ challengesDir = CHALLENGES_DIR, agents = AGENTS, runsDir = join(tmpdir(), 'play-with-ai-duel') } = {}) {
  const runs = new Map();
  const installing = new Map();
  let watchdog = null;

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
    if (card.test !== 'ava' || existsSync(join(startDir, AVA_CLI))) return Promise.resolve();
    if (!installing.has(card.id)) {
      installing.set(
        card.id,
        run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: startDir, timeoutMs: INSTALL_TIMEOUT_MS, shell: WIN }).then((r) => {
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
    const git = (...args) => run('git', ['-c', 'user.name=duel', '-c', 'user.email=duel@local', ...NO_CRLF, ...args], { cwd: dir, timeoutMs: 20_000 });
    await git('init', '-q');
    await git('add', '-A');
    await git('commit', '-qm', 'start');
  }

  async function changedFiles(dir) {
    const r = await run('git', [...NO_CRLF, 'status', '--short', '--', '.', `:!${HIDDEN_TEST}`], { cwd: dir, timeoutMs: 10_000 });
    // "XY name": the status letters, then the path.
    return r.ok ? r.output.split('\n').map((l) => l.trim().replace(/^\S+\s+/, '')).filter(Boolean) : [];
  }

  /** What a side actually wrote, as a patch. The start is a commit, so this is one command. */
  async function diffOf(dir) {
    const r = await run('git', [...NO_CRLF, 'diff', '--no-color', '--', '.', `:!${HIDDEN_TEST}`], { cwd: dir, timeoutMs: 10_000 });
    if (!r.ok || !r.output.trim()) return '';
    return r.output.length > MAX_DIFF_CHARS ? `${r.output.slice(0, MAX_DIFF_CHARS)}\n…` : r.output;
  }

  const runTests = (card, dir, files) =>
    card.test === 'ava'
      ? run(process.execPath, [join(dir, AVA_CLI), '--tap', ...files], { cwd: dir, timeoutMs: VERIFY_TIMEOUT_MS })
      : run(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, timeoutMs: VERIFY_TIMEOUT_MS });

  /** The repository's own tests are the card's, not the contestant's: put them back before judging. */
  const restorePublicTests = (card, dir) => Promise.all(card.publicTest.map((name) => cp(join(card.dir, 'start', name), join(dir, name))));

  /** The repo's own tests plus the card's hidden one, which is in the directory only while this runs. */
  async function verify(match, dir) {
    const card = match.card;
    try {
      await restorePublicTests(card, dir);
      await cp(join(card.dir, 'hidden.test.js'), join(dir, HIDDEN_TEST));
      return judge(card, await runTests(card, dir, [...card.publicTest, HIDDEN_TEST]));
    } finally {
      // Inside the copy's own try: a throw half way through must not leave the test behind.
      await rm(join(dir, HIDDEN_TEST), { force: true }).catch(() => {});
    }
  }

  const elapsed = (match) => (match.startedAt ? (match.endedAt ?? Date.now()) - match.startedAt : 0);
  /** A side's own clock: the wall clock, less the time its verdicts took. */
  const sideClock = (match, side) => Math.max(0, elapsed(match) - side.offClockMs);
  const clocksOf = (match) => Object.fromEntries(Object.entries(match.sides).map(([name, side]) => [name, sideClock(match, side)]));

  function killAgent(match) {
    const child = match.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Its own process group: a CLI's helpers and the tests it started must go with it.
    killGroup(child, 'SIGTERM');
    match.killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 2000);
    match.killTimer.unref();
  }

  /** Nothing is left running or on disk once a duel is over. Runs after the last verdict. */
  async function collect(match) {
    const dir = match.dir;
    if (!dir) return;
    match.dir = null;
    await match.sides.human.queue.catch(() => {});
    const jobs = [
      (async () => {
        const human = match.sides.human;
        human.changed = await changedFiles(join(dir, 'human'));
        human.diff = await diffOf(join(dir, 'human'));
      })(),
    ];
    if (match.sides.agent) {
      jobs.push(
        (async () => {
          const agent = match.sides.agent;
          // What it had touched when it was cut off is still worth showing.
          agent.changed = await changedFiles(join(dir, 'agent'));
          agent.diff = await diffOf(join(dir, 'agent'));
        })(),
      );
    }
    await Promise.all(jobs).catch(() => {});
    await rm(dir, RM_DIR).catch(() => {});
  }

  function settle(match, forced) {
    if (match.result) return;
    const result = forced ?? adjudicate(match.sides, clocksOf(match), match.limitMs);
    if (!result) return;
    match.result = result;
    match.endedAt = Date.now();
    clearTimeout(match.endTimer);
    clearTimeout(match.agentTimer);
    const agent = match.sides.agent;
    if (agent && agent.status === 'working') {
      agent.status = 'killed';
      agent.doneMs ??= sideClock(match, agent);
    }
    killAgent(match);
    // Kept, so the next duel's sweep does not delete the directory out from under it.
    match.collecting = collect(match);
  }

  /** The person's limit moves with their own clock, so a failed verdict gives the time back. */
  function armEnd(match) {
    if (match.result || !match.startedAt) return;
    clearTimeout(match.endTimer);
    const left = Math.max(...Object.values(clocksOf(match)).map((c) => match.limitMs - c), 0);
    match.endTimer = setTimeout(() => settle(match), left + 50);
    match.endTimer.unref();
  }

  function log(match, entry) {
    const entries = match.sides.agent.log;
    if (entries.length < MAX_LOG_ENTRIES) entries.push({ ...entry, at: sideClock(match, match.sides.agent) });
  }

  function launchAgent(match) {
    const side = match.sides.agent;
    const agent = agents.find((a) => a.id === match.agent);
    side.status = 'working';
    const [bin, leading] = match.agentCommand;
    const child = spawn(bin, [...leading, ...agent.args({ prompt: match.prompt, model: match.model })], { ...SPAWN, cwd: join(match.dir, 'agent') });
    match.child = child;

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_AGENT_LINE_BYTES) buffer = buffer.slice(-MAX_AGENT_LINE_BYTES);
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
      side.doneMs = sideClock(match, side);
      log(match, { kind: 'info', text: String(error.message) });
      settle(match);
    });
    child.on('close', (code) => {
      if (match.result || side.status !== 'working') return;
      side.doneMs = sideClock(match, side);
      side.exitCode = code;
      side.status = 'verifying';
      const dir = join(match.dir, 'agent');
      // Everything after this point is asynchronous, and a throw here used to be an unhandled
      // rejection: the side stuck on "verifying", the duel never over, the process on its way out.
      void (async () => {
        try {
          side.changed = await changedFiles(dir);
          const verdict = await verify(match, dir);
          side.output = verdict.output;
          side.failures = verdict.failures;
          side.status = verdict.ok ? 'pass' : 'fail';
        } catch (error) {
          side.status = 'error';
          side.output = String(error?.message || error);
        } finally {
          settle(match);
        }
      })();
    });
  }

  async function savePersonFiles(match, files) {
    const allowed = editableFiles(match.card);
    if (!files || typeof files !== 'object') throw fail(400, 'files must be an object of name: content');
    for (const [name, content] of Object.entries(files)) {
      // The repository's own tests are shown but not the person's to rewrite: "the existing tests
      // still pass" has to mean something.
      if (!allowed.includes(name)) throw fail(400, `${name} is not one of this challenge's editable files`);
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
    match.seenAt = Date.now();
    return match;
  };

  const running = () => [...runs.values()].filter((m) => !m.result);

  function stopAll() {
    for (const match of running()) settle(match, { winner: null, reason: 'stopped' });
  }

  /** A page that closed cannot say so. If nobody has asked for a while, nobody is watching. */
  function watch() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      for (const match of running()) {
        if (match.startedAt && Date.now() - match.seenAt > HEARTBEAT_MS) settle(match, { winner: null, reason: 'stopped' });
      }
      if (running().length === 0) {
        clearInterval(watchdog);
        watchdog = null;
      }
    }, WATCHDOG_MS);
    watchdog.unref();
  }

  /** Called on the way out of the process: synchronous, because nothing after this gets to run. */
  function shutdown() {
    for (const match of runs.values()) {
      const child = match.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        killGroup(child, 'SIGTERM');
        // No 2 s grace: a timer here would never fire, and an agent that ignores SIGTERM would
        // be left orphaned, working on a duel nobody will ever see.
        killGroup(child, 'SIGKILL');
      }
      if (match.dir) {
        try {
          rmSync(match.dir, RM_DIR);
        } catch {
          /* best effort on the way out */
        }
        match.dir = null;
      }
    }
  }

  const sideState = (match, side) =>
    side && {
      status: side.status,
      doneMs: side.doneMs,
      changed: side.changed,
      // A patch of someone's work is the point of the result screen, and nothing before it.
      diff: match.result ? side.diff : '',
    };

  const api = {
    async cards() {
      return { cards: (await cards()).map((card) => ({ ...Object.fromEntries(Object.entries(card).filter(([key]) => !SERVER_ONLY.includes(key))), editable: editableFiles(card), shown: card.files })) };
    },

    async start(body) {
      const card = (await cards()).find((c) => c.id === body.card);
      if (!card) throw fail(400, 'unknown card');
      const practice = body.agent === PRACTICE;
      const agent = practice ? null : agents.find((a) => a.id === body.agent);
      if (!practice && !agent) throw fail(400, 'unknown agent');
      const model = agent ? (agent.models.includes(body.model) ? body.model : agent.models[0]) : '';
      const limitSec = LIMITS_SEC.includes(body.limitSec) ? body.limitSec : 180;
      const headStartSec = HEAD_STARTS_SEC.includes(body.headStartSec) ? body.headStartSec : 0;
      const agentBin = agent ? await findOnPath(agent.bin) : null;
      if (agent && !agentBin) throw fail(503, `${agent.bin} is not on the server's PATH`);
      const agentCommand = agent ? await commandFor(agentBin, []) : null;

      // One duel at a time: a reloaded page must not leave an agent working for nobody.
      stopAll();
      // Its patches are what the last result screen shows; let them be read before the sweep.
      await Promise.all([...runs.values()].map((m) => m.collecting).filter(Boolean));
      await ensureInstalled(card);
      await mkdir(runsDir, { recursive: true });
      // Every directory here belongs to a duel that is over, or to a process that died holding it.
      const stale = (await readdir(runsDir)).filter((n) => n.startsWith('run-'));
      await Promise.all(stale.map((n) => rm(join(runsDir, n), RM_DIR).catch(() => {})));

      const id = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
      const dir = join(runsDir, id);
      await mkdir(dir, { recursive: true });
      await Promise.all([freshCopy(card, join(dir, 'human')), ...(agent ? [freshCopy(card, join(dir, 'agent'))] : [])]);

      const files = Object.fromEntries(await Promise.all(card.files.map(async (n) => [n, await readFile(join(dir, 'human', n), 'utf8')])));
      const sides = {
        human: { status: 'idle', doneMs: null, attempts: 0, offClockMs: 0, verifyFrom: 0, changed: [], diff: '', queue: Promise.resolve() },
      };
      if (agent) sides.agent = { status: 'idle', doneMs: null, offClockMs: 0, exitCode: null, usage: null, changed: [], diff: '', output: '', failures: [], log: [] };
      runs.set(id, {
        id,
        dir,
        card,
        prompt: promptFor(card),
        agent: agent?.id ?? PRACTICE,
        agentCommand,
        model,
        limitMs: limitSec * 1000,
        headStartMs: agent ? headStartSec * 1000 : 0,
        startedAt: null,
        endedAt: null,
        seenAt: Date.now(),
        result: null,
        child: null,
        endTimer: null,
        agentTimer: null,
        killTimer: null,
        collecting: null,
        sides,
      });
      // Finished runs are kept only for the result screen; their directories went at the last verdict.
      for (const [key] of runs) {
        if (runs.size <= KEEP_RUNS) break;
        if (key !== id) runs.delete(key);
      }
      return { id, files, editable: editableFiles(card), limitSec, headStartSec, model, practice };
    },

    async go(body) {
      const match = get(body.id);
      if (match.startedAt) return { ok: true };
      match.startedAt = Date.now();
      match.sides.human.status = 'working';
      if (match.sides.agent) {
        match.agentTimer = setTimeout(() => {
          // Time is up for the agent whatever it is doing; a verdict already under way still counts.
          if (match.sides.agent.status === 'working') {
            match.sides.agent.status = 'killed';
            match.sides.agent.doneMs = match.limitMs;
          }
          killAgent(match);
          settle(match);
        }, match.limitMs);
        match.agentTimer.unref();
        // A head start is the person's: the agent waits before it may touch the repository.
        if (match.headStartMs > 0) {
          match.sides.agent.status = 'waiting';
          const wait = setTimeout(() => {
            if (!match.result) launchAgent(match);
          }, match.headStartMs);
          wait.unref();
        } else {
          launchAgent(match);
        }
      }
      armEnd(match);
      watch();
      return { ok: true };
    },

    state(query) {
      const match = get(query.get('id'));
      const from = Math.max(0, Number(query.get('from')) || 0);
      const { human, agent } = match.sides;
      return {
        elapsedMs: sideClock(match, human),
        limitMs: match.limitMs,
        human: { ...sideState(match, human), attempts: human.attempts },
        agent: agent && {
          ...sideState(match, agent),
          exitCode: agent.exitCode,
          usage: agent.usage,
          output: match.result ? agent.output : '',
          failures: match.result ? agent.failures : [],
          log: agent.log.slice(from),
          logTotal: agent.log.length,
        },
        result: match.result,
      };
    },

    async test(body) {
      const match = get(body.id);
      if (match.result) throw fail(409, 'the duel is over');
      if (match.sides.human.status === 'verifying') throw fail(409, 'a submission is being verified');
      return queued(match.sides.human, async () => {
        await savePersonFiles(match, body.files);
        await restorePublicTests(match.card, join(match.dir, 'human'));
        const r = await runTests(match.card, join(match.dir, 'human'), match.card.publicTest);
        const tap = readTap(r.output);
        const failures = tap.cases.filter((c) => !c.ok);
        return {
          ok: r.ok && failures.length === 0 && tap.cases.length > 0,
          passed: tap.cases.length - failures.length,
          failed: failures.length,
          failures: failures.map((f) => f.title).slice(0, 12),
          output: failures.length > 0 ? tail(failures.map((f) => `✖ ${f.title}${f.detail ? `\n${f.detail.replace(/^/gm, '   ')}` : ''}`).join('\n\n')) : r.output,
          ms: r.ms,
        };
      });
    },

    async submit(body) {
      const match = get(body.id);
      const side = match.sides.human;
      if (!match.startedAt) throw fail(409, 'the duel has not started');
      if (match.result) throw fail(409, 'the duel is over');
      if (side.status === 'verifying') throw fail(409, 'already verifying');
      if (sideClock(match, side) >= match.limitMs) throw fail(409, 'time is up');
      // The clock stops here, when the person says "done", not when the verdict arrives.
      side.doneMs = sideClock(match, side);
      side.verifyFrom = elapsed(match);
      side.status = 'verifying';
      side.attempts += 1;
      return queued(side, async () => {
        try {
          await savePersonFiles(match, body.files);
          const verdict = await verify(match, join(match.dir, 'human'));
          side.status = verdict.ok ? 'pass' : 'working';
          return { pass: verdict.ok, passed: verdict.passed, failed: verdict.failed, failures: verdict.failures, output: verdict.output, doneMs: side.doneMs };
        } catch (error) {
          side.status = 'working';
          throw error;
        } finally {
          // Verifying is off this side's clock, limit included: a failed verdict hands back the
          // rest of their time instead of quietly spending it.
          side.offClockMs += Math.max(0, elapsed(match) - side.verifyFrom);
          armEnd(match);
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

  hookProcess();
  const duel = { ...api, availableAgents, stopAll, shutdown };
  liveDuels.add(duel);
  return duel;
}
