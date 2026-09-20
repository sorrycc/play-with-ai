import { Suspense, lazy, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { API_VERSION } from '../server/version.mjs';
import { i18n, t } from './core/i18n';
import { sfx } from './core/sound';
import type { GameId, PlayerConfig } from './core/types';
import { CodeSetup } from './games/code/CodeSetup';
import { CODE_DEFAULTS } from './games/code/match';
import { GOMOKU_DEFAULTS } from './games/gomoku/match';
import { GomokuArena } from './games/gomoku/GomokuArena';
import { ChessArena } from './games/chess/ChessArena';
import { CHESS_DEFAULTS } from './games/chess/match';
import { Arena2048 } from './games/g2048/Arena2048';
import { DEFAULTS_2048 } from './games/g2048/match';
import { SNAKE_DEFAULTS } from './games/snake/match';
import { XIANGQI_DEFAULTS } from './games/xiangqi/match';
import { XiangqiArena } from './games/xiangqi/XiangqiArena';
import { SnakeArena } from './games/snake/SnakeArena';
import { TETRIS_DEFAULTS } from './games/tetris/match';
import { TetrisArena } from './games/tetris/TetrisArena';
import { DEFAULT_MODEL } from './players/llm';
import { Floaters, Lobby } from './ui/Lobby';
import { SettingsPage } from './ui/Settings';
import { Setup, type ApiConfig, type MatchSetup } from './ui/Setup';

// The code duel brings an editor with it; nobody playing chess should download that.
const CodeArena = lazy(() => import('./games/code/CodeArena').then((m) => ({ default: m.CodeArena })));

type Screen = { name: 'lobby' } | { name: 'settings' } | { name: 'setup'; game: GameId } | { name: 'play'; game: GameId; round: number };

const STORAGE_KEY = 'play-with-ai:setup:v1';

const DEFAULT_SETUP: MatchSetup = {
  seats: [
    { kind: 'llm', model: DEFAULT_MODEL, thinking: false },
    { kind: 'jev', model: DEFAULT_MODEL, thinking: false },
  ],
  tetris: TETRIS_DEFAULTS,
  gomoku: GOMOKU_DEFAULTS,
  snake: SNAKE_DEFAULTS,
  g2048: DEFAULTS_2048,
  chess: CHESS_DEFAULTS,
  xiangqi: XIANGQI_DEFAULTS,
  code: CODE_DEFAULTS,
};

/** The last setup is a per-browser convenience; anything unreadable falls back to the defaults. */
function loadSetup(): MatchSetup {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved || !Array.isArray(saved.seats) || saved.seats.length !== 2) return DEFAULT_SETUP;
    return {
      seats: saved.seats,
      tetris: { ...TETRIS_DEFAULTS, ...saved.tetris },
      gomoku: { ...GOMOKU_DEFAULTS, ...saved.gomoku },
      snake: { ...SNAKE_DEFAULTS, ...saved.snake },
      g2048: { ...DEFAULTS_2048, ...saved.g2048 },
      // Pacing is not a user setting, so a value saved by an older version must not stick.
      chess: { ...CHESS_DEFAULTS, ...saved.chess, minMoveMs: CHESS_DEFAULTS.minMoveMs },
      xiangqi: { ...XIANGQI_DEFAULTS, ...saved.xiangqi, minMoveMs: XIANGQI_DEFAULTS.minMoveMs },
      code: { ...CODE_DEFAULTS, ...saved.code },
    };
  } catch {
    return DEFAULT_SETUP;
  }
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'lobby' });
  const [setup, setSetup] = useState<MatchSetup>(loadSetup);
  const [api, setApi] = useState<ApiConfig | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setApi)
      .catch(() => setApi({ zenmux: false, jev: false, agents: [] }));
  }, []);

  const muted = useSyncExternalStore(sfx.subscribe, () => sfx.muted);
  // Reading the language here re-renders the whole tree on a switch, which is what makes every
  // plain t() call below pick up the new language.
  const lang = useSyncExternalStore(i18n.subscribe, () => i18n.lang);

  // Audio may only start from a gesture, so the first press both unlocks it and clicks.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      sfx.unlock();
      const button = (e.target as HTMLElement | null)?.closest('button');
      if (button && !button.disabled && !button.hasAttribute('data-silent')) sfx.play('click');
    };
    const onKey = () => sfx.unlock();
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const start = (game: GameId, next: MatchSetup) => {
    setSetup(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private window: the setup just is not remembered */
    }
    setScreen({ name: 'play', game, round: 1 });
  };

  const lobby = () => setScreen({ name: 'lobby' });
  // Stable across renders: the arena builds its players from this.
  const codeSeats = useMemo<[PlayerConfig, PlayerConfig]>(() => [{ kind: 'human' }, { kind: 'agent', agent: setup.code.agent, agentModel: setup.code.agentModel }], [setup.code.agent, setup.code.agentModel]);

  return (
    <div className="min-h-screen">
      <Floaters />
      <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4">
        <button className="flex items-center gap-2 text-xl font-bold" onClick={lobby}>
          <span className="grid size-10 place-items-center rounded-xl border-[3px] border-ink bg-sun text-xl shadow-[3px_3px_0_var(--color-ink)]">🕹️</span>
          Play with AI
        </button>
        <div className="flex items-center gap-2 text-xs font-semibold">
          <button
            className="btn bg-white !px-2.5 !py-1 text-base"
            onClick={() => sfx.setMuted(!muted)}
            aria-pressed={muted}
            aria-label={t(muted ? 'nav.turnSoundOn' : 'nav.turnSoundOff')}
            title={t(muted ? 'nav.soundOff' : 'nav.soundOn')}
            data-silent
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button
            className="btn bg-white !px-2.5 !py-1 text-base"
            onClick={() => setScreen({ name: 'settings' })}
            aria-label={t('settings.title')}
            title={t('settings.title')}
            aria-current={screen.name === 'settings' ? 'page' : undefined}
          >
            ⚙️
          </button>
          <button className="btn bg-white !px-2.5 !py-1 text-xs" onClick={() => i18n.setLang(lang === 'zh' ? 'en' : 'zh')} aria-label={t('nav.switchLang')} title={t('nav.switchLang')}>
            {t('nav.otherLang')}
          </button>
          {api && (
            <>
              <span className={`rounded-full border-2 border-ink px-2 py-0.5 ${api.zenmux ? 'bg-mint' : 'bg-white opacity-50'}`} title={t('nav.keyHint', { name: 'ZENMUX_API_KEY' })}>
                {t('nav.models')} {api.zenmux ? '✓' : '✗'}
              </span>
              <span className={`rounded-full border-2 border-ink px-2 py-0.5 ${api.jev ? 'bg-mint' : 'bg-white opacity-50'}`} title={t('nav.keyHint', { name: 'TYPESAFE_API_KEY' })}>
                Jev {api.jev ? '✓' : '✗'}
              </span>
            </>
          )}
        </div>
      </nav>

      {api && (api.version ?? 0) < API_VERSION && (
        <div className="mx-auto mb-4 w-full max-w-3xl px-4">
          <p className="toy-sm !bg-sun px-4 py-2 text-sm font-semibold" role="alert">
            🔄 {t('nav.staleServer')}
          </p>
        </div>
      )}
      {screen.name === 'lobby' && <Lobby onPick={(game) => setScreen({ name: 'setup', game })} onSettings={() => setScreen({ name: 'settings' })} />}
      {screen.name === 'settings' && <SettingsPage onBack={lobby} />}
      {screen.name === 'setup' &&
        (screen.game === 'code' ? (
          <CodeSetup initial={setup} api={api} onStart={(next) => start('code', next)} onBack={lobby} />
        ) : (
          <Setup game={screen.game} initial={setup} api={api} onStart={(next) => start(screen.game, next)} onBack={lobby} />
        ))}
      {screen.name === 'play' &&
        (() => {
          const common = {
            seats: setup.seats,
            onRematch: () => setScreen({ ...screen, round: screen.round + 1 }),
            onSetup: () => setScreen({ name: 'setup', game: screen.game }),
            onLobby: lobby,
          };
          // `key` remounts the arena, which is how a rematch gets a fresh match.
          return screen.game === 'tetris' ? (
            <TetrisArena key={screen.round} {...common} options={setup.tetris} />
          ) : screen.game === 'gomoku' ? (
            <GomokuArena key={screen.round} {...common} options={setup.gomoku} />
          ) : screen.game === 'snake' ? (
            <SnakeArena key={screen.round} {...common} options={setup.snake} />
          ) : screen.game === '2048' ? (
            <Arena2048 key={screen.round} {...common} options={setup.g2048} />
          ) : screen.game === 'code' ? (
            <Suspense fallback={null}>
              <CodeArena key={screen.round} {...common} seats={codeSeats} options={setup.code} />
            </Suspense>
          ) : screen.game === 'chess' ? (
            <ChessArena key={screen.round} {...common} options={setup.chess} />
          ) : (
            <XiangqiArena key={screen.round} {...common} options={setup.xiangqi} />
          );
        })()}
    </div>
  );
}
