// A turn-based Gomoku match between any two seats. No DOM: the arena renders `board` and calls
// `click()` for a human seat.

import type { Decision, DecisionRequest, Player, PlayerStats } from '../../core/types';
import { freshStats, recordDecision, sleep } from '../../core/types';
import { t } from '../../core/i18n';
import {
  type Candidate,
  type GomokuBoard,
  type Stone,
  BLACK,
  CELLS,
  WHITE,
  botMove,
  candidates,
  cellId,
  describeCandidate,
  emptyGomokuBoard,
  gomokuBoardToText,
  parseCellId,
  winningLine,
} from './engine';

export interface GomokuOptions {
  /** How many moves a model is offered each turn. */
  candidateLimit: number;
  /** Shortest time between two moves, so an instant player can still be followed by eye. */
  minMoveMs: number;
}

export const GOMOKU_DEFAULTS: GomokuOptions = { candidateLimit: 20, minMoveMs: 450 };

export const GOMOKU_RULES =
  'You are playing Gomoku (five in a row) on a 15x15 board. Players alternate placing one stone. The first to get five or more of their stones in an unbroken row, column or diagonal wins.';

export const GOMOKU_PRIORITIES = [
  'If an option has urgency "winning move", play it.',
  'Otherwise, if an option has urgency "forced: block or lose", play it.',
  'Then prefer a decisive attack or a double threat of your own, then an urgent defense.',
  'An open four or a double threat wins; an open three must be answered. Apply this to both sides.',
  'With nothing urgent, build your own open shapes near your stones and the centre while limiting the opponent.',
];

export interface GomokuSeat {
  index: 0 | 1;
  stone: Stone;
  player: Player;
  human: boolean;
  thinking: boolean;
  move: string;
  moves: number;
  stats: PlayerStats;
}

export interface GomokuEvent {
  type: 'stone';
  stone: Stone;
}

export interface GomokuResult {
  winner: 0 | 1 | null;
  /** True when the match was stopped rather than decided. */
  stopped: boolean;
  reason: string;
  elapsedMs: number;
}

export function buildGomokuRequest(board: GomokuBoard, stone: Stone, list: Candidate[], moveNumber: number, lastMove: string | null): DecisionRequest {
  // By board position, not by score: the order must not hand the model the bot's ranking.
  const options = [...list].sort((a, b) => a.index - b.index).map((c) => ({ id: c.id, description: describeCandidate(c) }));
  return {
    game: 'gomoku',
    rules: GOMOKU_RULES,
    question: 'Where should `you_are` place the next stone? Each option is an empty cell described by what it makes for you and what it blocks.',
    priorities: GOMOKU_PRIORITIES,
    state: {
      you_are: stone === BLACK ? 'X (black)' : 'O (white)',
      opponent_is: stone === BLACK ? 'O (white)' : 'X (black)',
      board: gomokuBoardToText(board),
      legend: 'X black, O white, . empty. Columns are letters A-P without I, rows are numbers with 1 at the bottom. H8 is the centre.',
      move_number: moveNumber,
      opponent_last_move: lastMove ?? 'none',
    },
    options,
    data: {
      state: {
        board: gomokuBoardToText(board).slice(1).map((row) => row.slice(3).replace(/ /g, '')),
        size: 15,
        you: stone === BLACK ? 'X' : 'O',
        opponent: stone === BLACK ? 'O' : 'X',
        moveNumber,
      },
      options: list.map((c) => ({
        id: c.id,
        facts: {
          row: Math.floor(c.index / 15),
          col: c.index % 15,
          makes: c.attack.best,
          blocks: c.defense.best,
          attackScore: c.attack.score,
          defenseScore: c.defense.score,
          attackThreats: c.attack.threats,
          defenseThreats: c.defense.threats,
          distanceToCentre: Math.max(Math.abs(Math.floor(c.index / 15) - 7), Math.abs((c.index % 15) - 7)),
        },
      })),
    },
    botChoice: () => botMove(list).id,
    realtime: false,
  };
}

export class GomokuMatch {
  readonly seats: [GomokuSeat, GomokuSeat];
  readonly options: GomokuOptions;
  board: GomokuBoard = emptyGomokuBoard();
  /** Cell indexes in the order they were played. */
  history: number[] = [];
  turn: 0 | 1 = 0;
  winLine: number[] | null = null;
  status: 'idle' | 'running' | 'done' = 'idle';
  result: GomokuResult | null = null;
  error: string | null = null;

  private abort = new AbortController();
  private startedAt = 0;
  private endedAt = 0;
  private pendingClick: ((index: number) => void) | null = null;
  private onChange: () => void;
  private emit: (event: GomokuEvent) => void;

