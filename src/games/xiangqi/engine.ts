// Pure Chinese chess (象棋, xiangqi) engine. No DOM, no network. Verified by perft in
// tests/xiangqi.test.ts against the published counts (44, 1920, 79666 from the opening).
//
// The board is 9 files by 10 ranks, stored row by row from the top: square = row * 9 + col, with
// Black's back rank on row 0 and Red's on row 9. Red moves first. Pieces are letters, upper case
// for Red and lower case for Black: K 帅/将, A 仕/士, B 相/象, N 马, R 车, C 炮, P 兵/卒.

export type Color = 'r' | 'b';
export type PieceType = 'k' | 'a' | 'b' | 'n' | 'r' | 'c' | 'p';
export type Piece = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P' | 'k' | 'a' | 'b' | 'n' | 'r' | 'c' | 'p';

export const COLS = 9;
export const ROWS = 10;
export const SQUARES = COLS * ROWS;

export interface XiangqiState {
  board: (Piece | null)[];
  turn: Color;
  /** Plies since the last capture, for the no-progress draw. */
  quiet: number;
  fullmove: number;
}

export interface Move {
  from: number;
  to: number;
  piece: Piece;
  captured: Piece | null;
}

export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';
const FILES = 'abcdefghi';

export const rowOf = (sq: number) => Math.floor(sq / COLS);
export const colOf = (sq: number) => sq % COLS;
export const colorOf = (p: Piece): Color => (p === p.toUpperCase() ? 'r' : 'b');
export const typeOf = (p: Piece) => p.toLowerCase() as PieceType;
export const opposite = (c: Color): Color => (c === 'r' ? 'b' : 'r');
/** Coordinates as engines write them: files a to i from Red's left, ranks 0 to 9 from Red's side. */
export const squareName = (sq: number) => `${FILES[colOf(sq)]}${ROWS - 1 - rowOf(sq)}`;
export const moveId = (m: Move) => `${squareName(m.from)}${squareName(m.to)}`;

const inside = (r: number, c: number) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
const inPalace = (r: number, c: number, color: Color) => c >= 3 && c <= 5 && (color === 'r' ? r >= 7 : r <= 2);
/** Rows on a colour's own side of the river. */
const ownSide = (r: number, color: Color) => (color === 'r' ? r >= 5 : r <= 4);
const forwardOf = (color: Color) => (color === 'r' ? -1 : 1);

export function fromFen(fen: string): XiangqiState {
  const [placement, turn = 'w'] = fen.trim().split(/\s+/);
  const board: (Piece | null)[] = [];
  for (const ch of placement) {
    if (ch === '/') continue;
    if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) board.push(null);
    else board.push(ch as Piece);
  }
  return { board, turn: turn === 'b' ? 'b' : 'r', quiet: 0, fullmove: 1 };
}

export const startState = (): XiangqiState => fromFen(START_FEN);
export const positionKey = (s: XiangqiState) => `${s.board.map((p) => p ?? '.').join('')}${s.turn}`;

/** The position written back out the way `fromFen` reads it, for sharing or resuming a game. */
export function toFen(s: XiangqiState): string {
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    let row = '';
    let empty = 0;
    for (let c = 0; c < COLS; c++) {
      const p = s.board[r * COLS + c];
      if (!p) empty += 1;
      else {
        row += (empty || '') + p;
        empty = 0;
      }
    }
    rows.push(row + (empty || ''));
  }
  return `${rows.join('/')} ${s.turn === 'r' ? 'w' : 'b'}`;
}

const ORTHOGONAL: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIAGONAL: [number, number][] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
// A horse steps one square straight (its "leg", which must be empty), then one diagonally outward.
const HORSE: [leg: [number, number], to: [number, number]][] = [
  [[-1, 0], [-2, -1]], [[-1, 0], [-2, 1]], [[1, 0], [2, -1]], [[1, 0], [2, 1]],
  [[0, -1], [-1, -2]], [[0, -1], [1, -2]], [[0, 1], [-1, 2]], [[0, 1], [1, 2]],
];

