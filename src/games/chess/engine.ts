// Pure chess engine. No DOM, no network. Full rules: castling, en passant, promotion, check,
// checkmate, stalemate, the fifty-move rule and insufficient material (threefold repetition is
// counted by the match, which holds the history). Verified by perft in tests/chess.test.ts.
//
// Squares are 0..63, row by row as the board is drawn for white: 0 = a8, 7 = h8, 56 = a1, 63 = h1.
// Pieces are FEN letters: upper case white, lower case black.

export type Color = 'w' | 'b';
export type Piece = 'P' | 'N' | 'B' | 'R' | 'Q' | 'K' | 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Promotion = 'q' | 'r' | 'b' | 'n';

export interface ChessState {
  board: (Piece | null)[];
  turn: Color;
  castling: { K: boolean; Q: boolean; k: boolean; q: boolean };
  /** The square a pawn just skipped over, where it can be captured en passant. */
  ep: number | null;
  /** Plies since the last capture or pawn move, for the fifty-move rule. */
  halfmove: number;
  fullmove: number;
}

export interface Move {
  from: number;
  to: number;
  piece: Piece;
  captured: Piece | null;
  promotion: Promotion | null;
  flag: 'ep' | 'castleK' | 'castleQ' | 'double' | null;
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FILES = 'abcdefgh';

export const rowOf = (sq: number) => sq >> 3;
export const colOf = (sq: number) => sq & 7;
export const squareName = (sq: number) => `${FILES[colOf(sq)]}${8 - rowOf(sq)}`;
export const colorOf = (p: Piece): Color => (p === p.toUpperCase() ? 'w' : 'b');
export const typeOf = (p: Piece) => p.toLowerCase() as PieceType;
export const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');

export function parseSquare(name: string): number | null {
  const m = /^([a-h])([1-8])$/.exec(name);
  return m ? (8 - Number(m[2])) * 8 + FILES.indexOf(m[1]) : null;
}

export function fromFen(fen: string): ChessState {
  const [placement, turn = 'w', castling = '-', ep = '-', halfmove = '0', fullmove = '1'] = fen.trim().split(/\s+/);
  const board: (Piece | null)[] = [];
  for (const ch of placement) {
    if (ch === '/') continue;
    if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) board.push(null);
    else board.push(ch as Piece);
  }
  return {
    board,
    turn: turn === 'b' ? 'b' : 'w',
    castling: { K: castling.includes('K'), Q: castling.includes('Q'), k: castling.includes('k'), q: castling.includes('q') },
    ep: ep === '-' ? null : parseSquare(ep),
    halfmove: Number(halfmove),
    fullmove: Number(fullmove),
  };
}

export const startState = (): ChessState => fromFen(START_FEN);

export function toFen(s: ChessState): string {
  let placement = '';
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = s.board[r * 8 + c];
      if (!p) empty += 1;
      else {
        placement += (empty || '') + p;
        empty = 0;
      }
    }
    placement += (empty || '') + (r < 7 ? '/' : '');
  }
  const c = s.castling;
  const rights = `${c.K ? 'K' : ''}${c.Q ? 'Q' : ''}${c.k ? 'k' : ''}${c.q ? 'q' : ''}` || '-';
  return `${placement} ${s.turn} ${rights} ${s.ep === null ? '-' : squareName(s.ep)} ${s.halfmove} ${s.fullmove}`;
}

/**
 * Identifies a position for repetition: placement, side to move, castling rights and the en passant
 * square — but only when a pawn may really take there. Two positions that differ solely by a square
 * nobody can use are the same position under the rules, so counting them apart would hide a draw.
 */
export function positionKey(s: ChessState): string {
  const c = s.castling;
  const ep = epCapturePossible(s) ? s.ep : '-';
  return `${s.board.map((p) => p ?? '.').join('')}${s.turn}${c.K ? 'K' : ''}${c.Q ? 'Q' : ''}${c.k ? 'k' : ''}${c.q ? 'q' : ''}${ep}`;
}

