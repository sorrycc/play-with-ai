// The library of generated algorithms, kept in this browser. Each belongs to one game: the data it
// reads (see algoGames.ts) is different for every game.

import type { DecisionGameId } from '../core/types';

export interface Algorithm {
  id: string;
  game: DecisionGameId;
  name: string;
  /** What the person asked for. */
  prompt: string;
  /** The model that wrote it. */
  model: string;
  /** JavaScript defining `function choose(game)`. */
  code: string;
  createdAt: number;
}

const STORAGE_KEY = 'play-with-ai:algos:v1';

function read(): Algorithm[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((a): a is Algorithm => a && typeof a.id === 'string' && typeof a.game === 'string' && typeof a.code === 'string' && typeof a.name === 'string');
  } catch {
    return [];
  }
}

// Replaced, never mutated: useSyncExternalStore compares snapshots by identity.
let current: Algorithm[] = read();
const listeners = new Set<() => void>();

function update(next: Algorithm[]): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* kept for this page only */
  }
  listeners.forEach((l) => l());
}

export const algos = {
  all: (): Algorithm[] => current,
  forGame: (game: DecisionGameId): Algorithm[] => current.filter((a) => a.game === game),
  get: (id: string | undefined): Algorithm | undefined => (id ? current.find((a) => a.id === id) : undefined),
  /** For useSyncExternalStore. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  save(algo: Omit<Algorithm, 'id' | 'createdAt'>): Algorithm {
    const saved: Algorithm = { ...algo, id: `algo-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, createdAt: Date.now() };
    update([saved, ...current]);
    return saved;
  },
  remove(id: string): void {
    update(current.filter((a) => a.id !== id));
  },
};
