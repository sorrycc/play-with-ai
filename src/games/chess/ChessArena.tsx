import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../core/i18n';
import { sfx } from '../../core/sound';
import type { Player, PlayerConfig } from '../../core/types';
import { fmtMs, fmtUsd, formatClock } from '../../core/types';
import { createPlayer } from '../../players';
import { Countdown, PlayerBadge, MatchEnding, StatsGrid, modelStatRows, seatMood, type CompareRow, type StatRow } from '../../ui/bits';
import { useMatch } from '../../ui/useMatch';
import { type Piece, type Promotion, colOf, colorOf, inCheck, kingSquare, materialBalance, moveId, rowOf, squareName } from './engine';
import { ChessMatch, type ChessOptions, type ChessSeat, type PlayedMove } from './match';

// Outline glyphs for White, solid for Black. U+FE0E asks for the text form: without it some
// systems draw the black pawn as a colour emoji.
const GLYPH: Record<Piece, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};
const glyph = (p: Piece) => `${GLYPH[p]}︎`;
const PIECE_FONT = '"Noto Sans Symbols 2", "Segoe UI Symbol", "Apple Symbols", "Arial Unicode MS", "DejaVu Sans", sans-serif';
const FILES = 'abcdefgh';
const PROMOTIONS: Promotion[] = ['q', 'r', 'b', 'n'];

const pieceStyle: React.CSSProperties = { fontFamily: PIECE_FONT, fontSize: 'min(8.2vw, 46px)' };

/** Where a square is drawn: column and row on screen, which turn around when the board is flipped. */
const onScreen = (sq: number, flipped: boolean) => ({ x: flipped ? 7 - colOf(sq) : colOf(sq), y: flipped ? 7 - rowOf(sq) : rowOf(sq) });

/** The offset, in squares, from a piece's new square back to the one it left: where its slide starts. */
function slideFrom(from: number, to: number, flipped: boolean): React.CSSProperties {
  const a = onScreen(from, flipped);
  const b = onScreen(to, flipped);
  return { '--dx': a.x - b.x, '--dy': a.y - b.y } as React.CSSProperties;
}

/** An arrow from where the last move started to where it ended. It stays until the next move. */
function MoveArrow({ move, flipped }: { move: PlayedMove; flipped: boolean }) {
  const a = onScreen(move.from, flipped);
  const b = onScreen(move.to, flipped);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  // Start just off the centre of the origin square and stop short of the piece, so neither is covered.
  const ux = dx / length;
  const uy = dy / length;
  const x1 = a.x + 0.5 + ux * 0.2;
  const y1 = a.y + 0.5 + uy * 0.2;
  const x2 = b.x + 0.5 - ux * 0.46;
  const y2 = b.y + 0.5 - uy * 0.46;
  const color = move.captured ? '#ff5d8f' : '#7c5cff';
  return (
    <svg viewBox="0 0 8 8" className="arrow-in pointer-events-none absolute inset-0 z-[4] size-full" aria-hidden>
      <defs>
        <marker id="chess-arrow-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill={color} />
        </marker>
      </defs>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={0.13} strokeLinecap="round" opacity={0.6} markerEnd="url(#chess-arrow-head)" />
    </svg>
  );
}

/** "Last move: Black ♞ g8 → f6 takes ♙", for anyone who does not read chess notation. */
function LastMove({ move }: { move: PlayedMove | undefined }) {
  if (!move) return null;
  const castled = move.rook !== null;
  const promoted = /=/.test(move.san);
  return (
    <div key={move.id + move.san} className="toy-sm pop-in flex flex-wrap items-center justify-center gap-x-2 px-4 py-1.5 text-sm font-semibold" aria-live="polite">
      <span className="opacity-60">{t('c.lastMove')}</span>
      <span className={`inline-block size-3.5 rounded border-2 border-ink ${move.color === 'w' ? 'bg-white' : 'bg-night'}`} />
      <span>{t(move.color === 'w' ? 'c.white' : 'c.black')}</span>
      <span className="text-2xl leading-none" style={{ fontFamily: PIECE_FONT }}>
        {glyph(move.piece)}
      </span>
      <span className="font-mono">
        {squareName(move.from)} → {squareName(move.to)}
      </span>
      {move.captured && (
        <span className="flex items-center gap-1 text-pink">
          {t('c.takes')}
          <span className="text-2xl leading-none text-ink" style={{ fontFamily: PIECE_FONT }}>
            {glyph(move.captured)}
          </span>
        </span>
      )}
      {castled && <span className="text-grape">{t('c.castles')}</span>}
      {promoted && <span className="text-grape">{t('c.promotes')}</span>}
      <span className="rounded-full border-2 border-ink bg-paper px-2 font-mono text-xs">{move.san}</span>
    </div>
  );
}