/** Is there a legal en passant capture in this position? */
export function epCapturePossible(s: ChessState): boolean {
  if (s.ep === null) return false;
  const white = s.turn === 'w';
  // The capturing pawn stands beside the square it takes on, one rank further from the target.
  const r = rowOf(s.ep) + (white ? 1 : -1);
  const c = colOf(s.ep);
  const pawn = (white ? 'P' : 'p') as Piece;
  for (const dc of [-1, 1]) {
    if (!inside(r, c + dc)) continue;
    const from = r * 8 + c + dc;
    if (s.board[from] !== pawn) continue;
    const move: Move = { from, to: s.ep, piece: pawn, captured: (white ? 'p' : 'P') as Piece, promotion: null, flag: 'ep' };
    const after = makeMove(s, move);
    if (!isAttacked(after.board, kingSquare(after.board, s.turn), after.turn)) return true;
  }
  return false;
}

const KNIGHT: [number, number][] = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING: [number, number][] = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIAGONAL: [number, number][] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const STRAIGHT: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const inside = (r: number, c: number) => r >= 0 && r < 8 && c >= 0 && c < 8;

/** Is `sq` attacked by any piece of colour `by`? */
export function isAttacked(board: (Piece | null)[], sq: number, by: Color): boolean {
  const r = rowOf(sq);
  const c = colOf(sq);
  const mine = (p: Piece | null, type: PieceType) => p !== null && colorOf(p) === by && typeOf(p) === type;
  // A white pawn attacks upwards, so it sits one row below the square it attacks.
  const pawnRow = by === 'w' ? r + 1 : r - 1;
  for (const dc of [-1, 1]) if (inside(pawnRow, c + dc) && mine(board[pawnRow * 8 + c + dc], 'p')) return true;
  for (const [dr, dc] of KNIGHT) if (inside(r + dr, c + dc) && mine(board[(r + dr) * 8 + c + dc], 'n')) return true;
  for (const [dr, dc] of KING) if (inside(r + dr, c + dc) && mine(board[(r + dr) * 8 + c + dc], 'k')) return true;
  for (const [dirs, slider] of [[DIAGONAL, 'b'], [STRAIGHT, 'r']] as const) {
    for (const [dr, dc] of dirs) {
      let rr = r + dr;
      let cc = c + dc;
      while (inside(rr, cc)) {
        const p = board[rr * 8 + cc];
        if (p) {
          if (colorOf(p) === by && (typeOf(p) === slider || typeOf(p) === 'q')) return true;
          break;
        }
        rr += dr;
        cc += dc;
      }
    }
  }
  return false;
}

export function kingSquare(board: (Piece | null)[], color: Color): number {
  return board.indexOf(color === 'w' ? 'K' : 'k');
}

export const inCheck = (s: ChessState, color: Color = s.turn): boolean => isAttacked(s.board, kingSquare(s.board, color), opposite(color));

