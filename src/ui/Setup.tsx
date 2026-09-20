import { useEffect, useState, useSyncExternalStore } from 'react';
import { t, type TextKey } from '../core/i18n';
import { EFFORTS } from '../core/types';
import type { DecisionGameId, Effort, PlayerConfig, PlayerKind } from '../core/types';
import { ROLES } from '../players';
import { algos } from '../players/algos';
import { AlgoPanel, algoForSeat } from './AlgoPanel';
import { DEFAULT_MODEL, FEATURED_MODELS, loadModels, type ModelInfo } from '../players/llm';
import { GARBAGE_TABLES, type GarbageTable } from '../games/tetris/engine';
import { SPEEDUPS, type SpeedupName, type TetrisOptions } from '../games/tetris/match';
import type { GomokuOptions } from '../games/gomoku/match';
import { recommendedTickMs, type SnakeOptions } from '../games/snake/match';
import type { Options2048 } from '../games/g2048/match';
import type { ChessOptions } from '../games/chess/match';
import type { XiangqiOptions } from '../games/xiangqi/match';
import type { CodeOptions } from '../games/code/match';

export interface ApiConfig {
  zenmux: boolean;
  jev: boolean;
  /** Ids of the code agents (server/agents.mjs) whose CLI the server found on its PATH. */
  agents?: string[];
  /** Missing on a proxy from before versions existed, which is as stale as it gets. */
  version?: number;
}

export interface MatchSetup {
  seats: [PlayerConfig, PlayerConfig];
  tetris: TetrisOptions;
  gomoku: GomokuOptions;
  snake: SnakeOptions;
  g2048: Options2048;
  chess: ChessOptions;
  xiangqi: XiangqiOptions;
  /** The code duel keeps its own opponent: its seats are not the two free ones above. */
  code: CodeOptions;
}

/** The picker's last entry; never sent anywhere as a model id. */
const CUSTOM = '__custom__';

const GRIDS = [
  { key: 'grid.small', cols: 14, rows: 12 },
  { key: 'grid.medium', cols: 20, rows: 16 },
  { key: 'grid.large', cols: 26, rows: 20 },
] as const;

const PRESETS: { label: TextKey; seats: [PlayerKind, PlayerKind] }[] = [
  { label: 'preset.llmJev', seats: ['llm', 'jev'] },
  { label: 'preset.humanLlm', seats: ['human', 'llm'] },
  { label: 'preset.humanJev', seats: ['human', 'jev'] },
  { label: 'preset.llmBot', seats: ['llm', 'bot'] },
  { label: 'preset.llmLlm', seats: ['llm', 'llm'] },
  { label: 'preset.customBot', seats: ['custom', 'bot'] },
];

