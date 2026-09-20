import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../core/i18n';
import { sfx } from '../../core/sound';
import type { Player, PlayerConfig } from '../../core/types';
import { fmtMs, fmtUsd, formatClock } from '../../core/types';
import { createPlayer } from '../../players';
import { Countdown, PlayerBadge, ResultCard, StatsGrid, modelStatRows, resultJingle, type CompareRow, type StatRow } from '../../ui/bits';
import { useMatch } from '../../ui/useMatch';
import { N, type Dir } from './engine';
import { Match2048, type Options2048, type Side2048 } from './match';

const BOARD = 300;
const GAP = 8;
const CELL = (BOARD - GAP * (N + 1)) / N;
const SWIPE_PX = 24;

const at = (index: number) => ({ x: GAP + (index % N) * (CELL + GAP), y: GAP + Math.floor(index / N) * (CELL + GAP) });

// Candy colours that warm up, then cool down towards 2048.
const TILE_STYLE: Record<number, [background: string, color: string]> = {
  2: ['#fff3d6', '#1f1147'],
  4: ['#ffe3a3', '#1f1147'],
  8: ['#ffb86b', '#1f1147'],
  16: ['#ff9f40', '#ffffff'],
  32: ['#ff7a59', '#ffffff'],
  64: ['#ff5d73', '#ffffff'],
  128: ['#ffd23f', '#1f1147'],
  256: ['#a5e65a', '#1f1147'],
  512: ['#3ddc97', '#1f1147'],
  1024: ['#4cc9f0', '#1f1147'],
  2048: ['#7c5cff', '#ffffff'],
};
const tileStyle = (value: number) => TILE_STYLE[value] ?? ['#1f1147', '#ffd23f'];

type KeyMap = Record<string, Dir>;
const KEYS_ARROWS: KeyMap = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left' };
const KEYS_WASD: KeyMap = { w: 'up', d: 'right', s: 'down', a: 'left' };

function BoardView({ side, match }: { side: Side2048; match: Match2048 }) {
  const press = useRef<{ x: number; y: number } | null>(null);
  const onPointerUp = (e: React.PointerEvent) => {
    const start = press.current;
    press.current = null;
    if (!start || !side.human) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    match.input(side.index, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
  };
  return (
    <div
      className="bezel relative touch-none select-none"
      style={{ width: BOARD + 8, height: BOARD + 8 }}
      role="img"
      aria-label={t('t.boardLabel')}
      onPointerDown={(e) => (press.current = { x: e.clientX, y: e.clientY })}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (press.current = null)}
    >
      {Array.from({ length: N * N }, (_, i) => (
        <div key={i} className="absolute rounded-xl bg-white/[0.07]" style={{ width: CELL, height: CELL, left: at(i).x, top: at(i).y }} />
      ))}
      {side.tiles.map((tile) => {
        const { x, y } = at(tile.index);
        const [background, color] = tileStyle(tile.value);
        const digits = String(tile.value).length;
        return (
          // The outer box slides (a CSS transition on transform); the inner one pops when new.
          <div key={tile.id} className="absolute left-0 top-0 transition-transform duration-[120ms] ease-out" style={{ width: CELL, height: CELL, transform: `translate(${x}px, ${y}px)`, zIndex: tile.dying ? 1 : 2 }}>
            <div
              className={`grid size-full place-items-center rounded-xl border-[3px] border-ink font-bold shadow-[0_3px_0_rgba(0,0,0,0.25)] ${tile.born ? 'tile-pop' : ''}`}
              style={{ background, color, fontSize: digits >= 4 ? 20 : digits === 3 ? 25 : 30, opacity: side.over ? 0.55 : 1 }}
            >
              {tile.value}
            </div>
          </div>
        );
      })}
      {side.over && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-night/55">
          <div className="pop-in -rotate-6 rounded-2xl border-[3px] border-ink bg-pink px-4 py-2 text-xl font-bold text-white shadow-[4px_4px_0_var(--color-ink)]">{t('arena.stuck')}</div>
        </div>
      )}
    </div>
  );
}

function sideRows(side: Side2048): StatRow[] {
  const base: StatRow[] = [
    [t('stat.score'), side.score.toLocaleString()],
    [t('stat.bestTile'), side.best],
    [t('stat.moves'), side.moves],
  ];
  if (side.human) return base;
  return [...base, [t('stat.calls'), side.stats.calls], [t('stat.fallbacks'), side.stats.invalid + side.stats.errors], ...modelStatRows(side.stats, false)];
}