/** Moves that obey how pieces move, without yet asking whether they leave the king in check. */
function pseudoMoves(s: ChessState): Move[] {
  const { board, turn } = s;
  const moves: Move[] = [];
  const add = (from: number, to: number, flag: Move['flag'] = null) => {
    const piece = board[from]!;
    const captured = flag === 'ep' ? ((turn === 'w' ? 'p' : 'P') as Piece) : board[to];
    if (typeOf(piece) === 'p' && (rowOf(to) === 0 || rowOf(to) === 7)) {
      for (const promotion of ['q', 'r', 'b', 'n'] as const) moves.push({ from, to, piece, captured, promotion, flag });
    } else {
      moves.push({ from, to, piece, captured, promotion: null, flag });
    }
  };

  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (!piece || colorOf(piece) !== turn) continue;
    const r = rowOf(from);
    const c = colOf(from);
    const type = typeOf(piece);

    if (type === 'p') {
      const dir = turn === 'w' ? -1 : 1;
      const startRow = turn === 'w' ? 6 : 1;
      if (inside(r + dir, c) && !board[(r + dir) * 8 + c]) {
        add(from, (r + dir) * 8 + c);
        if (r === startRow && !board[(r + 2 * dir) * 8 + c]) add(from, (r + 2 * dir) * 8 + c, 'double');
      }
      for (const dc of [-1, 1]) {
        if (!inside(r + dir, c + dc)) continue;
        const to = (r + dir) * 8 + c + dc;
        const target = board[to];
        if (target && colorOf(target) !== turn) add(from, to);
        else if (to === s.ep) add(from, to, 'ep');
      }
      continue;
    }

    const steps = type === 'n' ? KNIGHT : type === 'k' ? KING : type === 'b' ? DIAGONAL : type === 'r' ? STRAIGHT : [...DIAGONAL, ...STRAIGHT];
    const slides = type === 'b' || type === 'r' || type === 'q';
    for (const [dr, dc] of steps) {
      let rr = r + dr;
      let cc = c + dc;
      while (inside(rr, cc)) {
        const target = board[rr * 8 + cc];
        if (!target) add(from, rr * 8 + cc);
        else {
          if (colorOf(target) !== turn) add(from, rr * 8 + cc);
          break;
        }
        if (!slides) break;
        rr += dr;
        cc += dc;
      }
    }

    if (type === 'k') {
      // Castling: rights intact, the squares between empty, and the king neither in check nor
      // crossing or landing on an attacked square.
      const home = turn === 'w' ? 60 : 4;
      const enemy = opposite(turn);
      if (from === home && !isAttacked(board, home, enemy)) {
        const rook = turn === 'w' ? 'R' : 'r';
        if (s.castling[turn === 'w' ? 'K' : 'k'] && !board[home + 1] && !board[home + 2] && board[home + 3] === rook && !isAttacked(board, home + 1, enemy) && !isAttacked(board, home + 2, enemy)) {
          add(from, home + 2, 'castleK');
        }
        if (s.castling[turn === 'w' ? 'Q' : 'q'] && !board[home - 1] && !board[home - 2] && !board[home - 3] && board[home - 4] === rook && !isAttacked(board, home - 1, enemy) && !isAttacked(board, home - 2, enemy)) {
          add(from, home - 2, 'castleQ');
        }
      }
    }
  }
  return moves;
}

/** Plays a move and returns the new state. Pure; the move must come from this position. */
export function makeMove(s: ChessState, m: Move): ChessState {
  const board = s.board.slice();
  const white = s.turn === 'w';
  board[m.from] = null;
  board[m.to] = m.promotion ? ((white ? m.promotion.toUpperCase() : m.promotion) as Piece) : m.piece;
  if (m.flag === 'ep') board[m.to + (white ? 8 : -8)] = null;
  if (m.flag === 'castleK') {
    board[m.to - 1] = board[m.to + 1];
    board[m.to + 1] = null;
  }
  if (m.flag === 'castleQ') {
    board[m.to + 1] = board[m.to - 2];
    board[m.to - 2] = null;
  }

  const castling = { ...s.castling };
  // A king that moves loses both rights; a rook that leaves its corner, or is captured on it, loses one.
  if (m.piece === 'K') castling.K = castling.Q = false;
  if (m.piece === 'k') castling.k = castling.q = false;
  for (const sq of [m.from, m.to]) {
    if (sq === 63) castling.K = false;
    if (sq === 56) castling.Q = false;
    if (sq === 7) castling.k = false;
    if (sq === 0) castling.q = false;
  }

  return {
    board,
    turn: opposite(s.turn),
    castling,
    ep: m.flag === 'double' ? (m.from + m.to) / 2 : null,
    halfmove: typeOf(m.piece) === 'p' || m.captured ? 0 : s.halfmove + 1,
    fullmove: s.fullmove + (white ? 0 : 1),
  };
}

export function legalMoves(s: ChessState): Move[] {
  return pseudoMoves(s).filter((m) => {
    const after = makeMove(s, m);
    return !isAttacked(after.board, kingSquare(after.board, s.turn), after.turn);
  });
}

/** Counts the positions reachable in exactly `depth` plies: the standard test of a move generator. */
export function perft(s: ChessState, depth: number): number {
  if (depth === 0) return 1;
  const moves = legalMoves(s);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const m of moves) nodes += perft(makeMove(s, m), depth - 1);
  return nodes;
}

/** Coordinate notation, e.g. e2e4 or e7e8q: unambiguous, so it is what players are asked to pick. */
export const moveId = (m: Move): string => `${squareName(m.from)}${squareName(m.to)}${m.promotion ?? ''}`;

