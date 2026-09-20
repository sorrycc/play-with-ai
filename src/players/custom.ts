// The "custom algorithm" role: code a model wrote once from the person's description, now playing
// locally. No API call per move, so no latency and no cost while the match runs.

import { t } from '../core/i18n';
import type { Decision, Player, PlayerConfig } from '../core/types';
import { PlayerError } from '../core/types';
import { algos } from './algos';
import type { ChatMessage } from './generate';
import { createWorkerRunner, type AlgoRunner } from './sandbox';

export const CUSTOM_COLOR = '#00b4d8';

export function createCustomPlayer(config: PlayerConfig): Player {
  const algo = algos.get(config.algoId);
  let runner: AlgoRunner | null = null;
  return {
    config,
    name: algo?.name ?? t('role.custom.title'),
    short: algo?.name ?? t('role.custom.title'),
    emoji: '✨',
    color: CUSTOM_COLOR,
    async decide(req): Promise<Decision> {
      // 404 is one of the statuses a match reports once, loudly, instead of on every move.
      if (!algo) throw new PlayerError(t('algo.missing'), 404);
      runner ??= createWorkerRunner(algo.code);
      // A throw, a timeout or an id that is not on offer all end the same way: the match falls back
      // to the classic bot for this move and counts it, exactly as for a model that answers badly.
      const optionId = await runner.run(req.data);
      // Local play: reported as instant, so games pace it like the classic bot.
      return { optionId, latencyMs: 0, inputTokens: 0, outputTokens: 0, cost: 0, note: t('n.custom', { id: optionId }) };
    },
  };
}

/** One chat completion through the proxy, for writing code rather than picking a move. */
export async function completeForGeneration(model: string, messages: ChatMessage[], signal?: AbortSignal) {
  const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages }), signal });
  const json = await res.json().catch(() => null);
  // A 404 here means the page is newer than the server process answering it.
  if (res.status === 404) throw new PlayerError(t('nav.staleServer'), 404);
  if (!res.ok || !json) throw new PlayerError(json?.message || `HTTP ${res.status}`, res.status);
  return { content: String(json.content ?? ''), inputTokens: Number(json.inputTokens ?? 0), outputTokens: Number(json.outputTokens ?? 0) };
}
