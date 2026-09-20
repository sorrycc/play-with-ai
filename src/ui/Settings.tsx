import { useState, useSyncExternalStore } from 'react';
import { t } from '../core/i18n';
import { settings, sortGames } from '../core/settings';
import type { GameId } from '../core/types';
import { GAMES, GameArt } from './Lobby';

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const { hiddenGames, gameOrder } = useSyncExternalStore(settings.subscribe, settings.get);
  const games = sortGames(GAMES, gameOrder);
  const ids = games.map((g) => g.id);
  const shownCount = games.filter((g) => !hiddenGames.includes(g.id)).length;
  const [dragging, setDragging] = useState<GameId | null>(null);
  const [over, setOver] = useState<GameId | null>(null);

  const drop = (target: GameId) => {
    if (dragging && dragging !== target) settings.moveGame(ids, dragging, ids.indexOf(target));
    setDragging(null);
    setOver(null);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-16">
      <div className="pop-in">
        <h1 className="text-4xl font-bold">⚙️ {t('settings.title')}</h1>
      </div>

      <section className="toy flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">{t('settings.games')}</h2>
            <p className="mt-1 text-sm leading-snug opacity-70">{t('settings.games.hint')}</p>
          </div>
          <span className="rounded-full border-2 border-ink bg-paper px-3 py-0.5 font-mono text-sm font-bold">
            {shownCount} / {games.length}
          </span>
        </div>

        <ol className="flex flex-col gap-3">
          {games.map((game, index) => {
            const shown = !hiddenGames.includes(game.id);
            return (
              // Dragging is a mouse convenience; the arrows do the same job for keyboard and touch.
              <li
                key={game.id}
                draggable
                onDragStart={(e) => {
                  setDragging(game.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', game.id);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (over !== game.id) setOver(game.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(game.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                className={`toy-sm flex items-center gap-3 p-2.5 transition-[opacity,transform] ${shown ? '' : '!bg-paper'} ${dragging === game.id ? 'opacity-40' : ''} ${
                  over === game.id && dragging && dragging !== game.id ? '!border-grape -translate-y-0.5' : ''
                }`}
              >
                <span className="cursor-grab select-none px-1 text-xl leading-none opacity-40 active:cursor-grabbing" title={t('settings.drag')} aria-hidden>
                  ⠿
                </span>
                <span className="w-5 text-center font-mono text-sm font-bold opacity-50">{index + 1}</span>
                <span className={`grid h-14 w-20 shrink-0 place-items-center overflow-hidden rounded-xl border-[3px] border-ink ${shown ? '' : 'opacity-50'}`} style={{ background: game.color }}>
                  <GameArt id={game.id} className="h-10 w-auto" />
                </span>
                <span className={`min-w-0 flex-1 ${shown ? '' : 'opacity-50'}`}>
                  <span className="block truncate text-lg font-bold leading-tight">{t(`game.${game.id}.title`)}</span>
                  <span className="block truncate text-sm leading-tight opacity-70">{t(`game.${game.id}.subtitle`)}</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <button
                    className="btn bg-white !px-2.5 !py-1 text-sm"
                    disabled={index === 0}
                    onClick={() => settings.moveGame(ids, game.id, index - 1)}
                    aria-label={`${t('settings.moveUp')}: ${t(`game.${game.id}.title`)}`}
                    title={t('settings.moveUp')}
                  >
                    ▲
                  </button>
                  <button
                    className="btn bg-white !px-2.5 !py-1 text-sm"
                    disabled={index === games.length - 1}
                    onClick={() => settings.moveGame(ids, game.id, index + 1)}
                    aria-label={`${t('settings.moveDown')}: ${t(`game.${game.id}.title`)}`}
                    title={t('settings.moveDown')}
                  >
                    ▼
                  </button>
                </span>
                <button
                  role="switch"
                  aria-checked={shown}
                  aria-label={`${t(shown ? 'settings.shown' : 'settings.hidden')}: ${t(`game.${game.id}.title`)}`}
                  title={t(shown ? 'settings.shown' : 'settings.hidden')}
                  onClick={() => settings.setGameVisible(game.id, !shown)}
                  className={`relative h-8 w-14 shrink-0 rounded-full border-[3px] border-ink transition-colors ${shown ? 'bg-mint' : 'bg-white'}`}
                >
                  <span className={`absolute top-0.5 size-5 rounded-full border-[3px] border-ink bg-white transition-[left] duration-200 ${shown ? 'left-[26px]' : 'left-0.5'}`} />
                </button>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap gap-2">
          {shownCount < games.length && (
            <button className="btn bg-white !py-1.5 text-sm" onClick={() => settings.showAllGames()}>
              {t('settings.showAll')}
            </button>
          )}
          {gameOrder.length > 0 && (
            <button className="btn bg-white !py-1.5 text-sm" onClick={() => settings.resetGameOrder()}>
              {t('settings.resetOrder')}
            </button>
          )}
        </div>
      </section>

      <div>
        <button className="btn bg-white" onClick={onBack}>
          {t('setup.back')}
        </button>
      </div>
    </div>
  );
}
