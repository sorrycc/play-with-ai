// Small shared pieces: avatar, thinking bubble, stats grid, confetti, the ending banner and result card.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Player, PlayerStats } from '../core/types';
import { fmtMs, fmtUsd } from '../core/types';
import { sfx, type SfxName } from '../core/sound';
import { t } from '../core/i18n';

type Ended = { winner: 0 | 1 | null; stopped: boolean };

export type Outcome = 'victory' | 'defeat' | 'draw' | 'spectate';

/**
 * How a finished match feels, or null for one that was stopped. With a person playing it is their
 * victory or defeat; with two people, or none, somebody won and that is worth celebrating anyway.
 */
export function resultOutcome(result: Ended, humans: [boolean, boolean]): Outcome | null {
  if (result.stopped) return null;
  if (result.winner === null) return 'draw';
  if (humans[0] === humans[1]) return 'spectate';
  return humans[result.winner] ? 'victory' : 'defeat';
}

const JINGLES: Record<Outcome, SfxName> = { victory: 'win', spectate: 'win', defeat: 'lose', draw: 'draw' };

/** The class for a seat's panel once the match is over: the winner bounces and glows, the loser slumps. */
export function seatMood(result: Ended | null | undefined, index: 0 | 1): string {
  if (!result || result.stopped || result.winner === null) return '';
  return result.winner === index ? 'seat-win' : 'seat-lose';
}

/** A player's mark: its logo in its own colour when it has one, its emoji otherwise. */
export function Mark({ player, size = '1em' }: { player: Pick<Player, 'emoji' | 'color' | 'logo'>; size?: number | string }) {
  if (!player.logo) return <>{player.emoji}</>;
  const mask = `url(${player.logo}) center / contain no-repeat`;
  return <span className="inline-block shrink-0 align-middle" style={{ width: size, height: size, background: player.color, mask, WebkitMask: mask }} aria-hidden />;
}

export function Avatar({ player, size = 56, thinking = false }: { player: Pick<Player, 'emoji' | 'color' | 'logo'>; size?: number; thinking?: boolean }) {
  return (
    <div
      className={`grid shrink-0 place-items-center rounded-full border-[3px] border-ink shadow-[3px_3px_0_var(--color-ink)] ${thinking ? 'wiggle' : ''}`}
      style={{ width: size, height: size, background: player.logo ? '#fff' : player.color, fontSize: size * 0.5 }}
      aria-hidden
    >
      <Mark player={player} size={size * 0.6} />
    </div>
  );
}

export function ThinkingDots() {
  return (
    <span className="dots" aria-label={t('arena.thinking')}>
      <span />
      <span />
      <span />
    </span>
  );
}

