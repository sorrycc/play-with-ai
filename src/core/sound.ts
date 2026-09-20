// Sound effects, synthesized with the Web Audio API: no audio files, nothing to download.
//
// Every effect is a few oscillator "blips" and filtered-noise "puffs". A browser only lets audio
// start after a gesture, so the context is created lazily and resumed on the first pointer or key
// event; until then play() is a silent no-op rather than an error.

export type SfxName =
  | 'click'
  | 'count'
  | 'go'
  | 'move'
  | 'rotate'
  | 'drop'
  | 'lock'
  | 'clear1'
  | 'clear2'
  | 'clear3'
  | 'clear4'
  | 'garbage'
  | 'miss'
  | 'levelup'
  | 'topout'
  | 'stoneBlack'
  | 'stoneWhite'
  | 'eat'
  | 'merge'
  | 'capture'
  | 'check'
  | 'crash'
  | 'win'
  | 'lose'
  | 'draw';

export interface PlayOptions {
  /** -1 (left) to 1 (right). Tetris pans each board to its side. */
  pan?: number;
  /** Multiplies the effect's own loudness. */
  volume?: number;
}

const STORAGE_KEY = 'play-with-ai:muted';
const MASTER_GAIN = 0.55;

interface Blip {
  type?: OscillatorType;
  freq: number;
  /** Glide to this frequency over the blip. */
  to?: number;
  /** Seconds after the effect starts. */
  at?: number;
  dur: number;
  gain: number;
}

interface Puff {
  at?: number;
  dur: number;
  gain: number;
  /** Low-pass cutoff; lower is duller, like a thud. */
  cutoff: number;
  /** Sweep the cutoff to this value. */
  cutoffTo?: number;
}

interface Recipe {
  blips?: Blip[];
  puffs?: Puff[];
}

// Notes, for the jingles.
const C5 = 523.25, E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5, E6 = 1318.5, G6 = 1568;

const arpeggio = (notes: number[], step: number, dur: number, gain: number, type: OscillatorType = 'triangle'): Blip[] =>
  notes.map((freq, i) => ({ type, freq, at: i * step, dur, gain }));

