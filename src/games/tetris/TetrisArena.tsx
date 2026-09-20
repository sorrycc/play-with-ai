import { useEffect, useMemo, useRef, useState } from 'react';
import type { Player, PlayerConfig } from '../../core/types';
import { fmtMs, fmtUsd, formatClock } from '../../core/types';
import { t, type TextKey } from '../../core/i18n';
import { sfx, type SfxName } from '../../core/sound';
import { createPlayer } from '../../players';
import { Countdown, PlayerBadge, MatchEnding, StatsGrid, modelStatRows, seatMood, type CompareRow, type StatRow } from '../../ui/bits';
import { useMatch } from '../../ui/useMatch';
import { drawBoard, drawHold, drawNext } from './draw';
import { HEIGHT, WIDTH } from './engine';
import { TetrisMatch, type TetrisAction, type TetrisEvent, type TetrisOptions, type TetrisSide } from './match';

const BOARD_W = 250;
const BOARD_H = (BOARD_W / WIDTH) * HEIGHT;
const CELL = BOARD_W / WIDTH;
const PANEL_W = 72;
const NEXT_H = 150;
const HOLD_SIZE = 56;

/** Our own key repeat: the delay before a held key starts moving, and how fast it moves then. */
const DAS_MS = 150;
const ARR_MS = 35;
/** Only these repeat; a held rotate key would spin the piece at whatever rate the OS fancies. */
const REPEATS: Partial<Record<TetrisAction, true>> = { left: true, right: true, soft: true };

type KeyMap = Record<string, TetrisAction>;

// One person gets every key. Two people split the keyboard: WASD side and arrow side.
const KEYS_SOLO: KeyMap = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'rotateCw', ArrowDown: 'soft',
  a: 'left', d: 'right', w: 'rotateCw', s: 'soft', x: 'rotateCw', z: 'rotateCcw', q: 'rotateCcw', c: 'hold', ' ': 'hard',
};
const KEYS_LEFT: KeyMap = { a: 'left', d: 'right', w: 'rotateCw', s: 'soft', q: 'rotateCcw', e: 'hold', ' ': 'hard', f: 'hard' };
const KEYS_RIGHT: KeyMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'rotateCw', ArrowDown: 'soft', '/': 'rotateCcw', '.': 'hold', Enter: 'hard' };

/** The keys as a person reads them, per keyboard layout above: what to press, then what it does. */
type GuideRow = [keys: string[], label: TextKey];
const GUIDE_SOLO: GuideRow[] = [[['←', '→'], 'tetris.guide.move'], [['↑'], 'tetris.guide.rotate'], [['Z'], 'tetris.guide.rotateCcw'], [['↓'], 'tetris.guide.soft'], [['C'], 'tetris.guide.hold'], [['Space'], 'tetris.guide.hard']];
const GUIDE_LEFT: GuideRow[] = [[['A', 'D'], 'tetris.guide.move'], [['W'], 'tetris.guide.rotate'], [['Q'], 'tetris.guide.rotateCcw'], [['S'], 'tetris.guide.soft'], [['E'], 'tetris.guide.hold'], [['Space', 'F'], 'tetris.guide.hard']];
const GUIDE_RIGHT: GuideRow[] = [[['←', '→'], 'tetris.guide.move'], [['↑'], 'tetris.guide.rotate'], [['/'], 'tetris.guide.rotateCcw'], [['↓'], 'tetris.guide.soft'], [['.'], 'tetris.guide.hold'], [['Enter'], 'tetris.guide.hard']];

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
  else if (event.type === 'hold') sfx.play('rotate', { pan, volume: 0.8 });
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

/** Holding a touch button repeats it, the same way a held key does. */
function useRepeatPress(send: (action: TetrisAction) => void) {
  const timers = useRef<{ das?: ReturnType<typeof setTimeout>; arr?: ReturnType<typeof setInterval> }>({});
  const stop = () => {
    clearTimeout(timers.current.das);
    clearInterval(timers.current.arr);
    timers.current = {};
  };
  useEffect(() => stop, []);
  return {
    start(action: TetrisAction) {
      stop();
      send(action);
      if (!REPEATS[action]) return;
      timers.current.das = setTimeout(() => {
        timers.current.arr = setInterval(() => send(action), ARR_MS);
      }, DAS_MS);
    },
    stop,
  };
}

function sideRows(side: TetrisSide): StatRow[] {
  const base: StatRow[] = [
    [t('stat.lines'), side.lines],
    [t('stat.pieces'), side.pieces],
    [t('stat.score'), side.score.toLocaleString()],
    [t('stat.tetrises'), side.clears[4]],
    [t('stat.sent'), side.sent],
    [t('stat.received'), side.received],
  ];
  if (side.human) return base;
  return [...base, [t('stat.calls'), side.stats.calls], [t('stat.late'), side.late], ...modelStatRows(side.stats)];
}

