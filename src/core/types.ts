// The contract every game and every player meets.
//
// Code owns the game: a game enumerates its legal moves, describes each one in words, and hands
// a player a DecisionRequest. A player only picks one option id. That keeps every role — a model
// behind ZenMux, Jev, a classic algorithm, a person — interchangeable in any seat of any game,
// and makes an illegal move impossible rather than something to detect.

/** Games played one decision at a time: every role below except `agent` can take a seat. */
export type DecisionGameId = 'tetris' | 'gomoku' | 'snake' | '2048' | 'chess' | 'xiangqi';
/** `code` is the odd one out: no moves to pick, a person and a code agent race to make a hidden test pass. */
export type GameId = DecisionGameId | 'code';
/** `agent` is a code agent's CLI run by the server (see server/agents.mjs); it only plays `code`. */
export type PlayerKind = 'llm' | 'jev' | 'human' | 'bot' | 'custom' | 'random' | 'agent';

export interface MoveOption {
  id: string;
  /** Same field names on every option so a model compares like with like. */
  description: Record<string, string>;
}

/**
 * The same decision as plain data, for code rather than for a language model: the position, and
 * numbers and flags about every legal move. A generated algorithm (`custom` role) gets exactly this.
 * It must survive `postMessage`, so: JSON values only.
 */
export interface AlgoInput {
  state: Record<string, unknown>;
  options: { id: string; facts: Record<string, unknown> }[];
}

export interface DecisionRequest {
  game: DecisionGameId;
  /** The rules, in a sentence or two. */
  rules: string;
  question: string;
  /** Ordered, most important first. */
  priorities: string[];
  state: Record<string, unknown>;
  options: MoveOption[];
  data: AlgoInput;
  /** What the classic algorithm would play; the `bot` role and every fallback use it. */
  botChoice: () => string;
  /** True when a clock is running while the player thinks. */
  realtime: boolean;
}

export interface Decision {
  /** null when the reply named no offered option. */
  optionId: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** USD */
  cost: number;
  note: string;
}

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface PlayerConfig {
  kind: PlayerKind;
  /** ZenMux model id, for kind 'llm'. */
  model?: string;
  /** Let a reasoning model think before answering: smarter and much slower. */
  thinking?: boolean;
  /** How hard it thinks, when thinking is on. Unset means medium. */
  effort?: Effort;
  /** A saved generated algorithm, for kind 'custom'. */
  algoId?: string;
  /** Which code agent, for kind 'agent': an id from server/agents.mjs. */
  agent?: string;
  /** The model that agent runs on, one of its `models`. */
  agentModel?: string;
}

export interface Player {
  config: PlayerConfig;
  name: string;
  short: string;
  emoji: string;
  /** URL of a one-colour SVG mark shown instead of the emoji: a product playing under its own name. */
  logo?: string;
  /** CSS colour used for this player's avatar and accents. */
  color: string;
  /** Never called for kind 'human': the game reads the person's input itself. */
  decide(request: DecisionRequest, signal: AbortSignal): Promise<Decision>;
}

export interface PlayerStats {
  calls: number;
  latency: number;
  minLatency: number;
  maxLatency: number;
  missed: number;
  invalid: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export function freshStats(): PlayerStats {
  return {
    calls: 0,
    latency: 0,
    minLatency: Infinity,
    maxLatency: 0,
    missed: 0,
    invalid: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  };
}

export function recordDecision(stats: PlayerStats, d: Decision): void {
  stats.calls += 1;
  stats.latency += d.latencyMs;
  stats.minLatency = Math.min(stats.minLatency, d.latencyMs);
  stats.maxLatency = Math.max(stats.maxLatency, d.latencyMs);
  stats.inputTokens += d.inputTokens;
  stats.outputTokens += d.outputTokens;
  stats.cost += d.cost;
}

export class PlayerError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'PlayerError';
    this.status = status;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Small seeded PRNG (mulberry32) so two players can share one piece sequence.
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function fmtUsd(v: number, digits = 4): string {
  return v === 0 ? '$0' : `$${v.toFixed(digits)}`;
}

export function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
