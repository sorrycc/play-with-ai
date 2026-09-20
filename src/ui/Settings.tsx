import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { AGENTS } from '../../server/agents.mjs';
import { t } from '../core/i18n';
import { settings, sortGames } from '../core/settings';
import { fmtMs, fmtUsd } from '../core/types';
import type { GameId } from '../core/types';
import { checkAgent, checkJev, checkModel } from '../players/health';
import type { CheckResult } from '../players/health';
import { DEFAULT_MODEL, FEATURED_MODELS } from '../players/llm';
import { Mark } from './bits';
import { GAMES, GameArt } from './Lobby';
import type { ApiConfig } from './Setup';

/** `null` before anything was asked, 'running' while it is, then what came back. */
type Check = CheckResult | 'running' | null;

function ServiceRow({ mark, color, name, blurb, status, ready, picker, action, check, onCheck }: { mark: ReactNode; color: string; name: string; blurb: string; status: string; ready: boolean | null; picker?: ReactNode; action: string; check: Check; onCheck: () => void }) {
  const done = check !== null && check !== 'running' ? check : null;
  return (
    <li className="toy-sm flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl border-[3px] border-ink bg-white text-2xl" style={{ color }}>
          {mark}
        </span>
        <span className="min-w-40 flex-1">
          <span className="block truncate text-lg font-bold leading-tight">{name}</span>
          <span className="block text-sm leading-tight opacity-70">{blurb}</span>
        </span>
        <span className={`rounded-full border-2 border-ink px-2 py-0.5 text-xs font-bold ${ready ? 'bg-mint' : 'bg-white opacity-60'}`}>
          {ready === null ? '…' : ready ? '✓' : '✗'} {status}
        </span>
        {picker}
        <button className="btn bg-white !py-1.5 text-sm" disabled={check === 'running'} onClick={onCheck}>
          {check === 'running' ? t('settings.svc.checking') : action}
        </button>
      </div>
      {done && (
        <p className={`rounded-xl border-2 border-ink px-3 py-1.5 text-sm leading-snug ${done.ok ? 'bg-mint' : 'bg-white'}`} role="status">
          <span className="font-bold">
            {done.ok ? '✅' : '❌'} {t(done.ok ? 'settings.svc.ok' : 'settings.svc.failed')}
          </span>
          <span className="font-mono opacity-70">
            {' · '}
            {fmtMs(done.ms)}
            {done.cost ? ` · ${fmtUsd(done.cost, 6)}` : ''}
          </span>
          {done.detail && <span className="block break-words opacity-80">{done.detail}</span>}
        </p>
      )}
    </li>
  );
}

function Services({ api }: { api: ApiConfig | null }) {
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, Check>>({});
  /** Each agent's `--version`, asked once when the page opens: free, and says more than "found". */
  const [versions, setVersions] = useState<Record<string, CheckResult>>({});

  useEffect(() => {
    let live = true;
    for (const a of AGENTS) void checkAgent(a.id, false).then((r) => live && setVersions((v) => ({ ...v, [a.id]: r })));
    return () => {
      live = false;
    };
  }, []);

  const run = (id: string, job: () => Promise<CheckResult>) => {
    setChecks((c) => ({ ...c, [id]: 'running' }));
    return job().then((r) => setChecks((c) => ({ ...c, [id]: r })));
  };
  const jobs: Record<string, () => Promise<CheckResult>> = {
    zenmux: () => checkModel(model),
    jev: checkJev,
    ...Object.fromEntries(AGENTS.map((a) => [a.id, () => checkAgent(a.id, true, agentModels[a.id] ?? a.models[0])])),
  };
  const busy = Object.values(checks).some((c) => c === 'running');

  return (
    <section className="toy flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold">{t('settings.services')}</h2>
          <p className="mt-1 text-sm leading-snug opacity-70">{t('settings.services.hint')}</p>
        </div>
        <button className="btn bg-sun !py-1.5 text-sm" disabled={busy} onClick={() => Object.entries(jobs).forEach(([id, job]) => void run(id, job))}>
          {t('settings.svc.checkAll')}
        </button>
      </div>

      <ol className="flex flex-col gap-3">
        <ServiceRow
          mark="🤖"
          color="#7c5cff"
          name={t('settings.svc.models')}
          blurb={t('settings.svc.modelsBlurb')}
          ready={api ? api.zenmux : null}
          status={api?.zenmux === false ? t('settings.svc.keyMissing', { name: 'ZENMUX_API_KEY' }) : t('settings.svc.keySet')}
          picker={
            <select className="field !w-auto text-sm" value={model} onChange={(e) => setModel(e.target.value)} aria-label={t('settings.svc.model')} title={t('settings.svc.model')}>
              {FEATURED_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          }
          action={t('settings.svc.check')}
          check={checks.zenmux ?? null}
          onCheck={() => void run('zenmux', jobs.zenmux)}
        />
        <ServiceRow
          mark="⚡"
          color="#ff9f1c"
          name="Jev"
          blurb={t('settings.svc.jevBlurb')}
          ready={api ? api.jev : null}
          status={api?.jev === false ? t('settings.svc.keyMissing', { name: 'TYPESAFE_API_KEY' }) : t('settings.svc.keySet')}
          action={t('settings.svc.check')}
          check={checks.jev ?? null}
          onCheck={() => void run('jev', jobs.jev)}
        />
        {AGENTS.map((a) => {
          const version = versions[a.id];
          return (
            <ServiceRow
              key={a.id}
              mark={<Mark player={a} />}
              color={a.color}
              name={a.name}
              blurb={t('settings.svc.runHint')}
              ready={version ? version.ok : null}
              status={!version ? t('settings.svc.looking') : version.ok ? t('settings.svc.found', { version: version.detail }) : version.detail || t('settings.svc.missing', { bin: a.bin })}
              picker={
                <select className="field !w-auto text-sm" value={agentModels[a.id] ?? a.models[0]} onChange={(e) => setAgentModels((m) => ({ ...m, [a.id]: e.target.value }))} aria-label={t('settings.svc.model')} title={t('settings.svc.model')}>
                  {a.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              }
              action={t('settings.svc.run')}
              check={checks[a.id] ?? null}
              onCheck={() => void run(a.id, jobs[a.id])}
            />
          );
        })}
      </ol>
    </section>
  );
}

export function SettingsPage({ api, onBack }: { api: ApiConfig | null; onBack: () => void }) {
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

      <Services api={api} />

      <div>
        <button className="btn bg-white" onClick={onBack}>
          {t('setup.back')}
        </button>
      </div>
    </div>
  );
}
