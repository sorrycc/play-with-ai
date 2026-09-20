import { useEffect, useMemo, useState } from 'react';
import type { Player, PlayerConfig } from '../../core/types';
import { fmtMs, fmtUsd, formatClock } from '../../core/types';
import { t } from '../../core/i18n';
import { sfx } from '../../core/sound';
import { createPlayer } from '../../players';
import { Countdown, PlayerBadge, ResultCard, StatsGrid, modelStatRows, resultJingle, type CompareRow, type StatRow } from '../../ui/bits';
import { useMatch } from '../../ui/useMatch';
import { BLACK, SIZE, cellId } from './engine';
import { GomokuMatch, type GomokuOptions, type GomokuSeat } from './match';

const STEP = 40;
const MARGIN = 34;
const BOARD_PX = MARGIN * 2 + STEP * (SIZE - 1);
const COLS = 'ABCDEFGHJKLMNOP';
const STAR_POINTS = [
  [3, 3],
  [3, 11],
  [7, 7],
  [11, 3],
  [11, 11],
];

const px = (n: number) => MARGIN + n * STEP;

function Stone({ row, col, black, order, animate }: { row: number; col: number; black: boolean; order: number; animate: boolean }) {
  return (
    <g className={animate ? 'stone' : undefined}>
      <circle cx={px(col) + 2} cy={px(row) + 3} r={STEP * 0.43} fill="rgba(31,17,71,0.28)" />
      <circle cx={px(col)} cy={px(row)} r={STEP * 0.43} fill={black ? 'url(#stone-black)' : 'url(#stone-white)'} stroke="#1f1147" strokeWidth={2.5} />
      <text x={px(col)} y={px(row) + 4} textAnchor="middle" fontSize={11} fontWeight={700} fontFamily="var(--font-mono)" fill={black ? '#ffffffb0' : '#1f114790'}>
        {order}
      </text>
    </g>
  );
}

