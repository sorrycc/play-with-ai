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
  type Promotion,
  VALUE,
  analyze,
  boardToText,
  botMove,
  describeMove,
  evaluate,
  inCheck,
  legalMoves,
  makeMove,
  materialBalance,
  moveId,
  outcome,
  positionKey,
  searchKey,
  squareName,
  startState,
  toFen,
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

/** At the move limit, a lead of at least this many points wins; less is a draw. */
const ADJUDICATION_MARGIN = 3;
/** How long the classic bot may think per move. Short enough that the page stays responsive. */
const BOT_BUDGET_MS = 200;

export const CHESS_RULES =
  'You are playing chess under the standard rules. Every listed option is a legal move; the facts next to each move were computed by code and are exact. ' +
  'Piece values: pawn 1, knight 3.2, bishop 3.3, rook 5, queen 9. "opponent_can_win_next" plays out the exchange on one square only: it catches hanging pieces and bad trades, not deeper tactics. ' +
  '"opponent_can_mate_next" is exact: it looks at every reply, not only captures.';

export const CHESS_PRIORITIES = [
  'If a move says CHECKMATE, play it.',
  'Never play a move whose opponent_can_mate_next says YES: it loses the game on the spot.',
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
  /** What the pawn became, so the board can slide a pawn and then turn it into its new piece. */
  promotion: Promotion | null;
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

export function buildChessRequest(state: ChessState, facts: MoveFacts[], recent: string[], repeats: readonly number[] = []): DecisionRequest {
  const white = state.turn === 'w';
  const c = state.castling;
  const key = searchKey(state);
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
      moves_without_a_capture_or_a_pawn_move: `${state.halfmove} of 100, then the game is a draw`,
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
        fen: toFen(state),
        castling: `${c.K ? 'K' : ''}${c.Q ? 'Q' : ''}${c.k ? 'k' : ''}${c.q ? 'q' : ''}` || '-',
        enPassant: state.ep === null ? null : squareName(state.ep),
        halfmoveClock: state.halfmove,
        repetitions: repeats.filter((seen) => seen === key).length,
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
          opponentCanMateNext: f.matedBy !== null,
          castles: f.move.flag === 'castleK' || f.move.flag === 'castleQ',
          promotesTo: f.move.promotion,
          evalAfter: f.evalAfter,
        },
      })),
    },
    botChoice: () => moveId(botMove(state, { budgetMs: BOT_BUDGET_MS, repeats })),
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
  /** How often the position on the board has stood there: 3 ends the game. */
  repetition = 1;
  /** The seat that has a draw on offer, and whether the other side has turned one down. */
  drawOffer: 0 | 1 | null = null;
  drawDeclined = false;

  private abort = new AbortController();
  private startedAt = 0;
  private endedAt = 0;
  private seen = new Map<string, number>([[positionKey(this.state), 1]]);
  /** The same history the search wants, as numbers, so it knows a repetition is a draw. */
  private keys: number[] = [searchKey(this.state)];
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

  /** The position as a FEN, and the game as a PGN: both for the copy buttons beside the board. */
  fen(): string {
    return toFen(this.state);
  }

  pgn(): string {
    const result = !this.result ? '*' : this.result.winner === 0 ? '1-0' : this.result.winner === 1 ? '0-1' : '1/2-1/2';
    const moves = this.history.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + m.san).join(' ');
    const tags = [`[White "${this.seats[0].player.name}"]`, `[Black "${this.seats[1].player.name}"]`, `[Result "${result}"]`];
    return `${tags.join('\n')}\n\n${moves} ${result}`.trim();
  }

  /** A person gives up their seat. */
  resign(index: 0 | 1): void {
    if (this.status !== 'running' || !this.seats[index].human) return;
    const winner = index === 0 ? 1 : 0;
    this.finish(winner, t('c.r.resign', { winner: this.seats[winner].player.name }));
  }

  /**
   * A person offers a draw. Another person answers with the same button; anyone else is answered by
   * the classic evaluation, so an offer is never a free way out of a lost position.
   */
  offerDraw(index: 0 | 1): void {
    if (this.status !== 'running' || !this.seats[index].human || this.drawOffer === index) return;
    const other = index === 0 ? 1 : 0;
    if (this.drawOffer === other) return void this.finish(null, t('c.r.agreed'));
    if (this.seats[other].human) {
      this.drawOffer = index;
      this.drawDeclined = false;
    } else if (evaluate(this.state) * (this.seats[other].color === 'w' ? 1 : -1) <= 50) {
      return void this.finish(null, t('c.r.agreed'));
    } else {
      this.drawDeclined = true;
    }
    this.onChange();
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
      // The listener goes as soon as the move arrives: a long game must not pile them up.
      const onAbort = () => resolve(null);
      this.pendingMove = (id) => {
        signal.removeEventListener('abort', onAbort);
        resolve(id);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Waits, unless the match is stopped first: a stopped match leaves no timer behind. */
  private pause(ms: number): Promise<void> {
    const signal = this.abort.signal;
    if (ms <= 0 || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
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
        const request = buildChessRequest(this.state, facts, this.history.slice(-10).map((m) => m.san), this.keys);
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
        await this.pause(Math.max(0, this.options.minMoveMs - (performance.now() - started)));
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
    this.history.push({ id: moveId(move), san, from: move.from, to: move.to, color: seat.color, piece: move.piece, promotion: move.promotion, captured: move.captured, capturedAt, rook });
    if (move.captured) seat.captured.push(move.captured);
    seat.moves += 1;
    this.state = makeMove(this.state, move);
    this.legal = legalMoves(this.state);
    this.keys.push(searchKey(this.state));
    // An offer is answered by the move that follows it.
    this.drawOffer = null;
    this.drawDeclined = false;
    const key = positionKey(this.state);
    const times = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, times);
    this.repetition = times;

    const check = inCheck(this.state);
    this.emit({ type: check ? 'check' : move.captured ? 'capture' : move.promotion ? 'promote' : move.flag === 'castleK' || move.flag === 'castleQ' ? 'castle' : 'move', color: seat.color });

    const end = outcome(this.state, this.legal);
    const fullMoves = Math.ceil(this.history.length / 2);
    if (end?.kind === 'checkmate') return this.finish(seat.index, t('c.r.mate', { winner: seat.player.name, n: fullMoves }));
    if (end) return this.finish(null, t(end.kind === 'stalemate' ? 'c.r.stalemate' : end.kind === 'fifty' ? 'c.r.fifty' : 'c.r.material'));
    if (times >= 3) return this.finish(null, t('c.r.threefold'));
    if (this.options.maxMoves > 0 && this.history.length >= this.options.maxMoves * 2) {
      // The full evaluation, not material alone: at the limit an extra rook on an open file counts.
      const lead = Math.round(evaluate(this.state) / 10) / 10;
      if (Math.abs(lead) < ADJUDICATION_MARGIN) return this.finish(null, t('c.r.limitDraw', { n: this.options.maxMoves, lead: Math.abs(lead) }));
      const winner = lead > 0 ? 0 : 1;
      return this.finish(winner, t('c.r.limitWin', { winner: this.seats[winner].player.name, n: this.options.maxMoves, lead: Math.abs(lead) }));
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
