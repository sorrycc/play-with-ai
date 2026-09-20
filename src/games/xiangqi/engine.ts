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

/**
 * Traditional notation, e.g. 炮二平五, 马8进7, 前车退一: the piece, the file it stands on (or 前/中/后
 * when two or more of the same piece share a file), 进/退/平, and then the destination file, or the
 * number of steps for a piece moving straight along its file.
 */
export function toChinese(s: XiangqiState, m: Move): string {
  const color = colorOf(m.piece);
  const type = typeOf(m.piece);
  const fromRow = rowOf(m.from);
  const fromCol = colOf(m.from);
  const toRow = rowOf(m.to);
  const advance = (fromRow - toRow) * (color === 'r' ? 1 : -1); // ranks gained towards the enemy

  const sameFile: number[] = [];
  for (let r = 0; r < ROWS; r++) if (s.board[r * COLS + fromCol] === m.piece) sameFile.push(r);
  let subject = PIECE_CHAR[m.piece] + fileLabel(fromCol, color);
  if (sameFile.length > 1 && type !== 'a' && type !== 'b') {
    // Front means nearer the enemy: the smallest row for Red, the largest for Black.
    const ordered = color === 'r' ? sameFile : [...sameFile].reverse();
    const index = ordered.indexOf(fromRow);
    const where = index === 0 ? '前' : index === ordered.length - 1 ? '后' : '中';
    subject = where + PIECE_CHAR[m.piece];
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

const CENTRE_COL = [0, 4, 8, 12, 16, 12, 8, 4, 0];
function squareBonus(type: PieceType, row: number, col: number): number {
  const advance = ROWS - 1 - row; // ranks from Red's back rank
  switch (type) {
    case 'p':
      return advance >= 5 ? (advance - 4) * 8 + CENTRE_COL[col] : 0;
    case 'n':
      return CENTRE_COL[col] + (advance >= 2 && advance <= 7 ? 12 : -8);
    case 'c':
      return CENTRE_COL[col] / 2 + (advance <= 2 ? 6 : 0);
    case 'r':
      return advance >= 1 ? 8 : 0; // off the back rank, into play
    default:
      return 0;
  }
}

/** Static evaluation in hundredths of a soldier, from Red's point of view. */
export function evaluate(s: XiangqiState): number {
  let score = 0;
  for (let sq = 0; sq < SQUARES; sq++) {
    const p = s.board[sq];
    if (!p) continue;
    const red = colorOf(p) === 'r';
    const row = red ? rowOf(sq) : ROWS - 1 - rowOf(sq);
    const value = pieceValue(p, rowOf(sq)) + squareBonus(typeOf(p), row, colOf(sq));
    score += red ? value : -value;
  }
  return score;
}

/** Material only, in soldiers, from Red's point of view: shown beside the board. */
export function materialBalance(board: (Piece | null)[]): number {
  let score = 0;
  for (let sq = 0; sq < SQUARES; sq++) {
    const p = board[sq];
    if (p) score += (colorOf(p) === 'r' ? 1 : -1) * pieceValue(p, rowOf(sq));
  }
  return Math.round(score / 50) / 2;
}

const MATE = 100_000;
const orderScore = (m: Move) => (m.captured ? 10 * VALUE[typeOf(m.captured)] - VALUE[typeOf(m.piece)] : 0);

/** Captures only, until the position is quiet, so the search does not stop in the middle of an exchange. */
function quiesce(s: XiangqiState, alpha: number, beta: number, depth: number): number {
  const stand = evaluate(s) * (s.turn === 'r' ? 1 : -1);
  if (depth === 0 || stand >= beta) return stand;
  alpha = Math.max(alpha, stand);
  const captures = legalMoves(s).filter((m) => m.captured).sort((a, b) => orderScore(b) - orderScore(a));
  for (const m of captures) {
    const score = -quiesce(makeMove(s, m), -beta, -alpha, depth - 1);
    if (score >= beta) return score;
    alpha = Math.max(alpha, score);
  }
  return alpha;
}

function negamax(s: XiangqiState, depth: number, alpha: number, beta: number, ply: number): number {
  const moves = legalMoves(s);
  if (moves.length === 0) return -MATE + ply; // no move loses, in check or not
  if (s.quiet >= QUIET_LIMIT) return 0;
  if (depth === 0) return quiesce(s, alpha, beta, 3);
  moves.sort((a, b) => orderScore(b) - orderScore(a));
  for (const m of moves) {
    const score = -negamax(makeMove(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (score >= beta) return score;
    alpha = Math.max(alpha, score);
  }
  return alpha;
}

/** The classic bot: alpha-beta to `depth` plies, then captures until quiet. `random` breaks ties. */
export function botMove(s: XiangqiState, depth = 2, random: () => number = Math.random): Move {
  const moves = legalMoves(s).sort((a, b) => orderScore(b) - orderScore(a));
  let best: Move[] = [];
  let bestScore = -Infinity;
  for (const m of moves) {
    const score = -negamax(makeMove(s, m), depth - 1, -MATE, MATE, 1);
    if (score > bestScore) {
      bestScore = score;
      best = [m];
    } else if (score === bestScore) best.push(m);
  }
  return best[Math.floor(random() * best.length)];
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
  /** Points the opponent can win with its best capture in reply (0 = nothing hangs), and that reply. */
  risk: number;
  riskNotation: string | null;
  /** Static evaluation after the move, in soldiers, from the mover's point of view. */
  evalAfter: number;
}

const points = (p: Piece | null, row: number) => (p ? pieceValue(p, row) / 100 : 0);

/**
 * For every legal move: what it takes, whether it checks or wins, and the most material the
 * opponent can then win with a single capture (the captured piece, less the capturer if the point
 * is defended). A one-move look, not a search: it catches hanging pieces, not tactics.
 */
export function analyze(s: XiangqiState, legal: Move[] = legalMoves(s)): MoveFacts[] {
  return legal.map((move): MoveFacts => {
    const after = makeMove(s, move);
    const replies = legalMoves(after);
    let risk = 0;
    let riskMove: Move | null = null;
    for (const reply of replies) {
      if (!reply.captured) continue;
      const landed = makeMove(after, reply);
      const defended = pseudoMoves(landed.board, s.turn).some((m) => m.to === reply.to);
      const gain = points(reply.captured, rowOf(reply.to)) - (defended ? points(reply.piece, rowOf(reply.from)) : 0);
      if (gain > risk) {
        risk = gain;
        riskMove = reply;
      }
    }
    return {
      move,
      id: moveId(move),
      notation: toChinese(s, move),
      check: inCheck(after.board, after.turn),
      wins: replies.length === 0,
      risk,
      riskNotation: riskMove ? toChinese(after, riskMove) : null,
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
    captures: move.captured ? `a ${PIECE_NAME[typeOf(move.captured)]} (${points(move.captured, rowOf(move.to))} points)` : 'nothing',
    check: f.wins ? 'WINS THE GAME: the opponent has no legal reply' : f.check ? 'gives check' : 'no',
    opponent_can_win_next: f.wins ? 'nothing' : f.risk > 0 ? `${f.risk} points with ${f.riskNotation}` : 'nothing',
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