/** Moves that obey how the pieces move, without yet asking whether they leave the general in check. */
export function pseudoMoves(board: (Piece | null)[], turn: Color): Move[] {
  const moves: Move[] = [];
  for (let from = 0; from < SQUARES; from++) {
    const piece = board[from];
    if (!piece || colorOf(piece) !== turn) continue;
    const r = rowOf(from);
    const c = colOf(from);
    const tryStep = (rr: number, cc: number) => {
      if (!inside(rr, cc)) return;
      const target = board[rr * COLS + cc];
      if (!target || colorOf(target) !== turn) moves.push({ from, to: rr * COLS + cc, piece, captured: target });
    };

    switch (typeOf(piece)) {
      case 'k':
        for (const [dr, dc] of ORTHOGONAL) if (inPalace(r + dr, c + dc, turn)) tryStep(r + dr, c + dc);
        break;
      case 'a':
        for (const [dr, dc] of DIAGONAL) if (inPalace(r + dr, c + dc, turn)) tryStep(r + dr, c + dc);
        break;
      case 'b':
        // Two squares diagonally, never across the river, and not if the square between (the "eye") is taken.
        for (const [dr, dc] of DIAGONAL) {
          const rr = r + 2 * dr;
          const cc = c + 2 * dc;
          if (inside(rr, cc) && ownSide(rr, turn) && !board[(r + dr) * COLS + c + dc]) tryStep(rr, cc);
        }
        break;
      case 'n':
        for (const [[lr, lc], [dr, dc]] of HORSE) if (inside(r + dr, c + dc) && !board[(r + lr) * COLS + c + lc]) tryStep(r + dr, c + dc);
        break;
      case 'r':
      case 'c': {
        const cannon = typeOf(piece) === 'c';
        for (const [dr, dc] of ORTHOGONAL) {
          let rr = r + dr;
          let cc = c + dc;
          let jumped = false;
          while (inside(rr, cc)) {
            const target = board[rr * COLS + cc];
            if (!jumped) {
              if (!target) moves.push({ from, to: rr * COLS + cc, piece, captured: null });
              else if (cannon) jumped = true; // a cannon needs exactly one piece to fire over
              else {
                if (colorOf(target) !== turn) moves.push({ from, to: rr * COLS + cc, piece, captured: target });
                break;
              }
            } else if (target) {
              if (colorOf(target) !== turn) moves.push({ from, to: rr * COLS + cc, piece, captured: target });
              break;
            }
            rr += dr;
            cc += dc;
          }
        }
        break;
      }
      case 'p':
        tryStep(r + forwardOf(turn), c);
        // Across the river a soldier may also step sideways. It never moves backwards.
        if (!ownSide(r, turn)) {
          tryStep(r, c - 1);
          tryStep(r, c + 1);
        }
        break;
    }
  }
  return moves;
}

export const generalSquare = (board: (Piece | null)[], color: Color) => board.indexOf(color === 'r' ? 'K' : 'k');

/**
 * Is `color`'s general attacked? Looks outward from the general rather than generating every enemy
 * move: chariots, cannons and the facing general along the lines, horses by their legs, soldiers
 * beside and in front. (Advisors and elephants can never reach the enemy palace.)
 */
export function inCheck(board: (Piece | null)[], color: Color): boolean {
  const sq = generalSquare(board, color);
  if (sq < 0) return true;
  const r = rowOf(sq);
  const c = colOf(sq);
  const enemy = opposite(color);
  const is = (p: Piece | null, type: PieceType) => p !== null && colorOf(p) === enemy && typeOf(p) === type;

  for (const [dr, dc] of ORTHOGONAL) {
    let rr = r + dr;
    let cc = c + dc;
    let screens = 0;
    while (inside(rr, cc)) {
      const p = board[rr * COLS + cc];
      if (p) {
        // The two generals may never face each other on an open file ("flying general").
        if (screens === 0 && (is(p, 'r') || (dc === 0 && is(p, 'k')))) return true;
        if (screens === 1 && is(p, 'c')) return true;
        screens += 1;
        if (screens === 2) break;
      }
      rr += dr;
      cc += dc;
    }
  }
  for (const [[lr, lc], [dr, dc]] of HORSE) {
    // A horse standing at (r - dr, c - dc) would arrive here by the step (dr, dc); its leg is next to it.
    const hr = r - dr;
    const hc = c - dc;
    if (inside(hr, hc) && is(board[hr * COLS + hc], 'n') && !board[(hr + lr) * COLS + hc + lc]) return true;
  }
  // An enemy soldier attacks the square in front of it, so it stands one step "behind" from its own view.
  const behind = r - forwardOf(enemy);
  if (inside(behind, c) && is(board[behind * COLS + c], 'p')) return true;
  // Any soldier this deep in enemy territory has crossed the river, so it also attacks sideways.
  for (const dc of [-1, 1]) if (inside(r, c + dc) && is(board[r * COLS + c + dc], 'p')) return true;
  return false;
}