function SideView({ side, match, keysHint }: { side: Side2048; match: Match2048; keysHint: string | null }) {
  const won = match.result?.winner === side.index;
  const leading = match.sides[side.index === 0 ? 1 : 0].score < side.score;
  return (
    <section className="flex w-full max-w-[320px] flex-col gap-3">
      <PlayerBadge
        player={side.player}
        thinking={side.thinking}
        move={side.move}
        align={side.index === 1 ? 'right' : 'left'}
        tag={won ? <span className="rounded-full border-2 border-ink bg-sun px-2 text-xs font-bold">{t('arena.winner')}</span> : undefined}
      />
      <div className={`toy-sm flex items-baseline justify-between px-4 py-1 transition-colors ${leading ? '!bg-sun' : ''}`}>
        <span className="text-xs font-bold uppercase tracking-widest opacity-60">{t('stat.score')}</span>
        <span className="font-mono text-3xl font-bold">{side.score.toLocaleString()}</span>
      </div>
      <BoardView side={side} match={match} />
      {keysHint && <p className="text-center text-xs opacity-60">{keysHint}</p>}
      <StatsGrid rows={sideRows(side)} />
    </section>
  );
}

function compareRows(match: Match2048): CompareRow[] {
  const [A, B] = match.sides;
  const minutes = Math.max(match.elapsed() / 60000, 1 / 60);
  const both = (label: string, f: (s: Side2048) => React.ReactNode): CompareRow => [label, f(A), f(B)];
  return [
    both(t('stat.score'), (s) => s.score.toLocaleString()),
    both(t('stat.bestTile'), (s) => s.best),
    both(t('stat.moves'), (s) => s.moves),
    both(t('cmp.movesPerMin'), (s) => Math.round(s.moves / minutes)),
    both(t('stat.avgLatency'), (s) => (s.stats.latency ? fmtMs(s.stats.latency / s.stats.calls) : '–')),
    both(t('cmp.botFallbacks'), (s) => (s.human ? '–' : s.stats.invalid + s.stats.errors)),
    both(t('cmp.tokensInOut'), (s) => (s.stats.inputTokens ? `${s.stats.inputTokens.toLocaleString()} / ${s.stats.outputTokens.toLocaleString()}` : '–')),
    both(t('stat.cost'), (s) => fmtUsd(s.stats.cost)),
    both(t('cmp.costPerMove'), (s) => (s.stats.calls && s.stats.cost ? fmtUsd(s.stats.cost / s.stats.calls, 5) : '–')),
  ];
}

export function Arena2048({
  seats,
  options,
  onRematch,
  onSetup,
  onLobby,
}: {
  seats: [PlayerConfig, PlayerConfig];
  options: Options2048;
  onRematch: () => void;
  onSetup: () => void;
  onLobby: () => void;
}) {
  const players = useMemo(() => seats.map(createPlayer) as [Player, Player], [seats]);
  const { match, count } = useMatch(
    (onChange) =>
      new Match2048(players, options, onChange, (event) => {
        const pan = event.side === 0 ? -0.5 : 0.5;
        const mine = seats[event.side].kind === 'human';
        if (event.type === 'merge') sfx.play('merge', { pan, volume: mine ? 1 : 0.6 });
        else if (event.type === 'slide') sfx.play('move', { pan, volume: mine ? 1 : 0.5 });
        else if (event.type === 'milestone') sfx.play(event.value === 2048 ? 'clear4' : 'levelup', { pan });
        else sfx.play('topout', { pan });
      }),
  );
  const [, setClock] = useState(0);
  const [resultOpen, setResultOpen] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 250);
    return () => clearInterval(id);
  }, []);

  const result = match?.result ?? null;
  useEffect(() => {
    const jingle = result && resultJingle(result, [seats[0].kind === 'human', seats[1].kind === 'human']);
    if (jingle) sfx.play(jingle);
  }, [result, seats]);

  const humans = seats.filter((s) => s.kind === 'human').length;
  useEffect(() => {
    if (!match || humans === 0) return;
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
  const [A, B] = match.sides;
  const hint = (index: 0 | 1) => t(humans === 2 ? (index === 0 ? 'keys.2048Left' : 'keys.2048Right') : 'keys.2048Solo');

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-5 px-4 pb-10">
      <Countdown value={count} />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <span className="toy-sm px-4 py-1 font-mono text-2xl font-bold">
          {formatClock(match.elapsed())}
          {options.timeLimitSec > 0 && <span className="text-sm opacity-50"> / {formatClock(options.timeLimitSec * 1000)}</span>}
        </span>
        <span className="toy-sm !bg-sun px-3 py-1 text-sm font-bold">{t('t.highestWins')}</span>
        <span className="toy-sm px-3 py-1 text-sm font-bold">{t('arena.seed', { n: options.seed })}</span>
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

      <div className="flex w-full flex-wrap items-start justify-center gap-x-12 gap-y-8">
        <SideView side={A} match={match} keysHint={A.human ? hint(0) : null} />
        <div className="hidden self-center text-5xl font-bold text-pink [-webkit-text-stroke:2px_var(--color-ink)] lg:block">VS</div>
        <SideView side={B} match={match} keysHint={B.human ? hint(1) : null} />
      </div>

      {match.result && resultOpen && (
        <ResultCard
          headline={match.result.reason}
          detail={t('detail.2048', { clock: formatClock(match.result.elapsedMs), seed: options.seed })}
          players={players}
          winner={match.result.winner}
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
