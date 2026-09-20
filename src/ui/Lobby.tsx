import { useSyncExternalStore } from 'react';
import { t } from '../core/i18n';
import { settings, sortGames } from '../core/settings';
import type { GameId } from '../core/types';

/** Title, subtitle, blurb and tags come from i18n: `game.<id>.*`. */
export interface GameInfo {
  id: GameId;
  color: string;
}

export const GAMES: GameInfo[] = [
  { id: 'tetris', color: 'var(--color-sky)' },
  { id: 'gomoku', color: 'var(--color-mint)' },
  { id: 'snake', color: 'var(--color-sun)' },
  { id: '2048', color: '#ffb3c7' },
  { id: 'chess', color: '#d5ccff' },
  { id: 'xiangqi', color: '#ffd9a0' },
  { id: 'code', color: '#bfe3ff' },
];

function TetrisArt({ className }: { className: string }) {
  const cells: [number, number, string][] = [
    [0, 3, '#ff5d73'], [1, 3, '#ff5d73'], [1, 2, '#ff5d73'], [2, 2, '#ff5d73'],
    [2, 3, '#ffd23f'], [3, 3, '#ffd23f'], [3, 2, '#ffd23f'], [4, 3, '#5b8cff'],
    [4, 2, '#5b8cff'], [4, 1, '#5b8cff'], [5, 3, '#4ee08a'],
    [2, 0, '#b56bff'], [3, 0, '#b56bff'], [4, 0, '#b56bff'], [3, -1, '#b56bff'],
  ];
  return (
    <svg viewBox="-0.2 -1.3 6.4 5.5" className={className} aria-hidden>
      {cells.map(([x, y, fill], i) => (
        <rect key={i} x={x + 0.06} y={y + 0.06} width={0.88} height={0.88} rx={0.2} fill={fill} stroke="#1f1147" strokeWidth={0.09} />
      ))}
    </svg>
  );
}

function GomokuArt({ className }: { className: string }) {
  const stones: [number, number, boolean][] = [
    [1, 3, true], [2, 2, true], [3, 1, true], [4, 0, true], [0, 4, true],
    [1, 2, false], [2, 3, false], [3, 2, false], [2, 1, false],
  ];
  return (
    <svg viewBox="-0.6 -0.6 5.2 5.2" className={className} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i} stroke="#1f1147" strokeWidth={0.05} opacity={0.6}>
          <line x1={0} y1={i} x2={4} y2={i} />
          <line x1={i} y1={0} x2={i} y2={4} />
        </g>
      ))}
      <line x1={0} y1={4} x2={4} y2={0} stroke="#ff5d8f" strokeWidth={0.22} strokeLinecap="round" opacity={0.7} />
      {stones.map(([x, y, black], i) => (
        <circle key={i} cx={x} cy={y} r={0.4} fill={black ? '#2a1a5e' : '#fff'} stroke="#1f1147" strokeWidth={0.09} />
      ))}
    </svg>
  );
}

