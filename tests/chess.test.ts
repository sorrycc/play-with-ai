import { describe, expect, it } from 'vitest';
import type { Decision, DecisionRequest, Player } from '../src/core/types';
import { ChessMatch, buildChessRequest } from '../src/games/chess/match';
import { analyze, botMove, describeMove, fromFen, insufficientMaterial, legalMoves, makeMove, moveId, outcome, perft, startState, toSan } from '../src/games/chess/engine';

const play = (fen: string, ...ids: string[]) => {
  let s = fromFen(fen);
  for (const id of ids) {
    const m = legalMoves(s).find((x) => moveId(x) === id);
    if (!m) throw new Error(`illegal ${id}`);
    s = makeMove(s, m);
  }
  return s;
};
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('chess move generation (perft against the published counts)', () => {
  it('start position', () => {
    expect(perft(startState(), 1)).toBe(20);
    expect(perft(startState(), 2)).toBe(400);
    expect(perft(startState(), 3)).toBe(8902);
    expect(perft(startState(), 4)).toBe(197281);
  }, 60_000);

  it('Kiwipete: castling, en passant, promotions and pins', () => {
    const s = fromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
    expect(perft(s, 1)).toBe(48);
    expect(perft(s, 2)).toBe(2039);
    expect(perft(s, 3)).toBe(97862);
  }, 60_000);

  it('position 3: en passant that would expose the king, and rook endings', () => {
    const s = fromFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
    expect(perft(s, 1)).toBe(14);
    expect(perft(s, 2)).toBe(191);
    expect(perft(s, 3)).toBe(2812);
    expect(perft(s, 4)).toBe(43238);
  }, 60_000);

  it('position 5: promotions with capture and check', () => {
    const s = fromFen('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8');
    expect(perft(s, 1)).toBe(44);
    expect(perft(s, 2)).toBe(1486);
    expect(perft(s, 3)).toBe(62379);
  }, 60_000);
});