/**
 * A dead position: no series of legal moves can mate. Bare kings, a single knight or bishop, or
 * bishops that all stand on one colour of square — those can never cover the squares a mate needs.
 * Two knights are not here: a mate is unreachable by force but not impossible, so the rules let the
 * game go on.
 */
export function insufficientMaterial(board: (Piece | null)[]): boolean {
  let knights = 0;
  let bishops = 0;
  let squares = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (!p || typeOf(p) === 'k') continue;
    if (typeOf(p) === 'n') knights += 1;
    else if (typeOf(p) === 'b') {
      bishops += 1;
      squares |= 1 << ((rowOf(sq) + colOf(sq)) & 1);
    } else return false;
  }
  if (knights + bishops <= 1) return true;
  return knights === 0 && squares !== 0b11;
}

export type Outcome = { kind: 'checkmate'; winner: Color } | { kind: 'stalemate' | 'fifty' | 'material' } | null;

export function outcome(s: ChessState, moves: Move[] = legalMoves(s)): Outcome {
  if (moves.length === 0) return inCheck(s) ? { kind: 'checkmate', winner: opposite(s.turn) } : { kind: 'stalemate' };
  if (s.halfmove >= 100) return { kind: 'fifty' };
  if (insufficientMaterial(s.board)) return { kind: 'material' };
  return null;
}

/**
 * Standard algebraic notation, e.g. Nf3, exd5, O-O, e8=Q+, Qxf7#. `legal` are the moves of this
 * position; `played` is the position after the move and its replies, which a caller that has
 * already worked them out passes in rather than paying for them twice.
 */
export function toSan(s: ChessState, m: Move, legal: Move[] = legalMoves(s), played?: { after: ChessState; replies: Move[] }): string {
  let san: string;
  if (m.flag === 'castleK') san = 'O-O';
  else if (m.flag === 'castleQ') san = 'O-O-O';
  else {
    const type = typeOf(m.piece);
    const target = squareName(m.to);
    if (type === 'p') {
      san = (m.captured ? `${FILES[colOf(m.from)]}x` : '') + target + (m.promotion ? `=${m.promotion.toUpperCase()}` : '');
    } else {
      // Another piece of the same kind that could also go there: say which one moved.
      const rivals = legal.filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
      let which = '';
      if (rivals.length) {
        if (!rivals.some((o) => colOf(o.from) === colOf(m.from))) which = FILES[colOf(m.from)];
        else if (!rivals.some((o) => rowOf(o.from) === rowOf(m.from))) which = String(8 - rowOf(m.from));
        else which = squareName(m.from);
      }
      san = type.toUpperCase() + which + (m.captured ? 'x' : '') + target;
    }
  }
  const after = played?.after ?? makeMove(s, m);
  if (inCheck(after)) san += (played?.replies ?? legalMoves(after)).length === 0 ? '#' : '+';
  return san;
}

// ---- Evaluation and the classic bot ---------------------------------------------------------------

export const VALUE: Record<PieceType, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// How much a piece likes each square, from white's side (row 0 is the eighth rank).
const CENTRE = [0, 5, 10, 15, 15, 10, 5, 0];
function squareBonus(type: PieceType, row: number, col: number, endgame: boolean): number {
  const advance = 7 - row; // ranks advanced, for white
  switch (type) {
    case 'p':
      return advance * 6 + (col >= 2 && col <= 5 ? advance * 3 : 0) + (advance === 6 ? 40 : 0);
    case 'n':
      return CENTRE[row] + CENTRE[col] - 15;
    case 'b':
      return (CENTRE[row] + CENTRE[col]) / 2 - 5;
    case 'r':
      return advance === 6 ? 15 : col === 3 || col === 4 ? 5 : 0;
    case 'q':
      return (CENTRE[row] + CENTRE[col]) / 4;
    case 'k':
      // Tucked away behind pawns in the middlegame, active in the centre once the queens are gone.
      return endgame ? CENTRE[row] + CENTRE[col] : (row === 7 ? 15 : -20 * advance) + (col <= 2 || col >= 6 ? 20 : 0);
  }
}