function SnakeArt({ className }: { className: string }) {
  const body = (points: string, color: string, dark: string) => (
    <>
      <polyline points={points} fill="none" stroke={dark} strokeWidth={0.86} strokeLinecap="round" strokeLinejoin="round" transform="translate(0 0.07)" />
      <polyline points={points} fill="none" stroke={color} strokeWidth={0.78} strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
  const eyes = (x: number, y: number, dx: number) => (
    <>
      {[-0.17, 0.17].map((o) => (
        <g key={o}>
          <circle cx={x + dx * 0.14} cy={y + o} r={0.12} fill="#fff" />
          <circle cx={x + dx * 0.19} cy={y + o} r={0.06} fill="#1f1147" />
        </g>
      ))}
    </>
  );
  return (
    <svg viewBox="-0.6 -0.6 8.2 5.2" className={className} aria-hidden>
      {body('0,0 2,0 2,2 3.1,2', '#3ddc97', '#178a5c')}
      {eyes(3.1, 2, 1)}
      {body('7,4 5,4 5,2.9 4.9,2', '#7c5cff', '#4a35b0')}
      <circle cx={4} cy={2} r={0.34} fill="#ff5d8f" stroke="#1f1147" strokeWidth={0.09} />
      <path d="M4 1.7 q0.2 -0.3 0.34 -0.06" fill="none" stroke="#178a5c" strokeWidth={0.12} strokeLinecap="round" />
    </svg>
  );
}

function Art2048({ className }: { className: string }) {
  const tiles: [number, number, number, string, string][] = [
    [0, 0, 2, '#fff3d6', '#1f1147'], [1, 0, 8, '#ffb86b', '#1f1147'], [2, 0, 64, '#ff5d73', '#fff'],
    [0, 1, 128, '#ffd23f', '#1f1147'], [1, 1, 512, '#3ddc97', '#1f1147'], [2, 1, 2048, '#7c5cff', '#fff'],
  ];
  return (
    <svg viewBox="-0.15 -0.15 3.3 2.3" className={className} aria-hidden>
      {tiles.map(([x, y, value, fill, ink]) => (
        <g key={value}>
          <rect x={x + 0.05} y={y + 0.05} width={0.9} height={0.9} rx={0.18} fill={fill} stroke="#1f1147" strokeWidth={0.07} />
          <text x={x + 0.5} y={y + 0.5} textAnchor="middle" dominantBaseline="central" fontWeight={700} fontSize={value > 999 ? 0.34 : value > 99 ? 0.4 : 0.5} fill={ink} fontFamily="var(--font-display)">
            {value}
          </text>
        </g>
      ))}
    </svg>
  );
}

function ChessArt({ className }: { className: string }) {
  const pieces: [number, number, string][] = [[0, 0, '♜'], [1, 0, '♞'], [2, 0, '♛'], [3, 0, '♚'], [1, 1, '♟'], [2, 2, '♙'], [0, 3, '♖'], [1, 3, '♘'], [2, 3, '♕'], [3, 3, '♔']];
  return (
    <svg viewBox="-0.1 -0.1 4.2 4.2" className={className} aria-hidden>
      <rect x={0} y={0} width={4} height={4} rx={0.25} fill="#ffffff" stroke="#1f1147" strokeWidth={0.09} />
      {Array.from({ length: 16 }, (_, i) => ((i % 4) + Math.floor(i / 4)) % 2 === 1 && <rect key={i} x={i % 4} y={Math.floor(i / 4)} width={1} height={1} fill="#e9e9ee" />)}
      {pieces.map(([x, y, g]) => (
        <text key={`${x}-${y}`} x={x + 0.5} y={y + 0.52} textAnchor="middle" dominantBaseline="central" fontSize={0.8} fill="#1f1147" fontFamily='"Apple Symbols", "Segoe UI Symbol", "Noto Sans Symbols 2", sans-serif'>
          {`${g}\uFE0E`}
        </text>
      ))}
      <rect x={0} y={0} width={4} height={4} rx={0.25} fill="none" stroke="#1f1147" strokeWidth={0.09} />
    </svg>
  );
}

function XiangqiArt({ className }: { className: string }) {
  const discs: [number, number, string, string][] = [[0.5, 0.6, '车', '#1f1147'], [2, 0.6, '将', '#1f1147'], [3.5, 0.6, '马', '#1f1147'], [1.25, 2, '炮', '#e0344f'], [2.75, 2, '兵', '#e0344f'], [2, 3.4, '帅', '#e0344f']];
  return (
    <svg viewBox="-0.2 -0.1 4.4 4.2" className={className} aria-hidden>
      <g stroke="#1f1147" strokeWidth={0.05} opacity={0.55}>
        {[0.6, 2, 3.4].map((y) => (
          <line key={y} x1={0} y1={y} x2={4} y2={y} />
        ))}
        {[0.5, 1.25, 2, 2.75, 3.5].map((x) => (
          <line key={x} x1={x} y1={0.6} x2={x} y2={3.4} />
        ))}
      </g>
      {discs.map(([x, y, char, color]) => (
        <g key={char}>
          <circle cx={x} cy={y} r={0.52} fill="#fff8e7" stroke="#1f1147" strokeWidth={0.08} />
          <circle cx={x} cy={y} r={0.4} fill="none" stroke={color} strokeWidth={0.04} />
          <text x={x} y={y + 0.02} textAnchor="middle" dominantBaseline="central" fontSize={0.56} fontWeight={700} fill={color} fontFamily='"Kaiti SC", "STKaiti", "KaiTi", serif'>
            {char}
          </text>
        </g>
      ))}
    </svg>
  );
}

function CodeArt({ className }: { className: string }) {
  const lines: [number, number, number, string][] = [[0.5, 1.45, 1.5, '#7c5cff'], [0.9, 2.05, 2.3, '#1f1147'], [0.9, 2.65, 1.2, '#ff5d8f'], [0.5, 3.25, 0.8, '#7c5cff']];
  return (
    <svg viewBox="-0.2 -0.2 8.6 4.6" className={className} aria-hidden>
      <rect x={0} y={0} width={4.4} height={4.1} rx={0.45} fill="#fff" stroke="#1f1147" strokeWidth={0.12} />
      <path d="M0 0.9 H4.4" stroke="#1f1147" strokeWidth={0.12} />
      {[0.5, 0.95, 1.4].map((x, i) => (
        <circle key={x} cx={x} cy={0.47} r={0.15} fill={['#ff5d8f', '#ffd23f', '#3ddc97'][i]} stroke="#1f1147" strokeWidth={0.06} />
      ))}
      {lines.map(([x, y, w, fill]) => (
        <rect key={y} x={x} y={y} width={w} height={0.28} rx={0.14} fill={fill} />
      ))}
      <text x={5} y={2.35} fontSize={0.9} fontWeight={700} fill="#ff5d8f" stroke="#1f1147" strokeWidth={0.05} textAnchor="middle" fontFamily="var(--font-display)">VS</text>
      {/* The other side is a terminal with Qoder's mark on it: the opponent is Qoder CLI. */}
      <rect x={5.7} y={0.45} width={2.5} height={3.3} rx={0.45} fill="#170d38" stroke="#1f1147" strokeWidth={0.12} />
      <mask id="qoder-mark" style={{ maskType: 'alpha' }}>
        <image href="/agents/qodercli.svg" x={6.3} y={0.75} width={1.3} height={1.3} />
      </mask>
      <rect x={6.3} y={0.75} width={1.3} height={1.3} fill="#2ADB5C" mask="url(#qoder-mark)" />
      <path d="M6.2 2.45 l0.5 0.4 l-0.5 0.4" fill="none" stroke="#2ADB5C" strokeWidth={0.2} strokeLinecap="round" strokeLinejoin="round" />
      <rect x={7} y={3.15} width={0.75} height={0.2} rx={0.1} fill="#ffd23f" />
    </svg>
  );
}

/** A game's little illustration; the lobby card and the settings row share it. */
export function GameArt({ id, className = 'h-28 w-auto' }: { id: GameId; className?: string }) {
  if (id === 'tetris') return <TetrisArt className={className} />;
  if (id === 'gomoku') return <GomokuArt className={className} />;
  if (id === '2048') return <Art2048 className={className} />;
  if (id === 'chess') return <ChessArt className={className} />;
  if (id === 'xiangqi') return <XiangqiArt className={className} />;
  if (id === 'code') return <CodeArt className={className} />;
  return <SnakeArt className={className} />;
}

const FLOATERS = [
  { emoji: '🟪', left: '6%', top: '18%', r: '-12deg', d: '7s', size: '2.6rem' },
  { emoji: '⚫', left: '90%', top: '14%', r: '8deg', d: '9s', size: '2.2rem' },
  { emoji: '🟨', left: '84%', top: '62%', r: '18deg', d: '6s', size: '2.8rem' },
  { emoji: '⚪', left: '10%', top: '70%', r: '-6deg', d: '8s', size: '2rem' },
  { emoji: '🟦', left: '48%', top: '6%', r: '24deg', d: '10s', size: '1.8rem' },
  { emoji: '🟩', left: '60%', top: '86%', r: '-20deg', d: '7.5s', size: '2.2rem' },
];

export function Floaters() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
      {FLOATERS.map((f, i) => (
        <span key={i} className="floaty absolute opacity-70" style={{ left: f.left, top: f.top, fontSize: f.size, '--r': f.r, '--d': f.d } as React.CSSProperties}>
          {f.emoji}
        </span>
      ))}
    </div>
  );
}

