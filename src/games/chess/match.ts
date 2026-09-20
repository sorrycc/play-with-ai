// A turn-based chess match between any two seats. No DOM: the arena renders `state` and calls
// `play()` for a human seat. Seat 0 plays white.

import type { Decision, DecisionRequest, Player, PlayerStats } from '../../core/types';
import { freshStats, recordDecision, sleep } from '../../core/types';
import { t } from '../../core/i18n';
import {
  type ChessState,
  type Color,
  type Move,
  type MoveFacts,
  type Piece,
  VALUE,
  analyze,
  boardToText,
  botMove,
  describeMove,
  inCheck,
  legalMoves,
  makeMove,
  materialBalance,
  moveId,
  outcome,
  positionKey,
  squareName,
  startState,
  toSan,
  typeOf,
} from './engine';

export interface ChessOptions {
  /** Full moves before the game is adjudicated on material. 0 = no limit. */
  maxMoves: number;
  /** Shortest time between two moves, so an instant player can still be followed by eye. */
  minMoveMs: number;
}

// Long enough for the previous move's slide to finish before the reply starts moving.
export const CHESS_DEFAULTS: ChessOptions = { maxMoves: 80, minMoveMs: 900 };

/** At the move limit, a lead of at least this many points of material wins; less is a draw. */
const ADJUDICATION_MARGIN = 3;
/** Few enough moves that a third ply is cheap, which is when it matters: endgames and mating nets. */
const DEEP_SEARCH_BELOW = 26;

export const CHESS_RULES =
  'You are playing chess under the standard rules. Every listed option is a legal move; the facts next to each move were computed by code and are exact. ' +
  'Piece values: pawn 1, knight 3, bishop 3, rook 5, queen 9. "opponent_can_win_next" looks one capture ahead only: it catches hanging pieces, not deeper tactics.';

export const CHESS_PRIORITIES = [
  'If a move says CHECKMATE, play it.',
  'Do not lose material: avoid a move whose opponent_can_win_next is larger than what the move captures. Moving a piece that is already under attack to safety counts as saving it.',
  'Win material when it is free: prefer captures where opponent_can_win_next is nothing or smaller than what you take.',
  'Never play a move marked STALEMATE when you are ahead in material.',
  'In the opening, develop knights and bishops, take space in the centre and castle early. Do not move the same piece twice or bring the queen out early without a reason.',
  'When ahead in material, trade pieces and push passed pawns; when the opponent king has few squares, look for checks that lead to mate.',
];

export interface ChessSeat {
  index: 0 | 1;
  color: Color;
  player: Player;
  human: boolean;
  thinking: boolean;
  move: string;
  moves: number;
  /** Enemy pieces this seat has taken, in order. */
  captured: Piece[];
  stats: PlayerStats;
}

export interface PlayedMove {
  id: string;
  san: string;
  from: number;
  to: number;
  color: Color;
  /** The piece as it left its square (a pawn, even when it promotes). */
  piece: Piece;
  captured: Piece | null;
  /** Where the captured piece stood: not `to` for en passant. */
  capturedAt: number | null;
  /** The rook's own journey when castling, so the board can animate it too. */
  rook: { from: number; to: number } | null;
}

export interface ChessEvent {
  type: 'move' | 'capture' | 'castle' | 'promote' | 'check';
  color: Color;
}

export interface ChessResult {
  winner: 0 | 1 | null;
  /** True when the match was stopped rather than decided. */
  stopped: boolean;
  reason: string;
  elapsedMs: number;
}

