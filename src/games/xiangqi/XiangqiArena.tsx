import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../core/i18n';
import { sfx } from '../../core/sound';
import type { Player, PlayerConfig } from '../../core/types';
import { fmtMs, fmtUsd, formatClock } from '../../core/types';
import { createPlayer } from '../../players';
import { Countdown, PlayerBadge, MatchEnding, StatsGrid, modelStatRows, seatMood, type CompareRow, type StatRow } from '../../ui/bits';
import { useMatch } from '../../ui/useMatch';
import { COLS, PIECE_CHAR, ROWS, SQUARES, type Piece, colOf, colorOf, generalSquare, inCheck, materialBalance, moveId, rowOf, squareName } from './engine';
import { XiangqiMatch, type PlayedMove, type XiangqiOptions, type XiangqiSeat } from './match';

const STEP = 60;
const MARGIN = 44;
const WIDTH = MARGIN * 2 + STEP * (COLS - 1);
const HEIGHT = MARGIN * 2 + STEP * (ROWS - 1);
const RADIUS = 25;
const RED = '#e0344f';
const INK = '#1f1147';
const PIECE_FONT = '"Kaiti SC", "STKaiti", "KaiTi", "Songti SC", "Noto Serif CJK SC", serif';
/** Points where cannons and soldiers start, marked on a real board with little corner ticks. */
const MARKED: [number, number][] = [[2, 1], [2, 7], [7, 1], [7, 7], [3, 0], [3, 2], [3, 4], [3, 6], [3, 8], [6, 0], [6, 2], [6, 4], [6, 6], [6, 8]];

/** Where a point is drawn; the board turns around when it is flipped. */
const pointOf = (sq: number, flipped: boolean) => {
  const col = flipped ? COLS - 1 - colOf(sq) : colOf(sq);
  const row = flipped ? ROWS - 1 - rowOf(sq) : rowOf(sq);
  return { x: MARGIN + col * STEP, y: MARGIN + row * STEP };
};

function Disc({ piece, x, y, className, style, dim }: { piece: Piece; x: number; y: number; className?: string; style?: React.CSSProperties; dim?: boolean }) {
  const color = colorOf(piece) === 'r' ? RED : INK;
  return (
    <g className={className} style={style} opacity={dim ? 0.5 : 1} pointerEvents="none">
      <circle cx={x + 2} cy={y + 3} r={RADIUS} fill="rgba(31,17,71,0.28)" />
      <circle cx={x} cy={y} r={RADIUS} fill="#fff8e7" stroke={INK} strokeWidth={3} />
      <circle cx={x} cy={y} r={RADIUS - 5.5} fill="none" stroke={color} strokeWidth={1.8} />
      <text x={x} y={y + 1} textAnchor="middle" dominantBaseline="central" fontSize={28} fontWeight={700} fill={color} fontFamily={PIECE_FONT}>
        {PIECE_CHAR[piece]}
      </text>
    </g>
  );
}

function Grid() {
  const x = (c: number) => MARGIN + c * STEP;
  const y = (r: number) => MARGIN + r * STEP;
  const tick = 5;
  const arm = 12;
  return (
    <g stroke={INK} strokeWidth={1.6} strokeLinecap="round" fill="none">
      <rect x={x(0) - 6} y={y(0) - 6} width={STEP * 8 + 12} height={STEP * 9 + 12} strokeWidth={3} rx={4} />
      {Array.from({ length: ROWS }, (_, r) => (
        <line key={`h${r}`} x1={x(0)} y1={y(r)} x2={x(8)} y2={y(r)} />
      ))}
      {Array.from({ length: COLS }, (_, c) =>
        // Only the two edge files cross the river.
        c === 0 || c === COLS - 1 ? (
          <line key={`v${c}`} x1={x(c)} y1={y(0)} x2={x(c)} y2={y(9)} />
        ) : (
          <g key={`v${c}`}>
            <line x1={x(c)} y1={y(0)} x2={x(c)} y2={y(4)} />
            <line x1={x(c)} y1={y(5)} x2={x(c)} y2={y(9)} />
          </g>
        ),
      )}
      {[0, 7].map((top) => (
        <g key={`palace${top}`}>
          <line x1={x(3)} y1={y(top)} x2={x(5)} y2={y(top + 2)} />
          <line x1={x(5)} y1={y(top)} x2={x(3)} y2={y(top + 2)} />
        </g>
      ))}
      {MARKED.map(([r, c]) =>
        [-1, 1].flatMap((sx) =>
          [-1, 1].map((sy) => {
            // No tick may hang off the edge of the board.
            if ((c === 0 && sx < 0) || (c === COLS - 1 && sx > 0)) return null;
            const px = x(c) + sx * tick;
            const py = y(r) + sy * tick;
            return <path key={`${r}-${c}-${sx}-${sy}`} d={`M${px + sx * arm} ${py} H${px} V${py + sy * arm}`} strokeWidth={1.4} />;
          }),
        ),
      )}
    </g>
  );
}

