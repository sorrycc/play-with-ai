import { useEffect, useMemo, useRef, useState } from 'react';
import type { Player, PlayerConfig } from '../../core/types';
import { formatClock } from '../../core/types';
import { i18n, t, type TextKey } from '../../core/i18n';
import { sfx } from '../../core/sound';
import { findAgent } from '../../../server/agents.mjs';
import { createPlayer } from '../../players';
import { Countdown, Mark, PlayerBadge, MatchEnding, StatsGrid, seatMood, type CompareRow } from '../../ui/bits';
import { useMatch } from '../../ui/useMatch';
import { Editor } from './Editor';
import { LEVELS, LevelBadge } from './Level';
import { CodeMatch, loadCards, type Card, type CodeOptions, type LogEntry, type SideStatus } from './match';

const STATUS_KEY: Record<SideStatus, TextKey> = {
  idle: 'code.status.idle',
  working: 'code.status.working',
  verifying: 'code.status.verifying',
  pass: 'code.status.pass',
  fail: 'code.status.fail',
  killed: 'code.status.killed',
  error: 'code.status.error',
};

const LOG_ICON: Record<LogEntry['kind'], string> = { think: '💭', say: '💬', tool: '🔧', info: 'ℹ️' };

const seconds = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);

function StatusTag({ status }: { status: SideStatus }) {
  const color = status === 'pass' ? 'bg-mint' : status === 'fail' || status === 'killed' || status === 'error' ? 'bg-pink text-white' : status === 'verifying' ? 'bg-sun' : 'bg-white';
  return <span className={`shrink-0 rounded-full border-2 border-ink px-2 text-xs font-bold ${color}`}>{t(STATUS_KEY[status])}</span>;
}

function TaskCard({ card }: { card: Card }) {
  const lang = i18n.lang;
  return (
    <section className="toy flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl font-bold leading-tight">{card.title[lang]}</h2>
        <LevelBadge level={card.level} />
      </div>
      <p className="text-sm leading-snug opacity-80">{card.intro[lang]}</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-snug">
        {card.tasks[lang].map((task) => (
          <li key={task}>{task}</li>
        ))}
      </ul>
      <div className="flex flex-col gap-1 rounded-2xl border-2 border-dashed border-ink/40 p-2.5 font-mono text-xs">
        {card.examples.map((e) => (
          <div key={e.input} className="flex flex-wrap gap-x-2">
            <span>{e.input}</span>
            <span className="opacity-60">→ {e.output}</span>
          </div>
        ))}
      </div>
      {/* From level 2 up the hint is there for the asking: someone who writes code may want to do without. */}
      {card.level === 1 ? (
        <p className="text-xs font-semibold opacity-70">💡 {card.hint[lang]}</p>
      ) : (
        <details className="text-xs font-semibold opacity-70">
          <summary className="cursor-pointer">💡 {t('code.hint.show')}</summary>
          <p className="mt-1">{card.hint[lang]}</p>
        </details>
      )}
    </section>
  );
}

/** The agent's thoughts, words and tool calls as they arrive; stays at the bottom unless the visitor scrolled up. */
function AgentLog({ log, working, name }: { log: LogEntry[]; working: boolean; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [log.length]);
  return (
    <div
      ref={box}
      className="bezel flex h-[min(46vh,420px)] !rounded-t-none min-h-56 flex-col gap-1.5 overflow-y-auto p-3 font-mono text-xs leading-snug text-white"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      role="log"
      aria-label={t('code.log', { name })}
    >
      {log.length === 0 && <span className="opacity-50">{t(working ? 'code.log.waiting' : 'code.log.empty')}</span>}
      {log.map((entry, i) => (
        <div key={i} className={`flex gap-2 ${entry.kind === 'think' ? 'opacity-60' : entry.kind === 'tool' ? 'text-sun' : entry.kind === 'info' ? 'text-pink' : ''}`}>
          <span className="w-9 shrink-0 text-right opacity-50">{Math.floor(entry.at / 1000)}s</span>
          <span className="shrink-0">{LOG_ICON[entry.kind]}</span>
          <span className="min-w-0 break-words">{entry.text}</span>
        </div>
      ))}
    </div>
  );
}