const RECIPES: Record<SfxName, Recipe> = {
  click: { blips: [{ type: 'triangle', freq: 880, to: 1320, dur: 0.06, gain: 0.18 }] },
  count: { blips: [{ type: 'square', freq: 440, dur: 0.12, gain: 0.16 }] },
  go: { blips: [{ type: 'square', freq: 880, dur: 0.32, gain: 0.16 }, { type: 'triangle', freq: 1320, dur: 0.32, gain: 0.12 }] },

  move: { blips: [{ type: 'square', freq: 320, dur: 0.035, gain: 0.07 }] },
  rotate: { blips: [{ type: 'triangle', freq: 520, to: 780, dur: 0.07, gain: 0.13 }] },
  drop: { puffs: [{ dur: 0.12, gain: 0.22, cutoff: 3200, cutoffTo: 300 }] },
  lock: { blips: [{ type: 'sine', freq: 150, to: 70, dur: 0.1, gain: 0.3 }], puffs: [{ dur: 0.05, gain: 0.12, cutoff: 900 }] },
  clear1: { blips: arpeggio([C5, E5], 0.06, 0.14, 0.2) },
  clear2: { blips: arpeggio([C5, E5, G5], 0.06, 0.15, 0.2) },
  clear3: { blips: arpeggio([C5, E5, G5, C6], 0.055, 0.16, 0.2) },
  clear4: {
    blips: [...arpeggio([C5, E5, G5, C6, E6, G6], 0.05, 0.2, 0.2), { type: 'square', freq: C6, at: 0.32, dur: 0.35, gain: 0.1 }],
    puffs: [{ at: 0.3, dur: 0.4, gain: 0.1, cutoff: 6000, cutoffTo: 1500 }],
  },
  garbage: { blips: [{ type: 'sawtooth', freq: 110, to: 55, dur: 0.22, gain: 0.22 }], puffs: [{ dur: 0.2, gain: 0.2, cutoff: 500 }] },
  miss: { blips: [{ type: 'square', freq: 300, to: 180, dur: 0.16, gain: 0.1 }] },
  levelup: { blips: arpeggio([G5, C6, E6], 0.07, 0.12, 0.14, 'square') },
  topout: { blips: arpeggio([G5, E5, C5, 392, 329.63, 261.63], 0.09, 0.18, 0.18, 'sawtooth'), puffs: [{ at: 0.5, dur: 0.5, gain: 0.2, cutoff: 700, cutoffTo: 120 }] },

  // A stone on wood: a short pitched knock plus a click of noise. White sits a little higher.
  stoneBlack: { blips: [{ type: 'sine', freq: 420, to: 210, dur: 0.07, gain: 0.35 }], puffs: [{ dur: 0.025, gain: 0.25, cutoff: 2600 }] },
  stoneWhite: { blips: [{ type: 'sine', freq: 560, to: 280, dur: 0.07, gain: 0.35 }], puffs: [{ dur: 0.025, gain: 0.25, cutoff: 3400 }] },

  // A quick rising gulp, and a crunch for a snake that hits something.
  eat: { blips: [{ type: 'square', freq: 440, to: 990, dur: 0.09, gain: 0.16 }, { type: 'triangle', freq: 1320, at: 0.07, dur: 0.08, gain: 0.12 }] },
  // Chess: a piece taken off the board, and the two-note warning of a check.
  capture: { blips: [{ type: 'sine', freq: 300, to: 120, dur: 0.1, gain: 0.35 }], puffs: [{ dur: 0.07, gain: 0.3, cutoff: 3000, cutoffTo: 600 }] },
  check: { blips: [{ type: 'square', freq: 660, dur: 0.1, gain: 0.14 }, { type: 'square', freq: 880, at: 0.11, dur: 0.16, gain: 0.14 }] },
  // Two tiles fusing: a soft rising pluck.
  merge: { blips: [{ type: 'triangle', freq: 392, to: 587, dur: 0.1, gain: 0.2 }, { type: 'sine', freq: 784, at: 0.05, dur: 0.1, gain: 0.1 }] },
  crash: { blips: [{ type: 'sawtooth', freq: 220, to: 45, dur: 0.35, gain: 0.22 }], puffs: [{ dur: 0.3, gain: 0.3, cutoff: 1800, cutoffTo: 150 }] },

  win: {
    blips: [
      ...arpeggio([C5, E5, G5, C6], 0.11, 0.22, 0.2, 'square'),
      { type: 'square', freq: C6, at: 0.5, dur: 0.5, gain: 0.16 },
      { type: 'triangle', freq: E6, at: 0.5, dur: 0.5, gain: 0.14 },
      { type: 'triangle', freq: G6, at: 0.5, dur: 0.5, gain: 0.1 },
    ],
  },
  lose: { blips: [{ type: 'sawtooth', freq: 311, at: 0, dur: 0.28, gain: 0.14 }, { type: 'sawtooth', freq: 293, at: 0.28, dur: 0.28, gain: 0.14 }, { type: 'sawtooth', freq: 277, at: 0.56, dur: 0.28, gain: 0.14 }, { type: 'sawtooth', freq: 261, to: 233, at: 0.84, dur: 0.7, gain: 0.16 }] },
  draw: { blips: [{ type: 'triangle', freq: A5, dur: 0.18, gain: 0.16 }, { type: 'triangle', freq: A5, at: 0.22, dur: 0.3, gain: 0.16 }] },
};

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = readMuted();
const listeners = new Set<() => void>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function ensureContext(): AudioContext | null {
  if (context) return context;
  const Ctor = typeof window === 'undefined' ? undefined : window.AudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  // A compressor keeps a Tetris clear on both boards at once from clipping.
  const limiter = context.createDynamicsCompressor();
  master = context.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(limiter).connect(context.destination);
  const length = context.sampleRate; // one second of white noise, reused by every puff
  noiseBuffer = context.createBuffer(1, length, context.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return context;
}

/** Shapes a quick attack and an exponential decay; a bare on/off gain would click. */
function envelope(ctx: AudioContext, gain: number, start: number, dur: number): GainNode {
  const node = ctx.createGain();
  node.gain.setValueAtTime(0.0001, start);
  node.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), start + 0.008);
  node.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  return node;
}

export const sfx = {
  /** Call from a user gesture. Browsers keep an AudioContext suspended until one happens. */
  unlock(): void {
    const ctx = ensureContext();
    if (ctx?.state === 'suspended') void ctx.resume();
  },

  play(name: SfxName, { pan = 0, volume = 1 }: PlayOptions = {}): void {
    if (muted) return;
    const ctx = ensureContext();
    if (!ctx || !master || ctx.state !== 'running') return;
    const recipe = RECIPES[name];
    const now = ctx.currentTime;
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(master);

    for (const b of recipe.blips ?? []) {
      const start = now + (b.at ?? 0);
      const osc = ctx.createOscillator();
      osc.type = b.type ?? 'sine';
      osc.frequency.setValueAtTime(b.freq, start);
      if (b.to) osc.frequency.exponentialRampToValueAtTime(b.to, start + b.dur);
      osc.connect(envelope(ctx, b.gain * volume, start, b.dur)).connect(out);
      osc.start(start);
      osc.stop(start + b.dur + 0.02);
    }
    for (const p of recipe.puffs ?? []) {
      const start = now + (p.at ?? 0);
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(p.cutoff, start);
      if (p.cutoffTo) filter.frequency.exponentialRampToValueAtTime(p.cutoffTo, start + p.dur);
      src.connect(filter).connect(envelope(ctx, p.gain * volume, start, p.dur)).connect(out);
      src.start(start, Math.random() * 0.5);
      src.stop(start + p.dur + 0.02);
    }
  },

  get muted(): boolean {
    return muted;
  },

  setMuted(next: boolean): void {
    muted = next;
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* private window: the choice lasts for this page only */
    }
    listeners.forEach((l) => l());
  },

  /** For useSyncExternalStore. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