export function buildChessRequest(state: ChessState, facts: MoveFacts[], recent: string[]): DecisionRequest {
  const white = state.turn === 'w';
  // `+ 0` turns the -0 that Black gets from a level position into a plain 0.
  const balance = materialBalance(state.board) * (white ? 1 : -1) + 0;
  return {
    game: 'chess',
    rules: CHESS_RULES,
    question: 'Which move should `you_are` play? Each option is a legal move with exact facts about it.',
    priorities: CHESS_PRIORITIES,
    state: {
      you_are: white ? 'White (upper-case letters, moving up the board)' : 'Black (lower-case letters, moving down the board)',
      board: boardToText(state),
      legend: 'K king, Q queen, R rook, B bishop, N knight, P pawn; upper case is White, lower case is Black; . is empty. Rank 8 is the top row.',
      move_number: state.fullmove,
      you_are_in_check: inCheck(state),
      material_balance: balance === 0 ? 'level' : balance > 0 ? `you are ${balance} points ahead` : `you are ${-balance} points behind`,
      recent_moves: recent.length ? recent.join(' ') : 'none yet',
    },
    options: facts.map((f) => ({ id: f.id, description: describeMove(f) })),
    data: {
      state: {
        board: boardToText(state).slice(0, 8).map((row) => row.slice(2).replace(/ /g, '')),
        youAre: state.turn,
        moveNumber: state.fullmove,
        inCheck: inCheck(state),
        materialBalance: balance,
      },
      options: facts.map((f) => ({
        id: f.id,
        facts: {
          san: f.san,
          piece: typeOf(f.move.piece),
          from: squareName(f.move.from),
          to: squareName(f.move.to),
          captures: f.move.captured ? typeOf(f.move.captured) : null,
          captureValue: f.move.captured ? VALUE[typeOf(f.move.captured)] / 100 : 0,
          givesCheck: f.check,
          checkmate: f.mate,
          stalemate: f.stalemates,
          opponentCanWinNext: f.risk,
          castles: f.move.flag === 'castleK' || f.move.flag === 'castleQ',
          promotesTo: f.move.promotion,
          evalAfter: f.evalAfter,
        },
      })),
    },
    botChoice: () => moveId(botMove(state, facts.length < DEEP_SEARCH_BELOW ? 3 : 2)),
    realtime: false,
  };
}

export class ChessMatch {
  readonly seats: [ChessSeat, ChessSeat];
  readonly options: ChessOptions;
  state: ChessState = startState();
  /** Legal moves in `state`, kept for the arena: which squares a person may click. */
  legal: Move[] = legalMoves(this.state);
  history: PlayedMove[] = [];
  status: 'idle' | 'running' | 'done' = 'idle';
  result: ChessResult | null = null;
  error: string | null = null;

  private abort = new AbortController();
  private startedAt = 0;
  private endedAt = 0;
  private seen = new Map<string, number>([[positionKey(this.state), 1]]);
  private pendingMove: ((id: string) => void) | null = null;
  private onChange: () => void;
  private emit: (event: ChessEvent) => void;

  constructor(players: [Player, Player], options: ChessOptions, onChange: () => void = () => {}, emit: (event: ChessEvent) => void = () => {}) {
    this.options = options;
    this.onChange = onChange;
    this.emit = emit;
    const seat = (index: 0 | 1): ChessSeat => ({
      index,
      color: index === 0 ? 'w' : 'b',
      player: players[index],
      human: players[index].config.kind === 'human',
      thinking: false,
      move: t(index === 0 ? 'c.whiteFirst' : 'c.blackWaits'),
      moves: 0,
      captured: [],
      stats: freshStats(),
    });
    this.seats = [seat(0), seat(1)];
  }

  elapsed(): number {
    if (this.status === 'idle') return 0;
    return (this.status === 'done' ? this.endedAt : performance.now()) - this.startedAt;
  }

  /** The seat to move. */
  get turnSeat(): ChessSeat {
    return this.seats[this.state.turn === 'w' ? 0 : 1];
  }

  /** True while the seat to move is a person, so the board should accept clicks. */
  get awaitingHuman(): boolean {
    return this.status === 'running' && this.pendingMove !== null;
  }

  start(): void {
    if (this.status !== 'idle') return;
    this.status = 'running';
    this.startedAt = performance.now();
    void this.run();
    this.onChange();
  }

  stop(): void {
    if (this.status === 'done') return;
    this.finish(null, t('r.stopped'), true);
  }

  /** A person's move, by id (e2e4, e7e8q). Ignored unless it is a human seat's turn and the move is legal. */
  play(id: string): void {
    if (!this.pendingMove || !this.legal.some((m) => moveId(m) === id)) return;
    const resolve = this.pendingMove;
    this.pendingMove = null;
    resolve(id);
  }