/** Steps from the middle four squares, counted along the ranks and files: 0 in the centre, 6 in a corner. */
const fromCentre = (sq: number) => Math.max(3 - rowOf(sq), rowOf(sq) - 4, 0) + Math.max(3 - colOf(sq), colOf(sq) - 4, 0);
/** The same count between two squares, which has finer steps than king moves and so fewer ties. */
const between = (a: number, b: number) => Math.abs(rowOf(a) - rowOf(b)) + Math.abs(colOf(a) - colOf(b));

/** Static evaluation in centipawns, from white's point of view. */
export function evaluate(s: ChessState): number {
  let queens = 0;
  let minorsAndRooks = 0;
  // A side with nothing but its king is mated on an edge, so those endings need their own rule.
  const force = { w: 0, b: 0 };
  for (const p of s.board) {
    if (!p) continue;
    const type = typeOf(p);
    if (type !== 'k') force[colorOf(p)] += VALUE[type];
    if (type === 'q') queens += 1;
    else if (type !== 'p' && type !== 'k') minorsAndRooks += 1;
  }
  const endgame = queens === 0 || minorsAndRooks <= 2;
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = s.board[sq];
    if (!p) continue;
    const white = colorOf(p) === 'w';
    const row = white ? rowOf(sq) : 7 - rowOf(sq);
    const value = VALUE[typeOf(p)] + squareBonus(typeOf(p), row, colOf(sq), endgame);
    score += white ? value : -value;
  }
  // Against a bare king, drive it to the edge and walk the other king up: without this the search
  // shuffles a winning queen or rook about until the fifty-move rule takes the win away.
  const bare = force.w === 0 ? 'w' : force.b === 0 ? 'b' : null;
  if (bare && force[opposite(bare)] >= VALUE.r) {
    const weak = kingSquare(s.board, bare);
    const strong = kingSquare(s.board, opposite(bare));
    const drive = 20 * fromCentre(weak) + 8 * (14 - between(weak, strong));
    score += bare === 'b' ? drive : -drive;
  }
  return score;
}

/** Material only, in pawns, from white's point of view: shown beside the board. */
export function materialBalance(board: (Piece | null)[]): number {
  let score = 0;
  for (const p of board) if (p) score += (colorOf(p) === 'w' ? 1 : -1) * VALUE[typeOf(p)];
  return Math.round(score / 100);
}

const MATE = 100_000;
/** Above this a score is a forced mate, and the distance to it is what is left. */
const MATE_IN = MATE - 1000;

// ---- Zobrist keys ---------------------------------------------------------------------------------
//
// One number per position, so the search can recognise a position it has already worked out. Two
// independent 32-bit draws are packed into one double: a collision would need both to match.

const PIECES = 'PNBRQKpnbrqk';
const ZOBRIST = (() => {
  // A fixed seed, so two runs of the same search behave the same.
  let a = 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) | 0;
  };
  const table = (n: number) => Int32Array.from({ length: n }, next);
  return { pieces: table(12 * 64), turn: next(), castling: table(16), ep: table(8) };
})();

/** A cheap number that stands for a position, for the transposition table and for repetitions. */
export function searchKey(s: ChessState): number {
  let a = 0;
  let b = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = s.board[sq];
    if (!p) continue;
    const i = PIECES.indexOf(p) * 64 + sq;
    a ^= ZOBRIST.pieces[i];
    b = (Math.imul(b ^ ZOBRIST.pieces[i], 0x85ebca6b) + sq) | 0;
  }
  const c = s.castling;
  const rights = (c.K ? 1 : 0) | (c.Q ? 2 : 0) | (c.k ? 4 : 0) | (c.q ? 8 : 0);
  a ^= ZOBRIST.castling[rights];
  b ^= ZOBRIST.castling[rights];
  if (s.ep !== null) {
    a ^= ZOBRIST.ep[colOf(s.ep)];
    b ^= ZOBRIST.ep[colOf(s.ep)];
  }
  if (s.turn === 'b') {
    a ^= ZOBRIST.turn;
    b ^= ZOBRIST.turn;
  }
  return (a >>> 0) * 65536 + (b >>> 16);
}

// ---- The classic bot ------------------------------------------------------------------------------

