// Role #2: Jev, TypeSafe's System One model. It does not generate text: it answers a typed
// Choice question over the offered options and returns calibrated probabilities.

import type { Decision, DecisionRequest, Player, PlayerConfig } from '../core/types';
import { PlayerError, sleep } from '../core/types';
import { t } from '../core/i18n';

export const JEV_MODEL = 'jev-latest';
// Published price: input only, output is free.
export const JEV_PRICE = { input: 0.042 / 1e6, output: 0 };

const RETRY_STATUSES = new Set([429, 529]);

export function buildJevRequest(req: DecisionRequest) {
  const criteria: Record<string, unknown> = {};
  for (const o of req.options) criteria[o.id] = o.description;
  return {
    state: { game: { rules: req.rules, ...req.state } },
    model: JEV_MODEL,
    questions: {
      move: {
        type: 'choice',
        instructions: { question: req.question, priorities: req.priorities },
        criteria,
      },
    },
  };
}

export function createJevPlayer(config: PlayerConfig): Player {
  return {
    config,
    name: 'Jev',
    short: 'Jev',
    emoji: '⚡',
    color: '#ff9f1c',
    async decide(req, signal): Promise<Decision> {
      const body = JSON.stringify(buildJevRequest(req));
      let delay = 500;
      for (let attempt = 1; ; attempt++) {
        const started = performance.now();
        const res = await fetch('/api/jev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
        const latencyMs = performance.now() - started;
        const json = await res.json().catch(() => null);
        if (res.ok && json) {
          const answer = json.answers?.move;
          const known = new Set(req.options.map((o) => o.id));
          let optionId: string | null = typeof answer?.choice === 'string' && known.has(answer.choice) ? answer.choice : null;
          if (!optionId && answer?.probabilities) {
            // The named choice was unknown: take the most probable offered option instead.
            const ranked = Object.entries(answer.probabilities as Record<string, number>)
              .filter(([id]) => known.has(id))
              .sort((a, b) => b[1] - a[1]);
            optionId = ranked[0]?.[0] ?? null;
          }
          const inputTokens = Number(json.usage?.input_tokens ?? 0);
          const confidence = typeof answer?.confidence === 'number' ? answer.confidence : null;
          return {
            optionId,
            latencyMs,
            inputTokens,
            outputTokens: Number(json.usage?.output_tokens ?? 0),
            cost: inputTokens * JEV_PRICE.input,
            note: !optionId ? t('n.invalid', { text: '' }).trim() : confidence === null ? t('n.picked', { id: optionId }) : t('n.pickedConfidence', { id: optionId, c: confidence.toFixed(2) }),
          };
        }
        if (RETRY_STATUSES.has(res.status) && attempt < 2) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        const message = json?.detail?.message || json?.message || json?.error || `HTTP ${res.status}`;
        throw new PlayerError(String(message), res.status);
      }
    },
  };
}