function MoveArrow({ move, flipped }: { move: PlayedMove; flipped: boolean }) {
  const a = pointOf(move.from, flipped);
  const b = pointOf(move.to, flipped);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const color = move.captured ? '#ff5d8f' : '#7c5cff';
  return (
    <g className="arrow-in" pointerEvents="none">
      <defs>
        <marker id="xq-arrow-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="3.4" markerHeight="3.4" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill={color} />
        </marker>
      </defs>
      <line x1={a.x + ux * 14} y1={a.y + uy * 14} x2={b.x - ux * (RADIUS + 9)} y2={b.y - uy * (RADIUS + 9)} stroke={color} strokeWidth={7} strokeLinecap="round" opacity={0.6} markerEnd="url(#xq-arrow-head)" />
    </g>
  );
}

function Board({ match, flipped }: { match: XiangqiMatch; flipped: boolean }) {
  const [selected, setSelected] = useState<number | null>(null);
  const { state, legal } = match;
  const canMove = match.awaitingHuman;
  const last = match.history[match.history.length - 1];
  const ply = match.history.length;
  const checked = match.status !== 'idle' && inCheck(state.board, state.turn) ? generalSquare(state.board, state.turn) : -1;

  // A selection made on one turn means nothing on the next.
  const seenPly = useRef(ply);
  if (seenPly.current !== ply) {
    seenPly.current = ply;
    if (selected !== null) setSelected(null);
  }

  const targets = useMemo(() => new Set(selected === null ? [] : legal.filter((m) => m.from === selected).map((m) => m.to)), [legal, selected]);

  const click = (sq: number) => {
    if (!canMove) return;
    if (selected !== null && targets.has(sq)) return match.play(moveId(legal.find((m) => m.from === selected && m.to === sq)!));
    const piece = state.board[sq];
    setSelected(piece && colorOf(piece) === state.turn && legal.some((m) => m.from === sq) ? sq : null);
  };

  const river = MARGIN + STEP * 4.5;
  return (
    <div className="toy w-full overflow-hidden !bg-[#ffe3a3] p-1" style={{ maxWidth: 560 }}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="block w-full" role="img" aria-label={t('x.boardLabel')}>
        <Grid />
        <g fontSize={26} fontWeight={700} fill={INK} opacity={0.35} fontFamily={PIECE_FONT} textAnchor="middle" dominantBaseline="central">
          <text x={MARGIN + STEP * 2} y={river}>楚　河</text>
          <text x={MARGIN + STEP * 6} y={river}>汉　界</text>
        </g>

        {last && (
          <>
            {/* Where the piece left: an empty dashed ring. Where it landed: a solid one. */}
            <circle {...{ cx: pointOf(last.from, flipped).x, cy: pointOf(last.from, flipped).y }} r={RADIUS - 4} fill="none" stroke={last.captured ? '#ff5d8f' : '#7c5cff'} strokeWidth={3} strokeDasharray="5 5" opacity={0.8} />
            <circle {...{ cx: pointOf(last.to, flipped).x, cy: pointOf(last.to, flipped).y }} r={RADIUS + 6} fill={last.captured ? '#ff5d8f' : '#7c5cff'} opacity={0.3} />
          </>
        )}

        {last?.captured && (
          <Disc key={`taken-${ply}`} piece={last.captured} {...pointOf(last.to, flipped)} className="xq-taken" />
        )}

        {Array.from({ length: SQUARES }, (_, sq) => {
          const piece = state.board[sq];
          if (!piece) return null;
          const { x, y } = pointOf(sq, flipped);
          const arrived = last?.to === sq;
          const from = arrived ? pointOf(last.from, flipped) : null;
          return (
            <g key={arrived ? `moved-${ply}` : `at-${sq}`}>
              {sq === selected && <circle cx={x} cy={y} r={RADIUS + 5} fill="#3ddc97" opacity={0.75} />}
              {sq === checked && <circle cx={x} cy={y} r={RADIUS + 6} fill="none" stroke="#ff5d8f" className="win-ring" />}
              <Disc
                piece={piece}
                x={x}
                y={y}
                dim={match.status === 'done' && match.result?.winner !== null && colorOf(piece) !== (match.result?.winner === 0 ? 'r' : 'b')}
                className={from ? 'xq-slide' : undefined}
                style={from ? ({ '--dx': `${from.x - x}px`, '--dy': `${from.y - y}px` } as React.CSSProperties) : undefined}
              />
            </g>
          );
        })}

        {last && <MoveArrow key={`arrow-${ply}`} move={last} flipped={flipped} />}

        {[...targets].map((sq) => {
          const { x, y } = pointOf(sq, flipped);
          return state.board[sq] ? (
            <circle key={`t${sq}`} cx={x} cy={y} r={RADIUS + 4} fill="none" stroke="#3ddc97" strokeWidth={5} pointerEvents="none" />
          ) : (
            <circle key={`t${sq}`} cx={x} cy={y} r={9} fill="#3ddc97" stroke={INK} strokeWidth={2} pointerEvents="none" />
          );
        })}

        {canMove &&
          Array.from({ length: SQUARES }, (_, sq) => {
            const { x, y } = pointOf(sq, flipped);
            const piece = state.board[sq];
            const active = targets.has(sq) || (piece !== null && colorOf(piece) === state.turn);
            return (
              <circle key={`hit${sq}`} cx={x} cy={y} r={STEP / 2} fill="transparent" style={{ cursor: active ? 'pointer' : 'default' }} onClick={() => click(sq)}>
                <title>{squareName(sq)}</title>
              </circle>
            );
          })}
      </svg>
    </div>
  );
}