describe('chess rules and notation', () => {
  it('writes standard algebraic notation', () => {
    const s = startState();
    const san = (state: typeof s, id: string) => toSan(state, legalMoves(state).find((m) => moveId(m) === id)!);
    expect(san(s, 'g1f3')).toBe('Nf3');
    expect(san(s, 'e2e4')).toBe('e4');
    const taken = play(START, 'e2e4', 'd7d5');
    expect(san(taken, 'e4d5')).toBe('exd5');
    const castle = fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(san(castle, 'e1g1')).toBe('O-O');
    expect(san(castle, 'e1c1')).toBe('O-O-O');
    // Two knights can reach d2: the file tells them apart.
    const twoKnights = fromFen('4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1');
    expect(san(twoKnights, 'b1d2')).toBe('Nbd2');
    expect(san(twoKnights, 'f3d2')).toBe('Nfd2');
    const promote = fromFen('8/4P1k1/8/8/8/8/8/4K3 w - - 0 1');
    expect(san(promote, 'e7e8q')).toBe('e8=Q');
  });

  it("finds fool's mate, and says so in notation and in the facts", () => {
    const s = play(START, 'f2f3', 'e7e5', 'g2g4');
    const mate = analyze(s).find((f) => f.id === 'd8h4')!;
    expect(mate.san).toBe('Qh4#');
    expect(mate.mate).toBe(true);
    expect(describeMove(mate).check).toBe('CHECKMATE: wins the game');
    expect(moveId(botMove(s, 2))).toBe('d8h4');
    expect(outcome(makeMove(s, mate.move))).toEqual({ kind: 'checkmate', winner: 'b' });
  });

  it('recognises stalemate, bare kings and the fifty-move rule', () => {
    expect(outcome(fromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'))).toEqual({ kind: 'stalemate' });
    expect(insufficientMaterial(fromFen('8/8/4k3/8/8/3NK3/8/8 w - - 0 1').board)).toBe(true);
    expect(insufficientMaterial(fromFen('8/8/4k3/8/8/3RK3/8/8 w - - 0 1').board)).toBe(false);
    expect(outcome(fromFen('8/8/4k3/8/8/3RK3/8/8 w - - 100 80'))).toEqual({ kind: 'fifty' });
  });

  it('takes en passant only on the very next move, and removes the right pawn', () => {
    const s = play(START, 'e2e4', 'a7a6', 'e4e5', 'd7d5');
    const ep = legalMoves(s).find((m) => moveId(m) === 'e5d6')!;
    expect(ep.flag).toBe('ep');
    const after = makeMove(s, ep);
    expect(after.board[27]).toBeNull(); // d5, where the black pawn stood
    const later = play(START, 'e2e4', 'a7a6', 'e4e5', 'd7d5', 'h2h3', 'h7h6');
    expect(legalMoves(later).some((m) => moveId(m) === 'e5d6')).toBe(false);
  });

  it('flags a move that hangs a piece, and a free capture', () => {
    // White queen can go to d5, where a pawn takes it.
    const s = fromFen('4k3/8/2p5/8/8/8/8/3QK3 w - - 0 1');
    const blunder = analyze(s).find((f) => f.id === 'd1d5')!;
    expect(blunder.risk).toBe(9);
    expect(describeMove(blunder).opponent_can_win_next).toBe('9 points with cxd5');
    const safe = analyze(s).find((f) => f.id === 'd1d2')!;
    expect(safe.risk).toBe(0);
    // The bot takes a free rook.
    const free = fromFen('4k3/8/8/3r4/8/8/8/3QK3 w - - 0 1');
    expect(moveId(botMove(free, 2))).toBe('d1d5');
    const fields = Object.keys(describeMove(blunder));
    for (const f of analyze(s)) expect(Object.keys(describeMove(f))).toEqual(fields);
  });
});


describe('chess match', () => {
  const scripted = (name: string, pick: (req: DecisionRequest) => string | null): Player => ({
    config: { kind: 'bot' },
    name,
    short: name,
    emoji: '',
    color: '',
    decide: async (req): Promise<Decision> => ({ optionId: pick(req), latencyMs: 1, inputTokens: 0, outputTokens: 0, cost: 0, note: 'scripted' }),
  });

  it('offers every legal move, by coordinate id, with the side named', () => {
    const s = startState();
    const req = buildChessRequest(s, analyze(s), []);
    expect(req.options).toHaveLength(20);
    expect(req.options.map((o) => o.id)).toContain('e2e4');
    expect(req.state.you_are).toMatch(/^White/);
    expect((req.state.board as string[])[0]).toBe('8 r n b q k b n r');
    for (const o of req.options) expect(o.id).toMatch(/^[\w.-]{1,24}$/); // what the proxy accepts
  });

  it('the bot beats a player that always takes the first legal move, by mate or on material', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    const naive = scripted('naive', (req) => req.options[0].id);
    const match = new ChessMatch([bot, naive], { maxMoves: 60, minMoveMs: 0 });
    match.start();
    await expect.poll(() => match.status, { timeout: 120_000, interval: 50 }).toBe('done');
    expect(match.result?.winner).toBe(0);
    expect(match.history.length).toBeGreaterThan(4);
    expect(match.seats[0].captured.length).toBeGreaterThan(0);
  }, 150_000);

  it('an invalid answer falls back to the bot, and a person can only play legal moves', async () => {
    const broken = scripted('broken', () => 'z9z9');
    const human: Player = { ...scripted('you', () => null), config: { kind: 'human' } };
    const match = new ChessMatch([human, broken], { maxMoves: 0, minMoveMs: 0 });
    match.start();
    await expect.poll(() => match.awaitingHuman).toBe(true);
    match.play('e2e5'); // not legal: ignored
    expect(match.history).toHaveLength(0);
    match.play('e2e4');
    await expect.poll(() => match.history.length, { timeout: 10_000 }).toBe(2);
    expect(match.history[0].san).toBe('e4');
    expect(match.seats[1].stats.invalid).toBe(1);
    match.stop();
    expect(match.result?.stopped).toBe(true);
  }, 30_000);
});
