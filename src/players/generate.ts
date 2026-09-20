// Turns a person's description of how to play into code: asks a model for a `choose(game)` function,
// tries it on real positions, and gives the model one chance to repair what failed.

import type { AlgoInput, DecisionGameId } from '../core/types';
import { ALGO_GAMES } from './algoGames';
import type { AlgoRunner } from './sandbox';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Generated {
  name: string;
  code: string;
  inputTokens: number;
  outputTokens: number;
  /** How many rounds it took: 1, or 2 when the first attempt had to be repaired. */
  attempts: number;
}

const MAX_CODE_CHARS = 20_000;
const MAX_NAME_CHARS = 24;

/** A sample shrunk to fit in a prompt: the first few options are enough to show the shape. */
function sampleForPrompt(sample: AlgoInput): string {
  return JSON.stringify({ state: sample.state, options: sample.options.slice(0, 3) }, null, 1);
}

export function buildGenerationMessages(game: DecisionGameId, wish: string, sample: AlgoInput): ChatMessage[] {
  const g = ALGO_GAMES[game];
  const system = [
    'You write a game-playing algorithm as one JavaScript function. It is called once per move and must pick one of the legal moves it is given.',
    '',
    `THE GAME: ${g.goal}`,
    '',
    'THE CONTRACT',
    'function choose(game) { ...; return id; }',
    '- `game.options` is a non-empty array of legal moves: { id: string, facts: {...} }. Return the `id` of exactly one of them, as a string.',
    '- `game.state` describes the position. All facts were computed by the game engine and are exact.',
    `- game.state fields: ${g.state}`,
    `- option.facts fields: ${g.facts}`,
    '',
    'RULES FOR THE CODE',
    '- Plain JavaScript (ES2020), synchronous, no imports, no async. It runs in a locked-down Web Worker: there is no DOM, no network, no timers worth using. Do not use fetch, require, import, eval or Function.',
    '- It must return within a few milliseconds, never throw, and never return an id that is not in game.options. If unsure, fall back to game.options[0].id.',
    '- You may define helper functions and constants next to `choose`, and keep state in variables between calls.',
    '- Make the strategy the person asks for the heart of the algorithm, but never at the cost of an instantly losing move when the facts show a safe one.',
    '',
    'OUTPUT FORMAT',
    `Reply with exactly one \`\`\`js code block and nothing else. Its first line must be a comment naming the algorithm in at most ${MAX_NAME_CHARS} characters, in the language the person wrote in:`,
    '// name: <short name>',
  ].join('\n');
  const user = [`How I want it to play:\n${wish.trim()}`, '', 'An example of the `game` argument (options truncated to the first three):', sampleForPrompt(sample)].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** The code out of a reply: the first fenced block, or the whole reply if the model skipped the fence. */
export function extractCode(reply: string): string {
  const fenced = /```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/.exec(reply);
  const code = (fenced ? fenced[1] : reply).trim();
  // An unclosed fence (the reply was cut off) still starts with one.
  return code.replace(/^```(?:js|javascript)?\s*\n/, '').trim();
}

export function extractName(code: string, fallback: string): string {
  const match = /^\s*\/\/\s*name\s*[:：]\s*(.+)$/im.exec(code);
  const name = (match?.[1] ?? fallback).trim().replace(/\s+/g, ' ');
  return [...name].slice(0, MAX_NAME_CHARS).join('') || fallback;
}

/** Things the contract forbids, caught before the code ever runs. */
export function staticProblems(code: string): string | null {
  if (!code) return 'the reply contained no code';
  if (code.length > MAX_CODE_CHARS) return `the code is longer than ${MAX_CODE_CHARS} characters`;
  if (!/\bfunction\s+choose\s*\(|\b(?:const|let|var)\s+choose\s*=/.test(code)) return 'the code does not define a function named choose';
  const banned = /\b(fetch|XMLHttpRequest|WebSocket|importScripts|import\s*\(|require\s*\(|eval\s*\(|new\s+Function|localStorage|document\.)/.exec(code);
  if (banned) return `the code uses ${banned[1].trim()}, which is not available`;
  if (/^\s*(import|export)\s/m.test(code)) return 'the code uses import/export, which is not available';
  return null;
}

/** Runs the code on every sample. Returns what went wrong, or null when every answer was a legal option. */
export async function validate(runner: AlgoRunner, samples: AlgoInput[]): Promise<string | null> {
  for (const [i, sample] of samples.entries()) {
    let id: string;
    try {
      id = await runner.run(sample);
    } catch (error) {
      return `on test position ${i + 1} it failed: ${(error as Error).message}`;
    }
    if (!sample.options.some((o) => o.id === id)) {
      return `on test position ${i + 1} it returned ${JSON.stringify(id)}, which is not one of the option ids (${sample.options.slice(0, 6).map((o) => o.id).join(', ')}${sample.options.length > 6 ? ', …' : ''})`;
    }
  }
  return null;
}

export interface GenerateDeps {
  /** One chat completion. */
  complete(messages: ChatMessage[]): Promise<{ content: string; inputTokens: number; outputTokens: number }>;
  /** A fresh runner for some code; the caller decides how isolated it is. */
  createRunner(code: string): AlgoRunner;
  onStage?(stage: 'writing' | 'testing' | 'repairing'): void;
}

export class GenerationError extends Error {}

export async function generateAlgorithm(game: DecisionGameId, wish: string, deps: GenerateDeps): Promise<Generated> {
  const samples = ALGO_GAMES[game].samples();
  if (samples.length === 0) throw new GenerationError('no test positions for this game');
  const messages = buildGenerationMessages(game, wish, samples[Math.min(1, samples.length - 1)]);
  let inputTokens = 0;
  let outputTokens = 0;
  let problem = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    deps.onStage?.(attempt === 1 ? 'writing' : 'repairing');
    const reply = await deps.complete(messages);
    inputTokens += reply.inputTokens;
    outputTokens += reply.outputTokens;
    const code = extractCode(reply.content);

    deps.onStage?.('testing');
    problem = staticProblems(code) ?? '';
    if (!problem) {
      const runner = deps.createRunner(code);
      try {
        problem = (await validate(runner, samples)) ?? '';
      } finally {
        runner.dispose();
      }
    }
    if (!problem) return { name: extractName(code, wish.trim().slice(0, MAX_NAME_CHARS) || 'algorithm'), code, inputTokens, outputTokens, attempts: attempt };

    // One repair round: show the model its own code and exactly what went wrong.
    messages.push({ role: 'assistant', content: reply.content });
    messages.push({ role: 'user', content: `That code was tested and rejected: ${problem}. Fix it and reply again with the complete code in one \`\`\`js block, keeping the "// name:" first line.` });
  }
  throw new GenerationError(problem);
}
