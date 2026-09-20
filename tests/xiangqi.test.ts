import { describe, expect, it } from 'vitest';
import type { Decision, DecisionRequest, Player } from '../src/core/types';
import { XiangqiMatch, buildXiangqiRequest } from '../src/games/xiangqi/match';
import { analyze, botMove, describeMove, fromFen, inCheck, legalMoves, makeMove, moveId, outcome, perft, startState, toChinese } from '../src/games/xiangqi/engine';

const find = (s: ReturnType<typeof startState>, id: string) => {
  const m = legalMoves(s).find((x) => moveId(x) === id);
  if (!m) throw new Error(`illegal ${id}`);
  return m;
};
const play = (fen: string, ...ids: string[]) => ids.reduce((s, id) => makeMove(s, find(s, id)), fromFen(fen));
const START = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

describe('xiangqi move generation (perft against the published counts)', () => {
  it('opening position', () => {
    expect(perft(startState(), 1)).toBe(44);
    expect(perft(startState(), 2)).toBe(1920);
    expect(perft(startState(), 3)).toBe(79666);
  }, 120_000);
});

describe('xiangqi rules', () => {
  it('blocks a horse by its leg and an elephant by its eye, and keeps the elephant on its side', () => {
    // Red horse on b0 with a piece on b1: both forward jumps are blocked.
    const s = fromFen('3k5/9/9/9/9/9/9/9/1P7/1N2K4 w');
    expect(legalMoves(s).filter((m) => m.piece === 'N').map(moveId).sort()).toEqual(['b0d1']);
    const e = fromFen('3k5/9/9/9/9/2B6/9/9/9/4K4 w');
    // From c4 an elephant may go to a2 or e2, never across the river to a6 or e6.
    expect(legalMoves(e).filter((m) => m.piece === 'B').map(moveId).sort()).toEqual(['c4a2', 'c4e2']);
  });

  it('a cannon moves like a chariot but captures only over exactly one piece', () => {
    const s = fromFen('5k3/9/9/9/4p4/9/4P4/9/4C4/3K5 w');
    const captures = legalMoves(s).filter((m) => m.piece === 'C' && m.captured).map(moveId);
    expect(captures).toEqual(['e1e5']); // over its own soldier onto the black one
    // With no piece to fire over, the soldier on the same file cannot be taken.
    const none = fromFen('5k3/9/9/9/4p4/9/9/9/4C4/3K5 w');
    expect(legalMoves(none).some((m) => m.piece === 'C' && m.captured)).toBe(false);
  });

  it('a soldier moves sideways only after crossing the river, and never backwards', () => {
    const home = fromFen('4k4/9/9/9/9/9/4P4/9/9/4K4 w');
    expect(legalMoves(home).filter((m) => m.piece === 'P').map(moveId)).toEqual(['e3e4']);
    const across = fromFen('3k5/9/9/9/4P4/9/9/9/9/4K4 w');
    expect(legalMoves(across).filter((m) => m.piece === 'P').map(moveId).sort()).toEqual(['e5d5', 'e5e6', 'e5f5']);
  });

  it('forbids the generals from facing each other on an open file', () => {
    const s = fromFen('4k4/9/9/9/9/9/9/9/4R4/4K4 w');
    // The chariot is the only thing between the generals: it may slide along the file but not leave it.
    const rook = legalMoves(s).filter((m) => m.piece === 'R');
    expect(rook.every((m) => m.to % 9 === 4)).toBe(true);
    expect(rook.length).toBeGreaterThan(0);
  });

  it('a side with no legal move loses, even when it is not in check', () => {
    // Two chariots: one checks along the back rank, the other guards the rank in front.
    const mate = fromFen('3k1R3/R8/9/9/9/9/9/9/9/4K4 b');
    expect(inCheck(mate.board, 'b')).toBe(true);
    expect(outcome(mate)).toEqual({ kind: 'checkmate', winner: 'r' });
    // Not in check, but both squares the general could step to are covered: still a loss.
    const stuck = fromFen('3k5/R8/9/9/4R4/9/9/9/9/4K4 b');
    expect(inCheck(stuck.board, 'b')).toBe(false);
    expect(legalMoves(stuck)).toEqual([]);
    expect(outcome(stuck)).toEqual({ kind: 'stalemate', winner: 'r' });
  });

  it('writes traditional notation from each side\'s own right', () => {
    const s = startState();
    expect(toChinese(s, find(s, 'h2e2'))).toBe('炮二平五');
    expect(toChinese(s, find(s, 'b0c2'))).toBe('马八进七');
    expect(toChinese(s, find(s, 'a0a1'))).toBe('车九进一');
    const black = play(START, 'h2e2');
    expect(toChinese(black, find(black, 'h9g7'))).toBe('马8进7');
    expect(toChinese(black, find(black, 'h7e7'))).toBe('炮8平5');
    // Two red chariots on one file: front and back instead of the file number.
    const doubled = fromFen('3k5/9/9/9/9/R8/9/R8/9/4K4 w');
    expect(toChinese(doubled, find(doubled, 'a4a5'))).toBe('前车进一');
    expect(toChinese(doubled, find(doubled, 'a2a1'))).toBe('后车退一');
  });

  it('flags a move that hangs a piece, and the bot takes a free one', () => {
    // Sliding the chariot to c4 puts it right in front of a black soldier.
    const s = fromFen('3k5/9/9/9/2p6/R8/9/9/9/4K4 w');
    const hang = analyze(s).find((f) => f.id === 'a4c4')!;
    expect(hang.risk).toBe(9);
    expect(describeMove(hang).opponent_can_win_next).toBe('9 points with 卒3进1');
    expect(analyze(s).find((f) => f.id === 'a4b4')!.risk).toBe(0);
    // The general sits behind an advisor, so no check competes with simply taking the chariot.
    const free = fromFen('4k4/4a4/9/9/r8/9/9/9/R8/3K5 w');
    expect(moveId(botMove(free, 2))).toBe('a1a5');
    const fields = Object.keys(describeMove(analyze(s)[0]));
    for (const f of analyze(s)) expect(Object.keys(describeMove(f))).toEqual(fields);
  });
});