  private waitForMove(): Promise<string | null> {
    const signal = this.abort.signal;
    return new Promise((resolve) => {
      this.pendingMove = resolve;
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      const seat = this.turnSeat;
      const started = performance.now();
      const legal = this.legal;
      let chosen: Move | undefined;

      if (seat.human) {
        seat.move = t('c.yourTurn');
        this.onChange();
        const id = await this.waitForMove();
        if (id === null) return;
        chosen = legal.find((m) => moveId(m) === id)!;
        seat.move = t('c.played', { san: toSan(this.state, chosen, legal), took: '' });
      } else {
        const facts = analyze(this.state, legal);
        const request = buildChessRequest(this.state, facts, this.history.slice(-10).map((m) => m.san));
        seat.thinking = true;
        this.onChange();
        // Let the "thinking" state paint before a local search blocks the thread.
        await sleep(0);
        let decision: Decision | null = null;
        try {
          decision = await seat.player.decide(request, signal);
        } catch (err) {
          if (signal.aborted) return;
          const e = err as Error & { status?: number };
          seat.stats.errors += 1;
          seat.move = t('m.error', { msg: e.message });
          if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 503) this.error = `${seat.player.name}: ${e.message}`;
        }
        seat.thinking = false;
        if (signal.aborted) return;
        if (decision) recordDecision(seat.stats, decision);
        const fact = facts.find((f) => f.id === decision?.optionId);
        if (fact) {
          chosen = fact.move;
          const took = decision!.latencyMs > 0 ? t('m.took', { ms: Math.round(decision!.latencyMs) }) : '';
          seat.move = t('c.played', { san: fact.san, took });
        } else {
          // A turn cannot be skipped, so an error or an invalid answer falls back to the classic bot.
          if (decision) seat.stats.invalid += 1;
          const id = request.botChoice();
          const fallback = facts.find((f) => f.id === id)!;
          chosen = fallback.move;
          seat.move = t('c.fallback', { note: decision ? decision.note : seat.move, san: fallback.san });
        }
        // Always a real timer, even at zero, so two instant players never starve the page.
        await sleep(Math.max(0, this.options.minMoveMs - (performance.now() - started)));
        if (signal.aborted) return;
      }

      if (this.apply(seat, chosen, legal)) return;
      this.onChange();
    }
  }

  /** Plays the move; returns true when it ended the game. */
  private apply(seat: ChessSeat, move: Move, legal: Move[]): boolean {
    const san = toSan(this.state, move, legal);
    const rook = move.flag === 'castleK' ? { from: move.to + 1, to: move.to - 1 } : move.flag === 'castleQ' ? { from: move.to - 2, to: move.to + 1 } : null;
    const capturedAt = !move.captured ? null : move.flag === 'ep' ? move.to + (seat.color === 'w' ? 8 : -8) : move.to;
    this.history.push({ id: moveId(move), san, from: move.from, to: move.to, color: seat.color, piece: move.piece, captured: move.captured, capturedAt, rook });
    if (move.captured) seat.captured.push(move.captured);
    seat.moves += 1;
    this.state = makeMove(this.state, move);
    this.legal = legalMoves(this.state);
    const key = positionKey(this.state);
    const times = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, times);

    const check = inCheck(this.state);
    this.emit({ type: check ? 'check' : move.captured ? 'capture' : move.promotion ? 'promote' : move.flag === 'castleK' || move.flag === 'castleQ' ? 'castle' : 'move', color: seat.color });

    const end = outcome(this.state, this.legal);
    const fullMoves = Math.ceil(this.history.length / 2);
    if (end?.kind === 'checkmate') return this.finish(seat.index, t('c.r.mate', { winner: seat.player.name, n: fullMoves }));
    if (end) return this.finish(null, t(end.kind === 'stalemate' ? 'c.r.stalemate' : end.kind === 'fifty' ? 'c.r.fifty' : 'c.r.material'));
    if (times >= 3) return this.finish(null, t('c.r.threefold'));
    if (this.options.maxMoves > 0 && this.history.length >= this.options.maxMoves * 2) {
      const balance = materialBalance(this.state.board);
      if (Math.abs(balance) < ADJUDICATION_MARGIN) return this.finish(null, t('c.r.limitDraw', { n: this.options.maxMoves }));
      const winner = balance > 0 ? 0 : 1;
      return this.finish(winner, t('c.r.limitWin', { winner: this.seats[winner].player.name, n: this.options.maxMoves, lead: Math.abs(balance) }));
    }
    return false;
  }

  private finish(winner: 0 | 1 | null, reason: string, stopped = false): true {
    if (this.status === 'done') return true;
    this.endedAt = performance.now();
    if (this.status === 'idle') this.startedAt = this.endedAt;
    this.status = 'done';
    this.abort.abort();
    this.pendingMove = null;
    for (const seat of this.seats) seat.thinking = false;
    this.result = { winner, stopped, reason, elapsedMs: this.endedAt - this.startedAt };
    this.onChange();
    return true;
  }
}