export function Lobby({ onPick, onSettings }: { onPick: (game: GameId) => void; onSettings: () => void }) {
  const { hiddenGames, gameOrder } = useSyncExternalStore(settings.subscribe, settings.get);
  const games = sortGames(GAMES, gameOrder).filter((g) => !hiddenGames.includes(g.id));
  // One or two cards should not stretch across a three-column page.
  const grid = games.length === 1 ? 'max-w-md' : games.length === 2 ? 'max-w-4xl md:grid-cols-2' : 'md:grid-cols-2 lg:grid-cols-3';
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-4 pb-16">
      <header className="pop-in mt-6 text-center">
        <h1 className="text-6xl font-bold leading-none tracking-tight sm:text-7xl">
          {t('hero.a')} <span className="inline-block -rotate-3 rounded-2xl border-[3px] border-ink bg-pink px-3 text-white shadow-[5px_5px_0_var(--color-ink)]">{t('hero.b')}</span> {t('hero.c')}
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-snug opacity-80">
          {t('hero.sub')}
        </p>
      </header>

      <div className={`mt-10 grid w-full gap-7 ${grid}`}>
        {games.map((game, i) => (
          <button
            key={game.id}
            onClick={() => onPick(game.id)}
            className="toy pop-in group flex flex-col items-start gap-4 p-6 text-left transition-transform duration-200 hover:-translate-y-1.5 hover:rotate-[-0.6deg] active:translate-y-1"
            style={{ animationDelay: `${0.1 + i * 0.1}s` }}
          >
            <div className="grid w-full place-items-center rounded-2xl border-[3px] border-ink py-5" style={{ background: game.color }}>
              <GameArt id={game.id} />
            </div>
            <div>
              <div className="text-sm font-bold uppercase tracking-widest opacity-60">{t(`game.${game.id}.subtitle`)}</div>
              <h2 className="text-3xl font-bold">{t(`game.${game.id}.title`)}</h2>
            </div>
            <p className="leading-snug opacity-80">{t(`game.${game.id}.blurb`)}</p>
            <div className="flex flex-wrap gap-2">
              {t(`game.${game.id}.tags`).split('|').map((tag) => (
                <span key={tag} className="rounded-full border-2 border-ink bg-paper px-2.5 py-0.5 text-xs font-semibold">
                  {tag}
                </span>
              ))}
            </div>
            <span className="btn mt-auto self-stretch bg-sun text-lg group-hover:bg-pink group-hover:text-white">{t('lobby.pick')}</span>
          </button>
        ))}
        {games.length === 0 ? (
          <div className="toy pop-in col-span-full flex flex-col items-center gap-4 p-8 text-center">
            <div className="text-5xl">🙈</div>
            <p className="text-lg font-semibold">{t('lobby.empty')}</p>
            <button className="btn bg-sun" onClick={onSettings}>
              ⚙️ {t('lobby.openSettings')}
            </button>
          </div>
        ) : (
          <div className="toy-sm col-span-full grid place-items-center border-dashed !bg-paper p-5 text-center !shadow-none">
            <p className="font-semibold opacity-60">{t('lobby.more')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