function Board({ match, flipped }: { match: ChessMatch; flipped: boolean }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [promoting, setPromoting] = useState<{ from: number; to: number } | null>(null);
  const { state, legal } = match;
  const canMove = match.awaitingHuman;
  const last = match.history[match.history.length - 1];
  const checked = match.status !== 'idle' && inCheck(state) ? kingSquare(state.board, state.turn) : -1;

  // A selection made on one turn means nothing on the next.
  const ply = match.history.length;
  const seenPly = useRef(ply);
  if (seenPly.current !== ply) {
    seenPly.current = ply;
    if (selected !== null) setSelected(null);
    if (promoting) setPromoting(null);
  }
  // Nor does a half-finished promotion survive the end of the match.
  if (promoting && !canMove) setPromoting(null);

  const targets = useMemo(() => new Set(selected === null ? [] : legal.filter((m) => m.from === selected).map((m) => m.to)), [legal, selected]);

  const click = (sq: number) => {
    if (!canMove || promoting) return;
    const piece = state.board[sq];
    if (selected !== null && targets.has(sq)) {
      const moves = legal.filter((m) => m.from === selected && m.to === sq);
      // Four moves to one square means a promotion: ask which piece.
      if (moves.length > 1) return setPromoting({ from: selected, to: sq });
      return match.play(moveId(moves[0]));
    }
    setSelected(piece && colorOf(piece) === state.turn && legal.some((m) => m.from === sq) ? sq : null);
  };

  const order = Array.from({ length: 64 }, (_, i) => (flipped ? 63 - i : i));
  return (
    <div className="toy relative w-full overflow-hidden !rounded-2xl p-0" style={{ maxWidth: 560 }} role="img" aria-label={t('c.boardLabel')}>
      <div className="grid grid-cols-8">
        {order.map((sq, i) => {
          const piece = state.board[sq];
          const dark = (rowOf(sq) + colOf(sq)) % 2 === 1;
          // Warm yellow marks the last move: paler where the piece left, stronger where it landed.
          const background = sq === selected ? '#b9f3d6' : sq === checked ? '#ffb3c1' : last?.to === sq ? '#ffe27a' : last?.from === sq ? '#fff1b8' : dark ? '#f1f1f1' : '#ffffff';
          const target = targets.has(sq);
          // A piece that just arrived here, and the square it came from: the king or, when castling, the rook.
          const cameFrom = last?.to === sq ? last.from : last?.rook?.to === sq ? last.rook.from : null;
          const taken = last?.capturedAt === sq ? last.captured : null;
          const promoted = last?.to === sq && last.promotion !== null && piece !== null;
          return (
            <button
              key={sq}
              type="button"
              data-silent
              aria-label={`${squareName(sq)}${piece ? ` ${piece}` : ''}`}
              onClick={() => click(sq)}
              className="relative grid aspect-square place-items-center p-0 transition-colors"
              style={{ background, cursor: canMove && (target || (piece && colorOf(piece) === state.turn)) ? 'pointer' : 'default' }}
            >
              {i % 8 === 0 && <span className="absolute left-1 top-0.5 font-mono text-[10px] text-ink/45">{8 - rowOf(sq)}</span>}
              {i >= 56 && <span className="absolute bottom-0.5 right-1 font-mono text-[10px] text-ink/45">{FILES[colOf(sq)]}</span>}
              {taken && (
                <span key={`taken-${ply}`} className="piece-taken pointer-events-none absolute inset-0 grid place-items-center leading-none text-ink" style={pieceStyle}>
                  {glyph(taken)}
                </span>
              )}
              {piece && (
                // Fills the square, so the slide can be written in squares; re-keyed per move so it runs once.
                <span
                  key={cameFrom !== null ? `moved-${ply}` : 'still'}
                  className={`pointer-events-none absolute inset-0 grid place-items-center leading-none text-ink ${cameFrom !== null ? 'piece-slide' : ''} ${promoted ? 'piece-promote-out' : ''}`}
                  style={cameFrom !== null ? { ...pieceStyle, ...slideFrom(cameFrom, sq, flipped) } : pieceStyle}
                >
                  {/* A promoting pawn travels as a pawn and only then becomes its new piece. */}
                  {glyph(promoted ? last.piece : piece)}
                </span>
              )}
              {promoted && (
                <span key={`promoted-${ply}`} className="piece-promote-in pointer-events-none absolute inset-0 grid place-items-center leading-none text-ink" style={pieceStyle}>
                  {glyph(piece!)}
                </span>
              )}
              {last?.to === sq && <span key={`ping-${ply}`} className={`square-ping pointer-events-none absolute inset-0 rounded-full border-4 ${last.captured ? 'border-pink' : 'border-grape'}`} />}
              {target && <span className={`pointer-events-none absolute rounded-full ${piece ? 'inset-1 border-4 border-mint/80' : 'size-[26%] bg-mint/80'}`} />}
            </button>
          );
        })}
      </div>
      {last && <MoveArrow key={ply} move={last} flipped={flipped} />}
      {promoting && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-white/70">
          <div className="toy-sm pop-in flex flex-col items-center gap-2 p-3">
            <span className="text-sm font-bold">{t('c.promoteTo')}</span>
            <div className="flex gap-2">
              {PROMOTIONS.map((p) => (
                <button
                  key={p}
                  className="btn bg-white !px-3 !py-1 text-4xl"
                  style={{ fontFamily: PIECE_FONT }}
                  onClick={() => match.play(`${squareName(promoting.from)}${squareName(promoting.to)}${p}`)}
                >
                  {glyph((state.turn === 'w' ? p.toUpperCase() : p) as Piece)}
                </button>
              ))}
            </div>
            <button className="btn bg-white !px-3 !py-0.5 text-xs" onClick={() => setPromoting(null)}>
              {t('c.promoteCancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** How the material stands, as one bar: white grows from the left, black from the right. */
function MaterialBar({ balance }: { balance: number }) {
  // Ten points ahead is the whole bar; more than that the game is long decided anyway.
  const share = 50 + Math.max(-10, Math.min(10, balance)) * 5;
  const label = balance === 0 ? '=' : balance > 0 ? `+${balance}` : String(balance);
  return (
    <div className="flex w-full items-center gap-2" title={t('c.material')}>
      <span className="font-mono text-xs opacity-60">{t('c.material')}</span>
      <div className="relative h-3 flex-1 overflow-hidden rounded-full border-2 border-ink bg-night">
        <div className="h-full bg-white transition-[width] duration-500" style={{ width: `${share}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-xs font-bold">{label}</span>
    </div>
  );
}

/** Copies a line of text and says so for a moment. */
function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <button
      className="btn bg-white !px-2 !py-0.5 text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(text()).then(() => setDone(true));
      }}
    >
      {done ? t('c.copied') : label}
    </button>
  );
}

function seatRows(seat: ChessSeat, lead: number): StatRow[] {
  const base: StatRow[] = [
    [t('stat.moves'), seat.moves],
    [t('stat.material'), lead > 0 ? `+${lead}` : lead === 0 ? '=' : String(lead)],
  ];
  if (seat.human) return base;
  return [...base, [t('stat.calls'), seat.stats.calls], [t('stat.fallbacks'), seat.stats.invalid + seat.stats.errors], ...modelStatRows(seat.stats, false)];
}

function SeatPanel({ seat, match }: { seat: ChessSeat; match: ChessMatch }) {
  const toMove = match.status === 'running' && match.turnSeat === seat;
  const won = match.result?.winner === seat.index;
  const lead = materialBalance(match.state.board) * (seat.color === 'w' ? 1 : -1);
  return (
    <section className={`toy flex w-full flex-col gap-3 p-4 transition-transform lg:w-72 ${toMove ? '!bg-sun/40 lg:-translate-y-1' : ''} ${seatMood(match.result, seat.index)}`}>
      <PlayerBadge
        player={seat.player}
        thinking={seat.thinking}
        move={seat.move}
        tag={
          <span className="flex shrink-0 items-center gap-1">
            <span className={`inline-block size-4 rounded border-2 border-ink ${seat.color === 'w' ? 'bg-white' : 'bg-night'}`} title={t(seat.color === 'w' ? 'c.white' : 'c.black')} />
            {won && <span className="rounded-full border-2 border-ink bg-sun px-2 text-xs font-bold">{t('arena.winner')}</span>}
          </span>
        }
      />
      <div className="min-h-7 rounded-xl border-2 border-ink/80 bg-white px-2 leading-7" title={t('c.captured')} style={{ fontFamily: PIECE_FONT }}>
        {seat.captured.length ? seat.captured.map((p, i) => <span key={i}>{glyph(p)}</span>) : <span className="font-[family-name:var(--font-display)] text-xs opacity-40">{t('c.captured')}</span>}
      </div>
      <StatsGrid rows={seatRows(seat, lead)} cols={2} />
    </section>
  );
}

function MoveList({ match }: { match: ChessMatch }) {
  const end = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', inline: 'end' });
  }, [match.history.length]);
  if (match.history.length === 0) return null;
  return (
    <div className="toy-sm w-full overflow-x-auto whitespace-nowrap px-3 py-1.5 font-mono text-sm" style={{ maxWidth: 560 }}>
      {match.history.map((m, i) => (
        <span key={i} className={i === match.history.length - 1 ? 'font-bold' : 'opacity-70'}>
          {i % 2 === 0 && <span className="opacity-50">{i / 2 + 1}. </span>}
          {m.san}{' '}
        </span>
      ))}
      <span ref={end} />
    </div>
  );
}

function compareRows(match: ChessMatch): CompareRow[] {
  const [A, B] = match.seats;
  const balance = materialBalance(match.state.board);
  const both = (label: string, f: (s: ChessSeat) => React.ReactNode): CompareRow => [label, f(A), f(B)];
  return [
    both(t('cmp.side'), (s) => t(s.color === 'w' ? 'c.white' : 'c.black')),
    both(t('stat.moves'), (s) => s.moves),
    both(t('stat.material'), (s) => {
      const lead = balance * (s.color === 'w' ? 1 : -1);
      return lead > 0 ? `+${lead}` : lead === 0 ? '=' : String(lead);
    }),
    both(t('stat.avgLatency'), (s) => (s.stats.latency ? fmtMs(s.stats.latency / s.stats.calls) : '–')),
    both(t('cmp.botFallbacks'), (s) => (s.human ? '–' : s.stats.invalid + s.stats.errors)),
    both(t('cmp.tokensInOut'), (s) => (s.stats.inputTokens ? `${s.stats.inputTokens.toLocaleString()} / ${s.stats.outputTokens.toLocaleString()}` : '–')),
    both(t('stat.cost'), (s) => fmtUsd(s.stats.cost)),
    both(t('cmp.costPerMove'), (s) => (s.stats.calls && s.stats.cost ? fmtUsd(s.stats.cost / s.stats.calls, 5) : '–')),
  ];
}

export function ChessArena({
  seats,
  options,
  onRematch,
  onSetup,
  onLobby,
}: {
  seats: [PlayerConfig, PlayerConfig];
  options: ChessOptions;
  onRematch: () => void;
  onSetup: () => void;
  onLobby: () => void;
}) {
  const players = useMemo(() => seats.map(createPlayer) as [Player, Player], [seats]);
  const { match, count } = useMatch(
    (onChange) =>
      new ChessMatch(players, options, onChange, (event) => {
        if (event.type === 'check') sfx.play('check');
        else if (event.type === 'capture') sfx.play('capture');
        else if (event.type === 'promote') sfx.play('levelup');
        else sfx.play(event.color === 'w' ? 'stoneWhite' : 'stoneBlack');
      }),
  );
  const [, setClock] = useState(0);
  const [resultOpen, setResultOpen] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 500);
    return () => clearInterval(id);
  }, []);

  if (!match) return null;
  const [A, B] = match.seats;
  // A person playing Black alone sees the board from Black's side.
  const flipped = seats[1].kind === 'human' && seats[0].kind !== 'human';
  // Resigning and offering a draw belong to the person at the board; when two share it, to the one to move.
  const human: 0 | 1 | null = seats[0].kind === 'human' && seats[1].kind === 'human' ? match.turnSeat.index : seats[0].kind === 'human' ? 0 : seats[1].kind === 'human' ? 1 : null;
  const fullMove = Math.floor(match.history.length / 2) + (match.status === 'done' ? 0 : 1);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-5 px-4 pb-10">
      <Countdown value={count} />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <span className="toy-sm px-4 py-1 font-mono text-2xl font-bold">{formatClock(match.elapsed())}</span>
        <span className="toy-sm !bg-sun px-3 py-1 text-sm font-bold">
          {t('c.moveNo', { n: Math.max(1, fullMove) })}
          {options.maxMoves > 0 && <span className="opacity-50"> / {options.maxMoves}</span>}
        </span>
        {match.status === 'running' && inCheck(match.state) && <span className="toy-sm pop-in !bg-pink px-3 py-1 text-sm font-bold text-white">{t('c.check')}</span>}
        {match.status === 'running' && match.repetition >= 2 && <span className="toy-sm px-3 py-1 text-sm font-bold">{t('c.repeated', { n: match.repetition })}</span>}
        {match.status === 'running' && match.state.halfmove >= 80 && (
          <span className="toy-sm px-3 py-1 text-sm font-bold">{t('c.fiftyLeft', { n: Math.ceil((100 - match.state.halfmove) / 2) })}</span>
        )}
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

      <div className="flex w-full flex-col items-center gap-5 lg:flex-row lg:items-start lg:justify-center">
        <SeatPanel seat={A} match={match} />
        <div className="flex w-full min-w-0 flex-col items-center gap-3" style={{ maxWidth: 560 }}>
          <LastMove move={match.history[match.history.length - 1]} />
          <Board match={match} flipped={flipped} />
          <MaterialBar balance={materialBalance(match.state.board)} />
          <MoveList match={match} />
          <div className="flex flex-wrap items-center justify-center gap-2">
            <CopyButton label={t('c.copyFen')} text={() => match.fen()} />
            <CopyButton label={t('c.copyPgn')} text={() => match.pgn()} />
            {human !== null && match.status === 'running' && (
              <>
                <button className="btn bg-white !px-2 !py-0.5 text-xs" onClick={() => window.confirm(t('c.resignConfirm')) && match.resign(human)}>
                  {t('c.resign')}
                </button>
                <button className="btn bg-white !px-2 !py-0.5 text-xs" onClick={() => match.offerDraw(human)}>
                  {t(match.drawOffer !== null && match.drawOffer !== human ? 'c.acceptDraw' : 'c.offerDraw')}
                </button>
              </>
            )}
            {match.drawOffer !== null && <span className="text-xs font-semibold opacity-70">{t('c.drawOffered', { name: match.seats[match.drawOffer].player.name })}</span>}
            {match.drawDeclined && <span className="text-xs font-semibold opacity-70">{t('c.drawDeclined')}</span>}
          </div>
        </div>
        <SeatPanel seat={B} match={match} />
      </div>

      {match.result && (
        <MatchEnding
          result={match.result}
          humans={[seats[0].kind === 'human', seats[1].kind === 'human']}
          open={resultOpen}
          detail={t('detail.chess', { clock: formatClock(match.result.elapsedMs), n: Math.ceil(match.history.length / 2) })}
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