/** Plays a move and returns the new state. Pure; the move must come from this position. */
export function makeMove(s: XiangqiState, m: Move): XiangqiState {
  const board = s.board.slice();
  board[m.from] = null;
  board[m.to] = m.piece;
  return { board, turn: opposite(s.turn), quiet: m.captured ? 0 : s.quiet + 1, fullmove: s.fullmove + (s.turn === 'b' ? 1 : 0) };
}

export function legalMoves(s: XiangqiState): Move[] {
  return pseudoMoves(s.board, s.turn).filter((m) => !inCheck(makeMove(s, m).board, s.turn));
}

/** Counts the positions reachable in exactly `depth` plies: the standard test of a move generator. */
export function perft(s: XiangqiState, depth: number): number {
  if (depth === 0) return 1;
  const moves = legalMoves(s);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const m of moves) nodes += perft(makeMove(s, m), depth - 1);
  return nodes;
}

/** Plies without a capture after which the game is a draw (the usual 60-move rule). */
export const QUIET_LIMIT = 120;

export type Outcome = { kind: 'checkmate' | 'stalemate'; winner: Color } | { kind: 'quiet' } | null;

/** A side with no legal move loses, whether or not it is in check: there is no stalemate draw in xiangqi. */
export function outcome(s: XiangqiState, moves: Move[] = legalMoves(s)): Outcome {
  if (moves.length === 0) return { kind: inCheck(s.board, s.turn) ? 'checkmate' : 'stalemate', winner: opposite(s.turn) };
  if (s.quiet >= QUIET_LIMIT) return { kind: 'quiet' };
  return null;
}

// ---- Notation -------------------------------------------------------------------------------------

export const PIECE_CHAR: Record<Piece, string> = {
  K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵',
  k: '将', a: '士', b: '象', n: '马', r: '车', c: '炮', p: '卒',
};
const RED_DIGITS = '一二三四五六七八九';

/** Files are numbered 1 to 9 from each player's own right; Red writes them in Chinese numerals. */
const fileLabel = (col: number, color: Color) => (color === 'r' ? RED_DIGITS[COLS - 1 - col] : String(col + 1));
const countLabel = (n: number, color: Color) => (color === 'r' ? RED_DIGITS[n - 1] : String(n));

/** The points one file holds of one piece, front (nearest the enemy) first. */
function fileStack(board: (Piece | null)[], piece: Piece, col: number): number[] {
  const stack: number[] = [];
  for (let r = 0; r < ROWS; r++) if (board[r * COLS + col] === piece) stack.push(r * COLS + col);
  return colorOf(piece) === 'r' ? stack : stack.reverse();
}

/** 前/中/后 for two or three of a kind on one file, 一二三四五 from the front for more. */
const stackLabel = (index: number, count: number, color: Color) =>
  count > 3 ? countLabel(index + 1, color) : index === 0 ? '前' : index === count - 1 ? '后' : '中';

/**
 * 前/后 cannot tell apart soldiers stacked on two different files, so once that happens every
 * soldier on a stacked file is numbered instead: from the mover's own right, and front to back.
 */
function soldierOrder(board: (Piece | null)[], piece: Piece): number[] {
  const cols: number[] = [];
  for (let c = 0; c < COLS; c++) if (fileStack(board, piece, c).length > 1) cols.push(c);
  if (cols.length < 2) return [];
  if (colorOf(piece) === 'r') cols.reverse(); // Red counts its files from column 8
  return cols.flatMap((c) => fileStack(board, piece, c));
}

/**
 * Traditional notation, e.g. 炮二平五, 马8进7, 前车退一, 三兵平四: the piece, the file it stands on
 * (or which of several identical pieces it is), 进/退/平, and then the destination file, or the
 * number of steps for a piece moving straight along its file.
 */
export function toChinese(s: XiangqiState, m: Move): string {
  const color = colorOf(m.piece);
  const type = typeOf(m.piece);
  const fromCol = colOf(m.from);
  const advance = (rowOf(m.from) - rowOf(m.to)) * (color === 'r' ? 1 : -1); // ranks gained towards the enemy

  let subject = PIECE_CHAR[m.piece] + fileLabel(fromCol, color);
  // An advisor and an elephant never need telling apart: 进 and 退 already do it.
  if (type !== 'a' && type !== 'b') {
    const numbered = type === 'p' ? soldierOrder(s.board, m.piece) : [];
    const index = numbered.indexOf(m.from);
    const stack = index < 0 ? fileStack(s.board, m.piece, fromCol) : [];
    if (index >= 0) subject = countLabel(index + 1, color) + PIECE_CHAR[m.piece];
    else if (stack.length > 1) subject = stackLabel(stack.indexOf(m.from), stack.length, color) + PIECE_CHAR[m.piece];
  }

  if (advance === 0) return `${subject}平${fileLabel(colOf(m.to), color)}`;
  const straight = type === 'r' || type === 'c' || type === 'p' || type === 'k';
  return `${subject}${advance > 0 ? '进' : '退'}${straight ? countLabel(Math.abs(advance), color) : fileLabel(colOf(m.to), color)}`;
}