function SeatCard({
  id,
  game,
  label,
  seat,
  api,
  models,
  onChange,
}: {
  /** Stable across languages; the label is not. */
  id: string;
  game: DecisionGameId;
  label: string;
  seat: PlayerConfig;
  api: ApiConfig | null;
  models: ModelInfo[];
  onChange: (next: PlayerConfig) => void;
}) {
  const listId = `models-${id}`;
  const model = seat.model ?? DEFAULT_MODEL;
  // A model outside the featured list (typed earlier, or restored from the last setup) opens the custom field.
  const [custom, setCustom] = useState(() => !(FEATURED_MODELS as readonly string[]).includes(model));
  const info = models.find((m) => m.id === model);
  return (
    <div className="toy flex min-w-0 flex-1 basis-0 flex-col gap-3 p-5">
      <h3 className="text-sm font-bold uppercase tracking-widest opacity-60">{label}</h3>
      <div className="grid grid-cols-2 gap-2.5">
        {ROLES.map((role) => {
          const missing = role.needs && api ? !api[role.needs] : false;
          return (
            <button
              key={role.kind}
              className="pick flex items-center gap-2 px-3 py-2 text-left"
              aria-pressed={seat.kind === role.kind}
              disabled={missing}
              style={{ '--pick-color': role.color } as React.CSSProperties}
              title={missing ? t('role.needsKey', { name: role.needs === 'jev' ? 'TYPESAFE_API_KEY' : 'ZENMUX_API_KEY' }) : t(`role.${role.kind}.blurb`)}
              onClick={() => onChange({ ...seat, kind: role.kind })}
            >
              <span className="text-2xl">{role.emoji}</span>
              <span className="min-w-0">
                <span className="block font-bold leading-tight">{t(`role.${role.kind}.title`)}</span>
                <span className="block text-[11px] leading-tight opacity-70">{missing ? t('role.noKey') : t(`role.${role.kind}.blurb`)}</span>
              </span>
            </button>
          );
        })}
      </div>

      {seat.kind === 'custom' && <AlgoPanel game={game} seat={seat} canGenerate={!api || api.zenmux} models={models} onChange={onChange} />}

      {seat.kind === 'llm' && (
        <div className="flex flex-col gap-2 rounded-2xl border-2 border-dashed border-ink/40 p-3">
          <label className="text-xs font-bold uppercase tracking-wide opacity-60" htmlFor={`${listId}-input`}>
            {t('setup.model')}
          </label>
          <select
            id={`${listId}-input`}
            className="field"
            value={custom ? CUSTOM : model}
            onChange={(e) => {
              const pickedCustom = e.target.value === CUSTOM;
              setCustom(pickedCustom);
              if (!pickedCustom) onChange({ ...seat, model: e.target.value });
            }}
          >
            {FEATURED_MODELS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
            <option value={CUSTOM}>{t('setup.customModel')}</option>
          </select>
          {custom && (
            <>
              <input
                className="field"
                list={listId}
                value={model}
                spellCheck={false}
                autoFocus
                aria-label={t('setup.customModel')}
                placeholder="provider/model-name"
                onChange={(e) => onChange({ ...seat, model: e.target.value })}
              />
              <datalist id={listId}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </datalist>
            </>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-mono opacity-70">{info ? t('setup.price', { in: info.inputPrice, out: info.outputPrice }) : models.length ? t('setup.unknownModel') : ''}</span>
            <label className="flex cursor-pointer items-center gap-1.5 font-semibold" title={t('setup.thinkingTitle')}>
              {t('setup.thinking')}
              <select
                className="field w-auto! px-2! py-0.5! text-xs!"
                value={seat.thinking === true ? (seat.effort ?? 'medium') : 'off'}
                onChange={(e) => onChange(e.target.value === 'off' ? { ...seat, thinking: false } : { ...seat, thinking: true, effort: e.target.value as Effort })}
              >
                {(['off', ...EFFORTS] as const).map((level) => (
                  <option key={level} value={level}>
                    {t(`effort.${level}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function Option({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-bold uppercase tracking-wide opacity-60">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-tight opacity-60">{hint}</span>}
    </label>
  );
}

type TetrisMode = 'versus' | 'independent' | 'lockstep';
const MODES: { id: TetrisMode; emoji: string; key: 'mode.versus' | 'mode.race' | 'mode.lockstep' }[] = [
  { id: 'versus', emoji: '⚔️', key: 'mode.versus' },
  { id: 'independent', emoji: '🏁', key: 'mode.race' },
  { id: 'lockstep', emoji: '🧘', key: 'mode.lockstep' },
];

const modeOf = (o: TetrisOptions): TetrisMode => (o.lockstep ? 'lockstep' : o.garbage ? 'versus' : 'independent');

export function Setup({
  game,
  initial,
  api,
  onStart,
  onBack,
}: {
  game: DecisionGameId;
  initial: MatchSetup;
  api: ApiConfig | null;
  onStart: (setup: MatchSetup) => void;
  onBack: () => void;
}) {
  const [setup, setSetup] = useState(initial);
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    void loadModels().then(setModels);
  }, []);

  const { seats, tetris, gomoku, snake, g2048 } = setup;
  // Chess and xiangqi share their one option, the move limit.
  const boardGame = game === 'xiangqi' ? 'xiangqi' : 'chess';
  const set2048 = (patch: Partial<Options2048>) => setSetup((s) => ({ ...s, g2048: { ...s.g2048, ...patch } }));
  const setSnake = (patch: Partial<SnakeOptions>) => setSetup((s) => ({ ...s, snake: { ...s.snake, ...patch } }));
  const llmSeats = seats.filter((s) => s.kind === 'llm');
  const autoTick = recommendedTickMs([seats[0].kind, seats[1].kind], llmSeats.some((s) => s.thinking === true), llmSeats.map((s) => s.model ?? DEFAULT_MODEL));
  const snakeTick = snake.tickAuto ? autoTick : snake.tickMs;
  const setSeat = (index: 0 | 1, next: PlayerConfig) => setSetup((s) => ({ ...s, seats: index === 0 ? [next, s.seats[1]] : [s.seats[0], next] }));
  const setTetris = (patch: Partial<TetrisOptions>) => setSetup((s) => ({ ...s, tetris: { ...s.tetris, ...patch } }));
  const usable = (kind: PlayerKind) => {
    const needs = ROLES.find((r) => r.kind === kind)?.needs;
    return !needs || !api || api[needs];
  };

  const warnings: string[] = [];
  if (game === 'tetris' && !tetris.lockstep) {
    if (seats.some((s) => s.kind === 'llm' && s.thinking)) warnings.push(t('warn.thinking'));
    else if (seats.some((s) => s.kind === 'llm') && tetris.gravityMs < 250) warnings.push(t('warn.fast'));
  }
  if (game === 'snake' && !snake.lockstep && seats.some((s) => s.kind === 'llm') && snakeTick < 1200) warnings.push(t('warn.snakeFast'));
  if (game === 'snake' && !snake.lockstep && seats.some((s) => s.kind === 'custom') && snakeTick < 200) warnings.push(t('warn.snakeFastAlgo'));
  // In the 2048 race a seat that thinks for ten seconds loses on move count against anything local.
  if (game === '2048' && !g2048.lockstep && seats.some((s) => s.kind === 'llm' && s.thinking) && seats.some((s) => s.kind === 'bot' || s.kind === 'custom' || s.kind === 'random')) warnings.push(t('warn.raceSlow'));
  if (seats.some((s) => !usable(s.kind))) warnings.push(t('warn.noKey'));
  // A custom seat is only ready once it points at an algorithm written for this game.
  useSyncExternalStore(algos.subscribe, algos.all);
  const missingAlgo = seats.some((s) => s.kind === 'custom' && !algoForSeat(s, game));
  if (missingAlgo) warnings.push(t('warn.noAlgo'));
  const labels = game === 'xiangqi' ? [t('seat.xqRed'), t('seat.xqBlack')] : game === 'chess' ? [t('seat.chessWhite'), t('seat.chessBlack')] : game === 'gomoku' ? [t('seat.black'), t('seat.white')] : game === 'snake' ? [t('seat.green'), t('seat.yellow')] : [t('seat.left'), t('seat.right')];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-16">
      <div className="pop-in flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-sm font-bold uppercase tracking-widest opacity-60">{t(`game.${game}.subtitle`)}</div>
          <h1 className="text-4xl font-bold">{t('setup.title', { game: t(`game.${game}.title`) })}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className="pick px-3 py-1 text-sm font-semibold"
              disabled={!p.seats.every(usable)}
              onClick={() => setSetup((s) => ({ ...s, seats: [{ ...s.seats[0], kind: p.seats[0] }, { ...s.seats[1], kind: p.seats[1] }] }))}
            >
              {t(p.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col items-stretch gap-4 md:flex-row md:items-center">
        <SeatCard id="a" game={game} label={labels[0]} seat={seats[0]} api={api} models={models} onChange={(next) => setSeat(0, next)} />
        <div className="flex flex-col items-center gap-2 self-center">
          <span className="text-4xl font-bold text-pink [-webkit-text-stroke:2px_var(--color-ink)]">VS</span>
          <button className="btn bg-white !px-3 !py-1 text-sm" title={t('setup.swapTitle')} onClick={() => setSetup((s) => ({ ...s, seats: [s.seats[1], s.seats[0]] }))}>
            {t('setup.swap')}
          </button>
        </div>
        <SeatCard id="b" game={game} label={labels[1]} seat={seats[1]} api={api} models={models} onChange={(next) => setSeat(1, next)} />
      </div>

      <div className="toy flex flex-col gap-4 p-5">
        <h3 className="text-sm font-bold uppercase tracking-widest opacity-60">{t('setup.rules')}</h3>
        {game === 'tetris' ? (
          <>
            <div className="grid gap-2.5 sm:grid-cols-3">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className="pick px-3 py-2 text-left"
                  aria-pressed={modeOf(tetris) === m.id}
                  onClick={() => setTetris({ lockstep: m.id === 'lockstep', garbage: m.id === 'versus' })}
                >
                  <span className="block font-bold">
                    {m.emoji} {t(m.key)}
                  </span>
                  <span className="block text-xs leading-tight opacity-70">{t(`${m.key}.hint`)}</span>
                </button>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Option label={t('opt.gravity', { ms: tetris.gravityMs })} hint={t('opt.gravity.hint')}>
                <input type="range" min={80} max={1000} step={10} value={tetris.gravityMs} disabled={tetris.lockstep} onChange={(e) => setTetris({ gravityMs: Number(e.target.value) })} className="accent-[var(--color-pink)]" />
              </Option>
              <Option label={t('opt.speedup')}>
                <select className="field" value={tetris.speedup} onChange={(e) => setTetris({ speedup: e.target.value as SpeedupName })}>
                  {(Object.keys(SPEEDUPS) as SpeedupName[]).map((id) => (
                    <option key={id} value={id}>
                      {t(`speedup.${id}`)}
                    </option>
                  ))}
                </select>
              </Option>
              <Option label={t('opt.garbageTable')} hint={t('opt.garbageTable.hint')}>
                <select className="field" value={tetris.garbageTable} disabled={!tetris.garbage || tetris.lockstep} onChange={(e) => setTetris({ garbageTable: e.target.value as GarbageTable })}>
                  {(Object.keys(GARBAGE_TABLES) as GarbageTable[]).map((id) => (
                    <option key={id} value={id}>
                      {t(`garbageTable.${id}`)}
                    </option>
                  ))}
                </select>
              </Option>
              <Option label={t('opt.timeLimit')} hint={t('opt.timeLimit.hint')}>
                <select className="field" value={tetris.timeLimitSec} onChange={(e) => setTetris({ timeLimitSec: Number(e.target.value) })}>
                  {[60, 120, 180, 300, 600, 0].map((s) => (
                    <option key={s} value={s}>
                      {s === 0 ? t('time.none') : s >= 60 ? t('time.min', { n: s / 60 }) : t('time.sec', { n: s })}
                    </option>
                  ))}
                </select>
              </Option>
              <Option label={t('opt.seed')} hint={t('opt.seed.hint')}>
                <div className="flex gap-2">
                  <input className="field" type="number" min={1} max={999999} value={tetris.seed} onChange={(e) => setTetris({ seed: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
                  <button className="btn bg-white !px-3 !py-1" title={t('opt.randomSeed')} onClick={() => setTetris({ seed: 1 + Math.floor(Math.random() * 99999) })}>
                    🎲
                  </button>
                </div>
              </Option>
            </div>
          </>
        ) : game === 'gomoku' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Option
              label={t('opt.candidates', { n: gomoku.candidateLimit })}
              hint={t('opt.candidates.hint')}
            >
              <input type="range" min={8} max={40} step={1} value={gomoku.candidateLimit} onChange={(e) => setSetup((s) => ({ ...s, gomoku: { ...s.gomoku, candidateLimit: Number(e.target.value) } }))} className="accent-[var(--color-pink)]" />
            </Option>
            <Option label={t('opt.moveTime')} hint={t('opt.moveTime.hint')}>
              <select className="field" value={gomoku.moveLimitMs} onChange={(e) => setSetup((s) => ({ ...s, gomoku: { ...s.gomoku, moveLimitMs: Number(e.target.value) } }))}>
                {[15_000, 30_000, 60_000, 120_000, 0].map((ms) => (
                  <option key={ms} value={ms}>
                    {ms === 0 ? t('time.none') : ms >= 60_000 ? t('time.min', { n: ms / 60_000 }) : t('time.sec', { n: ms / 1000 })}
                  </option>
                ))}
              </select>
            </Option>
            <p className="self-center text-sm leading-snug opacity-70 sm:col-span-2">{t('gomoku.rulesNote')}</p>
          </div>
        ) : game === 'snake' ? (
          <>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <button className="pick px-3 py-2 text-left" aria-pressed={snake.lockstep} onClick={() => setSnake({ lockstep: !snake.lockstep })}>
                <span className="block font-bold">{t('snake.lockstep')}</span>
                <span className="block text-xs leading-tight opacity-70">{t('snake.lockstep.hint')}</span>
              </button>
              <button className="pick px-3 py-2 text-left" aria-pressed={snake.suddenDeath} onClick={() => setSnake({ suddenDeath: !snake.suddenDeath })}>
                <span className="block font-bold">{t('snake.sudden')}</span>
                <span className="block text-xs leading-tight opacity-70">{t('snake.sudden.hint')}</span>
              </button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Option label={t('opt.tick', { ms: snakeTick })} hint={snake.tickAuto ? t('opt.tickAuto.hint') : t('opt.tick.hint')}>
                <div className="flex items-center gap-2">
                  <input type="range" min={80} max={10000} step={10} value={snakeTick} onChange={(e) => setSnake({ tickMs: Number(e.target.value), tickAuto: false })} className="min-w-0 flex-1 accent-[var(--color-pink)]" />
                  <button className="pick px-2 py-0.5 text-xs font-bold" aria-pressed={snake.tickAuto} onClick={() => setSnake({ tickAuto: !snake.tickAuto, tickMs: snakeTick })}>
                    {t('opt.tickAuto')}
                  </button>
                </div>
              </Option>
              <Option label={t('opt.grid')}>
                <select className="field" value={`${snake.cols}x${snake.rows}`} onChange={(e) => { const [cols, rows] = e.target.value.split('x').map(Number); setSnake({ cols, rows }); }}>
                  {GRIDS.map((g) => (
                    <option key={g.key} value={`${g.cols}x${g.rows}`}>
                      {t(g.key)}
                    </option>
                  ))}
                </select>
              </Option>
              <Option label={t('opt.timeLimit')} hint={t('opt.timeLimit.snakeHint')}>
                <select className="field" value={snake.timeLimitSec} onChange={(e) => setSnake({ timeLimitSec: Number(e.target.value) })}>
                  {[60, 120, 180, 300, 600, 0].map((s) => (
                    <option key={s} value={s}>
                      {s === 0 ? t('time.none') : t('time.min', { n: s / 60 })}
                    </option>
                  ))}
                </select>
              </Option>
              <Option label={t('opt.seed')} hint={t('opt.seed.snakeHint')}>
                <div className="flex gap-2">
                  <input className="field" type="number" min={1} max={999999} value={snake.seed} onChange={(e) => setSnake({ seed: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
                  <button className="btn bg-white !px-3 !py-1" title={t('opt.randomSeed')} onClick={() => setSnake({ seed: 1 + Math.floor(Math.random() * 99999) })}>
                    🎲
                  </button>
                </div>
              </Option>
            </div>
          </>
        ) : game === '2048' ? (
          <>
            <button className="pick px-3 py-2 text-left" aria-pressed={g2048.lockstep} onClick={() => set2048({ lockstep: !g2048.lockstep })}>
              <span className="block font-bold">{t('t.lockstep')}</span>
              <span className="block text-xs leading-tight opacity-70">{t('t.lockstep.hint')}</span>
            </button>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Option label={t('opt.timeLimit')} hint={t('opt.timeLimit.scoreHint')}>
                <select className="field" value={g2048.timeLimitSec} onChange={(e) => set2048({ timeLimitSec: Number(e.target.value) })}>
                  {[60, 120, 180, 300, 600, 0].map((s) => (
                    <option key={s} value={s}>
                      {s === 0 ? t('time.none') : t('time.min', { n: s / 60 })}
                    </option>
                  ))}
                </select>
              </Option>
              <Option label={t('opt.seed')} hint={t('opt.seed.2048Hint')}>
                <div className="flex gap-2">
                  <input className="field" type="number" min={1} max={999999} value={g2048.seed} onChange={(e) => set2048({ seed: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
                  <button className="btn bg-white !px-3 !py-1" title={t('opt.randomSeed')} onClick={() => set2048({ seed: 1 + Math.floor(Math.random() * 99999) })}>
                    🎲
                  </button>
                </div>
              </Option>
              <p className="self-center text-sm leading-snug opacity-70">{t('t.rulesNote')}</p>
            </div>
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Option label={t('opt.moveLimit')} hint={t('opt.moveLimit.hint')}>
              <select className="field" value={setup[boardGame].maxMoves} onChange={(e) => setSetup((s) => ({ ...s, [boardGame]: { ...s[boardGame], maxMoves: Number(e.target.value) } }))}>
                {[40, 60, 80, 120, 0].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? t('time.none') : t('moves.n', { n })}
                  </option>
                ))}
              </select>
            </Option>
            <p className="self-center text-sm leading-snug opacity-70">{t(game === 'xiangqi' ? 'x.rulesNote' : 'c.rulesNote')}</p>
          </div>
        )}
      </div>

      {warnings.map((w) => (
        <p key={w} className="toy-sm !bg-sun/60 px-4 py-2 text-sm font-medium">
          💡 {w}
        </p>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className="btn bg-white" onClick={onBack}>
          {t('setup.back')}
        </button>
        <button className="btn bg-mint px-10 py-4 text-2xl" disabled={seats.some((s) => !usable(s.kind)) || missingAlgo} onClick={() => onStart(setup)}>
          {t('setup.start')}
        </button>
      </div>
    </div>
  );
}
