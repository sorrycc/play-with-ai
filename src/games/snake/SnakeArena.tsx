import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../core/i18n';
import { sfx } from '../../core/sound';
import type { Player, PlayerConfig } from '../../core/types';
import { fmtMs, fmtUsd, formatClock } from '../../core/types';
import { createPlayer } from '../../players';
import { Countdown, PlayerBadge, MatchEnding, StatsGrid, modelStatRows, seatMood, type CompareRow, type StatRow } from '../../ui/bits';
import { useMatch } from '../../ui/useMatch';
import { SEAT_COLORS, drawDuel } from './draw';
import type { Dir } from './engine';
import { SnakeMatch, type SnakeOptions, type SnakeSeat } from './match';

const MAX_BOARD_W = 640;

type KeyMap = Record<string, Dir>;
const KEYS_ARROWS: KeyMap = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left' };
const KEYS_WASD: KeyMap = { w: 'up', d: 'right', s: 'down', a: 'left' };

function Board({ match }: { match: SnakeMatch }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(MAX_BOARD_W);
  const { cols, rows } = match.state;
  const height = (width / cols) * rows;

  // The grid keeps its aspect ratio and shrinks with the column it sits in.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setWidth(Math.max(240, Math.min(MAX_BOARD_W, Math.floor(el.clientWidth))));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let raf = 0;
    const frame = () => {
      drawDuel(ctx, match, width, height, performance.now());
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [match, width, height]);

  return (
    <div ref={wrap} className="w-full min-w-0" style={{ maxWidth: MAX_BOARD_W + 8 }}>
      <div className="bezel" style={{ width: width + 8 }}>
        <canvas ref={canvas} style={{ width, height, display: 'block' }} role="img" aria-label={t('snake.boardLabel')} />
      </div>
    </div>
  );
}

function seatRows(seat: SnakeSeat, match: SnakeMatch): StatRow[] {
  const snake = match.state.snakes[seat.index];
  const base: StatRow[] = [
    [t('stat.length'), snake.body.length],
    [t('stat.eaten'), snake.eaten],
  ];
  if (seat.human) return base;
  return [...base, [t('stat.calls'), seat.stats.calls], [t('stat.late'), seat.late], [t('stat.fallbacks'), seat.stats.invalid + seat.stats.errors], ...modelStatRows(seat.stats, false)];
}

function SeatPanel({ seat, match, keysHint }: { seat: SnakeSeat; match: SnakeMatch; keysHint: string | null }) {
  const snake = match.state.snakes[seat.index];
  const won = match.result?.winner === seat.index;
  const steer = (dir: Dir) => (e: React.PointerEvent) => {
    e.preventDefault();
    match.input(seat.index, dir);
  };
  return (
    <section className={`toy flex w-full flex-col gap-3 p-4 lg:w-72 ${seatMood(match.result, seat.index)}`}>
      <PlayerBadge
        player={seat.player}
        thinking={seat.thinking}
        move={seat.move}
        tag={
          <span className="flex shrink-0 items-center gap-1">
            <span className="inline-block size-4 rounded-full border-2 border-ink" style={{ background: SEAT_COLORS[seat.index] }} />
            {won && <span className="rounded-full border-2 border-ink bg-sun px-2 text-xs font-bold">{t('arena.winner')}</span>}
            {!snake.alive && <span className="rounded-full border-2 border-ink bg-pink px-2 text-xs font-bold text-white">{t('arena.crashed')}</span>}
          </span>
        }
      />
      {seat.human && (
        <div className="flex flex-col items-center gap-1.5">
          <div className="grid grid-cols-3 gap-1.5">
            {(
              [
                [null, null],
                ['up', '▲'],
                [null, null],
                ['left', '◀'],
                ['down', '▼'],
                ['right', '▶'],
              ] as [Dir | null, string | null][]
            ).map(([dir, glyph], n) =>
              dir ? (
                <button key={dir} className="btn bg-white !px-4 !py-2 text-lg" onPointerDown={steer(dir)} aria-label={dir} data-silent>
                  {glyph}
                </button>
              ) : (
                <span key={n} />
              ),
            )}
          </div>
          {keysHint && <p className="text-center text-xs opacity-60">{keysHint}</p>}
        </div>
      )}
      <StatsGrid rows={seatRows(seat, match)} cols={2} />
    </section>
  );
}

