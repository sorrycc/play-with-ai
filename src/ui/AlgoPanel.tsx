import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { i18n, t, type TextKey } from '../core/i18n';
import type { DecisionGameId, PlayerConfig } from '../core/types';
import { algos, type Algorithm } from '../players/algos';
import { completeForGeneration } from '../players/custom';
import { GenerationError, generateAlgorithm } from '../players/generate';
import { DEFAULT_MODEL, FEATURED_MODELS, type ModelInfo } from '../players/llm';
import { createWorkerRunner } from '../players/sandbox';

const CUSTOM = '__custom__';

type Status = { kind: 'idle' } | { kind: 'busy'; stage: 'writing' | 'testing' | 'repairing' } | { kind: 'done'; text: string } | { kind: 'error'; text: string };

/** The algorithm a custom seat will actually use in this game: an id saved for another game does not count. */
export function algoForSeat(seat: PlayerConfig, game: DecisionGameId): Algorithm | undefined {
  const algo = algos.get(seat.algoId);
  return algo?.game === game ? algo : undefined;
}

export function AlgoPanel({
  game,
  seat,
  canGenerate,
  models,
  onChange,
}: {
  game: DecisionGameId;
  seat: PlayerConfig;
  /** False when the model key is missing: saved algorithms still work, new ones cannot be written. */
  canGenerate: boolean;
  models: ModelInfo[];
  onChange: (next: PlayerConfig) => void;
}) {
  useSyncExternalStore(algos.subscribe, algos.all);
  const saved = algos.forGame(game);
  const selected = algoForSeat(seat, game);
  const model = seat.model ?? DEFAULT_MODEL;
  const [customModel, setCustomModel] = useState(() => !(FEATURED_MODELS as readonly string[]).includes(model));
  const [wish, setWish] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const inFlight = useRef<AbortController | null>(null);

  // The seat is shared between games, so it may point at another game's algorithm (or a deleted
  // one). Fall back to the newest algorithm for this game rather than leave the seat unusable.
  useEffect(() => {
    if (!selected && saved.length > 0) onChange({ ...seat, algoId: saved[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, selected?.id, saved.length]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const generate = async () => {
    const controller = new AbortController();
    inFlight.current = controller;
    setStatus({ kind: 'busy', stage: 'writing' });
    try {
      const result = await generateAlgorithm(game, wish, {
        complete: (messages) => completeForGeneration(model, messages, controller.signal),
        createRunner: (code) => createWorkerRunner(code),
        onStage: (stage) => setStatus({ kind: 'busy', stage }),
      });
      const algo = algos.save({ game, name: result.name, prompt: wish.trim(), model, code: result.code });
      onChange({ ...seat, algoId: algo.id });
      setStatus({ kind: 'done', text: t('algo.ready', { n: result.attempts, tokens: (result.inputTokens + result.outputTokens).toLocaleString() }) });
      setWish('');
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof GenerationError || error instanceof Error ? error.message : String(error);
      setStatus({ kind: 'error', text: t('algo.failed', { msg: message }) });
    }
  };

  const busy = status.kind === 'busy';
  const dateOf = (a: Algorithm) => new Date(a.createdAt).toLocaleDateString(i18n.lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' });

  return (
    // min-w-0 all the way down: without it one long line of code widens the whole seat card.
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border-2 border-dashed border-ink/40 p-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-xs font-bold uppercase tracking-wide opacity-60">{t('algo.saved')}</span>
        {saved.length === 0 ? (
          <p className="text-sm opacity-70">{t('algo.none')}</p>
        ) : (
          <div className="flex gap-2">
            <select className="field !font-[family-name:var(--font-display)]" value={selected?.id ?? ''} onChange={(e) => onChange({ ...seat, algoId: e.target.value })} aria-label={t('algo.saved')}>
              {saved.map((a) => (
                <option key={a.id} value={a.id}>
                  ✨ {a.name}
                </option>
              ))}
            </select>
            {selected && (
              <button className="btn bg-white !px-3 !py-1 text-sm" onClick={() => algos.remove(selected.id)} title={t('algo.delete')} aria-label={`${t('algo.delete')}: ${selected.name}`}>
                🗑
              </button>
            )}
          </div>
        )}
        {selected && (
          <details className="min-w-0 text-xs">
            <summary className="cursor-pointer select-none font-semibold opacity-70">
              {t('algo.viewCode')} · <span className="font-mono">{t('algo.by', { model: selected.model.split('/').pop() ?? selected.model, date: dateOf(selected) })}</span>
            </summary>
            {selected.prompt && <p className="mt-1.5 rounded-lg bg-paper px-2 py-1 leading-snug">“{selected.prompt}”</p>}
            <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg border-2 border-ink/70 bg-night p-2 font-mono text-[11px] leading-snug text-white/90">{selected.code}</pre>
          </details>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t-2 border-dashed border-ink/20 pt-3">
        <label className="text-xs font-bold uppercase tracking-wide opacity-60" htmlFor={`wish-${game}`}>
          {t('algo.new')} · {t('algo.wish')}
        </label>
        <textarea
          id={`wish-${game}`}
          className="field min-h-20 resize-y !font-[family-name:var(--font-display)] !text-sm"
          value={wish}
          maxLength={800}
          disabled={busy}
          placeholder={t(`algo.wish.placeholder.${game}` as TextKey)}
          onChange={(e) => setWish(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wide opacity-60">{t('algo.model')}</span>
          <select
            className="field min-w-0 flex-1"
            value={customModel ? CUSTOM : model}
            disabled={busy}
            aria-label={t('algo.model')}
            onChange={(e) => {
              const picked = e.target.value === CUSTOM;
              setCustomModel(picked);
              if (!picked) onChange({ ...seat, model: e.target.value });
            }}
          >
            {FEATURED_MODELS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
            <option value={CUSTOM}>{t('setup.customModel')}</option>
          </select>
        </div>
        {customModel && (
          <>
            <input className="field" list={`algo-models-${game}`} value={model} spellCheck={false} disabled={busy} placeholder="provider/model-name" aria-label={t('setup.customModel')} onChange={(e) => onChange({ ...seat, model: e.target.value })} />
            <datalist id={`algo-models-${game}`}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </datalist>
          </>
        )}
        <button className="btn self-start bg-sun" disabled={busy || !canGenerate || wish.trim().length < 4} onClick={generate}>
          {busy ? t(`algo.stage.${status.stage}`) : t('algo.generate')}
        </button>
        {!canGenerate && <p className="text-xs font-semibold text-pink">{t('algo.needsKey')}</p>}
        {status.kind === 'done' && <p className="text-xs font-semibold text-[#0a8f5b]">✓ {status.text}</p>}
        {status.kind === 'error' && (
          <p className="break-words text-xs font-semibold text-pink" role="alert">
            {status.text}
          </p>
        )}
        <p className="text-[11px] leading-snug opacity-60">{t('algo.note')}</p>
      </div>
    </div>
  );
}