// ---- Evaluation and the classic bot ---------------------------------------------------------------

export const VALUE: Record<PieceType, number> = { k: 0, a: 200, b: 200, n: 400, r: 900, c: 450, p: 100 };

/** A soldier is worth twice as much once it has crossed the river and can move sideways. */
function pieceValue(p: Piece, row: number): number {
  const type = typeOf(p);
  if (type !== 'p') return VALUE[type];
  return ownSide(row, colorOf(p)) ? 100 : 200;
}

/**
 * Piece-square tables in hundredths of a soldier, row by row from a piece's own back rank (advance
 * 0) to the enemy's (advance 9). Columns are symmetric, so one table serves both colours. They say
 * the ordinary things: soldiers are worth pushing once across, horses want the middle and hate the
 * edge, chariots want out of the corner, cannons want the back two ranks early and the centre file.
 */
const PST: Partial<Record<PieceType, number[][]>> = {
  p: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [6, 8, 12, 18, 22, 18, 12, 8, 6],
    [12, 16, 22, 30, 36, 30, 22, 16, 12],
    [18, 24, 32, 42, 48, 42, 32, 24, 18],
    [20, 28, 38, 50, 56, 50, 38, 28, 20],
    [18, 24, 32, 42, 46, 42, 32, 24, 18],
  ],
  n: [
    [-4, 0, 2, 2, 2, 2, 2, 0, -4],
    [0, 4, 8, 8, 6, 8, 8, 4, 0],
    [2, 8, 12, 14, 14, 14, 12, 8, 2],
    [4, 10, 16, 18, 20, 18, 16, 10, 4],
    [4, 12, 18, 22, 24, 22, 18, 12, 4],
    [4, 12, 18, 22, 24, 22, 18, 12, 4],
    [2, 10, 16, 20, 22, 20, 16, 10, 2],
    [0, 6, 12, 16, 18, 16, 12, 6, 0],
    [-2, 2, 6, 8, 10, 8, 6, 2, -2],
    [-4, 0, 2, 4, 4, 4, 2, 0, -4],
  ],
  c: [
    [2, 4, 4, 6, 8, 6, 4, 4, 2],
    [2, 4, 4, 6, 8, 6, 4, 4, 2],
    [2, 4, 6, 8, 10, 8, 6, 4, 2],
    [0, 2, 4, 6, 8, 6, 4, 2, 0],
    [0, 2, 4, 6, 8, 6, 4, 2, 0],
    [-2, 0, 2, 4, 6, 4, 2, 0, -2],
    [-2, 0, 2, 4, 6, 4, 2, 0, -2],
    [-2, 0, 2, 4, 4, 4, 2, 0, -2],
    [-4, -2, 0, 2, 2, 2, 0, -2, -4],
    [-4, -2, 0, 2, 2, 2, 0, -2, -4],
  ],
  r: [
    [0, 2, 4, 8, 8, 8, 4, 2, 0],
    [4, 8, 8, 12, 12, 12, 8, 8, 4],
    [4, 8, 8, 12, 14, 12, 8, 8, 4],
    [6, 10, 10, 14, 16, 14, 10, 10, 6],
    [6, 10, 10, 14, 16, 14, 10, 10, 6],
    [8, 12, 12, 16, 18, 16, 12, 12, 8],
    [8, 12, 12, 16, 18, 16, 12, 12, 8],
    [8, 12, 12, 16, 18, 16, 12, 12, 8],
    [6, 10, 10, 14, 16, 14, 10, 10, 6],
    [4, 8, 8, 12, 12, 12, 8, 8, 4],
  ],
};

/** Static evaluation in hundredths of a soldier, from Red's point of view. */
export function evaluate(s: XiangqiState): number {
  let score = 0;
  for (let sq = 0; sq < SQUARES; sq++) {
    const p = s.board[sq];
    if (!p) continue;
    const red = colorOf(p) === 'r';
    const advance = red ? ROWS - 1 - rowOf(sq) : rowOf(sq); // ranks gained from its own back rank
    const value = pieceValue(p, rowOf(sq)) + (PST[typeOf(p)]?.[advance][colOf(sq)] ?? 0);
    score += red ? value : -value;
  }
  return score;
}

