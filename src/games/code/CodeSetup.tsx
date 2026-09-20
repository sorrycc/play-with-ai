// Who plays the code duel is not a free choice of two roles: a person writes on the page, a code
// agent's CLI writes on the server. So this game has a setup of its own: which agent, on which
// model, and which task card.

import { useEffect, useState } from 'react';
import { AGENTS } from '../../../server/agents.mjs';
import { i18n, t } from '../../core/i18n';
import { ROLES } from '../../players';
import { Mark } from '../../ui/bits';
import type { ApiConfig, MatchSetup } from '../../ui/Setup';
import { LEVELS, LevelBadge } from './Level';
import { CODE_LIMITS_SEC, loadCards, type Card, type CardLevel, type CodeOptions } from './match';

const HUMAN = ROLES.find((r) => r.kind === 'human')!;

export function CodeSetup({ initial, api, onStart, onBack }: { initial: MatchSetup; api: ApiConfig | null; onStart: (setup: MatchSetup) => void; onBack: () => void }) {
  const [code, setCode] = useState(initial.code);
  const [cards, setCards] = useState<Card[]>([]);
  const [cardsError, setCardsError] = useState('');
  useEffect(() => {
    loadCards().then((loaded) => {
      setCards(loaded);
      // A remembered card may be gone: the deck changes between versions.
      setCode((c) => (loaded.length === 0 || loaded.some((card) => card.id === c.card) ? c : { ...c, card: loaded[0].id }));
    }, (error) => setCardsError(String(error.message)));
  }, []);

  const patch = (next: Partial<CodeOptions>) => setCode((c) => ({ ...c, ...next }));
  // Until /api/config answers, nothing is known to be missing.
  const available = (id: string) => !api || (api.agents ?? []).includes(id);
  const agent = AGENTS.find((a) => a.id === code.agent) ?? AGENTS[0];
  const model = agent.models.includes(code.agentModel) ? code.agentModel : agent.models[0];
  const lang = i18n.lang;
  const ready = available(agent.id) && cards.some((c) => c.id === code.card);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-16">
      <div className="pop-in">
        <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest opacity-60">
          <Mark player={agent} size="1.2em" /> {t('code.versus', { name: agent.name })}
        </div>
        <h1 className="text-4xl font-bold">{t('setup.title', { game: t('game.code.title') })}</h1>
      </div>

      <div className="flex flex-col items-stretch gap-4 md:flex-row md:items-center">
        <div className="toy flex min-w-0 flex-1 basis-0 flex-col gap-3 p-5">
          <h3 className="text-sm font-bold uppercase tracking-widest opacity-60">{t('seat.left')}</h3>
          <div className="pick flex items-center gap-2 px-3 py-2" aria-pressed="true" style={{ '--pick-color': HUMAN.color, cursor: 'default' } as React.CSSProperties}>
            <span className="text-2xl">{HUMAN.emoji}</span>
            <span className="min-w-0">
              <span className="block font-bold leading-tight">{t('role.human.title')}</span>
              <span className="block text-[11px] leading-tight opacity-70">{t('code.setup.you')}</span>
            </span>
          </div>
          <p className="text-xs leading-snug opacity-60">{t('code.setup.only')}</p>
        </div>

        <span className="self-center text-4xl font-bold text-pink [-webkit-text-stroke:2px_var(--color-ink)]">VS</span>

        <div className="toy flex min-w-0 flex-1 basis-0 flex-col gap-3 p-5">
          <h3 className="text-sm font-bold uppercase tracking-widest opacity-60">
            {t('seat.right')} · {t('role.agent.title')}
          </h3>
          <div className={`grid gap-2.5 ${AGENTS.length > 1 ? 'grid-cols-2' : ''}`}>
            {AGENTS.map((a) => (
              <button
                key={a.id}
                className="pick flex items-center gap-2 px-3 py-2 text-left text-white aria-[pressed=false]:text-ink"
                aria-pressed={agent.id === a.id}
                disabled={!available(a.id)}
                style={{ '--pick-color': a.color } as React.CSSProperties}
                title={available(a.id) ? a.blurb[i18n.lang] : t('code.setup.noAgent', { bin: a.bin })}
                onClick={() => patch({ agent: a.id, agentModel: a.models[0] })}
              >
                {/* On white: a selected button is filled with the agent's own colour. */}
                <span className="grid size-9 shrink-0 place-items-center rounded-full border-2 border-ink bg-white text-xl">
                  <Mark player={a} />
                </span>
                <span className="min-w-0">
                  <span className="block font-bold leading-tight">{a.name}</span>
                  <span className="block text-[11px] leading-tight opacity-70">{available(a.id) ? a.blurb[lang] : t('code.setup.noAgent', { bin: a.bin })}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 rounded-2xl border-2 border-dashed border-ink/40 p-3">
            <label className="text-xs font-bold uppercase tracking-wide opacity-60" htmlFor="agent-model">
              {t('code.setup.agentModel')}
            </label>
            <select id="agent-model" className="field" value={model} onChange={(e) => patch({ agentModel: e.target.value })}>
              {agent.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="toy flex flex-col gap-4 p-5">
        <h3 className="text-sm font-bold uppercase tracking-widest opacity-60">{t('code.setup.card')}</h3>
        {([1, 2, 3] as CardLevel[]).map((level) => {
          const deck = cards.filter((card) => card.level === level);
          if (deck.length === 0) return null;
          return (
            <div key={level} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <LevelBadge level={level} />
                <span className="text-xs opacity-70">
                  {t(LEVELS[level].blurb)} · {t('time.min', { n: LEVELS[level].limitSec / 60 })}
                </span>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {deck.map((card) => (
                  // A card brings its level's time limit with it; the select below still has the last word.
                  <button
                    key={card.id}
                    className="pick px-3 py-2 text-left"
                    aria-pressed={code.card === card.id}
                    style={{ '--pick-color': LEVELS[level].color } as React.CSSProperties}
                    onClick={() => patch({ card: card.id, limitSec: LEVELS[level].limitSec })}
                  >
                    <span className="block font-bold">{card.title[lang]}</span>
                    <span className="block text-xs leading-tight opacity-70">{card.intro[lang]}</span>
                    <span className="mt-1 block text-[11px] font-bold uppercase tracking-wide opacity-50">{card.repo ? t('code.setup.realRepo', { repo: card.repo }) : t('code.setup.miniRepo')}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold uppercase tracking-wide opacity-60">{t('opt.timeLimit')}</span>
            <select className="field" value={code.limitSec} onChange={(e) => patch({ limitSec: Number(e.target.value) })}>
              {CODE_LIMITS_SEC.map((s) => (
                <option key={s} value={s}>
                  {t('time.min', { n: s / 60 })}
                </option>
              ))}
            </select>
          </label>
          <p className="self-center text-sm leading-snug opacity-70">{t('code.rulesNote', { name: agent.name })}</p>
        </div>
      </div>

      {cardsError && <p className="toy-sm !bg-sun/60 px-4 py-2 text-sm font-medium">💡 {t('code.setup.cardsFailed', { message: cardsError })}</p>}
      {!available(agent.id) && <p className="toy-sm !bg-sun/60 px-4 py-2 text-sm font-medium">💡 {t('code.setup.noAgent', { bin: agent.bin })}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className="btn bg-white" onClick={onBack}>
          {t('setup.back')}
        </button>
        <button className="btn bg-mint px-10 py-4 text-2xl" disabled={!ready} onClick={() => onStart({ ...initial, code: { ...code, agent: agent.id, agentModel: model } })}>
          {t('setup.start')}
        </button>
      </div>
    </div>
  );
}