const sideName = (color: 'r' | 'b') => t(color === 'r' ? 'x.red' : 'x.black');

/** "Last move: Red 炮 h2 → e2 takes 马 · 炮二平五", so the opponent's move is never a mystery. */
function LastMove({ move }: { move: PlayedMove | undefined }) {
  if (!move) return null;
  const chip = (piece: Piece) => (
    <span className="grid size-7 place-items-center rounded-full border-2 border-ink bg-[#fff8e7] text-base font-bold leading-none" style={{ fontFamily: PIECE_FONT, color: colorOf(piece) === 'r' ? RED : INK }}>
      {PIECE_CHAR[piece]}
    </span>
  );
  return (
    <div key={move.id + move.notation} className="toy-sm pop-in flex flex-wrap items-center justify-center gap-x-2 px-4 py-1.5 text-sm font-semibold" aria-live="polite">
      <span className="opacity-60">{t('c.lastMove')}</span>
      <span>{sideName(move.color)}</span>
      {chip(move.piece)}
      <span className="font-mono">
        {squareName(move.from)} → {squareName(move.to)}
      </span>
      {move.captured && (
        <span className="flex items-center gap-1 text-pink">
          {t('c.takes')} {chip(move.captured)}
        </span>
      )}
      <span className="rounded-full border-2 border-ink bg-paper px-2.5 text-sm" style={{ fontFamily: PIECE_FONT }}>
        {move.notation}
      </span>
    </div>
  );
}

