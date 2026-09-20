// The page's half of the code duel. The match itself lives on the server (server/duel.mjs): this
// class prepares a run, starts it when the countdown ends, keeps the person's files, and polls for
// the clock, the agent's log and the result.

import { AGENTS, type AgentLogEntry, type AgentUsage } from '../../../server/agents.mjs';
import { t } from '../../core/i18n';
import { settings } from '../../core/settings';

export interface CodeOptions {
  card: string;
  limitSec: number;
  /** An id from server/agents.mjs, or `PRACTICE` for the card on its own. */
  agent: string;
  agentModel: string;
  /** Seconds the agent waits before it may touch the repository. */
  headStartSec: number;
}

export const CODE_LIMITS_SEC = [120, 180, 300, 600];
export const CODE_HEAD_STARTS_SEC = [0, 15, 30, 60];
/** The "no agent" seat: the same card and clock, nobody on the other side. */
export const PRACTICE = 'practice';

export const CODE_DEFAULTS: CodeOptions = { card: '01-range', limitSec: 120, agent: AGENTS[0].id, agentModel: AGENTS[0].models[0], headStartSec: 0 };

type Localized = { zh: string; en: string };

/** 1 is for anyone, 2 for someone who writes code, 3 makes that someone think. */
export type CardLevel = 1 | 2 | 3;

/** A task card as /api/duel/cards sends it: everything but the hidden test. */
export interface Card {
  id: string;
  level: CardLevel;
  title: Localized;
  intro: Localized;
  tasks: { zh: string[]; en: string[] };
  examples: { input: string; output: string }[];
  hint: Localized;
  /** The file the editor opens on. */
  open: string;
  /** Every file the person is shown. */
  shown: string[];
  /** The ones they may write: the repository's own tests are read-only. */
  editable: string[];
  /** The open-source repository the card is cut from; absent on a card written for the duel. */
  repo?: string;
}

export async function loadCards(): Promise<Card[]> {
  const res = await fetch('/api/duel/cards');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).cards;
}

export type SideStatus = 'idle' | 'waiting' | 'working' | 'verifying' | 'pass' | 'fail' | 'killed' | 'error';

export interface LogEntry extends AgentLogEntry {
  /** Milliseconds into the duel. */
  at: number;
}

interface SideState {
  status: SideStatus;
  doneMs: number | null;
  changed: string[];
  /** What the side wrote, as a patch; the server sends it once the match is over. */
  diff: string;
}

interface ServerState {
  elapsedMs: number;
  limitMs: number;
  human: SideState & { attempts: number };
  agent: (SideState & { exitCode: number | null; usage: AgentUsage | null; output: string; failures: string[]; log: LogEntry[]; logTotal: number }) | null;
  result: { winner: 'human' | 'agent' | null; reason: 'pass' | 'timeout' | 'stopped' } | null;
}

/** The agent as the page holds it: its log lives in `CodeMatch.log`, appended poll by poll. */
export type AgentView = Omit<NonNullable<ServerState['agent']>, 'log' | 'logTotal'>;

export interface CodeResult {
  winner: 0 | 1 | null;
  stopped: boolean;
  reason: string;
  elapsedMs: number;
}

/** What the last test run or submission said. */
export interface Verdict {
  kind: 'test' | 'submit';
  ok: boolean;
  /** How many of the tests that ran were green, and the titles of the ones that were not. */
  passed: number;
  failed: number;
  failures: string[];
  output: string;
}

/** A verdict came in for one side. */
export interface CodeEvent {
  side: 'human' | 'agent';
  pass: boolean;
}

const POLL_MS = 600;
/** A dropped request is not a lost duel: back off, keep asking, give up only after these. */
const POLL_RETRIES = 6;

async function post<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/duel/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  // A 404 on the route itself (not on a run) means the page is newer than the server process.
  if (res.status === 404 && json?.error === 'not_found') throw new Error(t('nav.staleServer'));
  if (!res.ok || !json) throw new Error(json?.message || `HTTP ${res.status}`);
  return json as T;
}

