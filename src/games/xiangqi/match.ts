// A turn-based Chinese chess match between any two seats. No DOM: the arena renders `state` and
// calls `play()` for a human seat. Seat 0 plays Red, which moves first.

import type { Decision, DecisionRequest, Player, PlayerStats } from '../../core/types';
import { freshStats, recordDecision, sleep } from '../../core/types';
import { t } from '../../core/i18n';
import {
  type Color,
  type Move,
  type MoveFacts,
  type Piece,
  type XiangqiState,
  PIECE_NAME,
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
  toChinese,
  typeOf,
} from './engine';

export interface XiangqiOptions {
  /** Full moves before the game is adjudicated on material. 0 = no limit. */
  maxMoves: number;
  /** Shortest time between two moves: long enough for the previous move's slide to finish. */
  minMoveMs: number;
}

export const XIANGQI_DEFAULTS: XiangqiOptions = { maxMoves: 80, minMoveMs: 900 };

/** At the move limit, a lead of at least this many points of material wins; less is a draw. */
const ADJUDICATION_MARGIN = 3;
/** Few enough moves that a third ply is cheap, which is when it matters: endgames and mating nets. */
const DEEP_SEARCH_BELOW = 24;

export const XIANGQI_RULES =
  'You are playing Chinese chess (xiangqi). Red (upper-case letters) starts at the bottom and moves first; Black (lower case) starts at the top. ' +
  'K general: one step orthogonally inside its palace; the two generals may never face each other on an open file. A advisor: one step diagonally inside the palace. ' +
  'B elephant: exactly two steps diagonally, blocked if the point between is occupied, and it never crosses the river. N horse: one step orthogonally then one diagonally, blocked if that first point is occupied. ' +
  'R chariot: any distance orthogonally. C cannon: moves like a chariot, but captures only by jumping over exactly one piece. P soldier: one step forward, and also sideways once across the river; never backwards. ' +
  'A player with no legal move loses, whether or not it is in check. Every listed option is a legal move and the facts next to it were computed by code and are exact. ' +
  'Piece values: chariot 9, cannon 4.5, horse 4, advisor 2, elephant 2, soldier 1 (2 once across the river). "opponent_can_win_next" looks one capture ahead only.';

export const XIANGQI_PRIORITIES = [
  'If a move says WINS THE GAME, play it.',
  'Do not lose material: avoid a move whose opponent_can_win_next is larger than what the move captures. Moving a piece that is already under attack to safety counts as saving it.',
  'Win material when it is free: prefer captures where opponent_can_win_next is nothing or smaller than what you take.',
  'In the opening, bring out the chariots, horses and cannons quickly; a central cannon and well-placed horses are good. Keep the advisors and elephants near the general for defence.',
  'Chariots are the strongest pieces: get them onto open files, and do not trade one for a lesser piece.',
  'When ahead in material, trade pieces and advance soldiers across the river; when the enemy general is short of defenders, look for checks.',
];

export interface XiangqiSeat {
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
  /** Traditional notation, e.g. 炮二平五. */
  notation: string;
  from: number;
  to: number;
  color: Color;
  piece: Piece;
  captured: Piece | null;
}

export interface XiangqiEvent {
  type: 'move' | 'capture' | 'check';
  color: Color;
}

export interface XiangqiResult {
  winner: 0 | 1 | null;
  /** True when the match was stopped rather than decided. */
  stopped: boolean;
  reason: string;
  elapsedMs: number;
}

export function buildXiangqiRequest(state: XiangqiState, facts: MoveFacts[], recent: string[]): DecisionRequest {
  const red = state.turn === 'r';
  // `+ 0` turns the -0 that Black gets from a level position into a plain 0.
  const balance = materialBalance(state.board) * (red ? 1 : -1) + 0;
  return {
    game: 'xiangqi',
    rules: XIANGQI_RULES,
    question: 'Which move should `you_are` play? Each option is a legal move with exact facts about it.',
    priorities: XIANGQI_PRIORITIES,
    state: {
      you_are: red ? 'Red (upper-case letters, at the bottom, moving up the board)' : 'Black (lower-case letters, at the top, moving down the board)',
      board: boardToText(state),
      legend: 'K general, A advisor, B elephant, N horse, R chariot, C cannon, P soldier; upper case is Red, lower case is Black; . is an empty point. Files a-i run left to right, ranks 0-9 from the bottom (Red) to the top (Black).',
      move_number: state.fullmove,
      you_are_in_check: inCheck(state.board, state.turn),
      material_balance: balance === 0 ? 'level' : balance > 0 ? `you are ${balance} points ahead` : `you are ${-balance} points behind`,
      recent_moves: recent.length ? recent.join(' ') : 'none yet',
    },
    options: facts.map((f) => ({ id: f.id, description: describeMove(f) })),
    data: {
      state: {
        board: boardToText(state).filter((row) => /^\d/.test(row)).map((row) => row.slice(2).replace(/ /g, '')),
        youAre: red ? 'red' : 'black',
        moveNumber: state.fullmove,
        inCheck: inCheck(state.board, state.turn),
        materialBalance: balance,
      },
      options: facts.map((f) => ({
        id: f.id,
        facts: {
          notation: f.notation,
          piece: PIECE_NAME[typeOf(f.move.piece)],
          from: squareName(f.move.from),
          to: squareName(f.move.to),
          captures: f.move.captured ? PIECE_NAME[typeOf(f.move.captured)] : null,
          captureValue: f.move.captured ? VALUE[typeOf(f.move.captured)] / 100 : 0,
          givesCheck: f.check,
          winsTheGame: f.wins,
          opponentCanWinNext: f.risk,
          evalAfter: f.evalAfter,
        },
      })),
    },
    botChoice: () => moveId(botMove(state, facts.length < DEEP_SEARCH_BELOW ? 3 : 2)),
    realtime: false,
  };
}

