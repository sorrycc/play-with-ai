// Canvas painting for one Tetris board. Called every animation frame by the arena, so it reads
// the side's state and keeps none of its own.

import { GARBAGE, HEIGHT, PIECES, PIECE_COLORS, WIDTH, dropY, type PieceName } from './engine';
import type { TetrisSide } from './match';

const GARBAGE_COLOR = '#6c6790';

function block(ctx: CanvasRenderingContext2D, x: number, y: number, cell: number, color: string, alpha = 1): void {
  const pad = Math.max(1, cell * 0.05);
  const size = cell - pad * 2;
  const r = cell * 0.22;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x * cell + pad, y * cell + pad, size, size, r);
  ctx.fill();
  // Candy shading: a darker base and a light gloss on top.
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.roundRect(x * cell + pad, y * cell + pad + size * 0.72, size, size * 0.28, [0, 0, r, r]);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.beginPath();
  ctx.roundRect(x * cell + pad + size * 0.14, y * cell + pad + size * 0.12, size * 0.5, size * 0.18, size * 0.09);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function outline(ctx: CanvasRenderingContext2D, x: number, y: number, cell: number, color: string, alpha: number): void {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, cell * 0.08);
  ctx.beginPath();
  ctx.roundRect(x * cell + 3, y * cell + 3, cell - 6, cell - 6, cell * 0.2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** `width`/`height` are CSS pixels; the context is already scaled for the device pixel ratio. */
export function drawBoard(ctx: CanvasRenderingContext2D, side: TetrisSide, width: number, height: number): void {
  const cell = width / WIDTH;
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      ctx.beginPath();
      ctx.arc(x * cell + cell / 2, y * cell + cell / 2, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const c = side.board[y][x];
      if (!c) continue;
      const color = side.flash.includes(y) ? '#ffffff' : c === GARBAGE ? GARBAGE_COLOR : PIECE_COLORS[c];
      block(ctx, x, y, cell, color, side.over ? 0.45 : 1);
    }
  }

  if (side.target) for (const [x, y] of side.target) outline(ctx, x, y, cell, '#ffffff', 0.75);

  if (side.active) {
    const { piece, rotation, x, y } = side.active;
    const cells = PIECES[piece][rotation].cells;
    if (side.human) {
      const gy = dropY(side.board, cells, x, y);
      for (const [cx, cy] of cells) if (gy + cy >= 0) outline(ctx, x + cx, gy + cy, cell, PIECE_COLORS[piece], 0.55);
    }
    for (const [cx, cy] of cells) if (y + cy >= 0) block(ctx, x + cx, y + cy, cell, PIECE_COLORS[piece]);
  }
}

/** The "next" preview, centred in a small square canvas. */
export function drawNext(ctx: CanvasRenderingContext2D, piece: PieceName | null, size: number): void {
  ctx.clearRect(0, 0, size, size);
  if (!piece) return;
  const state = PIECES[piece][0];
  const cell = size / 5;
  ctx.save();
  ctx.translate((size - state.width * cell) / 2, (size - state.height * cell) / 2);
  for (const [cx, cy] of state.cells) block(ctx, cx, cy, cell, PIECE_COLORS[piece]);
  ctx.restore();
}