function SideView({ side, match, keysHint, shaking }: { side: TetrisSide; match: TetrisMatch; keysHint: string | null; shaking: boolean }) {
  const boardRef = useHiDpiCanvas(BOARD_W, BOARD_H);
  const nextRef = useHiDpiCanvas(PANEL_W, NEXT_H);
  const holdRef = useHiDpiCanvas(HOLD_SIZE, HOLD_SIZE);

  // Painting runs off the animation frame, not React state: a falling piece moves far more often
  // than anything React needs to know about.
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const ctx = boardRef.current?.getContext('2d');
      if (ctx) drawBoard(ctx, side, BOARD_W, BOARD_H);
      const nctx = nextRef.current?.getContext('2d');
      if (nctx) drawNext(nctx, side.over ? [] : side.queue, PANEL_W, NEXT_H);
      const hctx = holdRef.current?.getContext('2d');
      if (hctx) drawHold(hctx, side.over ? null : side.hold, side.holdUsed, HOLD_SIZE);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [side, boardRef, nextRef, holdRef]);

  const won = match.result?.winner === side.index;
  const send = (action: TetrisAction) => match.input(side.index, action);
  const press = useRepeatPress(send);

  // Touch: drag sideways to move, drag down to soft drop, flick down to drop, tap to rotate.
  const drag = useRef<{ id: number; x: number; y: number; at: number; moved: boolean } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    // A mouse has the buttons below and the keyboard; a stray click should not turn the piece.
    if (!side.human || e.pointerType === 'mouse') return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, at: Date.now(), moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    while (Math.abs(e.clientX - g.x) >= CELL) {
      const right = e.clientX > g.x;
      g.x += right ? CELL : -CELL;
      g.moved = true;
      send(right ? 'right' : 'left');
    }
    while (e.clientY - g.y >= CELL) {
      g.y += CELL;
      g.moved = true;
      send('soft');
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || g.id !== e.pointerId) return;
    drag.current = null;
    const downFlick = e.clientY - g.y > CELL * 2 && Date.now() - g.at < 300;
    if (downFlick) send('hard');
    else if (!g.moved && Date.now() - g.at < 250) send('rotateCw');
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
        <div
          className={`bezel relative ${shaking ? 'shake' : ''}`}
          style={{ width: BOARD_W + 8, touchAction: side.human ? 'none' : undefined }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <canvas ref={boardRef} style={{ width: BOARD_W, height: BOARD_H, display: 'block' }} />
          {side.over && (
            <div className="absolute inset-0 grid place-items-center bg-night/60">
              <div className="pop-in -rotate-6 rounded-2xl border-[3px] border-ink bg-pink px-4 py-2 text-xl font-bold text-white shadow-[4px_4px_0_var(--color-ink)]">{t('arena.toppedOut')}</div>
            </div>
          )}
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="toy-sm p-1 text-center !bg-night" title={t('arena.holdTitle')}>
            <div className="text-[10px] font-bold uppercase tracking-widest text-white/70">{t('arena.hold')}</div>
            <canvas ref={holdRef} style={{ width: HOLD_SIZE, height: HOLD_SIZE, display: 'block' }} />
          </div>
          <div className="toy-sm p-1 text-center !bg-night">
            <div className="text-[10px] font-bold uppercase tracking-widest text-white/70">{t('arena.next')}</div>
            <canvas ref={nextRef} style={{ width: PANEL_W, height: NEXT_H, display: 'block' }} />
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
          <div className="grid grid-cols-6 gap-1.5">
            {(
              [
                ['left', '◀', 'tetris.guide.move'],
                ['rotateCcw', '⟲', 'tetris.guide.rotateCcw'],
                ['rotateCw', '⟳', 'tetris.guide.rotate'],
                ['hold', '↩', 'tetris.guide.hold'],
                ['soft', '▼', 'tetris.guide.soft'],
                ['right', '▶', 'tetris.guide.move'],
              ] as [TetrisAction, string, TextKey][]
            ).map(([action, glyph, label]) => (
              <button
                key={action}
                className="btn bg-white !px-0 !py-2 text-lg"
                onPointerDown={(e) => {
                  e.preventDefault();
                  press.start(action);
                }}
                onPointerUp={press.stop}
                onPointerLeave={press.stop}
                onPointerCancel={press.stop}
                aria-label={t(label)}
                data-silent
              >
                {glyph}
              </button>
            ))}
          </div>
          <button
            className="btn bg-sun !py-2 text-base"
            onPointerDown={(e) => {
              e.preventDefault();
              send('hard');
            }}
            aria-label={t('tetris.guide.hard')}
            data-silent
          >
            ⤓ {t('tetris.guide.hard')}
          </button>
          {keysHint && <p className="text-center text-xs opacity-60">{keysHint}</p>}
        </div>
      )}
      <StatsGrid rows={sideRows(side)} />
    </section>
  );
}