export class CodeMatch {
  status: 'preparing' | 'running' | 'done' = 'preparing';
  error = '';
  /** The person's files as the editor has them; `original` is the untouched repo. */
  files: Record<string, string> = {};
  original: Record<string, string> = {};
  /** Of those files, the ones the person may write. The tests are shown, not editable. */
  editable: string[] = [];
  human: ServerState['human'] = { status: 'idle', doneMs: null, attempts: 0, changed: [], diff: '' };
  agent: AgentView | null = null;
  log: LogEntry[] = [];
  verdict: Verdict | null = null;
  busy: 'test' | 'submit' | null = null;
  result: CodeResult | null = null;
  /** The person's best time on this card before today, in ms; null when this is their first. */
  previousBest: number | null = null;
  readonly limitMs: number;
  readonly practice: boolean;

  private id = '';
  private readonly prepared: Promise<void>;
  private stopped = false;
  private poller: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private misses = 0;
  /** The server's clock at the last poll, and this page's clock then. */
  private serverMs = 0;
  private serverAt = 0;

  constructor(
    private readonly options: CodeOptions,
    private readonly onChange: () => void,
    private readonly onEvent: (event: CodeEvent) => void = () => {},
  ) {
    this.limitMs = options.limitSec * 1000;
    this.practice = options.agent === PRACTICE;
    this.previousBest = settings.codeBest(options.card);
    // Copying the repo takes a moment; it happens under the countdown.
    this.prepared = post<{ id: string; files: Record<string, string>; editable: string[] }>('start', {
      card: options.card,
      agent: options.agent,
      model: options.agentModel,
      limitSec: options.limitSec,
      headStartSec: options.headStartSec,
    }).then(
      ({ id, files, editable }) => {
        this.id = id;
        this.files = { ...files };
        this.original = files;
        this.editable = editable;
        if (this.stopped) void post('stop', { id }).catch(() => {});
        this.onChange();
      },
      (error) => this.fail(error),
    );
  }

  /** Called when the countdown ends: the clock and the agent start together. */
  async start(): Promise<void> {
    await this.prepared;
    if (this.stopped || this.error) return;
    try {
      await post('go', { id: this.id });
    } catch (error) {
      return this.fail(error);
    }
    this.status = 'running';
    this.human.status = 'working';
    if (this.agent) this.agent.status = this.options.headStartSec > 0 ? 'waiting' : 'working';
    this.serverAt = performance.now();
    this.schedulePoll(POLL_MS);
    this.onChange();
  }

  /** Leaving the page or pressing Stop: the agent must not keep working for nobody. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.poller) clearTimeout(this.poller);
    if (this.id && !this.result) void post('stop', { id: this.id }).catch(() => {});
    // Even before the copies are ready, stopping ends in the same place: a result screen.
    if (!this.result) this.finish({ winner: null, reason: 'stopped' });
    this.status = 'done';
    this.onChange();
  }

  /** The tab is closing. A fetch would be cancelled with it; a beacon still arrives. */
  leave(): void {
    if (this.stopped || this.result || !this.id) return;
    try {
      navigator.sendBeacon('/api/duel/stop', new Blob([JSON.stringify({ id: this.id })], { type: 'application/json' }));
    } catch {
      /* the server's heartbeat timeout is the backstop */
    }
  }

  elapsed(): number {
    if (this.result) return this.result.elapsedMs;
    if (this.status !== 'running') return 0;
    return Math.min(this.limitMs, this.serverMs + (performance.now() - this.serverAt));
  }

  get canEdit(): boolean {
    return this.status === 'running' && this.human.status === 'working';
  }

  canWrite(name: string): boolean {
    return this.editable.includes(name);
  }

  edit(name: string, content: string): void {
    // No re-render: the editor owns what is on screen, this is only what gets sent.
    this.files[name] = content;
  }

  changedFiles(): string[] {
    return this.editable.filter((n) => this.files[n] !== this.original[n]);
  }

  /** Only what the person may write goes to the server; the tests are the card's. */
  private mine(): Record<string, string> {
    return Object.fromEntries(this.editable.map((name) => [name, this.files[name] ?? this.original[name] ?? '']));
  }

  async runTests(): Promise<void> {
    if (!this.canEdit || this.busy) return;
    this.busy = 'test';
    this.onChange();
    try {
      const r = await post<Omit<Verdict, 'kind'>>('test', { id: this.id, files: this.mine() });
      this.verdict = { ...r, kind: 'test' };
    } catch (error) {
      this.verdict = { kind: 'test', ok: false, passed: 0, failed: 0, failures: [], output: String((error as Error).message) };
    }
    this.busy = null;
    this.onChange();
  }

