// The player registry. A new role is one entry in ROLES plus one case in createPlayer; no game
// needs to change, because every player answers the same DecisionRequest.

import { AGENTS, findAgent } from '../../server/agents.mjs';
import type { Decision, Player, PlayerConfig, PlayerKind } from '../core/types';
import { t } from '../core/i18n';
import { createLlmPlayer } from './llm';
import { createJevPlayer } from './jev';
import { CUSTOM_COLOR, createCustomPlayer } from './custom';

/** Title and blurb come from i18n: `role.<kind>.title` and `role.<kind>.blurb`. */
export interface RoleInfo {
  /** `agent` is not in this list: it only plays the code duel, which has a setup of its own. */
  kind: Exclude<PlayerKind, 'agent'>;
  emoji: string;
  color: string;
  /** Which /api/config flag must be true for this role to work. */
  needs?: 'zenmux' | 'jev';
}

export const ROLES: RoleInfo[] = [
  { kind: 'llm', emoji: '🤖', color: '#7c5cff', needs: 'zenmux' },
  { kind: 'jev', emoji: '⚡', color: '#ff9f1c', needs: 'jev' },
  { kind: 'human', emoji: '🧑‍🚀', color: '#ff5d8f' },
  { kind: 'bot', emoji: '🧮', color: '#12b886' },
  // Needs the model key only to be written; once saved it plays without any API.
  { kind: 'custom', emoji: '✨', color: CUSTOM_COLOR },
  { kind: 'random', emoji: '🐒', color: '#8d99ae' },
];

const local = (optionId: string, note: string): Decision => ({
  optionId,
  latencyMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  note,
});

export function createPlayer(config: PlayerConfig): Player {
  switch (config.kind) {
    case 'llm':
      return createLlmPlayer(config);
    case 'jev':
      return createJevPlayer(config);
    case 'custom':
      return createCustomPlayer(config);
    case 'bot':
      return {
        config,
        name: t('role.bot.title'),
        short: t('role.bot.short'),
        emoji: '🧮',
        color: '#12b886',
        decide: async (req) => local(req.botChoice(), t('n.algorithm')),
      };
    case 'random':
      return {
        config,
        name: t('role.random.title'),
        short: t('role.random.short'),
        emoji: '🐒',
        color: '#8d99ae',
        decide: async (req) => local(req.options[Math.floor(Math.random() * req.options.length)].id, t('n.random')),
      };
    case 'agent': {
      // A code agent's CLI, run by the server against a person in the code duel (server/duel.mjs).
      const agent = findAgent(config.agent) ?? AGENTS[0];
      return {
        config,
        name: agent.name,
        short: agent.name,
        emoji: agent.emoji,
        logo: agent.logo,
        color: agent.color,
        decide: () => Promise.reject(new Error('a code agent works on a repository, it does not pick moves')),
      };
    }
    case 'human':
      return {
        config,
        name: t('role.human.title'),
        short: t('role.human.title'),
        emoji: '🧑‍🚀',
        color: '#ff5d8f',
        decide: () => Promise.reject(new Error('a human seat reads input from the game, not decide()')),
      };
  }
}
