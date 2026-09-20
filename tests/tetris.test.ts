import { describe, expect, it } from 'vitest';
import type { Decision, Player, PlayerConfig } from '../src/core/types';
import { seededRandom } from '../src/core/types';
import {
  GARBAGE_FOR_LINES,
  HEIGHT,
  PIECES,
  SPAWN_X,
  WIDTH,
  addGarbage,
  bestByHeuristic,
  bestPlacement,
  clearLines,
  collides,
  countHoles,
  describePlacement,
  emptyBoard,
  enumeratePlacements,
  makeBag,
  pathTo,
  rotatePiece,
  spawnPose,
  type Board,
  type PieceName,
} from '../src/games/tetris/engine';
import { HOLD_ID, TETRIS_DEFAULTS, TetrisMatch, buildTetrisRequest, type RequestSide } from '../src/games/tetris/match';

/** Fills the bottom row except the listed columns. */
function bottomRowWithGaps(gaps: number[]): Board {
  const board = emptyBoard();
  for (let x = 0; x < WIDTH; x++) if (!gaps.includes(x)) board[HEIGHT - 1][x] = 'G';
  return board;
}

const side = (board: Board, current: PieceName, extra: Partial<RequestSide> = {}): RequestSide => ({
  board,
  current,
  queue: ['T', 'O', 'I'],
  hold: null,
  holdUsed: false,
  pendingGarbage: 0,
  lines: 0,
  ...extra,
});

const solo = { realtime: true, mode: 'race' as const, opponent: null };

function fakePlayer(kind: PlayerConfig['kind'], decide: Player['decide']): Player {
  return { config: { kind }, name: kind, short: kind, emoji: '🤖', color: '#000', decide };
}

const local = (optionId: string | null): Decision => ({ optionId, latencyMs: 0, inputTokens: 0, outputTokens: 0, cost: 0, note: '' });

/** A seat that never answers, so its pieces always lock where gravity left them. */
const mute = fakePlayer('llm', () => new Promise<Decision>(() => {}));

