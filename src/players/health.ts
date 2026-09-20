// Settings asks each service whether it works. A model and Jev are asked through the players the
// games use, so a green light means the same request a match sends came back with a legal answer;
// a separate "ping" route could pass while a match still failed.

import type { DecisionRequest } from '../core/types';
import { createJevPlayer } from './jev';
import { createLlmPlayer } from './llm';

export interface CheckResult {
  ok: boolean;
  ms: number;
  /** What came back, or why nothing did. Shown as is. */
  detail: string;
  /** USD, when the check was a paid request. */
  cost?: number;
}

/** One question with one right answer, small enough to cost next to nothing. */
export const CHECK_REQUEST: DecisionRequest = {
  game: 'gomoku',
  rules: 'This is a connection check, not a game.',
  question: 'Which option confirms that you received this message?',
  priorities: ['Choose the option that confirms the connection works.'],
  state: { check: true },
  options: [
    { id: 'ok', description: { meaning: 'Confirms the message was received and the connection works.' } },
    { id: 'fail', description: { meaning: 'Says the message was not received.' } },
  ],
  data: { state: {}, options: [] },
  botChoice: () => 'ok',
  realtime: false,
};

async function ask(player: { decide: (req: DecisionRequest, signal: AbortSignal) => Promise<{ optionId: string | null; latencyMs: number; cost: number; note: string }> }): Promise<CheckResult> {
  const started = performance.now();
  try {
    const d = await player.decide(CHECK_REQUEST, new AbortController().signal);
    // Either id is a working service: the check is of the pipe, not of the model's judgement.
    return { ok: d.optionId !== null, ms: d.latencyMs, detail: d.note, cost: d.cost };
  } catch (error) {
    return { ok: false, ms: performance.now() - started, detail: error instanceof Error ? error.message : String(error) };
  }
}

export const checkModel = (model: string): Promise<CheckResult> => ask(createLlmPlayer({ kind: 'llm', model }));

export const checkJev = (): Promise<CheckResult> => ask(createJevPlayer({ kind: 'jev' }));

/** `deep` is one real headless run of the agent's CLI; without it, only its version is asked for. */
export async function checkAgent(agent: string, deep: boolean, model?: string): Promise<CheckResult> {
  const started = performance.now();
  try {
    const res = await fetch('/api/duel/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, deep, model }) });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) return { ok: false, ms: performance.now() - started, detail: json?.message || `HTTP ${res.status}` };
    return { ok: json.ok === true, ms: Number(json.ms ?? 0), detail: String(json.detail ?? '') };
  } catch (error) {
    return { ok: false, ms: performance.now() - started, detail: error instanceof Error ? error.message : String(error) };
  }
}