const EXACT = 0;
const LOWER = 1;
const UPPER = 2;
interface Entry {
  depth: number;
  score: number;
  flag: typeof EXACT | typeof LOWER | typeof UPPER;
  /** The best move here, as from * 64 + to: searched first next time. */
  best: number;
}

/** What one search carries: the table, the ordering it learned, its clock and the game so far. */
const table = new Map<number, Entry>();
const history = new Int32Array(64 * 64);
let killers: Int32Array = new Int32Array(0);
let repeated = new Map<number, number>();
let deadline = 0;
let nodes = 0;
let stopped = false;

const slot = (m: Move) => m.from * 64 + m.to;

/** Captures first, then the move that cut this position off before, then whatever worked elsewhere. */
function order(moves: Move[], best: number, ply: number): void {
  const score = (m: Move) => {
    if (slot(m) === best) return 1e9;
    let v = 0;
    if (m.captured) v += 1e6 + 10 * VALUE[typeOf(m.captured)] - VALUE[typeOf(m.piece)];
    if (m.promotion) v += 1e6 + VALUE[m.promotion];
    if (v === 0) {
      if (slot(m) === killers[ply * 2] || slot(m) === killers[ply * 2 + 1]) v = 5e5;
      else v = history[slot(m)];
    }
    return v;
  };
  moves.sort((a, b) => score(b) - score(a));
}

/** Captures and promotions until the position is quiet — and, in check, every way out of it. */
function quiesce(s: ChessState, alpha: number, beta: number, depth: number, ply: number): number {
  const moves = legalMoves(s);
  const checked = inCheck(s);
  // Mate and stalemate are exact at any depth: a leaf must never score a mated king as material.
  if (moves.length === 0) return checked ? -MATE + ply : 0;
  const stand = evaluate(s) * (s.turn === 'w' ? 1 : -1);
  if (depth === 0) return stand;
  // A king under attack is not a quiet position, so standing pat there would be a lie.
  if (!checked) {
    if (stand >= beta) return stand;
    alpha = Math.max(alpha, stand);
  }
  const candidates = checked ? moves : moves.filter((m) => m.captured || m.promotion);
  if (candidates.length === 0) return stand;
  order(candidates, 0, ply);
  let best = checked ? -MATE : stand;
  for (const m of candidates) {
    const score = -quiesce(makeMove(s, m), -beta, -alpha, depth - 1, ply + 1);
    if (score > best) best = score;
    if (score >= beta) return score;
    alpha = Math.max(alpha, score);
  }
  return best;
}