describe('xiangqi match', () => {
  const scripted = (name: string, pick: (req: DecisionRequest) => string | null): Player => ({
    config: { kind: 'bot' },
    name,
    short: name,
    emoji: '',
    color: '',
    decide: async (req): Promise<Decision> => ({ optionId: pick(req), latencyMs: 1, inputTokens: 0, outputTokens: 0, cost: 0, note: 'scripted' }),
  });

  it('offers all 44 opening moves by coordinate id, from Red\'s side', () => {
    const s = startState();
    const req = buildXiangqiRequest(s, analyze(s), []);
    expect(req.options).toHaveLength(44);
    expect(req.options.map((o) => o.id)).toContain('h2e2');
    expect(req.state.you_are).toMatch(/^Red/);
    expect((req.state.board as string[])[0]).toBe('9 r n b a k a b n r');
    expect(req.options.find((o) => o.id === 'h2e2')!.description.move).toBe('炮二平五: cannon h2 to e2');
    for (const o of req.options) expect(o.id).toMatch(/^[\w.-]{1,24}$/); // what the proxy accepts
  });

  it('the bot beats a player that always takes the first legal move', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    const naive = scripted('naive', (req) => req.options[0].id);
    const match = new XiangqiMatch([bot, naive], { maxMoves: 60, minMoveMs: 0 });
    match.start();
    await expect.poll(() => match.status, { timeout: 200_000, interval: 50 }).toBe('done');
    expect(match.result?.winner).toBe(0);
    expect(match.seats[0].captured.length).toBeGreaterThan(0);
  }, 240_000);

  it('an invalid answer falls back to the bot, and a person can only play legal moves', async () => {
    const human: Player = { ...scripted('you', () => null), config: { kind: 'human' } };
    const broken = scripted('broken', () => 'z9z9');
    const match = new XiangqiMatch([human, broken], { maxMoves: 0, minMoveMs: 0 });
    match.start();
    await expect.poll(() => match.awaitingHuman).toBe(true);
    match.play('b0b5'); // a horse does not move like that: ignored
    expect(match.history).toHaveLength(0);
    match.play('h2e2');
    await expect.poll(() => match.history.length, { timeout: 20_000 }).toBe(2);
    expect(match.history[0].notation).toBe('炮二平五');
    expect(match.seats[1].stats.invalid).toBe(1);
    match.stop();
    expect(match.result?.stopped).toBe(true);
  }, 60_000);
});