  /** players[0] takes black and moves first. */
  constructor(players: [Player, Player], options: GomokuOptions, onChange: () => void = () => {}, emit: (event: GomokuEvent) => void = () => {}) {
    this.options = options;
    this.onChange = onChange;
    this.emit = emit;
    const seat = (index: 0 | 1): GomokuSeat => ({
      index,
      stone: index === 0 ? BLACK : WHITE,
      player: players[index],
      human: players[index].config.kind === 'human',
      thinking: false,
      move: t(index === 0 ? 'g.blackFirst' : 'g.white'),
      moves: 0,
      stats: freshStats(),
    });
    this.seats = [seat(0), seat(1)];
  }

  elapsed(): number {
    if (this.status === 'idle') return 0;
    return (this.status === 'done' ? this.endedAt : performance.now()) - this.startedAt;
  }

  /** True while the seat to move is a person, so the board should accept clicks. */
  get awaitingHuman(): boolean {
    return this.status === 'running' && this.pendingClick !== null;
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

  /** A person clicked a cell. Ignored unless it is a human seat's turn and the cell is empty. */
  click(index: number): void {
    if (!this.pendingClick || index < 0 || index >= CELLS || this.board[index]) return;
    const resolve = this.pendingClick;
    this.pendingClick = null;
    resolve(index);
  }

  private waitForClick(): Promise<number | null> {
    const signal = this.abort.signal;
    return new Promise((resolve) => {
      this.pendingClick = resolve;
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      const seat = this.seats[this.turn];
      const turnStarted = performance.now();
      const lastMove = this.history.length ? cellId(this.history[this.history.length - 1]) : null;
      let index: number | null = null;

      if (seat.human) {
        seat.move = t('g.yourTurn');
        this.onChange();
        index = await this.waitForClick();
        if (index === null) return;
        seat.move = t('g.played', { cell: cellId(index), took: '' });
      } else {
        const list = candidates(this.board, seat.stone, this.options.candidateLimit);
        const request = buildGomokuRequest(this.board, seat.stone, list, this.history.length + 1, lastMove);
        seat.thinking = true;
        this.onChange();
        let decision: Decision | null = null;
        try {
          decision = await seat.player.decide(request, signal);
        } catch (err) {
          if (signal.aborted) return;
          const e = err as Error & { status?: number };
          seat.stats.errors += 1;
          if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 503) this.error = `${seat.player.name}: ${e.message}`;
          seat.move = t('m.error', { msg: e.message });
        }
        seat.thinking = false;
        if (signal.aborted) return;
        if (decision) recordDecision(seat.stats, decision);
        const chosen = decision?.optionId ? parseCellId(decision.optionId) : null;
        if (chosen !== null && !this.board[chosen] && list.some((c) => c.index === chosen)) {
          index = chosen;
          const took = decision!.latencyMs > 0 ? t('m.took', { ms: Math.round(decision!.latencyMs) }) : '';
          seat.move = t('g.played', { cell: cellId(index), took });
        } else {
          // A turn cannot be skipped, so an error or an invalid answer falls back to the classic bot.
          if (decision) seat.stats.invalid += 1;
          index = parseCellId(request.botChoice())!;
          seat.move = t('g.fallback', { note: decision ? decision.note : seat.move, cell: cellId(index) });
        }
        // Always a real timer, even at zero, so two instant players never starve the page.
        await sleep(Math.max(0, this.options.minMoveMs - (performance.now() - turnStarted)));
        if (signal.aborted) return;
      }

      this.board[index] = seat.stone;
      this.history.push(index);
      seat.moves += 1;
      this.emit({ type: 'stone', stone: seat.stone });
      const line = winningLine(this.board, index);
      if (line) {
        this.winLine = line;
        return this.finish(seat.index, t('g.win', { name: seat.player.name, n: this.history.length }));
      }
      if (this.history.length === CELLS) return this.finish(null, t('g.drawFull'));
      this.turn = this.turn === 0 ? 1 : 0;
      this.onChange();
    }
  }

  private finish(winner: 0 | 1 | null, reason: string, stopped = false): void {
    if (this.status === 'done') return;
    this.endedAt = performance.now();
    if (this.status === 'idle') this.startedAt = this.endedAt;
    this.status = 'done';
    this.abort.abort();
    this.pendingClick = null;
    for (const seat of this.seats) seat.thinking = false;
    this.result = { winner, stopped, reason, elapsedMs: this.endedAt - this.startedAt };
    this.onChange();
  }
}