/**
 * Material only, in soldiers, from Red's point of view: shown beside the board and used to
 * adjudicate at the move limit, so nothing but a capture may move it. A soldier across the river is
 * worth more to play with (see `pieceValue`), but that is position, not material.
 */
export function materialBalance(board: (Piece | null)[]): number {
  let score = 0;
  for (let sq = 0; sq < SQUARES; sq++) {
    const p = board[sq];
    if (p) score += (colorOf(p) === 'r' ? 1 : -1) * VALUE[typeOf(p)];
  }
  return Math.round(score / 50) / 2;
}

const MATE = 100_000;
/** How long the bot thinks about one move. Short enough that the page stays answerable. */
export const SEARCH_MS = 200;
const QUIESCE_DEPTH = 4;
/** Entries kept in the transposition table before it is dropped and refilled. */
const TABLE_LIMIT = 300_000;

interface TableEntry {
  depth: number;
  score: number;
  /** `lower` and `upper` are scores a cutoff only bounded, so they are only good enough one way. */
  flag: 'exact' | 'lower' | 'upper';
  move: Move | null;
}

/** Everything one search carries along: its budget, what it has learnt, and where it has been. */
interface Search {
  deadline: number;
  nodes: number;
  stopped: boolean;
  table: Map<string, TableEntry>;
  /** Two quiet moves per ply that caused a cutoff there before. */
  killers: (Move | null)[][];
  /** How often a from-to pair has caused a cutoff anywhere, as a last ordering resort. */
  history: Int32Array;
  /** How often each position has been reached, in the game already and on the way to this node. */
  seen: Map<string, number>;
}

const sameMove = (a: Move | null | undefined, b: Move | null | undefined) => !!a && !!b && a.from === b.from && a.to === b.to;
const enter = (ctx: Search, key: string) => ctx.seen.set(key, (ctx.seen.get(key) ?? 0) + 1);
const leave = (ctx: Search, key: string) => ctx.seen.set(key, (ctx.seen.get(key) ?? 1) - 1);
/** The third time in one position is a draw, so a search that reaches it a third time scores 0. */
const repeated = (ctx: Search, key: string) => (ctx.seen.get(key) ?? 0) >= 2;

/** The clock is read every thousandth node: often enough to stop on time, rarely enough to be free. */
function outOfTime(ctx: Search): boolean {
  if (!ctx.stopped && (ctx.nodes & 1023) === 0 && performance.now() >= ctx.deadline) ctx.stopped = true;
  return ctx.stopped;
}