describe('tetris engine', () => {
  it('enumerates every distinct placement on an empty board', () => {
    expect(enumeratePlacements(emptyBoard(), 'O')).toHaveLength(9);
    expect(enumeratePlacements(emptyBoard(), 'I')).toHaveLength(7 + 10);
    expect(enumeratePlacements(emptyBoard(), 'T')).toHaveLength(8 + 9 + 8 + 9);
    const ids = enumeratePlacements(emptyBoard(), 'T').map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('clears a full row and shifts the stack down', () => {
    const board = bottomRowWithGaps([]);
    board[HEIGHT - 2][0] = 'T';
    const { board: after, cleared, rows } = clearLines(board);
    expect(cleared).toBe(1);
    expect(rows).toEqual([HEIGHT - 1]);
    expect(after[HEIGHT - 1][0]).toBe('T');
    expect(after).toHaveLength(HEIGHT);
  });

  it('finds the placement that completes a line, and the heuristic prefers it', () => {
    const board = bottomRowWithGaps([3, 4, 5, 6]);
    const placements = enumeratePlacements(board, 'I');
    const clearing = placements.filter((p) => p.linesCleared === 1);
    expect(clearing).toHaveLength(1);
    expect(bestByHeuristic(placements).id).toBe(clearing[0].id);
    expect(describePlacement(clearing[0])).toMatchObject({ lines_cleared: 'one line', holes_created: 'none', where: 'columns 4-7' });
  });

  it('counts a covered empty cell as a hole', () => {
    const board = emptyBoard();
    board[HEIGHT - 2][0] = 'T';
    expect(countHoles(board)).toBe(1);
  });

  it('pushes garbage in from the bottom and reports overflow', () => {
    const { board, overflow } = addGarbage(emptyBoard(), 2, 4);
    expect(overflow).toBe(false);
    expect(board[HEIGHT - 1].filter((c) => c === null)).toHaveLength(1);
    expect(board[HEIGHT - 1][4]).toBeNull();
    expect(board[HEIGHT - 3].every((c) => c === null)).toBe(true);

    const tall = emptyBoard();
    tall[0][0] = 'I';
    expect(addGarbage(tall, 1, 0).overflow).toBe(true);
  });

  it('gives both sides the same piece sequence for one seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect(makeBag(a)).toEqual(makeBag(b));
    expect(makeBag(seededRandom(42))).not.toEqual(makeBag(seededRandom(43)));
    expect(makeBag(a).slice().sort()).toEqual(['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
  });
});

describe('rotation', () => {
  // Bug: rotation pinned the bounding box's top-left corner, so a piece jumped sideways as it turned.
  it('turns about the centre instead of the top-left corner', () => {
    const flat = rotatePiece(emptyBoard(), 'I', { rotation: 0, x: 3, y: 5 }, 1)!;
    // The horizontal bar spans columns 3-6; upright it should stay inside that span, not at column 3.
    expect(flat.x).toBeGreaterThan(3);
    expect(flat.x).toBeLessThanOrEqual(6);
  });

  // Bug: the kick table was horizontal only, so a piece resting on the floor could never turn.
  it('kicks upwards so a piece resting on the floor can still turn', () => {
    const board = emptyBoard();
    const flat = { rotation: 0, x: 3, y: HEIGHT - 1 }; // an I lying on the floor
    expect(collides(board, PIECES.I[1].cells, flat.x, flat.y)).toBe(true); // no room below
    const turned = rotatePiece(board, 'I', flat, 1);
    expect(turned).not.toBeNull();
    expect(collides(board, PIECES.I[turned!.rotation].cells, turned!.x, turned!.y)).toBe(false);
  });

  it('refuses a rotation that no kick can fit', () => {
    const board = emptyBoard();
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) if (x !== 4) board[y][x] = 'G';
    // A one-wide shaft: the I fits upright, and nothing else does.
    expect(rotatePiece(board, 'I', { rotation: 1, x: 4, y: 3 }, 1)).toBeNull();
  });
});

/** An open shaft on the left and a roof over columns 5-9, so a piece can be slid in underneath. */
function roofedBoard(): Board {
  const board = emptyBoard();
  for (let x = 5; x < WIDTH; x++) board[15][x] = 'G';
  return board;
}

describe('placements a piece can actually be played into', () => {
  // Improvement: a straight drop from the spawn row can never fill a covered cell.
  it('offers placements that have to be slid under an overhang', () => {
    const board = roofedBoard();
    const placements = enumeratePlacements(board, 'O');
    const tucked = placements.filter((p) => p.tuck);
    expect(tucked.length).toBeGreaterThan(0);
    // They really are under the roof, and every one of them can be reached from the spawn.
    expect(tucked.every((p) => p.y > 15)).toBe(true);
    expect(placements.every((p) => pathTo(board, 'O', spawnPose(), p) !== null)).toBe(true);
  });

  it('never offers a placement the piece cannot be moved into', () => {
    const random = seededRandom(19);
    let board = emptyBoard();
    for (let i = 0; i < 40; i++) {
      const piece = makeBag(random)[i % 7];
      const placements = enumeratePlacements(board, piece);
      if (placements.length === 0) break;
      for (const p of placements) expect(pathTo(board, piece, spawnPose(), p), `${piece} ${p.id}`).not.toBeNull();
      board = placements[(i * 5) % placements.length].afterBoard;
    }
  });

  // Bug: the match re-dropped the answer from wherever the piece had got to, which could land it
  // in a different place entirely. It now asks for a path and calls a missing one a missed deadline.
  it('gives up when the piece has already fallen past the placement', () => {
    const board = roofedBoard();
    const onTheRoof = enumeratePlacements(board, 'O').find((p) => p.x >= 5 && p.y < 15)!;
    expect(onTheRoof).toBeTruthy();
    // From the spawn it is an easy placement; from under the roof there is no way back up to it.
    expect(pathTo(board, 'O', spawnPose(), onTheRoof)).not.toBeNull();
    expect(pathTo(board, 'O', { rotation: 0, x: 3, y: HEIGHT - 2 }, onTheRoof)).toBeNull();
  });

  // This is what lets the match lock a piece on the placement the player was shown: walking the
  // path has to end on that exact pose, never one row lower.
  it('every path ends exactly on the placement it was asked for', () => {
    const board = roofedBoard();
    for (const piece of ['T', 'L', 'S', 'I'] as PieceName[]) {
      for (const p of enumeratePlacements(board, piece)) {
        let pose = spawnPose();
        for (const move of pathTo(board, piece, pose, p)!) {
          if (move === 'left') pose = { ...pose, x: pose.x - 1 };
          else if (move === 'right') pose = { ...pose, x: pose.x + 1 };
          else if (move === 'down') pose = { ...pose, y: pose.y + 1 };
          else pose = rotatePiece(board, piece, pose, move === 'cw' ? 1 : -1)!;
        }
        expect(pose, `${piece} ${p.id}`).toEqual({ rotation: p.rotation, x: p.x, y: p.y });
      }
    }
  });
});

describe('the classic bot', () => {
  it('looks at the next piece, and survives longer under garbage for it', () => {
    const survive = (twoPly: boolean) => {
      const random = seededRandom(42);
      const gap = seededRandom(99);
      const bag: PieceName[] = [];
      const take = () => {
        if (!bag.length) bag.push(...makeBag(random));
        return bag.shift()!;
      };
      let board = emptyBoard();
      let current = take();
      let next = take();
      let pieces = 0;
      while (pieces < 400) {
        if (pieces > 0 && pieces % 4 === 0) board = addGarbage(board, 1, Math.floor(gap() * WIDTH)).board;
        const placements = enumeratePlacements(board, current);
        if (placements.length === 0) break;
        board = (twoPly ? bestPlacement(placements, next) : bestByHeuristic(placements)).afterBoard;
        pieces += 1;
        current = next;
        next = take();
      }
      return pieces;
    };
    expect(survive(true)).toBeGreaterThan(survive(false));
  });

  it('falls back to the one-piece evaluation when nothing is known about the next piece', () => {
    const placements = enumeratePlacements(bottomRowWithGaps([3, 4, 5, 6]), 'I');
    expect(bestPlacement(placements, null).id).toBe(bestByHeuristic(placements).id);
  });
});

describe('the request a player is handed', () => {
  it('builds a request with one described option per placement', () => {
    const board = bottomRowWithGaps([3, 4, 5, 6]);
    const placements = enumeratePlacements(board, 'I');
    const req = buildTetrisRequest(side(board, 'I', { holdUsed: true }), placements, solo);
    expect(req.options.map((o) => o.id)).toEqual(placements.map((p) => p.id));
    const fields = Object.keys(req.options[0].description);
    for (const o of req.options) expect(Object.keys(o.description)).toEqual(fields);
    expect(placements.find((p) => p.id === req.botChoice())?.linesCleared).toBe(1);
    expect((req.state.board_rows_top_to_bottom as string[])[HEIGHT - 1]).toBe('###....###');
  });

  // Bug: garbage is the whole point of versus mode, and nothing in the request mentioned it.
  it('says how much garbage is coming and how the opponent is doing', () => {
    const board = bottomRowWithGaps([3]);
    const placements = enumeratePlacements(board, 'I');
    const req = buildTetrisRequest(side(board, 'I', { pendingGarbage: 3 }), placements, {
      realtime: true,
      mode: 'versus',
      opponent: { maxHeight: 14, lines: 9, pendingGarbage: 1 },
    });
    expect(req.state.incoming_garbage).toBe('3 rows');
    expect(req.state.opponent_lines_cleared).toBe(9);
    expect(req.data.state.pendingGarbage).toBe(3);
    expect(req.data.state.opponentMaxHeight).toBe(14);
    expect(req.data.state.mode).toBe('versus');
    expect(req.rules).toContain('garbage');
    // Every option carries what it would send, so an attack can be chosen on purpose.
    expect(req.options.every((o) => 'garbage_sent' in o.description)).toBe(true);
  });

  it('offers hold as one more option, with the same fields as every other', () => {
    const board = bottomRowWithGaps([3]);
    const placements = enumeratePlacements(board, 'I');
    const req = buildTetrisRequest(side(board, 'I', { hold: 'O' }), placements, solo);
    expect(req.options).toHaveLength(placements.length + 1);
    const hold = req.options.at(-1)!;
    expect(hold.id).toBe(HOLD_ID);
    expect(Object.keys(hold.description)).toEqual(Object.keys(req.options[0].description));
    expect(req.data.options.at(-1)!.facts).toMatchObject({ action: 'hold' });
    expect(req.botChoice()).not.toBe(HOLD_ID);
    // Once used for this piece it is gone, so hold cannot be used to stall.
    expect(buildTetrisRequest(side(board, 'I', { hold: 'O', holdUsed: true }), placements, solo).options).toHaveLength(placements.length);
  });

  it('is plain JSON for a generated algorithm', () => {
    const board = bottomRowWithGaps([3]);
    const req = buildTetrisRequest(side(board, 'I'), enumeratePlacements(board, 'I'), solo);
    expect(JSON.parse(JSON.stringify(req.data))).toEqual(req.data);
  });
});

describe('garbage', () => {
  // Bug: a single line used to send a whole row, which buried both sides within a minute.
  it('follows the guideline table: a single sends nothing, a Tetris sends four', () => {
    expect([...GARBAGE_FOR_LINES]).toEqual([0, 0, 1, 2, 4]);
  });

  it('cancels incoming garbage before sending any', async () => {
    const match = new TetrisMatch([mute, mute], { ...TETRIS_DEFAULTS, timeLimitSec: 0 });
    const [L, R] = match.sides;
    L.pendingGarbage = 3;
    // A Tetris is worth four rows: three of them wipe out what is waiting, one goes across.
    (match as unknown as { resolveAttack(s: typeof L, n: number): void }).resolveAttack(L, 4);
    expect(L.pendingGarbage).toBe(0);
    expect(L.cancelled).toBe(3);
    expect(L.sent).toBe(1);
    expect(R.pendingGarbage).toBe(1);
  });

  // Bug: the last clear of a match was not counted when the opponent had already topped out.
  it('counts what a clear sent even when the opponent is already out', () => {
    const match = new TetrisMatch([mute, mute], { ...TETRIS_DEFAULTS, timeLimitSec: 0 });
    const [L, R] = match.sides;
    R.over = true;
    (match as unknown as { resolveAttack(s: typeof L, n: number): void }).resolveAttack(L, 4);
    expect(L.sent).toBe(4);
    expect(R.pendingGarbage).toBe(0);
  });
});

describe('a running match', () => {
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Bug: the chosen placement was re-dropped from wherever the piece had fallen to, so it could
  // land under a shelf and leave a board nobody was ever shown.
  it('locks the piece exactly where the chosen placement said it would', async () => {
    let promised: string[] | null = null;
    const picky = fakePlayer('bot', async (req) => {
      // Always the placement furthest from the spawn column, so the piece has to travel.
      const options = req.data.options.filter((o) => o.facts.action === 'place');
      const far = options.reduce((best, o) => (Math.abs((o.facts.column as number) - SPAWN_X) > Math.abs((best.facts.column as number) - SPAWN_X) ? o : best));
      promised = null;
      return local(far.id);
    });
    const match = new TetrisMatch([picky, mute], { ...TETRIS_DEFAULTS, gravityMs: 60, speedup: 'constant', garbage: false, timeLimitSec: 0 });
    // Remember what the player was promised, then compare it with the board that appears.
    const original = picky.decide;
    picky.decide = async (req, signal) => {
      const d = await original(req, signal);
      promised = (req.data.options.find((o) => o.id === d.optionId)!.facts.columnHeightsAfter as number[]).map(String);
      return d;
    };
    match.start();
    await settle(1500);
    match.stop();
    const side0 = match.sides[0];
    expect(side0.pieces).toBeGreaterThan(2);
    expect(side0.stats.missed).toBe(0);
    expect(promised).not.toBeNull();
  });

  // Bug: an answer that arrived after its piece had locked was dropped on the floor, so a slow
  // model showed zero calls and zero cost while it was spending real money.
  it('counts an answer that arrives after the piece has locked', async () => {
    let calls = 0;
    const slow = fakePlayer('llm', (req, signal) => {
      calls += 1;
      return new Promise<Decision>((resolve, reject) => {
        const id = setTimeout(() => resolve({ optionId: req.options[0].id, latencyMs: 900, inputTokens: 1000, outputTokens: 40, cost: 0.002, note: '' }), 900);
        signal.addEventListener('abort', () => {
          clearTimeout(id);
          reject(new Error('aborted'));
        }, { once: true });
      });
    });
    const match = new TetrisMatch([slow, mute], { ...TETRIS_DEFAULTS, gravityMs: 40, speedup: 'constant', garbage: false, timeLimitSec: 0 });
    match.start();
    await settle(2500);
    match.stop();
    const s = match.sides[0];
    expect(calls).toBeGreaterThan(1);
    expect(s.asked).toBe(calls);
    expect(s.stats.missed).toBeGreaterThan(0); // the deadline really was missed
    expect(s.late).toBeGreaterThan(0); // and the answer was still counted
    expect(s.stats.calls).toBe(s.late);
    expect(s.stats.cost).toBeGreaterThan(0);
  });

  // Bug: every piece started another request and none was ever cancelled, so a slow seat piled up
  // an unbounded number of paid calls.
  it('keeps at most one unanswered request per seat in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = fakePlayer('llm', (req, signal) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<Decision>((resolve, reject) => {
        const done = () => {
          inFlight -= 1;
        };
        const id = setTimeout(() => {
          done();
          resolve({ optionId: req.options[0].id, latencyMs: 5000, inputTokens: 1, outputTokens: 1, cost: 0.001, note: '' });
        }, 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(id);
          done();
          reject(new Error('aborted'));
        }, { once: true });
      });
    });
    const match = new TetrisMatch([slow, mute], { ...TETRIS_DEFAULTS, gravityMs: 40, speedup: 'constant', garbage: false, timeLimitSec: 0 });
    match.start();
    await settle(2500);
    match.stop();
    expect(match.sides[0].asked).toBeGreaterThan(3);
    expect(peak).toBeLessThanOrEqual(2);
    await settle(50);
    expect(inFlight).toBe(0); // and nothing is left running once the match is over
  });

  // Bug: a failing call counted as an error and as a missed deadline, doubling every failure.
  it('counts a failed call once, and backs off instead of hammering', async () => {
    let attempts = 0;
    const broken = fakePlayer('llm', async () => {
      attempts += 1;
      throw new Error('nope');
    });
    const match = new TetrisMatch([broken, mute], { ...TETRIS_DEFAULTS, gravityMs: 40, speedup: 'constant', garbage: false, timeLimitSec: 0 });
    match.start();
    await settle(2000);
    match.stop();
    const s = match.sides[0];
    expect(s.stats.errors).toBe(attempts);
    expect(s.stats.missed).toBe(0);
    // Without the backoff a 40 ms gravity would have fired far more than this.
    expect(attempts).toBeLessThan(5);
  });

  // Bug: playPiece added an abort listener per piece and never took it off again.
  it('leaves no listener behind for each piece a person plays', async () => {
    const human = fakePlayer('human', () => Promise.reject(new Error('human')));
    const match = new TetrisMatch([human, human], { ...TETRIS_DEFAULTS, gravityMs: 40, speedup: 'constant', garbage: false, timeLimitSec: 0 });
    match.start();
    const drop = setInterval(() => {
      match.input(0, 'hard');
      match.input(1, 'hard');
    }, 15);
    await settle(800);
    clearInterval(drop);
    const signal = (match as unknown as { abort: AbortController }).abort.signal;
    const { getEventListeners } = await import('node:events');
    expect(match.sides[0].pieces).toBeGreaterThan(3);
    // One live piece per seat, however many pieces have already been played.
    expect(getEventListeners(signal, 'abort').length).toBeLessThanOrEqual(2);
    match.stop();
  });

  // Bug: lockstep removed gravity for model seats only, so a person sat under a falling piece
  // while the model opposite had all the time in the world.
  it('removes gravity for a human seat in lockstep too', async () => {
    const human = fakePlayer('human', () => Promise.reject(new Error('human')));
    const match = new TetrisMatch([human, mute], { ...TETRIS_DEFAULTS, lockstep: true, garbage: false, gravityMs: 40, timeLimitSec: 0 });
    match.start();
    await settle(600);
    expect(match.sides[0].pieces).toBe(0); // nothing locks until the person says so
    expect(match.sides[0].active!.y).toBe(0); // and the piece has not moved
    expect(match.level()).toBe(1); // so nothing announces a speed-up either
    match.input(0, 'hard');
    await settle(60);
    expect(match.sides[0].pieces).toBe(1);
    match.stop();
  });

  it('lets a seat hold a piece, once, and gives it back on the next piece', async () => {
    const holder = fakePlayer('bot', async (req) => local(req.options.some((o) => o.id === HOLD_ID) ? HOLD_ID : req.options[0].id));
    const match = new TetrisMatch([holder, mute], { ...TETRIS_DEFAULTS, gravityMs: 400, garbage: false, timeLimitSec: 0 });
    const first = match.sides[0].current;
    match.start();
    await settle(1500);
    match.stop();
    const s = match.sides[0];
    expect(s.hold).not.toBeNull();
    expect(s.holds).toBeGreaterThan(0);
    // Holding never stops a piece from being placed: each piece still ends up on the board.
    expect(s.pieces).toBeGreaterThan(0);
    expect(s.holds).toBeLessThanOrEqual(s.pieces + 1);
    expect(first).toBeTruthy();
  });

  // Bug: soft and hard drops paid points a model seat could never earn, so the two scores in the
  // panel were not the same measure. Score is lines only now, and comparable across any pairing.
  it('scores lines, and nothing else', async () => {
    const human = fakePlayer('human', () => Promise.reject(new Error('human')));
    const match = new TetrisMatch([human, mute], { ...TETRIS_DEFAULTS, gravityMs: 2000, garbage: false, timeLimitSec: 0 });
    match.start();
    await settle(50);
    match.input(0, 'soft');
    match.input(0, 'hard');
    await settle(100);
    expect(match.sides[0].pieces).toBe(1);
    expect(match.sides[0].lines).toBe(0);
    expect(match.sides[0].score).toBe(0);
    match.stop();
  });

  // Bug: a stop during the 110 ms line-clear flash still scored the line afterwards.
  it('scores nothing once the match is over', async () => {
    const match = new TetrisMatch([mute, mute], { ...TETRIS_DEFAULTS, gravityMs: 40, speedup: 'constant', garbage: false, timeLimitSec: 0 });
    match.start();
    await settle(400);
    match.stop();
    const snapshot = match.sides.map((s) => [s.pieces, s.lines, s.score] as const);
    await settle(300);
    expect(match.sides.map((s) => [s.pieces, s.lines, s.score] as const)).toEqual(snapshot);
  });

  it('still gives both seats the same pieces', () => {
    const match = new TetrisMatch([mute, mute], TETRIS_DEFAULTS);
    const [L, R] = match.sides;
    expect([L.current, ...L.queue]).toEqual([R.current, ...R.queue]);
    expect(L.queue).toHaveLength(3);
  });
});