function compareRows(match: CodeMatch): CompareRow[] {
  const { human, agent } = match;
  const verdict = (status: SideStatus) => (status === 'pass' ? '✅ PASS' : status === 'fail' ? '❌ FAIL' : '–');
  return [
    [t('code.cmp.verdict'), verdict(human.status), verdict(agent.status)],
    [t('code.cmp.time'), human.status === 'pass' ? seconds(human.doneMs) : '–', agent.doneMs !== null && agent.status !== 'killed' ? seconds(agent.doneMs) : '–'],
    [t('code.cmp.attempts'), human.attempts, agent.status === 'pass' || agent.status === 'fail' ? 1 : 0],
    [t('code.cmp.changed'), match.changedFiles().length, agent.changed.length],
    [t('code.cmp.turns'), '–', agent.usage?.turns ?? '–'],
    [t('code.cmp.tokens'), '–', agent.usage ? `${agent.usage.inputTokens.toLocaleString()} / ${agent.usage.outputTokens.toLocaleString()}` : '–'],
    [t('code.cmp.credits'), '–', agent.usage ? agent.usage.credits.toFixed(2) : '–'],
  ];
}

export function CodeArena({
  seats,
  options,
  onRematch,
  onSetup,
  onLobby,
}: {
  seats: [PlayerConfig, PlayerConfig];
  options: CodeOptions;
  onRematch: () => void;
  onSetup: () => void;
  onLobby: () => void;
}) {
  const players = useMemo(() => seats.map(createPlayer) as [Player, Player], [seats]);
  const { match, count } = useMatch((onChange) => new CodeMatch(options, onChange, (event) => sfx.play(event.pass ? 'levelup' : 'miss')));
  const [card, setCard] = useState<Card | null>(null);
  const [active, setActive] = useState('');
  const [, setClock] = useState(0);
  const [resultOpen, setResultOpen] = useState(true);

  useEffect(() => {
    void loadCards().then((cards) => {
      const found = cards.find((c) => c.id === options.card) ?? null;
      setCard(found);
      if (found) setActive(found.open);
    }, () => {});
  }, [options.card]);

  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 250);
    return () => clearInterval(id);
  }, []);

  // A verdict appears under the editor, which may be off screen on a laptop.
  const verdictBox = useRef<HTMLDivElement>(null);
  const lastVerdict = match?.verdict ?? null;
  useEffect(() => {
    if (lastVerdict) verdictBox.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [lastVerdict]);

  if (!match) return null;
  const names = Object.keys(match.files);
  const changed = match.changedFiles();
  const elapsed = match.elapsed();
  const left = Math.max(0, match.limitMs - elapsed);
  const verdict = match.verdict;
  const agentBin = findAgent(options.agent)?.bin ?? options.agent;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-5 px-4 pb-10">
      <Countdown value={count} />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <span className={`toy-sm px-4 py-1 font-mono text-2xl font-bold ${match.status === 'running' && left < 30_000 ? '!bg-pink text-white' : ''}`} title={t('code.clockTitle')}>
          {formatClock(elapsed)} <span className="text-base opacity-60">/ {formatClock(match.limitMs)}</span>
        </span>
        <span className="toy-sm flex items-center gap-2 !bg-white px-3 py-1 text-sm font-bold">
          <Mark player={players[1]} size="1.3em" /> {t('code.versus', { name: players[1].name })}
        </span>
        <span className="toy-sm !bg-sun px-3 py-1 text-sm font-bold">{t('code.firstPass')}</span>
        {match.status !== 'done' ? (
          <button className="btn bg-pink !py-1.5 text-sm text-white" onClick={() => match.stop()}>
            {t('arena.stop')}
          </button>
        ) : (
          match.result && (
            <button className="btn bg-mint !py-1.5 text-sm" onClick={() => setResultOpen(true)}>
              {t('arena.results')}
            </button>
          )
        )}
      </div>

      {match.error && (
        <div className="toy-sm flex flex-wrap items-center gap-3 !bg-pink px-4 py-2 text-sm font-medium text-white" role="alert">
          <span className="whitespace-pre-wrap">⚠️ {match.error}</span>
          <button className="btn bg-white !px-3 !py-1 text-ink" onClick={onSetup}>
            {t('result.change')}
          </button>
        </div>
      )}
      {match.status === 'preparing' && !match.error && count === null && <p className="toy-sm !bg-sun/60 px-4 py-2 text-sm font-medium">⏳ {t('code.preparing')}</p>}

      <div className="grid w-full items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="flex min-w-0 flex-col gap-5">
          {card && <TaskCard card={card} />}

          <section className={`toy flex min-w-0 flex-col overflow-hidden ${seatMood(match.result, 0) === 'seat-win' ? 'seat-win' : ''}`}>
            <div className="p-4 pb-3">
              <PlayerBadge player={players[0]} thinking={match.human.status === 'verifying'} move={match.human.attempts ? t('code.submitted', { n: match.human.attempts }) : t('code.keys')} tag={<StatusTag status={match.human.status} />} />
            </div>
            <div className="flex gap-1 overflow-x-auto border-y-[3px] border-ink bg-paper px-2 pt-2" role="tablist">
              {names.map((name) => (
                <button
                  key={name}
                  role="tab"
                  aria-selected={name === active}
                  data-silent
                  className={`shrink-0 rounded-t-xl border-[3px] border-b-0 border-ink px-3 py-1 font-mono text-xs font-semibold ${name === active ? 'bg-white' : 'bg-paper opacity-60 hover:opacity-100'}`}
                  onClick={() => setActive(name)}
                >
                  {name}
                  {changed.includes(name) && <span className="ml-1 text-pink" title={t('code.modified')}>●</span>}
                </button>
              ))}
            </div>
            <Editor files={match.files} active={active} editable={match.canEdit} onEdit={(name, content) => match.edit(name, content)} onRunTests={() => void match.runTests()} onSubmit={() => void match.submit()} />
            <div className="flex flex-wrap items-center gap-3 border-t-[3px] border-ink bg-paper p-3">
              <button className="btn bg-white !py-2 text-sm" disabled={!match.canEdit || match.busy !== null} onClick={() => void match.runTests()}>
                {match.busy === 'test' ? t('code.running') : t('code.run')}
              </button>
              <button className="btn bg-mint !py-2" disabled={!match.canEdit || match.busy !== null} onClick={() => void match.submit()}>
                {match.busy === 'submit' ? t('code.verifying') : t('code.submit')}
              </button>
            </div>
            {verdict && (
              <div ref={verdictBox} className={`border-t-[3px] border-ink p-3 ${verdict.ok ? 'bg-mint/30' : 'bg-pink/15'}`}>
                <p className="text-sm font-bold">{t(verdict.kind === 'test' ? (verdict.ok ? 'code.v.testOk' : 'code.v.testFail') : verdict.ok ? 'code.v.submitOk' : 'code.v.submitFail')}</p>
                {!(verdict.kind === 'submit' && verdict.ok) && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-snug">{verdict.output}</pre>}
              </div>
            )}
          </section>
        </div>

        <section className={`toy flex min-w-0 flex-col gap-3 p-4 lg:sticky lg:top-4 ${seatMood(match.result, 1)}`}>
          {/* The bubble is what it is doing right now: its latest thought, word or tool call. */}
          <PlayerBadge player={players[1]} thinking={match.agent.status === 'verifying' || (match.agent.status === 'working' && match.log.length === 0)} move={match.log.at(-1)?.text ?? t(STATUS_KEY[match.agent.status])} tag={<StatusTag status={match.agent.status} />} />
          <StatsGrid
            cols={2}
            rows={[
              [t('setup.model'), options.agentModel],
              [t('code.cmp.time'), match.agent.status === 'working' ? seconds(elapsed) : seconds(match.agent.doneMs)],
              [t('code.cmp.turns'), match.agent.usage?.turns ?? '–'],
              [t('code.cmp.credits'), match.agent.usage ? match.agent.usage.credits.toFixed(2) : '–'],
            ]}
          />
          {/* A terminal's title bar: what is running over there is the real CLI, not a model behind an API. */}
          <div className="-mb-3 flex items-center gap-2 rounded-t-2xl border-[3px] border-b-0 border-ink bg-ink px-3 py-1.5 font-mono text-xs text-white">
            <Mark player={{ ...players[1], color: '#2ADB5C' }} size="1.2em" />
            <span className="min-w-0 truncate">
              <span className="opacity-50">$</span> {agentBin} -p "…" -m {options.agentModel}
            </span>
          </div>
          <AgentLog log={match.log} working={match.agent.status === 'working'} name={players[1].name} />
          {match.agent.changed.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-bold opacity-60">{t('code.cmp.changed')}</span>
              {match.agent.changed.map((name) => (
                <span key={name} className="rounded-full border-2 border-ink bg-paper px-2 py-0.5 font-mono">
                  {name}
                </span>
              ))}
            </div>
          )}
          {match.agent.output && match.agent.status === 'fail' && (
            <details className="text-xs">
              <summary className="cursor-pointer font-bold">{t('code.agentOutput')}</summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-mono leading-snug">{match.agent.output}</pre>
            </details>
          )}
        </section>
      </div>

      {match.result && (
        <MatchEnding
          result={match.result}
          humans={[true, false]}
          open={resultOpen}
          detail={t('detail.code', { clock: formatClock(match.result.elapsedMs), level: card ? `Lv.${card.level} ${t(LEVELS[card.level].name)}` : '', card: card?.title[i18n.lang] ?? options.card })}
          players={players}
          rows={compareRows(match)}
          onRematch={onRematch}
          onSetup={onSetup}
          onLobby={onLobby}
          onClose={() => setResultOpen(false)}
        />
      )}
    </div>
  );
}