/** Name, avatar and a speech bubble with the last move (or dots while the player thinks). */
export function PlayerBadge({ player, thinking, move, tag, align = 'left' }: { player: Player; thinking: boolean; move: string; tag?: ReactNode; align?: 'left' | 'right' }) {
  const flip = align === 'right';
  return (
    <div className={`flex items-center gap-3 ${flip ? 'flex-row-reverse text-right' : ''}`}>
      <Avatar player={player} thinking={thinking} />
      <div className="min-w-0 flex-1">
        <div className={`flex items-center gap-2 ${flip ? 'flex-row-reverse' : ''}`}>
          <span className="truncate text-lg font-bold leading-tight">{player.name}</span>
          {tag}
        </div>
        <div
          className={`mt-1 inline-block max-w-full rounded-2xl border-2 border-ink bg-white px-3 py-1 text-left text-xs leading-snug ${flip ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}
          title={move}
        >
          {thinking ? (
            <span className="flex items-center gap-1 text-grape">
              {t('arena.thinking')} <ThinkingDots />
            </span>
          ) : (
            <span className="line-clamp-2 break-words">{move}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export type StatRow = [label: string, value: ReactNode];

export function StatsGrid({ rows, cols = 3 }: { rows: StatRow[]; cols?: 2 | 3 }) {
  return (
    <dl className={`grid gap-1.5 text-center ${cols === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-xl border-2 border-ink/80 bg-white px-1 py-1">
          <dt className="text-[10px] font-medium uppercase tracking-wide opacity-60">{label}</dt>
          <dd className="truncate font-mono text-sm font-bold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Rows every model-backed seat shares, whatever the game. `timed` adds the missed-deadline and invalid counts. */
export function modelStatRows(s: PlayerStats, timed = true): StatRow[] {
  return modelRows(s).filter((_, i) => timed || (i !== 1 && i !== 2));
}

function modelRows(s: PlayerStats): StatRow[] {
  return [
    [t('stat.avgLatency'), s.latency ? fmtMs(s.latency / s.calls) : '–'],
    [t('stat.missed'), s.missed],
    [t('stat.invalid'), s.invalid + s.errors],
    [t('stat.tokensIn'), s.inputTokens.toLocaleString()],
    [t('stat.tokensOut'), s.outputTokens.toLocaleString()],
    [t('stat.cost'), fmtUsd(s.cost)],
  ];
}

const CONFETTI_COLORS = ['#ff5d8f', '#ffd23f', '#3ddc97', '#4cc9f0', '#7c5cff', '#ff9f1c'];

/** Confetti raining from the top, or with `burst`, shot up out of the two bottom corners. */
export function Confetti({ pieces = 90, burst = false }: { pieces?: number; burst?: boolean }) {
  const bits = useMemo(
    () =>
      Array.from({ length: pieces }, (_, i) => {
        const side = i % 2 === 0 ? 1 : -1;
        return {
          left: burst ? (side === 1 ? '3vw' : '97vw') : `${Math.random() * 100}vw`,
          background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
          '--dx': burst ? `${side * (8 + Math.random() * 55)}vw` : `${(Math.random() - 0.5) * 30}vw`,
          '--dy': `${-(35 + Math.random() * 60)}vh`,
          '--rot': `${(Math.random() - 0.5) * 1800}deg`,
          '--t': burst ? `${1.3 + Math.random() * 0.9}s` : `${2.4 + Math.random() * 2.2}s`,
          '--delay': burst ? `${0.1 + Math.random() * 0.25}s` : `${Math.random() * 0.6}s`,
          borderRadius: i % 3 === 0 ? '50%' : '3px',
        };
      }),
    [pieces, burst],
  );
  return (
    <>
      {bits.map((style, i) => (
        <i key={i} className={burst ? 'confetti confetti-burst' : 'confetti'} style={style as React.CSSProperties} />
      ))}
    </>
  );
}

const BANNER_MS = 1800;
/** Keys and clicks from the last frantic moves of a game should not skip the banner. */
const BANNER_SKIP_AFTER_MS = 500;

/** The big moment before the numbers: VICTORY, DEFEAT, a draw, or the winner's name. Any key or click skips it. */
export function ResultBanner({ outcome, winner, headline, onDone }: { outcome: Outcome; winner: Player | null; headline: string; onDone: () => void }) {
  useEffect(() => {
    const shownAt = performance.now();
    const skip = () => {
      if (performance.now() - shownAt > BANNER_SKIP_AFTER_MS) onDone();
    };
    const timer = setTimeout(onDone, BANNER_MS);
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [onDone]);

  const lost = outcome === 'defeat';
  const won = outcome === 'victory' || outcome === 'spectate';
  const title = outcome === 'spectate' && winner ? t('banner.wins', { name: winner.short }) : t(lost ? 'banner.defeat' : outcome === 'draw' ? 'banner.draw' : 'banner.victory');
  return (
    <div className={`banner fixed inset-0 z-50 grid cursor-pointer place-items-center overflow-hidden p-4 ${lost ? 'banner-lost' : 'bg-ink/55'}`} role="status">
      {won && <div className="rays" aria-hidden />}
      {won && <Confetti burst pieces={120} />}
      <div className={`relative flex flex-col items-center text-center ${lost ? 'shake [animation-delay:0.22s]' : ''}`}>
        <div className={`text-7xl ${won ? 'trophy-bounce' : lost ? 'wiggle' : 'pop-in'}`} aria-hidden>
          {outcome === 'spectate' && winner ? <Avatar player={winner} size={96} /> : lost ? '💔' : outcome === 'draw' ? '🤝' : '🏆'}
        </div>
        <div
          className={`mt-3 font-bold leading-none [-webkit-text-stroke:5px_var(--color-ink)] [paint-order:stroke_fill] ${outcome === 'spectate' ? 'text-[clamp(2.5rem,9vw,6rem)]' : 'text-[clamp(3.5rem,14vw,9rem)]'} ${lost ? 'banner-drop text-[#b9b3d6]' : 'banner-slam'} ${won ? 'text-sun' : ''} ${outcome === 'draw' ? 'text-sky' : ''}`}
          style={outcome === 'spectate' && winner ? { color: winner.color } : undefined}
        >
          {title}
        </div>
        <p className="pop-in mt-4 max-w-xl text-lg font-bold text-white [animation-delay:0.5s]">{headline}</p>
        {lost && <p className="pop-in mt-2 rounded-full border-2 border-ink bg-sun px-4 py-1 text-sm font-bold [animation-delay:0.95s]">{t('banner.retry')}</p>}
      </div>
    </div>
  );
}

export type CompareRow = [label: string, left: ReactNode, right: ReactNode];

export function ResultCard({
  headline,
  detail,
  players,
  winner,
  outcome,
  rows,
  onRematch,
  onSetup,
  onLobby,
  onClose,
}: {
  headline: string;
  detail: string;
  players: [Player, Player];
  winner: 0 | 1 | null;
  /** Null for a stopped match: no verdict, just the numbers. */
  outcome: Outcome | null;
  rows: CompareRow[];
  onRematch: () => void;
  onSetup: () => void;
  onLobby: () => void;
  onClose: () => void;
}) {
  const lost = outcome === 'defeat';
  const won = outcome === 'victory' || outcome === 'spectate';
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/45 p-4 backdrop-blur-[2px]" onClick={onClose}>
      {won && <Confetti />}
      <div className="toy pop-in w-full max-w-xl p-6" role="dialog" aria-modal="true" aria-label={t('result.label')} onClick={(e) => e.stopPropagation()}>
        <div className="text-center">
          <div className={`inline-block text-5xl ${won ? 'trophy-glow trophy-bounce' : ''}`}>{lost ? '💔' : won ? '🏆' : '🤝'}</div>
          {outcome && outcome !== 'spectate' && (
            <div>
              <span className={`inline-block rounded-full border-2 border-ink px-3 text-sm font-bold ${lost ? 'bg-ink/15' : outcome === 'draw' ? 'bg-sky' : 'bg-sun'}`}>
                {t(lost ? 'banner.defeat' : outcome === 'draw' ? 'banner.draw' : 'banner.victory')}
              </span>
            </div>
          )}
          <h2 className="mt-2 text-2xl font-bold leading-tight">{headline}</h2>
          <p className="mt-1 text-sm opacity-70">{detail}</p>
        </div>
        <table className="mt-5 w-full table-fixed border-separate border-spacing-y-1 text-sm">
          <thead>
            <tr>
              <th className="w-[34%]" />
              {players.map((p, i) => (
                <th key={i} className="px-2 pb-1 text-center font-bold">
                  <span className={`inline-flex max-w-full items-center gap-1 rounded-full border-2 border-ink px-2 py-0.5 ${winner === i ? 'bg-sun' : 'bg-white'}`}>
                    <Mark player={p} />
                    <span className="truncate">{p.short}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, left, right]) => (
              <tr key={label} className="bg-paper">
                <th className="rounded-l-xl px-3 py-1 text-left text-xs font-medium opacity-70">{label}</th>
                <td className="px-2 py-1 text-center font-mono font-bold">{left}</td>
                <td className="rounded-r-xl px-2 py-1 text-center font-mono font-bold">{right}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button className={`btn bg-mint ${lost ? 'wiggle' : ''}`} onClick={onRematch}>
            {t('result.rematch')}
          </button>
          <button className="btn bg-sun" onClick={onSetup}>
            {t('result.change')}
          </button>
          <button className="btn bg-white" onClick={onLobby}>
            {t('result.lobby')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Everything that happens when a match ends: the jingle, the banner, then the result card. `open`
 * only governs the card, so closing it and reopening it from the arena never replays the banner.
 */
export function MatchEnding({
  result,
  humans,
  open,
  ...card
}: {
  result: (Ended & { reason: string }) | null;
  humans: [boolean, boolean];
  open: boolean;
} & Omit<Parameters<typeof ResultCard>[0], 'headline' | 'winner' | 'outcome'>) {
  const [bannerDone, setBannerDone] = useState(false);
  const endBanner = useCallback(() => setBannerDone(true), []);
  const outcome = result && resultOutcome(result, humans);

  useEffect(() => {
    if (!outcome) return;
    sfx.play('slam');
    sfx.play(JINGLES[outcome]);
  }, [outcome]);

  if (!result) return null;
  // With reduced motion the banner's animations collapse to nothing, so go straight to the card.
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (outcome && !bannerDone && !still) {
    return <ResultBanner outcome={outcome} winner={result.winner === null ? null : card.players[result.winner]} headline={result.reason} onDone={endBanner} />;
  }
  return open ? <ResultCard {...card} headline={result.reason} winner={result.winner} outcome={outcome} /> : null;
}

/** "3, 2, 1, GO!" before a match; re-keyed so the animation restarts on every number. */
export function Countdown({ value }: { value: number | null }) {
  if (value === null) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center">
      <div key={value} className="count text-[9rem] font-bold leading-none text-sun [-webkit-text-stroke:5px_var(--color-ink)] [paint-order:stroke_fill]">
        {value === 0 ? 'GO!' : value}
      </div>
    </div>
  );
}
