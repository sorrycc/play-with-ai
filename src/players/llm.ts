// Role #1: any chat model behind ZenMux. The model gets the state and the described options as
// JSON and must answer {"option_id": "..."}; the id is checked against the offered options.

import type { Decision, DecisionRequest, Player, PlayerConfig } from '../core/types';
import { PlayerError } from '../core/types';
import { t } from '../core/i18n';

export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';

/** The models offered in the picker. Any other model id can still be typed in. */
export const FEATURED_MODELS = [
  'deepseek/deepseek-v4.1-flash',
  'qwen/qwen3.8-flash',
  'anthropic/claude-haiku-4.5',
] as const;

// One colour per provider, so two models facing each other are told apart at a glance.
const PROVIDER_COLORS: Record<string, string> = {
  deepseek: '#7c5cff',
  qwen: '#c77dff',
  anthropic: '#e8825a',
  openai: '#19c37d',
  google: '#4c8bf5',
};

export const modelColor = (model: string): string => PROVIDER_COLORS[model.split('/')[0]] ?? '#7c5cff';

export interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  /** USD per million tokens */
  inputPrice: number;
  outputPrice: number;
}

let modelsPromise: Promise<ModelInfo[]> | null = null;

/** The ZenMux catalogue, fetched once. An empty list (proxy down, no network) is not an error. */
export function loadModels(): Promise<ModelInfo[]> {
  modelsPromise ??= fetch('/api/models')
    .then((r) => (r.ok ? r.json() : { models: [] }))
    .then((j) => (Array.isArray(j.models) ? (j.models as ModelInfo[]) : []))
    .catch(() => []);
  return modelsPromise;
}

export function buildMessages(req: DecisionRequest) {
  const system = [
    req.rules,
    'Each turn you get the game state and a list of options. Every option is a legal move described by its outcome.',
    `Priorities, most important first: ${req.priorities.map((p, i) => `(${i + 1}) ${p}`).join(' ')}`,
    req.realtime ? 'A clock is running while you think, so decide immediately.' : '',
    'Answer by choosing exactly one option id. If you reply in text, reply with JSON only: {"option_id": "<one id from options>"}.',
  ]
    .filter(Boolean)
    .join(' ');
  const options: Record<string, unknown> = {};
  for (const o of req.options) options[o.id] = o.description;
  const user = JSON.stringify({ question: req.question, state: req.state, options });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Reads the chosen id out of a reply. Tolerates prose around the JSON, never invents an id. */
export function parseChoice(content: string, ids: string[]): string | null {
  const known = new Set(ids);
  // Every flat {...} in the reply, so JSON inside a code fence or after a sentence is still found.
  for (const candidate of content.match(/\{[^{}]*\}/g) ?? []) {
    try {
      const parsed = JSON.parse(candidate);
      const id = parsed?.option_id ?? parsed?.id ?? parsed?.option ?? parsed?.move;
      if (typeof id === 'string' && known.has(id.trim())) return id.trim();
    } catch {
      /* not JSON: try the next one */
    }
  }
  // Plain text counts only when it names exactly one option. Prose that weighs several ("not down,
  // so up") names more than one, and guessing which it meant would be worse than a fallback.
  const named = ids.filter((id) => new RegExp(`(^|[^\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(content));
  return named.length === 1 ? named[0] : null;
}

function shortName(model: string): string {
  const tail = model.split('/').pop() ?? model;
  return tail.length > 22 ? `${tail.slice(0, 21)}…` : tail;
}

export function createLlmPlayer(config: PlayerConfig): Player {
  const model = config.model?.trim() || DEFAULT_MODEL;
  const thinking = config.thinking === true;
  return {
    config: { ...config, model },
    name: `${shortName(model)}${thinking ? t('llm.thinkingSuffix') : ''}`,
    short: shortName(model),
    emoji: '🤖',
    color: modelColor(model),
    async decide(req, signal): Promise<Decision> {
      const started = performance.now();
      const res = await fetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, thinking, messages: buildMessages(req), optionIds: req.options.map((o) => o.id) }),
        signal,
      });
      const latencyMs = performance.now() - started;
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) throw new PlayerError(json?.message || `HTTP ${res.status}`, res.status);

      const optionId = parseChoice(json.content ?? '', req.options.map((o) => o.id));
      const info = (await loadModels()).find((m) => m.id === model);
      const cost = info ? (json.inputTokens * info.inputPrice + json.outputTokens * info.outputPrice) / 1e6 : 0;
      return {
        optionId,
        latencyMs,
        inputTokens: json.inputTokens ?? 0,
        outputTokens: json.outputTokens ?? 0,
        cost,
        note: optionId ? t('n.picked', { id: optionId }) : t('n.invalid', { text: String(json.content).slice(0, 60) }),
      };
    },
  };
}