function endedWith(side: TetrisSide): string {
  if (!side.over) return t('cmp.stillStanding');
  return t(side.lostTo === 'garbage' ? 'cmp.buriedAt' : 'cmp.toppedAt', { clock: formatClock(side.lostAt ?? 0), n: side.pieces });
}

function compareRows(L: TetrisSide, R: TetrisSide): CompareRow[] {
  const both = (label: string, f: (s: TetrisSide) => React.ReactNode): CompareRow => [label, f(L), f(R)];
  return [
    both(t('stat.lines'), (s) => s.lines),
    both(t('stat.pieces'), (s) => s.pieces),
    both(t('cmp.linesPerPiece'), (s) => (s.pieces ? (s.lines / s.pieces).toFixed(2) : '–')),
    // Singles / doubles / triples / Tetrises: one number says how the lines were won.
    both(t('cmp.clearShape'), (s) => s.clears.slice(1).join(' / ')),
    both(t('cmp.garbageSent'), (s) => s.sent),
    both(t('cmp.garbageReceived'), (s) => s.received),
    both(t('cmp.garbageCancelled'), (s) => s.cancelled),
    both(t('cmp.holdsUsed'), (s) => s.holds),
    both(t('cmp.peakHeight'), (s) => s.peak),
    both(t('stat.avgLatency'), (s) => (s.stats.latency ? fmtMs(s.stats.latency / s.stats.calls) : '–')),
    both(t('cmp.slowestAnswer'), (s) => (s.slowestMs ? fmtMs(s.slowestMs) : '–')),
    both(t('cmp.missedDeadlines'), (s) => (s.human ? '–' : s.stats.missed)),
    both(t('cmp.lateAnswers'), (s) => (s.human ? '–' : s.late)),
    both(t('cmp.invalidErrors'), (s) => (s.human ? '–' : s.stats.invalid + s.stats.errors)),
    both(t('cmp.tokensInOut'), (s) => (s.stats.inputTokens ? `${s.stats.inputTokens.toLocaleString()} / ${s.stats.outputTokens.toLocaleString()}` : '–')),
    both(t('stat.cost'), (s) => fmtUsd(s.stats.cost)),
    both(t('cmp.costPerMove'), (s) => (s.stats.calls && s.stats.cost ? fmtUsd(s.stats.cost / s.stats.calls, 5) : '–')),
    both(t('cmp.endedWith'), endedWith),
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

  // In lockstep `level()` stays 1, so no jingle announces a speed-up that cannot happen.
  const level = match?.status === 'running' ? match.level() : 1;
  useEffect(() => {
    if (level > 1) sfx.play('levelup');
  }, [level]);

  useEffect(() => {
    // While the keys are being explained, Space and Enter belong to its start button.
    if (!match || humans === 0 || waiting) return;
    const maps: [KeyMap | null, KeyMap | null] =
      humans === 2 ? [KEYS_LEFT, KEYS_RIGHT] : [seats[0].kind === 'human' ? KEYS_SOLO : null, seats[1].kind === 'human' ? KEYS_SOLO : null];
    const named = (e: KeyboardEvent) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
    // Auto-repeat is ours, not the operating system's: two people on one keyboard would otherwise
    // move at two different speeds, and a held rotate key would spin the piece.
    const timers = new Map<string, { das?: ReturnType<typeof setTimeout>; arr?: ReturnType<typeof setInterval> }>();
    const stopKey = (id: string) => {
      const entry = timers.get(id);
      if (!entry) return;
      clearTimeout(entry.das);
      clearInterval(entry.arr);
      timers.delete(id);
    };
    const stopAll = () => [...timers.keys()].forEach(stopKey);
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = named(e);
      maps.forEach((map, index) => {
        const action = map?.[key];
        if (!action) return;
        e.preventDefault();
        if (e.repeat) return;
        const seat = index as 0 | 1;
        match.input(seat, action);
        if (!REPEATS[action]) return;
        const id = `${index}:${key}`;
        stopKey(id);
        const entry: { das?: ReturnType<typeof setTimeout>; arr?: ReturnType<typeof setInterval> } = {};
        entry.das = setTimeout(() => {
          entry.arr = setInterval(() => match.input(seat, action), ARR_MS);
        }, DAS_MS);
        timers.set(id, entry);
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = named(e);
      maps.forEach((map, index) => {
        if (map?.[key]) stopKey(`${index}:${key}`);
      });
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    // A key held while the page loses focus never sends its keyup.
    window.addEventListener('blur', stopAll);
    return () => {
      stopAll();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stopAll);
    };
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
