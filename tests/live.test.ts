// Opt-in end-to-end check against the real providers, through a running dev server:
//
//   npm run dev                                   (in one terminal)
//   LIVE_BASE=http://127.0.0.1:5173 npm run test:live
//
// It spends a fraction of a cent. Without LIVE_BASE every test here is skipped.
import { it as liveIt, expect } from 'vitest';
import { emptyBoard, enumeratePlacements, HEIGHT, WIDTH } from '../src/games/tetris/engine';
import { buildTetrisRequest } from '../src/games/tetris/match';
import { buildMessages, parseChoice } from '../src/players/llm';
import { buildJevRequest } from '../src/players/jev';
import { candidates, emptyGomokuBoard, at, BLACK, WHITE } from '../src/games/gomoku/engine';
import { buildGomokuRequest } from '../src/games/gomoku/match';

const B = process.env.LIVE_BASE ?? '';
const it = B ? liveIt : liveIt.skip;
const post = async (path: string, body: unknown) => {
  const t = Date.now();
  const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ms: Date.now() - t, json: await r.json() };
};

const board = emptyBoard();
for (let x = 0; x < WIDTH; x++) if (x < 3 || x > 6) board[HEIGHT - 1][x] = 'G';
const placements = enumeratePlacements(board, 'I');
const tReq = buildTetrisRequest({ board, current: 'I', queue: ['T', 'O', 'L'], hold: null, holdUsed: false, pendingGarbage: 0, lines: 0 }, placements, { realtime: true, mode: 'versus', opponent: { maxHeight: 6, lines: 2, pendingGarbage: 0 } });
const clearing = placements.find((p) => p.linesCleared === 1)!.id;

const g = emptyGomokuBoard();
for (const c of [3, 4, 5, 6]) g[at(7, c)] = BLACK;
g[at(7, 2)] = WHITE; g[at(9, 4)] = WHITE; g[at(9, 5)] = WHITE;
const gReq = buildGomokuRequest(g, WHITE, candidates(g, WHITE), 8, [at(7, 2), at(9, 4), at(9, 5), at(7, 6)]);

it('llm tetris', async () => {
  const r = await post('/api/llm', { model: 'deepseek/deepseek-v4.1-flash', thinking: false, messages: buildMessages(tReq) });
  const id = parseChoice(r.json.content ?? '', tReq.options.map((o) => o.id));
  console.log('LLM tetris', r.status, r.ms + 'ms', JSON.stringify(r.json), '→', id, '(line-clearing option is', clearing + ')');
  expect(r.status).toBe(200); expect(id).not.toBeNull();
}, 60000);
it('llm gomoku must-block', async () => {
  const r = await post('/api/llm', { model: 'deepseek/deepseek-v4.1-flash', thinking: false, messages: buildMessages(gReq) });
  const id = parseChoice(r.json.content ?? '', gReq.options.map((o) => o.id));
  console.log('LLM gomoku', r.status, r.ms + 'ms', JSON.stringify(r.json), '→', id, '(forced block is H8)');
  expect(r.status).toBe(200); expect(id).not.toBeNull();
}, 60000);
it('jev tetris', async () => {
  const r = await post('/api/jev', buildJevRequest(tReq));
  console.log('JEV tetris', r.status, r.ms + 'ms', JSON.stringify(r.json).slice(0, 500));
  expect(r.status).toBe(200);
}, 60000);
it('jev gomoku', async () => {
  const r = await post('/api/jev', buildJevRequest(gReq));
  console.log('JEV gomoku', r.status, r.ms + 'ms', JSON.stringify(r.json?.answers?.move ?? r.json).slice(0, 400), JSON.stringify(r.json?.usage));
  expect(r.status).toBe(200);
}, 60000);