  async submit(): Promise<void> {
    if (!this.canEdit || this.busy) return;
    this.busy = 'submit';
    this.human.status = 'verifying';
    this.onChange();
    try {
      const r = await post<{ pass: boolean; passed: number; failed: number; failures: string[]; output: string }>('submit', { id: this.id, files: this.mine() });
      this.verdict = { kind: 'submit', ok: r.pass, passed: r.passed, failed: r.failed, failures: r.failures, output: r.output };
      this.human.status = r.pass ? 'pass' : 'working';
      this.onEvent({ side: 'human', pass: r.pass });
    } catch (error) {
      this.verdict = { kind: 'submit', ok: false, passed: 0, failed: 0, failures: [], output: String((error as Error).message) };
      this.human.status = 'working';
    }
    this.busy = null;
    this.onChange();
    void this.poll();
  }

  private fail(error: unknown): void {
    this.error = String((error as Error)?.message ?? error);
    this.status = 'done';
    if (this.poller) clearTimeout(this.poller);
    // The page is giving up; the agent on the other side must not carry on regardless.
    if (this.id && !this.result) void post('stop', { id: this.id }).catch(() => {});
    this.stopped = true;
    this.onChange();
  }

  private finish(result: NonNullable<ServerState['result']>): void {
    const winner = result.winner === 'human' ? 0 : result.winner === 'agent' ? 1 : null;
    const doneMs = winner === 0 ? this.human.doneMs : winner === 1 ? (this.agent?.doneMs ?? null) : null;
    const name = AGENTS.find((a) => a.id === this.options.agent)?.name ?? this.options.agent;
    this.result = {
      winner,
      stopped: result.reason === 'stopped',
      reason:
        result.reason === 'stopped'
          ? t('code.r.stopped')
          : result.reason === 'timeout'
            ? t('code.r.timeout')
            : winner === 0
              ? this.practice
                ? t('code.r.solved')
                : t('code.r.youWin', { name })
              : t('code.r.agentWins', { name }),
      elapsedMs: doneMs ?? this.elapsed(),
    };
    // A card the person passed is worth remembering, however the match itself ended.
    if (this.human.status === 'pass' && this.human.doneMs !== null) settings.setCodeBest(this.options.card, this.human.doneMs);
  }

  private schedulePoll(delay: number): void {
    if (this.poller) clearTimeout(this.poller);
    this.poller = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || !this.id) return;
    this.polling = true;
    try {
      const res = await fetch(`/api/duel/state?id=${encodeURIComponent(this.id)}&from=${this.log.length}`);
      const state: ServerState | null = await res.json().catch(() => null);
      // A run the server has forgotten is gone for good; anything else may be a blip worth retrying.
      if (res.status === 404 && state) throw Object.assign(new Error((state as { message?: string }).message || 'gone'), { fatal: true });
      if (!res.ok || !state) throw new Error((state as { message?: string } | null)?.message || `HTTP ${res.status}`);
      if (this.stopped) return;
      this.misses = 0;
      this.serverMs = state.elapsedMs;
      this.serverAt = performance.now();
      // While a submission is in flight its own reply sets the person's status.
      if (!this.busy) this.human = state.human;
      const was = this.agent?.status;
      if (state.agent) {
        const { log, logTotal: _total, ...agent } = state.agent;
        this.agent = agent;
        this.log.push(...log);
        if (was !== agent.status && (agent.status === 'pass' || agent.status === 'fail')) this.onEvent({ side: 'agent', pass: agent.status === 'pass' });
      }
      if (state.result && !this.result) {
        this.finish(state.result);
        this.status = 'done';
        // The server collects both sides' patches a moment after the result.
        this.schedulePoll(1200);
      } else if (!state.result) {
        this.schedulePoll(POLL_MS);
      }
      this.onChange();
    } catch (error) {
      if ((error as { fatal?: boolean })?.fatal || ++this.misses > POLL_RETRIES) this.fail(error);
      // Back off rather than hammer a server that is busy running someone's tests.
      else this.schedulePoll(POLL_MS * Math.min(8, 2 ** this.misses));
    } finally {
      this.polling = false;
    }
  }
}
