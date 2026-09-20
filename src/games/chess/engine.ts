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

/** Identifies a position for repetition: placement, side to move, castling rights and en passant square. */
export function positionKey(s: ChessState): string {
  const c = s.castling;
  return `${s.board.map((p) => p ?? '.').join('')}${s.turn}${c.K ? 'K' : ''}${c.Q ? 'Q' : ''}${c.k ? 'k' : ''}${c.q ? 'q' : ''}${s.ep ?? '-'}`;
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

/** Neither side can possibly mate: bare kings, or a single knight or bishop on the board. */
export function insufficientMaterial(board: (Piece | null)[]): boolean {
  let minors = 0;
  for (const p of board) {
    if (!p || typeOf(p) === 'k') continue;
    if (typeOf(p) === 'n' || typeOf(p) === 'b') minors += 1;
    else return false;
  }
  return minors <= 1;
}

export type Outcome = { kind: 'checkmate'; winner: Color } | { kind: 'stalemate' | 'fifty' | 'material' } | null;

export function outcome(s: ChessState, moves: Move[] = legalMoves(s)): Outcome {
  if (moves.length === 0) return inCheck(s) ? { kind: 'checkmate', winner: opposite(s.turn) } : { kind: 'stalemate' };
  if (s.halfmove >= 100) return { kind: 'fifty' };
  if (insufficientMaterial(s.board)) return { kind: 'material' };
  return null;
}

/** Standard algebraic notation, e.g. Nf3, exd5, O-O, e8=Q+, Qxf7#. `legal` are the moves of this position. */
export function toSan(s: ChessState, m: Move, legal: Move[] = legalMoves(s)): string {
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
  const after = makeMove(s, m);
  if (inCheck(after)) san += legalMoves(after).length === 0 ? '#' : '+';
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

/** Static evaluation in centipawns, from white's point of view. */
export function evaluate(s: ChessState): number {
  let queens = 0;
  let minorsAndRooks = 0;
  for (const p of s.board) {
    if (!p) continue;
    if (typeOf(p) === 'q') queens += 1;
    else if (typeOf(p) !== 'p' && typeOf(p) !== 'k') minorsAndRooks += 1;
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
  return score;
}

/** Material only, in pawns, from white's point of view: shown beside the board. */
export function materialBalance(board: (Piece | null)[]): number {
  let score = 0;
  for (const p of board) if (p) score += (colorOf(p) === 'w' ? 1 : -1) * VALUE[typeOf(p)];
  return Math.round(score / 100);
}

const MATE = 100_000;
const orderScore = (m: Move) => (m.captured ? 10 * VALUE[typeOf(m.captured)] - VALUE[typeOf(m.piece)] : 0) + (m.promotion ? 800 : 0);

/** Captures only, until the position is quiet, so the search does not stop in the middle of an exchange. */
function quiesce(s: ChessState, alpha: number, beta: number, depth: number): number {
  const stand = evaluate(s) * (s.turn === 'w' ? 1 : -1);
  if (depth === 0 || stand >= beta) return stand;
  alpha = Math.max(alpha, stand);
  const captures = legalMoves(s).filter((m) => m.captured || m.promotion).sort((a, b) => orderScore(b) - orderScore(a));
  for (const m of captures) {
    const score = -quiesce(makeMove(s, m), -beta, -alpha, depth - 1);
    if (score >= beta) return score;
    alpha = Math.max(alpha, score);
  }
  return alpha;
}

function negamax(s: ChessState, depth: number, alpha: number, beta: number, ply: number): number {
  const moves = legalMoves(s);
  if (moves.length === 0) return inCheck(s) ? -MATE + ply : 0;
  if (s.halfmove >= 100 || insufficientMaterial(s.board)) return 0;
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
export function botMove(s: ChessState, depth = 2, random: () => number = Math.random): Move {
  const moves = legalMoves(s).sort((a, b) => orderScore(b) - orderScore(a));
  let best: Move[] = [];
  let bestScore = -Infinity;
  for (const m of moves) {
    // A full window for every root move, so equal moves really compare equal.
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
  san: string;
  check: boolean;
  mate: boolean;
  /** Points the opponent can win with its best capture in reply (0 = nothing hangs), and that reply. */
  risk: number;
  riskSan: string | null;
  stalemates: boolean;
  /** Static evaluation after the move, in pawns, from the mover's point of view. */
  evalAfter: number;
}

const points = (p: Piece | null) => (p ? Math.round(VALUE[typeOf(p)] / 100) : 0);

/**
 * For every legal move: what it takes, whether it checks or mates, and the most material the
 * opponent can then win with a single capture (the captured piece, less the capturer if the
 * square is defended). A one-move look, not a search: it catches hanging pieces, not tactics.
 */
export function analyze(s: ChessState, legal: Move[] = legalMoves(s)): MoveFacts[] {
  return legal.map((move): MoveFacts => {
    const after = makeMove(s, move);
    const replies = legalMoves(after);
    const check = inCheck(after);
    let risk = 0;
    let riskMove: Move | null = null;
    for (const reply of replies) {
      if (!reply.captured) continue;
      const landed = makeMove(after, reply);
      const defended = isAttacked(landed.board, reply.to, s.turn);
      const gain = points(reply.captured) - (defended ? points(reply.piece) : 0);
      if (gain > risk) {
        risk = gain;
        riskMove = reply;
      }
    }
    return {
      move,
      id: moveId(move),
      san: toSan(s, move, legal),
      check,
      mate: check && replies.length === 0,
      risk,
      riskSan: riskMove ? toSan(after, riskMove, replies) : null,
      stalemates: !check && replies.length === 0,
      evalAfter: Math.round(evaluate(after) * (s.turn === 'w' ? 1 : -1)) / 100,
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
    captures: move.captured ? `a ${NAMES[typeOf(move.captured)]} (${points(move.captured)} points)` : 'nothing',
    check: f.mate ? 'CHECKMATE: wins the game' : f.stalemates ? 'STALEMATE: the game is drawn at once' : f.check ? 'gives check' : 'no',
    opponent_can_win_next: f.mate ? 'nothing' : f.risk > 0 ? `${f.risk} points with ${f.riskSan}` : 'nothing',
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
