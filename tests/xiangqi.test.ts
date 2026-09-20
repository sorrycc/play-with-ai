import { describe, expect, it } from 'vitest';
import type { Decision, DecisionRequest, Player } from '../src/core/types';
import { XiangqiMatch, buildXiangqiRequest } from '../src/games/xiangqi/match';
import { analyze, botMove, describeMove, fromFen, inCheck, legalMoves, makeMove, materialBalance, moveId, openingBook, outcome, perft, positionKey, startState, toChinese, toFen } from '../src/games/xiangqi/engine';

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

  it('numbers soldiers when 前/后 cannot tell them apart', () => {
    const notation = (s: ReturnType<typeof startState>, piece: string) =>
      legalMoves(s).filter((m) => m.piece === piece).map((m) => toChinese(s, m));
    // Three on a file are 前/中/后; four or five are numbered from the front instead.
    const four = fromFen('3k5/9/9/4P4/4P4/4P4/4P4/9/9/4K4 w');
    expect(notation(four, 'P')).toEqual(['一兵进一', '一兵平六', '一兵平四', '二兵平六', '二兵平四']);
    // Two files with two soldiers each: 前兵 would name two different moves, so all four are numbered,
    // from Red's own right (column 8) and front to back.
    const twoFiles = fromFen('3k5/9/9/9/2P1P4/2P1P4/9/9/9/4K4 w');
    expect(notation(twoFiles, 'P')).toEqual(['三兵进一', '三兵平八', '三兵平六', '一兵进一', '一兵平六', '一兵平四']);
    const black = fromFen('4K4/9/9/9/2p1p4/2p1p4/9/9/9/3k5 b');
    expect(notation(black, 'p')).toEqual(['1卒进1', '1卒平2', '1卒平4', '3卒进1', '3卒平4', '3卒平6']);
  });

  it('never gives two legal moves the same notation', () => {
    const positions = [
      startState(),
      fromFen('3k5/9/4P4/4P4/4P4/4P4/4P4/9/9/4K4 w'), // five soldiers stacked on one file
      fromFen('3k5/9/9/9/2P1P4/2P1P4/9/9/9/4K4 w'), // soldiers doubled on two files
      fromFen('4K4/9/9/9/2p1p4/2p1p4/9/9/9/3k5 b'),
      fromFen('2baka3/9/2n1b1n2/p1p1C1p1p/9/2P6/P3P1P1P/1C2B1N2/4A4/1RBAK2R1 w'),
    ];
    // Random play from each, so ordinary middlegames are covered as well as the awkward positions.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const start of positions) {
      let s = start;
      for (let ply = 0; ply < 80; ply++) {
        const legal = legalMoves(s);
        if (legal.length === 0) break;
        const written = legal.map((m) => toChinese(s, m));
        expect(new Set(written).size, `${written.join(' ')} in ${toFen(s)}`).toBe(legal.length);
        s = makeMove(s, legal[Math.floor(random() * legal.length)]);
      }
    }
  }, 60_000);

  it('writes the position back out as a FEN', () => {
    expect(toFen(startState())).toBe(START);
    const after = play(START, 'h2e2', 'h9g7');
    expect(toFen(after)).toBe('rnbakab1r/9/1c4nc1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR w');
    expect(toFen(fromFen(toFen(after)))).toBe(toFen(after));
  });

  it('counts material by pieces alone, so only a capture moves it', () => {
    // Both sides hold a general and four soldiers; Red's have crossed the river, which is position,
    // not material, and must not hand Red a win when the move limit adjudicates.
    const same = fromFen('4k4/9/9/p1p1p1p2/P1P1P1P2/9/9/9/9/4K4 w');
    expect(materialBalance(same.board)).toBe(0);
    expect(materialBalance(fromFen('3k5/9/9/9/9/9/9/9/9/3KR4 w').board)).toBe(9);
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
    expect(moveId(botMove(free, { budgetMs: 100 }))).toBe('a1a5');
    const fields = Object.keys(describeMove(analyze(s)[0]));
    for (const f of analyze(s)) expect(Object.keys(describeMove(f))).toEqual(fields);
  });

  it('only counts a recapture that is legal, so a pinned defender does not make a piece safe', () => {
    // Black's chariot on d3 pins the one on d1 to the file in front of the general, so taking the
    // horse on e1 back with it would expose Kd0: the horse is free, and the facts have to say so.
    const s = fromFen('4rk3/9/9/9/9/9/3r5/9/3RN3P/3K5 w');
    const wait = analyze(s).find((f) => f.id === 'i1i2')!;
    expect(wait.risk).toBe(4);
    expect(describeMove(wait).opponent_can_win_next).toBe('4 points with 车5进8');
    // Defended by a piece that really can take back: the exchange is even, so nothing is won.
    const held = fromFen('4rk3/9/9/9/9/9/9/9/3RN3P/3K5 w');
    expect(analyze(held).find((f) => f.id === 'i1i2')!.risk).toBe(0);
  });

  it('says what a move saves and what it threatens', () => {
    // The chariot on c4 stands right in front of a soldier that can take it.
    const s = fromFen('3k5/9/9/9/2p6/2R6/9/9/9/4K4 w');
    const away = analyze(s).find((f) => f.id === 'c4i4')!;
    expect(away.escapes).toBe(9);
    expect(away.risk).toBe(0);
    expect(describeMove(away).saves).toBe('9 points: this piece was under attack where it stood');
    // Backing off down the file saves the chariot and keeps the soldier under attack.
    const back = analyze(s).find((f) => f.id === 'c4c1')!;
    expect(back.threatens).toBe(1);
    expect(describeMove(back).threatens_next).toBe('1 points with this piece on the move after');
    // A move that leaves the chariot where it is has nothing to save.
    const other = analyze(s).find((f) => f.move.piece === 'K')!;
    expect(other.escapes).toBe(0);
    expect(other.risk).toBe(9);
  });

  it('counts how often a position has been seen, and how long since a capture', () => {
    const s = startState();
    const seen = new Map([[positionKey(makeMove(s, find(s, 'b0c2'))), 2]]);
    const facts = analyze(s, legalMoves(s), seen);
    expect(facts.find((f) => f.id === 'b0c2')!.repeats).toBe(2);
    expect(describeMove(facts.find((f) => f.id === 'b0c2')!).repetition).toBe('DRAW: this position for the third time');
    expect(facts.find((f) => f.id === 'h2e2')!.repeats).toBe(0);
    expect(facts.find((f) => f.id === 'h2e2')!.quiet).toBe(1);
  });

  it('opens from a book of real openings, and searches under its time budget', () => {
    const start = openingBook().get(positionKey(startState()))!;
    expect(start).toContain('h2e2'); // 炮二平五
    expect(start.length).toBeGreaterThan(1); // two bots do not open the same way every game
    const opened = new Set(Array.from({ length: 12 }, (_, i) => moveId(botMove(startState(), { random: () => i / 12 }))));
    expect(opened.size).toBeGreaterThan(1);
    for (const id of opened) expect(start).toContain(id);

    // Off the book the search deepens until the budget runs out, and not far past it.
    const middle = fromFen('r1bakabr1/9/1cn3nc1/p1p1p1p1p/9/9/P1P1P1P1P/1CN3NC1/9/R1BAKABR1 w');
    const started = performance.now();
    const move = botMove(middle, { budgetMs: 200 });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(legalMoves(middle).map(moveId)).toContain(moveId(move));
  }, 20_000);

  it('sees a mate in one, and knows what a repetition is worth', () => {
    const mate = fromFen('3aka3/4R4/9/9/9/9/9/9/9/4K4 w');
    expect(analyze(mate).filter((f) => f.wins).map((f) => f.id)).toEqual(['e8e9']);
    expect(moveId(botMove(mate, { budgetMs: 300, random: () => 0 }))).toBe('e8e9');

    // Red is a chariot behind with two moves to choose from: stepping into the position for the
    // third time is a draw, and a draw is the best Red has.
    const behind = fromFen('5k3/9/9/9/r8/9/9/9/9/4K4 w');
    const repeat = positionKey(makeMove(behind, find(behind, 'e0d0')));
    expect(moveId(botMove(behind, { budgetMs: 300, random: () => 0 }))).toBe('e0e1');
    expect(moveId(botMove(behind, { budgetMs: 300, seen: new Map([[repeat, 2]]), random: () => 0 }))).toBe('e0d0');
    // With the material the other way round, the same draw throws a win away, so it is not played.
    const ahead = fromFen('5k3/9/9/9/9/9/9/9/R8/4K4 w');
    const same = positionKey(makeMove(ahead, find(ahead, 'a1a2')));
    expect(moveId(botMove(ahead, { budgetMs: 300, seen: new Map([[same, 2]]), random: () => 0 }))).not.toBe('a1a2');
  }, 20_000);
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

  it('gives every option the same facts, on one scale', () => {
    // A black soldier that has crossed the river is worth 2, in the words and in the data alike.
    const s = fromFen('3k5/9/9/9/9/9/4p4/9/4R4/4K4 w');
    const req = buildXiangqiRequest(s, analyze(s), []);
    const take = req.options.find((o) => o.id === 'e1e3')!;
    expect(take.description.captures).toBe('a soldier (2 points)');
    expect((req.data.options.find((o) => o.id === 'e1e3')!.facts as { captureValue: number }).captureValue).toBe(2);
    const fields = Object.keys(req.data.options[0].facts);
    for (const o of req.data.options) expect(Object.keys(o.facts)).toEqual(fields);
  });

  it('a seat says what it played only once the piece is on the board', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    const match = new XiangqiMatch([bot, bot], { maxMoves: 2, minMoveMs: 500 });
    const samples: string[] = [];
    const watch = setInterval(() => samples.push(`${match.history.length}|${match.seats[0].move}`), 10);
    match.start();
    await expect.poll(() => match.history.length, { timeout: 10_000 }).toBeGreaterThan(0);
    clearInterval(watch);
    match.stop();
    const played = match.history[0].notation;
    expect(samples.some((s) => s.startsWith('0|'))).toBe(true); // the seat was watched while it thought
    expect(samples.filter((s) => s.startsWith('0|') && s.includes(played))).toEqual([]);
    expect(match.seats[0].move).toContain(played);
    expect(match.seats[0].clockMs).toBeGreaterThan(0);
  }, 30_000);

  it('a side that gives check on every move of a repetition loses', async () => {
    // Red's chariot checks down one file, Black's general steps to the next one and back. After the
    // third time the position comes up, Red is plainly the one forcing it: 长将, and Red loses.
    const red = ['d5e5', 'e5f5', 'f5e5', 'e5f5', 'f5e5'];
    const black = ['e9f9', 'f9e9', 'e9f9', 'f9e9'];
    let i = 0;
    let j = 0;
    const chase = scripted('chaser', (req) => ((req.state.you_are as string).startsWith('Red') ? (red[i++] ?? req.botChoice()) : (black[j++] ?? req.botChoice())));
    const match = new XiangqiMatch([chase, chase], { maxMoves: 0, minMoveMs: 0 });
    match.state = fromFen('4k4/9/9/9/3R5/9/9/9/9/3K5 w');
    match.legal = legalMoves(match.state);
    match.start();
    await expect.poll(() => match.status, { timeout: 20_000 }).toBe('done');
    expect(match.history.map((m) => m.id)).toEqual(['d5e5', 'e9f9', 'e5f5', 'f9e9', 'f5e5', 'e9f9', 'e5f5', 'f9e9', 'f5e5']);
    expect(match.result?.winner).toBe(1); // Black wins: Red was the one giving check every move
    expect(match.result?.reason).toMatch(/长将|perpetual/);
  }, 30_000);

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

