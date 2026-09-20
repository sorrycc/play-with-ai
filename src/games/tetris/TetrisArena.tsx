import { useEffect, useMemo, useRef, useState } from 'react';
import type { Player, PlayerConfig } from '../../core/types';
import { fmtMs, fmtUsd, formatClock } from '../../core/types';
import { t, type TextKey } from '../../core/i18n';
import { sfx, type SfxName } from '../../core/sound';
import { createPlayer } from '../../players';
import { Countdown, PlayerBadge, MatchEnding, StatsGrid, modelStatRows, seatMood, type CompareRow, type StatRow } from '../../ui/bits';
import { useMatch } from '../../ui/useMatch';
import { drawBoard, drawNext } from './draw';
import { HEIGHT, WIDTH } from './engine';
import { TetrisMatch, type TetrisAction, type TetrisEvent, type TetrisOptions, type TetrisSide } from './match';

const BOARD_W = 250;
const BOARD_H = (BOARD_W / WIDTH) * HEIGHT;
const NEXT_SIZE = 72;

type KeyMap = Record<string, TetrisAction>;

// One person gets every key. Two people split the keyboard: WASD side and arrow side.
const KEYS_SOLO: KeyMap = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'rotateCw', ArrowDown: 'soft',
  a: 'left', d: 'right', w: 'rotateCw', s: 'soft', x: 'rotateCw', z: 'rotateCcw', q: 'rotateCcw', ' ': 'hard',
};
const KEYS_LEFT: KeyMap = { a: 'left', d: 'right', w: 'rotateCw', s: 'soft', q: 'rotateCcw', ' ': 'hard', f: 'hard' };
const KEYS_RIGHT: KeyMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'rotateCw', ArrowDown: 'soft', '/': 'rotateCcw', Enter: 'hard' };

/** The keys as a person reads them, per keyboard layout above: what to press, then what it does. */
type GuideRow = [keys: string[], label: TextKey];
const GUIDE_SOLO: GuideRow[] = [[['←', '→'], 'tetris.guide.move'], [['↑'], 'tetris.guide.rotate'], [['Z'], 'tetris.guide.rotateCcw'], [['↓'], 'tetris.guide.soft'], [['Space'], 'tetris.guide.hard']];
const GUIDE_LEFT: GuideRow[] = [[['A', 'D'], 'tetris.guide.move'], [['W'], 'tetris.guide.rotate'], [['Q'], 'tetris.guide.rotateCcw'], [['S'], 'tetris.guide.soft'], [['Space'], 'tetris.guide.hard']];
const GUIDE_RIGHT: GuideRow[] = [[['←', '→'], 'tetris.guide.move'], [['↑'], 'tetris.guide.rotate'], [['/'], 'tetris.guide.rotateCcw'], [['↓'], 'tetris.guide.soft'], [['Enter'], 'tetris.guide.hard']];

/**
 * Shown to a person before the count: nobody guesses that Space drops a piece all the way, and
 * finding out mid-game costs the game. The clock does not run while this is up.
 */