function compareRows(match: SnakeMatch): CompareRow[] {
  const [A, B] = match.seats;
  const both = (label: string, f: (s: SnakeSeat) => React.ReactNode): CompareRow => [label, f(A), f(B)];
  return [
    both(t('stat.length'), (s) => match.state.snakes[s.index].body.length),
    both(t('stat.eaten'), (s) => match.state.snakes[s.index].eaten),
    both(t('stat.avgLatency'), (s) => (s.stats.latency ? fmtMs(s.stats.latency / s.stats.calls) : '–')),
    both(t('cmp.missedDeadlines'), (s) => (s.human ? '–' : s.late)),
    both(t('cmp.botFallbacks'), (s) => (s.human ? '–' : s.stats.invalid + s.stats.errors)),
    both(t('cmp.tokensInOut'), (s) => (s.stats.inputTokens ? `${s.stats.inputTokens.toLocaleString()} / ${s.stats.outputTokens.toLocaleString()}` : '–')),
    both(t('stat.cost'), (s) => fmtUsd(s.stats.cost)),
    both(t('cmp.costPerMove'), (s) => (s.stats.calls && s.stats.cost ? fmtUsd(s.stats.cost / s.stats.calls, 5) : '–')),
  ];
}

export function SnakeArena({
  seats,
  options,
  onRematch,
  onSetup,
  onLobby,
}: {
  seats: [PlayerConfig, PlayerConfig];
  options: SnakeOptions;
  onRematch: () => void;
  onSetup: () => void;
  onLobby: () => void;
}) {
  const players = useMemo(() => seats.map(createPlayer) as [Player, Player], [seats]);
  const { match, count } = useMatch(
    (onChange) =>
      new SnakeMatch(players, options, onChange, (event) => {
        const pan = event.seat === 0 ? -0.4 : 0.4;
        if (event.type === 'eat') sfx.play('eat', { pan });
        else if (event.type === 'die') sfx.play('crash', { pan });
        else sfx.play('move', { pan });
      }),
  );
  const [, setClock] = useState(0);
  const [resultOpen, setResultOpen] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 250);
    return () => clearInterval(id);
  }, []);

  const humans = seats.filter((s) => s.kind === 'human').length;
  useEffect(() => {
    if (!match || humans === 0) return;
    // One person gets both key sets. Two people split the keyboard: WASD on the left, arrows on the right.
    const solo = { ...KEYS_ARROWS, ...KEYS_WASD };
    const maps: [KeyMap | null, KeyMap | null] = humans === 2 ? [KEYS_WASD, KEYS_ARROWS] : [seats[0].kind === 'human' ? solo : null, seats[1].kind === 'human' ? solo : null];
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      maps.forEach((map, index) => {
        const dir = map?.[key];
        if (!dir) return;
        e.preventDefault();
        match.input(index as 0 | 1, dir);
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [match, humans, seats]);

  if (!match) return null;
  const [A, B] = match.seats;
  const hint = (index: 0 | 1) => t(humans === 2 ? (index === 0 ? 'keys.snakeLeft' : 'keys.snakeRight') : 'keys.snakeSolo');

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-5 px-4 pb-10">
      <Countdown value={count} />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <span className="toy-sm px-4 py-1 font-mono text-2xl font-bold">
          {formatClock(match.elapsed())}
          {options.timeLimitSec > 0 && <span className="text-sm opacity-50"> / {formatClock(options.timeLimitSec * 1000)}</span>}
        </span>
        <span className="toy-sm !bg-sun px-3 py-1 text-sm font-bold">{t('snake.step', { n: match.state.steps })}</span>
        <span className="toy-sm px-3 py-1 text-sm font-bold">
          {options.lockstep ? `🧘 ${t('mode.lockstep')} · ` : ''}
          <span className="font-mono">{t('snake.tick', { ms: match.tickMs })}</span>
        </span>
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
        <SeatPanel seat={A} match={match} keysHint={A.human ? hint(0) : null} />
        <Board match={match} />
        <SeatPanel seat={B} match={match} keysHint={B.human ? hint(1) : null} />
      </div>

      {match.result && (
        <MatchEnding
          result={match.result}
          humans={[seats[0].kind === 'human', seats[1].kind === 'human']}
          open={resultOpen}
          detail={t('detail.snake', { clock: formatClock(match.result.elapsedMs), n: match.state.steps, seed: options.seed })}
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
