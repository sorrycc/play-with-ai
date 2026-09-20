// Per-browser preferences. The site runs locally with no accounts, so localStorage is the whole
// store; when it is unavailable (a private window) the settings still work for the page's lifetime.

import type { GameId } from './types';

export interface Settings {
  /** Games kept off the home page. Hidden rather than shown, so a game added later appears by default. */
  hiddenGames: GameId[];
  /** The order games appear in. A game missing from the list (added later) goes after the listed ones. */
  gameOrder: GameId[];
}

const STORAGE_KEY = 'play-with-ai:settings:v1';
const DEFAULTS: Settings = { hiddenGames: [], gameOrder: [] };

function read(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return DEFAULTS;
    const ids = (list: unknown): GameId[] => (Array.isArray(list) ? list.filter((g): g is GameId => typeof g === 'string') : []);
    return { hiddenGames: ids(saved.hiddenGames), gameOrder: ids(saved.gameOrder) };
  } catch {
    return DEFAULTS;
  }
}

// Replaced, never mutated: useSyncExternalStore compares snapshots by identity.
let current: Settings = read();
const listeners = new Set<() => void>();

function update(next: Settings): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* kept for this page only */
  }
  listeners.forEach((l) => l());
}

/** `games` in the saved order; anything the saved order does not mention keeps its place at the end. */
export function sortGames<T extends { id: GameId }>(games: T[], order: GameId[]): T[] {
  const rank = (id: GameId) => (order.includes(id) ? order.indexOf(id) : order.length + games.findIndex((g) => g.id === id));
  return [...games].sort((a, b) => rank(a.id) - rank(b.id));
}

export const settings = {
  get: (): Settings => current,
  /** For useSyncExternalStore. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setGameVisible(game: GameId, visible: boolean): void {
    const hidden = current.hiddenGames.filter((g) => g !== game);
    update({ ...current, hiddenGames: visible ? hidden : [...hidden, game] });
  },
  showAllGames(): void {
    update({ ...current, hiddenGames: [] });
  },
  /** Moves `game` to position `index` of `all`, the full list as currently ordered. */
  moveGame(all: GameId[], game: GameId, index: number): void {
    const order = all.filter((g) => g !== game);
    order.splice(Math.max(0, Math.min(index, order.length)), 0, game);
    update({ ...current, gameOrder: order });
  },
  resetGameOrder(): void {
    update({ ...current, gameOrder: [] });
  },
};