function HowToPlay({ guides, goal, onStart }: { guides: { title: string | null; rows: GuideRow[] }[]; goal: string; onStart: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/45 p-4 backdrop-blur-[2px]">
      <div className="toy pop-in flex w-full max-w-2xl flex-col gap-4 p-6" role="dialog" aria-modal="true" aria-label={t('tetris.guide.title')}>
        <div className="text-center">
          <h2 className="text-2xl font-bold leading-tight">🎮 {t('tetris.guide.title')}</h2>
          <p className="mt-1 text-sm opacity-70">{goal}</p>
        </div>
        <div className={`grid gap-4 ${guides.length > 1 ? 'sm:grid-cols-2' : ''}`}>
          {guides.map((guide, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              {guide.title && <h3 className="text-sm font-bold uppercase tracking-widest opacity-60">{guide.title}</h3>}
              {guide.rows.map(([keys, label]) => {
                const hard = label === 'tetris.guide.hard';
                return (
                  <div key={label} className={`flex items-center gap-3 rounded-xl border-2 px-3 py-1.5 ${hard ? 'border-ink bg-sun' : 'border-transparent bg-paper'}`}>
                    <span className="flex w-24 shrink-0 gap-1">
                      {keys.map((key) => (
                        <kbd key={key} className="rounded-lg border-2 border-ink bg-white px-2 py-0.5 font-mono text-sm font-bold shadow-[2px_2px_0_var(--color-ink)]">
                          {key}
                        </kbd>
                      ))}
                    </span>
                    <span className="min-w-0 text-sm leading-snug">
                      <span className="font-bold">{t(label)}</span>
                      {hard && <span className="block text-xs opacity-80">{t('tetris.guide.hardNote')}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <p className="text-center text-xs opacity-60">{t('tetris.guide.touch')}</p>
        <div className="flex flex-col items-center gap-1">
          <button className="btn bg-mint px-10 py-3 text-xl" autoFocus onClick={onStart}>
            {t('tetris.guide.start')}
          </button>
          <span className="text-xs opacity-60">{t('tetris.guide.startHint')}</span>
        </div>
      </div>
    </div>
  );
}

const CLEAR_SFX: SfxName[] = ['lock', 'clear1', 'clear2', 'clear3', 'clear4'];

/** Each board sounds from its own side. A seat nobody is steering locks more quietly. */
function playEvent(event: TetrisEvent, humanSeat: boolean): void {
  const pan = event.side === 0 ? -0.55 : 0.55;
  if (event.type === 'clear') sfx.play(CLEAR_SFX[event.lines ?? 1] ?? 'clear4', { pan });
  else if (event.type === 'lock') sfx.play('lock', { pan, volume: humanSeat ? 1 : 0.55 });
  else sfx.play(event.type, { pan });
}

function useHiDpiCanvas(width: number, height: number) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [width, height]);
  return ref;
}

function sideRows(side: TetrisSide): StatRow[] {
  const base: StatRow[] = [
    [t('stat.lines'), side.lines],
    [t('stat.pieces'), side.pieces],
    [t('stat.score'), side.score.toLocaleString()],
    [t('stat.sent'), side.sent],
    [t('stat.received'), side.received],
  ];
  if (side.human) return [...base, [t('stat.tetrises'), side.clears[4]]];
  return [...base, [t('stat.calls'), side.stats.calls], ...modelStatRows(side.stats)];
}

function SideView({ side, match, keysHint, shaking }: { side: TetrisSide; match: TetrisMatch; keysHint: string | null; shaking: boolean }) {
  const boardRef = useHiDpiCanvas(BOARD_W, BOARD_H);
  const nextRef = useHiDpiCanvas(NEXT_SIZE, NEXT_SIZE);

  // Painting runs off the animation frame, not React state: a falling piece moves far more often
  // than anything React needs to know about.
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const ctx = boardRef.current?.getContext('2d');
      if (ctx) drawBoard(ctx, side, BOARD_W, BOARD_H);
      const nctx = nextRef.current?.getContext('2d');
      if (nctx) drawNext(nctx, side.over ? null : side.next, NEXT_SIZE);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [side, boardRef, nextRef]);

  const won = match.result?.winner === side.index;
  const act = (action: TetrisAction) => (e: React.PointerEvent) => {
    e.preventDefault();
    match.input(side.index, action);
  };

  return (
    <section className={`flex w-full max-w-[370px] flex-col gap-3 ${seatMood(match.result, side.index)}`}>
      <PlayerBadge
        player={side.player}
        thinking={side.thinking}
        move={side.move}
        align={side.index === 1 ? 'right' : 'left'}
        tag={won ? <span className="rounded-full border-2 border-ink bg-sun px-2 text-xs font-bold">{t('arena.winner')}</span> : undefined}
      />
      <div className={`flex items-start gap-3 ${side.index === 1 ? 'flex-row-reverse' : ''}`}>
        <div className={`bezel relative ${shaking ? 'shake' : ''}`} style={{ width: BOARD_W + 8 }}>
          <canvas ref={boardRef} style={{ width: BOARD_W, height: BOARD_H, display: 'block' }} />
          {side.over && (
            <div className="absolute inset-0 grid place-items-center bg-night/60">
              <div className="pop-in -rotate-6 rounded-2xl border-[3px] border-ink bg-pink px-4 py-2 text-xl font-bold text-white shadow-[4px_4px_0_var(--color-ink)]">{t('arena.toppedOut')}</div>
            </div>
          )}
        </div>
        <div className="flex flex-col items-center gap-3">
          <div className="toy-sm p-1 text-center !bg-night">
            <div className="text-[10px] font-bold uppercase tracking-widest text-white/70">{t('arena.next')}</div>
            <canvas ref={nextRef} style={{ width: NEXT_SIZE, height: NEXT_SIZE, display: 'block' }} />
          </div>
          <div
            className={`toy-sm w-full px-1 py-2 text-center transition-colors ${side.pendingGarbage > 0 ? '!bg-pink text-white' : ''}`}
            title={t('arena.incomingTitle')}
          >
            <div className="text-[10px] font-bold uppercase tracking-widest opacity-70">{t('arena.incoming')}</div>
            <div className="font-mono text-2xl font-bold">{side.pendingGarbage > 0 ? `▼${side.pendingGarbage}` : '0'}</div>
          </div>
        </div>
      </div>
      {side.human && (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-5 gap-1.5">
            {(
              [
                ['left', '◀'],
                ['rotateCw', '⟳'],
                ['soft', '▼'],
                ['hard', '⤓'],
                ['right', '▶'],
              ] as [TetrisAction, string][]
            ).map(([action, glyph]) => (
              <button key={action} className="btn bg-white !px-0 !py-2 text-lg" onPointerDown={act(action)} aria-label={action} data-silent>
                {glyph}
              </button>
            ))}
          </div>
          {keysHint && <p className="text-center text-xs opacity-60">{keysHint}</p>}
        </div>
      )}
      <StatsGrid rows={sideRows(side)} />
    </section>
  );
}

function compareRows(L: TetrisSide, R: TetrisSide): CompareRow[] {
  const both = (label: string, f: (s: TetrisSide) => React.ReactNode): CompareRow => [label, f(L), f(R)];
  return [
    both(t('stat.lines'), (s) => s.lines),
    both(t('stat.pieces'), (s) => s.pieces),
    both(t('cmp.linesPerPiece'), (s) => (s.pieces ? (s.lines / s.pieces).toFixed(2) : '–')),
    both(t('cmp.garbageSent'), (s) => s.sent),
    both(t('stat.avgLatency'), (s) => (s.stats.latency ? fmtMs(s.stats.latency / s.stats.calls) : '–')),
    both(t('cmp.missedDeadlines'), (s) => (s.human ? '–' : s.stats.missed)),
    both(t('cmp.invalidErrors'), (s) => (s.human ? '–' : s.stats.invalid + s.stats.errors)),
    both(t('cmp.tokensInOut'), (s) => (s.stats.inputTokens ? `${s.stats.inputTokens.toLocaleString()} / ${s.stats.outputTokens.toLocaleString()}` : '–')),
    both(t('stat.cost'), (s) => fmtUsd(s.stats.cost)),
    both(t('cmp.costPerMove'), (s) => (s.stats.calls && s.stats.cost ? fmtUsd(s.stats.cost / s.stats.calls, 5) : '–')),
  ];
}

export function TetrisArena({
  seats,
  options,
  onRematch,
  onSetup,
  onLobby,
}: {
  seats: [PlayerConfig, PlayerConfig];
  options: TetrisOptions;
  onRematch: () => void;
  onSetup: () => void;
  onLobby: () => void;
}) {
  const players = useMemo(() => seats.map(createPlayer) as [Player, Player], [seats]);
  const humans = seats.filter((s) => s.kind === 'human').length;
  // A person gets the keys explained first; machines start right away.
  const { match, count, waiting, begin } = useMatch((onChange) => new TetrisMatch(players, options, onChange, (event) => playEvent(event, seats[event.side].kind === 'human')), { wait: humans > 0 });
  const [, setClock] = useState(0);
  const [resultOpen, setResultOpen] = useState(true);

  // The clock, the level and the stats tick on their own; everything else re-renders on change.
  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 200);
    return () => clearInterval(id);
  }, []);

  const level = match?.status === 'running' ? match.level() : 1;
  useEffect(() => {
    if (level > 1) sfx.play('levelup');
  }, [level]);

  useEffect(() => {
    // While the keys are being explained, Space and Enter belong to its start button.
    if (!match || humans === 0 || waiting) return;
    const maps: [KeyMap | null, KeyMap | null] =
      humans === 2 ? [KEYS_LEFT, KEYS_RIGHT] : [seats[0].kind === 'human' ? KEYS_SOLO : null, seats[1].kind === 'human' ? KEYS_SOLO : null];
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      maps.forEach((map, index) => {
        const action = map?.[key];
        if (!action) return;
        e.preventDefault();
        if (action === 'hard' && e.repeat) return;
        match.input(index as 0 | 1, action);
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [match, humans, seats, waiting]);

  if (!match) return null;
  const [L, R] = match.sides;
  const now = performance.now();
  const hint = (index: 0 | 1) =>
    humans === 2
      ? t(index === 0 ? 'keys.left' : 'keys.right')
      : t('keys.solo');
  const mode = t(options.lockstep ? 'mode.lockstep' : options.garbage ? 'mode.versus' : 'mode.race');

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-5 px-4 pb-10">
      <Countdown value={count} />
      {waiting && (
        <HowToPlay
          guides={humans === 2 ? [{ title: t('seat.left'), rows: GUIDE_LEFT }, { title: t('seat.right'), rows: GUIDE_RIGHT }] : [{ title: null, rows: GUIDE_SOLO }]}
          goal={t(options.lockstep ? 'tetris.guide.goalLockstep' : options.garbage ? 'tetris.guide.goalVersus' : 'tetris.guide.goalRace')}
          onStart={begin}
        />
      )}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <span className="toy-sm px-4 py-1 font-mono text-2xl font-bold">
          {formatClock(match.elapsed())}
          {options.timeLimitSec > 0 && <span className="text-sm opacity-50"> / {formatClock(options.timeLimitSec * 1000)}</span>}
        </span>
        <span className="toy-sm !bg-sun px-3 py-1 text-sm font-bold">{mode}</span>
        {!options.lockstep && (
          <span className="toy-sm px-3 py-1 text-sm font-bold">
            {t('arena.level', { n: match.level() })} · <span className="font-mono">{t('arena.msRow', { ms: match.gravityNow() })}</span>
          </span>
        )}
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

      <div className="flex w-full flex-wrap items-start justify-center gap-x-10 gap-y-8">
        <SideView side={L} match={match} keysHint={L.human ? hint(0) : null} shaking={now - L.hitAt < 350} />
        <div className="hidden self-center text-5xl font-bold text-pink [-webkit-text-stroke:2px_var(--color-ink)] lg:block">VS</div>
        <SideView side={R} match={match} keysHint={R.human ? hint(1) : null} shaking={now - R.hitAt < 350} />
      </div>

      {match.result && (
        <MatchEnding
          result={match.result}
          humans={[seats[0].kind === 'human', seats[1].kind === 'human']}
          open={resultOpen}
          detail={t('detail.tetris', { clock: formatClock(match.result.elapsedMs), mode, seed: options.seed })}
          players={players}
          rows={compareRows(L, R)}
          onRematch={onRematch}
          onSetup={onSetup}
          onLobby={onLobby}
          onClose={() => setResultOpen(false)}
        />
      )}
    </div>
  );
}