export class XiangqiMatch {
  readonly seats: [XiangqiSeat, XiangqiSeat];
  readonly options: XiangqiOptions;
  state: XiangqiState = startState();
  /** Legal moves in `state`, kept for the arena: which points a person may click. */
  legal: Move[] = legalMoves(this.state);
  history: PlayedMove[] = [];
  status: 'idle' | 'running' | 'done' = 'idle';
  result: XiangqiResult | null = null;
  error: string | null = null;

  private abort = new AbortController();
  private startedAt = 0;
  private endedAt = 0;
  private seen = new Map<string, number>([[positionKey(this.state), 1]]);
  private pendingMove: ((id: string) => void) | null = null;
  private onChange: () => void;
  private emit: (event: XiangqiEvent) => void;

  constructor(players: [Player, Player], options: XiangqiOptions, onChange: () => void = () => {}, emit: (event: XiangqiEvent) => void = () => {}) {
    this.options = options;
    this.onChange = onChange;
    this.emit = emit;
    const seat = (index: 0 | 1): XiangqiSeat => ({
      index,
      color: index === 0 ? 'r' : 'b',
      player: players[index],
      human: players[index].config.kind === 'human',
      thinking: false,
      move: t(index === 0 ? 'x.redFirst' : 'x.blackWaits'),
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

  get turnSeat(): XiangqiSeat {
    return this.seats[this.state.turn === 'r' ? 0 : 1];
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

  /** A person's move, by id (h2e2). Ignored unless it is a human seat's turn and the move is legal. */
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
        seat.move = t('c.played', { san: toChinese(this.state, chosen), took: '' });
      } else {
        const facts = analyze(this.state, legal);
        const request = buildXiangqiRequest(this.state, facts, this.history.slice(-10).map((m) => m.notation));
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
          seat.move = t('c.played', { san: fact.notation, took });
        } else {
          // A turn cannot be skipped, so an error or an invalid answer falls back to the classic bot.
          if (decision) seat.stats.invalid += 1;
          const id = request.botChoice();
          const fallback = facts.find((f) => f.id === id)!;
          chosen = fallback.move;
          seat.move = t('c.fallback', { note: decision ? decision.note : seat.move, san: fallback.notation });
        }
        // Always a real timer, even at zero, so two instant players never starve the page.
        await sleep(Math.max(0, this.options.minMoveMs - (performance.now() - started)));
        if (signal.aborted) return;
      }

      if (this.apply(seat, chosen)) return;
      this.onChange();
    }
  }

  /** Plays the move; returns true when it ended the game. */
  private apply(seat: XiangqiSeat, move: Move): boolean {
    this.history.push({ id: moveId(move), notation: toChinese(this.state, move), from: move.from, to: move.to, color: seat.color, piece: move.piece, captured: move.captured });
    if (move.captured) seat.captured.push(move.captured);
    seat.moves += 1;
    this.state = makeMove(this.state, move);
    this.legal = legalMoves(this.state);
    const key = positionKey(this.state);
    const times = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, times);

    this.emit({ type: inCheck(this.state.board, this.state.turn) ? 'check' : move.captured ? 'capture' : 'move', color: seat.color });

    const end = outcome(this.state, this.legal);
    const fullMoves = Math.ceil(this.history.length / 2);
    if (end && 'winner' in end) return this.finish(seat.index, t(end.kind === 'checkmate' ? 'x.r.mate' : 'x.r.stuck', { winner: seat.player.name, n: fullMoves }));
    if (end) return this.finish(null, t('x.r.quiet'));
    // Tournament rules decide a repetition by who is forcing it (perpetual check loses). That needs
    // judging intent, so here a position reached three times is simply a draw.
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