function Board({ match }: { match: GomokuMatch }) {
  const [hover, setHover] = useState<number | null>(null);
  const canClick = match.awaitingHuman;
  const last = match.history[match.history.length - 1];
  const orderOf = useMemo(() => new Map(match.history.map((index, i) => [index, i + 1])), [match.history.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const humanStone = match.seats[match.turn].stone;

  return (
    <div className="toy overflow-hidden !bg-[#ffe3a3] p-1" style={{ width: 'min(100%, 640px)' }}>
      <svg viewBox={`0 0 ${BOARD_PX} ${BOARD_PX}`} className="block w-full" role="img" aria-label={t('gomoku.boardLabel')}>
        <defs>
          <radialGradient id="stone-black" cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#6b5aa8" />
            <stop offset="55%" stopColor="#2a1a5e" />
            <stop offset="100%" stopColor="#170d38" />
          </radialGradient>
          <radialGradient id="stone-white" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="70%" stopColor="#fff3df" />
            <stop offset="100%" stopColor="#f3d9b1" />
          </radialGradient>
        </defs>

        {Array.from({ length: SIZE }, (_, i) => (
          <g key={i} stroke="#1f1147" strokeWidth={i === 0 || i === SIZE - 1 ? 3 : 1.4} strokeLinecap="round" opacity={0.8}>
            <line x1={px(0)} y1={px(i)} x2={px(SIZE - 1)} y2={px(i)} />
            <line x1={px(i)} y1={px(0)} x2={px(i)} y2={px(SIZE - 1)} />
          </g>
        ))}
        {STAR_POINTS.map(([r, c]) => (
          <circle key={`${r}-${c}`} cx={px(c)} cy={px(r)} r={4.5} fill="#1f1147" />
        ))}
        {Array.from({ length: SIZE }, (_, i) => (
          <g key={`label-${i}`} fontSize={12} fontWeight={600} fill="#1f1147" opacity={0.55} fontFamily="var(--font-mono)" textAnchor="middle">
            <text x={px(i)} y={14}>
              {COLS[i]}
            </text>
            <text x={12} y={px(i) + 4}>
              {SIZE - i}
            </text>
          </g>
        ))}

        {match.history.map((index) => (
          <Stone
            key={index}
            row={Math.floor(index / SIZE)}
            col={index % SIZE}
            black={match.board[index] === BLACK}
            order={orderOf.get(index) ?? 0}
            animate
          />
        ))}

        {last !== undefined && !match.winLine && (
          <circle cx={px(last % SIZE)} cy={px(Math.floor(last / SIZE))} r={STEP * 0.56} fill="none" stroke="#ff5d8f" strokeWidth={3.5} strokeDasharray="6 5" />
        )}
        {match.winLine?.map((index) => (
          <circle key={`win-${index}`} className="win-ring" cx={px(index % SIZE)} cy={px(Math.floor(index / SIZE))} r={STEP * 0.56} fill="none" stroke="#ff5d8f" />
        ))}

        {canClick && hover !== null && !match.board[hover] && (
          <circle
            cx={px(hover % SIZE)}
            cy={px(Math.floor(hover / SIZE))}
            r={STEP * 0.43}
            fill={humanStone === BLACK ? '#2a1a5e' : '#ffffff'}
            stroke="#1f1147"
            strokeWidth={2.5}
            opacity={0.5}
            pointerEvents="none"
          />
        )}
        {canClick &&
          Array.from({ length: SIZE * SIZE }, (_, index) =>
            match.board[index] ? null : (
              <rect
                key={`hit-${index}`}
                x={px(index % SIZE) - STEP / 2}
                y={px(Math.floor(index / SIZE)) - STEP / 2}
                width={STEP}
                height={STEP}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onPointerEnter={() => setHover(index)}
                onPointerLeave={() => setHover((h) => (h === index ? null : h))}
                onClick={() => {
                  setHover(null);
                  match.click(index);
                }}
              >
                <title>{cellId(index)}</title>
              </rect>
            ),
          )}
      </svg>
    </div>
  );
}

function seatRows(seat: GomokuSeat): StatRow[] {
  if (seat.human) return [[t('stat.stones'), seat.moves]];
  // Turn-based: there is no deadline to miss, and an invalid answer shows up as a fallback.
  return [[t('stat.stones'), seat.moves], [t('stat.calls'), seat.stats.calls], [t('stat.fallbacks'), seat.stats.invalid + seat.stats.errors], ...modelStatRows(seat.stats, false)];
}

function SeatPanel({ seat, match }: { seat: GomokuSeat; match: GomokuMatch }) {
  const toMove = match.status === 'running' && match.turn === seat.index;
  const won = match.result?.winner === seat.index;
  return (
    <section className={`toy flex w-full flex-col gap-3 p-4 transition-transform lg:w-72 ${toMove ? '!bg-sun/40 lg:-translate-y-1' : ''}`}>
      <PlayerBadge
        player={seat.player}
        thinking={seat.thinking}
        move={seat.move}
        tag={
          <span className="flex shrink-0 items-center gap-1">
            <span className={`inline-block size-4 rounded-full border-2 border-ink ${seat.stone === BLACK ? 'bg-night' : 'bg-white'}`} title={t(seat.stone === BLACK ? 'gomoku.black' : 'gomoku.white')} />
            {won && <span className="rounded-full border-2 border-ink bg-sun px-2 text-xs font-bold">{t('arena.winner')}</span>}
          </span>
        }
      />
      <StatsGrid rows={seatRows(seat)} cols={2} />
    </section>
  );
}

function compareRows(A: GomokuSeat, B: GomokuSeat): CompareRow[] {
  const both = (label: string, f: (s: GomokuSeat) => React.ReactNode): CompareRow => [label, f(A), f(B)];
  return [
    both(t('cmp.stone'), (s) => t(s.stone === BLACK ? 'cmp.black' : 'cmp.white')),
    both(t('cmp.stonesPlayed'), (s) => s.moves),
    both(t('stat.avgLatency'), (s) => (s.stats.latency ? fmtMs(s.stats.latency / s.stats.calls) : '–')),
    both(t('cmp.botFallbacks'), (s) => (s.human ? '–' : s.stats.invalid + s.stats.errors)),
    both(t('cmp.tokensInOut'), (s) => (s.stats.inputTokens ? `${s.stats.inputTokens.toLocaleString()} / ${s.stats.outputTokens.toLocaleString()}` : '–')),
    both(t('stat.cost'), (s) => fmtUsd(s.stats.cost)),
    both(t('cmp.costPerMove'), (s) => (s.stats.calls && s.stats.cost ? fmtUsd(s.stats.cost / s.stats.calls, 5) : '–')),
  ];
}

export function GomokuArena({
  seats,
  options,
  onRematch,
  onSetup,
  onLobby,
}: {
  seats: [PlayerConfig, PlayerConfig];
  options: GomokuOptions;
  onRematch: () => void;
  onSetup: () => void;
  onLobby: () => void;
}) {
  const players = useMemo(() => seats.map(createPlayer) as [Player, Player], [seats]);
  const { match, count } = useMatch((onChange) => new GomokuMatch(players, options, onChange, (event) => sfx.play(event.stone === BLACK ? 'stoneBlack' : 'stoneWhite')));
  const [, setClock] = useState(0);
  const [resultOpen, setResultOpen] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 500);
    return () => clearInterval(id);
  }, []);

  const result = match?.result ?? null;
  useEffect(() => {
    const jingle = result && resultJingle(result, [seats[0].kind === 'human', seats[1].kind === 'human']);
    if (jingle) sfx.play(jingle);
  }, [result, seats]);

  if (!match) return null;
  const [A, B] = match.seats;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-5 px-4 pb-10">
      <Countdown value={count} />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <span className="toy-sm px-4 py-1 font-mono text-2xl font-bold">{formatClock(match.elapsed())}</span>
        <span className="toy-sm !bg-sun px-3 py-1 text-sm font-bold">{t('gomoku.move', { n: match.history.length + (match.status === 'done' ? 0 : 1) })}</span>
        <span className="toy-sm px-3 py-1 text-sm font-bold">{t('gomoku.fiveWins')}</span>
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
        <Board match={match} />
        <SeatPanel seat={B} match={match} />
      </div>

      {match.result && resultOpen && (
        <ResultCard
          headline={match.result.reason}
          detail={t('detail.gomoku', { clock: formatClock(match.result.elapsedMs), n: match.history.length })}
          players={players}
          winner={match.result.winner}
          rows={compareRows(A, B)}
          onRematch={onRematch}
          onSetup={onSetup}
          onLobby={onLobby}
          onClose={() => setResultOpen(false)}
        />
      )}
    </div>
  );
}