function search(s: ChessState, depth: number, alpha: number, beta: number, ply: number): number {
  // Every node costs a move generation, so the clock is read often enough to stop near the budget.
  if (((nodes += 1) & 255) === 0 && performance.now() >= deadline) stopped = true;
  if (stopped) return 0;
  if (s.halfmove >= 100 || insufficientMaterial(s.board)) return 0;
  // A leaf is not hashed and generates its moves once, inside the quiescence search.
  if (depth <= 0) return quiesce(s, alpha, beta, 3, ply);

  const key = searchKey(s);
  // A position already on the board is a draw in the making: the match stops at the third time.
  if ((repeated.get(key) ?? 0) > 0) return 0;

  const start = alpha;
  const found = table.get(key);
  if (found && found.depth >= depth) {
    // A mate score means "in n plies from here", so it travels with the distance to this node.
    const score = found.score > MATE_IN ? found.score - ply : found.score < -MATE_IN ? found.score + ply : found.score;
    if (found.flag === EXACT) return score;
    if (found.flag === LOWER && score >= beta) return score;
    if (found.flag === UPPER && score <= alpha) return score;
  }

  const moves = legalMoves(s);
  if (moves.length === 0) return inCheck(s) ? -MATE + ply : 0;

  order(moves, found?.best ?? 0, ply);
  repeated.set(key, 1);
  let best = -MATE - 1;
  let bestMove = 0;
  for (const m of moves) {
    const score = -search(makeMove(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (score > best) {
      best = score;
      bestMove = slot(m);
    }
    if (score > alpha) alpha = score;
    if (alpha >= beta) {
      // A quiet move good enough to cut off is worth trying early in sister positions.
      if (!m.captured && !m.promotion) {
        if (killers[ply * 2] !== slot(m)) {
          killers[ply * 2 + 1] = killers[ply * 2];
          killers[ply * 2] = slot(m);
        }
        history[slot(m)] += depth * depth;
      }
      break;
    }
  }
  repeated.delete(key);

  if (!stopped) {
    const score = best > MATE_IN ? best + ply : best < -MATE_IN ? best - ply : best;
    table.set(key, { depth, score, flag: best <= start ? UPPER : best >= beta ? LOWER : EXACT, best: bestMove });
  }
  return best;
}

export interface SearchOptions {
  /** Milliseconds the search may spend. It always finishes at least the first ply. */
  budgetMs?: number;
  /** A ceiling on the depth, for tests that want one fixed, fast answer. */
  maxDepth?: number;
  /** Breaks ties between moves that come out equal. */
  random?: () => number;
  /** `searchKey` of every position already played, so a repetition is seen as the draw it is. */
  repeats?: readonly number[];
}

/**
 * The classic bot: alpha-beta with a quiescence search, deepened one ply at a time until the time
 * budget runs out. The root list is shuffled first, so moves that really are equal are equally
 * likely and no two games are the same; after that each iteration starts with the order the last
 * one found, which is what makes the pruning pay.
 */
export function botMove(s: ChessState, options: SearchOptions = {}): Move {
  const { budgetMs = 200, maxDepth = 64, random = Math.random, repeats = [] } = options;
  const ranked = legalMoves(s);
  if (ranked.length <= 1) return ranked[0];

  table.clear();
  history.fill(0);
  killers = new Int32Array((maxDepth + 8) * 2);
  repeated = new Map();
  for (const key of repeats) repeated.set(key, (repeated.get(key) ?? 0) + 1);
  deadline = performance.now() + budgetMs;
  nodes = 0;
  stopped = false;

  for (let i = ranked.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ranked[i], ranked[j]] = [ranked[j], ranked[i]];
  }
  order(ranked, 0, 0);
  let best = ranked[0];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const scored: { move: Move; score: number }[] = [];
    let alpha = -MATE - 1;
    for (const m of ranked) {
      const score = -search(makeMove(s, m), depth - 1, -MATE, -alpha, 1);
      if (stopped) break;
      scored.push({ move: m, score });
      if (score > alpha) alpha = score;
    }
    // Half an iteration says nothing: the moves not yet tried were never compared.
    if (scored.length < ranked.length) break;
    // A stable sort, so moves that scored the same keep the order the shuffle gave them.
    scored.sort((a, b) => b.score - a.score);
    ranked.splice(0, ranked.length, ...scored.map((x) => x.move));
    best = scored[0].move;
    // A forced mate is the end of the question, and so is a lost one.
    if (Math.abs(scored[0].score) > MATE_IN || performance.now() >= deadline) break;
  }
  return best;
}

// ---- Facts about each move ------------------------------------------------------------------------

export interface MoveFacts {
  move: Move;
  id: string;
  san: string;
  check: boolean;
  mate: boolean;
  /** Pawns of material the opponent wins with its best reply (0 = nothing hangs), and that reply. */
  risk: number;
  riskSan: string | null;
  /** The opponent has mate in one in reply, and how it mates. */
  matedBy: string | null;
  stalemates: boolean;
  /** Static evaluation after the move, in pawns, from the mover's point of view. */
  evalAfter: number;
}

/** Centipawns as a plain number of pawns: 320 reads 3.2, 900 reads 9. `+ 0` turns -0 into 0, which JSON keeps. */
const pawns = (cp: number) => Math.round(cp) / 100 + 0;
/** What a move wins outright: the piece it takes, plus what a pawn gains by becoming a piece. */
const won = (m: Move) => (m.captured ? VALUE[typeOf(m.captured)] : 0) + (m.promotion ? VALUE[m.promotion] - VALUE.p : 0);

/**
 * Static exchange evaluation: what the side to move really wins by taking on `sq`, in centipawns,
 * when both sides may keep taking or stop. Only legal captures count, so a pinned defender does
 * not defend and a king cannot recapture a protected piece, and a promotion on the square counts
 * as what the pawn becomes.
 */