function seatRows(seat: XiangqiSeat, lead: number): StatRow[] {
  const base: StatRow[] = [
    [t('stat.moves'), seat.moves],
    [t('stat.material'), lead > 0 ? `+${lead}` : lead === 0 ? '=' : String(lead)],
  ];
  if (seat.human) return base;
  return [...base, [t('stat.calls'), seat.stats.calls], [t('stat.fallbacks'), seat.stats.invalid + seat.stats.errors], ...modelStatRows(seat.stats, false)];
}

function SeatPanel({ seat, match }: { seat: XiangqiSeat; match: XiangqiMatch }) {
  const toMove = match.status === 'running' && match.turnSeat === seat;
  const won = match.result?.winner === seat.index;
  const lead = materialBalance(match.state.board) * (seat.color === 'r' ? 1 : -1);
  return (
    <section className={`toy flex w-full flex-col gap-3 p-4 transition-transform lg:w-72 ${toMove ? '!bg-sun/40 lg:-translate-y-1' : ''} ${seatMood(match.result, seat.index)}`}>
      <PlayerBadge
        player={seat.player}
        thinking={seat.thinking}
        move={seat.move}
        tag={
          <span className="flex shrink-0 items-center gap-1">
            <span className="inline-block size-4 rounded-full border-2 border-ink" style={{ background: seat.color === 'r' ? RED : INK }} title={sideName(seat.color)} />
            {won && <span className="rounded-full border-2 border-ink bg-sun px-2 text-xs font-bold">{t('arena.winner')}</span>}
          </span>
        }
      />
      <div className="flex min-h-8 flex-wrap items-center gap-0.5 rounded-xl border-2 border-ink/80 bg-white px-2 py-0.5" title={t('c.captured')}>
        {seat.captured.length ? (
          seat.captured.map((p, i) => (
            <span key={i} className="text-lg font-bold leading-none" style={{ fontFamily: PIECE_FONT, color: colorOf(p) === 'r' ? RED : INK }}>
              {PIECE_CHAR[p]}
            </span>
          ))
        ) : (
          <span className="text-xs opacity-40">{t('c.captured')}</span>
        )}
      </div>
      <StatsGrid rows={seatRows(seat, lead)} cols={2} />
    </section>
  );
}

function MoveList({ match }: { match: XiangqiMatch }) {
  const end = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', inline: 'end' });
  }, [match.history.length]);
  if (match.history.length === 0) return null;
  return (
    <div className="toy-sm w-full overflow-x-auto whitespace-nowrap px-3 py-1.5 text-sm" style={{ maxWidth: 560 }}>
      {match.history.map((m, i) => (
        <span key={i} className={i === match.history.length - 1 ? 'font-bold' : 'opacity-70'} style={{ color: m.color === 'r' ? RED : INK }}>
          {i % 2 === 0 && <span className="font-mono text-ink opacity-50">{i / 2 + 1}. </span>}
          {m.notation}{' '}
        </span>
      ))}
      <span ref={end} />
    </div>
  );
}

function compareRows(match: XiangqiMatch): CompareRow[] {
  const [A, B] = match.seats;
  const balance = materialBalance(match.state.board);
  const both = (label: string, f: (s: XiangqiSeat) => React.ReactNode): CompareRow => [label, f(A), f(B)];
  return [
    both(t('cmp.side'), (s) => sideName(s.color)),
    both(t('stat.moves'), (s) => s.moves),
    both(t('stat.material'), (s) => {
      const lead = balance * (s.color === 'r' ? 1 : -1);
      return lead > 0 ? `+${lead}` : lead === 0 ? '=' : String(lead);
    }),
    both(t('stat.avgLatency'), (s) => (s.stats.latency ? fmtMs(s.stats.latency / s.stats.calls) : '–')),
    both(t('cmp.botFallbacks'), (s) => (s.human ? '–' : s.stats.invalid + s.stats.errors)),
    both(t('cmp.tokensInOut'), (s) => (s.stats.inputTokens ? `${s.stats.inputTokens.toLocaleString()} / ${s.stats.outputTokens.toLocaleString()}` : '–')),
    both(t('stat.cost'), (s) => fmtUsd(s.stats.cost)),
    both(t('cmp.costPerMove'), (s) => (s.stats.calls && s.stats.cost ? fmtUsd(s.stats.cost / s.stats.calls, 5) : '–')),
  ];
}

