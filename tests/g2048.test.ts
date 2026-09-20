import { describe, expect, it } from 'vitest';
import type { Decision, DecisionRequest, Player, PlayerConfig } from '../src/core/types';
import { PlayerError, seededRandom, sleep } from '../src/core/types';
import { analyze, boardToText, botMove, describeMove, emptyCells, legalDirs, maxInCorner, maxTile, orderliness, searchDepth, slide, spawn, startBoard, type Board } from '../src/games/g2048/engine';
import { DEFAULTS_2048, Match2048, build2048Request, verdict2048, type Options2048, type Side2048 } from '../src/games/g2048/match';

const rows = (...r: number[][]): Board => r.flat();
/** A match that runs flat out, with the clock and the per-move deadline out of the way. */
const OPTIONS: Options2048 = { seed: 5, timeLimitSec: 0, minMoveMs: 0, lockstep: false, moveDeadlineSec: 0 };

describe('2048 engine', () => {
  it('slides and merges each tile at most once per move', () => {
    expect(slide(rows([2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), 'left').board.slice(0, 4)).toEqual([4, 4, 0, 0]);
    expect(slide(rows([2, 2, 4, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), 'left').board.slice(0, 4)).toEqual([4, 4, 0, 0]);
    expect(slide(rows([4, 2, 2, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), 'right').board.slice(0, 4)).toEqual([0, 0, 4, 4]);
    const up = slide(rows([2, 0, 0, 0], [2, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]), 'up');
    expect([up.board[0], up.board[4], up.board[8]]).toEqual([4, 8, 0]);
    expect(up.gained).toBe(12);
    expect(up.merges).toBe(2);
  });

  it('reports every tile\'s journey, with both halves of a merge marked', () => {
    const { slides } = slide(rows([2, 0, 2, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]), 'left');
    expect(slides).toEqual([
      { from: 0, to: 0, value: 2, merged: true },
      { from: 2, to: 0, value: 2, merged: true },
      { from: 3, to: 1, value: 4, merged: false },
    ]);
  });

  it('calls a move that changes nothing illegal', () => {
    const board = rows([2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
    expect(slide(board, 'left').moved).toBe(false);
    // A full row of different tiles cannot slide sideways at all.
    expect(legalDirs(board)).toEqual(['down']);
    const locked = rows([2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]);
    expect(legalDirs(locked)).toEqual([]);
    expect(analyze(locked)).toEqual([]);
  });

  it('spawns on an empty cell, the same way for the same seed', () => {
    const a = startBoard(seededRandom(9));
    expect(a.filter(Boolean)).toHaveLength(2);
    expect(startBoard(seededRandom(9))).toEqual(a);
    const full = rows([2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]);
    expect(spawn(full, seededRandom(1))).toBeNull();
    const next = spawn(a, seededRandom(3))!;
    expect(a[next.index]).toBe(0);
    expect([2, 4]).toContain(next.value);
  });

  it('describes what a move does to the corner, the order and the room left', () => {
    const board = rows([0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0], [512, 64, 8, 2]);
    expect(maxInCorner(board)).toBe(true);
    expect(orderliness(board)).toBeGreaterThan(0.9);
    const facts = analyze(board);
    const up = describeMove(facts.find((f) => f.dir === 'up')!);
    expect(up.largest_tile).toMatch(/^PULLS the largest tile \(512\) OUT/);
    const right = facts.find((f) => f.dir === 'right')!;
    expect(describeMove(right).largest_tile).toBe('512 sits in a corner');
    expect(botMove(board)).not.toBe('up');
    const fields = Object.keys(up);
    for (const f of facts) expect(Object.keys(describeMove(f))).toEqual(fields);
    expect(boardToText(board)[3]).toBe('  512   64    8    2');
  });

  it('builds a request whose options are exactly the legal directions, and says how the race stands', () => {
    const board = rows([2, 4, 8, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
    const req = build2048Request(board, 120, analyze(board), { opponentScore: 200, scoreGap: -80, secondsLeft: 45, movesMade: 12 });
    expect(req.options.map((o) => o.id).sort()).toEqual(['down', 'right']);
    expect(['down', 'right']).toContain(req.botChoice());
    // The other board is half the game: a player that cannot see it cannot know when to gamble.
    expect(req.state.opponent_score).toBe(200);
    expect(req.state.you_are).toBe('80 points behind');
    expect(req.state.time_left).toBe('45 seconds');
    expect(req.data.state).toMatchObject({ opponentScore: 200, scoreGap: -80, secondsLeft: 45, movesMade: 12 });
  });

  it('searches deeper only where the board is crowded enough to afford it', () => {
    // An open board branches over every empty cell, so depth is bought with the room the board has lost.
    expect(searchDepth(16)).toBe(1);
    expect(searchDepth(8)).toBe(1);
    expect(searchDepth(4)).toBeGreaterThan(1);
    expect(searchDepth(0)).toBeGreaterThanOrEqual(searchDepth(4));
    // Never deeper on a roomier board: that is the way round that gets expensive.
    for (let free = 0; free < 16; free++) expect(searchDepth(free)).toBeGreaterThanOrEqual(searchDepth(free + 1));
  });

  it('is a pure function of the board, so one seed is one game however busy the page is', () => {
    const board = rows([2, 4, 8, 16], [32, 64, 128, 256], [2, 4, 8, 16], [32, 64, 0, 0]);
    const first = botMove(board);
    for (let i = 0; i < 20; i++) expect(botMove(board)).toBe(first);
    expect(legalDirs(board)).toContain(first);
  });

  it('plays a whole game to a respectable tile without stalling the page', () => {
    const random = seededRandom(11);
    let board = startBoard(random);
    let moves = 0;
    let worst = 0;
    while (legalDirs(board).length && moves < 3000) {
      const started = performance.now();
      const dir = botMove(board);
      worst = Math.max(worst, performance.now() - started);
      board = spawn(slide(board, dir).board, random)!.board;
      moves += 1;
    }
    expect(Math.max(...board)).toBeGreaterThanOrEqual(1024);
    expect(emptyCells(board).length).toBeLessThan(16);
    // Deeper is only worth having if the page still moves: a move stays well inside the 160 ms pace.
    expect(worst).toBeLessThan(120);
  }, 120_000);
});

describe('2048 match', () => {
  const scripted = (name: string, pick: (req: DecisionRequest) => string | null): Player => ({
    config: { kind: 'bot' },
    name,
    short: name,
    emoji: '',
    color: '',
    decide: async (req): Promise<Decision> => ({ optionId: pick(req), latencyMs: 1, inputTokens: 0, outputTokens: 0, cost: 0, note: 'scripted' }),
  });

  const throwing = (name: string, make: () => Error): Player => ({ ...scripted(name, () => null), name, short: name, decide: async () => { throw make(); } });

  const human = (name = 'you'): Player => ({
    config: { kind: 'human' } as PlayerConfig,
    name,
    short: name,
    emoji: '',
    color: '',
    decide: () => Promise.reject(new Error('a human seat reads input from the game')),
  });

  /** Both seats human: nothing happens until the test says so, one move at a time. */
  const handPlayed = async (options: Partial<Options2048> = {}) => {
    const match = new Match2048([human('a'), human('b')], { ...OPTIONS, ...options });
    match.start();
    await sleep(5);
    return match;
  };

  it('both sides start from the same board, and the better player wins once both are stuck', async () => {
    const bot = scripted('bot', (req) => req.botChoice());
    // Always the first legal direction: it locks up early.
    const naive = scripted('naive', (req) => req.options[0].id);
    const match = new Match2048([naive, bot], OPTIONS);
    expect(match.sides[0].board).toEqual(match.sides[1].board);
    match.start();
    await expect.poll(() => match.status, { timeout: 120_000, interval: 25 }).toBe('done');
    expect(match.result?.winner).toBe(1);
    expect(match.sides[1].score).toBeGreaterThan(match.sides[0].score);
    expect(match.sides[0].over).toBe(true);
    // Tiles on screen always match the board.
    for (const side of match.sides) {
      const live = side.tiles.filter((tile) => !tile.dying);
      expect(live).toHaveLength(side.board.filter(Boolean).length);
      for (const tile of live) expect(side.board[tile.index]).toBe(tile.value);
    }
  }, 180_000);

  it('an invalid answer falls back to the bot instead of stalling', async () => {
    const broken = scripted('broken', () => 'diagonal');
    const bot = scripted('bot', (req) => req.botChoice());
    const match = new Match2048([broken, bot], OPTIONS);
    match.start();
    await expect.poll(() => match.sides[0].moves, { timeout: 30_000, interval: 10 }).toBeGreaterThanOrEqual(20);
    match.stop();
    expect(match.sides[0].stats.invalid).toBe(match.sides[0].stats.calls);
    expect(match.result?.stopped).toBe(true);
  }, 60_000);

  it('plays no move after the result has been written', async () => {
    // An error pauses the seat for half a second before the bot steps in; the match can end in between.
    const match = new Match2048([throwing('broken', () => new Error('boom')), scripted('bot', (req) => req.botChoice())], OPTIONS);
    match.start();
    await sleep(60);
    match.stop();
    const frozen = match.sides.map((s) => ({ score: s.score, moves: s.moves }));
    await sleep(700);
    expect(match.sides.map((s) => ({ score: s.score, moves: s.moves }))).toEqual(frozen);
  }, 20_000);

  it('splits an equal score by the largest tile, then by the fewer moves', () => {
    const side = (score: number, best: number, moves: number) => ({ score, best, moves }) as Side2048;
    expect(verdict2048(side(100, 64, 30), side(90, 128, 20))).toMatchObject({ by: 'score' });
    expect(verdict2048(side(100, 64, 30), side(100, 128, 40)).by).toBe('tile');
    expect(verdict2048(side(100, 64, 30), side(100, 128, 40)).leader?.best).toBe(128);
    expect(verdict2048(side(100, 64, 30), side(100, 64, 40)).by).toBe('moves');
    expect(verdict2048(side(100, 64, 30), side(100, 64, 40)).leader?.moves).toBe(30);
    expect(verdict2048(side(100, 64, 30), side(100, 64, 30)).leader).toBeNull();
  });

  it('keeps the best tile in step with the board, including a tile that only spawned', async () => {
    // A 4 can arrive without a single merge, and it is still the largest tile on the board.
    for (const seed of [5, 50, 77]) {
      const match = await handPlayed({ seed });
      for (let move = 0; move < 6; move++) {
        match.input(0, botMove(match.sides[0].board));
        await sleep(4);
        expect(match.sides[0].best, `seed ${seed}, move ${move}`).toBe(maxTile(match.sides[0].board));
      }
      match.stop();
    }
  }, 30_000);

  it('does not pile up an abort listener for every move a person makes', async () => {
    const match = await handPlayed();
    const { getEventListeners } = await import('node:events');
    const signal = (match as unknown as { abort: AbortController }).abort.signal;
    for (let move = 0; move < 25; move++) {
      match.input(0, botMove(match.sides[0].board));
      await sleep(3);
    }
    expect(match.sides[0].moves).toBeGreaterThan(10);
    // One seat waiting for a key is one listener, however long it has been playing.
    expect(getEventListeners(signal, 'abort').length).toBeLessThanOrEqual(4);
    match.stop();
  }, 30_000);

  it('marks a merged tile so it can wait for the halves that made it', async () => {
    const match = await handPlayed({ seed: 5 });
    for (let move = 0; move < 20; move++) {
      match.input(0, botMove(match.sides[0].board));
      await sleep(4);
      const side = match.sides[0];
      const fused = side.tiles.filter((tile) => tile.fused);
      if (fused.length === 0) continue;
      // Every fused tile is new, and the two halves that made it are on their way out.
      expect(fused.every((tile) => tile.born)).toBe(true);
      expect(side.tiles.filter((tile) => tile.dying)).toHaveLength(fused.length * 2);
      expect(side.tiles.filter((tile) => tile.born && !tile.fused).every((tile) => !tile.dying)).toBe(true);
      match.stop();
      return;
    }
    throw new Error('no merge happened in 20 moves');
  }, 30_000);

  it('gives up on a request that never comes back and plays on', async () => {
    const silent: Player = {
      ...scripted('silent', () => null),
      decide: (_req, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    };
    const match = new Match2048([silent, scripted('bot', (req) => req.botChoice())], { ...OPTIONS, moveDeadlineSec: 0.05 });
    match.start();
    await expect.poll(() => match.sides[0].moves, { timeout: 10_000, interval: 10 }).toBeGreaterThanOrEqual(3);
    expect(match.sides[0].stats.missed).toBeGreaterThanOrEqual(3);
    match.stop();
  }, 20_000);

  it('counts a call that failed, so the averages do not flatter the seat', async () => {
    const match = new Match2048([throwing('broken', () => new Error('boom')), scripted('bot', (req) => req.botChoice())], OPTIONS);
    match.start();
    await expect.poll(() => match.sides[0].stats.errors, { timeout: 20_000, interval: 20 }).toBeGreaterThanOrEqual(2);
    match.stop();
    const { calls, errors, invalid } = match.sides[0].stats;
    expect(calls).toBe(errors);
    expect(invalid).toBe(0);
  }, 30_000);

  it('hands a seat to the algorithm after three hard errors in a row', async () => {
    const match = new Match2048([throwing('nokey', () => new PlayerError('no key', 401)), scripted('bot', (req) => req.botChoice())], OPTIONS);
    match.start();
    await expect.poll(() => match.sides[0].demoted, { timeout: 20_000, interval: 20 }).toBe(true);
    const callsWhenDemoted = match.sides[0].stats.calls;
    expect(callsWhenDemoted).toBe(3);
    // From here the seat plays without asking anyone, so it keeps moving and stops spending.
    await expect.poll(() => match.sides[0].moves, { timeout: 10_000, interval: 20 }).toBeGreaterThan(5);
    expect(match.sides[0].stats.calls).toBe(callsWhenDemoted);
    expect(match.error).toContain('no key');
    match.stop();
  }, 40_000);

  it('lockstep holds the quick seat back so both boards play the same number of moves', async () => {
    const quick = scripted('quick', (req) => req.botChoice());
    const slow: Player = {
      ...scripted('slow', () => null),
      decide: async (req) => {
        await sleep(40);
        return { optionId: req.botChoice(), latencyMs: 40, inputTokens: 0, outputTokens: 0, cost: 0, note: 'slow' };
      },
    };
    const match = new Match2048([quick, slow], { ...OPTIONS, lockstep: true });
    match.start();
    await expect.poll(() => match.sides[1].moves, { timeout: 20_000, interval: 20 }).toBeGreaterThanOrEqual(6);
    expect(Math.abs(match.sides[0].moves - match.sides[1].moves)).toBeLessThanOrEqual(1);
    match.stop();
  }, 30_000);

  it('lets a person concede to a board that is already stuck', async () => {
    const match = await handPlayed();
    match.concede(0);
    expect(match.status).toBe('done');
    expect(match.result?.winner).toBe(1);
    expect(match.result?.stopped).toBe(false);
    expect(match.result?.reason).toContain('b');
  });

  it('records 2048 for whoever gets there first', async () => {
    // The shallow search keeps the test quick, and seed 1 takes it to 2048 all the same.
    const shallow = scripted('shallow', (req) => botMove((req.data.state.board as number[][]).flat(), 1));
    const match = new Match2048([shallow, shallow], { ...OPTIONS, seed: 1 });
    match.start();
    await expect.poll(() => match.status, { timeout: 120_000, interval: 50 }).toBe('done');
    expect(match.first2048).not.toBeNull();
    for (const side of match.sides) expect(side.reached2048).toBeGreaterThan(0);
    // The same seed, the same pace and the same algorithm really is a dead heat: only a tiebreak splits it.
    expect(match.result?.winner).toBeNull();
  }, 150_000);

  it('ships with a pace and a deadline that are not a user setting', () => {
    expect(DEFAULTS_2048.lockstep).toBe(false);
    expect(DEFAULTS_2048.minMoveMs).toBeGreaterThan(0);
    expect(DEFAULTS_2048.moveDeadlineSec).toBeGreaterThan(0);
  });
});