/** Best first: the move the table remembers, then captures by what they win, then killers, then history. */
function ordered(moves: Move[], ctx: Search, ply: number, first: Move | null): Move[] {
  const killers = ctx.killers[ply];
  const score = (m: Move) =>
    sameMove(m, first)
      ? 1e9
      : m.captured
        ? 1e6 + 10 * VALUE[typeOf(m.captured)] - VALUE[typeOf(m.piece)]
        : sameMove(m, killers?.[0])
          ? 9e5
          : sameMove(m, killers?.[1])
            ? 8e5
            : ctx.history[m.from * SQUARES + m.to];
  return moves
    .map((m) => ({ m, s: score(m) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
}

/**
 * Captures only, until the position is quiet, so the search does not stop in the middle of an
 * exchange. While in check there is nothing quiet about the position: every reply is searched, and
 * standing pat is not allowed.
 */
function quiesce(s: XiangqiState, alpha: number, beta: number, depth: number, ply: number, ctx: Search): number {
  ctx.nodes += 1;
  if (outOfTime(ctx)) return evaluate(s) * (s.turn === 'r' ? 1 : -1);
  const checked = inCheck(s.board, s.turn);
  let moves: Move[];
  let best: number;
  if (checked) {
    moves = legalMoves(s);
    if (moves.length === 0) return -MATE + ply;
    if (depth === 0) return evaluate(s) * (s.turn === 'r' ? 1 : -1);
    best = -Infinity;
  } else {
    best = evaluate(s) * (s.turn === 'r' ? 1 : -1);
    if (depth === 0 || best >= beta) return best;
    moves = legalMoves(s).filter((m) => m.captured);
    if (best > alpha) alpha = best;
  }
  for (const m of ordered(moves, ctx, ply, null)) {
    const score = -quiesce(makeMove(s, m), -beta, -alpha, depth - 1, ply + 1, ctx);
    if (score > best) best = score;
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return best;
}

function negamax(s: XiangqiState, depth: number, alpha: number, beta: number, ply: number, ctx: Search): number {
  ctx.nodes += 1;
  const key = positionKey(s);
  if (repeated(ctx, key)) return 0;
  if (s.quiet >= QUIET_LIMIT) return 0;
  const moves = legalMoves(s);
  if (moves.length === 0) return -MATE + ply; // no move loses, in check or not
  if (depth <= 0) return quiesce(s, alpha, beta, QUIESCE_DEPTH, ply, ctx);

  // A mate is stored as "so many plies from here", so it keeps its meaning wherever it is read back.
  const fromTable = (score: number) => (score > MATE - 1000 ? score - ply : score < -MATE + 1000 ? score + ply : score);
  const forTable = (score: number) => (score > MATE - 1000 ? score + ply : score < -MATE + 1000 ? score - ply : score);
  const entry = ctx.table.get(key);
  if (entry && entry.depth >= depth) {
    const score = fromTable(entry.score);
    if (entry.flag === 'exact') return score;
    if (entry.flag === 'lower' && score >= beta) return score;
    if (entry.flag === 'upper' && score <= alpha) return score;
  }

  const window = alpha;
  let best = -Infinity;
  let bestMove: Move | null = null;
  enter(ctx, key);
  for (const m of ordered(moves, ctx, ply, entry?.move ?? null)) {
    const score = -negamax(makeMove(s, m), depth - 1, -beta, -alpha, ply + 1, ctx);
    if (outOfTime(ctx)) break;
    if (score > best) {
      best = score;
      bestMove = m;
    }
    if (score > alpha) alpha = score;
    if (alpha >= beta) {
      // A quiet move good enough to cut off here is worth trying first in its neighbours.
      if (!m.captured) {
        const killers = (ctx.killers[ply] ??= [null, null]);
        if (!sameMove(killers[0], m)) killers[1] = killers[0];
        killers[0] = m;
        ctx.history[m.from * SQUARES + m.to] += depth * depth;
      }
      break;
    }
  }
  leave(ctx, key);
  if (!ctx.stopped) {
    if (ctx.table.size > TABLE_LIMIT) ctx.table.clear();
    ctx.table.set(key, { depth, score: forTable(best), flag: best <= window ? 'upper' : best >= beta ? 'lower' : 'exact', move: bestMove });
  }
  return best;
}

/**
 * One full-width pass over the root moves. Every move after the first is searched against the best
 * score so far minus one, so worse moves are cut off early but moves that tie are still seen — the
 * bot picks at random among equals, and a game between two bots is not the same game every time.
 */
function searchRoot(s: XiangqiState, moves: Move[], depth: number, ctx: Search, first: Move | null): { moves: Move[]; score: number } {
  let best: Move[] = [];
  let bestScore = -Infinity;
  for (const m of ordered(moves, ctx, 0, first)) {
    const score = -negamax(makeMove(s, m), depth - 1, -MATE, best.length ? -(bestScore - 1) : MATE, 1, ctx);
    if (outOfTime(ctx)) break;
    if (score > bestScore) {
      bestScore = score;
      best = [m];
    } else if (score === bestScore) best.push(m);
  }
  return { moves: best, score: bestScore };
}

export interface BotOptions {
  /** Milliseconds the search may take. It always finishes the depth it is on before stopping. */
  budgetMs?: number;
  maxDepth?: number;
  /** How often each position has been reached in the game, so the search knows what a repeat costs. */
  seen?: ReadonlyMap<string, number>;
  /** Breaks ties between equally good moves, and picks from the opening book. */
  random?: () => number;
}

/**
 * The classic bot: an opening book for the first few moves, then alpha-beta deepened one ply at a
 * time until the budget runs out, with captures searched on past the last ply until quiet.
 */
export function botMove(s: XiangqiState, options: BotOptions = {}): Move {
  const { budgetMs = SEARCH_MS, maxDepth = 24, seen, random = Math.random } = options;
  const moves = legalMoves(s);
  const book = openingBook().get(positionKey(s));
  if (book) {
    const known = moves.filter((m) => book.includes(moveId(m)));
    if (known.length) return known[Math.floor(random() * known.length)];
  }
  const ctx: Search = {
    deadline: performance.now() + budgetMs,
    nodes: 0,
    stopped: false,
    table: new Map(),
    killers: [],
    history: new Int32Array(SQUARES * SQUARES),
    seen: new Map(seen ?? []),
  };
  let best = [moves[0]];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const pass = searchRoot(s, moves, depth, ctx, best[0]);
    // A pass cut short by the clock saw only some of the moves, so the last full one stands.
    if (ctx.stopped || pass.moves.length === 0) break;
    best = pass.moves;
    if (Math.abs(pass.score) > MATE - 1000) break; // a forced mate: nothing deeper to find
  }
  return best[Math.floor(random() * best.length)];
}

/**
 * A few standard openings by their move ids, so two bots do not open the same way every game and a
 * model is not left alone with 44 equally dull-looking first moves. Each line stops being followed
 * the moment the other side leaves it.
 */
const OPENING_LINES: string[][] = [
  ['h2e2', 'h9g7', 'b0c2', 'b9c7', 'a0b0', 'i9h9'], // 中炮对屏风马
  ['h2e2', 'h9g7', 'b0c2', 'b7d7'], // 中炮对反宫马
  ['h2e2', 'h7e7', 'b0c2', 'b9c7'], // 顺炮
  ['h2e2', 'b7e7', 'b0c2', 'h9g7'], // 列炮
  ['c3c4', 'g6g5', 'b0c2', 'b9c7'], // 仙人指路
  ['c3c4', 'h7g7', 'b0c2', 'g6g5'],
  ['b0c2', 'h9g7', 'c3c4', 'g6g5'], // 起马局
  ['g0e2', 'h9g7', 'b0c2', 'b9c7'], // 飞相局
  ['g0e2', 'b7e7', 'b0c2', 'h9g7'],
];

let book: Map<string, string[]> | null = null;

/** The book as a position to the moves played from it. Built once, the first time the bot opens. */
export function openingBook(): Map<string, string[]> {
  if (book) return book;
  book = new Map();
  for (const line of OPENING_LINES) {
    let s = startState();
    for (const id of line) {
      const move = legalMoves(s).find((m) => moveId(m) === id);
      if (!move) break; // a line with a typo in it simply stops there
      const key = positionKey(s);
      const at = book.get(key) ?? [];
      if (!at.includes(id)) at.push(id);
      book.set(key, at);
      s = makeMove(s, move);
    }
  }
  return book;
}

// ---- Facts about each move ------------------------------------------------------------------------

export interface MoveFacts {
  move: Move;
  id: string;
  /** Traditional notation, e.g. 炮二平五. */
  notation: string;
  check: boolean;
  /** The opponent has no legal reply: the game is won. */
  wins: boolean;
  /** Points the opponent wins with its best capture in reply, after every recapture (0 = nothing hangs). */
  risk: number;
  riskNotation: string | null;
  /** Points the moved piece was losing where it stood, when the move takes it out of danger. */
  escapes: number;
  /** Points the moved piece threatens to win on the move after this one. */
  threatens: number;
  /** Enemy pieces that can legally take the moved piece where it landed, and own pieces that hold the point. */
  attackers: number;
  defenders: number;
  /** How often the position after the move has been reached before: 2 means this move draws. */
  repeats: number;
  /** Plies without a capture after this move; QUIET_LIMIT of them is a draw. */
  quiet: number;
  /** Static evaluation after the move, in soldiers, from the mover's point of view. */
  evalAfter: number;
}

const points = (p: Piece | null, row: number) => (p ? pieceValue(p, row) / 100 : 0);
const round = (n: number) => Math.round(n * 10) / 10;
/** What a capture wins, in soldiers, on the scale every other number here uses. */
export const capturePoints = (m: Move) => points(m.captured, rowOf(m.to));

/** The captures the side to move may legally play onto one point. */
function capturesOn(s: XiangqiState, sq: number): Move[] {
  return pseudoMoves(s.board, s.turn).filter((m) => m.to === sq && m.captured && !inCheck(makeMove(s, m).board, s.turn));
}

/**
 * What the side to move wins by starting an exchange on one point, in soldiers: the piece standing
 * there, less what taking it back is worth to the other side, down the whole sequence. Only legal
 * recaptures count, so a defender that is pinned, or one whose general would be exposed by taking
 * back, does not make a piece safe. Either side stops as soon as carrying on loses.
 */
export function exchangeValue(s: XiangqiState, sq: number): number {
  let best = 0;
  for (const m of capturesOn(s, sq)) {
    const gain = points(m.captured, rowOf(sq)) - exchangeValue(makeMove(s, m), sq);
    if (gain > best) best = gain;
  }
  return best;
}

/**
 * For every legal move: what it takes, whether it checks or wins, what the opponent can win in
 * reply, what the move saves and what it threatens. The exchanges are exact; nothing here is a
 * search, so it catches hanging pieces and simple threats, not tactics.
 */
export function analyze(s: XiangqiState, legal: Move[] = legalMoves(s), seen?: ReadonlyMap<string, number>): MoveFacts[] {
  // The same position with the opponent to move: what each of our pieces is losing where it stands.
  const waiting: XiangqiState = { ...s, turn: opposite(s.turn) };
  const exposed = new Map<number, number>();
  const losing = (sq: number) => {
    if (!exposed.has(sq)) exposed.set(sq, exchangeValue(waiting, sq));
    return exposed.get(sq)!;
  };

  return legal.map((move): MoveFacts => {
    const after = makeMove(s, move);
    const replies = legalMoves(after);
    let risk = 0;
    let riskMove: Move | null = null;
    for (const reply of replies) {
      if (!reply.captured) continue;
      const gain = points(reply.captured, rowOf(reply.to)) - exchangeValue(makeMove(after, reply), reply.to);
      if (gain > risk) {
        risk = gain;
        riskMove = reply;
      }
    }

    // What the piece would win if it could move again, and how the point it landed on is held.
    const again: XiangqiState = { ...after, turn: s.turn };
    let threatens = 0;
    for (const next of pseudoMoves(again.board, s.turn)) {
      if (next.from !== move.to || !next.captured || inCheck(makeMove(again, next).board, s.turn)) continue;
      const gain = points(next.captured, rowOf(next.to)) - exchangeValue(makeMove(again, next), next.to);
      if (gain > threatens) threatens = gain;
    }
    // Defenders are counted by asking who could take an enemy piece standing where this one does.
    const probe = after.board.slice();
    probe[move.to] = (s.turn === 'r' ? 'p' : 'P') as Piece;

    return {
      move,
      id: moveId(move),
      notation: toChinese(s, move),
      check: inCheck(after.board, after.turn),
      wins: replies.length === 0,
      risk: round(risk),
      riskNotation: riskMove ? toChinese(after, riskMove) : null,
      escapes: losing(move.from) > risk ? round(losing(move.from)) : 0,
      threatens: round(threatens),
      attackers: capturesOn(after, move.to).length,
      defenders: capturesOn({ ...again, board: probe }, move.to).length,
      repeats: seen?.get(positionKey(after)) ?? 0,
      quiet: after.quiet,
      evalAfter: Math.round(evaluate(after) * (s.turn === 'r' ? 1 : -1)) / 100,
    };
  });
}

export const PIECE_NAME: Record<PieceType, string> = { k: 'general', a: 'advisor', b: 'elephant', n: 'horse', r: 'chariot', c: 'cannon', p: 'soldier' };

/** Same field names on every option so a model can compare them directly. */
export function describeMove(f: MoveFacts): Record<string, string> {
  const { move } = f;
  const color = colorOf(move.piece);
  const notes: string[] = [];
  if (typeOf(move.piece) === 'p' && ownSide(rowOf(move.from), color) && !ownSide(rowOf(move.to), color)) notes.push('soldier crosses the river: it can now also move sideways');
  if (typeOf(move.piece) === 'c' && colOf(move.to) === 4 && ownSide(rowOf(move.to), color)) notes.push('central cannon: aims down the middle file at the enemy general');
  if ((typeOf(move.piece) === 'n' || typeOf(move.piece) === 'r') && rowOf(move.from) === (color === 'r' ? 9 : 0)) notes.push('develops a piece off the back rank');
  return {
    move: `${f.notation}: ${PIECE_NAME[typeOf(move.piece)]} ${squareName(move.from)} to ${squareName(move.to)}`,
    captures: move.captured ? `a ${PIECE_NAME[typeOf(move.captured)]} (${capturePoints(move)} points)` : 'nothing',
    check: f.wins ? 'WINS THE GAME: the opponent has no legal reply' : f.check ? 'gives check' : 'no',
    opponent_can_win_next: f.wins ? 'nothing' : f.risk > 0 ? `${f.risk} points with ${f.riskNotation}` : 'nothing',
    saves: f.escapes > 0 ? `${f.escapes} points: this piece was under attack where it stood` : 'nothing',
    threatens_next: f.threatens > 0 ? `${f.threatens} points with this piece on the move after` : 'nothing',
    lands_on: `${f.attackers} enemy pieces can take it there, ${f.defenders} of yours hold the point`,
    repetition: f.repeats >= 2 ? 'DRAW: this position for the third time' : f.repeats === 1 ? 'a position already seen once' : 'no',
    notes: notes.join('; ') || 'none',
  };
}

/** The board as text, Black's side at the top, with coordinates and the river marked. */
export function boardToText(s: XiangqiState): string[] {
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    rows.push(`${ROWS - 1 - r} ${s.board.slice(r * COLS, r * COLS + COLS).map((p) => p ?? '.').join(' ')}`);
    if (r === 4) rows.push('  ~ ~ ~ river ~ ~ ~');
  }
  rows.push('  a b c d e f g h i');
  return rows;
}
