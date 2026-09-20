// Canvas painting for the shared snake grid. Called every animation frame; the snakes slide
// between steps (the head into its new cell, the tail out of its old one) as in jev-snake.

import { DELTA, type Point } from './engine';
import type { SnakeMatch } from './match';

export const SEAT_COLORS = ['#3ddc97', '#ffd23f'] as const;
const SEAT_DARK = ['#178a5c', '#b88a00'] as const;
const DEAD = '#6c6790';
const SLIDE_MS = 380;

const lerp = (a: Point, b: Point, k: number): Point => ({ r: a.r + (b.r - a.r) * k, c: a.c + (b.c - a.c) * k });

/** Centre line of a snake, head first, `k` of the way through the last step. */
function bodyPath(body: Point[], from: Point[] | null, k: number): Point[] {
  if (!from || k >= 1 || body.length < 2 || from === body) return body;
  const path = [lerp(body[1], body[0], k), ...body.slice(1)];
  if (body.length === from.length) path.push(lerp(from[from.length - 1], body[body.length - 1], k));
  return path;
}

/** `width`/`height` are CSS pixels; the context is already scaled for the device pixel ratio. */
export function drawDuel(ctx: CanvasRenderingContext2D, match: SnakeMatch, width: number, height: number, now: number): void {
  const { state } = match;
  const cell = width / state.cols;
  const centre = (p: Point) => ({ x: (p.c + 0.5) * cell, y: (p.r + 0.5) * cell });
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      ctx.beginPath();
      ctx.arc((c + 0.5) * cell, (r + 0.5) * cell, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (state.food) {
    const { x, y } = centre(state.food);
    const pulse = 1 + Math.sin(now / 220) * 0.08;
    ctx.fillStyle = '#ff5d8f';
    ctx.beginPath();
    ctx.arc(x, y + cell * 0.04, cell * 0.34 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(x - cell * 0.12, y - cell * 0.08, cell * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4ee08a';
    ctx.lineWidth = Math.max(2, cell * 0.1);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y - cell * 0.3);
    ctx.quadraticCurveTo(x + cell * 0.18, y - cell * 0.5, x + cell * 0.26, y - cell * 0.34);
    ctx.stroke();
  }

  // A long tick should not mean a slow crawl: slide quickly, then rest until the next step.
  const k = match.steppedAt ? Math.min(1, (now - match.steppedAt) / Math.min(SLIDE_MS, match.tickMs)) : 1;

  state.snakes.forEach((snake, i) => {
    // A snake that just died did not move, so it has nothing to slide from.
    const from = snake.alive ? (match.previous?.[i] ?? null) : null;
    const path = bodyPath(snake.body, from, k).map(centre);
    const color = snake.alive ? SEAT_COLORS[i] : DEAD;
    const stroke = (style: string, widthPx: number, offset = 0) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = widthPx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      path.forEach((p, n) => (n === 0 ? ctx.moveTo(p.x, p.y + offset) : ctx.lineTo(p.x, p.y + offset)));
      if (path.length === 1) ctx.lineTo(path[0].x + 0.01, path[0].y + offset);
      ctx.stroke();
    };
    stroke(snake.alive ? SEAT_DARK[i] : '#4a4668', cell * 0.78, cell * 0.06);
    stroke(color, cell * 0.72);
    stroke('rgba(255,255,255,0.22)', cell * 0.18, -cell * 0.16);

    // Head: a rounder blob with eyes looking where it is heading.
    const head = path[0];
    const d = DELTA[snake.heading];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(head.x, head.y, cell * 0.44, 0, Math.PI * 2);
    ctx.fill();
    for (const side of [-1, 1]) {
      const ex = head.x + d.c * cell * 0.16 + -d.r * side * cell * 0.17;
      const ey = head.y + d.r * cell * 0.16 + d.c * side * cell * 0.17;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, cell * 0.12, 0, Math.PI * 2);
      ctx.fill();
      if (snake.alive) {
        ctx.fillStyle = '#1f1147';
        ctx.beginPath();
        ctx.arc(ex + d.c * cell * 0.04, ey + d.r * cell * 0.04, cell * 0.06, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Crossed-out eyes.
        ctx.strokeStyle = '#1f1147';
        ctx.lineWidth = Math.max(1.5, cell * 0.05);
        const s = cell * 0.07;
        ctx.beginPath();
        ctx.moveTo(ex - s, ey - s);
        ctx.lineTo(ex + s, ey + s);
        ctx.moveTo(ex + s, ey - s);
        ctx.lineTo(ex - s, ey + s);
        ctx.stroke();
      }
    }
  });
}
