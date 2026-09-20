import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '../src/core/types';
import { buildJevRequest } from '../src/players/jev';
import { buildMessages, parseChoice } from '../src/players/llm';

const request: DecisionRequest = {
  game: 'tetris',
  rules: 'RULES.',
  question: 'Which one?',
  priorities: ['first thing', 'second thing'],
  state: { current_piece: 'T' },
  options: [
    { id: 'p1', description: { lines_cleared: 'none' } },
    { id: 'p12', description: { lines_cleared: 'one line' } },
  ],
  data: { state: {}, options: [] },
  botChoice: () => 'p12',
  realtime: true,
};

describe('llm player', () => {
  it('reads a clean JSON answer', () => {
    expect(parseChoice('{"option_id": "p12"}', ['p1', 'p12'])).toBe('p12');
  });

  it('reads JSON wrapped in prose or a code fence', () => {
    expect(parseChoice('Sure!\n```json\n{"option_id":"p1"}\n```', ['p1', 'p12'])).toBe('p1');
  });

  it('falls back to plain text only when it names exactly one option', () => {
    expect(parseChoice('I would go with p12 here.', ['p1', 'p12'])).toBe('p12');
    expect(parseChoice('H8 looks best', ['H8', 'J9'])).toBe('H8');
    // Prose that weighs several options is ambiguous: better a fallback than a guess.
    expect(parseChoice('Going down is a dead end, so I go up.', ['up', 'down', 'left'])).toBeNull();
  });

  it('finds the JSON when a model adds prose with braces of its own', () => {
    expect(parseChoice('```json\n{"option_id": "up"}\n```\nThe set {left, down} is worse.', ['up', 'down', 'left'])).toBe('up');
  });

  it('never invents an id that was not offered', () => {
    expect(parseChoice('{"option_id": "p99"}', ['p1', 'p12'])).toBeNull();
    expect(parseChoice('no idea', ['p1', 'p12'])).toBeNull();
    expect(parseChoice('', ['p1'])).toBeNull();
  });

  it('puts rules and priorities in the system message and the options in the user message', () => {
    const [system, user] = buildMessages(request);
    expect(system.content).toContain('RULES.');
    expect(system.content).toContain('(1) first thing');
    expect(system.content).toContain('clock is running');
    expect(JSON.parse(user.content).options).toEqual({ p1: { lines_cleared: 'none' }, p12: { lines_cleared: 'one line' } });
  });
});

describe('jev player', () => {
  it('asks one Choice question with a criteria entry per option', () => {
    const body = buildJevRequest(request);
    expect(body.questions.move.type).toBe('choice');
    expect(Object.keys(body.questions.move.criteria)).toEqual(['p1', 'p12']);
    expect(body.state.game).toMatchObject({ rules: 'RULES.', current_piece: 'T' });
  });
});
