// The page's half of the code duel. The match itself lives on the server (server/duel.mjs): this
// class prepares a run, starts it when the countdown ends, keeps the person's files, and polls for
// the clock, the agent's log and the result.

import { AGENTS, type AgentLogEntry, type AgentUsage } from '../../../server/agents.mjs';
import { t } from '../../core/i18n';

export interface CodeOptions {
  card: string;
  limitSec: number;
  /** An id from server/agents.mjs, and one of that agent's models. */
  agent: string;
  agentModel: string;
}

export const CODE_LIMITS_SEC = [120, 180, 300, 600];

export const CODE_DEFAULTS: CodeOptions = { card: '01-range', limitSec: 120, agent: AGENTS[0].id, agentModel: AGENTS[0].models[0] };

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
  /** The open-source repository the card is cut from; absent on a card written for the duel. */
  repo?: string;
}

export async function loadCards(): Promise<Card[]> {
  const res = await fetch('/api/duel/cards');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).cards;
}

export type SideStatus = 'idle' | 'working' | 'verifying' | 'pass' | 'fail' | 'killed' | 'error';

export interface LogEntry extends AgentLogEntry {
  /** Milliseconds into the duel. */
  at: number;
}

interface ServerState {
  elapsedMs: number;
  limitMs: number;
  human: { status: SideStatus; doneMs: number | null; attempts: number };
  agent: { status: SideStatus; doneMs: number | null; exitCode: number | null; usage: AgentUsage | null; changed: string[]; output: string; log: LogEntry[]; logTotal: number };
  result: { winner: 'human' | 'agent' | null; reason: 'pass' | 'timeout' | 'stopped' } | null;
}

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
  output: string;
}

/** A verdict came in for one side. */
export interface CodeEvent {
  side: 'human' | 'agent';
  pass: boolean;
}

const POLL_MS = 600;

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
  human: ServerState['human'] = { status: 'idle', doneMs: null, attempts: 0 };
  agent: Omit<ServerState['agent'], 'log' | 'logTotal'> = { status: 'idle', doneMs: null, exitCode: null, usage: null, changed: [], output: '' };
  log: LogEntry[] = [];
  verdict: Verdict | null = null;
  busy: 'test' | 'submit' | null = null;
  result: CodeResult | null = null;
  readonly limitMs: number;

  private id = '';
  private readonly prepared: Promise<void>;
  private stopped = false;
  private poller: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** The server's clock at the last poll, and this page's clock then. */
  private serverMs = 0;
  private serverAt = 0;

  constructor(
    private readonly options: CodeOptions,
    private readonly onChange: () => void,
    private readonly onEvent: (event: CodeEvent) => void = () => {},
  ) {
    this.limitMs = options.limitSec * 1000;
    // Copying the repo takes a moment; it happens under the countdown.
    this.prepared = post<{ id: string; files: Record<string, string> }>('start', { card: options.card, agent: options.agent, model: options.agentModel, limitSec: options.limitSec }).then(
      ({ id, files }) => {
        this.id = id;
        this.files = { ...files };
        this.original = files;
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
    this.agent.status = 'working';
    this.serverAt = performance.now();
    this.poller = setInterval(() => void this.poll(), POLL_MS);
    this.onChange();
  }

  /** Leaving the page or pressing Stop: the agent must not keep working for nobody. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    if (this.id && !this.result) void post('stop', { id: this.id }).catch(() => {});
    if (!this.result && this.status !== 'preparing') this.finish({ winner: null, reason: 'stopped' });
    this.status = 'done';
    this.onChange();
  }

  elapsed(): number {
    if (this.result) return this.result.elapsedMs;
    if (this.status !== 'running') return 0;
    return Math.min(this.limitMs, this.serverMs + (performance.now() - this.serverAt));
  }

  get canEdit(): boolean {
    return this.status === 'running' && this.human.status === 'working';
  }

  edit(name: string, content: string): void {
    // No re-render: the editor owns what is on screen, this is only what gets sent.
    this.files[name] = content;
  }

  changedFiles(): string[] {
    return Object.keys(this.files).filter((n) => this.files[n] !== this.original[n]);
  }

  async runTests(): Promise<void> {
    if (!this.canEdit || this.busy) return;
    this.busy = 'test';
    this.onChange();
    try {
      const r = await post<{ ok: boolean; output: string }>('test', { id: this.id, files: this.files });
      this.verdict = { kind: 'test', ok: r.ok, output: r.output };
    } catch (error) {
      this.verdict = { kind: 'test', ok: false, output: String((error as Error).message) };
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
      const r = await post<{ pass: boolean; output: string }>('submit', { id: this.id, files: this.files });
      this.verdict = { kind: 'submit', ok: r.pass, output: r.output };
      this.human.status = r.pass ? 'pass' : 'working';
      this.onEvent({ side: 'human', pass: r.pass });
    } catch (error) {
      this.verdict = { kind: 'submit', ok: false, output: String((error as Error).message) };
      this.human.status = 'working';
    }
    this.busy = null;
    this.onChange();
    void this.poll();
  }

  private fail(error: unknown): void {
    this.error = String((error as Error)?.message ?? error);
    this.status = 'done';
    if (this.poller) clearInterval(this.poller);
    this.onChange();
  }

  private finish(result: NonNullable<ServerState['result']>): void {
    const winner = result.winner === 'human' ? 0 : result.winner === 'agent' ? 1 : null;
    const doneMs = winner === 0 ? this.human.doneMs : winner === 1 ? this.agent.doneMs : null;
    const name = AGENTS.find((a) => a.id === this.options.agent)?.name ?? this.options.agent;
    this.result = {
      winner,
      stopped: result.reason === 'stopped',
      reason: result.reason === 'stopped' ? t('code.r.stopped') : result.reason === 'timeout' ? t('code.r.timeout') : winner === 0 ? t('code.r.youWin', { name }) : t('code.r.agentWins', { name }),
      elapsedMs: doneMs ?? this.elapsed(),
    };
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || !this.id) return;
    this.polling = true;
    try {
      const res = await fetch(`/api/duel/state?id=${encodeURIComponent(this.id)}&from=${this.log.length}`);
      const state: ServerState | null = await res.json().catch(() => null);
      if (!res.ok || !state) throw new Error((state as { message?: string } | null)?.message || `HTTP ${res.status}`);
      if (this.stopped) return;
      this.serverMs = state.elapsedMs;
      this.serverAt = performance.now();
      // While a submission is in flight its own reply sets the person's status.
      if (!this.busy) this.human = state.human;
      const { log, logTotal: _total, ...agent } = state.agent;
      const was = this.agent.status;
      this.agent = agent;
      this.log.push(...log);
      if (was !== agent.status && (agent.status === 'pass' || agent.status === 'fail')) this.onEvent({ side: 'agent', pass: agent.status === 'pass' });
      if (state.result && !this.result) {
        this.finish(state.result);
        this.status = 'done';
        if (this.poller) clearInterval(this.poller);
        // An agent cut off by the clock: the server lists what it had changed a moment after the result.
        if (agent.status === 'killed') setTimeout(() => void this.poll(), 1500);
      }
      this.onChange();
    } catch (error) {
      this.fail(error);
    } finally {
      this.polling = false;
    }
  }
}