export function exchangeOn(s: ChessState, sq: number): number {
  if (!isAttacked(s.board, sq, s.turn)) return 0;
  let best = 0;
  for (const m of legalMoves(s)) {
    if (m.to !== sq || !m.captured) continue;
    const gain = won(m) - exchangeOn(makeMove(s, m), sq);
    if (gain > best) best = gain;
  }
  return best;
}

/**
 * For every legal move: what it takes, whether it checks or mates, the most material the opponent
 * can win in reply once the exchange on that square is played out, and whether it walks into mate
 * in one. A one-move look plus the exchange, not a search: it catches hanging pieces and bad
 * trades, not deeper tactics.
 */
export function analyze(s: ChessState, legal: Move[] = legalMoves(s)): MoveFacts[] {
  return legal.map((move): MoveFacts => {
    const after = makeMove(s, move);
    const replies = legalMoves(after);
    const check = inCheck(after);
    let risk = 0;
    let riskMove: Move | null = null;
    let mateMove: Move | null = null;
    for (const reply of replies) {
      const takes = won(reply);
      if (takes === 0 && mateMove) continue;
      const landed = makeMove(after, reply);
      // Mate ends the argument about material, so it is looked for on every reply, not just captures.
      if (!mateMove && inCheck(landed) && legalMoves(landed).length === 0) mateMove = reply;
      if (takes === 0) continue;
      const gain = takes - exchangeOn(landed, reply.to);
      if (gain > risk) {
        risk = gain;
        riskMove = reply;
      }
    }
    return {
      move,
      id: moveId(move),
      san: toSan(s, move, legal, { after, replies }),
      check,
      mate: check && replies.length === 0,
      risk: pawns(risk),
      riskSan: riskMove ? toSan(after, riskMove, replies) : null,
      matedBy: mateMove ? toSan(after, mateMove, replies) : null,
      stalemates: !check && replies.length === 0,
      evalAfter: pawns(evaluate(after) * (s.turn === 'w' ? 1 : -1)),
    };
  });
}

const NAMES: Record<PieceType, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const CENTRE_SQUARES = new Set([27, 28, 35, 36]);

/** Same field names on every option so a model can compare them directly. */
export function describeMove(f: MoveFacts): Record<string, string> {
  const { move } = f;
  const type = typeOf(move.piece);
  const white = colorOf(move.piece) === 'w';
  const notes: string[] = [];
  if (move.flag === 'castleK' || move.flag === 'castleQ') notes.push('castles: king to safety, rook into play');
  if (move.promotion) notes.push(`promotes to a ${NAMES[move.promotion]}`);
  if ((type === 'n' || type === 'b') && rowOf(move.from) === (white ? 7 : 0)) notes.push('develops a piece');
  if (type === 'p' && CENTRE_SQUARES.has(move.to)) notes.push('takes space in the centre');
  if (type === 'k' && !move.flag) notes.push('king move: gives up castling');
  return {
    move: `${f.san}: ${NAMES[type]} ${squareName(move.from)} to ${squareName(move.to)}`,
    captures: move.captured ? `a ${NAMES[typeOf(move.captured)]} (${pawns(VALUE[typeOf(move.captured)])} points)` : 'nothing',
    check: f.mate ? 'CHECKMATE: wins the game' : f.stalemates ? 'STALEMATE: the game is drawn at once' : f.check ? 'gives check' : 'no',
    opponent_can_win_next: f.mate ? 'nothing' : f.risk > 0 ? `${f.risk} points with ${f.riskSan}` : 'nothing',
    opponent_can_mate_next: f.mate ? 'no' : f.matedBy ? `YES: ${f.matedBy} CHECKMATES YOU. Do not play this move.` : 'no',
    notes: notes.join('; ') || 'none',
  };
}

/** The board as text, rank 8 at the top, with coordinates. */
export function boardToText(s: ChessState): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) rows.push(`${8 - r} ${s.board.slice(r * 8, r * 8 + 8).map((p) => p ?? '.').join(' ')}`);
  rows.push('  a b c d e f g h');
  return rows;
}