export function XiangqiArena({
  seats,
  options,
  onRematch,
  onSetup,
  onLobby,
}: {
  seats: [PlayerConfig, PlayerConfig];
  options: XiangqiOptions;
  onRematch: () => void;
  onSetup: () => void;
  onLobby: () => void;
}) {
  const players = useMemo(() => seats.map(createPlayer) as [Player, Player], [seats]);
  const { match, count } = useMatch(
    (onChange) =>
      new XiangqiMatch(players, options, onChange, (event) => {
        if (event.type === 'check') sfx.play('check');
        else if (event.type === 'capture') sfx.play('capture');
        else sfx.play(event.color === 'r' ? 'stoneWhite' : 'stoneBlack');
      }),
  );
  const [, setClock] = useState(0);
  const [resultOpen, setResultOpen] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 500);
    return () => clearInterval(id);
  }, []);

  if (!match) return null;
  const [A, B] = match.seats;
  // A person playing Black alone sees the board from Black's side.
  const flipped = seats[1].kind === 'human' && seats[0].kind !== 'human';
  const fullMove = Math.floor(match.history.length / 2) + (match.status === 'done' ? 0 : 1);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-5 px-4 pb-10">
      <Countdown value={count} />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <span className="toy-sm px-4 py-1 font-mono text-2xl font-bold">{formatClock(match.elapsed())}</span>
        <span className="toy-sm !bg-sun px-3 py-1 text-sm font-bold">
          {t('c.moveNo', { n: Math.max(1, fullMove) })}
          {options.maxMoves > 0 && <span className="opacity-50"> / {options.maxMoves}</span>}
        </span>
        {match.status === 'running' && inCheck(match.state.board, match.state.turn) && <span className="toy-sm pop-in !bg-pink px-3 py-1 text-sm font-bold text-white">{t('c.check')}</span>}
        {match.status !== 'done' ? (
          <button className="btn bg-pink !py-1.5 text-sm text-white" onClick={() => match.stop()}>
            {t('arena.stop')}
          </button>
        ) : (
          <button className="btn bg-mint !py-1.5 text-sm" onClick={() => setResultOpen(true)}>
            {t('arena.results')}
          </button>
        )}
      </div>

      {match.error && (
        <div className="toy-sm !bg-pink px-4 py-2 text-sm font-medium text-white" role="alert">
          ⚠️ {match.error}
        </div>
      )}

      <div className="flex w-full flex-col items-center gap-5 lg:flex-row lg:items-start lg:justify-center">
        <SeatPanel seat={A} match={match} />
        <div className="flex w-full min-w-0 flex-col items-center gap-3" style={{ maxWidth: 560 }}>
          <LastMove move={match.history[match.history.length - 1]} />
          <Board match={match} flipped={flipped} />
          <MoveList match={match} />
        </div>
        <SeatPanel seat={B} match={match} />
      </div>

      {match.result && (
        <MatchEnding
          result={match.result}
          humans={[seats[0].kind === 'human', seats[1].kind === 'human']}
          open={resultOpen}
          detail={t('detail.chess', { clock: formatClock(match.result.elapsedMs), n: Math.ceil(match.history.length / 2) })}
          players={players}
          rows={compareRows(match)}
          onRematch={onRematch}
          onSetup={onSetup}
          onLobby={onLobby}
          onClose={() => setResultOpen(false)}
        />
      )}
    </div>
  );
}
